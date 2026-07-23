[CmdletBinding()]
param(
    [string]$NodeExe,
    [string]$AskBridgeArchive,
    [string]$MakeNsis,
    [string]$SignTool,
    [string]$CertificateThumbprint,
    [string]$CertificatePath,
    [string]$CertificatePassword,
    [string]$TimestampUrl = "http://timestamp.digicert.com",
    [switch]$RequireSignature,
    [switch]$Offline,
    [switch]$StageOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$releaseDir = [IO.Path]::GetFullPath((Join-Path $repoRoot "release"))
$stageDir = [IO.Path]::GetFullPath((Join-Path $releaseDir "stage"))
$appStageDir = Join-Path $stageDir "app"
$bridgeStageDir = Join-Path $stageDir "bridge"
$runtimeStageDir = Join-Path $stageDir "runtime"
$binStageDir = Join-Path $stageDir "bin"
$installerPath = Join-Path $releaseDir "install.exe"
$uninstallerPath = Join-Path $releaseDir "uninstall.exe"
$installerHashPath = "$installerPath.sha256"
$uninstallerHashPath = "$uninstallerPath.sha256"
$legacyInstallerPath = Join-Path $releaseDir "ask-bridge-mcp-install.exe"

function Assert-GeneratedPath {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    $releasePrefix = $releaseDir.TrimEnd('\') + '\'
    if (-not $fullPath.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the release directory: $fullPath"
    }
}

function Resolve-Executable {
    param(
        [string]$ExplicitPath,
        [Parameter(Mandatory)][string]$CommandName,
        [string[]]$FallbackPaths = @()
    )

    if ($ExplicitPath) {
        $resolved = [IO.Path]::GetFullPath($ExplicitPath)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw "Executable not found: $resolved"
        }
        return $resolved
    }

    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    foreach ($candidate in $FallbackPaths) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }

    return $null
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "")
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function Resolve-SigningConfiguration {
    if (-not $CertificateThumbprint) {
        $script:CertificateThumbprint = $env:ASK_BRIDGE_SIGNING_CERTIFICATE_THUMBPRINT
    }
    if (-not $CertificatePath) {
        $script:CertificatePath = $env:ASK_BRIDGE_SIGNING_CERTIFICATE_PATH
    }
    if (-not $CertificatePassword) {
        $script:CertificatePassword = $env:ASK_BRIDGE_SIGNING_CERTIFICATE_PASSWORD
    }

    if ($CertificateThumbprint -and $CertificatePath) {
        throw "Specify either CertificateThumbprint or CertificatePath, not both."
    }
    if (-not $CertificateThumbprint -and -not $CertificatePath) {
        if ($RequireSignature) {
            throw "A code-signing certificate is required. Pass -CertificateThumbprint or -CertificatePath, or configure the ASK_BRIDGE_SIGNING_CERTIFICATE_* environment variables."
        }
        return $null
    }

    $windowsKitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $kitSignTool = Get-ChildItem -Path (Join-Path $windowsKitsRoot "*\x64\signtool.exe") -File -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    $signToolFallbacks = @(
        $(if ($kitSignTool) { $kitSignTool.FullName }),
        (Join-Path $env:ProgramFiles "Windows Kits\10\App Certification Kit\signtool.exe")
    )
    $resolvedSignTool = Resolve-Executable -ExplicitPath $SignTool -CommandName "signtool.exe" -FallbackPaths $signToolFallbacks
    if (-not $resolvedSignTool) {
        throw "A signing certificate was configured, but signtool.exe was not found. Install the Windows SDK or pass -SignTool <path>."
    }

    if ($CertificatePath) {
        $script:CertificatePath = [IO.Path]::GetFullPath($CertificatePath)
        if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
            throw "Code-signing certificate file not found: $CertificatePath"
        }
    }

    return $resolvedSignTool
}

function Invoke-CodeSigning {
    param(
        [Parameter(Mandatory)][string]$ResolvedSignTool,
        [Parameter(Mandatory)][string]$Path
    )

    $arguments = @("sign", "/fd", "SHA256", "/td", "SHA256", "/tr", $TimestampUrl, "/d", "ask-bridge-mcp", "/v")
    if ($CertificateThumbprint) {
        $arguments += @("/s", "My", "/sha1", ($CertificateThumbprint -replace '\s', ''))
    } else {
        $arguments += @("/f", $CertificatePath)
        if ($CertificatePassword) {
            $arguments += @("/p", $CertificatePassword)
        }
    }
    $arguments += $Path

    & $ResolvedSignTool @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Authenticode signing failed for $Path with exit code $LASTEXITCODE."
    }
    & $ResolvedSignTool verify /pa /v $Path
    if ($LASTEXITCODE -ne 0) {
        throw "Authenticode verification failed for $Path with exit code $LASTEXITCODE."
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "The Windows installer can only be built on Windows."
}

$resolvedSignTool = Resolve-SigningConfiguration

$package = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$componentsPath = Join-Path $repoRoot "installer\components.json"
$components = Get-Content -LiteralPath $componentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$appVersion = [string]$package.version
if ($appVersion -notmatch '^(\d+)\.(\d+)\.(\d+)') {
    throw "package.json version must begin with major.minor.patch: $appVersion"
}
$fileVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"
$askBridgeVersion = [string]$components.askBridge.version
$askBridgeArchiveUrl = [string]$components.askBridge.archiveUrl
$askBridgeArchiveSha256 = ([string]$components.askBridge.archiveSha256).ToLowerInvariant()
$chromeDevtoolsMcpVersion = [string]$components.chromeDevtoolsMcp.version
if ([string]$package.dependencies.'chrome-devtools-mcp' -cne $chromeDevtoolsMcpVersion) {
    throw "package.json must pin chrome-devtools-mcp to $chromeDevtoolsMcpVersion."
}

$npmExe = Resolve-Executable -CommandName "npm.cmd"
if (-not $npmExe) {
    throw "npm.cmd is required on the build computer. It is not required on computers that run the installer."
}

$resolvedNodeExe = Resolve-Executable -ExplicitPath $NodeExe -CommandName "node.exe"
if (-not $resolvedNodeExe) {
    throw "node.exe is required on the build computer."
}

$nodeVersionText = (& $resolvedNodeExe --version).TrimStart('v')
$nodeVersion = [Version]$nodeVersionText
if ($nodeVersion -lt [Version]"20.19.0") {
    throw "Node.js 20.19.0 or newer is required to build the package; found $nodeVersionText."
}

if ($AskBridgeArchive) {
    $resolvedAskBridgeArchive = [IO.Path]::GetFullPath($AskBridgeArchive)
    if (-not (Test-Path -LiteralPath $resolvedAskBridgeArchive -PathType Leaf)) {
        throw "ask-bridge archive not found: $resolvedAskBridgeArchive"
    }
} else {
    $componentCacheDir = Join-Path $releaseDir "component-cache"
    $resolvedAskBridgeArchive = Join-Path $componentCacheDir "ask-bridge-v$askBridgeVersion.zip"
    if (-not (Test-Path -LiteralPath $resolvedAskBridgeArchive -PathType Leaf)) {
        if ($Offline) {
            throw "Offline packaging requires -AskBridgeArchive <path>, or the verified cache file $resolvedAskBridgeArchive."
        }
        Assert-GeneratedPath -Path $componentCacheDir
        New-Item -ItemType Directory -Path $componentCacheDir -Force | Out-Null
        $curlExe = Resolve-Executable -CommandName "curl.exe"
        if (-not $curlExe) {
            throw "curl.exe is required to download the pinned ask-bridge component. Pass -AskBridgeArchive <path> to build without downloading."
        }
        Write-Host "Downloading ask-bridge $askBridgeVersion from its pinned GitHub Release"
        & $curlExe -L --fail --output $resolvedAskBridgeArchive $askBridgeArchiveUrl
        if ($LASTEXITCODE -ne 0) {
            throw "ask-bridge component download failed with exit code $LASTEXITCODE."
        }
    }
}

$actualAskBridgeArchiveSha256 = (Get-Sha256 -Path $resolvedAskBridgeArchive).ToLowerInvariant()
if ($actualAskBridgeArchiveSha256 -cne $askBridgeArchiveSha256) {
    throw "ask-bridge archive SHA-256 mismatch. Expected $askBridgeArchiveSha256, found $actualAskBridgeArchiveSha256."
}

Write-Host "Building ask-bridge-mcp $appVersion with Node.js $nodeVersionText"
& $npmExe run build --prefix $repoRoot
if ($LASTEXITCODE -ne 0) {
    throw "TypeScript build failed with exit code $LASTEXITCODE."
}

Assert-GeneratedPath -Path $stageDir
if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $appStageDir -Force | Out-Null
New-Item -ItemType Directory -Path $bridgeStageDir -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeStageDir -Force | Out-Null
New-Item -ItemType Directory -Path $binStageDir -Force | Out-Null

Expand-Archive -LiteralPath $resolvedAskBridgeArchive -DestinationPath $bridgeStageDir
$stagedAskBridge = Join-Path $bridgeStageDir "ask-bridge.exe"
$stagedAskBridgeUpdater = Join-Path $bridgeStageDir "ask-bridge-update.exe"
foreach ($requiredBridgeFile in @($stagedAskBridge, $stagedAskBridgeUpdater)) {
    if (-not (Test-Path -LiteralPath $requiredBridgeFile -PathType Leaf)) {
        throw "Pinned ask-bridge archive is missing required file: $requiredBridgeFile"
    }
}

Copy-Item -LiteralPath (Join-Path $repoRoot "dist") -Destination (Join-Path $appStageDir "dist") -Recurse
Copy-Item -LiteralPath (Join-Path $repoRoot "package.json") -Destination $appStageDir
Copy-Item -LiteralPath (Join-Path $repoRoot "package-lock.json") -Destination $appStageDir

$npmCiArguments = @(
    "ci",
    "--prefix", $appStageDir,
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund"
)
if ($Offline) {
    $npmCiArguments += @("--offline", "--cache", (Join-Path $repoRoot ".npm-cache"))
}

Write-Host "Installing production dependencies into the release staging directory"
& $npmExe @npmCiArguments
if ($LASTEXITCODE -ne 0) {
    throw "Production dependency staging failed with exit code $LASTEXITCODE."
}

Copy-Item -LiteralPath $resolvedNodeExe -Destination (Join-Path $runtimeStageDir "node.exe")
Copy-Item -LiteralPath (Join-Path $repoRoot "installer\payload\npx.cmd") -Destination $runtimeStageDir
Copy-Item -LiteralPath (Join-Path $repoRoot "installer\payload\ask-bridge.cmd") -Destination $binStageDir
Copy-Item -LiteralPath (Join-Path $repoRoot "installer\payload\ask.cmd") -Destination $binStageDir
Copy-Item -LiteralPath (Join-Path $repoRoot "installer\payload\ask-bridge-mcp.cmd") -Destination $stageDir
Copy-Item -LiteralPath (Join-Path $repoRoot "installer\payload\vscode-mcp.json") -Destination $stageDir
Copy-Item -LiteralPath $componentsPath -Destination $stageDir
Copy-Item -LiteralPath (Join-Path $repoRoot "README.md") -Destination $stageDir
Copy-Item -LiteralPath (Join-Path $repoRoot "examples") -Destination (Join-Path $stageDir "examples") -Recurse

$stagedNode = Join-Path $runtimeStageDir "node.exe"
$stagedEntry = Join-Path $appStageDir "dist\index.js"
$stagedChromeDevtoolsPackage = Get-Content -LiteralPath (Join-Path $appStageDir "node_modules\chrome-devtools-mcp\package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$stagedChromeDevtoolsPackage.version -cne $chromeDevtoolsMcpVersion) {
    throw "Staged chrome-devtools-mcp version mismatch: $($stagedChromeDevtoolsPackage.version)"
}
$stagedAskBridgeVersion = (& $stagedAskBridge --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $stagedAskBridgeVersion -notmatch "(?<![0-9])$([Regex]::Escape($askBridgeVersion))(?![0-9])") {
    throw "Staged ask-bridge version check failed: $stagedAskBridgeVersion"
}
$stagedAskBridgeCommand = Join-Path $binStageDir "ask-bridge.cmd"
$stagedAskCommand = Join-Path $binStageDir "ask.cmd"
foreach ($terminalCommand in @($stagedAskBridgeCommand, $stagedAskCommand)) {
    $terminalVersion = (& $terminalCommand --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $terminalVersion -notmatch "(?<![0-9])$([Regex]::Escape($askBridgeVersion))(?![0-9])") {
        throw "Staged terminal command failed: $terminalCommand ($terminalVersion)"
    }
}
$stagedNpx = Join-Path $runtimeStageDir "npx.cmd"
& $stagedNpx --yes "chrome-devtools-mcp@$chromeDevtoolsMcpVersion" --version
if ($LASTEXITCODE -ne 0) {
    throw "The bundled chrome-devtools-mcp launcher failed with exit code $LASTEXITCODE."
}
& $stagedNode -e "const { pathToFileURL } = require('node:url'); import(pathToFileURL(process.argv[1]).href).then(() => setTimeout(() => process.exit(0), 100))" $stagedEntry
if ($LASTEXITCODE -ne 0) {
    throw "The staged MCP server could not start with the bundled Node.js runtime."
}

Write-Host "Release staging directory is ready: $stageDir"
if ($StageOnly) {
    return
}

$localNsis = Get-ChildItem -Path (Join-Path $repoRoot ".tools\nsis-*\makensis.exe") -File -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
$nsisFallbacks = @(
    $(if ($localNsis) { $localNsis.FullName }),
    (Join-Path $repoRoot ".tools\nsis\makensis.exe"),
    (Join-Path $env:ProgramFiles "NSIS\makensis.exe"),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "NSIS\makensis.exe" }),
    (Join-Path $env:LOCALAPPDATA "Programs\NSIS\makensis.exe")
)
$resolvedMakeNsis = Resolve-Executable -ExplicitPath $MakeNsis -CommandName "makensis.exe" -FallbackPaths $nsisFallbacks
if (-not $resolvedMakeNsis) {
    throw "NSIS makensis.exe was not found. Install NSIS on the build computer, or pass -MakeNsis <path>. The staged offline payload is already available at $stageDir."
}

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
foreach ($artifactPath in @($installerPath, $uninstallerPath, $installerHashPath, $uninstallerHashPath, $legacyInstallerPath)) {
    if (Test-Path -LiteralPath $artifactPath) {
        Assert-GeneratedPath -Path $artifactPath
        Remove-Item -LiteralPath $artifactPath -Force
    }
}

$nsisScript = Join-Path $repoRoot "installer\ask-bridge-mcp.nsi"
& $resolvedMakeNsis "/INPUTCHARSET" "UTF8" "/DAPP_VERSION=$appVersion" "/DFILE_VERSION=$fileVersion" "/DSTAGE_DIR=$stageDir" "/DOUTPUT_FILE=$installerPath" $nsisScript
if ($LASTEXITCODE -ne 0) {
    throw "NSIS failed to build install.exe with exit code $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "NSIS reported success but the installer was not created: $installerPath"
}

$uninstallerScript = Join-Path $repoRoot "installer\ask-bridge-mcp-uninstall.nsi"
& $resolvedMakeNsis "/INPUTCHARSET" "UTF8" "/DAPP_VERSION=$appVersion" "/DFILE_VERSION=$fileVersion" "/DOUTPUT_FILE=$uninstallerPath" $uninstallerScript
if ($LASTEXITCODE -ne 0) {
    throw "NSIS failed to build uninstall.exe with exit code $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
    throw "NSIS reported success but the standalone uninstaller was not created: $uninstallerPath"
}

foreach ($artifactPath in @($installerPath, $uninstallerPath)) {
    if ($resolvedSignTool) {
        Invoke-CodeSigning -ResolvedSignTool $resolvedSignTool -Path $artifactPath
    }
    $artifact = Get-Item -LiteralPath $artifactPath
    $hash = Get-Sha256 -Path $artifactPath
    $hashPath = "$artifactPath.sha256"
    "$($hash.ToLowerInvariant())  $($artifact.Name)" | Out-File -LiteralPath $hashPath -Encoding ascii
    Write-Host "Artifact created: $($artifact.FullName)"
    Write-Host "Size: $($artifact.Length) bytes"
    Write-Host "SHA256: $hash"
    Write-Host "Checksum file: $hashPath"
}

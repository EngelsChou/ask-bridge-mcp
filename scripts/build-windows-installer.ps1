[CmdletBinding()]
param(
    [string]$NodeExe,
    [string]$MakeNsis,
    [switch]$Offline,
    [switch]$StageOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$releaseDir = [IO.Path]::GetFullPath((Join-Path $repoRoot "release"))
$stageDir = [IO.Path]::GetFullPath((Join-Path $releaseDir "stage"))
$appStageDir = Join-Path $stageDir "app"
$runtimeStageDir = Join-Path $stageDir "runtime"
$installerPath = Join-Path $releaseDir "install.exe"
$uninstallerPath = Join-Path $releaseDir "uninstall.exe"
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

if ($env:OS -ne "Windows_NT") {
    throw "The Windows installer can only be built on Windows."
}

$package = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$appVersion = [string]$package.version
if ($appVersion -notmatch '^(\d+)\.(\d+)\.(\d+)') {
    throw "package.json version must begin with major.minor.patch: $appVersion"
}
$fileVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"

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
New-Item -ItemType Directory -Path $runtimeStageDir -Force | Out-Null

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
Copy-Item -LiteralPath (Join-Path $repoRoot "installer\payload\ask-bridge-mcp.cmd") -Destination $stageDir
Copy-Item -LiteralPath (Join-Path $repoRoot "installer\payload\vscode-mcp.json") -Destination $stageDir
Copy-Item -LiteralPath (Join-Path $repoRoot "README.md") -Destination $stageDir

$stagedNode = Join-Path $runtimeStageDir "node.exe"
$stagedEntry = Join-Path $appStageDir "dist\index.js"
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
foreach ($artifactPath in @($installerPath, $uninstallerPath, $legacyInstallerPath)) {
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
    $artifact = Get-Item -LiteralPath $artifactPath
    $hash = Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256
    Write-Host "Artifact created: $($artifact.FullName)"
    Write-Host "Size: $($artifact.Length) bytes"
    Write-Host "SHA256: $($hash.Hash)"
}

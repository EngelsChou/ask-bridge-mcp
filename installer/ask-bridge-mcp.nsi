Unicode True
RequestExecutionLevel user

!ifndef APP_VERSION
  !define APP_VERSION "0.2.7"
!endif
!ifndef FILE_VERSION
  !define FILE_VERSION "0.2.7.0"
!endif
!ifndef STAGE_DIR
  !error "STAGE_DIR is required"
!endif
!ifndef OUTPUT_FILE
  !define OUTPUT_FILE "install.exe"
!endif

!define PRODUCT_NAME "ask-bridge-mcp"
!define PRODUCT_DESCRIPTION "Microsoft 365 Copilot MCP bridge"
!define PRODUCT_PUBLISHER "Engels Chou"
!define PRODUCT_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ask-bridge-mcp"

Name "${PRODUCT_NAME} ${APP_VERSION}"
Caption "${PRODUCT_NAME} 安裝程式"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\ask-bridge-mcp"
SetCompressor /SOLID lzma
SetCompressorDictSize 32
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${FILE_VERSION}"
VIAddVersionKey /LANG=1028 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1028 "FileDescription" "${PRODUCT_DESCRIPTION} 安裝程式"
VIAddVersionKey /LANG=1028 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1028 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1028 "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey /LANG=1028 "LegalCopyright" "Copyright (c) ${PRODUCT_PUBLISHER}"

!include "MUI2.nsh"
!include "StrFunc.nsh"
!include "WinMessages.nsh"
${StrStr}
${UnStrRep}

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\orange-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\orange-uninstall.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "TradChinese"

Function AddBinToUserPath
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 "$INSTDIR\bin"
  StrCmp $0 "" write_only

  StrCpy $2 ";$0;"
  ${StrStr} $3 "$2" ";$1;"
  StrCmp $3 "" append notify

  write_only:
    WriteRegExpandStr HKCU "Environment" "Path" "$1"
    Goto notify

  append:
    WriteRegExpandStr HKCU "Environment" "Path" "$1;$0"

  notify:
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
FunctionEnd

Function un.RemoveBinFromUserPath
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCmp $0 "" done

  StrCpy $1 ";$0;"
  ${UnStrRep} $2 "$1" ";$INSTDIR\bin;" ";"
  StrCmp $2 $1 done
  StrCmp $2 ";" clear_path

  StrLen $3 $2
  IntOp $3 $3 - 2
  StrCpy $2 $2 $3 1
  WriteRegExpandStr HKCU "Environment" "Path" "$2"
  Goto notify

  clear_path:
    DeleteRegValue HKCU "Environment" "Path"

  notify:
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  done:
FunctionEnd

Section "安裝 ask-bridge-mcp" SEC_MAIN
  SetShellVarContext current

  ; Upgrade the complete managed payload while preserving the external login profile.
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\bridge"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\examples"
  Delete "$INSTDIR\ask-bridge-mcp.cmd"
  Delete "$INSTDIR\vscode-mcp.json"
  Delete "$INSTDIR\README.md"

  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*.*"
  Call AddBinToUserPath
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\ask-bridge-mcp"
  CreateShortCut "$SMPROGRAMS\ask-bridge-mcp\VS Code MCP 設定.lnk" "$INSTDIR\vscode-mcp.json"
  CreateShortCut "$SMPROGRAMS\ask-bridge-mcp\README.lnk" "$INSTDIR\README.md"
  CreateShortCut "$SMPROGRAMS\ask-bridge-mcp\解除安裝.lnk" "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "DisplayIcon" "$INSTDIR\bridge\ask-bridge.exe"
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "QuietUninstallString" '$\"$INSTDIR\uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${PRODUCT_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${PRODUCT_REG_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Call un.RemoveBinFromUserPath

  RMDir /r "$SMPROGRAMS\ask-bridge-mcp"
  DeleteRegKey HKCU "${PRODUCT_REG_KEY}"

  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\bridge"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\examples"
  Delete "$INSTDIR\ask-bridge-mcp.cmd"
  Delete "$INSTDIR\vscode-mcp.json"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd

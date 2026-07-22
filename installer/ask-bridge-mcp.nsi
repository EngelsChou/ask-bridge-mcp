Unicode True
RequestExecutionLevel user

!ifndef APP_VERSION
  !define APP_VERSION "0.2.3"
!endif
!ifndef FILE_VERSION
  !define FILE_VERSION "0.2.3.0"
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

Function .onInit
  SearchPath $0 "ask-bridge.exe"
  StrCmp $0 "" ask_bridge_missing ask_bridge_found

  ask_bridge_missing:
    MessageBox MB_ICONEXCLAMATION|MB_YESNO \
      "找不到 ask-bridge.exe。$\r$\n$\r$\n請先獨立安裝並測試 ask-bridge；本安裝程式不會替你安裝它。$\r$\n$\r$\n是否仍要繼續安裝 ask-bridge-mcp？" \
      /SD IDYES IDYES ask_bridge_continue
    Abort

  ask_bridge_continue:
  ask_bridge_found:
FunctionEnd

Section "安裝 ask-bridge-mcp" SEC_MAIN
  SetShellVarContext current

  ; Upgrade cleanly without touching the separately installed ask-bridge.
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\examples"
  Delete "$INSTDIR\ask-bridge-mcp.cmd"
  Delete "$INSTDIR\vscode-mcp.json"
  Delete "$INSTDIR\README.md"

  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\ask-bridge-mcp"
  CreateShortCut "$SMPROGRAMS\ask-bridge-mcp\VS Code MCP 設定.lnk" "$INSTDIR\vscode-mcp.json"
  CreateShortCut "$SMPROGRAMS\ask-bridge-mcp\README.lnk" "$INSTDIR\README.md"
  CreateShortCut "$SMPROGRAMS\ask-bridge-mcp\解除安裝.lnk" "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "DisplayIcon" "$INSTDIR\runtime\node.exe"
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "${PRODUCT_REG_KEY}" "QuietUninstallString" '$\"$INSTDIR\uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${PRODUCT_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${PRODUCT_REG_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current

  RMDir /r "$SMPROGRAMS\ask-bridge-mcp"
  DeleteRegKey HKCU "${PRODUCT_REG_KEY}"

  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\examples"
  Delete "$INSTDIR\ask-bridge-mcp.cmd"
  Delete "$INSTDIR\vscode-mcp.json"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd

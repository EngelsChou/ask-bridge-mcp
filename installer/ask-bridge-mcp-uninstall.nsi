Unicode True
RequestExecutionLevel user

!ifndef APP_VERSION
  !define APP_VERSION "0.2.0"
!endif
!ifndef FILE_VERSION
  !define FILE_VERSION "0.2.0.0"
!endif
!ifndef OUTPUT_FILE
  !define OUTPUT_FILE "uninstall.exe"
!endif
!ifndef INSTALL_DIR
  !define INSTALL_DIR "$LOCALAPPDATA\Programs\ask-bridge-mcp"
!endif

!define PRODUCT_NAME "ask-bridge-mcp"
!define PRODUCT_DESCRIPTION "Microsoft 365 Copilot MCP bridge"
!define PRODUCT_PUBLISHER "Engels Chou"
!define PRODUCT_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ask-bridge-mcp"

Name "${PRODUCT_NAME} ${APP_VERSION} 解除安裝"
Caption "${PRODUCT_NAME} 解除安裝"
OutFile "${OUTPUT_FILE}"
InstallDir "${INSTALL_DIR}"
SilentInstall normal
AutoCloseWindow true
ShowInstDetails nevershow
ShowUninstDetails show

VIProductVersion "${FILE_VERSION}"
VIAddVersionKey /LANG=1028 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1028 "FileDescription" "${PRODUCT_DESCRIPTION} 獨立解除安裝程式"
VIAddVersionKey /LANG=1028 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1028 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1028 "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey /LANG=1028 "LegalCopyright" "Copyright (c) ${PRODUCT_PUBLISHER}"

!include "MUI2.nsh"

!define MUI_ABORTWARNING
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\orange-uninstall.ico"

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "TradChinese"

Var PassSilent

Function .onInit
  StrCpy $PassSilent ""
  IfSilent 0 not_silent
  StrCpy $PassSilent "/S"

  not_silent:
    ; The bootstrap stays hidden; the generated real uninstaller owns the UI.
    SetSilent silent
FunctionEnd

Section "Create uninstaller bootstrap" SEC_BOOTSTRAP
  SetShellVarContext current

  IfFileExists "${INSTALL_DIR}\runtime\node.exe" installed not_installed

  not_installed:
    MessageBox MB_ICONINFORMATION|MB_OK \
      "找不到已安裝的 ask-bridge-mcp。$\r$\n$\r$\n預期位置：${INSTALL_DIR}"
    SetErrorLevel 2
    Quit

  installed:
    InitPluginsDir
    WriteUninstaller "$PLUGINSDIR\ask-bridge-mcp-uninstall.exe"
    StrCmp $PassSilent "/S" run_silent run_interactive

  run_silent:
    ExecWait '$\"$PLUGINSDIR\ask-bridge-mcp-uninstall.exe$\" /S' $0
    Goto done

  run_interactive:
    ExecWait '$\"$PLUGINSDIR\ask-bridge-mcp-uninstall.exe$\"' $0

  done:
    SetErrorLevel $0
SectionEnd

Function un.onInit
  StrCpy $INSTDIR "${INSTALL_DIR}"
FunctionEnd

Section "Uninstall"
  SetShellVarContext current

  RMDir /r "$SMPROGRAMS\ask-bridge-mcp"
  DeleteRegKey HKCU "${PRODUCT_REG_KEY}"

  RMDir /r "${INSTALL_DIR}\app"
  RMDir /r "${INSTALL_DIR}\runtime"
  RMDir /r "${INSTALL_DIR}\examples"
  Delete "${INSTALL_DIR}\ask-bridge-mcp.cmd"
  Delete "${INSTALL_DIR}\vscode-mcp.json"
  Delete "${INSTALL_DIR}\README.md"
  Delete "${INSTALL_DIR}\uninstall.exe"
  RMDir "${INSTALL_DIR}"
SectionEnd

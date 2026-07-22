@echo off
setlocal
set "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1"

if /I "%~1"=="--yes" shift /1
if /I not "%~1"=="chrome-devtools-mcp@1.5.0" (
  echo Bundled npx supports only chrome-devtools-mcp@1.5.0. 1>&2
  exit /b 64
)
shift /1

"%~dp0node.exe" "%~dp0..\app\node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js" %*
exit /b %ERRORLEVEL%

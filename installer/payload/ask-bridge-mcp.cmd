@echo off
set "ASK_BRIDGE_PATH=%~dp0bridge\ask-bridge.exe"
set "PATH=%~dp0runtime;%PATH%"
"%~dp0runtime\node.exe" "%~dp0app\dist\index.js" %*

@echo off
setlocal
set "PATH=%~dp0..\runtime;%PATH%"
"%~dp0..\bridge\ask-bridge.exe" %*
exit /b %ERRORLEVEL%

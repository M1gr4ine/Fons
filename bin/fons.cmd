@echo off
node "%~dp0..\scripts\fons-cli.mjs" %*
exit /b %ERRORLEVEL%

@echo off
setlocal
set "LOCAL_PLUG_MARKER=..\..\..\.agents\plugins\fons\hooks.json"
set "REL_INBOX=..\..\fons\ideas.md"

if exist "%LOCAL_PLUG_MARKER%" (
  if not exist "%REL_INBOX%" goto :fast_exit
  for %%A in ("%REL_INBOX%") do if %%~zA EQU 0 goto :fast_exit
)

node "%~dp0fons-hook.mjs"
exit /b %ERRORLEVEL%

:fast_exit
if "%~1"=="Stop" (
  echo {"decision":"allow"}
) else (
  echo {}
)
exit /b 0

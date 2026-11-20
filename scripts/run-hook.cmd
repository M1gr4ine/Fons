@echo off
setlocal
set "LOCAL_PLUG_MARKER=..\..\..\.agents\plugins\fons\hooks.json"
set "REL_FONS=..\..\fons"

if exist "%LOCAL_PLUG_MARKER%" (
  if /i "%~1"=="SessionStart" goto :run
  for %%F in ("%REL_FONS%\ideas-*.md" "%REL_FONS%\ideas.md") do if exist "%%~fF" if %%~zF GTR 0 goto :run
  if /i "%~1"=="PreInvocation" (
    for %%F in ("%REL_FONS%\.retract-*.pending") do if exist "%%~fF" goto :run
  )
  goto :fast_exit
)

:run
node "%~dp0fons-hook.mjs" --scope=workspace
exit /b %ERRORLEVEL%

:fast_exit
if /i "%~1"=="Stop" (
  echo {"decision":"allow"}
) else (
  echo {}
)
exit /b 0
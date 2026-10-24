@echo off
rem eNCode in a terminal (ADR 0108): the app's own program, run as Node.js, runs the command line
rem bundled in the app. Put this folder on PATH to type `encode` anywhere; `encode --help` lists the rest.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\eNCode.exe" "%~dp0..\resources\app.asar\dist\electron\encode-cli.cjs" %*
exit /b %ERRORLEVEL%

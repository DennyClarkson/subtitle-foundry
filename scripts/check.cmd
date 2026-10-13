@echo off
setlocal
cd /d "%~dp0.."
set "PATH=%CD%\runtime\node-v24.21.0-win-x64;%PATH%"
set "TEMP=%CD%\data\temp"
set "TMP=%TEMP%"
set "npm_config_cache=%CD%\data\npm-cache"
call runtime\node-v24.21.0-win-x64\npm.cmd run typecheck
if errorlevel 1 exit /b 1
call runtime\node-v24.21.0-win-x64\npm.cmd test
if errorlevel 1 exit /b 1
call runtime\node-v24.21.0-win-x64\npm.cmd run build

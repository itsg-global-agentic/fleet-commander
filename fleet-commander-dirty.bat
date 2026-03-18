@echo off
set PORT=4681
set FLEET_DB_PATH=%~dp0fleet-dirty.db
node "%~dp0dist\server\index.js"

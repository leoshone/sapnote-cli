@echo off
rem sapnote.cmd - shim entry, same folder as cli.js, %~dp0 = this file's dir
rem so the whole folder is portable (move anywhere, no edit needed)
node "%~dp0cli.js" %*

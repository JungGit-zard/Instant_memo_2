@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:5174
npm run dev -- --port 5174

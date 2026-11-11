@echo off
rem ローカルサーバーを起動してブラウザで開く（終了は Ctrl+C）
cd /d "%~dp0"
start "" http://localhost:8000
python -m http.server 8000 --bind 127.0.0.1

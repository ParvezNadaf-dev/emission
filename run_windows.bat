@echo off
REM Emission & Noise Monitor - first run installs packages, then starts the server
cd /d "%~dp0"
if not exist .venv (
  echo Creating virtual environment...
  python -m venv .venv || (echo Python was not found. Install Python 3.10+ from python.org and tick "Add to PATH". & pause & exit /b 1)
)
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo A .env file was created. Open it, set DB_PASSWORD to your MySQL password, then run this file again.
  notepad .env
  pause
  exit /b 0
)
start "" http://127.0.0.1:5000
python app.py
pause

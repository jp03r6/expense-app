@echo off
title ExpenseSnap - Cross-Platform Receipt & Expense App
echo Starting ExpenseSnap server...
python server.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Trying fallback Python path...
    "%USERPROFILE%\.local\bin\python.cmd" server.py
)
pause

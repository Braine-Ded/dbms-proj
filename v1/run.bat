@echo off
rem Starts Stride v1 on http://localhost:%PORT%  (the Windows version of run.sh)
rem
rem   run.bat            start the site
rem   run.bat --reset    build the database first: 00_account.sql and 01_schema.sql as root
rem                      (asks for the MySQL root password), then migrate, then 02_seed.sql
rem
rem Settings and passwords come from .env.
setlocal
cd /d "%~dp0"

rem .env -> environment (variables already set in the shell win)
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do if not defined %%a set "%%a=%%b"

rem the mysql client: on PATH, or in the MySQL Server install folder
where mysql >nul 2>nul
if errorlevel 1 for /d %%d in ("%ProgramFiles%\MySQL\MySQL Server *") do set "PATH=%%d\bin;%PATH%"
set "HAVE_MYSQL=1"
where mysql >nul 2>nul || set "HAVE_MYSQL="

rem Python environment (mysqlclient has Windows wheels for Python 3.11 to 3.13)
if exist .venv\Scripts\python.exe goto have_venv
echo Creating .venv and installing requirements...
py -3.13 -m venv .venv 2>nul || py -3.12 -m venv .venv 2>nul || py -3.11 -m venv .venv 2>nul || python -m venv .venv || goto no_python
.venv\Scripts\python -m pip install -q -r requirements.txt || goto pip_failed
:have_venv
set "PY=.venv\Scripts\python"

if /i not "%~1"=="--reset" goto check
if not defined HAVE_MYSQL goto no_mysql
echo 1/3  db\00_account.sql + db\01_schema.sql as root  (recreates %DB_USER% and %DB_NAME%)
type db\00_account.sql db\01_schema.sql 2>nul | mysql -h %DB_HOST% -P %DB_PORT% -u root -p || goto failed
echo 2/3  manage.py migrate  (Django's own tables: sessions, admin log, permissions)
%PY% manage.py migrate --verbosity 0 || goto failed
echo 3/3  db\02_seed.sql  (sample users, catalogue and four weeks of logs)
mysql -h %DB_HOST% -P %DB_PORT% -u %DB_USER% -p%DB_PASSWORD% < db\02_seed.sql || goto failed

:check
if not defined HAVE_MYSQL goto start
mysql -h %DB_HOST% -P %DB_PORT% -u %DB_USER% -p%DB_PASSWORD% -N -e "SELECT 1 FROM %DB_NAME%.Users LIMIT 1" >nul 2>nul && goto start
echo Can't read %DB_NAME%.Users as %DB_USER%@%DB_HOST%:%DB_PORT%.
echo First time on this computer? Run:  run.bat --reset
exit /b 1

:start
echo.
echo   Stride v1:    http://localhost:%PORT%
echo   Admin panel:  http://localhost:%PORT%/admin/   (%SEED_ADMIN_USER% / %SEED_ADMIN_PASSWORD%)
echo   Stop with Ctrl+C.
echo.
%PY% manage.py runserver 0.0.0.0:%PORT%
exit /b

:no_python
echo Python not found. Install Python 3.12 from python.org and tick "Add python.exe to PATH".
exit /b 1
:pip_failed
echo pip install failed. mysqlclient needs Python 3.11, 3.12 or 3.13: install one, delete .venv, run again.
exit /b 1
:no_mysql
echo The mysql client was not found. Install MySQL Server 8 (MySQL Installer), or add its bin folder to PATH.
exit /b 1
:failed
echo Stopped: the step above failed.
exit /b 1

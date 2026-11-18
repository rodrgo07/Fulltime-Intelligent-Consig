@echo off
rem Robo do Fulltime Intelligent Consig. Nao precisa de administrador.
rem Primeira execucao: cria o ambiente Python na pasta e instala as dependencias (precisa de acesso ao PyPI).
setlocal
cd /d "%~dp0"
set FIC_ROBOT_HOME=%~dp0
if not exist ".venv\Scripts\python.exe" (
  echo Preparando o ambiente Python...
  py -3 -m venv .venv || python -m venv .venv || goto :erro
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q . || goto :erro
)
:loop
".venv\Scripts\python.exe" -m fic_robot
rem Codigo 3 = reinicio pedido pelo painel.
if %ERRORLEVEL%==3 goto :loop
pause
exit /b %ERRORLEVEL%
:erro
echo Nao foi possivel preparar o ambiente. Verifique o Python e o acesso a internet.
pause
exit /b 1

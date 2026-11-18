@echo off
rem Ensaio do fluxo do Consig: roda as etapas mapeadas e para antes do envio. Nao reserva job.
rem Feche o robo antes (os dois usam o mesmo perfil do Chrome). Rode o iniciar.bat uma vez antes.
setlocal
cd /d "%~dp0"
set FIC_ROBOT_HOME=%~dp0
if not exist ".venv\Scripts\python.exe" (
  echo Rode o iniciar.bat uma vez para preparar o ambiente.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m fic_robot.ensaio
pause

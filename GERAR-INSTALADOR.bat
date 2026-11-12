@echo off
setlocal EnableDelayedExpansion
title M^&M Odontologia LTDA - Instalador e Gerador de .exe
color 0A

echo.
echo  =====================================================
echo   M^&M Odontologia LTDA - WhatsApp Sender
echo   Instalador e Gerador de .exe para Windows
echo  =====================================================
echo.

:: -- 1. Detectar Node.js ------------------------------------------------------
set "NODE_EXE="
for %%P in (node.exe) do set "NODE_EXE=%%~$PATH:P"

if not defined NODE_EXE (
    if exist "C:\Program Files\nodejs\node.exe"        set "NODE_EXE=C:\Program Files\nodejs\node.exe"
    if exist "C:\Program Files (x86)\nodejs\node.exe"  set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
    if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe"  set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
)

if not defined NODE_EXE (
    echo  [ATENCAO] Node.js nao foi encontrado!
    echo  Baixe em: https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi
    echo  Instale e execute este arquivo novamente.
    start "" "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
    pause
    exit /b 1
)

for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"
echo  [OK] Node.js: %NODE_EXE%

set "NPM_CMD=%NODE_DIR%npm.cmd"
if not exist "%NPM_CMD%" set "NPM_CMD=%NODE_DIR%npm"
echo  [OK] npm: %NPM_CMD%

:: -- 2. Limpar cache npm corrompido --------------------------------------------
echo.
echo  [1/4] Limpando cache npm corrompido...
call "%NPM_CMD%" cache clean --force >nul 2>&1
echo  [OK] Cache limpo.

:: -- 3. Copiar projeto para C:\mm-sender (sem espacos no caminho) --------------
set "DEST=C:\mm-sender"
set "ORIGEM=%~dp0"
:: Remove barra final
if "%ORIGEM:~-1%"=="\" set "ORIGEM=%ORIGEM:~0,-1%"

echo.
echo  [2/4] Copiando projeto para %DEST% (sem espacos no caminho)...
if exist "%DEST%" (
    rmdir /s /q "%DEST%" >nul 2>&1
)
mkdir "%DEST%" >nul 2>&1

:: Copia tudo exceto node_modules e dist
robocopy "%ORIGEM%" "%DEST%" /E /XD node_modules dist .wwebjs_auth /XF "*.log" /NFL /NDL /NJH /NJS >nul 2>&1
if errorlevel 8 (
    echo  [ERRO] Falha ao copiar arquivos. Verifique permissoes.
    pause
    exit /b 1
)
echo  [OK] Arquivos copiados para %DEST%

:: -- 4. npm install ------------------------------------------------------------
echo.
echo  [3/4] Instalando dependencias (pode demorar 5-15 min na 1a vez)...
echo        Aguarde - sera feito o download do Electron e Chromium...
echo.

cd /d "%DEST%"
call "%NPM_CMD%" install
if errorlevel 1 (
    echo.
    echo  [ERRO] Falha no npm install. Veja os erros acima.
    pause
    exit /b 1
)
echo.
echo  [OK] Dependencias instaladas!

:: -- 5. npm run build ----------------------------------------------------------
echo.
echo  [4/4] Gerando instalador .exe...
echo        Aguarde...
echo.

call "%NPM_CMD%" run build
if errorlevel 1 (
    echo.
    echo  [ERRO] Falha ao gerar instalador. Veja os erros acima.
    pause
    exit /b 1
)

:: -- Resultado -----------------------------------------------------------------
echo.
echo  =====================================================
echo   SUCESSO!
echo   Instalador gerado em: %DEST%\dist\
echo  =====================================================
echo.

if exist "%DEST%\dist" (
    explorer "%DEST%\dist"
)

pause

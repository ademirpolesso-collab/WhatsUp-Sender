# ============================================================
#  M&M Odontologia LTDA — WhatsApp Sender
#  Script de instalação e geração do instalador .exe
#  Execute com: powershell -ExecutionPolicy Bypass -File instalar-e-compilar.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "M&M Odontologia — Setup"

function Write-Step([string]$msg) {
    Write-Host "`n[ ] $msg" -ForegroundColor Cyan
}
function Write-OK([string]$msg) {
    Write-Host "[OK] $msg" -ForegroundColor Green
}
function Write-Fail([string]$msg) {
    Write-Host "[ERRO] $msg" -ForegroundColor Red
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  M&M Odontologia LTDA — WhatsApp Sender" -ForegroundColor Green
Write-Host "  Instalador e Gerador de .exe" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""

# ── 1. Detectar / instalar Node.js ────────────────────────────────────────────
Write-Step "Verificando Node.js..."

$nodePath = $null
$candidatos = @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:APPDATA\nvm\current\node.exe"
)
foreach ($c in $candidatos) {
    if (Test-Path $c) { $nodePath = $c; break }
}

if (-not $nodePath) {
    Write-Host "  Node.js nao encontrado. Baixando instalador LTS..." -ForegroundColor Yellow
    $nodeInstaller = "$env:TEMP\node-installer.msi"
    $nodeUrl = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
    Write-Host "  Baixando de: $nodeUrl" -ForegroundColor Gray

    try {
        $wc = New-Object System.Net.WebClient
        $wc.DownloadFile($nodeUrl, $nodeInstaller)
    } catch {
        Write-Fail "Falha ao baixar Node.js. Verifique a conexao com a internet."
        Write-Host "  Baixe manualmente em: https://nodejs.org" -ForegroundColor Yellow
        Read-Host "Pressione ENTER para sair"
        exit 1
    }

    Write-Host "  Instalando Node.js (requer permissao de administrador)..." -ForegroundColor Yellow
    Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /quiet /norestart" -Wait -Verb RunAs

    # Atualiza PATH na sessao atual
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")

    $nodePath = "C:\Program Files\nodejs\node.exe"
    if (-not (Test-Path $nodePath)) {
        Write-Fail "Instalacao do Node.js falhou. Instale manualmente em https://nodejs.org"
        Read-Host "Pressione ENTER para sair"
        exit 1
    }
    Write-OK "Node.js instalado com sucesso"
} else {
    Write-OK "Node.js encontrado: $nodePath"
}

# Garante que npm e node estejam no PATH
$nodeDir = Split-Path $nodePath
if ($env:PATH -notlike "*$nodeDir*") {
    $env:PATH = "$nodeDir;$env:PATH"
}

$nodeVersion = & node --version 2>&1
$npmVersion  = & npm  --version 2>&1
Write-OK "node $nodeVersion / npm $npmVersion"

# ── 2. Instalar dependências ──────────────────────────────────────────────────
Write-Step "Instalando dependencias do projeto (pode demorar alguns minutos)..."
Write-Host "  Isso inclui Electron, whatsapp-web.js e Puppeteer/Chromium." -ForegroundColor Gray
Write-Host "  Aguarde..." -ForegroundColor Gray

Set-Location $PSScriptRoot

try {
    & npm install --prefer-offline 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    if ($LASTEXITCODE -ne 0) { throw "npm install retornou codigo $LASTEXITCODE" }
    Write-OK "Dependencias instaladas"
} catch {
    Write-Fail "Falha ao instalar dependencias: $_"
    Read-Host "Pressione ENTER para sair"
    exit 1
}

# ── 3. Gerar instalador .exe ──────────────────────────────────────────────────
Write-Step "Gerando instalador Windows (.exe)..."
Write-Host "  Aguarde — este passo pode demorar 2-5 minutos..." -ForegroundColor Gray

try {
    & npm run build 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    if ($LASTEXITCODE -ne 0) { throw "electron-builder retornou codigo $LASTEXITCODE" }
    Write-OK "Build concluido!"
} catch {
    Write-Fail "Falha ao gerar instalador: $_"
    Read-Host "Pressione ENTER para sair"
    exit 1
}

# ── 4. Abrir pasta dist ───────────────────────────────────────────────────────
$distPath = Join-Path $PSScriptRoot "dist"
if (Test-Path $distPath) {
    Write-Host ""
    Write-Host "=============================================" -ForegroundColor Green
    Write-Host "  SUCESSO! Instalador gerado em:" -ForegroundColor Green
    Write-Host "  $distPath" -ForegroundColor White
    Write-Host "=============================================" -ForegroundColor Green
    Start-Process explorer.exe $distPath
} else {
    Write-Host "  Pasta dist nao encontrada. Verifique os logs acima." -ForegroundColor Yellow
}

Read-Host "`nPressione ENTER para fechar"

param(
  [string]$RootDir = '',
  [switch]$RunBuild
)
$ErrorActionPreference = 'Continue'

if ([string]::IsNullOrWhiteSpace($RootDir)) {
  $RootDir = Split-Path -Parent $PSScriptRoot
}
$RootDir = [System.IO.Path]::GetFullPath($RootDir)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$cfgPath = Join-Path $RootDir 'configuracoes\clinic-settings.json'
if (-not (Test-Path -LiteralPath $cfgPath)) {
  Write-Host '[AVISO] clinic-settings.json nao encontrado em configuracoes.' -ForegroundColor Yellow
  exit 0
}

$cfgRaw = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8)
$cfgObj = $cfgRaw | ConvertFrom-Json

# 1. Sincroniza clinic-settings.json e modulos em %APPDATA%, %LOCALAPPDATA%, resources\app e raiz do mm-sender
$syncTargets = @()
if ($env:APPDATA) {
  $syncTargets += (Join-Path $env:APPDATA 'mm-sender\configuracoes\clinic-settings.json')
}
if ($env:LOCALAPPDATA) {
  $syncTargets += (Join-Path $env:LOCALAPPDATA 'mm-sender\configuracoes\clinic-settings.json')
}
$syncTargets += (Join-Path $RootDir 'clinic-settings.json')
$resAppCandidates = @(
  (Join-Path $RootDir 'resources\app'),
  (Join-Path $RootDir 'resources'),
  (Join-Path $RootDir 'release\win-unpacked\resources\app'),
  (Join-Path $RootDir 'release\win-unpacked\resources')
)
foreach ($resBase in $resAppCandidates) {
  if (Test-Path -LiteralPath $resBase) {
    $resCfgDir = Join-Path $resBase 'configuracoes'
    if (-not (Test-Path -LiteralPath $resCfgDir)) { New-Item -ItemType Directory -Force -Path $resCfgDir | Out-Null }
    try { Copy-Item -Path (Join-Path $RootDir 'configuracoes\*') -Destination $resCfgDir -Force -ErrorAction SilentlyContinue } catch {}
    $syncTargets += (Join-Path $resCfgDir 'clinic-settings.json')
  }
}

foreach ($st in $syncTargets) {
  try {
    $stDir = Split-Path -Parent $st
    if ($stDir -and -not (Test-Path -LiteralPath $stDir)) {
      New-Item -ItemType Directory -Force -Path $stDir | Out-Null
    }
    [System.IO.File]::WriteAllText($st, $cfgRaw, $utf8NoBom)
  } catch {}
}

# 2. Prepara snippet HTML com Config Geral e Config Zelda separadas + Dashboard Serena sem status da Zelda
$injectorTemplatePath = Join-Path $RootDir 'configuracoes\serena-ui-injector.html'
$injectorHtml = ''
if (Test-Path -LiteralPath $injectorTemplatePath) {
  $injectorHtml = [System.IO.File]::ReadAllText($injectorTemplatePath, [System.Text.Encoding]::UTF8)
  $addrResolved = if ($cfgObj.clinicAddress) { [string]$cfgObj.clinicAddress } else { [string]$cfgObj.address }
  $zeldaGrpResolved = if ($cfgObj.zeldaGroupTarget) { [string]$cfgObj.zeldaGroupTarget } elseif ($cfgObj.grupoZelda) { [string]$cfgObj.grupoZelda } else { '' }
  $zeldaCaretakerResolved = if ($cfgObj.zeldaCaretakerPhone) { [string]$cfgObj.zeldaCaretakerPhone } else { '' }
  $zeldaQuorumResolved = if ($cfgObj.zeldaApprovalQuorum) { [int]$cfgObj.zeldaApprovalQuorum } else { 3 }
  $hourlyResolved = if ($cfgObj.maxActiveMessagesPerHour) { [int]$cfgObj.maxActiveMessagesPerHour } else { 30 }
  $defaultsCompact = @{
    clinicName = [string]$cfgObj.clinicName
    clinicAddress = $addrResolved
    parkingInfo = [string]$cfgObj.parkingInfo
    zeldaGroupEnabled = ($cfgObj.zeldaGroupEnabled -ne $false)
    zeldaGroupTarget = $zeldaGrpResolved
    zeldaCaretakerPhone = $zeldaCaretakerResolved
    zeldaApprovalQuorum = $zeldaQuorumResolved
    zeldaAllowFromMeTest = ($cfgObj.zeldaAllowFromMeTest -ne $false)
    maxActiveMessagesPerHour = $hourlyResolved
    enableSpintax = ($cfgObj.enableSpintax -ne $false)
    enableOptOutBlacklist = ($cfgObj.enableOptOutBlacklist -ne $false)
    serenaKeepUnreadForHuman = ($cfgObj.serenaKeepUnreadForHuman -ne $false)
  } | ConvertTo-Json -Compress
  $dStart = '/*__SERENA_DEFAULTS_START__*/'
  $dEnd = '/*__SERENA_DEFAULTS_END__*/'
  $dsIdx = $injectorHtml.IndexOf($dStart, [System.StringComparison]::Ordinal)
  $deIdx = $injectorHtml.IndexOf($dEnd, [System.StringComparison]::Ordinal)
  if ($dsIdx -ge 0 -and $deIdx -gt $dsIdx) {
    $injectorHtml = $injectorHtml.Substring(0, $dsIdx + $dStart.Length) + $defaultsCompact + $injectorHtml.Substring($deIdx)
  }
}

function Test-ShouldSkipPath([string]$fullPath) {
  $rel = $fullPath.Substring($RootDir.Length).TrimStart('\', '/')
  $parts = $rel -split '[\\/]'
  $skipDirs = @('node_modules', '.git', '.venv', 'venv', '__pycache__', '.wwebjs_auth', '.wwebjs_cache', 'auth_serena', 'configuracoes', 'dados')
  foreach ($p in $parts) {
    $lp = $p.ToLowerInvariant()
    if ($skipDirs -contains $lp) { return $true }
    if ($lp.StartsWith('backup_antes_serena')) { return $true }
  }
  return $false
}

$diagFindings = New-Object System.Collections.Generic.List[object]

$entryRelCandidates = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)
foreach ($defaultRootEntry in @('index.js', 'main.js', 'server.js', 'app.js', 'bot.js', 'electron.js', 'src/index.js', 'src/main.js', 'src/server.js', 'src/bot.js', 'index.ts', 'main.ts', 'server.ts', 'app.ts', 'bot.ts', 'src/index.ts', 'src/main.ts', 'src/server.ts', 'src/bot.ts', 'electron/main.ts', 'electron/main.js')) {
  [void]$entryRelCandidates.Add($defaultRootEntry)
}
$rootPkgFile = Join-Path $RootDir 'package.json'
if (Test-Path -LiteralPath $rootPkgFile) {
  try {
    $rootPkgObj = [System.IO.File]::ReadAllText($rootPkgFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($rootPkgObj.main) { [void]$entryRelCandidates.Add((([string]$rootPkgObj.main) -replace '^\./', '').Replace('\', '/')) }
    if ($rootPkgObj.scripts) {
      foreach ($scVal in @($rootPkgObj.scripts.start, $rootPkgObj.scripts.dev)) {
        if ($scVal -and ([string]$scVal -match '([A-Za-z0-9_./\\-]+\.(?:js|cjs|mjs|ts))')) {
          [void]$entryRelCandidates.Add((([string]$Matches[1]) -replace '^\./', '').Replace('\', '/'))
        }
      }
    }
  } catch {}
}

function Invoke-PatchAllUiAndBotFiles {
  $patchedList = New-Object System.Collections.Generic.List[string]
  $allFiles = Get-ChildItem -LiteralPath $RootDir -Recurse -File -ErrorAction SilentlyContinue
  foreach ($file in $allFiles) {
    if (Test-ShouldSkipPath $file.FullName) { continue }
    $rel = $file.FullName.Substring($RootDir.Length).TrimStart('\', '/').Replace('\', '/')
    $ext = $file.Extension.ToLowerInvariant()

    # A) Patch HTML / EJS / WebView / Electron / Vite dist
    if (($ext -eq '.html' -or $ext -eq '.htm' -or $ext -eq '.ejs') -and $injectorHtml.Length -gt 0) {
      try {
        $html = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        if ($html -match '(?i)</body>' -or $html -match '(?i)</html>') {
          $startTag = '<!-- SERENA_CLINIC_CONFIG_START -->'
          $endTag = '<!-- SERENA_CLINIC_CONFIG_END -->'
          $sIdx = $html.IndexOf($startTag, [System.StringComparison]::Ordinal)
          $eIdx = $html.IndexOf($endTag, [System.StringComparison]::Ordinal)
          if ($sIdx -ge 0 -and $eIdx -gt $sIdx) {
            $html = $html.Substring(0, $sIdx) + $injectorHtml + $html.Substring($eIdx + $endTag.Length)
          } else {
            $bIdx = $html.LastIndexOf('</body>', [System.StringComparison]::OrdinalIgnoreCase)
            if ($bIdx -ge 0) {
              $html = $html.Substring(0, $bIdx) + $injectorHtml + "`r`n" + $html.Substring($bIdx)
            } else {
              $html = $html + "`r`n" + $injectorHtml
            }
          }
          [System.IO.File]::WriteAllText($file.FullName, $html, $utf8NoBom)
          $patchedList.Add($rel)
        }
      } catch {}
    }

    # B0) Patch TypeScript de Backend/Electron/WhatsApp (.ts) para sobreviver ao GERAR-INSTALADOR (tsc / vite / tsup / electron-builder)
    if (($ext -eq '.ts') -and (-not $rel.EndsWith('.d.ts')) -and ($file.Length -lt 2500000)) {
      try {
        $tsTxt = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        $tsHasBackend = ($tsTxt -match 'express\s*\(\s*\)') -or ($tsTxt -match '\bipcMain\b') -or ($tsTxt -match 'BrowserWindow') -or ($tsTxt -match 'BrowserView') -or ($tsTxt -match 'WebContentsView') -or ($tsTxt -match 'web\.whatsapp\.com')
        $tsHasWa = ($tsTxt -match 'whatsapp-web\.js') -or ($tsTxt -match 'baileys') -or ($tsTxt -match 'makeWASocket') -or ($tsTxt -match 'wppconnect') -or ($tsTxt -match 'venom') -or ($tsTxt -match 'puppeteer') -or ($tsTxt -match 'playwright')
        $tsMentionsZelda = $tsTxt -match '(?i)\bzelda\b'
        $tsIsEntry = $entryRelCandidates.Contains($rel)
        if ($tsMentionsZelda -or ($tsTxt -match '@g\.us')) {
          $diagFindings.Add(@{ file = $rel; mentionsZelda = $tsMentionsZelda; hasGroupFilter = ($tsTxt -match '@g\.us'); isTs = $true })
        }
        if ($tsHasBackend -or $tsHasWa -or $tsIsEntry) {
          $tsStart = '// === SERENA_RUNTIME_AUTOHOOK_START ==='
          $tsEnd = '// === SERENA_RUNTIME_AUTOHOOK_END ==='
          $tsHook = @(
            $tsStart,
            'try { Function(''try{var m=typeof process!=="undefined"&&typeof process.getBuiltinModule==="function"?process.getBuiltinModule("module"):null;var req=typeof require==="function"?require:(m&&m.createRequire?m.createRequire(process.cwd()+"/index.js"):(typeof process!=="undefined"&&process.mainModule&&process.mainModule.require));if(req){var p=req("path"),f=req("fs"),cwd=process.cwd(),rp=(typeof process!=="undefined"&&process.resourcesPath)||"";var cs=[p.join(cwd,"configuracoes")];if(rp){cs.push(p.join(rp,"app","configuracoes"),p.join(rp,"configuracoes"));}for(var i=0;i<cs.length;i++){var h=p.join(cs[i],"runtimeAutoHook.cjs");if(f.existsSync(h)){req(h);break;}}}}catch(e){}'')(); } catch {}',
            $tsEnd
          ) -join "`r`n"
          $tsIdx1 = $tsTxt.IndexOf($tsStart, [System.StringComparison]::Ordinal)
          $tsIdx2 = $tsTxt.IndexOf($tsEnd, [System.StringComparison]::Ordinal)
          if ($tsIdx1 -ge 0 -and $tsIdx2 -gt $tsIdx1) {
            $tsTxt = $tsTxt.Substring(0, $tsIdx1) + $tsHook + $tsTxt.Substring($tsIdx2 + $tsEnd.Length)
          } else {
            $tsTxt = $tsHook + "`r`n" + $tsTxt
          }
          [System.IO.File]::WriteAllText($file.FullName, $tsTxt, $utf8NoBom)
          $patchedList.Add($rel)
        }
      } catch {}
    }

    # B) Patch + Diagnostico em arquivos Node/Electron/WhatsApp (.js / .cjs / .mjs) - CJS e ESM!
    $isStaticMinAsset = ($rel -match '(?i)(^|/)(public|static)/') -or ($rel -match '(?i)\.min\.js$')
    if (($ext -eq '.js' -or $ext -eq '.cjs' -or $ext -eq '.mjs') -and ($file.Length -lt 8500000) -and ($rel -ne 'serenaEngine.cjs') -and (-not $isStaticMinAsset)) {
      try {
        $js = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        $hasReq = $js -match '\brequire\s*\('
        $isEsm = ($ext -eq '.mjs') -or (($js -match '(?m)^\s*import\s+[\s\S]{1,180}?\s+from\s+[''\"]') -and (-not $hasReq)) -or ($js -match '(?m)^\s*export\s+(default|const|function|class|async)\b')
        $isFrontendAsset = ($rel -match '(?i)(^|/)assets/') -and (-not $hasReq)
        $hasBackend = ($js -match 'express\s*\(\s*\)') -or ($js -match '\bipcMain\b') -or ($js -match 'BrowserWindow') -or ($js -match 'BrowserView') -or ($js -match 'WebContentsView') -or ($js -match 'web\.whatsapp\.com')
        $hasWaClient = ($js -match 'whatsapp-web\.js') -or ($js -match 'baileys') -or ($js -match 'makeWASocket') -or ($js -match 'wppconnect') -or ($js -match 'venom') -or ($js -match 'puppeteer') -or ($js -match 'playwright') -or ($js -match '\.on\s*\(\s*[''\"]message')
        $mentionsZelda = $js -match '(?i)\bzelda\b'
        $isEntryJs = $entryRelCandidates.Contains($rel)

        if ($mentionsZelda -or ($js -match '@g\.us')) {
          $diagFindings.Add(@{ file = $rel; mentionsZelda = $mentionsZelda; hasGroupFilter = ($js -match '@g\.us'); isEsm = $isEsm })
        }

        if ((-not $isFrontendAsset) -and ($hasReq -or $isEsm) -and ($hasBackend -or $hasWaClient -or $mentionsZelda -or $isEntryJs)) {
          # 1) Prepend early Module._load + EventEmitter + WebContents auto-hook at the top of the file
          $topStart = '// === SERENA_RUNTIME_AUTOHOOK_START ==='
          $topEnd = '// === SERENA_RUNTIME_AUTOHOOK_END ==='
          if ($isEsm) {
            $topHook = @(
              $topStart,
              'import { createRequire as __serenaTopCreateReq } from "module";',
              'import { fileURLToPath as __serenaTopFileUrl } from "url";',
              'try {',
              '  const __req = __serenaTopCreateReq(import.meta.url);',
              '  const __p = __req("path"), __f = __req("fs");',
              '  const __here = __p.dirname(__serenaTopFileUrl(import.meta.url));',
              '  const __cands = [__p.join(__here, "configuracoes"), __p.join(__here, "..", "configuracoes"), __p.join(__here, "..", "..", "configuracoes"), __p.join(process.cwd(), "configuracoes")];',
              '  if (process.resourcesPath) { __cands.push(__p.join(process.resourcesPath, "app", "configuracoes"), __p.join(process.resourcesPath, "configuracoes")); }',
              '  for (const __d of __cands) { const __h = __p.join(__d, "runtimeAutoHook.cjs"); if (__f.existsSync(__h)) { __req(__h); break; } }',
              '} catch (_eAutoHook) {}',
              $topEnd
            ) -join "`r`n"
          } else {
            $topHook = @(
              $topStart,
              'try {',
              '  const __p = require("path"), __f = require("fs");',
              '  const __cands = [__p.join(__dirname, "configuracoes"), __p.join(__dirname, "..", "configuracoes"), __p.join(__dirname, "..", "..", "configuracoes"), __p.join(process.cwd(), "configuracoes")];',
              '  if (process.resourcesPath) { __cands.push(__p.join(process.resourcesPath, "app", "configuracoes"), __p.join(process.resourcesPath, "configuracoes")); }',
              '  for (const __d of __cands) { const __h = __p.join(__d, "runtimeAutoHook.cjs"); if (__f.existsSync(__h)) { require(__h); break; } }',
              '} catch (_eAutoHook) {}',
              $topEnd
            ) -join "`r`n"
          }
          $tIdx1 = $js.IndexOf($topStart, [System.StringComparison]::Ordinal)
          $tIdx2 = $js.IndexOf($topEnd, [System.StringComparison]::Ordinal)
          if ($tIdx1 -ge 0 -and $tIdx2 -gt $tIdx1) {
            $js = $js.Substring(0, $tIdx1) + $topHook + $js.Substring($tIdx2 + $topEnd.Length)
          } elseif ($js.StartsWith('#!')) {
            $nlPos = $js.IndexOf("`n")
            if ($nlPos -ge 0) {
              $js = $js.Substring(0, $nlPos + 1) + $topHook + "`r`n" + $js.Substring($nlPos + 1)
            }
          } else {
            $js = $topHook + "`r`n" + $js
          }

          # 2) Append/update IPC & Express endpoints at bottom of the file (compatible with both CJS and ESM)
          $jsStart = '// === SERENA_CLINIC_CONFIG_BACKEND_START ==='
          $jsEnd = '// === SERENA_CLINIC_CONFIG_BACKEND_END ==='
          $reqInitLine = if ($isEsm) { '  const __bReq = __serenaTopCreateReq(import.meta.url); const __bDir = __bReq("path").dirname(__serenaTopFileUrl(import.meta.url));' } else { '  const __bReq = require; const __bDir = __dirname;' }
          $hookLines = @(
            $jsStart,
            'try {',
            $reqInitLine,
            '  const __pathMod = __bReq("path");',
            '  const __fsMod = __bReq("fs");',
            '  const __cfgCandidates = [__pathMod.join(__bDir, "configuracoes"), __pathMod.join(__bDir, "..", "configuracoes"), __pathMod.join(__bDir, "..", "..", "configuracoes"), __pathMod.join(process.cwd(), "configuracoes")];',
            '  if (process.resourcesPath) { __cfgCandidates.push(__pathMod.join(process.resourcesPath, "app", "configuracoes"), __pathMod.join(process.resourcesPath, "configuracoes")); }',
            '  const __cfgDir = __cfgCandidates.find((d) => __fsMod.existsSync(__pathMod.join(d, "configManager.cjs"))) || __pathMod.join(process.cwd(), "configuracoes");',
            '  const __serenaConfigMgr = __bReq(__pathMod.join(__cfgDir, "configManager.cjs"));',
            '  const __serenaAntiBan = __bReq(__pathMod.join(__cfgDir, "antiBanEngine.cjs"));',
            '  const __serenaZeldaCond = __bReq(__pathMod.join(__cfgDir, "zeldaCondominioEngine.cjs"));',
            '  const __serenaZeldaGuard = __bReq(__pathMod.join(__cfgDir, "zeldaGroupGuard.cjs"));',
            '  const __serenaDashEng = __bReq(__pathMod.join(__cfgDir, "serenaDashboardEngine.cjs"));',
            '  global.getSerenaClinicSettings = __serenaConfigMgr.getClinicSettings;',
            '  global.saveSerenaClinicSettings = __serenaConfigMgr.saveClinicSettings;',
            '  global.serenaAntiBan = __serenaAntiBan;',
            '  global.serenaZeldaCondominio = __serenaZeldaCond;',
            '  global.serenaZeldaGuard = __serenaZeldaGuard;',
            '  global.serenaDashboardEngine = __serenaDashEng;',
            '  try {',
            '    const __wwebLib = __bReq("whatsapp-web.js");',
            '    if (__wwebLib && __wwebLib.Client && __wwebLib.Client.prototype && !__wwebLib.Client.prototype.__serenaProtoHooked) {',
            '      __wwebLib.Client.prototype.__serenaProtoHooked = true;',
            '      const __origWwebInit = __wwebLib.Client.prototype.initialize;',
            '      __wwebLib.Client.prototype.initialize = function (...__iArgs) {',
            '        try {',
            '          __serenaAntiBan.installBulkAntiBanHook(this);',
            '          __serenaZeldaCond.attachConnectionMonitor(this);',
            '          __serenaZeldaGuard.attachZeldaGroupListener(this);',
            '          if (typeof __serenaDashEng.attachLeadTracker === "function") __serenaDashEng.attachLeadTracker(this);',
            '        } catch (_eInit) {}',
            '        return __origWwebInit.apply(this, __iArgs);',
            '      };',
            '    }',
            '  } catch (_noWwebLib) {}',
            '  if (typeof client !== "undefined" && client) {',
            '    __serenaAntiBan.installBulkAntiBanHook(client);',
            '    __serenaZeldaCond.attachConnectionMonitor(client);',
            '    __serenaZeldaGuard.attachZeldaGroupListener(client);',
            '    if (typeof __serenaDashEng.attachLeadTracker === "function") __serenaDashEng.attachLeadTracker(client);',
            '  }',
            '  if (typeof sock !== "undefined" && sock) {',
            '    __serenaAntiBan.installBulkAntiBanHook(sock);',
            '    __serenaZeldaCond.attachConnectionMonitor(sock);',
            '    __serenaZeldaGuard.attachZeldaGroupListener(sock);',
            '    if (typeof __serenaDashEng.attachLeadTracker === "function") __serenaDashEng.attachLeadTracker(sock);',
            '  }',
            '  if (typeof ipcMain !== "undefined" && ipcMain && typeof ipcMain.handle === "function") {',
            '    try { ipcMain.removeHandler("serena:get-clinic-settings"); } catch (_e) {}',
            '    try { ipcMain.removeHandler("serena:save-clinic-settings"); } catch (_e) {}',
            '    try { ipcMain.removeHandler("zelda:get-condominio-state"); } catch (_e) {}',
            '    try { ipcMain.removeHandler("zelda:get-group-diagnostics"); } catch (_e) {}',
            '    try { ipcMain.removeHandler("zelda:save-activities"); } catch (_e) {}',
            '    try { ipcMain.removeHandler("zelda:add-activity"); } catch (_e) {}',
            '    try { ipcMain.removeHandler("zelda:update-activity"); } catch (_e) {}',
            '    try { ipcMain.removeHandler("zelda:delete-activity"); } catch (_e) {}',
            '    try { ipcMain.removeHandler("serena:get-dashboard-metrics"); } catch (_e) {}',
            '    ipcMain.handle("serena:get-clinic-settings", () => __serenaConfigMgr.getClinicSettings());',
            '    ipcMain.handle("serena:save-clinic-settings", (_evt, payload) => __serenaConfigMgr.saveClinicSettings(payload || {}));',
            '    ipcMain.handle("zelda:get-condominio-state", () => ({ connection: __serenaZeldaCond.getWhatsAppConnectionStatus(), activities: __serenaZeldaCond.loadActivities(), settings: __serenaConfigMgr.getClinicSettings(), discoveredGroups: __serenaZeldaCond.getDiscoveredGroups(), debugEvents: __serenaZeldaCond.getZeldaGroupDebugLog() }));',
            '    ipcMain.handle("zelda:get-group-diagnostics", () => ({ discoveredGroups: __serenaZeldaCond.getDiscoveredGroups(), debugEvents: __serenaZeldaCond.getZeldaGroupDebugLog(), settings: __serenaConfigMgr.getClinicSettings() }));',
            '    ipcMain.handle("zelda:save-activities", (_evt, payload) => { const saved = __serenaZeldaCond.saveActivities((payload && payload.activities) || []); if (payload && payload.outboxText) { __serenaZeldaCond.enqueueGroupMessage(payload.outboxText, (__serenaConfigMgr.getClinicSettings().zeldaGroupTarget || "")); } return saved; });',
            '    ipcMain.handle("zelda:add-activity", (_evt, payload) => __serenaZeldaCond.addActivity(payload || {}, (payload && payload.updatedBy) || "Painel mm-sender"));',
            '    ipcMain.handle("zelda:update-activity", (_evt, payload) => __serenaZeldaCond.updateActivity(payload && (payload.id || payload.code), payload || {}, (payload && payload.updatedBy) || "Painel mm-sender"));',
            '    ipcMain.handle("zelda:delete-activity", (_evt, idOrCode) => __serenaZeldaCond.deleteActivity(typeof idOrCode === "object" && idOrCode ? (idOrCode.id || idOrCode.code) : idOrCode));',
            '    ipcMain.handle("serena:get-dashboard-metrics", (_evt, dateStr) => __serenaDashEng.computeDashboardMetrics(dateStr || "all"));',
            '  }',
            '  if (typeof app !== "undefined" && app && typeof app.get === "function" && typeof app.post === "function" && typeof app.use === "function") {',
            '    app.get("/api/clinic-settings", (_req, res) => res.json(__serenaConfigMgr.getClinicSettings()));',
            '    app.post("/api/clinic-settings", (req, res) => res.json(__serenaConfigMgr.saveClinicSettings(req.body || {})));',
            '    app.get("/api/zelda-condominio/state", (_req, res) => res.json({ connection: __serenaZeldaCond.getWhatsAppConnectionStatus(), activities: __serenaZeldaCond.loadActivities(), settings: __serenaConfigMgr.getClinicSettings(), discoveredGroups: __serenaZeldaCond.getDiscoveredGroups(), debugEvents: __serenaZeldaCond.getZeldaGroupDebugLog() }));',
            '    app.get("/api/zelda-condominio/diagnostics", (_req, res) => res.json({ ok: true, discoveredGroups: __serenaZeldaCond.getDiscoveredGroups(), debugEvents: __serenaZeldaCond.getZeldaGroupDebugLog(), settings: __serenaConfigMgr.getClinicSettings() }));',
            '    app.post("/api/zelda-condominio/activities", (req, res) => { if (Array.isArray(req.body && req.body.activities)) { const saved = __serenaZeldaCond.saveActivities(req.body.activities); if (req.body.outboxText) { __serenaZeldaCond.enqueueGroupMessage(req.body.outboxText, (__serenaConfigMgr.getClinicSettings().zeldaGroupTarget || "")); } return res.json({ ok: true, activities: saved }); } const r = __serenaZeldaCond.addActivity(req.body || {}, (req.body && req.body.updatedBy) || "Painel mm-sender"); return res.json({ ok: true, activity: r.created, activities: r.list }); });',
            '    if (typeof app.put === "function") { app.put("/api/zelda-condominio/activities/:id", (req, res) => { const r = __serenaZeldaCond.updateActivity(req.params.id, req.body || {}, (req.body && req.body.updatedBy) || "Painel mm-sender"); if (!r.updated) return res.status(404).json({ ok: false, error: "Iniciativa nao encontrada." }); return res.json({ ok: true, activity: r.updated, activities: r.list }); }); }',
            '    if (typeof app.delete === "function") { app.delete("/api/zelda-condominio/activities/:id", (req, res) => { const r = __serenaZeldaCond.deleteActivity(req.params.id); return res.json({ ok: true, activities: r.list }); }); }',
            '    app.get("/api/serena-dashboard/metrics", (req, res) => res.json(__serenaDashEng.computeDashboardMetrics((req.query && req.query.date) || "all")));',
            '  }',
            '} catch (_serenaHookErr) {}',
            $jsEnd
          ) -join "`r`n"
          $jIdx1 = $js.IndexOf($jsStart, [System.StringComparison]::Ordinal)
          $jIdx2 = $js.IndexOf($jsEnd, [System.StringComparison]::Ordinal)
          if ($jIdx1 -ge 0 -and $jIdx2 -gt $jIdx1) {
            $js = $js.Substring(0, $jIdx1) + $hookLines + $js.Substring($jIdx2 + $jsEnd.Length)
          } else {
            $js = $js + "`r`n" + $hookLines + "`r`n"
          }
          [System.IO.File]::WriteAllText($file.FullName, $js, $utf8NoBom)
          $patchedList.Add($rel)
        }
      } catch {}
    }

    # C) Patch Python Desktop GUI (.py com tkinter / customtkinter)
    if (($ext -eq '.py') -and ($file.Length -lt 500000) -and ($file.Name -ne 'serena_clinic_py.py')) {
      try {
        $py = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        if ($py -match '(?i)zelda') {
          $diagFindings.Add(@{ file = $rel; mentionsZelda = $true; hasGroupFilter = ($py -match '@g\.us') })
        }
        $isGuiPy = ($py -match '\b(customtkinter|tkinter)\b') -and ($py -match '\.mainloop\s*\(')
        if ($isGuiPy -and (-not ($py -match 'SERENA_PY_GUI_HOOK'))) {
          $pyHook = @(
            '# === SERENA_PY_GUI_HOOK_START ===',
            'try:',
            '    import os as _serena_os, sys as _serena_sys',
            '    _serena_cfg_dir = _serena_os.path.join(_serena_os.path.dirname(_serena_os.path.abspath(__file__)), "configuracoes")',
            '    if not _serena_os.path.isdir(_serena_cfg_dir):',
            '        _serena_cfg_dir = _serena_os.path.join(_serena_os.getcwd(), "configuracoes")',
            '    if _serena_cfg_dir not in _serena_sys.path:',
            '        _serena_sys.path.insert(0, _serena_cfg_dir)',
            '    import serena_clinic_py as _serena_clinic_py',
            'except Exception:',
            '    pass',
            '# === SERENA_PY_GUI_HOOK_END ===',
            ''
          ) -join "`r`n"
          $py = $pyHook + $py
          [System.IO.File]::WriteAllText($file.FullName, $py, $utf8NoBom)
          $patchedList.Add($rel)
        }
      } catch {}
    }
  }
  return $patchedList
}

function Find-NodeDir {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    return (Split-Path -Parent $cmd.Source)
  }
  $candidates = @(
    (Join-Path $RootDir 'node\node.exe'),
    (Join-Path $RootDir 'runtime\node.exe'),
    (Join-Path $RootDir 'bin\node.exe')
  )
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
  if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.volta\bin\node.exe') }
  if ($env:APPDATA -and (Test-Path -LiteralPath (Join-Path $env:APPDATA 'nvm'))) {
    $nvmNodes = Get-ChildItem -LiteralPath (Join-Path $env:APPDATA 'nvm') -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue
    foreach ($nn in $nvmNodes) { $candidates += $nn.FullName }
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) {
      return (Split-Path -Parent $c)
    }
  }
  return $null
}

function Restore-OriginalMenuFilesFromBackup {
  try {
    $bkpDirs = Get-ChildItem -LiteralPath $RootDir -Directory -Filter 'backup_antes_serena*' -ErrorAction SilentlyContinue | Sort-Object Name
    if (-not $bkpDirs -or $bkpDirs.Count -eq 0) { return }
    $menuKeywords = @('Agendamentos', 'Disparos', 'Contatos', 'Mensagens', 'Associa', 'Disparar', 'Status')
    foreach ($bd in $bkpDirs) {
      $bkpFiles = Get-ChildItem -LiteralPath $bd.FullName -Recurse -File -ErrorAction SilentlyContinue
      foreach ($bf in $bkpFiles) {
        $ext = $bf.Extension.ToLowerInvariant()
        if ($ext -notin @('.html', '.htm', '.js', '.jsx', '.tsx', '.vue')) { continue }
        $rel = $bf.FullName.Substring($bd.FullName.Length).TrimStart('\', '/')
        $curTarget = Join-Path $RootDir $rel
        if (-not (Test-Path -LiteralPath $curTarget)) { continue }
        $bkpTxt = [System.IO.File]::ReadAllText($bf.FullName, [System.Text.Encoding]::UTF8)
        $curTxt = [System.IO.File]::ReadAllText($curTarget, [System.Text.Encoding]::UTF8)
        $bkpHits = 0; $curHits = 0
        foreach ($kw in $menuKeywords) {
          if ($bkpTxt -match $kw) { $bkpHits++ }
          if ($curTxt -match $kw) { $curHits++ }
        }
        if ($bkpHits -ge 4 -and $curHits -le 1) {
          [System.IO.File]::WriteAllText($curTarget, $bkpTxt, $utf8NoBom)
          Write-Host ('[MENU RESTAURADO] Restaurado menu original de 10 itens a partir do backup em: ' + $rel) -ForegroundColor Cyan
        }
      }
    }
  } catch {}
}

Restore-OriginalMenuFilesFromBackup
$patched = Invoke-PatchAllUiAndBotFiles

# Salva diagnostico local da Zelda e Anti-Ban
try {
  $diagOutPath = Join-Path $RootDir 'configuracoes\diagnostico-zelda.json'
  $diagPayload = @{
    inspectedAt = (Get-Date -Format 'dd/MM/yyyy HH:mm:ss')
    patchedFiles = $patched.ToArray()
    zeldaMatches = $diagFindings.ToArray()
  } | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($diagOutPath, $diagPayload, $utf8NoBom)
} catch {}

$pkgPath = Join-Path $RootDir 'package.json'
if ($RunBuild -and (Test-Path -LiteralPath $pkgPath)) {
  $nodeDir = Find-NodeDir
  if ($nodeDir) {
    $npmCmd = Join-Path $nodeDir 'npm.cmd'
    if (Test-Path -LiteralPath $npmCmd) {
      try {
        $pkgJson = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $buildScript = ''
        if ($pkgJson.scripts -and $pkgJson.scripts.build) { $buildScript = [string]$pkgJson.scripts.build }
        if ($buildScript -match '(?i)(vite|tsc|react-scripts|webpack|parcel|rollup|esbuild|vue-cli|svelte)' -and ($buildScript -notmatch '(?i)(electron-builder|electron-packager|innosetup)')) {
          Write-Host '[BUILD] Node local detectado. Recompilando frontend (dist/)...' -ForegroundColor Cyan
          $env:PATH = $nodeDir + ';' + $env:PATH
          Push-Location -LiteralPath $RootDir
          & $npmCmd run build
          Pop-Location
          $patchedAfter = Invoke-PatchAllUiAndBotFiles
          foreach ($item in $patchedAfter) {
            if (-not $patched.Contains($item)) { $patched.Add($item) }
          }
        }
      } catch {}
    }
  }
}

Write-Host '[CONFIG SEPARADA] Config Geral e Config Zelda em telas separadas; status da Zelda ocultado da tela da Serena.' -ForegroundColor Green
Write-Host '[DASHBOARD SERENA] Contadores diarios America/Sao_Paulo + Todos os dias (Total Geral) sem piscar.' -ForegroundColor Green
Write-Host '[ANTI-BAN] Escudo Disparo em Massa ativo (Delay 3-7s, Digitando 2-5s, Spintax, <=450 chars, <=30/h, [BLACKLIST]).' -ForegroundColor Green
Write-Host '[SERENA NAO LIDA] Conversas lidas pela Serena mantidas como Nao Lidas no WhatsApp (sendSeen:false + markUnread).' -ForegroundColor Green
if ($patched.Count -gt 0) {
  Write-Host ('[ARQUIVOS CONECTADOS] ' + ($patched -join ', ')) -ForegroundColor Green
}
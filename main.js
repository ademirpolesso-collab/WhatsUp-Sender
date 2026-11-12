// === SERENA_RUNTIME_AUTOHOOK_START ===
try {
  const __p = require("path"), __f = require("fs");
  const __cands = [__p.join(__dirname, "configuracoes"), __p.join(__dirname, "..", "configuracoes"), __p.join(__dirname, "..", "..", "configuracoes"), __p.join(process.cwd(), "configuracoes")];
  if (process.resourcesPath) { __cands.push(__p.join(process.resourcesPath, "app", "configuracoes"), __p.join(process.resourcesPath, "configuracoes")); }
  for (const __d of __cands) { const __h = __p.join(__d, "runtimeAutoHook.cjs"); if (__f.existsSync(__h)) { require(__h); break; } }
} catch (_eAutoHook) {}
// === SERENA_RUNTIME_AUTOHOOK_END ===
/**
 * main.js — processo principal do Electron
 * Configurado com suporte a System Tray (bandeja) e sessão persistente 24/7
 */
const electron = require('electron');
const { app, BrowserWindow, Tray, Menu, ipcMain } = electron;
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let mainWindow;
let tray = null;
let isQuitting = false;

// Se for processo secundário do Node/Electron sem app, encerra
if (!app) {
  process.exit(0);
}

// ── Função Unificada de Reset (Zera leads, conversas, agenda e estatísticas) ──
async function executeFullSerenaReset() {
  let result = { success: true };

  // 1. Zera o serena-db.json via serenaEngine.mjs (preservando configurações da clínica)
  try {
    const engineUrl = pathToFileURL(path.join(__dirname, 'serenaEngine.mjs')).href;
    const serenaEngine = await import(engineUrl);
    if (typeof serenaEngine.resetDatabase === 'function') {
      result = await serenaEngine.resetDatabase();
    }
  } catch (e) {
    console.error('⚠️ [SERENA] Aviso ao resetar serenaEngine.mjs:', e.message);
  }

  // 2. Zera o histórico no banco SQLite (src/db)
  try {
    const db = require('./src/db');
    if (db && typeof db.resetSerenaConversations === 'function') {
      db.resetSerenaConversations();
    }
  } catch (_) {}

  // 3. Zera as métricas do Dashboard em memória e em disco
  try {
    if (global.serenaDashboardEngine && typeof global.serenaDashboardEngine.resetMetrics === 'function') {
      global.serenaDashboardEngine.resetMetrics();
    }
    const cfgCandidates = [
      path.join(__dirname, 'configuracoes'),
      path.join(process.cwd(), 'configuracoes'),
      process.resourcesPath ? path.join(process.resourcesPath, 'app', 'configuracoes') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'configuracoes') : '',
    ].filter(Boolean);

    for (const dir of cfgCandidates) {
      for (const mf of ['serena-dashboard-metrics.json', 'serena-leads-tracker.json']) {
        const fullMf = path.join(dir, mf);
        if (fs.existsSync(fullMf)) fs.unlinkSync(fullMf);
      }
    }
  } catch (_) {}

  console.log('⚠️ [SERENA] Banco de dados, conversas e estatísticas zerados com sucesso.');
  return { success: true, ...(result && typeof result === 'object' ? result : {}) };
}

function registerSafeResetHandlers() {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return;
  const resetChannels = [
    'serena:resetDatabase',
    'serena:reset-all',
    'serena:reset-db',
    'serena:reset',
    'serena:clear-stats',
  ];
  for (const ch of resetChannels) {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, async () => executeFullSerenaReset());
  }
}

// ── Worker de Follow-up em Segundo Plano (Resgate de Leads) ───────────────
function startSerenaFollowupWorker() {
  const CHECK_INTERVAL_MS = 5 * 60 * 1000; // Varredura a cada 5 minutos

  console.log('⏱️ Worker de Follow-up da Serena iniciado (varredura a cada 5 min)...');

  setInterval(async () => {
    try {
      const engineUrl = pathToFileURL(path.join(__dirname, 'serenaEngine.mjs')).href;
      const serenaEngine = await import(engineUrl);
      const wa = require('./src/whatsapp');

      const { hour } = serenaEngine.getBrasiliaParts();
      
      // Trava de Horário Comercial: envia apenas entre 08h e 20h (BRT)
      if (hour >= 8 && hour < 20) {
        await serenaEngine.checkAndSendFollowups(async (jid, text) => {
          if (wa && typeof wa.sendMessage === 'function') {
            await wa.sendMessage(jid, text);
          } else if (wa && wa.client && typeof wa.client.sendMessage === 'function') {
            const formattedJid = jid.includes('@') ? jid : `${jid}@c.us`;
            await wa.client.sendMessage(formattedJid, text);
          }
        });
      }
    } catch (err) {
      console.error('Erro na varredura de follow-up em segundo plano:', err);
    }
  }, CHECK_INTERVAL_MS);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    title: 'OdontoCompany Bela Vista — WhatsApp Sender & Serena Bot',
    icon: path.join(__dirname, 'ui/assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('focus', () => mainWindow.webContents.focus());

  // Fechar a janela apenas esconde para manter a Serena rodando 24x7 na bandeja
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  const { register } = require('./src/ipcHandlers');
  register(mainWindow);

  // Garante que os handlers unificados de reset prevaleçam após register()
  registerSafeResetHandlers();
}

function createTray() {
  const iconPath = path.join(__dirname, 'ui/assets/icon.ico');
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir Painel Serena / WhatsApp Sender',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Sair Completamente',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('OdontoCompany Bela Vista Osasco - Serena Ativa 24/7');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  registerSafeResetHandlers();
  createWindow();
  createTray();

  const wa = require('./src/whatsapp');
  wa.init();

  // Inicializa a varredura automática de follow-up
  startSerenaFollowupWorker();
});

app.on('before-quit', (e) => {
  if (isQuitting) return;
  isQuitting = true;
  e.preventDefault();
  const wa = require('./src/whatsapp');
  wa.disconnect().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    app.dock.hide();
  }
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// === SERENA_CLINIC_CONFIG_BACKEND_START ===
try {
  const __bReq = require; const __bDir = __dirname;
  const __pathMod = __bReq("path");
  const __fsMod = __bReq("fs");
  const __cfgCandidates = [__pathMod.join(__bDir, "configuracoes"), __pathMod.join(__bDir, "..", "configuracoes"), __pathMod.join(__bDir, "..", "..", "configuracoes"), __pathMod.join(process.cwd(), "configuracoes")];
  if (process.resourcesPath) { __cfgCandidates.push(__pathMod.join(process.resourcesPath, "app", "configuracoes"), __pathMod.join(process.resourcesPath, "configuracoes")); }
  const __cfgDir = __cfgCandidates.find((d) => __fsMod.existsSync(__pathMod.join(d, "configManager.cjs"))) || __pathMod.join(process.cwd(), "configuracoes");
  const __serenaConfigMgr = __bReq(__pathMod.join(__cfgDir, "configManager.cjs"));
  const __serenaAntiBan = __bReq(__pathMod.join(__cfgDir, "antiBanEngine.cjs"));
  const __serenaZeldaCond = __bReq(__pathMod.join(__cfgDir, "zeldaCondominioEngine.cjs"));
  const __serenaZeldaGuard = __bReq(__pathMod.join(__cfgDir, "zeldaGroupGuard.cjs"));
  const __serenaDashEng = __bReq(__pathMod.join(__cfgDir, "serenaDashboardEngine.cjs"));
  global.getSerenaClinicSettings = __serenaConfigMgr.getClinicSettings;
  global.saveSerenaClinicSettings = __serenaConfigMgr.saveClinicSettings;
  global.serenaAntiBan = __serenaAntiBan;
  global.serenaZeldaCondominio = __serenaZeldaCond;
  global.serenaZeldaGuard = __serenaZeldaGuard;
  global.serenaDashboardEngine = __serenaDashEng;

  try {
    const __wwebLib = __bReq("whatsapp-web.js");
    if (__wwebLib && __wwebLib.Client && __wwebLib.Client.prototype && !__wwebLib.Client.prototype.__serenaProtoHooked) {
      __wwebLib.Client.prototype.__serenaProtoHooked = true;
      const __origWwebInit = __wwebLib.Client.prototype.initialize;
      __wwebLib.Client.prototype.initialize = function (...__iArgs) {
        try {
          __serenaAntiBan.installBulkAntiBanHook(this);
          __serenaZeldaCond.attachConnectionMonitor(this);
          __serenaZeldaGuard.attachZeldaGroupListener(this);
          if (typeof __serenaDashEng.attachLeadTracker === "function") __serenaDashEng.attachLeadTracker(this);
        } catch (_eInit) {}
        return __origWwebInit.apply(this, __iArgs);
      };
    }
  } catch (_noWwebLib) {}
  if (typeof client !== "undefined" && client) {
    __serenaAntiBan.installBulkAntiBanHook(client);
    __serenaZeldaCond.attachConnectionMonitor(client);
    __serenaZeldaGuard.attachZeldaGroupListener(client);
    if (typeof __serenaDashEng.attachLeadTracker === "function") __serenaDashEng.attachLeadTracker(client);
  }
  if (typeof sock !== "undefined" && sock) {
    __serenaAntiBan.installBulkAntiBanHook(sock);
    __serenaZeldaCond.attachConnectionMonitor(sock);
    __serenaZeldaGuard.attachZeldaGroupListener(sock);
    if (typeof __serenaDashEng.attachLeadTracker === "function") __serenaDashEng.attachLeadTracker(sock);
  }
  if (typeof ipcMain !== "undefined" && ipcMain && typeof ipcMain.handle === "function") {
    try { ipcMain.removeHandler("serena:get-clinic-settings"); } catch (_e) {}
    try { ipcMain.removeHandler("serena:save-clinic-settings"); } catch (_e) {}
    try { ipcMain.removeHandler("zelda:get-condominio-state"); } catch (_e) {}
    try { ipcMain.removeHandler("zelda:get-group-diagnostics"); } catch (_e) {}
    try { ipcMain.removeHandler("zelda:save-activities"); } catch (_e) {}
    try { ipcMain.removeHandler("zelda:add-activity"); } catch (_e) {}
    try { ipcMain.removeHandler("zelda:update-activity"); } catch (_e) {}
    try { ipcMain.removeHandler("zelda:delete-activity"); } catch (_e) {}
    try { ipcMain.removeHandler("serena:get-dashboard-metrics"); } catch (_e) {}

    ipcMain.handle("serena:get-clinic-settings", () => __serenaConfigMgr.getClinicSettings());
    ipcMain.handle("serena:save-clinic-settings", (_evt, payload) => __serenaConfigMgr.saveClinicSettings(payload || {}));
    ipcMain.handle("zelda:get-condominio-state", () => ({ connection: __serenaZeldaCond.getWhatsAppConnectionStatus(), activities: __serenaZeldaCond.loadActivities(), settings: __serenaConfigMgr.getClinicSettings(), discoveredGroups: __serenaZeldaCond.getDiscoveredGroups(), debugEvents: __serenaZeldaCond.getZeldaGroupDebugLog() }));
    ipcMain.handle("zelda:get-group-diagnostics", () => ({ discoveredGroups: __serenaZeldaCond.getDiscoveredGroups(), debugEvents: __serenaZeldaCond.getZeldaGroupDebugLog(), settings: __serenaConfigMgr.getClinicSettings() }));
    ipcMain.handle("zelda:save-activities", (_evt, payload) => { const saved = __serenaZeldaCond.saveActivities((payload && payload.activities) || []); if (payload && payload.outboxText) { __serenaZeldaCond.enqueueGroupMessage(payload.outboxText, (__serenaConfigMgr.getClinicSettings().zeldaGroupTarget || "")); } return saved; });
    ipcMain.handle("zelda:add-activity", (_evt, payload) => __serenaZeldaCond.addActivity(payload || {}, (payload && payload.updatedBy) || "Painel mm-sender"));
    ipcMain.handle("zelda:update-activity", (_evt, payload) => __serenaZeldaCond.updateActivity(payload && (payload.id || payload.code), payload || {}, (payload && payload.updatedBy) || "Painel mm-sender"));
    ipcMain.handle("zelda:delete-activity", (_evt, idOrCode) => __serenaZeldaCond.deleteActivity(typeof idOrCode === "object" && idOrCode ? (idOrCode.id || idOrCode.code) : idOrCode));
    ipcMain.handle("serena:get-dashboard-metrics", (_evt, dateStr) => __serenaDashEng.computeDashboardMetrics(dateStr || "all"));
    
    registerSafeResetHandlers();
  }
  if (typeof app !== "undefined" && app && typeof app.get === "function" && typeof app.post === "function" && typeof app.use === "function") {
    app.get("/api/clinic-settings", (_req, res) => res.json(__serenaConfigMgr.getClinicSettings()));
    app.post("/api/clinic-settings", (req, res) => res.json(__serenaConfigMgr.saveClinicSettings(req.body || {})));
    app.get("/api/zelda-condominio/state", (_req, res) => res.json({ connection: __serenaZeldaCond.getWhatsAppConnectionStatus(), activities: __serenaZeldaCond.loadActivities(), settings: __serenaConfigMgr.getClinicSettings(), discoveredGroups: __serenaZeldaCond.getDiscoveredGroups(), debugEvents: __serenaZeldaCond.getZeldaGroupDebugLog() }));
    app.get("/api/zelda-condominio/diagnostics", (_req, res) => res.json({ ok: true, discoveredGroups: __serenaZeldaCond.getDiscoveredGroups(), debugEvents: __serenaZeldaCond.getZeldaGroupDebugLog(), settings: __serenaConfigMgr.getClinicSettings() }));
    app.post("/api/zelda-condominio/activities", (req, res) => { if (Array.isArray(req.body && req.body.activities)) { const saved = __serenaZeldaCond.saveActivities(req.body.activities); if (req.body.outboxText) { __serenaZeldaCond.enqueueGroupMessage(req.body.outboxText, (__serenaConfigMgr.getClinicSettings().zeldaGroupTarget || "")); } return res.json({ ok: true, activities: saved }); } const r = __serenaZeldaCond.addActivity(req.body || {}, (req.body && req.body.updatedBy) || "Painel mm-sender"); return res.json({ ok: true, activity: r.created, activities: r.list }); });
    if (typeof app.put === "function") { app.put("/api/zelda-condominio/activities/:id", (req, res) => { const r = __serenaZeldaCond.updateActivity(req.params.id, req.body || {}, (req.body && req.body.updatedBy) || "Painel mm-sender"); if (!r.updated) return res.status(404).json({ ok: false, error: "Iniciativa nao encontrada." }); return res.json({ ok: true, activity: r.updated, activities: r.list }); }); }
    if (typeof app.delete === "function") { app.delete("/api/zelda-condominio/activities/:id", (req, res) => { const r = __serenaZeldaCond.deleteActivity(req.params.id); return res.json({ ok: true, activities: r.list }); }); }
    app.get("/api/serena-dashboard/metrics", (req, res) => res.json(__serenaDashEng.computeDashboardMetrics((req.query && req.query.date) || "all")));
    
    // Rota HTTP REST unificada
    app.post("/api/reset-database", async (_req, res) => {
      try {
        const result = await executeFullSerenaReset();
        return res.json(result);
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
    });
  }
} catch (_serenaHookErr) {}
// === SERENA_CLINIC_CONFIG_BACKEND_END ===
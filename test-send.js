// === SERENA_RUNTIME_AUTOHOOK_START ===
try {
  const __p = require("path"), __f = require("fs");
  const __cands = [__p.join(__dirname, "configuracoes"), __p.join(__dirname, "..", "configuracoes"), __p.join(__dirname, "..", "..", "configuracoes"), __p.join(process.cwd(), "configuracoes")];
  if (process.resourcesPath) { __cands.push(__p.join(process.resourcesPath, "app", "configuracoes"), __p.join(process.resourcesPath, "configuracoes")); }
  for (const __d of __cands) { const __h = __p.join(__d, "runtimeAutoHook.cjs"); if (__f.existsSync(__h)) { require(__h); break; } }
} catch (_eAutoHook) {}
// === SERENA_RUNTIME_AUTOHOOK_END ===
const { Client, LocalAuth } = require('./node_modules/whatsapp-web.js');
const path = require('path');
const os   = require('os');

const authDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'whatsapp-sender', '.wwebjs_auth');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: authDataPath }),
  puppeteer: {
    headless: true,
    protocolTimeout: 120000,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  },
  webVersion: '2.3000.1049703040-alpha',
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html'
  }
});

client.on('qr', () => { console.log('[TEST] Sem sessão.'); process.exit(1); });
client.on('authenticated', () => console.log('[TEST] Autenticado'));

client.on('ready', async () => {
  console.log('[TEST] Pronto. wid:', client.info?.wid?._serialized);

  // Testa diagnóstico COMPLETO de um contato específico antes de enviar
  // Use o número de Micheline (ou qualquer contato que falhou)
  // Vou usar o primeiro contato LID listado para diagnosticar
  const testContacts = [
    { name: 'Micheline (número estimado)', phone: '5511996202504' }, // substitua pelo número real
  ];

  // Primeiro lista os contatos LID para pegar o número real de Micheline
  console.log('\n[TEST] Listando contatos com LID...');
  try {
    const lidContacts = await client.pupPage.evaluate(async () => {
      const contacts = window.require('WAWebCollections').Contact.getModelsArray();
      const result = [];
      for (const c of contacts) {
        if (c.id.isLid && c.id.isLid()) {
          result.push({
            lid: c.id._serialized,
            name: c.pushname || c.verifiedName || c.name || '',
            phone: c.phoneNumber || ''
          });
          if (result.length >= 20) break;
        }
      }
      return result;
    });
    console.log('[TEST] Contatos LID (primeiros 20):');
    lidContacts.forEach(c => console.log(`  LID:${c.lid} | phone:${c.phone} | name:${c.name}`));
  } catch(e) {
    console.error('[TEST] Erro ao listar LID contacts:', e.message);
  }

  // Testa o envio capturando o erro completo com pupPage console
  await client.pupPage.evaluate(() => {
    window.__testErrors = [];
    const origError = console.error.bind(console);
    console.error = (...args) => { window.__testErrors.push(args.join(' ')); origError(...args); };
  });

  // Captura erros não tratados do browser
  client.pupPage.on('pageerror', err => {
    console.error('[BROWSER ERROR]', err.message);
  });
  client.pupPage.on('console', msg => {
    if (msg.type() === 'error') console.error('[BROWSER CONSOLE ERROR]', msg.text());
  });

  // Tenta envio para o próprio número (sempre funciona como referência)
  console.log('\n[TEST] --- TESTE 1: próprio número ---');
  try {
    const msg = await client.sendMessage('5511996202504@c.us', '[Teste Bob] próprio numero - pode ignorar');
    console.log('[TEST] SUCESSO proprio:', msg?.id?._serialized || msg);
  } catch(e) {
    console.error('[TEST] ERRO proprio:', e.message);
    console.error('[TEST] STACK:', e.stack);
  }
  await new Promise(r => setTimeout(r, 3000));

  // Tenta envio para o número de Micheline (que estava falhando)
  // SUBSTITUA pelo número real abaixo:
  const michelinePhone = process.env.TEST_PHONE || '';
  if (michelinePhone) {
    console.log('\n[TEST] --- TESTE 2: Micheline', michelinePhone, '---');
    try {
      // Diagnóstico antes do envio
      const diag = await client.pupPage.evaluate(async (phone) => {
        try {
          const chatId = phone + '@c.us';
          const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
          const { getMaybeMeLidUser, getMaybeMePnUser } = window.require('WAWebUserPrefsMeUser');
          return {
            found: !!chat,
            chatId: chat ? (chat.id._serialized || chat.id.$1) : null,
            isLid: chat?.id?.isLid?.() ?? null,
            lidUser: getMaybeMeLidUser()?._serialized ?? null,
            meUser: getMaybeMePnUser()?._serialized ?? null,
          };
        } catch(e) { return { error: e.message }; }
      }, michelinePhone);
      console.log('[TEST] Diagnóstico Micheline:', JSON.stringify(diag));

      const msg2 = await client.sendMessage(michelinePhone + '@c.us', '[Teste Bob] teste Micheline - pode ignorar');
      console.log('[TEST] SUCESSO Micheline:', msg2?.id?._serialized || msg2);
    } catch(e) {
      console.error('[TEST] ERRO Micheline:', e.message);
      console.error('[TEST] STACK:', e.stack?.substring(0, 500));
    }
  } else {
    console.log('[TEST] Defina TEST_PHONE=<numero> para testar envio para Micheline');
  }

  // Coleta erros do browser
  const browserErrors = await client.pupPage.evaluate(() => window.__testErrors || []);
  if (browserErrors.length > 0) {
    console.log('\n[TEST] Erros do browser capturados:', browserErrors);
  }

  await client.destroy();
  process.exit(0);
});

client.on('auth_failure', msg => { console.error('[TEST] Auth failure:', msg); process.exit(1); });
client.initialize().catch(err => { console.error('[TEST] Init error:', err.message); process.exit(1); });
setTimeout(() => { console.error('[TEST] Timeout'); process.exit(1); }, 180000);

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
  }
} catch (_serenaHookErr) {}
// === SERENA_CLINIC_CONFIG_BACKEND_END ===

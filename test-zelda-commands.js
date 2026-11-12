// === SERENA_RUNTIME_AUTOHOOK_START ===
try {
  const __p = require("path"), __f = require("fs");
  const __cands = [__p.join(__dirname, "configuracoes"), __p.join(__dirname, "..", "configuracoes"), __p.join(__dirname, "..", "..", "configuracoes"), __p.join(process.cwd(), "configuracoes")];
  if (process.resourcesPath) { __cands.push(__p.join(process.resourcesPath, "app", "configuracoes"), __p.join(process.resourcesPath, "configuracoes")); }
  for (const __d of __cands) { const __h = __p.join(__d, "runtimeAutoHook.cjs"); if (__f.existsSync(__h)) { require(__h); break; } }
} catch (_eAutoHook) {}
// === SERENA_RUNTIME_AUTOHOOK_END ===
/**
 * test-zelda-commands.js
 * Suíte de testes abrangente para os comandos do bot Zelda (Condomínio)
 */
const db = require('./src/db');
const zeldaCore = require('./src/zeldaCore');

let passed = 0;
let failed = 0;

function assert(cond, name, details = '') {
  if (cond) {
    console.log(`✅ [PASS] ${name}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${name} ${details ? '— ' + details : ''}`);
    failed++;
  }
}

async function run() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  🧪 Testes de Comandos da Zelda — Gestão de Condomínio');
  console.log('════════════════════════════════════════════════════════════════\n');

  // Garante configurações padrão
  db.setConfig('zelda_enabled', '1');
  db.setConfig('zelda_group_name', 'Teste Conselho');
  db.setConfig('zelda_sindico_phone', '11986624666');
  db.setConfig('zelda_min_approvals', '3');

  const groupId = '120363000000000000@g.us';
  const sindicoPhone = '11986624666';
  const user1Phone = '11999990001';
  const user2Phone = '11999990002';
  const user3Phone = '11999990003';
  const user4Phone = '11999990004';

  let lastSentMessages = [];
  const fakeSender = async (msg) => {
    lastSentMessages.push(msg);
  };

  const sendMsg = async (senderPhone, senderName, text) => {
    lastSentMessages = [];
    await zeldaCore.processGroupMessage(groupId, senderPhone, senderName, text, fakeSender);
    return lastSentMessages;
  };

  // 1. Ajuda
  let out = await sendMsg(user1Phone, 'Carlos', 'Zelda, ?');
  assert(out.length > 0 && out[0].includes('Comandos disponíveis'), 'Comando Zelda, ? exibe ajuda');

  out = await sendMsg(user1Phone, 'Carlos', 'Zelda ajuda');
  assert(out.length > 0 && out[0].includes('Comandos disponíveis'), 'Comando Zelda ajuda (sem vírgula) exibe ajuda');

  out = await sendMsg(user1Phone, 'Carlos', 'Zelda: help');
  assert(out.length > 0 && out[0].includes('Comandos disponíveis'), 'Comando Zelda: help exibe ajuda');

  // 2. Fluxo multi-passo: Criar Nova Atividade
  out = await sendMsg(user1Phone, 'Carlos', 'Zelda, incluir atividade');
  assert(out.length > 0 && out[0].includes('Informe o nome da atividade'), 'Início do fluxo de nova atividade');

  out = await sendMsg(user1Phone, 'Carlos', 'Reforma da portaria');
  assert(out.length > 0 && out[0].includes('Responsável pela atividade'), 'Passo 2: Pergunta responsável');

  out = await sendMsg(user1Phone, 'Carlos', 'Carlos Morador');
  assert(out.length > 0 && out[0].includes('Data prevista'), 'Passo 3: Pergunta data prevista');

  out = await sendMsg(user1Phone, 'Carlos', '30/05/2025');
  assert(out.length > 0 && out[0].includes('Atividade criada com sucesso') && out[0].includes('Reforma da portaria'), 'Passo 4: Atividade cadastrada com sucesso');

  const activeList = db.zeldaListActive();
  const created = activeList.find(i => i.title === 'Reforma da portaria' && i.status === 'em_cotacao');
  assert(!!created, 'Atividade persistida no SQLite com sucesso');
  const seq = created ? created.seq : 1;

  // 3. Listar atividades
  out = await sendMsg(user1Phone, 'Carlos', 'Zelda, listar');
  assert(out.length > 0 && out[0].includes('Reforma da portaria'), 'Comando Zelda, listar exibe a atividade');

  // 4. Detalhes da atividade
  out = await sendMsg(user1Phone, 'Carlos', `Zelda, detalhe ${seq}`);
  assert(out.length > 0 && out[0].includes('Reforma da portaria') && out[0].includes('Carlos Morador'), 'Comando Zelda, detalhe NNN');

  // 5. Adicionar orçamento (Multi-passo)
  out = await sendMsg(user1Phone, 'Carlos', `Zelda, adicionar orçamento ${seq}`);
  assert(out.length > 0 && out[0].includes('Informe o nome do fornecedor'), 'Início do fluxo de adicionar orçamento');

  out = await sendMsg(user1Phone, 'Carlos', 'Alfa Engenharia');
  assert(out.length > 0 && out[0].includes('Valor do orçamento'), 'Passo 2 do orçamento: valor');

  out = await sendMsg(user1Phone, 'Carlos', 'R$ 2.500,00');
  assert(out.length > 0 && out[0].includes('Orçamento 1 adicionado'), 'Passo 3: Orçamento adicionado');

  // Segundo orçamento
  await sendMsg(user1Phone, 'Carlos', `Zelda, adicionar orçamento ${seq}`);
  await sendMsg(user1Phone, 'Carlos', 'Beta Reformas');
  out = await sendMsg(user1Phone, 'Carlos', '2800');
  assert(out.length > 0 && out[0].includes('Orçamento 2 adicionado'), 'Segundo orçamento adicionado');

  // 6. Mudar status para 'cotado' e depois para 'em aprovação'
  out = await sendMsg(user1Phone, 'Carlos', `Zelda, mudar status ${seq} para cotado`);
  assert(out.length > 0 && out[0].includes('atualizado para *🟡 Cotado*'), 'Mudar status para cotado');

  out = await sendMsg(user1Phone, 'Carlos', `Zelda, mudar status ${seq} para em aprovação`);
  assert(out.length > 0 && out.some(m => m.includes('aguarda aprovação do conselho')), 'Mudar status para em aprovação dispara notificação');

  // 7. Votação de Aprovação (com múltiplos orçamentos)
  // Conselheiro 1 aprova especificando orçamento
  out = await sendMsg(user1Phone, 'Carlos', `Zelda, aprovar ${seq} orcamento 1`);
  assert(out.length > 0 && out.some(m => m.includes('Carlos') && m.includes('aprovou') && m.includes('1/3')), 'Voto 1 computado', JSON.stringify(out));

  // Voto duplicado do mesmo conselheiro
  out = await sendMsg(user1Phone, 'Carlos', `Zelda, aprovar ${seq} orcamento 1`);
  assert(out.length > 0 && out[0].includes('já registrou seu voto'), 'Bloqueio de voto duplicado');

  // Voto de rejeição do Conselheiro 2
  out = await sendMsg(user2Phone, 'Mariana', `Zelda, rejeitar ${seq}`);
  assert(out.length > 0 && out.some(m => m.includes('Mariana') && m.includes('rejeitou') && m.includes('1/3')), 'Voto de rejeição computado', JSON.stringify(out));

  // Conselheiro 3 aprova
  out = await sendMsg(user3Phone, 'Roberto', `Zelda, aprovar ${seq} orcamento 1`);
  assert(out.length > 0 && out.some(m => m.includes('Roberto') && m.includes('aprovou') && m.includes('2/3')), 'Voto 2 de aprovação computado', JSON.stringify(out));

  // Conselheiro 4 aprova atingindo o quórum de 3 aprovações
  out = await sendMsg(user4Phone, 'Fernando', `Zelda, aprovar ${seq} orcamento 1`);
  assert(out.length > 0 && out.some(m => m.includes('APROVADA') && m.includes('Alfa Engenharia')), 'Atividade APROVADA automaticamente ao atingir quórum');

  // 8. Avançar para em execução
  out = await sendMsg(user1Phone, 'Carlos', `Zelda, mudar status ${seq} para em execução`);
  assert(out.length > 0 && out[0].includes('atualizado para *🔨 Em Execução*'), 'Mover de aprovado para em execução');

  // 9. Concluir / Encerrar
  out = await sendMsg(user1Phone, 'Carlos', `Zelda, mudar status ${seq} para encerrado`);
  assert(out.length > 0 && out[0].includes('atualizado para *🏁 Encerrado*'), 'Mover para encerrado');

  // 10. Arquivar tudo (Síndico)
  out = await sendMsg(user1Phone, 'Carlos', 'Zelda, arquivar tudo');
  assert(out.length > 0 && out[0].includes('Apenas o síndico'), 'Conselheiro comum não pode arquivar');

  out = await sendMsg(sindicoPhone, 'Síndico T7', 'Zelda, arquivar tudo');
  assert(out.length > 0 && out[0].includes('arquivadas com sucesso'), 'Síndico arquiva atividades com sucesso');

  out = await sendMsg(user1Phone, 'Carlos', 'Zelda, historico');
  assert(out.length > 0 && out[0].includes('Histórico de atividades') && out[0].includes('Reforma da portaria'), 'Atividade consta no histórico');

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(`  Resultado Zelda: ${passed} passaram  |  ${failed} falharam`);
  console.log('════════════════════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Erro fatal nos testes da Zelda:', err);
  process.exit(1);
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

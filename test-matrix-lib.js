/**
 * test-matrix-lib.js — Sandbox isolado para testar o serenaEngine.cjs (motor em produção).
 *
 * Garantias:
 *  - Copia serenaEngine.cjs + configuracoes/*.cjs para uma pasta temporária e aponta APPDATA para lá:
 *    nenhum dado real (dados/, blacklist, agenda, eventos) é tocado.
 *  - Bloqueia e CONTA qualquer tentativa de rede (http/https/net/tls/dns/fetch/WebSocket)
 *    e de processos filhos => prova da premissa de CUSTO ZERO de execução.
 *  - Impede o runtimeAutoHook de subir servidor HTTP local ou hookar módulos.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const SRC_ROOT = __dirname;

// ── Guarda de custo zero ──────────────────────────────────────────────────────
const guard = { network: [], spawn: [] };
function installGuards() {
  const deny = (kind, name) => (...a) => {
    guard[kind].push(`${name}(${String(a[0] && a[0].host || a[0] && a[0].hostname || a[0] || '').slice(0, 80)})`);
    throw new Error(`[GUARDA CUSTO-ZERO] ${name} bloqueado`);
  };
  for (const m of ['http', 'https']) {
    const mod = require(m);
    mod.request = deny('network', `${m}.request`);
    mod.get = deny('network', `${m}.get`);
    mod.createServer = deny('network', `${m}.createServer`);
  }
  const net = require('net');
  net.connect = net.createConnection = deny('network', 'net.connect');
  net.Socket.prototype.connect = deny('network', 'net.Socket.connect');
  net.Server.prototype.listen = deny('network', 'net.Server.listen');
  require('tls').connect = deny('network', 'tls.connect');
  const dns = require('dns');
  for (const f of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[f] = deny('network', `dns.${f}`);
  if (global.fetch) global.fetch = deny('network', 'fetch');
  if (global.WebSocket) global.WebSocket = deny('network', 'WebSocket');
  const cp = require('child_process');
  for (const f of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) {
    cp[f] = deny('spawn', `child_process.${f}`);
  }
}

// ── Sandbox ───────────────────────────────────────────────────────────────────
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (filter && !filter(e)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

function buildSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serena-matrix-'));
  fs.copyFileSync(path.join(SRC_ROOT, 'serenaEngine.cjs'), path.join(root, 'serenaEngine.cjs'));
  copyDir(path.join(SRC_ROOT, 'configuracoes'), path.join(root, 'configuracoes'),
    e => e.isDirectory() || /\.cjs$/.test(e.name));
  // Configuração limpa e determinística (recepção configurada para testar notificações)
  fs.writeFileSync(path.join(root, 'configuracoes', 'clinic-settings.json'), JSON.stringify({
    ...JSON.parse(fs.readFileSync(path.join(SRC_ROOT, 'clinic-settings.json'), 'utf8')),
    receptionWhatsapp: '5511900000000',
    // zera delays humanizados (só afetam envio real, não o handleIncoming)
    reactionDelayMinMs: 1, reactionDelayMaxMs: 2, typingStateMinMs: 1, typingStateMaxMs: 2,
    updatedAtEpochMs: Date.now() + 1e9,
  }, null, 2));
  const appdata = path.join(root, 'appdata');
  fs.mkdirSync(appdata, { recursive: true });
  process.env.APPDATA = appdata;
  process.env.LOCALAPPDATA = appdata;
  process.chdir(root);
  return root;
}

function loadEngine(root) {
  // impede runtimeAutoHook de hookar Module._load / subir servidor local
  global.__serenaRuntimeAutoHookInstalled = true;
  global.__serenaEmbeddedSyncServerStarted = true;
  const eng = require(path.join(root, 'serenaEngine.cjs'));
  const dash = require(path.join(root, 'configuracoes', 'serenaDashboardEngine.cjs'));
  const anti = require(path.join(root, 'configuracoes', 'antiBanEngine.cjs'));
  return { eng, dash, anti };
}

// ── Helpers de conversa ───────────────────────────────────────────────────────
function makeHarness() {
  installGuards();
  const root = buildSandbox();
  const { eng, dash, anti } = loadEngine(root);
  const dadosDir = path.join(root, 'dados');
  const agendaFile = () => path.join(dadosDir, 'agenda-serena-v2.json');
  let seq = 0;

  const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return def; } };
  const agenda = () => readJson(agendaFile(), { leads: {}, slots: [] });

  function newPhone() { seq += 1; return `55119${String(80000000 + seq)}`; }

  function resetAll() {
    for (const f of ['agenda-serena-v2.json', 'serena-daily-events.json', 'blacklist-optout.json',
      'serena-pending-confirmations.json', 'antiban-hourly-metrics.json']) {
      try { fs.unlinkSync(path.join(dadosDir, f)); } catch (_) {}
    }
    try { fs.unlinkSync(path.join(appdataDados(), 'serena-daily-events.json')); } catch (_) {}
  }
  function appdataDados() { return path.join(process.env.APPDATA, 'mm-sender', 'dados'); }

  async function say(phone, text, pushName = '') {
    return eng.handleIncomingWhatsAppMessage(phone, text, pushName);
  }
  /** Executa vários turnos; retorna { replies: [...], last } */
  async function talk(phone, turns, pushName = '') {
    const replies = [];
    for (const t of turns) replies.push(await say(phone, t, pushName));
    return { replies, last: replies[replies.length - 1] };
  }
  const lead = phone => agenda().leads[phone];
  const events = () => readJson(path.join(dadosDir, 'serena-daily-events.json'), { leads: {}, opEvents: [], receptionAlerts: [] });
  const metrics = (d = 'all') => dash.computeDashboardMetrics(d);
  const alerts = () => dash.getReceptionAlerts();
  const blacklist = () => readJson(path.join(dadosDir, 'blacklist-optout.json'), []);

  /** Chega a um lead qualificado com nome completo + slots oferecidos */
  async function leadOffered(phone, interestMsg = 'Quero uma avaliação') {
    await say(phone, 'Olá');
    await say(phone, 'João da Silva');
    await say(phone, 'Sim');
    await say(phone, interestMsg);
    return say(phone, 'Quero agendar');
  }

  return {
    root, eng, dash, anti, guard, say, talk, lead, agenda, events, metrics, alerts, blacklist,
    newPhone, resetAll, leadOffered, readJson, dadosDir,
  };
}

module.exports = { makeHarness };

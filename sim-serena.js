/**
 * sim-serena.js — Simulador de conversas da Serena (sem WhatsApp, sem Electron, banco em memória).
 * Uso: node sim-serena.js
 */
const path = require('path');
const Module = require('module');

// ── Banco em memória que substitui src/db.js ─────────────────────────────────
const leads = {};
const appts = [];
let msgs = [];
const cfg = { serena_enabled: '1', reception_phone: '5511900000000' };

const fakeDb = {
  getConfig: () => cfg,
  getSerenaLead: p => leads[p],
  upsertSerenaLead: (p, f = {}) => {
    if (!leads[p]) leads[p] = { phone: p, name: '', state: 'NEW', state_data: '{}', opt_out: 0 };
    for (const [k, v] of Object.entries(f)) leads[p][k] = (k === 'state_data' && typeof v === 'object') ? JSON.stringify(v) : v;
    return leads[p];
  },
  insertSerenaMessage: (p, s, m) => msgs.push({ p, s, m }),
  getAppointmentsByDate: d => appts.filter(a => a.date === d && a.status === 'confirmed'),
  isSlotAvailable: (d, t) => !appts.some(a => a.date === d && a.time === t && a.status === 'confirmed'),
  createAppointment: (p, n, d, t) => appts.push({ lead_phone: p, lead_name: n, date: d, time: t, status: 'confirmed' }),
  cancelAppointmentByPhone: p => appts.forEach(a => { if (a.lead_phone === p) a.status = 'cancelled'; }),
  getActiveAppointmentByPhone: p => appts.find(a => a.lead_phone === p && a.status === 'confirmed'),
  getCustomHolidays: () => [],
  updateAppointmentReminderResponse: () => {},
};

const dbPath = path.resolve(__dirname, 'src', 'db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

// Remove atrasos de digitação
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);

const serena = require('./src/serenaCore');

async function run(title, turns, pushName = '') {
  Object.keys(leads).forEach(k => delete leads[k]);
  appts.length = 0;
  console.log('\n' + '═'.repeat(78) + '\n' + title + '\n' + '═'.repeat(78));
  const phone = '5511988887777';
  for (const t of turns) {
    console.log(`\n👤 PACIENTE: ${t}`);
    const out = [];
    await serena.processMessage(phone, t, async (_p, text) => { out.push(text); }, pushName);
    out.forEach(o => console.log(`🤖 SERENA: ${o.replace(/\n/g, '\n          ')}`));
    console.log(`   [estado: ${leads[phone] ? leads[phone].state : '-'}]`);
  }
}

const only = process.argv[2];
const scenarios = require('./sim-scenarios');

(async () => {
  for (const s of scenarios) {
    if (only && !s.id.includes(only)) continue;
    await run(`${s.id} — ${s.title}`, s.turns, s.pushName || '');
  }
  process.exit(0);
})();

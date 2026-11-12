/**
 * test-regression.js — Runner de testes regressivos da Serena.
 *
 * Uso:
 *   node test-regression.js          → roda todos os cenários
 *   node test-regression.js S08      → roda apenas cenários cujo id contém "S08"
 *   node test-regression.js --verbose → mostra toda a conversa mesmo nos que passam
 *
 * Retorna exit code 0 se tudo passar, 1 se houver falhas.
 */
'use strict';

const path = require('path');
const Module = require('module');

// ── Bootstrap: banco em memória ───────────────────────────────────────────────
function makeDb() {
  const leads = {};
  const appts = [];
  const cfg = { serena_enabled: '1', reception_phone: '5511900000000' };
  return {
    getConfig: () => cfg,
    getSerenaLead: p => leads[p],
    upsertSerenaLead: (p, f = {}) => {
      if (!leads[p]) leads[p] = { phone: p, name: '', state: 'NEW', state_data: '{}', opt_out: 0 };
      for (const [k, v] of Object.entries(f))
        leads[p][k] = (k === 'state_data' && typeof v === 'object') ? JSON.stringify(v) : v;
      return leads[p];
    },
    insertSerenaMessage: () => {},
    getAppointmentsByDate: d => appts.filter(a => a.date === d && a.status === 'confirmed'),
    isSlotAvailable: (d, t) => !appts.some(a => a.date === d && a.time === t && a.status === 'confirmed'),
    createAppointment: (p, n, d, t) => appts.push({ lead_phone: p, lead_name: n, date: d, time: t, status: 'confirmed' }),
    cancelAppointmentByPhone: p => appts.forEach(a => { if (a.lead_phone === p) a.status = 'cancelled'; }),
    getActiveAppointmentByPhone: p => appts.find(a => a.lead_phone === p && a.status === 'confirmed'),
    getCustomHolidays: () => [],
    updateAppointmentReminderResponse: () => {},
    _leads: leads,
  };
}

// Remove atrasos de digitação
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);

// ── Helpers de assertion ──────────────────────────────────────────────────────
function parseSlotTimes(text) {
  // Extrai horários apenas das linhas de slots numerados (1️⃣ ... às HH:MM)
  // para evitar capturar horários do header de erro ("às 15:00" no "Horário pedido:")
  const slotLines = text.split('\n').filter(l => /[1-3]️⃣/.test(l));
  const matches = [];
  for (const line of slotLines) {
    const m = line.match(/(\d{2}:\d{2})/g);
    if (m) matches.push(...m);
  }
  return matches;
}

function timeToMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function checkAssertions(scenario, finalState, allReplies, failures) {
  const e = scenario.expect || {};
  const lastReply = allReplies[allReplies.length - 1] || '';
  const allText = allReplies.join('\n');

  if (e.finalState && finalState !== e.finalState) {
    failures.push(`estado final: esperado "${e.finalState}", obtido "${finalState}"`);
  }
  if (e.notState && finalState === e.notState) {
    failures.push(`estado proibido "${e.notState}" foi atingido`);
  }
  if (e.lastContains) {
    for (const sub of e.lastContains) {
      if (!lastReply.includes(sub)) {
        failures.push(`última resposta deveria conter "${sub}"`);
      }
    }
  }
  if (e.lastNotContains) {
    for (const sub of e.lastNotContains) {
      if (lastReply.includes(sub)) {
        failures.push(`última resposta não deveria conter "${sub}"`);
      }
    }
  }
  if (e.anyContains) {
    for (const sub of e.anyContains) {
      if (!allText.includes(sub)) {
        failures.push(`nenhuma resposta conteve "${sub}"`);
      }
    }
  }
  if (e.anyNotContains) {
    for (const sub of e.anyNotContains) {
      if (allText.includes(sub)) {
        failures.push(`resposta não deveria conter "${sub}" em nenhum turno`);
      }
    }
  }
  if (e.slotsAllAfter) {
    const minRef = timeToMin(e.slotsAllAfter);
    const times = parseSlotTimes(lastReply);
    for (const t of times) {
      if (timeToMin(t) <= minRef) {
        failures.push(`slot ${t} está antes ou igual a ${e.slotsAllAfter} (slotsAllAfter)`);
      }
    }
  }
  if (e.slotsAllBefore) {
    const maxRef = timeToMin(e.slotsAllBefore);
    const times = parseSlotTimes(lastReply);
    for (const t of times) {
      if (timeToMin(t) >= maxRef) {
        failures.push(`slot ${t} está depois ou igual a ${e.slotsAllBefore} (slotsAllBefore)`);
      }
    }
  }
}

// ── Runner principal ──────────────────────────────────────────────────────────
async function runScenario(scenario) {
  // Isola módulos por cenário: recria db e serenaCore sem cache
  const dbPath = path.resolve(__dirname, 'src', 'db.js');
  const db = makeDb();
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };

  // Limpa cache do serenaCore e suas dependências para estado limpo
  const coreKeys = Object.keys(require.cache).filter(k =>
    k.includes('serenaCore') || k.includes('scheduleManager') || k.includes('holidays')
  );
  coreKeys.forEach(k => delete require.cache[k]);

  const serena = require('./src/serenaCore');
  const phone = '5511988887777';
  const pushName = scenario.pushName || '';

  const allReplies = [];
  const log = [];

  for (const turn of scenario.turns) {
    log.push(`  👤 ${turn}`);
    const out = [];
    await serena.processMessage(phone, turn, async (_p, text) => { out.push(text); }, pushName);
    out.forEach(o => {
      allReplies.push(o);
      log.push(`  🤖 ${o.replace(/\n/g, '\n     ')}`);
    });
    const lead = db._leads[phone.replace(/\D/g, '')];
    const state = lead ? lead.state : '-';
    log.push(`     [estado: ${state}]`);
  }

  const lead = db._leads[phone.replace(/\D/g, '')];
  const finalState = lead ? lead.state : 'NEW';

  const failures = [];
  checkAssertions(scenario, finalState, allReplies, failures);

  return { failures, log, finalState };
}

async function main() {
  const args = process.argv.slice(2);
  const filter = args.find(a => !a.startsWith('--'));
  const verbose = args.includes('--verbose');

  const scenarios = require('./sim-scenarios');
  const filtered = filter
    ? scenarios.filter(s => s.id.includes(filter) || s.title.toLowerCase().includes(filter.toLowerCase()))
    : scenarios;

  if (filtered.length === 0) {
    console.error(`Nenhum cenário encontrado para filtro "${filter}"`);
    process.exit(1);
  }

  const LINE = '─'.repeat(72);
  const results = { pass: 0, fail: 0, errors: [] };

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  🧪 Serena — Testes Regressivos  (${filtered.length} cenário${filtered.length > 1 ? 's' : ''})`);
  console.log(`${'═'.repeat(72)}\n`);

  for (const scenario of filtered) {
    let result;
    try {
      result = await runScenario(scenario);
    } catch (err) {
      result = { failures: [`ERRO INESPERADO: ${err.message}`], log: [], finalState: '?' };
    }

    const passed = result.failures.length === 0;
    const icon = passed ? '✅' : '❌';
    const status = passed ? 'PASS' : 'FAIL';

    console.log(`${icon} ${scenario.id} — ${scenario.title}`);
    console.log(`   Estado final: ${result.finalState}   [${status}]`);

    if (!passed) {
      results.fail++;
      results.errors.push({ id: scenario.id, title: scenario.title, failures: result.failures });
      result.failures.forEach(f => console.log(`   ⚠️  ${f}`));
      // Mostra a conversa completa quando falha
      console.log(LINE);
      result.log.forEach(l => console.log(l));
      console.log(LINE);
    } else {
      results.pass++;
      if (verbose) {
        console.log(LINE);
        result.log.forEach(l => console.log(l));
        console.log(LINE);
      }
    }
    console.log();
  }

  // ── Sumário ────────────────────────────────────────────────────────────────
  console.log('═'.repeat(72));
  console.log(`  Resultado: ${results.pass} passaram  |  ${results.fail} falharam`);
  console.log('═'.repeat(72));

  if (results.errors.length > 0) {
    console.log('\n  Falhas:\n');
    results.errors.forEach(e => {
      console.log(`  ❌ ${e.id} — ${e.title}`);
      e.failures.forEach(f => console.log(`       • ${f}`));
    });
    console.log();
    process.exit(1);
  } else {
    console.log('\n  Todos os cenários passaram! 🎉\n');
    process.exit(0);
  }
}

main();

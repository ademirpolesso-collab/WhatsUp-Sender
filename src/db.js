// === SERENA_RUNTIME_AUTOHOOK_START ===
try {
  const __p = require("path"), __f = require("fs");
  const __cands = [__p.join(__dirname, "configuracoes"), __p.join(__dirname, "..", "configuracoes"), __p.join(__dirname, "..", "..", "configuracoes"), __p.join(process.cwd(), "configuracoes")];
  if (process.resourcesPath) { __cands.push(__p.join(process.resourcesPath, "app", "configuracoes"), __p.join(process.resourcesPath, "configuracoes")); }
  for (const __d of __cands) { const __h = __p.join(__d, "runtimeAutoHook.cjs"); if (__f.existsSync(__h)) { require(__h); break; } }
} catch (_eAutoHook) {}
// === SERENA_RUNTIME_AUTOHOOK_END ===
/**
 * db.js — camada SQLite (better-sqlite3)
 * Criação/migração automática de tabelas na primeira execução.
 */
const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');

let db;

function getDb() {
  if (db) return db;
  const userDataPath = app ? app.getPath('userData') : '.';
  const dbPath = path.join(userDataPath, 'whatsapp-sender.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT    NOT NULL,
      phone     TEXT    NOT NULL UNIQUE,
      created_at TEXT   DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      title     TEXT NOT NULL,
      body      TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      UNIQUE(contact_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS send_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      wam_id     TEXT,
      status     TEXT DEFAULT 'pending',
      error_msg  TEXT,
      sent_at    TEXT,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Tabela de Leads da Serena
    CREATE TABLE IF NOT EXISTS serena_leads (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      phone            TEXT NOT NULL UNIQUE,
      name             TEXT DEFAULT '',
      whats_name       TEXT DEFAULT '',
      state            TEXT DEFAULT 'NEW',
      state_data       TEXT DEFAULT '{}',
      origin           TEXT DEFAULT 'whatsapp',
      opt_out          INTEGER DEFAULT 0,
      human            INTEGER DEFAULT 0,
      transferred_to_reception INTEGER DEFAULT 0,
      reception_transfer_time TEXT,
      reception_check_done    INTEGER DEFAULT 0,
      followup_count   INTEGER DEFAULT 0,
      last_interaction TEXT DEFAULT (datetime('now','localtime')),
      next_followup_at TEXT,
      created_at       TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Tabela de Agendamentos
    CREATE TABLE IF NOT EXISTS appointments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_phone     TEXT NOT NULL,
      lead_name      TEXT NOT NULL,
      date           TEXT NOT NULL, -- YYYY-MM-DD
      time           TEXT NOT NULL, -- HH:MM (ex: 08:30)
      status         TEXT DEFAULT 'confirmed', -- confirmed, cancelled, rescheduled
      notes          TEXT,
      created_at     TEXT DEFAULT (datetime('now','localtime')),
      updated_at     TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Histórico de Mensagens / Diálogo da Serena
    CREATE TABLE IF NOT EXISTS serena_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_phone TEXT NOT NULL,
      sender     TEXT NOT NULL, -- 'lead', 'serena', 'system'
      message    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Feriados Manuais / Municipais / Pontos Facultativos
    CREATE TABLE IF NOT EXISTS custom_holidays (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT NOT NULL UNIQUE, -- YYYY-MM-DD
      description TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    );

    -- ── Zelda: Gestão de Iniciativas do Condomínio ───────────────────────────

    CREATE TABLE IF NOT EXISTS zelda_initiatives (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      seq           INTEGER NOT NULL UNIQUE,   -- #001, #002...
      title         TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'em_cotacao',
        -- em_cotacao | cotado | em_aprovacao | aprovado | em_execucao | encerrado | negado
      responsible   TEXT    NOT NULL,
      due_date      TEXT,                      -- DD/MM/AAAA (livre)
      supplier      TEXT,                      -- fornecedor aprovado (preenchido ao aprovar)
      approved_value REAL,                     -- valor do orçamento vencedor
      created_by    TEXT    NOT NULL,          -- número WhatsApp de quem criou
      archived      INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now','localtime')),
      updated_at    TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS zelda_quotes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      initiative_id   INTEGER NOT NULL REFERENCES zelda_initiatives(id) ON DELETE CASCADE,
      seq             INTEGER NOT NULL,        -- 1, 2, 3
      supplier        TEXT    NOT NULL,
      value           REAL    NOT NULL,
      added_by        TEXT    NOT NULL,
      created_at      TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS zelda_votes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      initiative_id   INTEGER NOT NULL REFERENCES zelda_initiatives(id) ON DELETE CASCADE,
      voter_phone     TEXT    NOT NULL,
      voter_name      TEXT    NOT NULL DEFAULT '',
      vote            TEXT    NOT NULL,        -- 'approve' | 'reject'
      quote_seq       INTEGER,                 -- qual orçamento escolhido (ao aprovar)
      created_at      TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(initiative_id, voter_phone)       -- cada membro vota só uma vez
    );

    CREATE TABLE IF NOT EXISTS zelda_comments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      initiative_id   INTEGER NOT NULL REFERENCES zelda_initiatives(id) ON DELETE CASCADE,
      author_phone    TEXT    NOT NULL,
      author_name     TEXT    NOT NULL DEFAULT '',
      comment         TEXT    NOT NULL,
      created_at      TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS zelda_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id        TEXT    NOT NULL,
      sender_phone    TEXT    NOT NULL,
      sender_name     TEXT    NOT NULL DEFAULT '',
      direction       TEXT    NOT NULL,        -- 'in' | 'out'
      message         TEXT    NOT NULL,
      created_at      TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // Migração: adiciona colunas novas em tabelas já existentes (idempotente)
  const existingCols = db.prepare(`PRAGMA table_info(send_log)`).all().map(c => c.name);
  if (!existingCols.includes('error_msg')) {
    db.exec(`ALTER TABLE send_log ADD COLUMN error_msg TEXT`);
  }

  // Migração: colunas de lembrete de agendamento
  const apptCols = db.prepare(`PRAGMA table_info(appointments)`).all().map(c => c.name);
  if (!apptCols.includes('reminder_1d_sent')) {
    db.exec(`ALTER TABLE appointments ADD COLUMN reminder_1d_sent INTEGER DEFAULT 0`);
  }
  if (!apptCols.includes('reminder_3h_sent')) {
    db.exec(`ALTER TABLE appointments ADD COLUMN reminder_3h_sent INTEGER DEFAULT 0`);
  }
  if (!apptCols.includes('reminder_1h_sent')) {
    db.exec(`ALTER TABLE appointments ADD COLUMN reminder_1h_sent INTEGER DEFAULT 0`);
  }
  if (!apptCols.includes('reminder_response')) {
    // valores possíveis: 'confirmed', 'rescheduled', 'cancelled'
    db.exec(`ALTER TABLE appointments ADD COLUMN reminder_response TEXT`);
  }

  // Migração: colunas da régua de resgate inteligente na serena_leads
  const leadCols = db.prepare(`PRAGMA table_info(serena_leads)`).all().map(c => c.name);
  if (!leadCols.includes('reply_count')) {
    db.exec(`ALTER TABLE serena_leads ADD COLUMN reply_count INTEGER DEFAULT 0`);
  }
  if (!leadCols.includes('unanswered_bot_count')) {
    db.exec(`ALTER TABLE serena_leads ADD COLUMN unanswered_bot_count INTEGER DEFAULT 0`);
  }
  if (!leadCols.includes('procedure_interest')) {
    db.exec(`ALTER TABLE serena_leads ADD COLUMN procedure_interest TEXT DEFAULT ''`);
  }
  if (!leadCols.includes('is_urgent')) {
    db.exec(`ALTER TABLE serena_leads ADD COLUMN is_urgent INTEGER DEFAULT 0`);
  }
  if (!leadCols.includes('payment_modality')) {
    db.exec(`ALTER TABLE serena_leads ADD COLUMN payment_modality TEXT DEFAULT ''`);
  }
  if (!leadCols.includes('last_followup_step')) {
    db.exec(`ALTER TABLE serena_leads ADD COLUMN last_followup_step TEXT DEFAULT ''`);
  }
  if (!leadCols.includes('human')) {
    db.exec(`ALTER TABLE serena_leads ADD COLUMN human INTEGER DEFAULT 0`);
  }
  if (!leadCols.includes('whats_name')) {
    db.exec(`ALTER TABLE serena_leads ADD COLUMN whats_name TEXT DEFAULT ''`);
  }

  // defaults de configuração
  const defaults = {
    block_size: '10',
    block_delay: '60',
    whatsapp_number: '',
    reception_phone: '',
    serena_enabled: '1',
    clinic_name: 'OdontoCompany Bela Vista Osasco',
    clinic_address: 'Av Antonio Carlos Costa 991, Bela Vista, Osasco, SP',
    zelda_enabled: '1',
    zelda_group_name: 'Teste Conselho',
    zelda_sindico_phone: '11986624666',
    zelda_min_approvals: '3',
    zelda_reminder_hour: '9'
  };
  const ins = db.prepare(`INSERT OR IGNORE INTO config(key,value) VALUES(?,?)`);
  for (const [k, v] of Object.entries(defaults)) ins.run(k, v);

  // Migração: renomeia "Conselho T7 -" → "Teste Conselho" para bancos existentes
  const oldGroupName = db.prepare(`SELECT value FROM config WHERE key='zelda_group_name'`).get();
  if (oldGroupName && oldGroupName.value === 'Conselho T7 -') {
    db.prepare(`UPDATE config SET value='Teste Conselho' WHERE key='zelda_group_name'`).run();
  }
}

// ── Contatos ──────────────────────────────────────────────────────────────────
function getContacts() {
  return getDb().prepare(`SELECT * FROM contacts ORDER BY name`).all();
}
function insertContact(name, phone) {
  return getDb().prepare(`INSERT OR IGNORE INTO contacts(name,phone) VALUES(?,?)`).run(name, phone.replace(/\D/g, ''));
}
function deleteContact(id) {
  return getDb().prepare(`DELETE FROM contacts WHERE id=?`).run(id);
}
function deleteContacts(ids) {
  if (!ids || !ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  getDb().prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`).run(...ids);
}
function deleteAllContacts() {
  getDb().prepare(`DELETE FROM assignments`).run();
  getDb().prepare(`DELETE FROM send_log`).run();
  return getDb().prepare(`DELETE FROM contacts`).run();
}
function bulkInsertContacts(rows) {
  const ins = getDb().prepare(`INSERT OR IGNORE INTO contacts(name,phone) VALUES(?,?)`);
  const tx = getDb().transaction((rows) => { for (const r of rows) ins.run(r.name, r.phone.replace(/\D/g, '')); });
  tx(rows);
}

// ── Mensagens ─────────────────────────────────────────────────────────────────
function getMessages() {
  return getDb().prepare(`SELECT * FROM messages ORDER BY title`).all();
}
function insertMessage(title, body) {
  return getDb().prepare(`INSERT INTO messages(title,body) VALUES(?,?)`).run(title, body);
}
function updateMessage(id, title, body) {
  return getDb().prepare(`UPDATE messages SET title=?,body=? WHERE id=?`).run(title, body, id);
}
function deleteMessage(id) {
  return getDb().prepare(`DELETE FROM messages WHERE id=?`).run(id);
}

// ── Associações ───────────────────────────────────────────────────────────────
function getAssignments() {
  return getDb().prepare(`
    SELECT a.id, c.id as contact_id, c.name, c.phone, m.id as message_id, m.title
    FROM assignments a
    JOIN contacts c ON c.id=a.contact_id
    JOIN messages m ON m.id=a.message_id
    ORDER BY c.name
  `).all();
}
function setAssignment(contactId, messageId) {
  return getDb().prepare(`INSERT OR REPLACE INTO assignments(contact_id,message_id) VALUES(?,?)`).run(contactId, messageId);
}
function deleteAssignment(id) {
  return getDb().prepare(`DELETE FROM assignments WHERE id=?`).run(id);
}

// ── Send Log ──────────────────────────────────────────────────────────────────
function getSendLog() {
  return getDb().prepare(`
    SELECT l.id, c.name as contact_name, c.phone as contact_phone,
           m.title as message_title, l.wam_id, l.status, l.error_msg, l.sent_at, l.updated_at
    FROM send_log l
    JOIN contacts c ON c.id=l.contact_id
    JOIN messages m ON m.id=l.message_id
    ORDER BY l.id DESC
  `).all();
}
function insertLog(contactId, messageId, wamId, status = 'pending', errorMsg = null) {
  return getDb().prepare(`
    INSERT INTO send_log(contact_id,message_id,wam_id,status,error_msg,sent_at)
    VALUES(?,?,?,?,?,datetime('now','localtime'))
  `).run(contactId, messageId, wamId, status, errorMsg);
}
function updateLog(id, status, errorMsg = null) {
  return getDb().prepare(`
    UPDATE send_log SET status=?,error_msg=?,updated_at=datetime('now','localtime') WHERE id=?
  `).run(status, errorMsg, id);
}
function updateLogByWamId(wamId, status) {
  return getDb().prepare(`UPDATE send_log SET status=?,updated_at=datetime('now','localtime') WHERE wam_id=?`).run(status, wamId);
}
function markRepliedByContactId(contactId) {
  return getDb().prepare(`
    UPDATE send_log SET status='replied', updated_at=datetime('now','localtime')
    WHERE id = (
      SELECT id FROM send_log WHERE contact_id=?
      AND status IN ('sent','delivered','read')
      ORDER BY sent_at DESC LIMIT 1
    )
  `).run(contactId);
}

// ── Serena Leads ──────────────────────────────────────────────────────────────
function getSerenaLead(phone) {
  return getDb().prepare(`SELECT * FROM serena_leads WHERE phone=?`).get(phone);
}

function resetSerenaConversations() {
  // Salva offset de agendamentos no momento do reset para zerar o contador no dashboard
  const currentApptCount = getDb().prepare(`SELECT count(*) as count FROM appointments WHERE status='confirmed'`).get().count;
  getDb().prepare(`INSERT OR REPLACE INTO config(key, value) VALUES('appointments_reset_offset', ?)`).run(String(currentApptCount));

  getDb().prepare(`DELETE FROM serena_messages`).run();
  return getDb().prepare(`DELETE FROM serena_leads`).run();
}

function resetLeadByPhone(phone) {
  getDb().prepare(`DELETE FROM serena_messages WHERE lead_phone=?`).run(phone);
  return getDb().prepare(`DELETE FROM serena_leads WHERE phone=?`).run(phone);
}

function upsertSerenaLead(phone, fields = {}) {
  const existing = getSerenaLead(phone);
  if (!existing) {
    getDb().prepare(`
      INSERT INTO serena_leads (phone, name, whats_name, state, state_data, origin, opt_out, human, transferred_to_reception, reception_transfer_time, reception_check_done, followup_count, last_interaction, next_followup_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?)
    `).run(
      phone,
      fields.name || '',
      fields.whats_name || '',
      fields.state || 'NEW',
      fields.state_data ? JSON.stringify(fields.state_data) : '{}',
      fields.origin || 'whatsapp',
      fields.opt_out || 0,
      fields.human || 0,
      fields.transferred_to_reception || 0,
      fields.reception_transfer_time || null,
      fields.reception_check_done || 0,
      fields.followup_count || 0,
      fields.next_followup_at || null
    );
  } else {
    const keys = Object.keys(fields);
    if (keys.length > 0) {
      const setClauses = keys.map(k => `${k}=?`).join(', ');
      const values = keys.map(k => k === 'state_data' && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]);
      getDb().prepare(`
        UPDATE serena_leads SET ${setClauses}, last_interaction=datetime('now','localtime') WHERE phone=?
      `).run(...values, phone);
    } else {
      getDb().prepare(`UPDATE serena_leads SET last_interaction=datetime('now','localtime') WHERE phone=?`).run(phone);
    }
  }
  return getSerenaLead(phone);
}

function updateSerenaLeadState(phone, state, stateData = null) {
  if (stateData !== null) {
    return getDb().prepare(`
      UPDATE serena_leads
      SET state=?, state_data=?, last_interaction=datetime('now','localtime')
      WHERE phone=?
    `).run(state, JSON.stringify(stateData), phone);
  }
  return getDb().prepare(`
    UPDATE serena_leads
    SET state=?, last_interaction=datetime('now','localtime')
    WHERE phone=?
  `).run(state, phone);
}

function getSerenaLeadsForFollowup() {
  return getDb().prepare(`
    SELECT * FROM serena_leads
    WHERE opt_out = 0
      AND human = 0
      AND transferred_to_reception = 0
      AND state NOT IN ('AGENDADO', 'CONCLUIDO', 'OPT_OUT', 'EMERGENCIA')
      AND followup_count < 5
      AND next_followup_at IS NOT NULL
      AND next_followup_at <= datetime('now','localtime')
    ORDER BY next_followup_at ASC
  `).all();
}

function getLeadsAwaitingReceptionCheck() {
  return getDb().prepare(`
    SELECT * FROM serena_leads
    WHERE transferred_to_reception = 1
      AND human = 0
      AND reception_check_done = 0
      AND reception_transfer_time IS NOT NULL
      AND datetime(reception_transfer_time, '+2 hours') <= datetime('now','localtime')
  `).all();
}

function insertSerenaMessage(leadPhone, sender, message) {
  return getDb().prepare(`
    INSERT INTO serena_messages(lead_phone, sender, message) VALUES(?, ?, ?)
  `).run(leadPhone, sender, message);
}

function getSerenaMessages(leadPhone, limit = 50) {
  return getDb().prepare(`
    SELECT * FROM serena_messages WHERE lead_phone=? ORDER BY id DESC LIMIT ?
  `).all(leadPhone, limit).reverse();
}

function getSerenaRecentActivity(limit = 100) {
  return getDb().prepare(`
    SELECT m.id, m.lead_phone, m.sender, m.message, m.created_at, l.name as lead_name, l.state
    FROM serena_messages m
    LEFT JOIN serena_leads l ON l.phone = m.lead_phone
    ORDER BY m.id DESC
    LIMIT ?
  `).all(limit);
}

// ── Agendamentos ──────────────────────────────────────────────────────────────
function getAppointmentsByDate(date) {
  return getDb().prepare(`
    SELECT * FROM appointments WHERE date=? AND status='confirmed' ORDER BY time ASC
  `).all(date);
}

function getAllAppointments(limit = 200) {
  return getDb().prepare(`
    SELECT * FROM appointments ORDER BY date DESC, time DESC LIMIT ?
  `).all(limit);
}

function isSlotAvailable(date, time) {
  const existing = getDb().prepare(`
    SELECT id FROM appointments WHERE date=? AND time=? AND status='confirmed'
  `).get(date, time);
  return !existing;
}

function createAppointment(leadPhone, leadName, date, time, notes = '') {
  return getDb().prepare(`
    INSERT INTO appointments(lead_phone, lead_name, date, time, notes)
    VALUES(?, ?, ?, ?, ?)
  `).run(leadPhone, leadName, date, time, notes);
}

function cancelAppointmentByPhone(leadPhone) {
  return getDb().prepare(`
    UPDATE appointments SET status='cancelled', updated_at=datetime('now','localtime')
    WHERE lead_phone=? AND status='confirmed'
  `).run(leadPhone);
}

function getActiveAppointmentByPhone(leadPhone) {
  return getDb().prepare(`
    SELECT * FROM appointments WHERE lead_phone=? AND status='confirmed' ORDER BY id DESC LIMIT 1
  `).get(leadPhone);
}

/**
 * Retorna agendamentos confirmados que precisam de lembrete.
 * Lembrete de 1 dia: data do agendamento é amanhã e reminder_1d_sent = 0
 * Lembrete de 3h:  data é hoje e horário está entre 3h e 3h30 no futuro e reminder_3h_sent = 0
 * Lembrete de 1h:  data é hoje e horário está entre 1h e 1h30 no futuro e reminder_1h_sent = 0
 *
 * Retorna cada agendamento com campo extra `reminder_type` ('1d' | '3h' | '1h')
 * usando queries separadas por tipo para evitar ambiguidade quando múltiplas
 * condições são verdadeiras ao mesmo tempo.
 */
function getAppointmentsForReminder() {
  const db = getDb();
  const results = [];
  const seen = new Set();

  // Prioridade de envio: 1h (mais urgente) > 3h > 1d
  // Queries separadas garantem que cada tipo dispara exatamente uma vez
  const queries = [
    {
      type: '1h',
      sql: `SELECT * FROM appointments WHERE status='confirmed'
              AND reminder_1h_sent=0
              AND date=date('now','localtime')
              AND time(time) BETWEEN time(datetime('now','localtime','+1 hour'))
                                 AND time(datetime('now','localtime','+1 hour 30 minutes'))
            ORDER BY date ASC, time ASC`,
    },
    {
      type: '3h',
      sql: `SELECT * FROM appointments WHERE status='confirmed'
              AND reminder_3h_sent=0
              AND date=date('now','localtime')
              AND time(time) BETWEEN time(datetime('now','localtime','+3 hours'))
                                 AND time(datetime('now','localtime','+3 hours 30 minutes'))
            ORDER BY date ASC, time ASC`,
    },
    {
      type: '1d',
      sql: `SELECT * FROM appointments WHERE status='confirmed'
              AND reminder_1d_sent=0
              AND date=date('now','localtime','+1 day')
            ORDER BY date ASC, time ASC`,
    },
  ];

  for (const { type, sql } of queries) {
    const rows = db.prepare(sql).all();
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        results.push({ ...row, reminder_type: type });
      }
    }
  }

  return results;
}

function markReminderSent(appointmentId, type) {
  const col = type === '1d' ? 'reminder_1d_sent'
            : type === '3h' ? 'reminder_3h_sent'
            : 'reminder_1h_sent';
  return getDb().prepare(`
    UPDATE appointments SET ${col}=1, updated_at=datetime('now','localtime') WHERE id=?
  `).run(appointmentId);
}

function updateAppointmentReminderResponse(appointmentId, response) {
  return getDb().prepare(`
    UPDATE appointments SET reminder_response=?, updated_at=datetime('now','localtime') WHERE id=?
  `).run(response, appointmentId);
}

// ── Dashboard Metrics ─────────────────────────────────────────────────────────
function getDashboardMetrics(dateFilter = null) {
  let leadsQuery = `SELECT count(*) as count FROM serena_leads`;
  let respondedQuery = `SELECT count(DISTINCT lead_phone) as count FROM serena_messages WHERE sender='lead'`;
  let appointmentsQuery = `SELECT count(*) as count FROM appointments WHERE status='confirmed'`;

  if (dateFilter) {
    leadsQuery += ` WHERE date(created_at) = date('${dateFilter}')`;
    respondedQuery += ` AND date(created_at) = date('${dateFilter}')`;
    appointmentsQuery += ` AND date(date) = date('${dateFilter}')`;
  }

  const totalLeads = getDb().prepare(leadsQuery).get().count;
  const totalResponded = getDb().prepare(respondedQuery).get().count;
  const totalAppointments = getDb().prepare(appointmentsQuery).get().count;

  // Acumulados gerais (sempre no topo)
  const allLeads = getDb().prepare(`SELECT count(*) as count FROM serena_leads`).get().count;
  const allResponded = getDb().prepare(`SELECT count(DISTINCT lead_phone) as count FROM serena_messages WHERE sender='lead'`).get().count;
  const rawAllAppointments = getDb().prepare(`SELECT count(*) as count FROM appointments WHERE status='confirmed'`).get().count;

  // Desconta o offset gravado no último "Reiniciar Conversas" (zera contador sem apagar agenda)
  const apptOffsetRow = getDb().prepare(`SELECT value FROM config WHERE key='appointments_reset_offset'`).get();
  const apptOffset = apptOffsetRow ? parseInt(apptOffsetRow.value, 10) : 0;
  const allAppointments = Math.max(0, rawAllAppointments - apptOffset);

  return {
    filtered: {
      leads: totalLeads,
      responded: totalResponded,
      appointments: totalAppointments
    },
    accumulated: {
      leads: allLeads,
      responded: allResponded,
      appointments: allAppointments
    }
  };
}

// ── Feriados Manuais ──────────────────────────────────────────────────────────
function getCustomHolidays() {
  return getDb().prepare(`SELECT * FROM custom_holidays ORDER BY date ASC`).all();
}

function addCustomHoliday(date, description) {
  return getDb().prepare(`
    INSERT OR REPLACE INTO custom_holidays(date, description) VALUES(?, ?)
  `).run(date, description);
}

function deleteCustomHoliday(id) {
  return getDb().prepare(`DELETE FROM custom_holidays WHERE id=?`).run(id);
}

// ── Config ────────────────────────────────────────────────────────────────────
function getConfig() {
  const rows = getDb().prepare(`SELECT key,value FROM config`).all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
function setConfig(key, value) {
  return getDb().prepare(`INSERT OR REPLACE INTO config(key,value) VALUES(?,?)`).run(key, String(value));
}

// ── Zelda: Iniciativas ────────────────────────────────────────────────────────
function zeldaNextSeq() {
  const row = getDb().prepare(`SELECT COALESCE(MAX(seq),0)+1 as next FROM zelda_initiatives`).get();
  return row.next;
}

function zeldaCreateInitiative(title, responsible, dueDate, createdBy, status = 'em_cotacao', supplier = null, approvedValue = null) {
  const seq = zeldaNextSeq();
  getDb().prepare(`
    INSERT INTO zelda_initiatives(seq, title, status, responsible, due_date, supplier, approved_value, created_by)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `).run(seq, title, status || 'em_cotacao', responsible, dueDate || null, supplier || null, approvedValue || null, createdBy);
  return getDb().prepare(`SELECT * FROM zelda_initiatives WHERE seq=?`).get(seq);
}

function zeldaGetBySeq(seq) {
  return getDb().prepare(`SELECT * FROM zelda_initiatives WHERE seq=?`).get(Number(seq));
}

function zeldaGetById(id) {
  return getDb().prepare(`SELECT * FROM zelda_initiatives WHERE id=?`).get(id);
}

function zeldaListActive() {
  return getDb().prepare(`
    SELECT * FROM zelda_initiatives WHERE archived=0 ORDER BY seq ASC
  `).all();
}

function zeldaListArchived() {
  return getDb().prepare(`
    SELECT * FROM zelda_initiatives WHERE archived=1 ORDER BY seq DESC
  `).all();
}

function zeldaUpdateStatus(id, status, extra = {}) {
  const now = `datetime('now','localtime')`;
  let sql = `UPDATE zelda_initiatives SET status=?, updated_at=${now}`;
  const params = [status];
  if (extra.supplier !== undefined) { sql += `, supplier=?`; params.push(extra.supplier); }
  if (extra.approved_value !== undefined) { sql += `, approved_value=?`; params.push(extra.approved_value); }
  sql += ` WHERE id=?`;
  params.push(id);
  getDb().prepare(sql).run(...params);
}

function zeldaArchiveAll() {
  getDb().prepare(`
    UPDATE zelda_initiatives SET archived=1, updated_at=datetime('now','localtime')
    WHERE archived=0 AND status IN ('encerrado','negado')
  `).run();
}

// ── Zelda: Orçamentos ─────────────────────────────────────────────────────────
function zeldaAddQuote(initiativeId, supplier, value, addedBy) {
  const maxSeq = getDb().prepare(`SELECT COALESCE(MAX(seq),0) as m FROM zelda_quotes WHERE initiative_id=?`).get(initiativeId).m;
  if (maxSeq >= 3) return null; // máximo 3 orçamentos
  const seq = maxSeq + 1;
  getDb().prepare(`
    INSERT INTO zelda_quotes(initiative_id, seq, supplier, value, added_by) VALUES(?,?,?,?,?)
  `).run(initiativeId, seq, supplier, value, addedBy);
  return seq;
}

function zeldaGetQuotes(initiativeId) {
  return getDb().prepare(`SELECT * FROM zelda_quotes WHERE initiative_id=? ORDER BY seq ASC`).all(initiativeId);
}

// ── Zelda: Votos ──────────────────────────────────────────────────────────────
function zeldaAddVote(initiativeId, voterPhone, voterName, vote, quoteSeq) {
  try {
    getDb().prepare(`
      INSERT INTO zelda_votes(initiative_id, voter_phone, voter_name, vote, quote_seq)
      VALUES(?,?,?,?,?)
    `).run(initiativeId, voterPhone, voterName, vote, quoteSeq || null);
    return true;
  } catch (_) {
    return false; // UNIQUE constraint — já votou
  }
}

function zeldaGetVotes(initiativeId) {
  return getDb().prepare(`SELECT * FROM zelda_votes WHERE initiative_id=? ORDER BY id ASC`).all(initiativeId);
}

function zeldaCountVotes(initiativeId) {
  const votes = zeldaGetVotes(initiativeId);
  const approvals = votes.filter(v => v.vote === 'approve');
  const rejections = votes.filter(v => v.vote === 'reject');
  return { approvals, rejections, total: votes.length };
}

function zeldaHasVoted(initiativeId, voterPhone) {
  return !!getDb().prepare(`SELECT id FROM zelda_votes WHERE initiative_id=? AND voter_phone=?`).get(initiativeId, voterPhone);
}

// ── Zelda: Comentários ────────────────────────────────────────────────────────
function zeldaAddComment(initiativeId, authorPhone, authorName, comment) {
  getDb().prepare(`
    INSERT INTO zelda_comments(initiative_id, author_phone, author_name, comment)
    VALUES(?,?,?,?)
  `).run(initiativeId, authorPhone, authorName, comment);
}

function zeldaGetComments(initiativeId) {
  return getDb().prepare(`SELECT * FROM zelda_comments WHERE initiative_id=? ORDER BY id ASC`).all(initiativeId);
}

// ── Zelda: Mensagens (log) ────────────────────────────────────────────────────
function zeldaLogMessage(groupId, senderPhone, senderName, direction, message) {
  getDb().prepare(`
    INSERT INTO zelda_messages(group_id, sender_phone, sender_name, direction, message)
    VALUES(?,?,?,?,?)
  `).run(groupId, senderPhone, senderName, direction, message);
}

function zeldaGetMessages(limit = 200) {
  return getDb().prepare(`
    SELECT * FROM zelda_messages ORDER BY id DESC LIMIT ?
  `).all(limit).reverse();
}

// Retorna iniciativas em status 'em_aprovacao' que ainda não foram aprovadas/negadas
function zeldaGetPendingApprovals() {
  return getDb().prepare(`
    SELECT * FROM zelda_initiatives
    WHERE status='em_aprovacao' AND archived=0
    ORDER BY seq ASC
  `).all();
}

module.exports = {
  getContacts, insertContact, deleteContact, deleteContacts, deleteAllContacts, bulkInsertContacts,
  getMessages, insertMessage, updateMessage, deleteMessage,
  getAssignments, setAssignment, deleteAssignment,
  getSendLog, insertLog, updateLog, updateLogByWamId, markRepliedByContactId,
  getSerenaLead, upsertSerenaLead, updateSerenaLeadState, getSerenaLeadsForFollowup, getLeadsAwaitingReceptionCheck,
  resetSerenaConversations, resetLeadByPhone,
  insertSerenaMessage, getSerenaMessages, getSerenaRecentActivity,
  getAppointmentsByDate, getAllAppointments, isSlotAvailable, createAppointment, cancelAppointmentByPhone, getActiveAppointmentByPhone,
  getAppointmentsForReminder, markReminderSent, updateAppointmentReminderResponse,
  getDashboardMetrics,
  getCustomHolidays, addCustomHoliday, deleteCustomHoliday,
  getConfig, setConfig,
  // Zelda
  zeldaCreateInitiative, zeldaGetBySeq, zeldaGetById, zeldaListActive, zeldaListArchived,
  zeldaUpdateStatus, zeldaArchiveAll,
  zeldaAddQuote, zeldaGetQuotes,
  zeldaAddVote, zeldaGetVotes, zeldaCountVotes, zeldaHasVoted,
  zeldaAddComment, zeldaGetComments,
  zeldaLogMessage, zeldaGetMessages, zeldaGetPendingApprovals
};

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

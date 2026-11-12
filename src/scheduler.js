/**
 * scheduler.js — fila de envio por blocos com delay configurável
 */
const db = require('./db');
const wa = require('./whatsapp');

let running = false;
let cancelRequested = false;
let mainWindow = null;

function setWindow(win) { mainWindow = win; }

function emit(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function resolveText(body, contact) {
  return body
    .replace(/\{\{nome\}\}/gi, contact.name)
    .replace(/\{\{telefone\}\}/gi, contact.phone);
}

/**
 * @param {Array}  jobs      [{contact_id, contact_name, phone, message_id, message_body}]
 * @param {number} blockSize número de mensagens por bloco
 * @param {number} delaySec  segundos entre blocos
 */
async function run(jobs, blockSize, delaySec) {
  if (running) throw new Error('Já existe um envio em andamento');
  running = true;
  cancelRequested = false;

  emit('scheduler:start', { total: jobs.length });

  for (let i = 0; i < jobs.length; i += blockSize) {
    if (cancelRequested) break;

    const block = jobs.slice(i, i + blockSize);

    for (const job of block) {
      if (cancelRequested) break;
      const logRow = db.insertLog(job.contact_id, job.message_id);
      const logId  = logRow.lastInsertRowid;

      try {
        const text  = resolveText(job.message_body, { name: job.contact_name, phone: job.phone });
        const cleanPhone = String(job.phone || '').replace(/\D/g, '');
        const wamId = await wa.sendMessage(cleanPhone, text);
        db.updateLog(logId, 'sent', wamId);

        // Registra o lead outbound da campanha na base da Serena com origin='bulk_campaign' e reply_count=0
        const existingLead = db.getSerenaLead(cleanPhone);
        if (!existingLead) {
          db.upsertSerenaLead(cleanPhone, {
            name: job.contact_name || '',
            origin: 'bulk_campaign',
            state: 'OUTBOUND_CAMPANHA',
            reply_count: 0,
            unanswered_bot_count: 1
          });
        }

        emit('scheduler:progress', { logId, contact: job.contact_name, status: 'sent', index: i });
      } catch (err) {
        db.updateLog(logId, 'error', null, err.message);
        emit('scheduler:progress', { logId, contact: job.contact_name, status: 'error', error: err.message, index: i });
      }

      // pequena pausa entre mensagens do mesmo bloco (evita flood)
      await sleep(1200);
    }

    // delay entre blocos (exceto após o último)
    const isLast = i + blockSize >= jobs.length;
    if (!isLast && !cancelRequested) {
      emit('scheduler:waiting', { seconds: delaySec, nextAt: i + blockSize });
      await sleep(delaySec * 1000);
    }
  }

  running = false;
  emit('scheduler:done', { cancelled: cancelRequested });
}

function cancel() {
  cancelRequested = true;
}

function isRunning() { return running; }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { run, cancel, isRunning, setWindow };

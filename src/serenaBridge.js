/**
 * serenaBridge.js — liga o Fluxo Mestre Corporativo (serenaEngine.mjs) ao cliente whatsapp-web.js.
 */
const path = require('path');
const { pathToFileURL } = require('url');

let enginePromise = null;
function getEngine() {
  if (!enginePromise) {
    const enginePath = path.join(__dirname, '..', 'serenaEngine.mjs');
    enginePromise = import(pathToFileURL(enginePath).href);
  }
  return enginePromise;
}

const botSentIds = new Set();
const botSentAt = new Map();
const BOT_ECHO_WINDOW_MS = 20 * 1000;

const PAUSE_CMD_REGEX = /^#(pausar|pausa|silenciar|assumir)\b/i;
const RESUME_CMD_REGEX = /^#(retomar|voltar|despausar|bot)\b/i;

const digits = (v) => String(v || '').replace(/\D/g, '');

function markBotSend(target, id) {
  const ph = digits(String(target || '').split('@')[0]);
  if (ph) botSentAt.set(ph, Date.now());
  if (id) {
    botSentIds.add(id);
    if (botSentIds.size > 800) botSentIds.delete(botSentIds.values().next().value);
  }
}

function makeRawSend(client) {
  const base = client.__serenaOrigSendMessage
    ? client.__serenaOrigSendMessage.bind(client)
    : client.sendMessage.bind(client);
  return async (target, payload, opts) => {
    markBotSend(target);
    const res = await base(target, payload, opts);
    markBotSend(target, res && res.id && res.id._serialized);
    return res;
  };
}

async function handleText(client, chatId, text, pushName) {
  const engine = await getEngine();
  return engine.processAndReplySerenaWhatsApp(client, chatId, text, pushName || '', {
    rawSendFn: makeRawSend(client),
  });
}

async function sendFixedReply(client, chatId, text) {
  const engine = await getEngine();
  return engine.sendProtectedWhatsAppMessage(client, chatId, text, {
    isBulkCampaign: false,
    rawSendFn: makeRawSend(client),
  });
}

function handleOutgoingMessage(msg, receptionPhone) {
  try {
    if (!msg || !msg.fromMe) return false;
    const id = msg.id && msg.id._serialized;
    if (id && botSentIds.has(id)) return false;

    const target = msg.to || msg.from;
    if (!target || target.includes('@g.us') || target.includes('@broadcast')) return false;

    const phone = digits(String(target).split('@')[0]);
    if (!phone || phone === digits(receptionPhone)) return false;

    const text = String(msg.body || '').trim();

    if (PAUSE_CMD_REGEX.test(text)) {
      getEngine().then((eng) => eng.setCrcAssumiu(phone, true));
      return 'paused';
    }

    if (RESUME_CMD_REGEX.test(text)) {
      getEngine().then((eng) => eng.setCrcAssumiu(phone, false));
      return 'resumed';
    }

    if (Date.now() - (botSentAt.get(phone) || 0) < BOT_ECHO_WINDOW_MS) return false;

    getEngine().then((eng) => eng.setCrcAssumiu(phone, true));
    return 'paused';
  } catch (_) {
    return false;
  }
}

function startScheduler() {
  return true;
}

function stopScheduler() {
  return true;
}

module.exports = {
  getEngine,
  handleText,
  sendFixedReply,
  handleOutgoingMessage,
  startScheduler,
  stopScheduler,
};
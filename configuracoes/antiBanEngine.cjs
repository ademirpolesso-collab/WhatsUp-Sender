// configuracoes/antiBanEngine.cjs
// Escudo Anti-Banimento para Disparo em Massa e Automação WhatsApp Web (mm-sender)

process.env.TZ = "America/Sao_Paulo";

const fs = require("fs");
const path = require("path");
const { resolveWritableDataDir, getClinicSettings } = require("./configManager.cjs");

const DATA_DIR = path.join(resolveWritableDataDir(), "dados");
const BLACKLIST_FILE = path.join(DATA_DIR, "blacklist-optout.json");
const METRICS_FILE = path.join(DATA_DIR, "antiban-hourly-metrics.json");
const PENDING_CONFIRMATIONS_FILE = path.join(DATA_DIR, "serena-pending-confirmations.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function normalizePhoneDigits(phoneOrJid) {
  const clean = String(phoneOrJid || "").split("@")[0];
  return clean.replace(/\D+/g, "");
}

function normalizePhoneKeyShort(phoneOrJid) {
  const d = normalizePhoneDigits(phoneOrJid);
  if (d.length > 11 && d.startsWith("55")) return d.slice(2);
  return d;
}

function randomBetween(minMs, maxMs) {
  const low = Math.max(1000, Number(minMs) || 3000);
  const high = Math.max(low + 200, Number(maxMs) || 7000);
  return Math.floor(low + Math.random() * (high - low + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanPatientFirstName(rawName) {
  const cleaned = String(rawName || "")
    .replace(/^(oi|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite)[,!.\s]*/i, "")
    .replace(/[!?.:,;]+$/g, "")
    .trim();
  if (
    !cleaned ||
    /^(nome[-_\s]?paciente|\{nome\}|\[nome\]|paciente|tudo\s+bem|amigo\(?a?\)?|cliente|visitante|novo\s+lead)/i.test(
      cleaned
    )
  ) {
    return "";
  }
  return cleaned.split(/\s+/)[0];
}

function buildEmpatheticRescuePrompt(rawName, settingsOverride = null) {
  const settings = settingsOverride || getClinicSettings();
  const clinicName = settings.clinicName || "nossa clínica";
  const first = cleanPatientFirstName(rawName);
  const greetSuffix = first ? `, ${first}` : "";
  return `Oi${greetSuffix}! Tudo bem por aí? 😊\n\nPassei só para saber se ficou alguma dúvida ou se posso te ajudar com alguma informação aqui na ${clinicName}.\n\nFique super à vontade para me responder no seu tempo, sem nenhuma pressa!`;
}

// Intercepta e substitui automaticamente a mensagem robótica "Oi, nome-paciente! Para facilitar: Você busca..."
function upgradeRescueAndMechanicalPrompts(rawText, fallbackName = "") {
  const txt = String(rawText || "").trim();
  if (!txt) return txt;
  const settings = getClinicSettings();

  const rescueMatch = txt.match(
    /^(?:\s*(?:oi|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite)\s*,?\s*([^!.\n:?]{1,40})[!.,?]?\s*)?[\s\S]*?\bpara\s+facilitar\s*:\s*voc[eê]\s+busca[\s\S]*$/i
  );
  if (rescueMatch) {
    return buildEmpatheticRescuePrompt(rescueMatch[1] || fallbackName, settings);
  }

  if (/vagas\s+com\s+nosso\s+especialista\s+para\s+esta\s+semana\s+est[aã]o\s+quase\s+encerradas/i.test(txt)) {
    const greetMatch = txt.match(/^(?:oi|ol[aá])\s*,\s*([^,!?\n]+)/i);
    return buildEmpatheticRescuePrompt((greetMatch && greetMatch[1]) || fallbackName, settings);
  }

  return txt;
}

// Rastreia pedidos de confirmação de agendamento enviados pela clínica / mm-sender para NUNCA fechar a resposta como novo agendamento
const OUTBOUND_CONFIRMATION_REQUEST_REGEX =
  /(passando\s+(?:com\s+carinho\s+)?para\s+confirmar|confirmar\s+(?:o\s+)?seu\s+(?:agendamento|hor[aá]rio|atendimento|consulta)|confirma[cç][aã]o\s+d[eo]\s+(?:agendamento|hor[aá]rio|consulta)|confirma[cç][aã]o\s+anti-falta|lembrete\s+d[eo]\s+(?:agendamento|hor[aá]rio|consulta)|podemos\s+manter\s+(?:o|seu)\s+hor[aá]rio|responda\s*1\s*(?:\/\s*sim\s*)?para\s*confirmar)/i;

const OUTBOUND_NEW_BOOKING_OR_ALREADY_CONFIRMED_REGEX =
  /(j[aá]\s+bloqueei\s+esse\s+hor[aá]rio|j[aá]\s+reservei\s+esse\s+hor[aá]rio|presen[cç]a\s+(?:est[aá]\s+)?confirmada)/i;

function loadPendingConfirmationsMap() {
  ensureDataDir();
  try {
    if (fs.existsSync(PENDING_CONFIRMATIONS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(PENDING_CONFIRMATIONS_FILE, "utf-8"));
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (_e) {}
  return {};
}

function savePendingConfirmationsMap(mapObj) {
  ensureDataDir();
  try {
    fs.writeFileSync(PENDING_CONFIRMATIONS_FILE, JSON.stringify(mapObj, null, 2), "utf-8");
  } catch (_e) {}
}

function detectAndRegisterOutboundConfirmation(targetJid, textBody) {
  if (!targetJid || String(targetJid).endsWith("@g.us")) return false;
  const txt = String(textBody || "").trim();
  if (!txt) return false;
  if (OUTBOUND_NEW_BOOKING_OR_ALREADY_CONFIRMED_REGEX.test(txt)) return false;
  if (!OUTBOUND_CONFIRMATION_REQUEST_REGEX.test(txt)) return false;

  const key = normalizePhoneKeyShort(targetJid);
  if (!key) return false;

  const slotMatch = txt.match(/\(([^()]{4,60})\)/);
  const mapObj = loadPendingConfirmationsMap();
  mapObj[key] = {
    phone: key,
    targetJid: String(targetJid),
    awaitingConfirmation: true,
    slotHint: slotMatch && slotMatch[1] ? slotMatch[1].trim() : "",
    sentAtEpochMs: Date.now(),
    sentAtLabel: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
  };
  savePendingConfirmationsMap(mapObj);

  // Sincroniza também em agenda-serena-v2.json se existir, sem alterar bookedDate!
  try {
    const agPath = path.join(DATA_DIR, "agenda-serena-v2.json");
    if (fs.existsSync(agPath)) {
      const db = JSON.parse(fs.readFileSync(agPath, "utf-8"));
      if (db && db.leads && typeof db.leads === "object") {
        const matchLeadKey = Object.keys(db.leads).find(
          (lk) => normalizePhoneKeyShort(lk) === key
        );
        if (matchLeadKey && db.leads[matchLeadKey]) {
          db.leads[matchLeadKey].stage = "AGENDADO";
          db.leads[matchLeadKey].awaitingConfirmation = true;
          fs.writeFileSync(agPath, JSON.stringify(db, null, 2), "utf-8");
        }
      }
    }
  } catch (_eSync) {}

  return true;
}

function getPendingConfirmation(phoneOrJid) {
  const key = normalizePhoneKeyShort(phoneOrJid);
  if (!key) return null;
  const mapObj = loadPendingConfirmationsMap();
  const entry = mapObj[key];
  if (!entry || !entry.awaitingConfirmation) return null;
  // Expira após 7 dias
  if (entry.sentAtEpochMs && Date.now() - Number(entry.sentAtEpochMs) > 7 * 86_400_000) {
    delete mapObj[key];
    savePendingConfirmationsMap(mapObj);
    return null;
  }
  return entry;
}

function resolvePendingConfirmation(phoneOrJid, resolution = "confirmed") {
  const key = normalizePhoneKeyShort(phoneOrJid);
  if (!key) return false;
  const mapObj = loadPendingConfirmationsMap();
  if (!mapObj[key]) return false;
  mapObj[key] = {
    ...mapObj[key],
    awaitingConfirmation: false,
    resolution,
    resolvedAt: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
  };
  savePendingConfirmationsMap(mapObj);
  return true;
}

// 1. Spintax {Olá|Oi|Como vai} + Variação Anti-Hash Criptográfico Repetido
const GREETING_SPINTAX_DEFAULTS = ["Olá", "Oi", "Olá, tudo bem?", "Oi, como vai?"];

function resolveSpintax(rawText) {
  let out = upgradeRescueAndMechanicalPrompts(String(rawText || ""));
  const settings = getClinicSettings();
  if (settings.enableSpintax === false) return out;

  let guard = 0;
  const rx = /\{([^{}]+\|[^{}]+)\}/g;
  const hadExplicitSpintax = rx.test(out);
  rx.lastIndex = 0;

  while (rx.test(out) && guard < 12) {
    rx.lastIndex = 0;
    guard++;
    out = out.replace(rx, (_m, group) => {
      const opts = String(group).split("|").map((s) => s.trim());
      if (opts.length <= 1) return _m;
      return opts[Math.floor(Math.random() * opts.length)];
    });
  }

  // Se o operador esqueceu de usar Spintax no Disparo em Massa, varia saudação inicial sutilmente
  if (!hadExplicitSpintax && /^(ol[aá]|oi)\b/i.test(out.trim())) {
    const pick = GREETING_SPINTAX_DEFAULTS[Math.floor(Math.random() * GREETING_SPINTAX_DEFAULTS.length)];
    out = out.trim().replace(/^(ol[aá]|oi)[!,.]?/i, pick);
  }

  return out;
}

// 2. Limite máximo de 450 caracteres por mensagem (divide com naturalidade sem cortar palavras)
function splitMessageMax450(text) {
  const settings = getClinicSettings();
  const limit = Math.max(200, Number(settings.maxMessageChars) || 450);
  const clean = String(text || "").trim();
  if (clean.length <= limit) return [clean];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current ? current.length + 2 + para.length : para.length) <= limit) {
      current = current ? current + "\n\n" + para : para;
    } else {
      if (current) chunks.push(current.trim());
      if (para.length <= limit) {
        current = para;
      } else {
        const sentences = para.split(/(?<=[.!?])\s+/);
        current = "";
        for (const s of sentences) {
          if ((current ? current.length + 1 + s.length : s.length) <= limit) {
            current = current ? current + " " + s : s;
          } else {
            if (current) chunks.push(current.trim());
            current = s.slice(0, limit);
          }
        }
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [clean.slice(0, limit)];
}

// 3. Bloqueio de Links Externos antes de 2 respostas do lead (anti-phishing WhatsApp)
const EXTERNAL_URL_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+|maps\.app\.goo\.gl\/[^\s]+|bit\.ly\/[^\s]+)/gi;

function sanitizeLinksForLeadHistory(text, leadReplyCount = 0) {
  const settings = getClinicSettings();
  const minReplies = Number(settings.minLeadRepliesBeforeLinks ?? 2);
  if (settings.blockFirstMessageLinks === false || leadReplyCount >= minReplies) {
    return String(text || "");
  }
  return String(text || "")
    .replace(EXTERNAL_URL_REGEX, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// 4. Opt-Out Obrigatório [BLACKLIST]
const OPTOUT_REGEX = /\b(nao\s+quero|n[aã]o\s+quero|pare\b|parar\b|sair\b|nao\s+me\s+mande|n[aã]o\s+me\s+mande|me\s+bloqueia|remover\s+meu\s+numero|para\s+de\s+mandar)\b/i;

function loadBlacklist() {
  ensureDataDir();
  try {
    if (fs.existsSync(BLACKLIST_FILE)) {
      const list = JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf-8"));
      if (Array.isArray(list)) return list;
    }
  } catch (_e) {}
  return [];
}

function saveBlacklist(list) {
  ensureDataDir();
  try {
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(list, null, 2), "utf-8");
  } catch (_e) {}
}

function isPhoneBlacklisted(phoneOrJid) {
  const digits = normalizePhoneDigits(phoneOrJid);
  if (!digits) return false;
  const list = loadBlacklist();
  return list.some((entry) => normalizePhoneDigits(entry.phone) === digits);
}

function checkAndRegisterOptOut(phoneOrJid, incomingText) {
  const settings = getClinicSettings();
  if (settings.enableOptOutBlacklist === false) return false;
  const text = String(incomingText || "").trim();
  if (!OPTOUT_REGEX.test(text)) return false;

  const digits = normalizePhoneDigits(phoneOrJid);
  if (!digits) return true;
  const list = loadBlacklist();
  if (!list.some((item) => normalizePhoneDigits(item.phone) === digits)) {
    list.unshift({
      phone: digits,
      tag: "[BLACKLIST]",
      triggerPhrase: text.slice(0, 100),
      blockedAt: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
    });
    saveBlacklist(list);
  }
  return true;
}

// 5. Matriz de Transbordo Humano (3 Níveis — Nota: "cancelar" consulta NÃO é risco jurídico!)
const HANDOFF_HUMAN_REGEX = /\b(atendente|humano|moca|mo[cç]a|recepcao|recep[cç][aã]o|falar\s+com\s+algu[eé]m|secretaria)\b/i;
const HANDOFF_LEGAL_REGEX = /\b(processo|procon|advogad\w*|absurdo|reclamacao|reclama[cç][aã]o|denunciar|justi[cç]a)\b/i;
const HANDOFF_CLINICAL_REGEX = /\b(hemorragia|rosto\s+muito\s+inchado|pus\b|febre|acidente|desmai\w*)\b/i;

function classifyHandoffTrigger(incomingText, patientName = "") {
  const text = String(incomingText || "");
  const cleanFirst = patientName ? `, ${String(patientName).trim().split(" ")[0]}` : "";
  const replyScript = `Compreendo perfeitamente${cleanFirst}. Vou transferir nossa conversa agora mesmo para a nossa coordenadora de atendimento aqui da clínica. Ela assume o chat em instantes. Só um minuto!`;

  if (HANDOFF_CLINICAL_REGEX.test(text)) {
    return {
      triggered: true,
      tag: "[PRIORIDADE CLÍNICA MÁXIMA]",
      alertSound: true,
      notifyTarget: "Dentista / Recepção (Ligar Imediatamente)",
      replyScript,
    };
  }
  if (HANDOFF_LEGAL_REGEX.test(text)) {
    return {
      triggered: true,
      tag: "[RISCO JURÍDICO / GERÊNCIA]",
      alertSound: true,
      notifyTarget: "Gerência Imediatamente",
      replyScript,
    };
  }
  if (HANDOFF_HUMAN_REGEX.test(text)) {
    return {
      triggered: true,
      tag: "[ATENDIMENTO HUMANO]",
      alertSound: true,
      notifyTarget: "Recepcionista Humana",
      replyScript,
    };
  }
  return { triggered: false };
}

// 6. Rate Limiter Deslizante: Máx. 30 Mensagens Ativas / Hora (+ Proteção Warmup 21 Dias)
function loadHourlyMetrics() {
  ensureDataDir();
  try {
    if (fs.existsSync(METRICS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(METRICS_FILE, "utf-8"));
      if (parsed && Array.isArray(parsed.activeSendTimestamps)) return parsed;
    }
  } catch (_e) {}
  return { activeSendTimestamps: [], bulkCounterInBatch: 0 };
}

function saveHourlyMetrics(metrics) {
  ensureDataDir();
  try {
    fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2), "utf-8");
  } catch (_e) {}
}

async function waitForSafeActiveSendWindow(isBulkCampaign = true) {
  const settings = getClinicSettings();
  const maxPerHourRaw = Number(settings.maxActiveMessagesPerHour) || 30;
  const warmupDays = Number(settings.chipWarmupDays ?? 21);
  const hourlyCap = warmupDays < 21 ? Math.min(maxPerHourRaw, 12) : maxPerHourRaw;

  let metrics = loadHourlyMetrics();
  const oneHourAgo = Date.now() - 3_600_000;
  metrics.activeSendTimestamps = metrics.activeSendTimestamps.filter((ts) => ts > oneHourAgo);

  if (metrics.activeSendTimestamps.length >= hourlyCap) {
    const oldest = metrics.activeSendTimestamps[0];
    const waitMs = Math.max(5000, oldest + 3_600_000 - Date.now() + randomBetween(3000, 9000));
    console.log(`[ANTI-BAN] Teto de ${hourlyCap} mensagens ativas/hora atingido. Pausando ${Math.round(waitMs / 1000)}s para proteger o chip...`);
    await sleep(waitMs);
    metrics = loadHourlyMetrics();
    metrics.activeSendTimestamps = metrics.activeSendTimestamps.filter((ts) => ts > Date.now() - 3_600_000);
  }

  if (isBulkCampaign) {
    const batchSize = Math.max(5, Number(settings.bulkBatchSize) || 10);
    const batchPauseMs = Math.max(30, Number(settings.bulkBatchPauseSec) || 180) * 1000;
    metrics.bulkCounterInBatch = (Number(metrics.bulkCounterInBatch) || 0) + 1;

    if (metrics.bulkCounterInBatch > 1 && metrics.bulkCounterInBatch % batchSize === 0) {
      const jitterPause = batchPauseMs + randomBetween(5000, 25000);
      console.log(`[ANTI-BAN] Lote de ${batchSize} envios concluído. Pausa humana de ${Math.round(jitterPause / 1000)}s...`);
      await sleep(jitterPause);
    } else if (metrics.bulkCounterInBatch > 1) {
      const minInt = (Number(settings.bulkIntervalMinSec) || 15) * 1000;
      const maxInt = (Number(settings.bulkIntervalMaxSec) || 35) * 1000;
      await sleep(randomBetween(minInt, maxInt));
    }
  }

  metrics.activeSendTimestamps.push(Date.now());
  saveHourlyMetrics(metrics);
}

// 7. Simulação Universal de "Digitando..." (whatsapp-web.js, Baileys, wppconnect, venom)
async function simulateHumanReactionAndTyping(clientOrSock, targetJid, isReplyToIncoming = true) {
  const settings = getClinicSettings();
  if (isReplyToIncoming) {
    const reactMs = randomBetween(
      settings.reactionDelayMinMs || 3000,
      settings.reactionDelayMaxMs || 7000
    );
    await sleep(reactMs);
  }

  const typingMs = randomBetween(
    settings.typingStateMinMs || 2000,
    settings.typingStateMaxMs || 5000
  );

  try {
    if (clientOrSock) {
      // whatsapp-web.js
      if (typeof clientOrSock.getChatById === "function") {
        const chat = await clientOrSock.getChatById(targetJid).catch(() => null);
        if (chat) {
          wrapWwebChatPreventSeen(chat);
          if (typeof chat.sendStateTyping === "function") {
            await chat.sendStateTyping();
            await sleep(typingMs);
            if (typeof chat.clearState === "function") await chat.clearState().catch(() => {});
            return;
          }
        }
      }
      // Baileys
      if (typeof clientOrSock.sendPresenceUpdate === "function") {
        await clientOrSock.sendPresenceUpdate("composing", targetJid).catch(() => {});
        await sleep(typingMs);
        await clientOrSock.sendPresenceUpdate("paused", targetJid).catch(() => {});
        return;
      }
      // wppconnect / venom
      if (typeof clientOrSock.startTyping === "function") {
        await clientOrSock.startTyping(targetJid).catch(() => {});
        await sleep(typingMs);
        if (typeof clientOrSock.stopTyping === "function") {
          await clientOrSock.stopTyping(targetJid).catch(() => {});
        }
        return;
      }
    }
  } catch (_e) {}

  await sleep(typingMs);
}

// 7.5. Preservação de "Não Lida" para Mensagens Lidas pela Serena (Acompanhamento Humano no WhatsApp)
const serenaReadChatsMap = new Map();

function normalizeSerenaChatKey(phoneOrJid) {
  const digits = normalizePhoneDigits(phoneOrJid);
  return digits || String(phoneOrJid || "").trim().toLowerCase();
}

function is1to1PatientChat(targetJid) {
  const raw = String(targetJid || "").trim().toLowerCase();
  if (!raw) return false;
  if (raw.endsWith("@g.us") || raw.includes("broadcast") || raw === "status@broadcast") {
    return false;
  }
  return true;
}

function markChatReadBySerena(phoneOrJid, meta = null) {
  if (!is1to1PatientChat(phoneOrJid)) return;
  const key = normalizeSerenaChatKey(phoneOrJid);
  if (!key) return;
  const prev = serenaReadChatsMap.get(key) || {};
  serenaReadChatsMap.set(key, {
    chatId: String(phoneOrJid || prev.chatId || ""),
    readAt: Date.now(),
    lastMsgKey: (meta && meta.lastMsgKey) || prev.lastMsgKey || null,
    messageTimestamp:
      (meta && meta.messageTimestamp) ||
      prev.messageTimestamp ||
      Math.floor(Date.now() / 1000),
  });
  if (serenaReadChatsMap.size > 600) {
    const oldestKey = serenaReadChatsMap.keys().next().value;
    serenaReadChatsMap.delete(oldestKey);
  }
}

function getSerenaReadMeta(phoneOrJid) {
  const key = normalizeSerenaChatKey(phoneOrJid);
  if (!key) return null;
  const entry = serenaReadChatsMap.get(key);
  if (!entry) return null;
  if (Date.now() - entry.readAt > 20 * 60 * 1000) {
    serenaReadChatsMap.delete(key);
    return null;
  }
  return entry;
}

function wasChatRecentlyReadBySerena(phoneOrJid) {
  return Boolean(getSerenaReadMeta(phoneOrJid));
}

function wrapWwebChatPreventSeen(chatObj) {
  if (!chatObj || chatObj.isGroup || chatObj.__serenaSeenShielded) return chatObj;
  chatObj.__serenaSeenShielded = true;
  if (typeof chatObj.sendSeen === "function") {
    const origChatSendSeen = chatObj.sendSeen.bind(chatObj);
    chatObj.sendSeen = function (...args) {
      const settings = getClinicSettings();
      if (settings.serenaKeepUnreadForHuman !== false) {
        return Promise.resolve(false);
      }
      return origChatSendSeen(...args);
    };
  }
  return chatObj;
}

async function ensureSerenaChatUnread(clientOrSock, targetJid, options = {}) {
  const settings = getClinicSettings();
  if (settings.serenaKeepUnreadForHuman === false) return false;
  if (!clientOrSock || !is1to1PatientChat(targetJid)) return false;

  const applyUnreadOnce = async () => {
    try {
      // 1) whatsapp-web.js (chat.markUnread / client.markChatUnread)
      if (typeof clientOrSock.getChatById === "function") {
        const chat = await clientOrSock.getChatById(targetJid).catch(() => null);
        if (chat && !chat.isGroup) {
          wrapWwebChatPreventSeen(chat);
          if (typeof chat.markUnread === "function") {
            await chat.markUnread().catch(() => {});
            return true;
          }
        }
      }
      if (typeof clientOrSock.markChatUnread === "function") {
        await clientOrSock.markChatUnread(targetJid).catch(() => {});
        return true;
      }
      // 2) wppconnect / venom-bot
      if (typeof clientOrSock.markUnseenMessage === "function") {
        await clientOrSock.markUnseenMessage(targetJid).catch(() => {});
        return true;
      }
      // 3) Baileys (@whiskeysockets/baileys)
      if (typeof clientOrSock.chatModify === "function") {
        const meta = getSerenaReadMeta(targetJid);
        const msgKey = options.lastMsgKey || (meta && meta.lastMsgKey) || null;
        const msgTs =
          options.messageTimestamp ||
          (meta && meta.messageTimestamp) ||
          Math.floor(Date.now() / 1000);
        if (msgKey) {
          await clientOrSock
            .chatModify(
              { markRead: false, lastMessages: [{ key: msgKey, messageTimestamp: msgTs }] },
              targetJid
            )
            .catch(() => {});
          return true;
        }
      }
    } catch (_e) {}
    return false;
  };

  const appliedNow = await applyUnreadOnce();
  if (!options.skipDelayedConfirm) {
    const confirmTimer = setTimeout(() => {
      applyUnreadOnce().catch(() => {});
    }, 900);
    if (confirmTimer && typeof confirmTimer.unref === "function") {
      confirmTimer.unref();
    }
  }
  return appliedNow;
}

// 8. Envio Protegido Completo (para Disparo em Massa ou Resposta Individual)
async function sendProtectedWhatsAppMessage(clientOrSock, targetJid, rawMessage, options = {}) {
  const isGroup = String(targetJid || "").endsWith("@g.us");
  const isBulk = Boolean(options.isBulkCampaign);
  const leadReplyCount = Number(options.leadReplyCount ?? (isBulk ? 0 : 2));

  if (!isGroup && isPhoneBlacklisted(targetJid)) {
    console.log(`[ANTI-BAN][BLACKLIST] Envio bloqueado para ${targetJid} (Opt-Out registrado).`);
    return { skippedBlacklist: true };
  }

  if (!isGroup && !isBulk) {
    markChatReadBySerena(targetJid, options);
  }

  if (isBulk && !isGroup) {
    await waitForSafeActiveSendWindow(true);
  }

  const upgradedInput = !isGroup ? upgradeRescueAndMechanicalPrompts(rawMessage) : rawMessage;
  if (!isGroup) {
    detectAndRegisterOutboundConfirmation(targetJid, upgradedInput);
  }
  const spintaxApplied = resolveSpintax(upgradedInput);
  const linkChecked = isGroup ? spintaxApplied : sanitizeLinksForLeadHistory(spintaxApplied, leadReplyCount);
  const bubbles = splitMessageMax450(linkChecked);

  const settings = getClinicSettings();
  const keepUnread1to1 = !isGroup && settings.serenaKeepUnreadForHuman !== false;
  let rawSend = options.rawSendFn;
  if (!rawSend && clientOrSock) {
    rawSend = clientOrSock.__serenaOrigSendMessage
      ? clientOrSock.__serenaOrigSendMessage.bind(clientOrSock)
      : typeof clientOrSock.sendMessage === "function"
      ? clientOrSock.sendMessage.bind(clientOrSock)
      : null;
  }

  const results = [];
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      await sleep(
        randomBetween(
          settings.betweenBubblesMinMs || 4000,
          settings.betweenBubblesMaxMs || 8000
        )
      );
    }
    await simulateHumanReactionAndTyping(clientOrSock, targetJid, i === 0 && !isBulk);
    if (rawSend) {
      // Compatibilidade Baileys ({ text }) vs whatsapp-web.js (string + sendSeen: false inclusive em grupos @g.us para evitar erro markedUnread!)
      const isBaileys = Boolean(clientOrSock?.ev) || (typeof clientOrSock?.sendPresenceUpdate === "function" && !clientOrSock?.getChatById);
      const isGroupTarget = String(targetJid || "").endsWith("@g.us");
      const payload = isBaileys && typeof bubbles[i] === "string" ? { text: bubbles[i] } : bubbles[i];
      let sent = null;
      if (!isBaileys && (keepUnread1to1 || isGroupTarget)) {
        try {
          sent = await rawSend(targetJid, payload, { sendSeen: false });
        } catch (_sendOptErr) {
          sent = await rawSend(targetJid, payload);
        }
      } else {
        sent = await rawSend(targetJid, payload);
      }
      results.push(sent);
    }
  }

  if (keepUnread1to1 && (!isBulk || wasChatRecentlyReadBySerena(targetJid))) {
    await ensureSerenaChatUnread(clientOrSock, targetJid, options);
  }

  return { ok: true, bubblesSent: bubbles.length, keptUnread: keepUnread1to1 && !isBulk, results };
}

// 9. Hook Automático sobre client.sendMessage + Escudo "Manter Não Lida" nas conversas da Serena
function installBulkAntiBanHook(clientOrSock) {
  if (!clientOrSock || clientOrSock.__serenaAntiBanInstalled) return clientOrSock;
  if (typeof clientOrSock.sendMessage !== "function") return clientOrSock;

  const origSend = clientOrSock.sendMessage.bind(clientOrSock);
  clientOrSock.__serenaOrigSendMessage = origSend;
  clientOrSock.__serenaAntiBanInstalled = true;

  // Bloqueia client.sendSeen automático em conversas 1:1 quando serenaKeepUnreadForHuman está ativo e em grupos @g.us (evita crash markedUnread)
  if (typeof clientOrSock.sendSeen === "function") {
    const origClientSendSeen = clientOrSock.sendSeen.bind(clientOrSock);
    clientOrSock.sendSeen = function (chatId, ...args) {
      const settings = getClinicSettings();
      if (String(chatId || "").endsWith("@g.us")) {
        return Promise.resolve(false);
      }
      if (settings.serenaKeepUnreadForHuman !== false && is1to1PatientChat(chatId)) {
        return Promise.resolve(false);
      }
      return origClientSendSeen(chatId, ...args);
    };
  }

  // Envolve getChatById para impedir chat.sendSeen() em conversas 1:1 da Serena
  if (typeof clientOrSock.getChatById === "function") {
    const origGetChatById = clientOrSock.getChatById.bind(clientOrSock);
    clientOrSock.getChatById = async function (chatId, ...args) {
      const chat = await origGetChatById(chatId, ...args);
      if (chat && !chat.isGroup) {
        wrapWwebChatPreventSeen(chat);
      }
      return chat;
    };
  }

  // Bloqueia sock.readMessages automático em conversas 1:1 no Baileys
  if (typeof clientOrSock.readMessages === "function") {
    const origReadMessages = clientOrSock.readMessages.bind(clientOrSock);
    clientOrSock.readMessages = function (keys, ...args) {
      const settings = getClinicSettings();
      if (settings.serenaKeepUnreadForHuman !== false && Array.isArray(keys)) {
        const allowedKeys = keys.filter((k) => !is1to1PatientChat(k && k.remoteJid));
        if (allowedKeys.length === 0) return Promise.resolve();
        return origReadMessages(allowedKeys, ...args);
      }
      return origReadMessages(keys, ...args);
    };
  }

  let sendQueue = Promise.resolve();

  clientOrSock.sendMessage = function (targetJid, content, ...rest) {
    const isGroup = String(targetJid || "").endsWith("@g.us");
    const textBody =
      typeof content === "string"
        ? content
        : content && typeof content.text === "string"
        ? content.text
        : null;

    if (textBody === null) {
      const settingsNow = getClinicSettings();
      const isBaileysMedia = Boolean(clientOrSock?.ev) || (typeof clientOrSock?.sendPresenceUpdate === "function" && !clientOrSock?.getChatById);
      if (!isBaileysMedia && (isGroup || settingsNow.serenaKeepUnreadForHuman !== false)) {
        const nextRest =
          rest.length === 0
            ? [{ sendSeen: false }]
            : rest[0] && typeof rest[0] === "object" && !Array.isArray(rest[0])
            ? [{ ...rest[0], sendSeen: false }, ...rest.slice(1)]
            : rest;
        return origSend(targetJid, content, ...nextRest);
      }
      return origSend(targetJid, content, ...rest);
    }

    if (!isGroup && isPhoneBlacklisted(targetJid)) {
      console.log(`[ANTI-BAN][BLACKLIST] Número ${targetJid} ignorado automaticamente no envio.`);
      return Promise.resolve(null);
    }

    const runTask = async () => {
      const settings = getClinicSettings();
      const keepUnread1to1 = !isGroup && settings.serenaKeepUnreadForHuman !== false;
      const isReplyToSerenaRead = keepUnread1to1 && wasChatRecentlyReadBySerena(targetJid);
      const isBaileys = Boolean(clientOrSock?.ev) || (typeof clientOrSock?.sendPresenceUpdate === "function" && !clientOrSock?.getChatById);
      const upgradedBody = !isGroup ? upgradeRescueAndMechanicalPrompts(textBody) : textBody;
      if (!isGroup) {
        detectAndRegisterOutboundConfirmation(targetJid, upgradedBody);
      }
      const processedText = resolveSpintax(upgradedBody);
      const chunks = splitMessageMax450(processedText);
      let lastRes = null;

      // Em whatsapp-web.js, passa { sendSeen: false } tanto em 1:1 (manter não lida) quanto em grupos @g.us (evita TypeError: markedUnread em WWebJS.sendSeen!)
      const shouldPassNoSeen = !isBaileys && (keepUnread1to1 || isGroup);
      const sendRest = shouldPassNoSeen
        ? rest.length === 0
          ? [{ sendSeen: false }]
          : rest[0] && typeof rest[0] === "object" && !Array.isArray(rest[0])
          ? [{ ...rest[0], sendSeen: false }, ...rest.slice(1)]
          : rest
        : rest;

      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
          await sleep(randomBetween(settings.betweenBubblesMinMs || 4000, settings.betweenBubblesMaxMs || 8000));
        } else {
          await simulateHumanReactionAndTyping(clientOrSock, targetJid, true);
        }
        const chunkPayload = typeof content === "string" ? chunks[i] : { ...content, text: chunks[i] };
        try {
          lastRes = await origSend(targetJid, chunkPayload, ...sendRest);
        } catch (_optErr) {
          lastRes = await origSend(targetJid, chunkPayload, ...rest);
        }
      }

      if (isReplyToSerenaRead) {
        await ensureSerenaChatUnread(clientOrSock, targetJid);
      }

      return lastRes;
    };

    const next = sendQueue.then(runTask, runTask);
    sendQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  // Monitora entradas e saídas 1:1 (Opt-Out + Confirmação de Agendamento + Preservação de Não Lida)
  if (typeof clientOrSock.on === "function") {
    clientOrSock.on("message", (msg) => {
      try {
        if (msg && !msg.fromMe && msg.from && is1to1PatientChat(msg.from)) {
          markChatReadBySerena(msg.from, { messageTimestamp: msg.timestamp });
          if (typeof msg.getChat === "function" && !msg.__serenaGetChatWrapped) {
            msg.__serenaGetChatWrapped = true;
            const origMsgGetChat = msg.getChat.bind(msg);
            msg.getChat = async function (...args) {
              const chatObj = await origMsgGetChat(...args);
              return wrapWwebChatPreventSeen(chatObj);
            };
          }
          if (msg.body && checkAndRegisterOptOut(msg.from, msg.body)) {
            console.log(`[OPT-OUT][BLACKLIST] Número ${msg.from} adicionado à BLACKLIST automaticamente.`);
          }
        }
      } catch (_e) {}
    });

    clientOrSock.on("message_create", (msg) => {
      try {
        if (msg && msg.fromMe && msg.to && is1to1PatientChat(msg.to) && msg.body) {
          detectAndRegisterOutboundConfirmation(msg.to, msg.body);
        }
      } catch (_eCreate) {}
    });
  }

  if (clientOrSock.ev && typeof clientOrSock.ev.on === "function") {
    clientOrSock.ev.on("messages.upsert", (upsert) => {
      try {
        const list = (upsert && upsert.messages) || [];
        for (const m of list) {
          const remoteJid = String(m?.key?.remoteJid || "");
          if (!is1to1PatientChat(remoteJid)) continue;
          if (!m?.key?.fromMe) {
            markChatReadBySerena(remoteJid, {
              lastMsgKey: m.key,
              messageTimestamp: m.messageTimestamp,
            });
          } else {
            const outTxt = String(
              m?.message?.conversation ||
                m?.message?.extendedTextMessage?.text ||
                ""
            ).trim();
            if (outTxt) {
              detectAndRegisterOutboundConfirmation(remoteJid, outTxt);
            }
          }
        }
      } catch (_e) {}
    });
  }

  return clientOrSock;
}

module.exports = {
  resolveSpintax,
  buildEmpatheticRescuePrompt,
  upgradeRescueAndMechanicalPrompts,
  detectAndRegisterOutboundConfirmation,
  getPendingConfirmation,
  resolvePendingConfirmation,
  splitMessageMax450,
  sanitizeLinksForLeadHistory,
  isPhoneBlacklisted,
  checkAndRegisterOptOut,
  classifyHandoffTrigger,
  waitForSafeActiveSendWindow,
  simulateHumanReactionAndTyping,
  markChatReadBySerena,
  wasChatRecentlyReadBySerena,
  ensureSerenaChatUnread,
  sendProtectedWhatsAppMessage,
  installBulkAntiBanHook,
};

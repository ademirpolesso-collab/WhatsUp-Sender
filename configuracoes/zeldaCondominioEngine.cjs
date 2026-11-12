// configuracoes/zeldaCondominioEngine.cjs
// Corrige o status na aba Zelda (Condomínio): reflete conexão real do WhatsApp (nunca "Ativa" sem WhatsApp conectado!)
// Separa "Grupo Configurado" (via parâmetro) + Gerencia Atividades/Pendências na Aplicação e pelo Grupo de WhatsApp

process.env.TZ = "America/Sao_Paulo";

const fs = require("fs");
const path = require("path");
const { resolveWritableDataDir, getClinicSettings } = require("./configManager.cjs");
const { simulateHumanReactionAndTyping } = require("./antiBanEngine.cjs");

const ZELDA_LOOP_MARKER = "\u200B";
const recentSentRepliesMap = new Map();

function normalizeEchoFingerprint(txt) {
  return String(txt || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220)
    .toLowerCase();
}

function registerZeldaSentReply(text) {
  const fp = normalizeEchoFingerprint(text);
  if (!fp) return;
  const now = Date.now();
  recentSentRepliesMap.set(fp, now);
  for (const [k, ts] of recentSentRepliesMap.entries()) {
    if (now - ts > 60000) recentSentRepliesMap.delete(k);
  }
}

function isZeldaOwnFormattedReply(text) {
  const clean = String(text || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .trim();
  if (!clean) return false;
  return (
    /^(?:📋\s*\*(?:INICIATIVAS DO CONDOM[IÍ]NIO|Comandos Interativos da Zelda)|🏢\s*\*(?:Iniciativas do Condom[ií]nio|Lista de Iniciativas)|📌\s*\*Iniciativa #|🗳️\s*(?:Voto|Vota[cç][aã]o|Iniciativa)|❎\s*Opera[cç][aã]o cancelada|✅\s*(?:Iniciativa|Zelda ativa)|🆕\s*\*Inclus[aã]o Guiada|✏️\s*\*#|⚠️\s*(?:N[aã]o reconheci|A iniciativa|O campo|Informe)|🚫\s*(?:\*Voto bloqueado|O Zelador)|⚖️\s*\*Encerramento de Vota[cç][aã]o)/.test(
      clean
    )
  );
}

function isZeldaSelfEcho(text, isFromMe = false) {
  const raw = String(text || "");
  if (raw.includes(ZELDA_LOOP_MARKER)) return true;
  if (!isFromMe) return false;
  if (isZeldaOwnFormattedReply(raw)) return true;
  const fp = normalizeEchoFingerprint(raw);
  if (!fp) return false;
  const sentAt = recentSentRepliesMap.get(fp);
  if (sentAt && Date.now() - sentAt <= 60000) return true;
  return false;
}

function pickExistingSortedByMtime(paths) {
  const valid = [];
  const seen = new Set();
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        valid.push({ file: p, mtimeMs: Number(st.mtimeMs || 0) });
      }
    } catch (_e) {}
  }
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return valid.map((v) => v.file);
}

function getDataFiles() {
  const rootWritable = resolveWritableDataDir();
  const base = path.join(rootWritable, "dados");
  if (!fs.existsSync(base)) {
    try { fs.mkdirSync(base, { recursive: true }); } catch (_e) {}
  }
  const appDataBase = process.env.APPDATA
    ? path.join(process.env.APPDATA, "mm-sender", "dados")
    : null;
  if (appDataBase && !fs.existsSync(appDataBase)) {
    try { fs.mkdirSync(appDataBase, { recursive: true }); } catch (_e) {}
  }
  const localAppDataBase = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "mm-sender", "dados")
    : null;
  const resAppDir = path.join(rootWritable, "resources", "app");
  const resAppBase = fs.existsSync(resAppDir) ? path.join(resAppDir, "dados") : null;
  const cwdIsProject = fs.existsSync(path.join(process.cwd(), "configuracoes", "configManager.cjs"));
  const cwdBase = cwdIsProject ? path.resolve(process.cwd(), "dados") : null;

  const makeCandidates = (fname) =>
    [
      path.join(base, fname),
      appDataBase ? path.join(appDataBase, fname) : null,
      resAppBase ? path.join(resAppBase, fname) : null,
      localAppDataBase ? path.join(localAppDataBase, fname) : null,
      cwdBase ? path.join(cwdBase, fname) : null,
    ].filter(Boolean);

  return {
    activitiesPrimary: path.join(base, "zelda-condominio-atividades.json"),
    activitiesAppData: appDataBase ? path.join(appDataBase, "zelda-condominio-atividades.json") : null,
    activitiesResApp: resAppBase ? path.join(resAppBase, "zelda-condominio-atividades.json") : null,
    activitiesAll: makeCandidates("zelda-condominio-atividades.json"),
    connPrimary: path.join(base, "whatsapp-connection-status.json"),
    connAppData: appDataBase ? path.join(appDataBase, "whatsapp-connection-status.json") : null,
    connResApp: resAppBase ? path.join(resAppBase, "whatsapp-connection-status.json") : null,
    connAll: makeCandidates("whatsapp-connection-status.json"),
    outboxPrimary: path.join(base, "zelda-outbox-queue.json"),
    outboxAppData: appDataBase ? path.join(appDataBase, "zelda-outbox-queue.json") : null,
    outboxResApp: resAppBase ? path.join(resAppBase, "zelda-outbox-queue.json") : null,
    outboxAll: makeCandidates("zelda-outbox-queue.json"),
    debugPrimary: path.join(base, "zelda-group-debug.json"),
    debugAppData: appDataBase ? path.join(appDataBase, "zelda-group-debug.json") : null,
    debugResApp: resAppBase ? path.join(resAppBase, "zelda-group-debug.json") : null,
    debugAll: makeCandidates("zelda-group-debug.json"),
    groupsPrimary: path.join(base, "zelda-discovered-groups.json"),
    groupsAppData: appDataBase ? path.join(appDataBase, "zelda-discovered-groups.json") : null,
    groupsResApp: resAppBase ? path.join(resAppBase, "zelda-discovered-groups.json") : null,
    groupsAll: makeCandidates("zelda-discovered-groups.json"),
  };
}

function nowBrasiliaLabel() {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function getDiscoveredGroups() {
  const files = getDataFiles();
  for (const f of pickExistingSortedByMtime(files.groupsAll)) {
    try {
      const arr = JSON.parse(fs.readFileSync(f, "utf-8"));
      if (Array.isArray(arr)) return arr;
    } catch (_e) {}
  }
  return [];
}

function recordDiscoveredGroup(jid, name) {
  const cleanJid = String(jid || "").trim();
  const cleanName = String(name || "").trim();
  if ((!cleanJid.endsWith("@g.us") && !cleanJid.startsWith("dom_grp:")) || !cleanName) return;
  const list = getDiscoveredGroups();
  const existingIdx = list.findIndex((g) => g && (g.jid === cleanJid || g.name === cleanName));
  const stamp = nowBrasiliaLabel();
  if (existingIdx >= 0) {
    if (list[existingIdx].name === cleanName && list[existingIdx].jid === cleanJid) return;
    list[existingIdx] = { jid: cleanJid, name: cleanName, lastSeenAt: stamp };
  } else {
    list.unshift({ jid: cleanJid, name: cleanName, lastSeenAt: stamp });
  }
  const trimmed = list.slice(0, 60);
  const files = getDataFiles();
  writeJsonTargets([files.groupsPrimary, files.groupsAppData, files.groupsResApp], trimmed);
}

function getZeldaGroupDebugLog() {
  const files = getDataFiles();
  for (const f of pickExistingSortedByMtime(files.debugAll)) {
    try {
      const arr = JSON.parse(fs.readFileSync(f, "utf-8"));
      if (Array.isArray(arr)) return arr;
    } catch (_e) {}
  }
  return [];
}

function recordZeldaGroupDebug(entry) {
  try {
    const list = getZeldaGroupDebugLog();
    const nowEpoch = Date.now();
    const record = {
      id: entry?.id ? String(entry.id) : `zdbg_${nowEpoch}_${Math.floor(Math.random() * 1000)}`,
      epochMs: nowEpoch,
      timestamp: nowBrasiliaLabel(),
      chatId: String(entry?.chatId || ""),
      groupName: String(entry?.groupName || ""),
      configuredGroup: String(entry?.configuredGroup || ""),
      senderName: entry?.senderName ? String(entry.senderName).slice(0, 80) : "",
      senderPhone: entry?.senderPhone ? String(entry.senderPhone).slice(0, 40) : "",
      fromMe: Boolean(entry?.fromMe),
      matched: Boolean(entry?.matched),
      reason: String(entry?.reason || ""),
      preview: String(entry?.preview || "").slice(0, 300),
      replyPreview: entry?.replyPreview ? String(entry.replyPreview).slice(0, 500) : "",
      handled: Boolean(entry?.handled),
      replied: Boolean(entry?.replied),
      error: entry?.error ? String(entry.error).slice(0, 220) : "",
    };
    list.unshift(record);
    const trimmed = list.slice(0, 50);
    const files = getDataFiles();
    writeJsonTargets([files.debugPrimary, files.debugAppData, files.debugResApp], trimmed);
    return record;
  } catch (_e) {
    return null;
  }
}

function writeJsonTargets(targets, data) {
  const raw = JSON.stringify(data, null, 2);
  const seen = new Set();
  for (const dest of targets) {
    if (!dest || seen.has(dest)) continue;
    seen.add(dest);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, raw, "utf-8");
    } catch (_e) {}
  }
}

// 1. STATUS REAL DE CONEXÃO DO WHATSAPP (Sem falso "Offline" quando conectado e sem piscar disco!)
let runtimeConnected = false;
let runtimeState = "disconnected";
let runtimePhone = "";
let lastPersistedConnected = null;
let lastPersistedState = "";
let lastPersistedDiskMs = 0;
let heartbeatTimer = null;
let outboxTimer = null;
let activeClientRef = null;

function persistConnectionStatus(connected, connectionState = "disconnected", connectedPhone = "", forceDisk = false) {
  runtimeConnected = Boolean(connected);
  runtimeState = runtimeConnected ? "connected" : connectionState || "disconnected";
  runtimePhone = connectedPhone || (runtimeConnected ? runtimePhone : "");
  const nowMs = Date.now();
  const stamp = nowBrasiliaLabel();
  const payload = {
    connected: runtimeConnected,
    connectionState: runtimeState,
    statusLabel: runtimeConnected
      ? "Conectada (WhatsApp Online)"
      : runtimeState === "connecting"
      ? "Conectando ao WhatsApp..."
      : "Desconectada (WhatsApp Offline)",
    phone: runtimePhone,
    connectedPhone: runtimePhone,
    heartbeatEpochMs: nowMs,
    updatedAt: stamp,
    lastUpdatedAt: stamp,
  };

  const stateChanged =
    lastPersistedConnected !== runtimeConnected || lastPersistedState !== runtimeState;
  if (forceDisk || stateChanged || nowMs - lastPersistedDiskMs >= 42000) {
    lastPersistedConnected = runtimeConnected;
    lastPersistedState = runtimeState;
    lastPersistedDiskMs = nowMs;
    const files = getDataFiles();
    writeJsonTargets([files.connPrimary, files.connAppData, files.connResApp], payload);
  }
  return payload;
}

function initConnectionStatusIfMissing() {
  const files = getDataFiles();
  const candidates = pickExistingSortedByMtime(files.connAll);
  for (const f of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
      const ageMs = Date.now() - Number(parsed.heartbeatEpochMs || 0);
      if (parsed && parsed.connected && ageMs >= 0 && ageMs <= 180000) {
        runtimeConnected = true;
        runtimeState = "connected";
        runtimePhone = String(parsed.connectedPhone || parsed.phone || "");
        lastPersistedConnected = true;
        lastPersistedState = "connected";
        lastPersistedDiskMs = Number(parsed.heartbeatEpochMs || Date.now());
        return;
      }
      return;
    } catch (_e) {}
  }
  persistConnectionStatus(false, "disconnected", "", true);
}

// Sempre que a Serena ou a Zelda recebe mensagem real no WhatsApp, garante status Online imediatamente!
function markWhatsAppActivityOnline(phoneHint = "") {
  const cleanHint = String(phoneHint || "").split("@")[0].trim();
  const resolvedPhone = runtimePhone || cleanHint || "";
  if (!runtimeConnected || Date.now() - lastPersistedDiskMs >= 30000) {
    return persistConnectionStatus(true, "connected", resolvedPhone, !runtimeConnected);
  }
  runtimeConnected = true;
  runtimeState = "connected";
  return {
    connected: true,
    connectionState: "connected",
    statusLabel: "Conectada (WhatsApp Online)",
    phone: resolvedPhone,
    connectedPhone: resolvedPhone,
    heartbeatEpochMs: Date.now(),
    updatedAt: nowBrasiliaLabel(),
    lastUpdatedAt: nowBrasiliaLabel(),
  };
}

function getWhatsAppConnectionStatus() {
  if (runtimeConnected) {
    const stamp = nowBrasiliaLabel();
    return {
      connected: true,
      connectionState: "connected",
      statusLabel: "Conectada (WhatsApp Online)",
      phone: runtimePhone || "",
      connectedPhone: runtimePhone || "",
      updatedAt: stamp,
      lastUpdatedAt: stamp,
    };
  }
  const files = getDataFiles();
  const candidates = pickExistingSortedByMtime(files.connAll);
  for (const f of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
      const ageMs = Date.now() - Number(parsed.heartbeatEpochMs || 0);
      const ph = String(parsed.connectedPhone || parsed.phone || "");
      const upd = String(parsed.updatedAt || parsed.lastUpdatedAt || "");
      // Janela segura de 180s (3 min) para evitar falso "Offline" entre heartbeats
      if (parsed.connected && ageMs >= 0 && ageMs <= 180000) {
        return {
          connected: true,
          connectionState: "connected",
          statusLabel: "Conectada (WhatsApp Online)",
          phone: ph,
          connectedPhone: ph,
          updatedAt: upd,
          lastUpdatedAt: upd,
        };
      }
      const isConnecting = parsed.connectionState === "connecting" && ageMs >= 0 && ageMs <= 60000;
      return {
        connected: false,
        connectionState: isConnecting ? "connecting" : "disconnected",
        statusLabel: isConnecting
          ? "Conectando ao WhatsApp..."
          : "Desconectada (WhatsApp Offline)",
        phone: "",
        connectedPhone: "",
        updatedAt: upd,
        lastUpdatedAt: upd,
      };
    } catch (_e) {}
  }
  const fallbackStamp = nowBrasiliaLabel();
  return {
    connected: false,
    connectionState: "disconnected",
    statusLabel: "Desconectada (WhatsApp Offline)",
    phone: "",
    connectedPhone: "",
    updatedAt: fallbackStamp,
    lastUpdatedAt: fallbackStamp,
  };
}

// 2. GESTÃO DE ATIVIDADES E PENDÊNCIAS DO CONDOMÍNIO
function loadZeldaActivities() {
  const files = getDataFiles();
  const candidates = pickExistingSortedByMtime(files.activitiesAll);
  for (const f of candidates) {
    try {
      const list = JSON.parse(fs.readFileSync(f, "utf-8"));
      if (Array.isArray(list)) return list;
    } catch (_e) {}
  }
  return [];
}

function saveZeldaActivities(list) {
  const existing = loadZeldaActivities();
  const prevById = new Map();
  for (const prev of existing) {
    if (prev && prev.id) prevById.set(String(prev.id), prev);
  }
  const nowTs = Date.now();
  const safeList = (Array.isArray(list) ? list : []).map((item) => {
    if (!item || typeof item !== "object") return item;
    const prev = item.id ? prevById.get(String(item.id)) : null;
    let ts =
      typeof item.updatedAtEpochMs === "number" && Number.isFinite(item.updatedAtEpochMs)
        ? item.updatedAtEpochMs
        : 0;
    if (prev && prev.updatedAt !== item.updatedAt && (!ts || ts <= (prev.updatedAtEpochMs || 0))) {
      ts = nowTs;
    } else if (!ts) {
      ts = prev && typeof prev.updatedAtEpochMs === "number" ? prev.updatedAtEpochMs : nowTs;
    }
    return Object.assign({}, item, { updatedAtEpochMs: ts });
  });
  const files = getDataFiles();
  writeJsonTargets([files.activitiesPrimary, files.activitiesAppData, files.activitiesResApp], safeList);
  return safeList;
}

function nextActivityCode(list) {
  let max = 0;
  for (const item of list) {
    const c = Number(item.code) || 0;
    if (c > max) max = c;
  }
  return max + 1;
}

function normalizeTextToken(raw) {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function buildBrPhoneMatchKeys(rawPhone) {
  const keys = new Set();
  const base = String(rawPhone || "").split("@")[0].split(":")[0];
  let digits = base.replace(/\D+/g, "");
  if (!digits || digits.length < 8) return keys;
  keys.add(digits);
  if (digits.startsWith("55") && digits.length >= 12) {
    digits = digits.slice(2);
    keys.add(digits);
  }
  keys.add("55" + digits);
  if (digits.length === 11 && digits[2] === "9") {
    const withoutNine = digits.slice(0, 2) + digits.slice(3);
    keys.add(withoutNine);
    keys.add("55" + withoutNine);
  } else if (digits.length === 10) {
    const withNine = digits.slice(0, 2) + "9" + digits.slice(2);
    keys.add(withNine);
    keys.add("55" + withNine);
  }
  if (digits.length >= 8) {
    keys.add("last8:" + digits.slice(-8));
  }
  return keys;
}

function isCaretakerPhoneBlocked(senderPhone, configuredCaretakerRaw) {
  const rawCfg = String(configuredCaretakerRaw || "").trim();
  if (!rawCfg || !senderPhone) return false;
  const senderKeys = buildBrPhoneMatchKeys(senderPhone);
  if (senderKeys.size === 0) return false;
  const parts = rawCfg.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const cfgKeys = buildBrPhoneMatchKeys(part);
    for (const k of cfgKeys) {
      if (k.startsWith("last8:")) continue;
      if (senderKeys.has(k)) return true;
    }
    const cfgDigits = part.replace(/\D+/g, "");
    const sndDigits = String(senderPhone).split("@")[0].replace(/\D+/g, "");
    if (cfgDigits.length === 8 && sndDigits.endsWith(cfgDigits)) return true;
  }
  return false;
}

const BLANK_TOKENS = new Set([
  "-",
  "--",
  "—",
  "branco",
  "em branco",
  "deixar em branco",
  "sem",
  "sem informacao",
  "sem dado",
  "sem dados",
  "nao informado",
  "nao informada",
  "a definir",
  "pular",
  "vazio",
  "vazia",
  "nenhum",
  "nenhuma",
  "n/a",
  "na",
  "null",
]);

const OPTIONAL_NOTE_NEGATIVE_TOKENS = new Set([
  "nao",
  "n",
  "nada",
  "nao precisa",
  "nao quero",
  "sem obs",
  "sem observacao",
  "sem observacoes",
  "sem comentario",
  "sem comentarios",
  "sem nota",
  "sem detalhe",
  "sem detalhes",
]);

const OPTIONAL_NOTE_AFFIRMATIVE_ONLY_TOKENS = new Set([
  "sim",
  "s",
  "quero",
  "claro",
  "pode",
  "gostaria",
  "incluir",
  "adicionar",
]);

const CHAT_NOISE_EXACT = new Set([
  "oi",
  "ola",
  "opa",
  "bom dia",
  "boa tarde",
  "boa noite",
  "sim",
  "s",
  "nao",
  "n",
  "ok",
  "okay",
  "blz",
  "beleza",
  "certo",
  "obrigado",
  "obrigada",
  "valeu",
  "show",
  "top",
  "perfeito",
  "confirmo",
  "confirmar",
  "talvez",
  "nao sei",
  "sei la",
  "ajuda",
  "menu",
  "comandos",
  "status",
  "lista",
  "todas",
  "votar",
  "aprovar",
  "reprovar",
  "concluir",
  "excluir",
  "cancelar",
  "zelda",
  "kk",
  "kkk",
  "kkkk",
  "haha",
  "hahaha",
  "rs",
  "rsrs",
]);

function collapseCleanText(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsUrl(text) {
  return /(?:https?:\/\/|www\.)\S+/i.test(text);
}

function looksLikeDateOnly(text) {
  const t = String(text || "").trim();
  return (
    /^\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?$/.test(t) ||
    /^\d{4}-\d{1,2}-\d{1,2}$/.test(t)
  );
}

function looksLikeZeldaCommandAttempt(text) {
  return /^[/*_~@!\s]*zelda(?:\b|[\s,.:;!?*_~-])/i.test(String(text || "").trim());
}

function isBlankFieldToken(raw, extraTokens) {
  const cleaned = collapseCleanText(raw);
  if (!cleaned) return true;
  const norm = normalizeTextToken(cleaned);
  if (BLANK_TOKENS.has(norm)) return true;
  if (Array.isArray(extraTokens) && extraTokens.includes(norm)) return true;
  return false;
}

function parseStrictYesNo(raw) {
  const cleaned = collapseCleanText(raw);
  if (!cleaned || BLANK_TOKENS.has(normalizeTextToken(cleaned))) {
    return "blank";
  }
  const norm = normalizeTextToken(cleaned).replace(/[.!?,;:]+$/g, "").trim();
  if (/^(nao|n|2|negativo|errado|errada|outra|outro|incorreto|incorreta|nao confirmo|nao quero)$/.test(norm)) {
    return "no";
  }
  if (/^(sim|s|1|confirmo|confirmar|confirmado|correto|correta|isso|isso mesmo|exato|ok|positivo)$/.test(norm)) {
    return "yes";
  }
  return "invalid";
}

function parseStrictInitiativeCode(raw) {
  const cleaned = collapseCleanText(raw);
  if (!cleaned) return null;
  const norm = normalizeTextToken(cleaned);
  const m = norm.match(/^(?:iniciativa\s+|item\s+|n\s+|no\s+|numero\s+)?#?(\d{1,5})$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
}

function extractInlineCommandTargetCode(afterActionText) {
  const cleaned = collapseCleanText(afterActionText);
  if (!cleaned) {
    return { code: null, hasInvalidTrailingArg: false, rawArg: "" };
  }
  const norm = normalizeTextToken(cleaned)
    .replace(/^(?:da\s+|do\s+|na\s+|no\s+|em\s+|para\s+|a\s+|o\s+)?(?:iniciativa|atividade|pendencia|item|tarefa)?\s*/, "")
    .trim();
  if (!norm) {
    return { code: null, hasInvalidTrailingArg: false, rawArg: "" };
  }
  const exactNum = norm.match(/^#?(\d{1,5})$/);
  if (exactNum) {
    const code = Number(exactNum[1]);
    if (Number.isInteger(code) && code > 0) {
      return { code, hasInvalidTrailingArg: false, rawArg: norm };
    }
  }
  return { code: null, hasInvalidTrailingArg: true, rawArg: cleaned };
}

function isRealCalendarDate(day, month, year) {
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return false;
  if (year < 2020 || year > 2039) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDays = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= maxDays[month - 1];
}

function getCurrentBrasiliaYear() {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
    }).formatToParts(new Date());
    const yPart = parts.find((p) => p.type === "year");
    const y = yPart ? Number(yPart.value) : NaN;
    if (y >= 2020 && y <= 2039) return y;
  } catch (_e) {}
  return new Date().getFullYear();
}

function validateTitleField(raw) {
  const cleaned = collapseCleanText(raw);
  if (!cleaned || isBlankFieldToken(cleaned)) {
    return {
      valid: false,
      isBlank: true,
      value: "",
      error: "O *nome/descrição da iniciativa* identifica o item na lista e não pode ficar vazio. Informe um título válido (ex.: *Pintura do hall do Bloco T7*).",
    };
  }
  if (looksLikeZeldaCommandAttempt(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "Parece que você digitou um comando da Zelda no lugar do nome da iniciativa. Digite o *título da iniciativa* ou envie *cancelar*.",
    };
  }
  const norm = normalizeTextToken(cleaned);
  if (CHAT_NOISE_EXACT.has(norm)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: `"${cleaned}" não parece um nome válido de iniciativa. Descreva brevemente a atividade (mínimo 4 caracteres, ex.: *Manutenção do portão da garagem*).`,
    };
  }
  if (containsUrl(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "O nome da iniciativa não deve conter links/URLs. Informe um título descritivo curto.",
    };
  }
  if (looksLikeDateOnly(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "Você informou uma data no lugar do *nome da iniciativa*. Digite primeiro o título da atividade (a data será pedida no passo próprio).",
    };
  }
  if (cleaned.length < 4 || cleaned.length > 160) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "O nome da iniciativa deve ter entre *4 e 160 caracteres*.",
    };
  }
  const letters = (cleaned.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  if (letters < 3) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "O nome da iniciativa deve conter palavras válidas (pelo menos 3 letras), evitando apenas números ou símbolos.",
    };
  }
  return { valid: true, isBlank: false, value: cleaned };
}

function validateAreaField(raw) {
  if (isBlankFieldToken(raw, ["sem area", "sem local", "sem bloco", "sem setor"])) {
    return { valid: true, isBlank: true, value: "" };
  }
  const cleaned = collapseCleanText(raw);
  if (looksLikeZeldaCommandAttempt(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "Comando detectado no lugar da Área/Setor. Informe a área (ex.: *Bloco T7*, *Portaria*), envie *-* para deixar em branco, ou digite *cancelar*.",
    };
  }
  const norm = normalizeTextToken(cleaned);
  if (
    CHAT_NOISE_EXACT.has(norm) ||
    ["alta", "media", "baixa", "pendente", "concluida", "em votacao", "em andamento"].includes(norm)
  ) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: `"${cleaned}" não é uma Área/Setor válida. Informe o local (ex.: *Bloco T7*, *Portaria*, *Garagem*) ou envie *-* para deixar sem informação.`,
    };
  }
  if (looksLikeDateOnly(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "Isso parece uma data e não uma Área/Setor. Informe o local (ex.: *Torre T7*, *Salão*) ou envie *-* para deixar sem informação.",
    };
  }
  if (containsUrl(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "A Área/Setor não pode conter links. Informe apenas o local ou deixe em branco (*-*).",
    };
  }
  if (cleaned.length < 2 || cleaned.length > 80) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "A Área/Setor deve ter entre *2 e 80 caracteres* (ou fique em branco enviando *-*).",
    };
  }
  const letters = (cleaned.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  if (letters < 1) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "A Área/Setor deve conter pelo menos uma letra (ex.: *T7*, *Bloco B*, *Portaria*) ou ficar sem informação (*-*).",
    };
  }
  if (!/^[A-Za-zÀ-ÿ0-9\s.,ºª°/()&'-]+$/.test(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "A Área/Setor contém símbolos inválidos. Use apenas letras e números (ex.: *Bloco T7 - Subsolo 1*) ou envie *-* para deixar em branco.",
    };
  }
  return { valid: true, isBlank: false, value: cleaned };
}

function validateResponsibleField(raw) {
  if (isBlankFieldToken(raw, ["sem responsavel", "sem encarregado"])) {
    return { valid: true, isBlank: true, value: "" };
  }
  const cleaned = collapseCleanText(raw);
  if (looksLikeZeldaCommandAttempt(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "Comando detectado no lugar do Responsável. Informe o nome do responsável, envie *-* para deixar em branco, ou digite *cancelar*.",
    };
  }
  const norm = normalizeTextToken(cleaned);
  if (
    CHAT_NOISE_EXACT.has(norm) ||
    ["alta", "media", "baixa", "pendente", "concluida", "em votacao", "em andamento"].includes(norm)
  ) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: `"${cleaned}" não é um nome de Responsável válido. Informe o nome/cargo (ex.: *Síndico Carlos*, *Zeladoria*, *Empresa Atlas*) ou envie *-* para deixar sem informação.`,
    };
  }
  if (looksLikeDateOnly(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "Isso parece uma data e não um Responsável. Informe o nome/cargo ou envie *-* para deixar sem informação.",
    };
  }
  if (containsUrl(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "O campo Responsável não pode conter links. Informe um nome/cargo válido ou deixe em branco (*-*).",
    };
  }
  const digitsCount = (cleaned.match(/\d/g) || []).length;
  if (digitsCount >= 8) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "Informe o *nome ou função* do responsável (evite enviar apenas número de telefone) ou envie *-* para deixar sem informação.",
    };
  }
  if (cleaned.length < 2 || cleaned.length > 80) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "O Responsável deve ter entre *2 e 80 caracteres* (ou fique em branco enviando *-*).",
    };
  }
  const letters = (cleaned.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  if (letters < 2) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "O Responsável deve conter um nome válido (pelo menos 2 letras) ou ficar sem informação (*-*).",
    };
  }
  if (!/^[A-Za-zÀ-ÿ0-9\s.,/()&'-]+$/.test(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "O nome do Responsável contém caracteres inválidos. Informe apenas nome/função (ex.: *Síndico / Zelador*) ou envie *-* para deixar em branco.",
    };
  }
  return { valid: true, isBlank: false, value: cleaned };
}

function validateDueDateField(raw) {
  if (isBlankFieldToken(raw, ["sem data", "sem prazo", "sem previsao", "indefinido", "indefinida"])) {
    return { valid: true, isBlank: true, value: "" };
  }
  const cleaned = collapseCleanText(raw);
  let day = 0;
  let month = 0;
  let year = 0;
  const brMatch = cleaned.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);
  const isoMatch = !brMatch ? cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) : null;
  if (brMatch) {
    day = Number(brMatch[1]);
    month = Number(brMatch[2]);
    if (!brMatch[3]) {
      year = getCurrentBrasiliaYear();
    } else if (brMatch[3].length === 2) {
      year = 2000 + Number(brMatch[3]);
    } else {
      year = Number(brMatch[3]);
    }
  } else if (isoMatch) {
    year = Number(isoMatch[1]);
    month = Number(isoMatch[2]);
    day = Number(isoMatch[3]);
  } else {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: `Data/Prazo inválido ("${cleaned}"). Informe uma data real no formato *DD/MM/AAAA* (ex.: *25/11/2026* ou *25/11*) ou deixe sem informação (*-*).`,
    };
  }
  if (!isRealCalendarDate(day, month, year)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: `A data *"${cleaned}"* não existe no calendário (ou está fora do intervalo válido 2020–2039). Informe uma data válida (ex.: *25/11/2026*) ou envie *-* para deixar em branco.`,
    };
  }
  const formatted = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
  return { valid: true, isBlank: false, value: formatted };
}

function validatePriorityField(raw, fallbackWhenBlank = "media") {
  if (isBlankFieldToken(raw, ["sem prioridade", "padrao"])) {
    return { valid: true, isBlank: true, value: fallbackWhenBlank };
  }
  const cleaned = collapseCleanText(raw);
  const norm = normalizeTextToken(cleaned).replace(/[.!?,;:]+$/g, "").trim();
  if (/\b(nao|nunca|sem)\b/.test(norm)) {
    return {
      valid: false,
      isBlank: false,
      value: fallbackWhenBlank,
      error: "Prioridade inválida. Responda apenas *Alta* (1), *Média* (2) ou *Baixa* (3) — ou envie *-* para manter o padrão (*Média*).",
    };
  }
  if (/^(1|alta|prioridade alta|urgente|critica)$/.test(norm)) {
    return { valid: true, isBlank: false, value: "alta" };
  }
  if (/^(2|media|prioridade media|normal|moderada)$/.test(norm)) {
    return { valid: true, isBlank: false, value: "media" };
  }
  if (/^(3|baixa|prioridade baixa|pouca)$/.test(norm)) {
    return { valid: true, isBlank: false, value: "baixa" };
  }
  return {
    valid: false,
    isBlank: false,
    value: fallbackWhenBlank,
    error: `"${cleaned}" não é uma prioridade válida. Escolha *Alta*, *Média* ou *Baixa* (ou envie *-* para manter *Média*).`,
  };
}

function validateStatusField(raw) {
  const cleaned = collapseCleanText(raw);
  if (!cleaned || isBlankFieldToken(cleaned)) {
    return {
      valid: false,
      isBlank: true,
      value: "pendente",
      error: "Escolha uma etapa válida de *1 a 6*:\n1 - Em votação\n2 - Aprovada\n3 - Pendente\n4 - Em andamento\n5 - Concluída\n6 - Reprovada",
    };
  }
  const norm = normalizeTextToken(cleaned).replace(/[.!?,;:]+$/g, "").trim();
  if (/\b(nao|nunca|jamais|ainda nao)\b/.test(norm)) {
    return {
      valid: false,
      isBlank: false,
      value: "pendente",
      error: "Resposta com negação detectada. Para evitar erro na atividade, responda apenas com o número de *1 a 6* ou nome exato do status (ex.: *3* para Pendente ou *6* para Reprovada).",
    };
  }
  if (/^(1|em_votacao|em votacao|votacao)$/.test(norm)) return { valid: true, isBlank: false, value: "em_votacao" };
  if (/^(2|aprovada|aprovado)$/.test(norm)) return { valid: true, isBlank: false, value: "aprovada" };
  if (/^(3|pendente|aberta|aberto)$/.test(norm)) return { valid: true, isBlank: false, value: "pendente" };
  if (/^(4|em_andamento|em andamento|andamento|em execucao|execucao)$/.test(norm)) return { valid: true, isBlank: false, value: "em_andamento" };
  if (/^(5|concluida|concluido|finalizada|finalizado)$/.test(norm)) return { valid: true, isBlank: false, value: "concluida" };
  if (/^(6|reprovada|reprovado|recusada|recusado|arquivada|arquivado)$/.test(norm)) return { valid: true, isBlank: false, value: "reprovada" };
  return {
    valid: false,
    isBlank: false,
    value: "pendente",
    error: `"${cleaned}" não é um status válido. Responda com *1* (Em votação), *2* (Aprovada), *3* (Pendente), *4* (Em andamento), *5* (Concluída) ou *6* (Reprovada).`,
  };
}

function validateVoteField(raw) {
  const cleaned = collapseCleanText(raw);
  if (!cleaned || isBlankFieldToken(cleaned)) {
    return {
      valid: false,
      isBlank: true,
      value: "favor",
      error: "Informe seu voto respondendo *1* (Aprovar / A favor), *2* (Reprovar / Contra) ou *3* (Abster).",
    };
  }
  const norm = normalizeTextToken(cleaned).replace(/[.!?,;:]+$/g, "").trim();
  if (/^(2|reprovar|reprovo|reprovada|reprovado|contra|voto contra|sou contra|nao|nao aprovo|nao aprovar)$/.test(norm)) {
    return { valid: true, isBlank: false, value: "contra" };
  }
  if (/^(1|aprovar|aprovo|aprovada|aprovado|favor|a favor|voto a favor|sou a favor|sim)$/.test(norm)) {
    return { valid: true, isBlank: false, value: "favor" };
  }
  if (/^(3|abster|abstencao|me abstenho|neutro)$/.test(norm)) {
    return { valid: true, isBlank: false, value: "abstencao" };
  }
  return {
    valid: false,
    isBlank: false,
    value: "favor",
    error: `Voto não reconhecido ("${cleaned}"). Responda apenas *1* (Aprovar / A favor), *2* (Reprovar / Contra) ou *3* (Abster).`,
  };
}

function validateNotesField(raw, fromInteractivePrompt = false) {
  const cleaned = collapseCleanText(raw);
  if (!cleaned) {
    return { valid: true, isBlank: true, value: "" };
  }
  const norm = normalizeTextToken(cleaned).replace(/[.!?,;:]+$/g, "").trim();
  if (BLANK_TOKENS.has(norm) || OPTIONAL_NOTE_NEGATIVE_TOKENS.has(norm)) {
    return { valid: true, isBlank: true, value: "" };
  }
  if (fromInteractivePrompt && OPTIONAL_NOTE_AFFIRMATIVE_ONLY_TOKENS.has(norm)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      needsTextAfterYes: true,
      error: "💬 Perfeito! Digite agora o *texto da observação/comentário* que deseja registrar _(ou envie *-* para deixar sem informação)_:",
    };
  }
  if (looksLikeZeldaCommandAttempt(cleaned)) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "Comando da Zelda detectado no lugar da observação. Digite o texto da observação, envie *-* para deixar em branco, ou digite *cancelar*.",
    };
  }
  if (cleaned.length > 500) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "A observação/comentário deve ter no máximo *500 caracteres*.",
    };
  }
  const alphaNum = (cleaned.match(/[A-Za-zÀ-ÿ0-9]/g) || []).length;
  if (alphaNum < 2) {
    return {
      valid: false,
      isBlank: false,
      value: "",
      error: "A observação informada contém apenas símbolos ou está incompleta. Digite um texto válido ou envie *-* para deixar sem informação.",
    };
  }
  return { valid: true, isBlank: false, value: cleaned };
}

function validateCompleteActivityPayload(input = {}) {
  const tCheck = validateTitleField(input.title ?? "");
  if (!tCheck.valid) return { ok: false, error: tCheck.error.replace(/\*/g, "") };
  const aCheck = validateAreaField(input.area ?? "");
  if (!aCheck.valid) return { ok: false, error: aCheck.error.replace(/\*/g, "") };
  const rCheck = validateResponsibleField(input.responsible ?? "");
  if (!rCheck.valid) return { ok: false, error: rCheck.error.replace(/\*/g, "") };
  const dCheck = validateDueDateField(input.dueDate ?? "");
  if (!dCheck.valid) return { ok: false, error: dCheck.error.replace(/\*/g, "") };
  const pCheck = validatePriorityField(input.priority ?? "", "media");
  if (!pCheck.valid) return { ok: false, error: pCheck.error.replace(/\*/g, "") };
  let finalStatus = "pendente";
  if (input.status !== undefined && String(input.status).trim() !== "") {
    const sCheck = validateStatusField(input.status);
    if (!sCheck.valid) return { ok: false, error: sCheck.error.replace(/\*/g, "") };
    finalStatus = sCheck.value;
  }
  const nCheck = validateNotesField(input.notes ?? "", false);
  if (!nCheck.valid) return { ok: false, error: nCheck.error.replace(/\*/g, "") };
  return {
    ok: true,
    data: {
      title: tCheck.value,
      area: aCheck.value,
      responsible: rCheck.value,
      dueDate: dCheck.value,
      priority: pCheck.value,
      status: finalStatus,
      notes: nCheck.value,
    },
  };
}

const STATUS_NAMES_PT = {
  em_votacao: "Em votação",
  aprovada: "Aprovada",
  pendente: "Pendente",
  em_andamento: "Em andamento",
  concluida: "Concluída",
  reprovada: "Reprovada",
};

const PRIORITY_NAMES_PT = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

function summarizeVotes(item) {
  const votes = Array.isArray(item.votes) ? item.votes : [];
  let favor = 0;
  let contra = 0;
  let abstencao = 0;
  for (const v of votes) {
    if (v.choice === "favor") favor++;
    else if (v.choice === "contra") contra++;
    else abstencao++;
  }
  return { favor, contra, abstencao, total: votes.length };
}

function addZeldaActivity(input, author = "Aplicação") {
  const list = loadZeldaActivities();
  const validation = validateCompleteActivityPayload(input || {});
  if (!validation.ok) {
    return { created: null, error: validation.error, list };
  }
  const now = nowBrasiliaLabel();
  const created = {
    id: `zact-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    code: nextActivityCode(list),
    title: validation.data.title,
    area: validation.data.area,
    responsible: validation.data.responsible,
    priority: validation.data.priority,
    dueDate: validation.data.dueDate,
    status: validation.data.status,
    notes: validation.data.notes,
    votes: Array.isArray(input.votes) ? input.votes : [],
    createdAt: now,
    updatedAt: now,
    updatedAtEpochMs: Date.now(),
    updatedBy: String(input.updatedBy || author || "Aplicação").trim(),
  };
  list.push(created);
  const saved = saveZeldaActivities(list);
  return { created, list: saved };
}

function updateZeldaActivity(idOrCode, patch = {}, author = "Aplicação") {
  const list = loadZeldaActivities();
  const targetKey = String(idOrCode || "").trim();
  const cleanCode = targetKey.replace(/^#/, "");
  const idx = list.findIndex(
    (a) => String(a.id) === targetKey || String(a.code) === cleanCode
  );
  if (idx < 0) return { updated: null, error: "Iniciativa não encontrada.", list };
  const current = list[idx];

  let nextTitle = current.title;
  if (patch.title !== undefined) {
    const tCheck = validateTitleField(patch.title);
    if (!tCheck.valid) return { updated: null, error: tCheck.error.replace(/\*/g, ""), list };
    nextTitle = tCheck.value;
  }
  let nextArea = String(current.area || "");
  if (patch.area !== undefined) {
    const aCheck = validateAreaField(patch.area);
    if (!aCheck.valid) return { updated: null, error: aCheck.error.replace(/\*/g, ""), list };
    nextArea = aCheck.value;
  }
  let nextResp = String(current.responsible || "");
  if (patch.responsible !== undefined) {
    const rCheck = validateResponsibleField(patch.responsible);
    if (!rCheck.valid) return { updated: null, error: rCheck.error.replace(/\*/g, ""), list };
    nextResp = rCheck.value;
  }
  let nextDue = String(current.dueDate || "");
  if (patch.dueDate !== undefined) {
    const dCheck = validateDueDateField(patch.dueDate);
    if (!dCheck.valid) return { updated: null, error: dCheck.error.replace(/\*/g, ""), list };
    nextDue = dCheck.value;
  }
  let nextPrio = current.priority || "media";
  if (patch.priority !== undefined) {
    const pCheck = validatePriorityField(patch.priority, nextPrio);
    if (!pCheck.valid) return { updated: null, error: pCheck.error.replace(/\*/g, ""), list };
    nextPrio = pCheck.value;
  }
  let nextStatus = current.status || "pendente";
  if (patch.status !== undefined) {
    const sCheck = validateStatusField(patch.status);
    if (!sCheck.valid) return { updated: null, error: sCheck.error.replace(/\*/g, ""), list };
    nextStatus = sCheck.value;
  }
  let nextNotes = String(current.notes || "");
  if (patch.notes !== undefined) {
    const nCheck = validateNotesField(patch.notes, false);
    if (!nCheck.valid) return { updated: null, error: nCheck.error.replace(/\*/g, ""), list };
    nextNotes = nCheck.value;
  }

  const now = nowBrasiliaLabel();
  const updated = Object.assign({}, current, {
    title: nextTitle,
    area: nextArea,
    responsible: nextResp,
    priority: nextPrio,
    dueDate: nextDue,
    status: nextStatus,
    notes: nextNotes,
    votes: Array.isArray(patch.votes)
      ? patch.votes
      : Array.isArray(current.votes)
      ? current.votes
      : [],
    updatedAt: now,
    updatedAtEpochMs: Date.now(),
    updatedBy: String(patch.updatedBy || author || "Aplicação").trim(),
  });
  list[idx] = updated;
  const saved = saveZeldaActivities(list);
  return { updated, list: saved };
}

function deleteZeldaActivity(idOrCode) {
  const list = loadZeldaActivities();
  const targetKey = String(idOrCode || "").trim();
  const cleanCode = targetKey.replace(/^#/, "");
  const filtered = list.filter(
    (a) => String(a.id) !== targetKey && String(a.code) !== cleanCode
  );
  const saved = saveZeldaActivities(filtered);
  return { removed: filtered.length < list.length, list: saved };
}

function formatSingleInitiativeDetail(item, quorum = 3) {
  const tally = summarizeVotes(item);
  const lines = [
    `📌 *Iniciativa #${item.code}* — ${item.title}`,
    `• *Status:* ${STATUS_NAMES_PT[item.status] || item.status}`,
    `• *Área/Local:* ${item.area || "(em branco)"}`,
    `• *Responsável:* ${item.responsible || "(em branco)"}`,
    `• *Data/Prazo:* ${item.dueDate || "(em branco)"}`,
    `• *Prioridade:* ${PRIORITY_NAMES_PT[item.priority] || "Média"}`,
    `• *Observação:* ${item.notes || "(em branco)"}`,
  ];
  if (item.status === "em_votacao" || tally.total > 0) {
    lines.push(`• *Votação do Conselho:* ${tally.favor}/${quorum} a favor · ${tally.contra} contra · ${tally.abstencao} abstenção(ões)`);
  }
  return lines.join("\n");
}

function formatCompactReferenceList(list) {
  const open = list.filter((a) => a.status !== "concluida" && a.status !== "reprovada");
  const target = open.length > 0 ? open : list;
  if (target.length === 0) return "";
  const preview = target.slice(0, 12).map((a) => `• *#${a.code}* — ${a.title} _(${STATUS_NAMES_PT[a.status] || a.status})_`);
  if (target.length > 12) preview.push(`_...e mais ${target.length - 12} iniciativa(s)._`);
  return preview.join("\n");
}

function formatPendenciesListText(customList = null, includeCompleted = false) {
  const list = Array.isArray(customList) ? [...customList] : loadZeldaActivities();
  const settings = getClinicSettings();
  const groupLabel = String(settings.zeldaGroupTarget || "").trim() || "Grupo Configurado";
  const quorum = Math.max(1, Number(settings.zeldaApprovalQuorum) || 3);
  const visible = includeCompleted
    ? list
    : list.filter((a) => a.status !== "concluida" && a.status !== "reprovada");

  const pRank = { alta: 0, media: 1, baixa: 2 };
  const sRank = { em_votacao: 0, em_andamento: 1, aprovada: 2, pendente: 3, concluida: 4, reprovada: 5 };
  visible.sort((a, b) => {
    const sd = (sRank[a.status] ?? 3) - (sRank[b.status] ?? 3);
    if (sd !== 0) return sd;
    const pd = (pRank[a.priority] ?? 1) - (pRank[b.priority] ?? 1);
    if (pd !== 0) return pd;
    return (Number(a.code) || 0) - (Number(b.code) || 0);
  });

  if (visible.length === 0) {
    return `🏢 *Iniciativas do Condomínio — ${groupLabel}*\n📅 ${nowBrasiliaLabel()}\n\n✅ Nenhuma iniciativa em aberto no momento.\n\n_Para cadastrar passo a passo no grupo, envie:_ *Zelda Inserir Iniciativa*`;
  }

  const lines = [
    `🏢 *Iniciativas Atualizadas — ${groupLabel}*`,
    `📅 ${nowBrasiliaLabel()}`,
    "",
  ];

  for (const item of visible) {
    const badge =
      item.status === "concluida"
        ? "✅"
        : item.status === "em_votacao"
        ? "🗳️"
        : item.status === "aprovada"
        ? "☑️"
        : item.priority === "alta"
        ? "🔴 [Alta]"
        : item.priority === "media"
        ? "🟡 [Média]"
        : "🔵 [Baixa]";
    const stName = STATUS_NAMES_PT[item.status] || "Pendente";
    const tally = summarizeVotes(item);

    lines.push(`${badge} *#${item.code}* — ${item.title}${item.area ? " _(" + item.area + ")_" : ""}`);
    const meta = [`Status: *${stName}*`];
    if (item.responsible) meta.push(`Resp.: ${item.responsible}`);
    if (item.dueDate) meta.push(`Prazo: ${item.dueDate}`);
    if (item.status === "em_votacao" || tally.total > 0) {
      meta.push(`Votos: ${tally.favor}/${quorum} favor · ${tally.contra} contra`);
    }
    lines.push(`   ${meta.join(" · ")}`);
    if (item.notes) lines.push(`   💬 Obs.: ${item.notes}`);
    lines.push("");
  }

  const voteCount = list.filter((a) => a.status === "em_votacao").length;
  const openCount = list.filter((a) => a.status === "pendente" || a.status === "aprovada").length;
  const progCount = list.filter((a) => a.status === "em_andamento").length;
  const doneCount = list.filter((a) => a.status === "concluida").length;

  lines.push(`📊 *Resumo:* ${voteCount} em votação · ${openCount} pendente(s)/aprovada(s) · ${progCount} em andamento · ${doneCount} concluída(s)`);
  lines.push(`_Comandos interativos:_ *Zelda Inserir Iniciativa* · *Zelda Alterar data* · *Zelda Votar* · *Zelda Concluir* · *Zelda Ajuda*`);
  return lines.join("\n").trim();
}

// 3. SESSÕES INTERATIVAS PASSO A PASSO POR REMETENTE (COMANDOS INICIADOS POR "ZELDA")
const zeldaSessionsBySender = new Map();
const ZELDA_SESSION_TTL_MS = 10 * 60 * 1000;

const ACTION_CONFIG = {
  alterar_data: {
    title: "Alterar Data / Prazo",
    valuePrompt: "Informe a *nova data/prazo* para esta iniciativa (ou envie *-* para deixar em branco):",
  },
  alterar_responsavel: {
    title: "Alterar Responsável",
    valuePrompt: "Informe o *novo responsável* para esta iniciativa (ou envie *-* para deixar em branco):",
  },
  alterar_nome: {
    title: "Alterar Nome / Descrição",
    valuePrompt: "Informe o *novo nome/descrição* da iniciativa:",
  },
  alterar_area: {
    title: "Alterar Área / Local",
    valuePrompt: "Informe a *nova área/bloco/setor* (ou envie *-* para deixar em branco):",
  },
  alterar_prioridade: {
    title: "Alterar Prioridade",
    valuePrompt: "Qual a *nova prioridade*? Responda *Alta*, *Média* ou *Baixa* (ou *-* para manter Média):",
  },
  alterar_observacao: {
    title: "Alterar Observação",
    valuePrompt: "Digite a *nova observação* da iniciativa (ou envie *-* para limpar a observação):",
  },
  alterar_status: {
    title: "Alterar Status",
    valuePrompt: "Qual o *novo status*?\n1 - Em votação\n2 - Aprovada\n3 - Pendente\n4 - Em andamento\n5 - Concluída\n6 - Reprovada",
  },
  em_andamento: {
    title: "Marcar Em Andamento",
    valuePrompt: "Deseja registrar alguma *observação* sobre o andamento? (Digite o texto ou envie *-* para deixar em branco):",
  },
  concluir: {
    title: "Concluir Iniciativa",
    valuePrompt: "Deseja registrar alguma *observação de conclusão*? (Digite o texto ou envie *-* para deixar em branco):",
  },
  reabrir: {
    title: "Reabrir Iniciativa",
    valuePrompt: "Deseja registrar o *motivo/observação* ao reabrir? (Digite o texto ou envie *-* para deixar em branco):",
  },
  abrir_votacao: {
    title: "Colocar em Votação do Conselho",
    valuePrompt: "Deseja adicionar alguma *observação/orçamento* para a votação? (Digite o texto ou envie *-* para deixar em branco):",
  },
  encerrar_votacao: {
    title: "Encerrar Votação",
    valuePrompt: "Como deseja encerrar a votação? Responda *Aprovar* ou *Reprovar*:",
  },
  votar: {
    title: "Registrar Voto do Conselho",
    valuePrompt: "Qual é o seu voto para esta iniciativa?\n1 - *Aprovar* (A favor)\n2 - *Reprovar* (Contra)\n3 - *Abstenção*",
  },
  excluir: {
    title: "Excluir Iniciativa",
    valuePrompt: null,
  },
  detalhar: {
    title: "Detalhar Iniciativa",
    valuePrompt: null,
  },
};

function parseZeldaCommandAndRemainder(normAfterZelda) {
  if (!normAfterZelda) return { cmd: "saudacao", remainder: "" };
  if (/^(cancelar|sair|parar|abortar|encerrar$)\b/.test(normAfterZelda)) {
    return { cmd: "cancelar", remainder: "" };
  }
  if (/^(ajuda|comandos|menu|help)\b/.test(normAfterZelda)) {
    return { cmd: "ajuda", remainder: "" };
  }
  if (/^(status|conexao|online)\b/.test(normAfterZelda)) {
    return { cmd: "status", remainder: "" };
  }
  if (/^(todas|historico|concluidas|lista\s+completa)\b/.test(normAfterZelda)) {
    return { cmd: "todas", remainder: "" };
  }
  if (/^(em\s+votacao|votacoes|pautas|pauta)\b/.test(normAfterZelda)) {
    return { cmd: "lista_votacao", remainder: "" };
  }
  if (/^(lista|listar|iniciativas|pendencias|atividades|resumo|relatorio)\b/.test(normAfterZelda)) {
    return { cmd: "lista", remainder: "" };
  }

  let m = null;

  // Observação ANTES de inserir genérico (para "Zelda incluir observacao" ir para alterar_observacao!)
  m =
    normAfterZelda.match(/^(?:alterar|mudar|editar|atualizar|incluir|inserir|adicionar|trocar)\s+(?:a\s+|o\s+)?(?:obs|observacao|nota|comentario)\b(.*)$/) ||
    normAfterZelda.match(/^(?:obs|observacao)\b(.*)$/);
  if (m) return { cmd: "alterar_observacao", remainder: m[1] || "" };

  if (/^(inserir|incluir|nova|novo|adicionar|cadastrar|criar)\b/.test(normAfterZelda)) {
    return { cmd: "inserir_iniciativa", remainder: "" };
  }

  m =
    normAfterZelda.match(/^(?:alterar|mudar|editar|atualizar|trocar)\s+(?:a\s+|o\s+)?(?:data|prazo|vencimento|previsao)\b(.*)$/) ||
    normAfterZelda.match(/^(?:prazo|data)\b(.*)$/);
  if (m) return { cmd: "alterar_data", remainder: m[1] || "" };

  m =
    normAfterZelda.match(/^(?:alterar|mudar|editar|atualizar|trocar)\s+(?:a\s+|o\s+)?(?:responsavel|encarregado|dono)\b(.*)$/) ||
    normAfterZelda.match(/^responsavel\b(.*)$/);
  if (m) return { cmd: "alterar_responsavel", remainder: m[1] || "" };

  m = normAfterZelda.match(/^(?:alterar|mudar|editar|atualizar|trocar)\s+(?:a\s+|o\s+)?(?:nome|titulo|descricao)\b(.*)$/);
  if (m) return { cmd: "alterar_nome", remainder: m[1] || "" };

  m = normAfterZelda.match(/^(?:alterar|mudar|editar|atualizar|trocar)\s+(?:a\s+|o\s+)?(?:area|local|bloco|setor)\b(.*)$/);
  if (m) return { cmd: "alterar_area", remainder: m[1] || "" };

  m =
    normAfterZelda.match(/^(?:alterar|mudar|editar|atualizar|trocar)\s+(?:a\s+|o\s+)?prioridade\b(.*)$/) ||
    normAfterZelda.match(/^prioridade\b(.*)$/);
  if (m) return { cmd: "alterar_prioridade", remainder: m[1] || "" };

  m = normAfterZelda.match(/^(?:alterar|mudar|editar|atualizar|trocar)\s+(?:o\s+|a\s+)?(?:status|situacao|etapa)\b(.*)$/);
  if (m) return { cmd: "alterar_status", remainder: m[1] || "" };

  m = normAfterZelda.match(/^(?:em\s+andamento|andamento|iniciar|execucao)\b(.*)$/);
  if (m) return { cmd: "em_andamento", remainder: m[1] || "" };

  m = normAfterZelda.match(/^(?:concluir|concluida|concluido|finalizar|baixar)\b(.*)$/);
  if (m) return { cmd: "concluir", remainder: m[1] || "" };

  m = normAfterZelda.match(/^(?:reabrir|voltar\s+para\s+pendente)\b(.*)$/);
  if (m) return { cmd: "reabrir", remainder: m[1] || "" };

  m = normAfterZelda.match(/^(?:abrir\s+votacao|colocar\s+em\s+votacao|iniciar\s+votacao|submeter)\b(.*)$/);
  if (m) return { cmd: "abrir_votacao", remainder: m[1] || "" };

  m = normAfterZelda.match(/^(?:encerrar\s+votacao|fechar\s+votacao|apurar\s+votacao)\b(.*)$/);
  if (m) return { cmd: "encerrar_votacao", remainder: m[1] || "" };

  m = normAfterZelda.match(/^(?:votar|voto)\b(.*)$/);
  if (m) return { cmd: "votar", remainder: m[1] || "" };

  m = normAfterZelda.match(/^aprovar\b(.*)$/);
  if (m) return { cmd: "votar_aprovar", remainder: m[1] || "" };

  m = normAfterZelda.match(/^reprovar\b(.*)$/);
  if (m) return { cmd: "votar_reprovar", remainder: m[1] || "" };

  m = normAfterZelda.match(/^(?:excluir|remover|apagar|deletar)\b(.*)$/);
  if (m) return { cmd: "excluir", remainder: m[1] || "" };

  m = normAfterZelda.match(/^(?:detalhar|detalhe|detalhes|ver|consultar)\b(.*)$/);
  if (m) return { cmd: "detalhar", remainder: m[1] || "" };

  if (/^(alterar|mudar|editar|atualizar|trocar)$/.test(normAfterZelda)) {
    return { cmd: "menu_alterar", remainder: "" };
  }

  return { cmd: "desconhecido", remainder: "" };
}

function buildSenderSessionKeys(groupId, senderPhone, senderName) {
  const grpPrefix = String(groupId || "default_grp").trim().toLowerCase() + "::";
  const rawPh = String(senderPhone || "").trim().toLowerCase();
  const digits = rawPh.split("@")[0].split(":")[0].replace(/\D+/g, "");
  const normWho = normalizeTextToken(senderName || "");
  const keys = [];
  if (digits.length >= 8) {
    keys.push(grpPrefix + "num:" + digits.slice(-10));
    keys.push("num:" + digits.slice(-10));
  }
  if (rawPh) {
    keys.push(grpPrefix + "raw:" + rawPh);
    keys.push("raw:" + rawPh);
  }
  if (normWho && normWho !== "conselheiro") {
    keys.push(grpPrefix + "who:" + normWho);
    keys.push("who:" + normWho);
  }
  if (keys.length === 0) {
    keys.push(grpPrefix + "default_member");
  }
  return Array.from(new Set(keys));
}

function stripInvisibleWaMarks(str) {
  return String(str || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .trim();
}

function escapeRegExpSafe(val) {
  return String(val || "").replace(/[.*+?^${}()|\[\]\\]/g, "\\$&");
}

function parseZeldaTrigger(cleanText, customKeyword, botMentioned = false, botProfileName = "") {
  let working = stripInvisibleWaMarks(cleanText);
  if (!working) return { triggered: false, stripped: "" };

  let hadAccountMention = Boolean(botMentioned);
  const profileEsc = escapeRegExpSafe(String(botProfileName || "").trim());

  // Remove saudações curtas e menções iniciais dinâmicas do WhatsApp conectado em qualquer ordem
  const greetingPrefixRx = /^(?:oi+|ol[aá]+|opa+|e\s*a[ií]|fala|ei|bom\s+dia|boa\s+tarde|boa\s+noite|por\s+favor|pfv)[\s,.:;!?-]+/i;
  for (let i = 0; i < 4; i++) {
    let strippedOnce = false;
    if (greetingPrefixRx.test(working)) {
      working = working.replace(greetingPrefixRx, "").trim();
      strippedOnce = true;
    }
    if (profileEsc && profileEsc.length >= 2) {
      const profRx = new RegExp(`^@${profileEsc}(?:\\b|[\\s,.:;!?-]*)`, "i");
      if (profRx.test(working)) {
        working = working.replace(profRx, "").trim();
        hadAccountMention = true;
        strippedOnce = true;
      }
    }
    if (!strippedOnce && /^@\d{5,22}(?:\b|[\s,.:;!?-]*)/.test(working)) {
      working = working.replace(/^@\d{5,22}[\s,.:;!?-]*/, "").trim();
      hadAccountMention = true;
      strippedOnce = true;
    }
    if (!strippedOnce) break;
  }

  const withoutGreeting = working.replace(greetingPrefixRx, "").trim();

  const kw = escapeRegExpSafe(String(customKeyword || "zelda").trim()) || "zelda";
  const kwRegex = new RegExp(`^[/*_~@!\\s]*${kw}(?:\\b|[\\s,.:;!?*_~-]|$)`, "i");
  const kwStrip = new RegExp(`^[/*_~@!\\s]*${kw}[\\s,.:;!?*_~-]*`, "i");

  for (const candidate of [working, withoutGreeting]) {
    if (kwRegex.test(candidate)) {
      return {
        triggered: true,
        stripped: candidate.replace(kwStrip, "").trim(),
      };
    }
    if (/^[/*_~@!\s]*zelda(?:\b|[\s,.:;!?*_~-]|$)/i.test(candidate)) {
      return {
        triggered: true,
        stripped: candidate.replace(/^[/*_~@!\s]*zelda[\s,.:;!?*_~-]*/i, "").trim(),
      };
    }
  }

  // Se mencionou dinamicamente o WhatsApp conectado (por @nome da sessão ativa ou número/LID) seguido de um comando válido da Zelda
  if (hadAccountMention) {
    const candidateCmd = withoutGreeting || working;
    if (!candidateCmd) {
      return { triggered: true, stripped: "" };
    }
    const normW = normalizeTextToken(candidateCmd);
    const parsedCmd = parseZeldaCommandAndRemainder(normW);
    if (parsedCmd.cmd !== "desconhecido" || /^(cancelar|sair|parar|encerrar)\b/.test(normW)) {
      return {
        triggered: true,
        stripped: candidateCmd,
      };
    }
  }

  return { triggered: false, stripped: "" };
}

function handleZeldaCondominioCommand(
  rawText,
  senderName = "",
  senderPhone = "",
  isCaretakerOverride = false,
  groupId = "",
  botMentioned = false,
  botProfileName = ""
) {
  const clean = stripInvisibleWaMarks(rawText);
  if (!clean) return { handled: false, replyText: null };

  const settings = getClinicSettings();
  const groupLabel = String(settings.zeldaGroupTarget || "").trim() || "Grupo Configurado";
  const quorum = Math.max(1, Number(settings.zeldaApprovalQuorum) || 3);
  const caretakerPhoneCfg = String(settings.zeldaCaretakerPhone || "").trim();
  const who = senderName ? String(senderName).trim() : "Conselheiro";
  const sessionKeys = buildSenderSessionKeys(groupId, senderPhone, who);
  const senderKey = sessionKeys[0];

  const getSenderSession = () => {
    for (const k of sessionKeys) {
      const s = zeldaSessionsBySender.get(k);
      if (s) {
        if (Date.now() - s.updatedAtMs > ZELDA_SESSION_TTL_MS) {
          for (const dk of sessionKeys) zeldaSessionsBySender.delete(dk);
          return null;
        }
        return s;
      }
    }
    return null;
  };
  const saveSenderSession = (sessObj) => {
    for (const k of sessionKeys) {
      zeldaSessionsBySender.set(k, sessObj);
    }
  };
  const clearSenderSession = () => {
    for (const k of sessionKeys) {
      zeldaSessionsBySender.delete(k);
    }
  };

  const isCaretaker =
    Boolean(isCaretakerOverride) ||
    isCaretakerPhoneBlocked(senderPhone, caretakerPhoneCfg);

  const trig = parseZeldaTrigger(clean, settings.zeldaTriggerKeyword || "zelda", botMentioned, botProfileName);
  const startsWithZelda = trig.triggered;
  const strippedAfterZelda = trig.stripped;
  const normAfterZelda = normalizeTextToken(strippedAfterZelda);
  const normFull = normalizeTextToken(clean);

  const activeSession = getSenderSession();

  if (
    (startsWithZelda && /^(cancelar|sair|parar|abortar|encerrar$)\b/.test(normAfterZelda)) ||
    (activeSession && /^(cancelar|sair|parar|abortar|desistir)$/.test(normFull))
  ) {
    clearSenderSession();
    return {
      handled: true,
      replyText: `✅ Operação cancelada, ${who}. Quando precisar, inicie um comando começando por *Zelda* (ex.: *Zelda Ajuda*).`,
    };
  }

  if (startsWithZelda) {
    clearSenderSession();
    const parsedCmd = parseZeldaCommandAndRemainder(normAfterZelda);
    const cmd = parsedCmd.cmd;
    const cmdRemainder = parsedCmd.remainder;

    if (cmd === "menu_alterar") {
      return {
        handled: true,
        replyText: [
          "✏️ *O que você deseja alterar?* Envie um dos comandos abaixo:",
          "• *Zelda Alterar data*",
          "• *Zelda Alterar responsavel*",
          "• *Zelda Alterar nome*",
          "• *Zelda Alterar area*",
          "• *Zelda Alterar prioridade*",
          "• *Zelda Alterar observacao*",
          "• *Zelda Alterar status*",
        ].join("\n"),
      };
    }

    if (cmd === "ajuda" || cmd === "saudacao" || cmd === "desconhecido") {
      const list = loadZeldaActivities();
      const openCount = list.filter((a) => a.status !== "concluida" && a.status !== "reprovada").length;
      const header =
        cmd === "desconhecido"
          ? `⚠️ Não reconheci esse comando, ${who}. Veja os comandos interativos disponíveis:\n`
          : `📋 *Comandos Interativos da Zelda — ${groupLabel}* (${openCount} em aberto)\n`;
      return {
        handled: true,
        replyText: [
          header,
          "*Consulta:*",
          "• *Zelda Lista* — lista iniciativas em aberto",
          "• *Zelda Todas* — lista abertas e concluídas",
          "• *Zelda Em votacao* — lista itens aguardando votos",
          "• *Zelda Detalhar* — consulta todos os campos de uma iniciativa",
          "• *Zelda Status* — status da conexão e resumo do grupo",
          "",
          "*Inclusão Passo a Passo (aceita campos opcionais em branco com -):*",
          "• *Zelda Inserir Iniciativa*",
          "",
          "*Modificação Passo a Passo (pergunta nº, confirma descrição e valida novo valor):*",
          "• *Zelda Alterar data*",
          "• *Zelda Alterar responsavel*",
          "• *Zelda Alterar nome*",
          "• *Zelda Alterar area*",
          "• *Zelda Alterar prioridade*",
          "• *Zelda Alterar observacao*",
          "• *Zelda Alterar status*",
          "• *Zelda Em andamento*",
          "• *Zelda Concluir*",
          "• *Zelda Reabrir*",
          "• *Zelda Excluir iniciativa*",
          "",
          "*Aprovação do Conselho (Zelador sem direito a voto):*",
          "• *Zelda Abrir votacao*",
          "• *Zelda Votar* (ou *Zelda Aprovar* / *Zelda Reprovar*)",
          "• *Zelda Encerrar votacao*",
          "• *Zelda Cancelar* — interrompe um preenchimento em curso",
        ].join("\n"),
      };
    }

    if (cmd === "status") {
      const conn = getWhatsAppConnectionStatus();
      const list = loadZeldaActivities();
      const openCount = list.filter((a) => a.status !== "concluida" && a.status !== "reprovada").length;
      const voteCount = list.filter((a) => a.status === "em_votacao").length;
      const doneCount = list.filter((a) => a.status === "concluida").length;
      return {
        handled: true,
        replyText: [
          `📡 *Status da Conexão:* ${conn.statusLabel}`,
          `👥 *Grupo Configurado:* ${groupLabel}`,
          `🗳️ *Quórum de Aprovação:* ${quorum} voto(s) favoráveis`,
          `🔒 *Zelador (Sem Voto):* ${caretakerPhoneCfg ? caretakerPhoneCfg : "Não cadastrado"}`,
          `📌 *Iniciativas:* ${openCount} em aberto (${voteCount} em votação) · ${doneCount} concluída(s).`,
        ].join("\n"),
      };
    }

    if (cmd === "lista") {
      return { handled: true, replyText: formatPendenciesListText(null, false) };
    }

    if (cmd === "todas") {
      return { handled: true, replyText: formatPendenciesListText(null, true) };
    }

    if (cmd === "lista_votacao") {
      const list = loadZeldaActivities().filter((a) => a.status === "em_votacao");
      if (list.length === 0) {
        return {
          handled: true,
          replyText: `🗳️ Nenhuma iniciativa está *Em votação* no momento no grupo *${groupLabel}*.\nPara abrir votação em um item, envie *Zelda Abrir votacao*.`,
        };
      }
      return { handled: true, replyText: formatPendenciesListText(list, false) };
    }

    if (["votar", "votar_aprovar", "votar_reprovar", "encerrar_votacao"].includes(cmd) && isCaretaker) {
      return {
        handled: true,
        replyText: `🚫 *Voto não permitido, ${who}.*\nO seu número de WhatsApp está cadastrado como *Zelador* do condomínio e, conforme regra de governança do grupo *${groupLabel}*, somente os Conselheiros podem votar ou encerrar votações.\n\nVocê continua podendo consultar (*Zelda Lista*) e atualizar o andamento das iniciativas (*Zelda Alterar data*, *Zelda Alterar observacao*, *Zelda Concluir*).`,
      };
    }

    if (cmd === "inserir_iniciativa") {
      saveSenderSession({
        mode: "insert",
        step: "ask_title",
        draft: {},
        updatedAtMs: Date.now(),
      });
      return {
        handled: true,
        replyText: `📝 *Nova Iniciativa — Passo 1 de 6*\nQual o *nome da Iniciativa*?\n_(Mínimo de 4 caracteres · para cancelar a qualquer momento, digite *cancelar*)_`,
      };
    }

    const baseAction =
      cmd === "votar_aprovar" || cmd === "votar_reprovar" ? "votar" : cmd;
    const preselectedVote =
      cmd === "votar_aprovar" ? "favor" : cmd === "votar_reprovar" ? "contra" : null;

    const list = loadZeldaActivities();
    if (list.length === 0) {
      return {
        handled: true,
        replyText: `⚠️ Ainda não há iniciativas cadastradas no grupo *${groupLabel}*.\nEnvie *Zelda Inserir Iniciativa* para incluir a primeira.`,
      };
    }

    const actionMeta = ACTION_CONFIG[baseAction];
    if (!actionMeta) {
      return { handled: false, replyText: null };
    }

    const inlineTarget = extractInlineCommandTargetCode(cmdRemainder);
    const refList = formatCompactReferenceList(list);

    if (inlineTarget.hasInvalidTrailingArg) {
      saveSenderSession({
        mode: "modify",
        action: baseAction,
        preselectedVote,
        step: "ask_id",
        targetCode: null,
        updatedAtMs: Date.now(),
      });
      return {
        handled: true,
        replyText: [
          `ℹ️ *${actionMeta.title}*`,
          "Para evitar gravar dados na iniciativa errada, informe primeiro apenas o *número da iniciativa* (ex.: *1*).",
          "Depois da sua confirmação eu peço o novo valor!",
          refList ? `\n${refList}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    if (inlineTarget.code !== null) {
      const foundInline = list.find((a) => Number(a.code) === inlineTarget.code);
      if (!foundInline) {
        saveSenderSession({
          mode: "modify",
          action: baseAction,
          preselectedVote,
          step: "ask_id",
          targetCode: null,
          updatedAtMs: Date.now(),
        });
        return {
          handled: true,
          replyText: `⚠️ Iniciativa *#${inlineTarget.code}* não encontrada.\nInforme um número válido da lista ou digite *cancelar*:${refList ? "\n\n" + refList : ""}`,
        };
      }

      saveSenderSession({
        mode: "modify",
        action: baseAction,
        preselectedVote,
        step: "confirm_target",
        targetCode: foundInline.code,
        updatedAtMs: Date.now(),
      });
      return {
        handled: true,
        replyText: [
          `🔎 *Confirmação da Iniciativa (${actionMeta.title})*`,
          `• *#${foundInline.code}* — *${foundInline.title}*`,
          `• Status atual: ${STATUS_NAMES_PT[foundInline.status] || foundInline.status}${foundInline.dueDate ? " · Prazo: " + foundInline.dueDate : ""}${foundInline.responsible ? " · Resp.: " + foundInline.responsible : ""}`,
          "",
          "Confirma que é esta iniciativa? Responda *Sim* ou *Não*:",
        ].join("\n"),
      };
    }

    saveSenderSession({
      mode: "modify",
      action: baseAction,
      preselectedVote,
      step: "ask_id",
      targetCode: null,
      updatedAtMs: Date.now(),
    });

    return {
      handled: true,
      replyText: [
        `🔧 *${actionMeta.title}*`,
        "De que iniciativa? Informe apenas o *número* (ex.: *1*):",
        refList ? `\n${refList}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (!activeSession) {
    return { handled: false, replyText: null };
  }

  activeSession.updatedAtMs = Date.now();

  if (activeSession.mode === "insert") {
    if (activeSession.step === "ask_title") {
      const check = validateTitleField(clean);
      if (!check.valid) {
        return {
          handled: true,
          replyText: `⚠️ ${check.error}\n_(Ou digite *cancelar*)_`,
        };
      }
      activeSession.draft.title = check.value;
      activeSession.step = "ask_area";
      return {
        handled: true,
        replyText: `📝 *Passo 2 de 6 — Área / Local*\nQual a *área, bloco ou setor* da iniciativa *"${check.value}"*?\n_(Envie *-* para deixar sem informação)_`,
      };
    }

    if (activeSession.step === "ask_area") {
      const check = validateAreaField(clean);
      if (!check.valid) {
        return { handled: true, replyText: `⚠️ ${check.error}` };
      }
      activeSession.draft.area = check.value;
      activeSession.step = "ask_responsible";
      return {
        handled: true,
        replyText: "📝 *Passo 3 de 6 — Responsável*\nQuem será o *responsável* pela iniciativa?\n_(Envie *-* para deixar sem informação)_",
      };
    }

    if (activeSession.step === "ask_responsible") {
      const check = validateResponsibleField(clean);
      if (!check.valid) {
        return { handled: true, replyText: `⚠️ ${check.error}` };
      }
      activeSession.draft.responsible = check.value;
      activeSession.step = "ask_due_date";
      return {
        handled: true,
        replyText: "📝 *Passo 4 de 6 — Data / Prazo*\nQual a *data ou prazo previsto*? _(Formato DD/MM/AAAA, ex.: 25/11/2026)_\n_(Envie *-* para deixar sem informação)_",
      };
    }

    if (activeSession.step === "ask_due_date") {
      const check = validateDueDateField(clean);
      if (!check.valid) {
        return { handled: true, replyText: `⚠️ ${check.error}` };
      }
      activeSession.draft.dueDate = check.value;
      activeSession.step = "ask_priority";
      return {
        handled: true,
        replyText: "📝 *Passo 5 de 6 — Prioridade*\nQual a *prioridade*? Responda *Alta*, *Média* ou *Baixa*:\n_(Envie *-* para manter Média)_",
      };
    }

    if (activeSession.step === "ask_priority") {
      const check = validatePriorityField(clean, "media");
      if (!check.valid) {
        return { handled: true, replyText: `⚠️ ${check.error}` };
      }
      activeSession.draft.priority = check.value;
      activeSession.step = "ask_notes";
      return {
        handled: true,
        replyText: "📝 *Passo 6 de 6 — Observação*\nDeseja incluir alguma *observação ou detalhe*?\n_(Envie o texto ou *-* / *Não* para deixar sem informação)_",
      };
    }

    if (activeSession.step === "ask_notes") {
      const check = validateNotesField(clean, true);
      if (!check.valid) {
        return {
          handled: true,
          replyText: check.needsTextAfterYes ? check.error : `⚠️ ${check.error}`,
        };
      }
      activeSession.draft.notes = check.value;
      activeSession.step = "ask_voting_status";
      return {
        handled: true,
        replyText: "🗳️ *Aprovação do Conselho*\nDeseja colocar esta iniciativa *Em votação* do Conselho agora? Responda *Sim* ou *Não* _(envie *-* para cadastrar direto como Pendente)_:",
      };
    }

    if (activeSession.step === "ask_voting_status") {
      const yn = parseStrictYesNo(clean);
      if (yn === "invalid") {
        return {
          handled: true,
          replyText: `⚠️ Resposta inválida ("${clean}"). Responda apenas *Sim* (colocar Em votação) ou *Não* / *-* (cadastrar como Pendente):`,
        };
      }
      const status = yn === "yes" ? "em_votacao" : "pendente";
      const { created, error } = addZeldaActivity(
        {
          title: activeSession.draft.title,
          area: activeSession.draft.area || "",
          responsible: activeSession.draft.responsible || "",
          dueDate: activeSession.draft.dueDate || "",
          priority: activeSession.draft.priority || "media",
          notes: activeSession.draft.notes || "",
          status,
        },
        `${who} (WhatsApp)`
      );
      clearSenderSession();
      if (!created) {
        return {
          handled: true,
          replyText: `⚠️ Não foi possível concluir o cadastro: ${error || "dados inválidos"}.`,
        };
      }
      return {
        handled: true,
        replyText: [
          `✅ *Iniciativa #${created.code} cadastrada com sucesso por ${who}!*`,
          "",
          formatSingleInitiativeDetail(created, quorum),
          status === "em_votacao"
            ? `\n🗳️ Para votar, os conselheiros podem enviar *Zelda Votar*.`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
  }

  if (activeSession.mode === "modify") {
    const actionMeta = ACTION_CONFIG[activeSession.action];

    if (activeSession.step === "ask_id") {
      const code = parseStrictInitiativeCode(clean);
      if (code === null) {
        return {
          handled: true,
          replyText: "🔢 Informe apenas o *número* da iniciativa (ex.: *1* ou *#1*) ou digite *cancelar*:",
        };
      }
      const list = loadZeldaActivities();
      const found = list.find((a) => Number(a.code) === code);
      if (!found) {
        const refList = formatCompactReferenceList(list);
        return {
          handled: true,
          replyText: `⚠️ Iniciativa *#${code}* não encontrada. Informe um número válido da lista ou digite *cancelar*:${refList ? "\n\n" + refList : ""}`,
        };
      }

      activeSession.targetCode = code;
      activeSession.step = "confirm_target";
      return {
        handled: true,
        replyText: [
          `🔎 *Confirmação da Iniciativa*`,
          `• *#${found.code}* — *${found.title}*`,
          `• Status atual: ${STATUS_NAMES_PT[found.status] || found.status}${found.dueDate ? " · Prazo: " + found.dueDate : ""}${found.responsible ? " · Resp.: " + found.responsible : ""}`,
          "",
          "Confirma que é esta iniciativa? Responda *Sim* ou *Não*:",
        ].join("\n"),
      };
    }

    if (activeSession.step === "confirm_target") {
      const yn = parseStrictYesNo(clean);
      if (yn === "no") {
        activeSession.targetCode = null;
        activeSession.step = "ask_id";
        const refList = formatCompactReferenceList(loadZeldaActivities());
        return {
          handled: true,
          replyText: `Sem problemas! De que iniciativa você deseja tratar? Informe apenas o *número*:${refList ? "\n\n" + refList : ""}`,
        };
      }
      if (yn !== "yes") {
        return {
          handled: true,
          replyText: "Por favor, confirme respondendo *Sim* ou *Não* (ou digite *cancelar*):",
        };
      }

      const list = loadZeldaActivities();
      const foundIdx = list.findIndex((a) => Number(a.code) === Number(activeSession.targetCode));
      if (foundIdx < 0) {
        clearSenderSession();
        return {
          handled: true,
          replyText: "⚠️ Esta iniciativa não está mais disponível na lista.",
        };
      }
      const found = list[foundIdx];

      if (activeSession.action === "detalhar") {
        clearSenderSession();
        return {
          handled: true,
          replyText: formatSingleInitiativeDetail(found, quorum),
        };
      }

      if (activeSession.action === "excluir") {
        const [removed] = list.splice(foundIdx, 1);
        saveZeldaActivities(list);
        clearSenderSession();
        return {
          handled: true,
          replyText: `🗑️ Iniciativa *#${removed.code}* (*${removed.title}*) excluída por ${who}.`,
        };
      }

      if (activeSession.action === "abrir_votacao" && found.status === "concluida") {
        clearSenderSession();
        return {
          handled: true,
          replyText: `⚠️ A iniciativa *#${found.code} — ${found.title}* já consta como *Concluída*. Para reabri-la antes de votar, envie *Zelda Reabrir*.`,
        };
      }

      if (activeSession.action === "votar") {
        if (isCaretaker) {
          clearSenderSession();
          return {
            handled: true,
            replyText: `🚫 *Voto bloqueado:* O WhatsApp do Zelador não possui permissão de voto nas iniciativas do Conselho.`,
          };
        }
        if (found.status === "concluida" || found.status === "reprovada") {
          clearSenderSession();
          return {
            handled: true,
            replyText: `⚠️ A iniciativa *#${found.code} — ${found.title}* está com status *${STATUS_NAMES_PT[found.status] || found.status}* e não recebe novos votos.\nPara reavaliá-la no Conselho, envie *Zelda Abrir votacao* ou *Zelda Reabrir*.`,
          };
        }
        if (activeSession.preselectedVote) {
          activeSession.pendingVoteChoice = activeSession.preselectedVote;
          activeSession.step = "ask_vote_note";
          const voteLabel = activeSession.preselectedVote === "favor" ? "Aprovar (A favor)" : "Reprovar (Contra)";
          return {
            handled: true,
            replyText: `🗳️ Voto selecionado: *${voteLabel}* na iniciativa *#${found.code}* (${found.title}).\nDeseja acrescentar algum *comentário/ressalva* ao voto? _(Envie *-* ou *Não* para deixar em branco)_`,
          };
        }
      }

      if (activeSession.action === "encerrar_votacao") {
        if (isCaretaker) {
          clearSenderSession();
          return {
            handled: true,
            replyText: "🚫 O Zelador não possui permissão para encerrar votações do Conselho.",
          };
        }
        const tally = summarizeVotes(found);
        if (found.status !== "em_votacao" && tally.total === 0) {
          clearSenderSession();
          return {
            handled: true,
            replyText: `⚠️ A iniciativa *#${found.code} — ${found.title}* não está *Em votação* no momento (status atual: *${STATUS_NAMES_PT[found.status] || found.status}*).\nPara abrir votação, envie *Zelda Abrir votacao*.`,
          };
        }
        if (tally.total > 0 && tally.favor !== tally.contra) {
          found.status = tally.favor > tally.contra ? "aprovada" : "reprovada";
          found.updatedAt = nowBrasiliaLabel();
          found.updatedAtEpochMs = Date.now();
          found.updatedBy = `${who} (Apuração WhatsApp)`;
          saveZeldaActivities(list);
          clearSenderSession();
          return {
            handled: true,
            replyText: `🗳️ Votação da iniciativa *#${found.code}* (${found.title}) encerrada automaticamente pelo placar como *${STATUS_NAMES_PT[found.status]}*!\nPlacar final: ${tally.favor} a favor · ${tally.contra} contra · ${tally.abstencao} abstenção(ões).`,
          };
        }
        activeSession.step = "ask_value";
        return {
          handled: true,
          replyText: `⚖️ *Encerramento de Votação — #${found.code} — ${found.title}*\nPlacar atual: *${tally.favor} a favor · ${tally.contra} contra* _(sem maioria definida)_.\nComo deseja encerrar a votação? Responda *1* (*Aprovar*) ou *2* (*Reprovar*) _(ou digite *cancelar*)_:`,
        };
      }

      activeSession.step = "ask_value";
      return {
        handled: true,
        replyText: `✏️ *#${found.code} — ${found.title}*\n${actionMeta.valuePrompt}`,
      };
    }

    if (activeSession.step === "ask_value") {
      const list = loadZeldaActivities();
      const found = list.find((a) => Number(a.code) === Number(activeSession.targetCode));
      if (!found) {
        clearSenderSession();
        return { handled: true, replyText: "⚠️ Iniciativa não encontrada." };
      }

      const act = activeSession.action;
      const now = nowBrasiliaLabel();

      if (act === "alterar_nome") {
        const check = validateTitleField(clean);
        if (!check.valid) {
          return {
            handled: true,
            replyText: `⚠️ ${check.error}\n_(Ou digite *cancelar*)_`,
          };
        }
        found.title = check.value;
        found.updatedAt = now;
        found.updatedAtEpochMs = Date.now();
        found.updatedBy = `${who} (WhatsApp)`;
        saveZeldaActivities(list);
        clearSenderSession();
        return {
          handled: true,
          replyText: `✅ Nome da iniciativa *#${found.code}* atualizado para: *${found.title}*`,
        };
      }

      if (act === "alterar_data") {
        const check = validateDueDateField(clean);
        if (!check.valid) {
          return { handled: true, replyText: `⚠️ ${check.error}` };
        }
        found.dueDate = check.value;
        found.updatedAt = now;
        found.updatedAtEpochMs = Date.now();
        found.updatedBy = `${who} (WhatsApp)`;
        saveZeldaActivities(list);
        clearSenderSession();
        return {
          handled: true,
          replyText: `✅ Data/Prazo da iniciativa *#${found.code}* (${found.title}) atualizada para: *${found.dueDate || "(em branco)"}*`,
        };
      }

      if (act === "alterar_responsavel") {
        const check = validateResponsibleField(clean);
        if (!check.valid) {
          return { handled: true, replyText: `⚠️ ${check.error}` };
        }
        found.responsible = check.value;
        found.updatedAt = now;
        found.updatedAtEpochMs = Date.now();
        found.updatedBy = `${who} (WhatsApp)`;
        saveZeldaActivities(list);
        clearSenderSession();
        return {
          handled: true,
          replyText: `✅ Responsável da iniciativa *#${found.code}* (${found.title}) atualizado para: *${found.responsible || "(em branco)"}*`,
        };
      }

      if (act === "alterar_area") {
        const check = validateAreaField(clean);
        if (!check.valid) {
          return { handled: true, replyText: `⚠️ ${check.error}` };
        }
        found.area = check.value;
        found.updatedAt = now;
        found.updatedAtEpochMs = Date.now();
        found.updatedBy = `${who} (WhatsApp)`;
        saveZeldaActivities(list);
        clearSenderSession();
        return {
          handled: true,
          replyText: `✅ Área/Local da iniciativa *#${found.code}* (${found.title}) atualizada para: *${found.area || "(em branco)"}*`,
        };
      }

      if (act === "alterar_prioridade") {
        const check = validatePriorityField(clean, "media");
        if (!check.valid) {
          return { handled: true, replyText: `⚠️ ${check.error}` };
        }
        found.priority = check.value;
        found.updatedAt = now;
        found.updatedAtEpochMs = Date.now();
        found.updatedBy = `${who} (WhatsApp)`;
        saveZeldaActivities(list);
        clearSenderSession();
        return {
          handled: true,
          replyText: `✅ Prioridade da iniciativa *#${found.code}* (${found.title}) atualizada para: *${PRIORITY_NAMES_PT[found.priority]}*`,
        };
      }

      if (act === "alterar_observacao") {
        const check = validateNotesField(clean, true);
        if (!check.valid) {
          return {
            handled: true,
            replyText: check.needsTextAfterYes ? check.error : `⚠️ ${check.error}`,
          };
        }
        found.notes = check.value;
        found.updatedAt = now;
        found.updatedAtEpochMs = Date.now();
        found.updatedBy = `${who} (WhatsApp)`;
        saveZeldaActivities(list);
        clearSenderSession();
        return {
          handled: true,
          replyText: `✅ Observação da iniciativa *#${found.code}* (${found.title}) atualizada para: *${found.notes || "(em branco)"}*`,
        };
      }

      if (act === "alterar_status") {
        const check = validateStatusField(clean);
        if (!check.valid) {
          return {
            handled: true,
            replyText: `⚠️ ${check.error}\n_(Ou digite *cancelar*)_`,
          };
        }
        if ((check.value === "aprovada" || check.value === "reprovada") && isCaretaker) {
          clearSenderSession();
          return {
            handled: true,
            replyText: "🚫 O Zelador não pode aprovar ou reprovar iniciativas do Conselho.",
          };
        }
        activeSession.pendingStatus = check.value;
        activeSession.step = "ask_status_obs";
        return {
          handled: true,
          replyText: `💬 Novo status selecionado: *${STATUS_NAMES_PT[check.value]}*.\nDeseja atualizar a observação também?\n_(Envie o texto ou *-* / *Não* para manter sem alteração)_`,
        };
      }

      if (act === "em_andamento" || act === "concluir" || act === "reabrir" || act === "abrir_votacao") {
        const check = validateNotesField(clean, true);
        if (!check.valid) {
          return {
            handled: true,
            replyText: check.needsTextAfterYes ? check.error : `⚠️ ${check.error}`,
          };
        }
        const statusMap = {
          em_andamento: "em_andamento",
          concluir: "concluida",
          reabrir: "pendente",
          abrir_votacao: "em_votacao",
        };
        found.status = statusMap[act];
        if (!check.isBlank && check.value) found.notes = check.value;
        found.updatedAt = now;
        found.updatedAtEpochMs = Date.now();
        found.updatedBy = `${who} (WhatsApp)`;
        saveZeldaActivities(list);
        clearSenderSession();
        return {
          handled: true,
          replyText: `✅ Iniciativa *#${found.code}* (${found.title}) marcada como *${STATUS_NAMES_PT[found.status]}* por ${who}!${!check.isBlank && check.value ? "\n💬 Obs.: " + check.value : ""}`,
        };
      }

      if (act === "encerrar_votacao") {
        if (isCaretaker) {
          clearSenderSession();
          return {
            handled: true,
            replyText: "🚫 O Zelador não possui permissão para encerrar votações do Conselho.",
          };
        }
        const norm = normalizeTextToken(clean).replace(/[.!?,;:]+$/g, "").trim();
        let finalSt = null;
        if (/^(2|reprovar|reprovada|reprovado|nao aprovar|nao aprovo|contra)$/.test(norm)) {
          finalSt = "reprovada";
        } else if (/^(1|aprovar|aprovada|aprovado)$/.test(norm)) {
          finalSt = "aprovada";
        }
        if (!finalSt) {
          return {
            handled: true,
            replyText: `⚠️ Resposta inválida ("${clean}"). Responda apenas *1* (*Aprovar*), *2* (*Reprovar*) ou digite *cancelar*:`,
          };
        }
        found.status = finalSt;
        found.updatedAt = now;
        found.updatedAtEpochMs = Date.now();
        found.updatedBy = `${who} (Apuração WhatsApp)`;
        saveZeldaActivities(list);
        clearSenderSession();
        const tally = summarizeVotes(found);
        return {
          handled: true,
          replyText: `🗳️ Votação da iniciativa *#${found.code}* (${found.title}) encerrada como *${STATUS_NAMES_PT[finalSt]}* por ${who}.\nPlacar final: ${tally.favor} a favor · ${tally.contra} contra · ${tally.abstencao} abstenção(ões).`,
        };
      }

      if (act === "votar") {
        if (isCaretaker) {
          clearSenderSession();
          return {
            handled: true,
            replyText: "🚫 *Voto bloqueado:* O WhatsApp do Zelador não possui direito a voto nas deliberações do Conselho.",
          };
        }
        const check = validateVoteField(clean);
        if (!check.valid) {
          return {
            handled: true,
            replyText: `⚠️ ${check.error}\n_(Ou digite *cancelar*)_`,
          };
        }
        activeSession.pendingVoteChoice = check.value;
        activeSession.step = "ask_vote_note";
        return {
          handled: true,
          replyText: "Deseja registrar algum *comentário* junto ao seu voto? _(Envie o comentário ou *-* / *Não* para deixar em branco)_",
        };
      }
    }

    if (activeSession.step === "ask_status_obs") {
      const list = loadZeldaActivities();
      const found = list.find((a) => Number(a.code) === Number(activeSession.targetCode));
      if (!found) {
        clearSenderSession();
        return { handled: true, replyText: "⚠️ Iniciativa não encontrada." };
      }
      const check = validateNotesField(clean, true);
      if (!check.valid) {
        return {
          handled: true,
          replyText: check.needsTextAfterYes ? check.error : `⚠️ ${check.error}`,
        };
      }
      if (activeSession.pendingStatus) {
        found.status = activeSession.pendingStatus;
      }
      if (!check.isBlank && check.value) {
        found.notes = check.value;
      }
      found.updatedAt = nowBrasiliaLabel();
      found.updatedAtEpochMs = Date.now();
      found.updatedBy = `${who} (WhatsApp)`;
      saveZeldaActivities(list);
      clearSenderSession();
      return {
        handled: true,
        replyText: `✅ Status da iniciativa *#${found.code}* (${found.title}) alterado para *${STATUS_NAMES_PT[found.status]}* por ${who}!${!check.isBlank && check.value ? "\n💬 Obs.: " + check.value : ""}`,
      };
    }

    if (activeSession.step === "ask_vote_note") {
      if (isCaretaker) {
        clearSenderSession();
        return {
          handled: true,
          replyText: "🚫 *Voto bloqueado:* O WhatsApp do Zelador não possui direito a voto.",
        };
      }
      const list = loadZeldaActivities();
      const found = list.find((a) => Number(a.code) === Number(activeSession.targetCode));
      if (!found) {
        clearSenderSession();
        return { handled: true, replyText: "⚠️ Iniciativa não encontrada." };
      }

      const check = validateNotesField(clean, true);
      if (!check.valid) {
        return {
          handled: true,
          replyText: check.needsTextAfterYes ? check.error : `⚠️ ${check.error}`,
        };
      }

      const comment = check.value;
      const choice = activeSession.pendingVoteChoice || "favor";
      const now = nowBrasiliaLabel();
      if (!Array.isArray(found.votes)) found.votes = [];

      const voterId = senderPhone ? String(senderPhone).split("@")[0].replace(/\D+/g, "") || senderKey : senderKey;
      const existingVoteIdx = found.votes.findIndex((v) => v.voterKey === voterId);
      const voteRecord = {
        voterKey: voterId,
        voterName: who,
        choice,
        comment,
        votedAt: now,
      };
      if (existingVoteIdx >= 0) {
        found.votes[existingVoteIdx] = voteRecord;
      } else {
        found.votes.push(voteRecord);
      }

      if (found.status === "pendente") {
        found.status = "em_votacao";
      }

      const tally = summarizeVotes(found);
      let quorumMsg = "";
      if (found.status === "em_votacao" && tally.favor >= quorum) {
        found.status = "aprovada";
        quorumMsg = `\n🎉 *Quórum atingido (${tally.favor}/${quorum})!* Iniciativa *#${found.code}* passou automaticamente para *Aprovada*.`;
      }

      found.updatedAt = now;
      found.updatedAtEpochMs = Date.now();
      found.updatedBy = `${who} (Voto WhatsApp)`;
      saveZeldaActivities(list);
      clearSenderSession();

      const choiceLabel =
        choice === "favor" ? "A favor (Aprovar)" : choice === "contra" ? "Contra (Reprovar)" : "Abstenção";
      return {
        handled: true,
        replyText: `🗳️ Voto de *${who}* registrado em *#${found.code}* (${found.title}): *${choiceLabel}*${comment ? "\n💬 Comentário: " + comment : ""}\n📊 Placar: *${tally.favor}/${quorum}* a favor · *${tally.contra}* contra · *${tally.abstencao}* abstenção(ões).${quorumMsg}`,
      };
    }
  }

  clearSenderSession();
  return { handled: false, replyText: null };
}

// 4. ENVIO DA LISTA ATUALIZADA DA APLICAÇÃO DIRETO PARA O GRUPO CONFIGURADO (PARAMETRIZADO)
function normalizeToken(val) {
  return String(val || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactToken(val) {
  return String(val || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function groupNameMatchesTarget(candidateName, rawTarget) {
  const nSub = normalizeToken(candidateName);
  const cSub = compactToken(candidateName);
  const nTarget = normalizeToken(rawTarget);
  const cTarget = compactToken(rawTarget);
  if (nSub && nTarget && (nSub === nTarget || nSub.includes(nTarget) || nTarget.includes(nSub))) {
    return true;
  }
  if (cSub.length >= 3 && cTarget.length >= 3 && (cSub === cTarget || cSub.includes(cTarget) || cTarget.includes(cSub))) {
    return true;
  }
  return false;
}

async function resolveConfiguredGroupJid(clientOrSock, targetGroupConfig) {
  const targets = String(targetGroupConfig || "")
    .split(/[,;\n]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (targets.length === 0) return null;

  for (const t of targets) {
    if (t.endsWith("@g.us")) return t;
  }

  // 1) Verifica cache persistido de grupos descobertos
  const cachedGroups = getDiscoveredGroups();
  for (const t of targets) {
    for (const cg of cachedGroups) {
      if (cg && cg.jid && groupNameMatchesTarget(cg.name || "", t)) {
        return cg.jid;
      }
    }
  }

  try {
    // 2) whatsapp-web.js
    if (typeof clientOrSock.getChats === "function") {
      const chats = await clientOrSock.getChats();
      for (const ch of chats || []) {
        const jid = ch?.id?._serialized || (typeof ch?.id === "string" ? ch.id : "");
        if (!jid.endsWith("@g.us")) continue;
        const gName = String(ch.name || ch.formattedTitle || ch.subject || "");
        if (gName) recordDiscoveredGroup(jid, gName);
        for (const t of targets) {
          if (groupNameMatchesTarget(gName, t)) return jid;
        }
      }
    }
    // 3) WPPConnect / Venom
    if (typeof clientOrSock.listChats === "function") {
      const chats = await clientOrSock.listChats({ onlyGroups: true }).catch(() => []);
      for (const ch of chats || []) {
        const jid = ch?.id?._serialized || (typeof ch?.id === "string" ? ch.id : "");
        if (!jid.endsWith("@g.us")) continue;
        const gName = String(ch.name || ch.formattedTitle || ch.contact?.name || "");
        if (gName) recordDiscoveredGroup(jid, gName);
        for (const t of targets) {
          if (groupNameMatchesTarget(gName, t)) return jid;
        }
      }
    } else if (typeof clientOrSock.getAllGroups === "function") {
      const groups = await clientOrSock.getAllGroups().catch(() => []);
      for (const ch of groups || []) {
        const jid = ch?.id?._serialized || (typeof ch?.id === "string" ? ch.id : "");
        if (!jid.endsWith("@g.us")) continue;
        const gName = String(ch.name || ch.formattedTitle || ch.contact?.name || "");
        if (gName) recordDiscoveredGroup(jid, gName);
        for (const t of targets) {
          if (groupNameMatchesTarget(gName, t)) return jid;
        }
      }
    }
    // 4) Baileys
    if (typeof clientOrSock.groupFetchAllParticipating === "function") {
      const map = await clientOrSock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(map || {})) {
        const gName = String(meta && meta.subject ? meta.subject : "");
        if (gName) recordDiscoveredGroup(jid, gName);
        for (const t of targets) {
          if (groupNameMatchesTarget(gName, t)) return jid;
        }
      }
    }
  } catch (_e) {}
  return null;
}

function enqueueGroupOutboxMessage(text, targetGroupOverride = "") {
  const files = getDataFiles();
  let queue = [];
  try {
    if (fs.existsSync(files.outboxPrimary)) {
      queue = JSON.parse(fs.readFileSync(files.outboxPrimary, "utf-8"));
      if (!Array.isArray(queue)) queue = [];
    }
  } catch (_e) {}
  queue.push({
    id: `out-${Date.now()}`,
    targetGroup: String(targetGroupOverride || ""),
    text: String(text || ""),
    sent: false,
    createdAt: Date.now(),
  });
  writeJsonTargets([files.outboxPrimary, files.outboxAppData, files.outboxResApp], queue);
  return { queued: true, connected: runtimeConnected };
}

async function flushOutboxIfConnected() {
  if (!runtimeConnected || !activeClientRef) return;
  const files = getDataFiles();
  const outboxCandidates = pickExistingSortedByMtime(files.outboxAll);
  if (outboxCandidates.length === 0) return;
  let queue = [];
  try {
    queue = JSON.parse(fs.readFileSync(outboxCandidates[0], "utf-8"));
    if (!Array.isArray(queue) || queue.length === 0) return;
  } catch (_e) {
    return;
  }

  const pendingIdx = queue.findIndex((it) => it && it.text && it.sent !== true);
  if (pendingIdx < 0) {
    if (queue.length > 0) writeJsonTargets([files.outboxPrimary, files.outboxAppData, files.outboxResApp], []);
    return;
  }

  const item = queue[pendingIdx];
  const settings = getClinicSettings();
  const desiredGroup = String(item.targetGroup || settings.zeldaGroupTarget || "").trim();
  if (!desiredGroup) return;
  const groupJid = await resolveConfiguredGroupJid(activeClientRef, desiredGroup);
  if (!groupJid) return;

  queue.splice(pendingIdx, 1);
  writeJsonTargets([files.outboxPrimary, files.outboxAppData, files.outboxResApp], queue);

  if (item && item.text) {
    try {
      await simulateHumanReactionAndTyping(activeClientRef, groupJid, false);
      const cleanOut = String(item.text).trim();
      registerZeldaSentReply(cleanOut);
      const safeOut = cleanOut + ZELDA_LOOP_MARKER;
      if (activeClientRef.ev && typeof activeClientRef.sendMessage === "function") {
        await activeClientRef.sendMessage(groupJid, { text: safeOut });
      } else if (typeof activeClientRef.sendText === "function" && !activeClientRef.pupPage) {
        await activeClientRef.sendText(groupJid, safeOut);
      } else if (typeof activeClientRef.sendMessage === "function") {
        const sendFn = activeClientRef.__serenaOrigSendMessage
          ? activeClientRef.__serenaOrigSendMessage.bind(activeClientRef)
          : activeClientRef.sendMessage.bind(activeClientRef);
        try {
          await sendFn(groupJid, safeOut, { sendSeen: false });
        } catch (_seenErr) {
          await sendFn(groupJid, safeOut);
        }
      }
    } catch (_err) {}
  }
}

function popNextOutboxItemForWebBridge() {
  try {
    if (activeClientRef) return null;
    const files = getDataFiles();
    const outboxCandidates = pickExistingSortedByMtime(files.outboxAll);
    if (outboxCandidates.length === 0) return null;
    const queue = JSON.parse(fs.readFileSync(outboxCandidates[0], "utf-8"));
    if (!Array.isArray(queue) || queue.length === 0) return null;
    const pendingIdx = queue.findIndex((it) => it && it.text && it.sent !== true);
    if (pendingIdx < 0) {
      if (queue.length > 0) writeJsonTargets([files.outboxPrimary, files.outboxAppData, files.outboxResApp], []);
      return null;
    }
    const item = queue[pendingIdx];
    const settings = getClinicSettings();
    const desiredGroup = String(item.targetGroup || settings.zeldaGroupTarget || "").trim();
    if (!desiredGroup) return null;
    queue.splice(pendingIdx, 1);
    writeJsonTargets([files.outboxPrimary, files.outboxAppData, files.outboxResApp], queue);
    return {
      targetGroup: desiredGroup,
      text: String(item.text || "").trim(),
    };
  } catch (_e) {
    return null;
  }
}

function attachConnectionMonitor(clientOrSock) {
  if (!clientOrSock) return;
  activeClientRef = clientOrSock;
  if (clientOrSock.__zeldaConnMonitorAttached) return;
  clientOrSock.__zeldaConnMonitorAttached = true;

  const alreadyWwebConnected = Boolean(clientOrSock.info && clientOrSock.info.wid);
  const alreadyBaileysConnected = Boolean(clientOrSock.user && clientOrSock.user.id);
  if (alreadyWwebConnected || alreadyBaileysConnected) {
    const ph = clientOrSock.info?.wid?.user || clientOrSock.user?.id || "";
    persistConnectionStatus(true, "connected", ph, true);
  } else {
    initConnectionStatusIfMissing();
    if (typeof clientOrSock.getState === "function") {
      Promise.resolve()
        .then(() => clientOrSock.getState())
        .then((st) => {
          if (String(st || "").toUpperCase() === "CONNECTED") {
            persistConnectionStatus(true, "connected", clientOrSock.info?.wid?.user || "", true);
          }
        })
        .catch(() => {});
    }
  }

  if (typeof clientOrSock.on === "function") {
    clientOrSock.on("qr", () => persistConnectionStatus(false, "disconnected", "", true));
    clientOrSock.on("authenticated", () => persistConnectionStatus(false, "connecting", "", true));
    clientOrSock.on("ready", () => {
      const ph = clientOrSock.info?.wid?.user || "";
      persistConnectionStatus(true, "connected", ph, true);
    });
    clientOrSock.on("message", () => {
      markWhatsAppActivityOnline(clientOrSock.info?.wid?.user || "");
    });
    clientOrSock.on("message_create", () => {
      markWhatsAppActivityOnline(clientOrSock.info?.wid?.user || "");
    });
    clientOrSock.on("change_state", (state) => {
      const st = String(state || "").toUpperCase();
      if (st === "CONNECTED") {
        persistConnectionStatus(true, "connected", clientOrSock.info?.wid?.user || "", true);
      } else if (st === "UNPAIRED" || st === "UNLAUNCHED" || st === "CONFLICT") {
        persistConnectionStatus(false, "disconnected", "", true);
      }
    });
    clientOrSock.on("disconnected", () => persistConnectionStatus(false, "disconnected", "", true));
    clientOrSock.on("auth_failure", () => persistConnectionStatus(false, "disconnected", "", true));
  }

  if (clientOrSock.ev && typeof clientOrSock.ev.on === "function") {
    clientOrSock.ev.on("connection.update", (upd) => {
      if (!upd) return;
      if (upd.connection === "open") {
        persistConnectionStatus(true, "connected", clientOrSock.user?.id || "", true);
      } else if (upd.connection === "connecting") {
        persistConnectionStatus(false, "connecting", "", true);
      } else if (upd.connection === "close") {
        persistConnectionStatus(false, "disconnected", "", true);
      }
    });
    clientOrSock.ev.on("messages.upsert", () => {
      markWhatsAppActivityOnline(clientOrSock.user?.id || "");
    });
  }

  if (typeof clientOrSock.onStateChange === "function") {
    try {
      clientOrSock.onStateChange((state) => {
        const st = String(state || "").toUpperCase();
        if (st === "CONNECTED" || st === "MAIN") {
          persistConnectionStatus(true, "connected", "", true);
        } else if (st === "UNPAIRED" || st === "DISCONNECTED") {
          persistConnectionStatus(false, "disconnected", "", true);
        }
      });
    } catch (_e) {}
  }

  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      if (runtimeConnected) {
        persistConnectionStatus(true, "connected", runtimePhone, true);
      } else if (activeClientRef) {
        const wwebOk = Boolean(activeClientRef.info && activeClientRef.info.wid);
        const baileysOk = Boolean(activeClientRef.user && activeClientRef.user.id);
        if (wwebOk || baileysOk) {
          const ph = activeClientRef.info?.wid?.user || activeClientRef.user?.id || "";
          persistConnectionStatus(true, "connected", ph, true);
        }
      }
    }, 45000);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  }

  if (!outboxTimer) {
    outboxTimer = setInterval(() => {
      flushOutboxIfConnected().catch(() => {});
    }, 4500);
    if (typeof outboxTimer.unref === "function") outboxTimer.unref();
  }
}

// Preserva status conectado existente; cria desconectado apenas se o arquivo ainda não existir
initConnectionStatusIfMissing();

process.on("exit", () => {
  try { persistConnectionStatus(false, "disconnected", "", true); } catch (_e) {}
});

module.exports = {
  ZELDA_LOOP_MARKER,
  registerZeldaSentReply,
  isZeldaOwnFormattedReply,
  isZeldaSelfEcho,
  parseZeldaTrigger,
  getWhatsAppConnectionStatus,
  persistConnectionStatus,
  markWhatsAppActivityOnline,
  loadZeldaActivities,
  saveZeldaActivities,
  addZeldaActivity,
  updateZeldaActivity,
  deleteZeldaActivity,
  loadActivities: loadZeldaActivities,
  saveActivities: saveZeldaActivities,
  addActivity: addZeldaActivity,
  updateActivity: updateZeldaActivity,
  deleteActivity: deleteZeldaActivity,
  formatPendenciesListText,
  handleZeldaCondominioCommand,
  enqueueGroupOutboxMessage,
  enqueueGroupMessage: enqueueGroupOutboxMessage,
  popNextOutboxItemForWebBridge,
  attachConnectionMonitor,
  recordDiscoveredGroup,
  getDiscoveredGroups,
  loadDiscoveredGroups: getDiscoveredGroups,
  recordZeldaGroupDebug,
  getZeldaGroupDebugLog,
  loadZeldaGroupDebug: getZeldaGroupDebugLog,
  validateTitleField,
  validateAreaField,
  validateResponsibleField,
  validateDueDateField,
  validatePriorityField,
  validateStatusField,
  validateVoteField,
  validateNotesField,
  validateCompleteActivityPayload,
};

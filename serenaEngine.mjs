// serenaEngine.mjs — Motor Serena v2 Custo Zero (100% Dinâmico via pasta configuracoes/)
// Regras Oficiais:
// - Nome da Clínica e Endereço lidos DINAMICAMENTE de configuracoes/configManager.cjs
// - Fuso Horário Oficial do Brasil (Brasília - America/Sao_Paulo / BRT)
// - Expediente: Seg-Sex 08:00 às 18:00 (último slot 17:30) e Sábados 08:00 às 13:00 (último slot 12:30)
// - Avaliação 100% GRATUITA (30 min) com RX Panorâmico + Escaneamento 5D

process.env.TZ = "America/Sao_Paulo";

import fs from "node:fs";
import path from "node:path";
import configManager from "./configuracoes/configManager.cjs";
const { resolveWritableDataDir, getClinicSettings, saveClinicSettings } = configManager;

const BRASILIA_TZ = "America/Sao_Paulo";
const DB_FILE = path.join(resolveWritableDataDir(), "serena-db.json");

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Normaliza o JID/telefone para garantir chave única por paciente (E.164 puro: ex 5511996202504)
 * Elimina a duplicidade de IDs internos/fictícios no JSON.
 */
function normalizePhoneKey(jid) {
  if (!jid) return "";
  let clean = String(jid).replace(/\D/g, "");
  
  // Trata números sem DDI do Brasil (10 ou 11 dígitos)
  if ((clean.length === 10 || clean.length === 11) && !clean.startsWith("55")) {
    clean = "55" + clean;
  }
  
  return clean || String(jid);
}

function getBrasiliaParts(dateObj = new Date()) {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: BRASILIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dateObj);

  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  const year = Number(get("year"));
  const month = get("month");
  const day = get("day");
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekdayRaw = get("weekday").toLowerCase();

  let weekdayIndex = 1;
  if (weekdayRaw.startsWith("dom")) weekdayIndex = 0;
  else if (weekdayRaw.startsWith("seg")) weekdayIndex = 1;
  else if (weekdayRaw.startsWith("ter")) weekdayIndex = 2;
  else if (weekdayRaw.startsWith("qua")) weekdayIndex = 3;
  else if (weekdayRaw.startsWith("qui")) weekdayIndex = 4;
  else if (weekdayRaw.startsWith("sex")) weekdayIndex = 5;
  else if (weekdayRaw.startsWith("sáb") || weekdayRaw.startsWith("sab")) weekdayIndex = 6;

  const weekdayTitle =
    weekdayRaw.charAt(0).toUpperCase() + weekdayRaw.slice(1).replace("-feira", "");

  return {
    isoDate: `${year}-${month}-${day}`,
    ddmm: `${day}/${month}`,
    hour,
    minute,
    hhmm: `${pad2(hour)}:${pad2(minute)}`,
    weekdayIndex,
    weekdayTitle,
  };
}

function isWithinClinicHoursBrasilia(dateObj = new Date()) {
  const { weekdayIndex, hour, minute } = getBrasiliaParts(dateObj);
  const totalMin = hour * 60 + minute;
  if (weekdayIndex === 0) return false;
  if (weekdayIndex === 6) return totalMin >= 8 * 60 && totalMin < 13 * 60;
  return totalMin >= 8 * 60 && totalMin < 18 * 60;
}

function buildDefault30MinSchedule() {
  const slots = [];
  const nowBrt = getBrasiliaParts(new Date());
  const nowMinutesBrt = nowBrt.hour * 60 + nowBrt.minute;

  for (let offsetDays = 0; offsetDays <= 6; offsetDays++) {
    const targetDate = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
    const d = getBrasiliaParts(targetDate);
    if (d.weekdayIndex === 0) continue;

    const isSaturday = d.weekdayIndex === 6;
    const startHour = 8;
    const endHour = isSaturday ? 13 : 18;
    const dayPrefix =
      offsetDays === 0
        ? `Hoje (${d.ddmm})`
        : offsetDays === 1
        ? `Amanhã (${d.weekdayTitle} ${d.ddmm})`
        : `${d.weekdayTitle} (${d.ddmm})`;

    for (let h = startHour; h < endHour; h++) {
      for (const m of [0, 30]) {
        const slotStartMin = h * 60 + m;
        if (offsetDays === 0 && slotStartMin <= nowMinutesBrt + 20) continue;
        const startTime = `${pad2(h)}:${pad2(m)}`;
        const endTotal = slotStartMin + 30;
        const endTime = `${pad2(Math.floor(endTotal / 60))}:${pad2(endTotal % 60)}`;
        slots.push({
          id: `${d.isoDate}-${startTime.replace(":", "")}`,
          isoDate: d.isoDate,
          offsetDays,
          dayLabel: dayPrefix,
          isSaturday,
          startTime,
          endTime,
          label: `${dayPrefix} às ${startTime}`,
          period: h < 12 ? "manha" : "tarde",
          bookedBy: null,
        });
      }
    }
  }
  return slots;
}

// REGEXES DE TRIAGEM, INTENÇÃO E COMANDOS DA CRC
const PAUSE_COMMAND_REGEX = /^#(pausar|pausa|silenciar|assumir)\b/i;
const RESUME_COMMAND_REGEX = /^#(retomar|voltar|despausar|bot)\b/i;
const URGENCY_REGEX = /\b(dor|doendo|quebr\w+|inchad\w+|inchaço|sangr\w+|emerg[eê]ncia|urg[eê]ncia|canal|siso)\b/i;
const HANDOFF_REGEX = /\b(falar com atendente|atendente humano|falar com humano|recepcionista real|reclama[cç][aã]o|reembolso)\b/i;
const CANCEL_REGEX = /\b(cancelar|desmarcar|n[aã]o vou poder|n[aã]o poderei|anular)\b/i;
const LOCATION_REGEX = /\b(endere[cç]o|onde fica|localiza[cç][aã]o|como chegar|qual a rua|qual o bairro|estacionamento|nome da cl[ií]nica|qual cl[ií]nica)\b/i;
const PORTO_SEGURO_REGEX = /\b(porto\s*seguro|odonto\s*porto|porto\s*odonto)\b/i;
const OTHER_INSURANCE_REGEX = /\b(amil|bradesco|odontoprev|sulam[eé]rica|unimed|metlife|hapvida|interodonto|dental\s*uni|inpao|bb\s*dental)\b/i;
const GENERIC_INSURANCE_REGEX = /\b(conv[eê]nio\w*|plano\s*odontol[oó]gico|aceita\w*\s+plano|quais\s+planos)\b/i;
const PARTICULAR_REGEX = /\b(particular|sem plano|sem conv[eê]nio)\b/i;
const EVAL_PRICE_REGEX = /\b((valor|pre[cç]o|custa|paga\w*).*(avalia[cç][aã]o|consulta)|(avalia[cç][aã]o|consulta).*(valor|pre[cç]o|custa|paga\w*))\b/i;
const TREATMENT_PRICE_REGEX = /\b(pre[cç]o|valor|valores|quanto custa|quanto fica|or[cç]amento|parcela\w*)\b/i;

// DATAS E PROCEDIMENTOS
const SATURDAY_REGEX = /\b(s[aá]bado|sabado)\b/i;
const SUNDAY_REGEX = /\b(domingo)\b/i;
const TOMORROW_REGEX = /\b(amanh[aã])\b/i;
const TODAY_REGEX = /\b(hoje)\b/i;
const PROCEDURE_REGEX = /\b(implante\w*|limpeza|aparelho|pr[oó]tese|facetas?|lentes?|extrac[aã]o|restaura[cç][aã]o|clareamento|ortodontia|canal)\b/i;
const MORNING_REGEX = /\b(manh[aã]|cedo|08[:h]?|09[:h]?|10[:h]?|11[:h]?)\b/i;
const AFTERNOON_REGEX = /\b(tarde|13[:h]?|14[:h]?|15[:h]?|16[:h]?|17[:h]?)\b/i;
const AFFIRMATIVE_REGEX = /\b(sim|pode|quero|com certeza|bora|pode ser|ok|blz|fechado)\b/i;
const OBJECTION_SLOT_REGEX = /\b(outro|outra|muda|troca|n[aã]o posso|n[aã]o d[aá]|mais tarde|mais cedo|outro dia|outra data|diferente)\b/i;

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { leads: {}, slots: buildDefault30MinSchedule() };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  if (!Array.isArray(parsed.slots) || parsed.slots.length === 0) {
    parsed.slots = buildDefault30MinSchedule();
  }
  return parsed;
}

function saveDb(db) {
  const tmpFile = DB_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2));
  fs.renameSync(tmpFile, DB_FILE);
}

function calculateAntiBanDelayMs(text) {
  const cfg = getClinicSettings();
  const minMs = Number(cfg.typingDelayMinMs || 3200);
  const maxMs = Number(cfg.typingDelayMaxMs || 5600);
  const ratio = Math.min(1, String(text || "").length / 260);
  return Math.round(minMs + ratio * (maxMs - minMs));
}

let bookingLock = Promise.resolve();
function withScheduleLock(fn) {
  const next = bookingLock.then(fn, fn);
  bookingLock = next.then(() => undefined, () => undefined);
  return next;
}

function normalizeTime(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/(\d{1,2})h(\d{2})/g, (_, h, m) => `${pad2(Number(h))}:${m}`)
    .replace(/(\d{1,2})h\b/g, (_, h) => `${pad2(Number(h))}:00`)
    .replace(/\b(\d):(\d{2})\b/g, "0$1:$2");
}

function pushUniqueDate(arr = [], isoDate) {
  if (!arr.includes(isoDate)) arr.push(isoDate);
  return arr;
}

/**
 * Funçao para Zerar/Resetar o Banco de Leads e Horarios (Chamada via API/Painel de Configurações)
 * Preserva 100% das configurações da clínica lidas via configManager.cjs
 */
async function resetDatabase() {
  return withScheduleLock(async () => {
    const freshDb = {
      leads: {},
      slots: buildDefault30MinSchedule(),
    };
    saveDb(freshDb);
    return { success: true, message: "Banco de dados e histórico de estatísticas zerados com sucesso!" };
  });
}

/**
 * Varredura Automática de Follow-up (Resgate em 20 min) e Timeout de SLA (Perda por inatividade em 24h)
 */
async function checkAndSendFollowups(sendMessageCallback) {
  const db = loadDb();
  const now = Date.now();
  const TWENTY_MINUTES_MS = 20 * 60 * 1000;
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
  const todayIso = getBrasiliaParts(new Date()).isoDate;
  let updated = false;

  for (const jid of Object.keys(db.leads)) {
    const lead = db.leads[jid];

    // Se o atendimento foi assumido por um humano/CRC, ignora automações de timeout
    if (lead.stage === "TRANSBORDO_HUMANO" || lead.crcAssumiu === true || lead.botPaused === true) {
      continue;
    }

    // 1. DISPARO DE FOLLOW-UP EM 20 MINUTOS
    if (
      lead.stage === "OFERTA_HORARIOS" &&
      !lead.followupSent &&
      lead.lastPatientAt &&
      (now - lead.lastPatientAt) > TWENTY_MINUTES_MS
    ) {
      const cfg = getClinicSettings();
      const greetName = lead.name ? `, ${lead.name}` : "";
      const followupMsg = `Oi${greetName}! Passando só para saber se conseguiu dar uma olhadinha nas opções de horário que te mandei acima? 😊\n\nSe preferir outro dia ou horário na ${cfg.clinicName}, é só me avisar que busco aqui para você!`;

      if (typeof sendMessageCallback === "function") {
        try {
          await sendMessageCallback(lead.jid || lead.phone, followupMsg);
        } catch (_err) {}
      }

      lead.followupSent = true;
      lead.stage = "FOLLOWUP_ENVIADO";
      lead.followupDates = pushUniqueDate(lead.followupDates, todayIso);
      updated = true;
    }

    // 2. TIMEOUT DE SLA APÓS 24H (MARCA COMO PERDIDO POR SEM RESPOSTA DA OFERTA)
    if (
      (lead.stage === "OFERTA_HORARIOS" || lead.stage === "FOLLOWUP_ENVIADO") &&
      lead.status !== "perdido" &&
      lead.status !== "agendado" &&
      lead.lastPatientAt &&
      (now - lead.lastPatientAt) > TWENTY_FOUR_HOURS_MS
    ) {
      lead.status = "perdido";
      lead.motivoPerda = "sem_resposta";
      lead.lostDates = pushUniqueDate(lead.lostDates, todayIso);
      updated = true;
    }
  }

  if (updated) saveDb(db);
}

async function handleIncomingWhatsAppMessage(rawJid, rawText) {
  return withScheduleLock(async () => {
    const text = String(rawText || "").trim();
    if (!text) return null;

    const phoneKey = normalizePhoneKey(rawJid);
    const cfg = getClinicSettings();
    const clinicName = cfg.clinicName;
    const clinicAddress = cfg.clinicAddress;
    const parkingSuffix = cfg.parkingInfo ? ` (${cfg.parkingInfo})` : "";

    const db = loadDb();
    const nowParts = getBrasiliaParts(new Date());

    // CRIAÇÃO E NORMALIZAÇÃO DO LEAD COM TELEMETRIA COMPLETA
    if (!db.leads[phoneKey]) {
      db.leads[phoneKey] = {
        jid: phoneKey,
        phone: phoneKey,
        name: "",
        modality: "Não informado",
        procedure: "Avaliação Geral",
        stage: "ACOLHIMENTO",
        status: "recebido",
        origem: "whatsapp",
        interesse: "avaliacao",
        motivoPerda: null,
        pacienteExistente: false,
        consentimentoLgpd: true,
        crcAssumiu: false,
        botPaused: false,
        lastOfferedSlots: [],
        scheduledSlot: null,
        lastPatientAt: Date.now(),
        lastPatientBrt: nowParts.hhmm,
        firstSeenDate: nowParts.isoDate,
        lastInboundDate: nowParts.isoDate,
        inboundDates: [nowParts.isoDate],
        repliedDates: [],
        qualifiedDates: [],
        offeredDates: [],
        bookedDates: [],
        followupDates: [],
        handoffDates: [],
        lostDates: [],
        inboundCountByDate: { [nowParts.isoDate]: 1 },
        repliedCountByDate: {},
        followupSent: false
      };
    }

    const lead = db.leads[phoneKey];
    lead.phone = phoneKey; // Garante a chave real E.164
    lead.lastPatientAt = Date.now();
    lead.lastPatientBrt = nowParts.hhmm;
    lead.lastInboundDate = nowParts.isoDate;
    lead.inboundDates = pushUniqueDate(lead.inboundDates, nowParts.isoDate);
    lead.inboundCountByDate[nowParts.isoDate] = (lead.inboundCountByDate[nowParts.isoDate] || 0) + 1;

    // ------------------------------------------------------------------------
    // COMANDOS INTERNOS DA CRC / RECEPÇÃO (ENVIADOS DIRETO DO CELULAR/WHATSAPP)
    // ------------------------------------------------------------------------
    if (PAUSE_COMMAND_REGEX.test(text)) {
      lead.stage = "TRANSBORDO_HUMANO";
      lead.crcAssumiu = true;
      lead.botPaused = true;
      lead.status = "atendimento_humano";
      saveDb(db);
      return `🛑 *[Serena Pausada]* Atendimento assumido pela CRC/Recepção. Para reativar o bot nesta conversa, digite *#retomar*.`;
    }

    if (RESUME_COMMAND_REGEX.test(text)) {
      lead.crcAssumiu = false;
      lead.botPaused = false;
      lead.stage = "ACOLHIMENTO";
      lead.status = "engajado";
      saveDb(db);
      return `🤖 *[Serena Reativada]* O atendimento automático da Serena foi reativado para este paciente.`;
    }

    // TRAVA ABSOLUTA: Se a conversa foi pausada (por comando ou transbordo), a Serena silencia totalmente!
    if (lead.stage === "TRANSBORDO_HUMANO" || lead.crcAssumiu === true || lead.botPaused === true) {
      saveDb(db);
      return null;
    }

    lead.repliedDates = pushUniqueDate(lead.repliedDates, nowParts.isoDate);
    lead.repliedCountByDate[nowParts.isoDate] = (lead.repliedCountByDate[nowParts.isoDate] || 0) + 1;

    const nameMatch = text.match(/(?:me chamo|meu nome [eé]|sou o|sou a)\s+([A-ZÀ-Úa-zà-ú]+)/i);
    if (nameMatch && nameMatch[1]) lead.name = nameMatch[1];
    const greetName = lead.name ? `, ${lead.name}` : "";

    // Captura procedimento se mencionado (ex: "Implante")
    const procMatch = text.match(PROCEDURE_REGEX);
    if (procMatch) {
      lead.procedure = procMatch[0].charAt(0).toUpperCase() + procMatch[0].slice(1).toLowerCase();
      lead.interesse = lead.procedure.toLowerCase();
    }

    // QUALIFICAÇÃO AUTOMÁTICA
    if (lead.status === "recebido" || lead.status === "engajado") {
      lead.status = "qualificado";
      lead.qualifiedDates = pushUniqueDate(lead.qualifiedDates, nowParts.isoDate);
    }

    // CANCELAMENTO DE CONSULTA PELO CLIENTE
    if (CANCEL_REGEX.test(text) && lead.stage === "AGENDADO") {
      for (const slot of db.slots) {
        if (slot.bookedBy === phoneKey) slot.bookedBy = null;
      }
      lead.stage = "OFERTA_HORARIOS";
      lead.status = "perdido";
      lead.motivoPerda = "cancelamento_cliente";
      lead.lostDates = pushUniqueDate(lead.lostDates, nowParts.isoDate);
      
      const openSlots = db.slots.filter((s) => !s.bookedBy);
      const pair = openSlots.slice(0, 2);
      lead.lastOfferedSlots = pair.map((s) => s.id);
      saveDb(db);

      return `Poxa, que pena que não poderá comparecer no horário agendado${greetName}! 🥺 Mas sem problemas, cancelamento realizado.\n\nPara não deixar os seus cuidados com os dentes para depois, quer reagendar para uma dessas duas opções:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual fica melhor para você?`;
    }

    // PEDIDO DIRETO DE ATENDIMENTO HUMANO / CRC
    if (HANDOFF_REGEX.test(text)) {
      lead.stage = "TRANSBORDO_HUMANO";
      lead.status = "atendimento_humano";
      lead.crcAssumiu = true;
      lead.botPaused = true;
      lead.handoffDates = pushUniqueDate(lead.handoffDates, nowParts.isoDate);
      saveDb(db);
      return `Claro${greetName}! Com certeza! Já chamei nossa recepcionista da ${clinicName} para continuar seu atendimento pessoalmente por aqui. Só um instante que ela já vai te responder! 🙏`;
    }

    const norm = normalizeTime(text);
    const openSlots = db.slots.filter((s) => !s.bookedBy);

    // 1. CHECAGEM DE SELEÇÃO POR NÚMERO (1, 2 ou Opção 1, Opção 2)
    if ((lead.stage === "OFERTA_HORARIOS" || lead.stage === "FOLLOWUP_ENVIADO") && Array.isArray(lead.lastOfferedSlots) && lead.lastOfferedSlots.length > 0) {
      const optionMatch = norm.match(/\b(?:op[cç][aã]o\s*)?([12])\b/i);
      if (optionMatch) {
        const index = Number(optionMatch[1]) - 1;
        const selectedId = lead.lastOfferedSlots[index];
        const requested = db.slots.find((s) => s.id === selectedId && !s.bookedBy);

        if (requested) {
          for (const prev of db.slots) {
            if (prev.bookedBy === phoneKey) prev.bookedBy = null;
          }
          requested.bookedBy = phoneKey;
          lead.scheduledSlot = `${requested.label} (30 min · BRT)`;
          lead.stage = "AGENDADO";
          lead.status = "agendado";
          lead.motivoPerda = null;
          lead.bookedDates = pushUniqueDate(lead.bookedDates, nowParts.isoDate);
          saveDb(db);
          return `Maravilha, confirmado${greetName}! 🎉 Sua avaliação de **${lead.procedure}** na ${clinicName} (com RX Panorâmico + Escaneamento 5D inclusos) foi reservada para **${requested.label}**.\n\n📍 Endereço: ${clinicAddress}${parkingSuffix}.\n\nNa véspera te enviamos um lembrete por aqui. Estamos te esperando com muito carinho! 😊`;
        }
      }
    }

    // 2. CHECAGEM DE SELEÇÃO POR HORÁRIO ESPECÍFICO (ex: 14:00, 09:30, 9h)
    const timeMatch = norm.match(/\b(\d{2}):(\d{2})\b/);
    if (timeMatch) {
      const targetTime = `${timeMatch[1]}:${timeMatch[2]}`;
      const candidates = openSlots.filter((s) => s.startTime === targetTime);
      
      let requested = null;
      if (Array.isArray(lead.lastOfferedSlots) && lead.lastOfferedSlots.length > 0) {
        requested = candidates.find((s) => lead.lastOfferedSlots.includes(s.id));
      }
      if (!requested) requested = candidates[0];

      if (requested) {
        for (const prev of db.slots) {
          if (prev.bookedBy === phoneKey) prev.bookedBy = null;
        }
        requested.bookedBy = phoneKey;
        lead.scheduledSlot = `${requested.label} (30 min · BRT)`;
        lead.stage = "AGENDADO";
        lead.status = "agendado";
        lead.motivoPerda = null;
        lead.bookedDates = pushUniqueDate(lead.bookedDates, nowParts.isoDate);
        saveDb(db);
        return `Maravilha, confirmado${greetName}! 🎉 Sua avaliação de **${lead.procedure}** na ${clinicName} (com RX Panorâmico + Escaneamento 5D inclusos) foi reservada para **${requested.label}**.\n\n📍 Endereço: ${clinicAddress}${parkingSuffix}.\n\nNa véspera te enviamos um lembrete por aqui. Qualquer dúvida é só chamar! 😊`;
      }
    }

    // Funções auxiliares para registrar a etapa de oferta de horários
    const setOfferedStage = (pairSlots) => {
      lead.stage = "OFERTA_HORARIOS";
      lead.status = "agendamento_oferecido";
      lead.lastOfferedSlots = pairSlots.map((s) => s.id);
      lead.offeredDates = pushUniqueDate(lead.offeredDates, nowParts.isoDate);
    };

    // 3. TRATAMENTO DE OBJEÇÃO DE HORÁRIO / PEDIDO DE TROCA DE DATA
    if ((lead.stage === "OFERTA_HORARIOS" || lead.stage === "FOLLOWUP_ENVIADO") && OBJECTION_SLOT_REGEX.test(norm)) {
      const nextSlots = openSlots.filter((s) => !lead.lastOfferedSlots.includes(s.id)).slice(0, 2);
      const pair = nextSlots.length >= 2 ? nextSlots : openSlots.slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Com certeza${greetName}, sem problemas! Vamos encontrar um horário que fique perfeito para você. Que tal essas duas opções na ${clinicName}:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nAlgum desses fica melhor para a sua rotina?`;
    }

    // URGÊNCIA / DOR
    if (URGENCY_REGEX.test(text)) {
      const pair = openSlots.slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Poxa, sinto muito por estar passando por esse incômodo${greetName}! 🥺 Vamos priorizar seu atendimento aqui na ${clinicName} para te ajudar o quanto antes. Nossa avaliação de 30 min com RX Panorâmico é 100% gratuita.\n\nConsegue vir em qual destes horários:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual opção fica melhor para encaixar você hoje?`;
    }

    // DIA DOMINGO
    if (SUNDAY_REGEX.test(norm)) {
      const pair = openSlots.slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Aos domingos a ${clinicName} permanece fechada para descanso da equipe 😊 Mas atendemos de Segunda a Sexta (08h às 18h) e Sábados (08h às 13h). Tenho disponível para agendar:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual dessas opções prefere (1 ou 2)?`;
    }

    // DIA SÁBADO
    if (SATURDAY_REGEX.test(norm)) {
      const satOpen = openSlots.filter((s) => s.isSaturday).slice(0, 2);
      const pair = satOpen.length > 0 ? satOpen : openSlots.slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Perfeito! Aos sábados na ${clinicName} atendemos das 08:00 às 13:00! 😊 Tenho estas opções vagas para a sua avaliação de **${lead.procedure}**:\n\n1️⃣ ${pair[0]?.label}\n${pair[1] ? `2️⃣ ${pair[1].label}\n` : ""}\nQual dessas fica melhor para você?`;
    }

    // AMANHÃ
    if (TOMORROW_REGEX.test(norm)) {
      const tomorrowSlots = openSlots.filter((s) => s.offsetDays === 1);
      const pair = (tomorrowSlots.length >= 2 ? tomorrowSlots : openSlots).slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Ótimo${greetName}! Para amanhã (${pair[0]?.dayLabel}), separei estes dois horários para a sua avaliação de **${lead.procedure}**:\n\n1️⃣ Opção 1: às ${pair[0]?.startTime}\n2️⃣ Opção 2: às ${pair[1]?.startTime}\n\nDigite 1 ou 2 para escolher a melhor opção!`;
    }

    // HOJE
    if (TODAY_REGEX.test(norm)) {
      const todaySlots = openSlots.filter((s) => s.offsetDays === 0);
      if (todaySlots.length > 0) {
        const pair = todaySlots.slice(0, 2);
        setOfferedStage(pair);
        saveDb(db);
        return `Com certeza${greetName}! Para hoje mesmo, ainda temos vagas disponíveis na ${clinicName}:\n\n1️⃣ às ${pair[0]?.startTime}\n${pair[1] ? `2️⃣ às ${pair[1].startTime}\n` : ""}\nQual dessas opções fica melhor para você vir?`;
      } else {
        const alt = openSlots.filter((s) => s.offsetDays === 1).slice(0, 2);
        setOfferedStage(alt);
        saveDb(db);
        return `Para hoje nossos horários já estão totalmente preenchidos${greetName}! Mas para amanhã já consegui reservar para você:\n\n1️⃣ às ${alt[0]?.startTime}\n2️⃣ às ${alt[1]?.startTime}\n\nQual prefere agendar?`;
      }
    }

    // PROCEDIMENTO MENCIONADO
    if (procMatch && lead.stage !== "AGENDADO") {
      const pair = openSlots.slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Excelente escolha${greetName}! Para o procedimento de **${lead.procedure}**, a primeira consulta de avaliação é 100% gratuita e já inclui o RX Panorâmico + Escaneamento 5D na ${clinicName}. 😊\n\nConsegue vir em qual destes horários:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual opção fica melhor para você?`;
    }

    // SIM / QUERO
    if (AFFIRMATIVE_REGEX.test(norm) && lead.stage !== "AGENDADO") {
      const pair = openSlots.slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Maravilha${greetName}! Fico muito feliz! Para a sua avaliação gratuita de 30 min (com RX Panorâmico + Escaneamento 5D), tenho estes dois horários abertos:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual das duas opções prefere (1 ou 2)?`;
    }

    // LOCALIZAÇÃO
    if (LOCATION_REGEX.test(text)) {
      const pair = openSlots.slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `A ${clinicName} fica localizada em: 📍 ${clinicAddress}${parkingSuffix}.\n\nNossa avaliação de 30 min é 100% gratuita e já inclui RX Panorâmico + Escaneamento 5D! Para você conhecer a clínica, tenho estas duas vagas:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual das duas opções fica melhor para você?`;
    }

    // PORTO SEGURO
    if (PORTO_SEGURO_REGEX.test(text)) {
      lead.modality = "Porto Seguro";
      const pair = openSlots.slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Sim, com certeza${greetName}! Na ${clinicName} atendemos pelo Plano Odontológico Porto Seguro! 😊 Sua avaliação de 30 min é gratuita com RX Panorâmico + Escaneamento 5D inclusos.\n\nTenho estes horários para agendar:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual prefere reservar?`;
    }

    // OUTROS PLANOS
    if (OTHER_INSURANCE_REGEX.test(text)) {
      lead.modality = "Outro Plano (Oferta Particular)";
      const pair = openSlots.slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Entendi${greetName}! Para esse plano específico não temos credenciamento direto na ${clinicName} (atendemos Porto Seguro e Particular). Mas fique tranquilo(a)! A nossa avaliação de 30 min é 100% gratuita com RX Panorâmico + Escaneamento 5D inclusos! 😊\n\nTenho vagas disponíveis:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual opção fica melhor para você vir conhecer nosso espaço?`;
    }

    // GENÉRICO CONVÊNIO
    if (GENERIC_INSURANCE_REGEX.test(text)) {
      lead.stage = "FILTRO_CONVENIO";
      saveDb(db);
      return `Na ${clinicName} atendemos Particular e Plano Odontológico Porto Seguro! 😊 Em ambos os casos, sua consulta de avaliação (30 min) é 100% gratuita com RX Panorâmico e Escaneamento 5D inclusos. Seu plano é Porto Seguro ou prefere atendimento particular?`;
    }

    // PARTICULAR
    if (PARTICULAR_REGEX.test(text)) {
      lead.modality = "Particular";
      const pair = openSlots.slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Perfeito${greetName}! No atendimento particular da ${clinicName}, a primeira avaliação de 30 min é 100% gratuita e já inclui RX Panorâmico + Escaneamento Digital 5D! 😊\n\nTenho estes dois horários vagos:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual prefere agendar?`;
    }

    // PREÇO / VALORES
    if (EVAL_PRICE_REGEX.test(text) || TREATMENT_PRICE_REGEX.test(text)) {
      const pair = openSlots.slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Entendo sua preocupação com os valores${greetName}! A consulta de avaliação aqui na ${clinicName} é 100% gratuita (30 min) e inclui o RX Panorâmico e o Escaneamento Digital 5D sem custo nenhum. Assim o dentista avalia exatamente o seu caso e te passa um orçamento justo e facilitado! 😊\n\nConsegue vir em qual destes horários:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual das opções fica melhor para você?`;
    }

    // PERÍODO (MANHÃ / TARDE)
    if (MORNING_REGEX.test(text) || AFTERNOON_REGEX.test(text)) {
      const period = MORNING_REGEX.test(text) ? "manha" : "tarde";
      const filtered = openSlots.filter((s) => s.period === period);
      const pair = (filtered.length >= 2 ? filtered : openSlots).slice(0, 2);
      setOfferedStage(pair);
      saveDb(db);
      return `Perfeito${greetName}! Para o período da ${period === "manha" ? "manhã" : "tarde"}, tenho duas vagas livres na ${clinicName}:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual das duas opções posso reservar para você?`;
    }

    // FALLBACK PADRÃO
    const pair = openSlots.slice(0, 2);
    setOfferedStage(pair);
    saveDb(db);
    return `Olá${greetName}! Sou a Serena, secretária virtual da ${clinicName} 😊 É um prazer falar com você! Nossa avaliação de 30 min é 100% gratuita e já inclui RX Panorâmico + Escaneamento 5D inclusos.\n\nTenho estes horários vagos para esta semana:\n\n1️⃣ ${pair[0]?.label}\n2️⃣ ${pair[1]?.label}\n\nQual das duas opções fica melhor para você?`;
  });
}

export {
  BRASILIA_TZ,
  resolveWritableDataDir,
  getClinicSettings,
  saveClinicSettings,
  getBrasiliaParts,
  isWithinClinicHoursBrasilia,
  buildDefault30MinSchedule,
  loadDb,
  saveDb,
  resetDatabase,
  calculateAntiBanDelayMs,
  checkAndSendFollowups,
  handleIncomingWhatsAppMessage,
};
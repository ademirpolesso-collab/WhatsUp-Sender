// serenaEngine.cjs — Motor Serena v2 Custo Zero (Fluxo 5 Etapas + Ética CFO + Anti-Ban + Métricas Diárias)
// Fuso Oficial: America/Sao_Paulo (Brasília) | Seg–Sex 08:00–18:00 | Sáb 08:00–13:00

process.env.TZ = "America/Sao_Paulo";

const fs = require("fs");
const path = require("path");
const {
  resolveWritableDataDir,
  getClinicSettings,
  saveClinicSettings,
} = require("./configuracoes/configManager.cjs");
const {
  resolveSpintax,
  splitMessageMax450,
  sanitizeLinksForLeadHistory,
  isPhoneBlacklisted,
  checkAndRegisterOptOut,
  classifyHandoffTrigger,
  markChatReadBySerena,
  ensureSerenaChatUnread,
  sendProtectedWhatsAppMessage,
  installBulkAntiBanHook,
} = require("./configuracoes/antiBanEngine.cjs");
const zeldaCondominio = require("./configuracoes/zeldaCondominioEngine.cjs");
const {
  matchesConfiguredZeldaGroup,
  shouldIgnoreGroupForGeneralBot,
  attachZeldaGroupListener,
} = require("./configuracoes/zeldaGroupGuard.cjs");
const dashEngine = require("./configuracoes/serenaDashboardEngine.cjs");
require("./configuracoes/runtimeAutoHook.cjs");

const BRASILIA_TZ = "America/Sao_Paulo";
const DB_DIR = path.join(resolveWritableDataDir(), "dados");
const DB_FILE = path.join(DB_DIR, "agenda-serena-v2.json");

function getBrasiliaParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BRASILIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) {
    map[p.type] = p.value;
  }
  const wkMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(map.hour === "24" ? 0 : map.hour);
  return {
    isoDate: `${map.year}-${map.month}-${map.day}`,
    dayMonth: `${map.day}/${map.month}`,
    weekday: wkMap[map.weekday] ?? 1,
    hour,
    minute: Number(map.minute),
  };
}

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function generateValidClinicSlots() {
  const weekdayNames = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
  const weekdayStarts = ["08:30", "10:00", "11:30", "14:30", "16:00", "17:30"];
  const saturdayStarts = ["08:00", "09:15", "10:30", "11:30", "12:30"];
  const slots = [];
  const baseMs = Date.now();
  let offset = 0;
  let validDays = 0;

  while (validDays < 6 && offset < 12) {
    const d = new Date(baseMs + offset * 86_400_000);
    const br = getBrasiliaParts(d);
    offset++;
    if (br.weekday === 0) continue;

    const isSat = br.weekday === 6;
    const dayLabel = offset === 1 ? "Hoje" : offset === 2 ? "Amanhã" : weekdayNames[br.weekday];
    const starts = isSat ? saturdayStarts : weekdayStarts;
    const nowMins = br.hour * 60 + br.minute;

    for (const st of starts) {
      const [sh, sm] = st.split(":").map(Number);
      if (offset === 1 && sh * 60 + sm <= nowMins + 20) continue;
      const end = addMinutes(st, 30);
      slots.push({
        id: `slot-${br.isoDate}-${st.replace(":", "")}`,
        isoDate: br.isoDate,
        dayLabel,
        startTime: st,
        endTime: end,
        period: sh < 12 ? "manha" : "tarde",
        isSaturday: isSat,
        label: `${dayLabel} (${br.dayMonth}) às ${st}`,
        bookedByPhone: null,
      });
    }
    validDays++;
  }
  return slots;
}

function loadDb() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const initial = { leads: {}, slots: generateValidClinicSlots() };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), "utf-8");
    return initial;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function saveDb(db) {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
}

let bookingMutex = Promise.resolve();
function withAtomicSlotLock(fn) {
  const run = bookingMutex.then(fn, fn);
  bookingMutex = run.then(() => undefined, () => undefined);
  return run;
}

function normalizeAccents(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseRequestedTimeMinutes(text) {
  const m = text.match(/\b([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)?\b/i);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  if (hh < 6 || hh > 23) return null;
  return hh * 60 + mm;
}

const PORTO_SEGURO_REGEX = /\b(porto\s*seguro|odonto\s*porto)\b/i;
const OTHER_INSURANCE_REGEX = /\b(amil|bradesco|sulamerica|odontoprev|unimed|hapvida|intermedica|metlife|bb\s*dental)\b/i;
const PRICE_OBJECTION_REGEX = /\b(valor|preco|quanto custa|orcamento|tabela|cobra avaliacao|avaliacao paga|tem custo)\b/i;
const PAIN_URGENCY_REGEX = /\b(dor|inchado|quebrou|caiu|sangrando|urgencia|emergencia|latejando)\b/i;
const SATURDAY_REGEX = /\b(sabado|sab)\b/i;
const SUNDAY_REGEX = /\b(domingo)\b/i;
const LOCATION_REGEX = /\b(endereco|onde fica|localizacao|como chegar|rua|avenida|estacionamento|qual clinica|nome da clinica)\b/i;

async function handleIncomingWhatsAppMessage(phone, rawText, pushName = "") {
  return withAtomicSlotLock(async () => {
    // 1) Marca conexão do WhatsApp como Online e registra conversa como Não Lida p/ acompanhamento humano
    zeldaCondominio.markWhatsAppActivityOnline();
    markChatReadBySerena(phone);

    const todayIso = dashEngine.getBrtTodayIso();
    dashEngine.recordLeadInbound(phone, pushName, rawText);

    // 0. Verifica Opt-Out [BLACKLIST]
    if (isPhoneBlacklisted(phone)) return null;
    if (checkAndRegisterOptOut(phone, rawText)) {
      console.log(`[SERENA][BLACKLIST] Opt-Out registrado para ${phone}. Bot silenciado definitivamente.`);
      return null;
    }

    const settings = getClinicSettings();
    const clinicName = settings.clinicName;
    const clinicAddress = settings.clinicAddress || settings.address;
    const parkingSuffix = settings.parkingInfo ? ` - ${settings.parkingInfo}` : "";

    const db = loadDb();
    const text = String(rawText || "").trim();
    const norm = normalizeAccents(text);

    const isNewLead = !db.leads[phone];
    if (isNewLead) {
      db.leads[phone] = {
        phone,
        name: pushName ? String(pushName).trim() : "",
        stage: "ACOLHIMENTO",
        replyCount: 0,
        botPaused: false,
        bookedSlotId: null,
        offeredPairIds: [],
        createdDate: todayIso,
        lastActivityDate: todayIso,
        bookedDate: null,
        handoffDate: null,
        activityDates: [todayIso],
        updatedAt: new Date().toISOString(),
      };
    }

    const lead = db.leads[phone];
    lead.replyCount = (Number(lead.replyCount) || 0) + 1;
    lead.lastActivityDate = todayIso;
    if (!lead.createdDate) lead.createdDate = todayIso;
    if (!Array.isArray(lead.activityDates)) lead.activityDates = [];
    if (!lead.activityDates.includes(todayIso)) lead.activityDates.push(todayIso);
    lead.updatedAt = new Date().toISOString();

    if (lead.botPaused) {
      saveDb(db);
      return null;
    }

    function finalizeReply(outText) {
      saveDb(db);
      if (outText) dashEngine.recordSerenaReply(phone, lead.stage);
      return outText;
    }

    // 1. Matriz de Transbordo Humano (3 Níveis: Humano, Jurídico, Clínico Máximo)
    const handoff = classifyHandoffTrigger(text, lead.name || pushName);
    if (handoff.triggered) {
      lead.botPaused = true;
      lead.stage = "TRANSBORDO_HUMANO";
      lead.handoffTag = handoff.tag;
      lead.handoffDate = todayIso;
      dashEngine.recordLeadHandoff(phone, handoff.tag);
      return finalizeReply(handoff.replyScript);
    }

    const openSlots = db.slots.filter((s) => !s.bookedByPhone);
    const satSlots = openSlots.filter((s) => s.isSaturday);
    const firstName = lead.name ? lead.name.split(" ")[0] : "";
    const greetComma = firstName ? `, ${firstName}` : "";

    // Etapa 1: Primeiro contato puro de saudação -> Boas-vindas (< 20 palavras, sem pergunta dupla)
    if (isNewLead && /^(oi|ola|bom dia|boa tarde|boa noite|opa|tudo bem)[!?. ]*$/i.test(norm)) {
      return finalizeReply(
        resolveSpintax(
          `{Olá|Oi}! Que bom ter você aqui na ${clinicName}! 😊\n\nEu sou a Serena, assistente virtual da clínica.\n\nPara que eu possa te direcionar ao dentista especialista certo, como você prefere ser chamado(a)?`
        )
      );
    }

    // Resposta 1 ou 2 de confirmação/reagendamento quando já está AGENDADO
    if (lead.stage === "AGENDADO") {
      if (/^(1|confirm\w*|sim|pode manter|combinado)\b/i.test(norm)) {
        return finalizeReply(`Perfeito${greetComma}! ✅ Presença confirmada na ${clinicName} (📍 ${clinicAddress}). Nosso especialista já deixou tudo preparado para você!`);
      }
      if (/^(2|reagendar|remarcar|trocar)\b/i.test(norm)) {
        if (lead.bookedSlotId) {
          const prev = db.slots.find((s) => s.id === lead.bookedSlotId);
          if (prev) prev.bookedByPhone = null;
          lead.bookedSlotId = null;
        }
        lead.stage = "OFERTA_HORARIOS";
        const freshOpen = db.slots.filter((s) => !s.bookedByPhone).slice(0, 2);
        lead.offeredPairIds = freshOpen.map((s) => s.id);
        return finalizeReply(`Sem problemas${greetComma}! Já liberei o horário anterior 😊\n\nTenho estas duas opções prioritárias:\n👉 Opção A: ${freshOpen[0]?.label}\n👉 Opção B: ${freshOpen[1]?.label}\n\nQual desses dois momentos encaixa melhor na sua rotina?`);
      }
    }

    // Escolha Opção A / Opção B ou horário explícito na Etapa 4 -> Etapa 5 (Protocolo Anti-No-Show)
    if (lead.stage === "OFERTA_HORARIOS") {
      let chosenSlot = null;
      if (/\b(opcao\s*a|primeir[ao]|^a$)\b/i.test(norm) && lead.offeredPairIds?.[0]) {
        chosenSlot = db.slots.find((s) => s.id === lead.offeredPairIds[0]);
      } else if (/\b(opcao\s*b|segund[ao]|^b$)\b/i.test(norm) && lead.offeredPairIds?.[1]) {
        chosenSlot = db.slots.find((s) => s.id === lead.offeredPairIds[1]);
      }
      if (chosenSlot && !chosenSlot.bookedByPhone) {
        chosenSlot.bookedByPhone = phone;
        lead.stage = "AGENDADO";
        lead.bookedSlotId = chosenSlot.id;
        lead.bookedDate = todayIso;
        dashEngine.recordLeadBooked(phone, chosenSlot.isoDate);
        return finalizeReply(
          sanitizeLinksForLeadHistory(
            `Excelente${greetComma}! ✅\n\nJá bloqueei esse horário na agenda do especialista para você:\n🗓 ${chosenSlot.label}\n📍 Endereço: ${clinicAddress}${parkingSuffix}\n\n⚠️ Importante: Nosso especialista estará em sala aguardando exclusivamente por você, com o kit de esterilização e equipamentos preparados.\n\nTe envio a localização pelo GPS no dia anterior, combinado?`,
            lead.replyCount
          )
        );
      }
    }

    const reqMins = parseRequestedTimeMinutes(norm);
    const isSatReq = SATURDAY_REGEX.test(norm);

    if (reqMins !== null) {
      if (isSatReq && (reqMins < 480 || reqMins > 750)) {
        const pair = satSlots.slice(0, 2);
        lead.stage = "OFERTA_HORARIOS";
        lead.offeredPairIds = pair.map((s) => s.id);
        return finalizeReply(`Aos sábados na ${clinicName} atendemos das 08:00 às 13:00 (última avaliação às 12:30). Tenho disponível:\n\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nQual desses dois momentos encaixa melhor?`);
      }
      if (!isSatReq && (reqMins < 480 || reqMins > 1050)) {
        const pair = openSlots.slice(0, 2);
        lead.stage = "OFERTA_HORARIOS";
        lead.offeredPairIds = pair.map((s) => s.id);
        return finalizeReply(`De segunda a sexta atendemos das 08:00 às 18:00 na ${clinicName} e aos sábados das 08:00 às 13:00 😊\n\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nQual prefere?`);
      }

      const hhmm = `${String(Math.floor(reqMins / 60)).padStart(2, "0")}:${String(reqMins % 60).padStart(2, "0")}`;
      const exactSlot = db.slots.find((s) => s.startTime === hhmm && (isSatReq ? s.isSaturday : true));

      if (exactSlot && !exactSlot.bookedByPhone) {
        exactSlot.bookedByPhone = phone;
        lead.stage = "AGENDADO";
        lead.bookedSlotId = exactSlot.id;
        lead.bookedDate = todayIso;
        dashEngine.recordLeadBooked(phone, exactSlot.isoDate);
        return finalizeReply(`Excelente${greetComma}! ✅\n\nJá bloqueei esse horário na agenda do especialista para você:\n🗓 ${exactSlot.label}\n📍 Endereço: ${clinicAddress}${parkingSuffix}\n\n⚠️ Importante: Nosso especialista estará em sala aguardando exclusivamente por você, com o kit de esterilização e equipamentos preparados.\n\nTe envio a localização pelo GPS no dia anterior, combinado?`);
      }
    }

    if (LOCATION_REGEX.test(norm)) {
      return finalizeReply(`A ${clinicName} fica em: 📍 ${clinicAddress}${parkingSuffix}. Nossa avaliação gratuita de 30 min inclui RX Panorâmico + Escaneamento 5D! Prefere agendar durante a semana (08h–18h) ou no sábado (08h–13h)?`);
    }

    if (SUNDAY_REGEX.test(norm)) {
      const pair = openSlots.slice(0, 2);
      lead.stage = "OFERTA_HORARIOS";
      lead.offeredPairIds = pair.map((s) => s.id);
      return finalizeReply(`Aos domingos não temos expediente na ${clinicName} 😊 Atendemos Seg–Sex (08:00–18:00) e Sábados (08:00–13:00):\n\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nQual fica melhor?`);
    }

    if (PORTO_SEGURO_REGEX.test(norm)) {
      const pair = openSlots.slice(0, 2);
      lead.stage = "OFERTA_HORARIOS";
      lead.offeredPairIds = pair.map((s) => s.id);
      return finalizeReply(`Sim${greetComma}, na ${clinicName} somos credenciados ao Plano Odontológico Porto Seguro! 😊\n\nPara sua avaliação de 30 min (com RX Panorâmico + Escaneamento 5D), tenho:\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nQual encaixa melhor?`);
    }

    if (OTHER_INSURANCE_REGEX.test(norm)) {
      const pair = openSlots.slice(0, 2);
      lead.stage = "OFERTA_HORARIOS";
      lead.offeredPairIds = pair.map((s) => s.id);
      return finalizeReply(`Na ${clinicName} atendemos Particular e Plano Odontológico Porto Seguro 😊 Como nossa avaliação de 30 min é 100% gratuita (com RX Panorâmico + Escaneamento 5D), vale muito conhecer:\n\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nQual prefere?`);
    }

    // Adequação Ética CFO (Scripts 2.1 Implante, 2.2 Aparelho, 2.3 Limpeza/Geral)
    if (PRICE_OBJECTION_REGEX.test(norm)) {
      lead.stage = "CONTORNO_PRECO";
      if (/implant|protese|perdi/i.test(norm)) {
        return finalizeReply(`Entendo perfeitamente sua dúvida${greetComma}! O investimento em um implante depende de fatores biológicos únicos: espessura óssea, fixação ideal e saúde gengival (o CFO proíbe valores sem avaliação presencial).\n\nNa ${clinicName} realizamos planejamento digital 5D + RX gratuitos para você sair sabendo o plano exato e condições facilitadas.\n\nFaz muito tempo que você perdeu esse dente ou ainda está com ele no local?`);
      }
      if (/aparelho|ortodont|alinhador|invis/i.test(norm)) {
        return finalizeReply(`Essa é a dúvida de quase todos os nossos pacientes${greetComma}! O valor depende da complexidade da mordida e do tempo estimado.\n\nTrabalhamos com convencionais e alinhadores invisíveis (com Escaneamento 5D gratuito na avaliação para orçamento justo).\n\nO que mais tem te incomodado no sorriso hoje: a posição dos dentes ou dores ao mastigar?`);
      }
      return finalizeReply(`Olá${greetComma}! Trabalhamos com protocolo completo de profilaxia por ultrassom.\n\nO valor preventivo é bem acessível, mas o dentista avalia antes gengiva e focos de cárie na nossa avaliação gratuita de 30 min (com RX + Escaneamento 5D).\n\nVocê sente algum sangramento na gengiva ao escovar ou seria manutenção de rotina mesmo?`);
    }

    // Etapa 3 + Etapa 4: Escolha das trilhas 1 a 5
    const numChoice = norm.trim().match(/^[1-5]$/) ? Number(norm.trim()) : null;
    if (numChoice === 1 || PAIN_URGENCY_REGEX.test(norm)) {
      const pair = openSlots.slice(0, 2);
      lead.stage = "OFERTA_HORARIOS";
      lead.offeredPairIds = pair.map((s) => s.id);
      return finalizeReply(`Compreendo${greetComma}! Dor de dente não pode esperar. 🚨\n\nNossos especialistas deixam encaixes reservados para aliviar seu incômodo rápido:\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nQual desses dois momentos encaixa melhor para você?`);
    }

    if (numChoice === 2 || numChoice === 3 || numChoice === 4 || numChoice === 5 || lead.stage === "CONTORNO_PRECO") {
      const pair = openSlots.slice(0, 2);
      lead.stage = "OFERTA_HORARIOS";
      lead.offeredPairIds = pair.map((s) => s.id);
      return finalizeReply(`Excelente escolha${greetComma}! Nossos especialistas usam tecnologia digital 5D + RX Panorâmico (gratuitos na avaliação de 30 min) para planejar seu resultado.\n\nTenho duas opções prioritárias esta semana:\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nQual desses dois momentos encaixa melhor na sua rotina?`);
    }

    // Etapa 2: Lead enviou o nome -> Dispara Triagem (Dor vs. Desejo 1 a 5)
    if (lead.stage === "ACOLHIMENTO" && norm.split(/\s+/).length <= 4) {
      const cleanName = text
        .replace(/^(oi|ola|eu sou o|eu sou a|me chamo|meu nome e|meu nome é)\s+/i, "")
        .trim();
      if (cleanName) {
        lead.name = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
      }
      const disp = (lead.name || pushName || "paciente").split(" ")[0];
      lead.stage = "TRIAGEM";
      return finalizeReply(`Prazer, ${disp}! ✨\n\nMe conte uma coisa: o que você precisa resolver hoje com a gente?\n\n1️⃣ Estou sentindo dor, quebrei um dente ou é urgência\n2️⃣ Quero repor dentes com Implantes ou Prótese\n3️⃣ Quero alinhar meus dentes com Aparelho\n4️⃣ Quero transformar meu sorriso (Lentes / Clareamento)\n5️⃣ Limpeza, canal ou Check-up Geral\n\n(Basta digitar o número da opção ou escrever com suas palavras!)`);
    }

    // Fallback determinístico em 2 horários (Lei de Hick)
    const pair = openSlots.slice(0, 2);
    lead.stage = "OFERTA_HORARIOS";
    lead.offeredPairIds = pair.map((s) => s.id);
    return finalizeReply(`Para fazermos sua avaliação diagnóstica presencial completa na ${clinicName} (gratuita, 30 min com RX + Escaneamento 5D), tenho duas opções prioritárias:\n\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nQual desses dois momentos encaixa melhor na sua rotina?`);
  });
}

function buildReminder24hMessage(leadName, slotLabel) {
  const settings = getClinicSettings();
  const clinic = settings.clinicName;
  const addr = settings.clinicAddress || settings.address;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clinic + " " + addr)}`;
  return `Oi, ${leadName || "tudo bem"}, bom dia! Aqui é a Serena da ${clinic}.\n\nPassando para confirmar seu horário amanhã (${slotLabel}) com nosso especialista.\n\nSegue a localização no mapa: ${mapsUrl}\n\nPodemos manter o horário ou você precisou de algum ajuste de última hora?\n(Responda: 1 para CONFIRMAR ou 2 para REAGENDAR)`;
}

function buildFollowup24hMessage(leadName) {
  const settings = getClinicSettings();
  return `Oi, ${leadName || "tudo bem"}?\n\nVi que não conseguimos finalizar seu agendamento ontem na ${settings.clinicName}. Sei que a rotina é corrida!\n\nAs vagas com nosso especialista para esta semana estão quase encerradas, mas guardei um espaço para você.\n\nAinda faz sentido avaliarmos o seu caso ou prefere deixar para o próximo mês?`;
}

async function processAndReplySerenaWhatsApp(clientOrSock, targetJid, rawText, pushName = "", msgMeta = {}) {
  zeldaCondominio.markWhatsAppActivityOnline();
  markChatReadBySerena(targetJid, msgMeta);
  const reply = await handleIncomingWhatsAppMessage(targetJid, rawText, pushName);
  if (reply && String(reply).trim()) {
    await sendProtectedWhatsAppMessage(clientOrSock, targetJid, reply, {
      ...msgMeta,
      isBulkCampaign: false,
    });
  } else {
    await ensureSerenaChatUnread(clientOrSock, targetJid, msgMeta);
  }
  return reply;
}

module.exports = {
  BRASILIA_TZ,
  getBrasiliaParts,
  getClinicSettings,
  saveClinicSettings,
  resolveSpintax,
  splitMessageMax450,
  isPhoneBlacklisted,
  checkAndRegisterOptOut,
  classifyHandoffTrigger,
  markChatReadBySerena,
  ensureSerenaChatUnread,
  sendProtectedWhatsAppMessage,
  installBulkAntiBanHook,
  matchesConfiguredZeldaGroup,
  shouldIgnoreGroupForGeneralBot,
  attachZeldaGroupListener,
  handleIncomingWhatsAppMessage,
  processAndReplySerenaWhatsApp,
  buildReminder24hMessage,
  buildFollowup24hMessage,
  computeDashboardMetrics: dashEngine.computeDashboardMetrics,
};

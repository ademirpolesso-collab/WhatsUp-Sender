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

const PORTO_SEGURO_REGEX = /\b(porto\s*seguro|odonto\s*porto|porto\s*odonto)\b/i;
const OTHER_INSURANCE_REGEX = /\b(amil|bradesco|sulamerica|odontoprev|unimed|hapvida|intermedica|metlife|bb\s*dental|dental\s*uni|inpao|rede\s*unna)\b/i;
const GENERIC_INSURANCE_REGEX = /\b(convenio\w*|plano\s*odontologico|aceita\w*\s+plano|qual\s+plano|quais\s+planos)\b/i;
const EVAL_PRICE_REGEX = /\b((valor|preco|custa|paga\w*|gratuita|gratis).*(avaliacao|consulta)|(avaliacao|consulta).*(valor|preco|custa|paga\w*|gratuita|gratis))\b/i;
const PRICE_OBJECTION_REGEX = /\b(valor|preco|valores|quanto custa|quanto fica|orcamento|tabela|parcela\w*)\b/i;
const PAIN_URGENCY_REGEX = /\b(dor|doendo|inchado|quebrou|caiu|sangrando|urgencia|emergencia|latejando|siso|canal)\b/i;
const SATURDAY_REGEX = /\b(sabado|sab)\b/i;
const SUNDAY_REGEX = /\b(domingo|feriado)\b/i;
const HOURS_QUESTION_REGEX = /\b(horario\s+de\s+funcionamento|que\s+horas\s+abre|que\s+horas\s+fecha|ate\s+que\s+horas|abre\s+sabado|funciona\s+sabado)\b/i;
const LOCATION_REGEX = /\b(endereco|onde fica|localizacao|como chegar|rua|avenida|estacionamento|qual clinica|nome da clinica)\b/i;

const APPT_NEGATION_OR_CHANGE_REGEX =
  /\b(nao\s+vou|nao\s+consigo|nao\s+posso|nao\s+poderei|nao\s+da|imprevisto|cancelar|cancela\b|desmarcar|desmarca\b|remarcar|reagendar|trocar|mudar|outro\s+dia|outro\s+horario)\b/i;
const APPT_CONFIRM_REGEX =
  /^(1|ok|okay|sim|s\b|certo|combinado|perfeito|confirmo|confirmad[oa]|isso|positivo|beleza|fechado|pode\s+manter|tudo\s+certo|com\s+certeza)\b|\b(confirmad[oa]|confirmo|pode\s+confirmar|pode\s+manter|mantem\s+o\s+horario|vou\s+comparecer|vou\s+ir|vou\s+sim|estarei\s+ai|estarei\s+la|presenca\s+confirmada|tudo\s+certo\s+para|combinado\s+para|com\s+certeza)\b/i;
const APPT_CANCEL_REGEX =
  /\b(cancelar|cancela\b|cancelamento|desmarcar|desmarca\b|nao\s+vou\s+conseguir|nao\s+consigo\s+ir|nao\s+vou\s+poder|nao\s+poderei|tive\s+um\s+imprevisto|surgiu\s+um\s+imprevisto|depois\s+eu\s+remarco|depois\s+remarco|outro\s+dia\s+eu\s+marco|preciso\s+desmarcar)\b/i;
const APPT_RESCHEDULE_REGEX =
  /^(2)\b|\b(reagendar|remarcar|trocar\s+(o\s+)?(horario|dia)|mudar\s+(o\s+)?(horario|dia)|outro\s+horario|outro\s+dia|preciso\s+ajustar|mudar\s+para|passar\s+para|transferir\s+para)\b/i;

const HESITATION_REGEX =
  /\b(vou\s+pensar|preciso\s+pensar|vou\s+analisar|vou\s+avaliar|vou\s+ver\s+(na\s+|minha\s+)?agenda|olhar\s+(a\s+|minha\s+)?agenda|falar\s+com\s+meu\s+marido|falar\s+com\s+minha\s+esposa|conversar\s+em\s+casa|conversar\s+com\s+(meu|minha)\b|depois\s+eu\s+vejo|depois\s+te\s+aviso|depois\s+(eu\s+)?retorno|te\s+chamo\s+depois|no\s+momento\s+nao|agora\s+nao|por\s+enquanto\s+nao|so\s+pesquisando|so\s+queria\s+(saber|tirar\s+uma\s+duvida|essa\s+informacao)|so\s+uma\s+duvida|so\s+tirar\s+uma\s+duvida|deixar\s+p(?:ara|ra)\s+depois|mes\s+que\s+vem|sem\s+agendar\s+agora|nao\s+quero\s+agendar\s+agora|ainda\s+nao\s+sei)\b/i;
const DENTAL_FEAR_REGEX =
  /\b(medo\s+de\s+dentista|tenho\s+(muito\s+)?medo|morro\s+de\s+medo|pavor\s+de\s+dentista|trauma\s+de\s+dentista|fobia|ansiedade\s+com\s+dentista|medo\s+de\s+doer|receio\s+de\s+doer|tenho\s+trauma)\b/i;
const GRATITUDE_REGEX =
  /^(obrigad[oa]|muito\s+obrigad[oa]|valeu|agradeco|ta\s+otimo|ta\s+bom,?\s*obrigad[oa]|ta\s+certo,?\s*obrigad[oa]|entendi,?\s*obrigad[oa]|perfeito,?\s*obrigad[oa]|era\s+so\s+isso|ok,?\s*obrigad[oa])[!.,\s😊🙏]*$/i;
const WANTS_SCHEDULE_REGEX =
  /\b(agendar|marcar|reservar|horario\s+disponivel|tem\s+horario|tem\s+vaga|quero\s+ir|quero\s+fazer\s+a\s+avaliacao|quando\s+posso\s+ir|quais\s+horarios|ver\s+horario|particular)\b/i;
const GENTLE_YES_REGEX =
  /^(sim|quero(\s+sim)?|pode\s+ser|pode\s+ver|gostaria(\s+sim)?|vamos(\s+sim|\s+agendar)?|por\s+favor|claro|bora|aceito|quero\s+agendar|pode\s+mostrar)[!.,\s]*$/i;

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
    const norm = normalizeAccents(text).trim();
    const pendingConf = getPendingConfirmation(phone);

    const isNewLead = !db.leads[phone];
    if (isNewLead) {
      db.leads[phone] = {
        phone,
        name: pushName ? String(pushName).trim() : "",
        stage: pendingConf ? "AGENDADO" : "ACOLHIMENTO",
        replyCount: 0,
        botPaused: false,
        bookedSlotId: null,
        scheduledSlotLabel: pendingConf && pendingConf.slotHint ? pendingConf.slotHint : null,
        awaitingConfirmation: Boolean(pendingConf),
        confirmedPresence: false,
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
    if (pendingConf) {
      lead.stage = "AGENDADO";
      lead.awaitingConfirmation = true;
      if (!lead.scheduledSlotLabel && pendingConf.slotHint) {
        lead.scheduledSlotLabel = pendingConf.slotHint;
      }
    }
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
    const reqMins = parseRequestedTimeMinutes(norm);
    const isSatReq = SATURDAY_REGEX.test(norm);

    // =========================================================================
    // PRIORIDADE 1: AGENDAMENTO JÁ EXISTENTE / PEDIDO DE CONFIRMAÇÃO
    // Impede 100% que resposta de confirmação seja encerrada como NOVO agendamento!
    // =========================================================================
    const bookedSlotObj = lead.bookedSlotId ? db.slots.find((s) => s.id === lead.bookedSlotId) : null;
    const currentSlotLabel =
      (bookedSlotObj && bookedSlotObj.label) ||
      lead.scheduledSlotLabel ||
      (pendingConf && pendingConf.slotHint) ||
      "o seu horário reservado";
    const hasExistingBooking =
      lead.stage === "AGENDADO" || Boolean(lead.awaitingConfirmation) || Boolean(pendingConf);

    if (hasExistingBooking) {
      const wantsRescheduleExplicitly =
        APPT_RESCHEDULE_REGEX.test(norm) && !/\bdepois\s+(eu\s+)?remarco\b/i.test(norm);
      const wantsCancelOnly = APPT_CANCEL_REGEX.test(norm) && !wantsRescheduleExplicitly;

      // 1A. Desmarcação / Cancelamento empático sem empurrar novo horário
      if (wantsCancelOnly) {
        if (lead.bookedSlotId) {
          const prev = db.slots.find((s) => s.id === lead.bookedSlotId);
          if (prev) prev.bookedByPhone = null;
          lead.bookedSlotId = null;
        }
        lead.scheduledSlotLabel = null;
        lead.awaitingConfirmation = false;
        lead.confirmedPresence = false;
        lead.stage = "TRIAGEM";
        resolvePendingConfirmation(phone, "cancelled");
        return finalizeReply(
          `Imagino${greetComma}, imprevistos acontecem! Já desmarquei e liberei o seu horário aqui para você ficar tranquilo(a), sem nenhum problema 😊\n\nQuando sua rotina acalmar e você quiser ver uma nova data, é só me chamar no seu tempo!`
        );
      }

      // 1B. Confirmação de Presença (mesmo que o paciente mencione o horário já marcado!)
      const reqHHMM =
        reqMins !== null
          ? `${String(Math.floor(reqMins / 60)).padStart(2, "0")}:${String(reqMins % 60).padStart(2, "0")}`
          : "";
      const repeatsSameBookedHour =
        Boolean(reqHHMM) &&
        currentSlotLabel.includes(reqHHMM) &&
        !APPT_NEGATION_OR_CHANGE_REGEX.test(norm);
      const isConfirmingPresence =
        (!APPT_NEGATION_OR_CHANGE_REGEX.test(norm) && APPT_CONFIRM_REGEX.test(norm)) ||
        repeatsSameBookedHour;

      if (isConfirmingPresence) {
        lead.stage = "AGENDADO";
        lead.awaitingConfirmation = false;
        lead.confirmedPresence = true;
        resolvePendingConfirmation(phone, "confirmed");
        if (typeof dashEngine.recordAppointmentConfirmed === "function") {
          dashEngine.recordAppointmentConfirmed(phone);
        }
        return finalizeReply(
          `Que ótimo${greetComma}! 😊 Sua presença está confirmada para ${currentSlotLabel} aqui na ${clinicName} (📍 ${clinicAddress}${parkingSuffix}).\n\nNosso especialista já estará te aguardando com tudo preparado. Até lá!`
        );
      }

      // 1C. Pedido de Reagendamento (troca para novo horário sem duplicar contagem de novo fechamento)
      if (wantsRescheduleExplicitly || reqMins !== null) {
        if (reqMins !== null) {
          const hhmmNew = `${String(Math.floor(reqMins / 60)).padStart(2, "0")}:${String(reqMins % 60).padStart(2, "0")}`;
          const exactNew = db.slots.find((s) => s.startTime === hhmmNew && (isSatReq ? s.isSaturday : true));
          if (exactNew && !exactNew.bookedByPhone) {
            if (lead.bookedSlotId) {
              const prev = db.slots.find((s) => s.id === lead.bookedSlotId);
              if (prev) prev.bookedByPhone = null;
            }
            exactNew.bookedByPhone = phone;
            lead.bookedSlotId = exactNew.id;
            lead.scheduledSlotLabel = exactNew.label;
            lead.awaitingConfirmation = false;
            lead.stage = "AGENDADO";
            resolvePendingConfirmation(phone, "rescheduled");
            return finalizeReply(
              `Combinado${greetComma}! 😊 Atualizei o seu agendamento na ${clinicName} para:\n🗓 ${exactNew.label}\n📍 ${clinicAddress}${parkingSuffix}\n\nQualquer outro ajuste que precisar, é só me chamar!`
            );
          }
        }

        if (lead.bookedSlotId) {
          const prev = db.slots.find((s) => s.id === lead.bookedSlotId);
          if (prev) prev.bookedByPhone = null;
          lead.bookedSlotId = null;
        }
        lead.scheduledSlotLabel = null;
        lead.awaitingConfirmation = false;
        lead.stage = "OFERTA_HORARIOS";
        resolvePendingConfirmation(phone, "rescheduling");
        const freshOpen = db.slots.filter((s) => !s.bookedByPhone).slice(0, 2);
        lead.offeredPairIds = freshOpen.map((s) => s.id);
        return finalizeReply(
          `Sem nenhum problema${greetComma}! Já liberei o horário anterior para ajustarmos com calma 😊\n\nQual dia ou período fica mais confortável para você? Se ajudar, tenho livre:\n👉 Opção A: ${freshOpen[0]?.label}\n👉 Opção B: ${freshOpen[1]?.label}\n\n(Ou pode me dizer outro dia de sua preferência!)`
        );
      }

      if (LOCATION_REGEX.test(norm)) {
        return finalizeReply(
          `A ${clinicName} fica em: 📍 ${clinicAddress}${parkingSuffix}. Seu horário segue reservado para ${currentSlotLabel}! Qualquer dúvida no caminho é só me chamar 😊`
        );
      }
      if (GRATITUDE_REGEX.test(norm)) {
        return finalizeReply(
          `Imagina, por nada${greetComma}! 😊 Te esperamos em ${currentSlotLabel} aqui na ${clinicName}!`
        );
      }

      return finalizeReply(
        `Recebido${greetComma}! 😊 Seu horário (${currentSlotLabel}) segue reservado aqui na ${clinicName} (📍 ${clinicAddress}). Posso te ajudar com alguma dúvida ou você precisa ajustar o horário?`
      );
    }

    // =========================================================================
    // PRIORIDADE 2: EMPATIA E RESPEITO À VONTADE DO PACIENTE (SEM FORÇAR AÇÃO)
    // =========================================================================
    if (DENTAL_FEAR_REGEX.test(norm)) {
      lead.stage = "TRIAGEM";
      return finalizeReply(
        `Entendo você de coração${greetComma}! Muita gente sente esse receio, e aqui na ${clinicName} respeitamos totalmente o seu ritmo 💙\n\nO primeiro encontro é apenas uma conversa tranquila de diagnóstico, sem nenhum procedimento invasivo e sem dor. Você prefere tirar suas dúvidas por aqui primeiro ou quer me contar o que mais te preocupa?`
      );
    }

    if (HESITATION_REGEX.test(norm)) {
      lead.stage = "TRIAGEM";
      return finalizeReply(
        `Fique super à vontade${greetComma}, sem nenhuma pressa! 😊\n\nÉ muito importante decidir com calma e no seu tempo. Se surgir mais alguma dúvida aqui na ${clinicName}, estou à disposição. Quando quiser conversar de novo, é só me chamar!`
      );
    }

    if (GRATITUDE_REGEX.test(norm)) {
      if (lead.stage === "OFERTA_HORARIOS") lead.stage = "TRIAGEM";
      return finalizeReply(
        `Imagina, por nada${greetComma}! 😊 Fico muito feliz em ajudar. Precisando de qualquer informação aqui na ${clinicName}, é só me chamar no seu tempo. Tenha um excelente dia!`
      );
    }

    if (APPT_CANCEL_REGEX.test(norm) && !APPT_RESCHEDULE_REGEX.test(norm)) {
      lead.stage = "TRIAGEM";
      return finalizeReply(
        `Sem nenhum problema${greetComma}! Já registrei a desmarcação para você ficar tranquilo(a) 😊\n\nQuando sua rotina estiver mais calma e você quiser ver outra data, é só me chamar por aqui!`
      );
    }

    // Etapa 1: Primeiro contato puro de saudação -> Boas-vindas acolhedoras
    if (isNewLead && /^(oi|ola|bom dia|boa tarde|boa noite|opa|tudo bem)[!?. ]*$/i.test(norm)) {
      return finalizeReply(
        resolveSpintax(
          `{Olá|Oi}! Que bom ter você aqui na ${clinicName}! 😊\n\nEu sou a Serena, assistente virtual da clínica.\n\nPara que eu possa te atender com atenção, como você prefere ser chamado(a)?`
        )
      );
    }

    // Escolha Opção A / Opção B na Etapa 4 -> Novo Agendamento
    if (lead.stage === "OFERTA_HORARIOS") {
      let chosenSlot = null;
      if (/\b(opcao\s*a|primeir[ao]|^a$|^1$)\b/i.test(norm) && lead.offeredPairIds?.[0]) {
        chosenSlot = db.slots.find((s) => s.id === lead.offeredPairIds[0]);
      } else if (/\b(opcao\s*b|segund[ao]|^b$|^2$)\b/i.test(norm) && lead.offeredPairIds?.[1]) {
        chosenSlot = db.slots.find((s) => s.id === lead.offeredPairIds[1]);
      }
      if (chosenSlot && !chosenSlot.bookedByPhone) {
        chosenSlot.bookedByPhone = phone;
        lead.stage = "AGENDADO";
        lead.bookedSlotId = chosenSlot.id;
        lead.scheduledSlotLabel = chosenSlot.label;
        lead.awaitingConfirmation = false;
        lead.bookedDate = todayIso;
        dashEngine.recordLeadBooked(phone, chosenSlot.isoDate);
        return finalizeReply(
          sanitizeLinksForLeadHistory(
            `Excelente${greetComma}! ✅\n\nJá reservei esse horário na agenda do especialista da ${clinicName} para você:\n🗓 ${chosenSlot.label}\n📍 Endereço: ${clinicAddress}${parkingSuffix}\n\nNosso especialista estará aguardando você com toda atenção e equipamentos preparados. Te envio um lembrete gentil um dia antes, combinado?`,
            lead.replyCount
          )
        );
      }
    }

    if (reqMins !== null) {
      if (isSatReq && (reqMins < 480 || reqMins > 750)) {
        const pair = satSlots.slice(0, 2);
        lead.stage = "OFERTA_HORARIOS";
        lead.offeredPairIds = pair.map((s) => s.id);
        return finalizeReply(`Aos sábados na ${clinicName} atendemos das 08:00 às 13:00 (última avaliação às 12:30) 😊 Se quiser ir no sábado pela manhã, tenho disponível:\n\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nAlgum desses fica bom para você, ou prefere um dia na semana?`);
      }
      if (!isSatReq && (reqMins < 480 || reqMins > 1050)) {
        const pair = openSlots.slice(0, 2);
        lead.stage = "OFERTA_HORARIOS";
        lead.offeredPairIds = pair.map((s) => s.id);
        return finalizeReply(`De segunda a sexta atendemos das 08:00 às 18:00 na ${clinicName} e aos sábados das 08:00 às 13:00 😊 Se ajudar na sua rotina, tenho:\n\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nAlgum deles funciona para você?`);
      }

      const hhmm = `${String(Math.floor(reqMins / 60)).padStart(2, "0")}:${String(reqMins % 60).padStart(2, "0")}`;
      const exactSlot = db.slots.find((s) => s.startTime === hhmm && (isSatReq ? s.isSaturday : true));

      if (exactSlot && !exactSlot.bookedByPhone) {
        exactSlot.bookedByPhone = phone;
        lead.stage = "AGENDADO";
        lead.bookedSlotId = exactSlot.id;
        lead.scheduledSlotLabel = exactSlot.label;
        lead.awaitingConfirmation = false;
        lead.bookedDate = todayIso;
        dashEngine.recordLeadBooked(phone, exactSlot.isoDate);
        return finalizeReply(`Excelente${greetComma}! ✅\n\nJá reservei esse horário na agenda do especialista da ${clinicName} para você:\n🗓 ${exactSlot.label}\n📍 Endereço: ${clinicAddress}${parkingSuffix}\n\nNosso especialista estará aguardando você com toda atenção e equipamentos preparados. Te envio um lembrete gentil um dia antes, combinado?`);
      }
    }

    const alsoWantsSchedule = WANTS_SCHEDULE_REGEX.test(norm);

    if (LOCATION_REGEX.test(norm)) {
      lead.stage = "TRIAGEM";
      return finalizeReply(`A ${clinicName} fica em: 📍 ${clinicAddress}${parkingSuffix}.\n\nAtendemos de Segunda a Sexta (08:00–18:00) e aos Sábados (08:00–13:00). Posso te ajudar com mais alguma informação ou gostaria de ver um horário sem compromisso? 😊`);
    }

    if (HOURS_QUESTION_REGEX.test(norm)) {
      lead.stage = "TRIAGEM";
      return finalizeReply(`Aqui na ${clinicName} atendemos de Segunda a Sexta das 08:00 às 18:00 e aos Sábados das 08:00 às 13:00! 😊\n\nTem algum dia ou período que costuma ser mais tranquilo na sua rotina, ou queria só confirmar o expediente mesmo?`);
    }

    if (SUNDAY_REGEX.test(norm)) {
      lead.stage = "TRIAGEM";
      return finalizeReply(`Aos domingos não temos expediente na ${clinicName} 😊 Atendemos de Segunda a Sexta (08:00–18:00) e aos Sábados (08:00–13:00). Algum dia na semana ou sábado de manhã ficaria confortável para você?`);
    }

    if (PORTO_SEGURO_REGEX.test(norm)) {
      if (alsoWantsSchedule) {
        const pair = openSlots.slice(0, 2);
        lead.stage = "OFERTA_HORARIOS";
        lead.offeredPairIds = pair.map((s) => s.id);
        return finalizeReply(`Sim${greetComma}, na ${clinicName} somos credenciados ao Plano Odontológico Porto Seguro! 😊\n\nPara sua avaliação de 30 min (com RX Panorâmico + Escaneamento 5D), tenho livre:\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nAlgum desses encaixa bem para você, ou prefere outro dia?`);
      }
      lead.stage = "FILTRO_CONVENIO";
      return finalizeReply(`Sim${greetComma}, na ${clinicName} atendemos pelo Plano Odontológico Porto Seguro! 😊 Sua avaliação de 30 min é gratuita e já inclui RX Panorâmico + Escaneamento 5D.\n\nGostaria que eu visse horários disponíveis para você ou quer tirar alguma dúvida antes?`);
    }

    if (OTHER_INSURANCE_REGEX.test(norm)) {
      lead.stage = "FILTRO_CONVENIO";
      return finalizeReply(`Que bom você perguntar${greetComma}! Para esse convênio específico não somos credenciados aqui na ${clinicName} (atendemos Porto Seguro e Particular).\n\nCaso queira conhecer nossa estrutura sem nenhum compromisso, a avaliação diagnóstica de 30 min é 100% gratuita (com RX Panorâmico + Escaneamento 5D inclusos). Faz sentido para você ou prefere atender direto pela rede do seu plano? 😊`);
    }

    if (GENERIC_INSURANCE_REGEX.test(norm)) {
      lead.stage = "FILTRO_CONVENIO";
      return finalizeReply(`Aqui na ${clinicName} atendemos Particular e o Plano Odontológico Porto Seguro! 😊 Em ambos, a avaliação de 30 min é gratuita com RX Panorâmico + Escaneamento 5D inclusos.\n\nQual seria o seu convênio, ou você busca atendimento particular?`);
    }

    if (GENTLE_YES_REGEX.test(norm) || alsoWantsSchedule) {
      const pair = openSlots.slice(0, 2);
      lead.stage = "OFERTA_HORARIOS";
      lead.offeredPairIds = pair.map((s) => s.id);
      return finalizeReply(`Com certeza${greetComma}! 😊 Para sua avaliação diagnóstica gratuita de 30 min (com RX Panorâmico + Escaneamento 5D) aqui na ${clinicName}, separei duas sugestões:\n\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nAlguma delas encaixa bem na sua rotina, ou prefere me dizer outro dia/turno?`);
    }

    if (EVAL_PRICE_REGEX.test(norm)) {
      lead.stage = "TRIAGEM";
      return finalizeReply(`Pode ficar tranquilo(a)${greetComma}: a avaliação diagnóstica aqui na ${clinicName} é 100% gratuita (30 min) e já inclui RX Panorâmico + Escaneamento Digital 5D sem custo! 😊\n\nGostaria que eu visse um horário confortável para você ou ficou mais alguma dúvida antes?`);
    }

    // Adequação Ética CFO (Scripts 2.1 Implante, 2.2 Aparelho, 2.3 Limpeza/Geral)
    if (PRICE_OBJECTION_REGEX.test(norm)) {
      lead.stage = "CONTORNO_PRECO";
      if (/implant|protese|perdi/i.test(norm)) {
        return finalizeReply(`Entendo perfeitamente você querer se programar${greetComma}! 😊 O investimento em implante varia conforme a estrutura óssea e a fixação ideal para o seu caso (e pelo CFO o dentista precisa avaliar clinicamente antes de orçar).\n\nNa ${clinicName} realizamos planejamento digital 5D + RX gratuitos e sem compromisso.\n\nSe quiser me contar: faz tempo que você perdeu esse dente ou ainda está com ele no local?`);
      }
      if (/aparelho|ortodont|alinhador|invis/i.test(norm)) {
        return finalizeReply(`Super compreensível sua dúvida${greetComma}! 😊 O valor depende da movimentação necessária e do tempo estimado.\n\nTrabalhamos com convencionais e alinhadores invisíveis, com Escaneamento 5D gratuito e sem compromisso na avaliação.\n\nO que mais tem te incomodado hoje: a posição dos dentes ou algum desconforto na mordida?`);
      }
      return finalizeReply(`Claro${greetComma}, entendo querer ter essa base! 😊 Trabalhamos com profilaxia completa por ultrassom e valores bem acessíveis, mas o dentista avalia antes gengiva e saúde bucal na nossa avaliação gratuita de 30 min (com RX + Escaneamento 5D), sem compromisso.\n\nHoje você sente algum incômodo/sangramento ou busca prevenção de rotina mesmo?`);
    }

    // Etapa 3 + Etapa 4: Escolha das trilhas 1 a 5
    const numChoice = norm.match(/^[1-5]$/) ? Number(norm) : null;
    if (numChoice === 1 || PAIN_URGENCY_REGEX.test(norm)) {
      const pair = openSlots.slice(0, 2);
      lead.stage = "OFERTA_HORARIOS";
      lead.offeredPairIds = pair.map((s) => s.id);
      return finalizeReply(`Sinto muito que você esteja passando por esse incômodo${greetComma}! Dor de dente merece atenção rápida 💙\n\nDeixamos encaixes prioritários na ${clinicName} para aliviar seu incômodo (avaliação gratuita de 30 min com RX Panorâmico):\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nVocê consegue vir em algum desses horários ou prefere outro momento hoje/amanhã?`);
    }

    if (lead.stage === "CONTORNO_PRECO" && numChoice === null) {
      lead.stage = "TRIAGEM";
      return finalizeReply(`Obrigada por compartilhar${greetComma}! 😊 Com esse contexto nosso especialista já consegue te orientar com todo cuidado na avaliação gratuita (30 min com RX Panorâmico + Escaneamento 5D), sem nenhum compromisso.\n\nVocê gostaria que eu visse um horário tranquilo para você conhecer a clínica, ou prefere tirar mais alguma dúvida por aqui antes?`);
    }

    if (numChoice === 2 || numChoice === 3 || numChoice === 4 || numChoice === 5) {
      const pair = openSlots.slice(0, 2);
      lead.stage = "OFERTA_HORARIOS";
      lead.offeredPairIds = pair.map((s) => s.id);
      return finalizeReply(`Que bacana${greetComma}! Cuidar do sorriso traz muita leveza e confiança no dia a dia 😊\n\nSe você já quiser agendar sua avaliação gratuita de 30 min (com RX Panorâmico + Escaneamento 5D) sem compromisso, tenho estas sugestões:\n👉 Opção A: ${pair[0]?.label}\n👉 Opção B: ${pair[1]?.label}\n\nAlguma delas fica boa na sua agenda, ou prefere tirar alguma dúvida sobre o procedimento antes?`);
    }

    // Etapa 2: Lead enviou o nome -> Escuta acolhedora e aberta
    if (lead.stage === "ACOLHIMENTO" && norm.split(/\s+/).length <= 3 && !/^(sim|nao|ok|obrigad[oa])$/i.test(norm)) {
      const cleanName = text
        .replace(/^(oi|ola|eu sou o|eu sou a|me chamo|meu nome e|meu nome é)\s+/i, "")
        .trim();
      if (cleanName) {
        lead.name = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
      }
      const disp = (lead.name || pushName || "paciente").split(" ")[0];
      lead.stage = "TRIAGEM";
      return finalizeReply(`Prazer em falar com você, ${disp}! 😊\n\nComo posso te ajudar hoje? Pode escrever com suas palavras (dúvida, informação ou avaliação) ou, se preferir, escolher um tema:\n\n1️⃣ Dor de dente, dente quebrado ou urgência\n2️⃣ Implantes ou Prótese\n3️⃣ Aparelho / Alinhador\n4️⃣ Estética (Clareamento / Lentes)\n5️⃣ Limpeza ou Check-up Geral`);
    }

    // Fallback empático e sem forçar agendamento!
    lead.stage = "TRIAGEM";
    return finalizeReply(`Entendi${greetComma}! 😊 Para eu te ajudar do jeitinho que você precisa aqui na ${clinicName}: você gostaria de tirar alguma dúvida específica agora ou prefere que eu veja horários disponíveis para uma avaliação gratuita e sem compromisso?`);
  });
}

function buildReminder24hMessage(leadName, slotLabel, targetPhone = "") {
  const settings = getClinicSettings();
  const clinic = settings.clinicName;
  const addr = settings.clinicAddress || settings.address;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clinic + " " + addr)}`;
  const cleanFirst = String(leadName || "").trim().split(/\s+/)[0];
  const greet = cleanFirst && !/^(tudo|paciente|visitante|novo)/i.test(cleanFirst) ? `, ${cleanFirst}` : "";
  const msg = `Oi${greet}, tudo bem? 😊 Aqui é a Serena da ${clinic}.\n\nPassando com carinho para confirmar seu agendamento já reservado (${slotLabel || "horário agendado"}) com nosso especialista.\n\n📍 Endereço: ${addr}\nLocalização no mapa: ${mapsUrl}\n\nPodemos manter seu horário confirmado ou você precisou de algum ajuste?\n(Pode responder com 1 / Sim para confirmar, ou 2 se precisar reagendar ou desmarcar)`;
  if (targetPhone) {
    detectAndRegisterOutboundConfirmation(targetPhone, msg);
  }
  return msg;
}

function buildRescueMessage(leadName) {
  return buildEmpatheticRescuePrompt(leadName);
}

function buildFollowup24hMessage(leadName) {
  return buildEmpatheticRescuePrompt(leadName);
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
  buildEmpatheticRescuePrompt,
  upgradeRescueAndMechanicalPrompts,
  detectAndRegisterOutboundConfirmation,
  getPendingConfirmation,
  resolvePendingConfirmation,
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
  buildRescueMessage,
  buildFollowup24hMessage,
  computeDashboardMetrics: dashEngine.computeDashboardMetrics,
};

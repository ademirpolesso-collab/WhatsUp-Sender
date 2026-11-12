// serenaEngine.cjs — Fluxo Mestre Corporativo Serena (CRM, LGPD, CRC, Zero Preços, Funil, Follow-up Autorizado e Alertas Recepção)
// Fuso Oficial: America/Sao_Paulo (Brasília) | Seg–Sex 08:00–18:00 | Sáb 08:00–13:00

process.env.TZ = "America/Sao_Paulo";

const fs = require("fs");
const path = require("path");
function requireConfigMod(modFile) {
  const inSub = path.join(__dirname, "configuracoes", modFile);
  if (fs.existsSync(inSub)) return require(inSub);
  return require(path.join(__dirname, modFile));
}
const {
  resolveWritableDataDir,
  getClinicSettings,
  saveClinicSettings,
} = requireConfigMod("configManager.cjs");
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
} = requireConfigMod("antiBanEngine.cjs");
const zeldaCondominio = requireConfigMod("zeldaCondominioEngine.cjs");
const {
  matchesConfiguredZeldaGroup,
  shouldIgnoreGroupForGeneralBot,
  attachZeldaGroupListener,
} = requireConfigMod("zeldaGroupGuard.cjs");
const dashEngine = requireConfigMod("serenaDashboardEngine.cjs");
try { requireConfigMod("runtimeAutoHook.cjs"); } catch (_eHook) {}

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

function syncStageFromStatus(status) {
  switch (status) {
    case "recebido":
      return "ACOLHIMENTO";
    case "engajado":
    case "qualificado":
    case "followup":
    case "perdido":
      return "TRIAGEM";
    case "agendamento_oferecido":
      return "OFERTA_HORARIOS";
    case "agendado":
    case "concluido":
      return "AGENDADO";
    case "atendimento_humano":
      return "TRANSBORDO_HUMANO";
    default:
      return "TRIAGEM";
  }
}

const OPTOUT_CORP_REGEX =
  /\b(parar\b|pare\b|remover|nao\s+quero\s+mais\s+mensagens|cancelar\s+contato|nao\s+me\s+mande|sair\s+da\s+lista|descadastrar|opt\s*out)\b/i;
const SEVERE_URGENCY_REGEX =
  /\b(sangramento\s+intenso|hemorragia|rosto\s+(muito\s+)?inchado|febre|trauma|bati\s+o\s+dente|acidente|pus\b|desmai\w*)\b/i;
const MILD_URGENCY_REGEX =
  /\b(dor\b|doendo|dente\s+quebr\w*|quebrou|caiu|sangrando|urgencia|emergencia|latejando|siso|canal|inflamado)\b/i;
const EXISTING_PATIENT_REGEX =
  /\b(ja\s+sou\s+paciente|tenho\s+consulta\s+marcada|ja\s+faco\s+tratamento|ja\s+estou\s+em\s+tratamento|meu\s+retorno)\b/i;
const HUMAN_REQUEST_REGEX =
  /\b(atendente|humano|moca|recepcao|falar\s+com\s+alguem|falar\s+com\s+a\s+equipe|secretaria|pessoa\s+real|procon|advogad\w*|reclamacao)\b/i;
const PRICE_OBJECTION_REGEX =
  /\b(valor|preco|valores|precos|quanto\s+custa|quanto\s+fica|orcamento|tabela|parcela\w*|custa\s+a\s+avaliacao|avaliacao\s+paga)\b/i;
const LOCATION_REGEX =
  /\b(endereco|onde\s+fica|localizacao|como\s+chegar|qual\s+rua|qual\s+avenida|estacionamento)\b/i;
const HOURS_QUESTION_REGEX =
  /\b(horario\s+de\s+funcionamento|que\s+horas\s+abre|que\s+horas\s+fecha|ate\s+que\s+horas|abre\s+sabado|funciona\s+sabado|quais\s+dias\s+atende\w*)\b/i;
const SATURDAY_REGEX = /\b(sabado|sab)\b/i;
const SUNDAY_REGEX = /\b(domingo|feriado)\b/i;
const MORNING_REGEX = /\b(manha|cedo|08|09|10|11)\b/i;
const AFTERNOON_REGEX = /(?<!\bboa\s)\b(tarde|depois\s+do\s+almoco|14|15|16|17)\b/i;

const APPT_NEGATION_OR_CHANGE_REGEX =
  /\b(nao\s+vou|nao\s+consigo|nao\s+posso|nao\s+poderei|nao\s+da|imprevisto|cancelar|cancela\b|desmarcar|desmarca\b|remarcar|reagendar|trocar|mudar|outro\s+dia|outro\s+horario)\b/i;
const APPT_CONFIRM_REGEX =
  /^(1|ok|okay|sim|s\b|certo|combinado|perfeito|confirmo|confirmad[oa]|isso|positivo|beleza|fechado|pode\s+manter|tudo\s+certo|com\s+certeza)\b|\b(confirmad[oa]|confirmo|pode\s+confirmar|pode\s+manter|mantem\s+o\s+horario|vou\s+comparecer|vou\s+ir|vou\s+sim|estarei\s+ai|estarei\s+la|presenca\s+confirmada)\b/i;
const APPT_CANCEL_REGEX =
  /\b(cancelar|cancela\b|cancelamento|desmarcar|desmarca\b|nao\s+vou\s+conseguir|nao\s+consigo\s+ir|nao\s+vou\s+poder|nao\s+poderei|tive\s+um\s+imprevisto|surgiu\s+um\s+imprevisto|depois\s+eu\s+remarco|preciso\s+desmarcar)\b/i;
const APPT_RESCHEDULE_REGEX =
  /^(2)\b|\b(reagendar|remarcar|trocar\s+(o\s+)?(horario|dia)|mudar\s+(o\s+)?(horario|dia)|outro\s+horario|outro\s+dia|preciso\s+ajustar|mudar\s+para|passar\s+para)\b/i;

const SLOT_REJECTION_REGEX =
  /\b(nenhum|nao\s+consigo\s+nesses|nao\s+posso\s+nesses|esses\s+nao|outro\s+dia|outro\s+horario|outro\s+periodo|nao\s+da\s+nesses|incompativel)\b/i;
const HESITATION_REGEX =
  /\b(vou\s+pensar|preciso\s+pensar|vou\s+analisar|vou\s+avaliar|vou\s+ver\s+(na\s+|minha\s+)?agenda|falar\s+com\s+meu\s+marido|falar\s+com\s+minha\s+esposa|conversar\s+em\s+casa|depois\s+eu\s+vejo|depois\s+te\s+aviso|depois\s+retorno|no\s+momento\s+nao|agora\s+nao|por\s+enquanto\s+nao|so\s+pesquisando|comparando|deixar\s+p(?:ara|ra)\s+depois|mes\s+que\s+vem|sem\s+agendar\s+agora|nao\s+quero\s+agendar\s+agora|ainda\s+nao\s+sei)\b/i;
const CLOSURE_NO_INTEREST_REGEX =
  /\b(nao\s+tenho\s+interesse|sem\s+interesse|desisti|fechei\s+em\s+outro|preferi\s+outra\s+clinica|ja\s+fechei|encerrar\s+atendimento)\b/i;
const DENTAL_FEAR_REGEX =
  /\b(medo\s+de\s+dentista|tenho\s+(muito\s+)?medo|morro\s+de\s+medo|pavor\s+de\s+dentista|trauma\s+de\s+dentista|fobia|medo\s+de\s+doer)\b/i;
const GRATITUDE_REGEX =
  /^(obrigad[oa]|muito\s+obrigad[oa]|valeu|agradeco|ta\s+otimo|ta\s+bom,?\s*obrigad[oa]|entendi,?\s*obrigad[oa]|perfeito,?\s*obrigad[oa]|era\s+so\s+isso|ok,?\s*obrigad[oa])[!.,\s😊🙏]*$/i;
const WANTS_SCHEDULE_REGEX =
  /\b(agendar|marcar|reservar|horarios?\s+disponive\w+|tem\s+horario|tem\s+vaga|quero\s+ir|quero\s+fazer\s+a\s+avaliacao|quando\s+posso\s+ir|quais\s+(os\s+)?horarios|ver\s+(os\s+)?horarios?|consultar\s+(os\s+)?horarios?|pode\s+verificar|pode\s+consultar)\b/i;
const AFFIRMATIVE_REGEX =
  /^(sim|s\b|concordo|aceito|autorizo|pode(\s+sim|\s+ser|\s+verificar|\s+entrar\s+em\s+contato|\s+mandar)?|claro|com\s+certeza|quero(\s+sim)?|vamos|ok|tudo\s+bem|por\s+favor|confirmo)[!.,\s😊]*$/i;
const NEGATIVE_REGEX =
  /^(nao|n\b|prefiro\s+nao|nao\s+precisa|melhor\s+nao|nao\s+quero|nao\s+autorizo|agora\s+nao)[!.,\s]*$/i;
const PURE_COMPOUND_GREETING_RX =
  /^(?:(?:oi+|ola+|opa|e\s*ai|bom\s+dia|boa\s+tarde|boa\s+noite|tudo\s+bem|tudo\s+bom|como\s+vai)[,!?.:\s]*)+$/i;

function detectLeadOrigin(norm) {
  if (/\b(google|pesquisa|busca|maps|mapa)\b/i.test(norm)) return "google";
  if (/\b(insta|instagram|reels|stories)\b/i.test(norm)) return "instagram";
  if (/\b(face|facebook)\b/i.test(norm)) return "facebook";
  if (/\b(indicac\w*|indicaram|amigo|amiga|familia\w*|parente|colega)\b/i.test(norm)) return "indicacao";
  if (/\b(site|pagina|portal)\b/i.test(norm)) return "site";
  if (/\b(whats|whatsapp|mensagem|campanha)\b/i.test(norm)) return "whatsapp";
  if (/\b(passei\s+na\s+frente|fachada|rua|outro\w*)\b/i.test(norm)) return "outros";
  return null;
}

function detectLeadInterest(norm) {
  if (/\b(implant\w*|protes\w*|protocolo|perdi\s+(um\s+)?dente|falta\s+de\s+dente)\b/i.test(norm)) return "implante";
  if (/\b(ortodont\w*|aparelh\w*|alinhador\w*|invisalign|dente\s+torto|mordida)\b/i.test(norm)) return "ortodontia";
  if (/\b(estetic\w*|clareament\w*|lente\w*|faceta\w*|sorriso\s+branco)\b/i.test(norm)) return "estetica";
  if (/\b(limpeza|profilaxia|tartaro|raspagem)\b/i.test(norm)) return "limpeza";
  if (SEVERE_URGENCY_REGEX.test(norm) || MILD_URGENCY_REGEX.test(norm)) return "urgencia";
  if (/\b(avaliac\w*|check\s*up|consulta|revisao|rotina)\b/i.test(norm)) return "avaliacao";
  return null;
}

function buildInterestReply(interest) {
  switch (interest) {
    case "implante":
      return "Entendi. 😊\nCada caso é único e precisa ser avaliado por um profissional.\nPosso verificar os horários disponíveis para uma avaliação?";
    case "ortodontia":
      return "Existem diferentes opções de tratamento ortodôntico.\nPosso verificar uma avaliação para você?";
    case "estetica":
      return "Existem diversas alternativas para melhorar a estética do sorriso.\nPosso verificar um horário disponível?";
    case "limpeza":
      return "Claro. 😊\nPosso consultar os horários disponíveis?";
    case "urgencia":
      return "Sinto muito por isso. 😔\nO ideal é realizarmos uma avaliação para identificar a causa.\nPosso verificar uma disponibilidade?";
    default:
      return "Claro! 😊\nPosso verificar os horários disponíveis para sua avaliação?";
  }
}

function classifyLossReasonFromText(norm, priceQuestionCount = 0) {
  if (/\b(concorrente|outra\s+clinica|outro\s+dentista|ja\s+fechei)\b/i.test(norm)) return "preferiu_concorrente";
  if (/\b(comparando|outros\s+orcamentos)\b/i.test(norm)) return "comparando";
  if (/\b(pesquisando|so\s+queria\s+saber)\b/i.test(norm)) return "pesquisando";
  if (/\b(valor|preco|caro|condicao|orcamento)\b/i.test(norm) || priceQuestionCount >= 2) return "preco";
  if (/\b(horario|agenda|dia|sabado|noite|trabalho)\b/i.test(norm)) return "horario_incompativel";
  if (/\b(sem\s+interesse|nao\s+tenho\s+interesse|desisti)\b/i.test(norm)) return "sem_interesse";
  return "outros";
}

function formatThreeSlotsMessage(slots3) {
  const s1 = slots3[0]?.label || "Amanhã às 09:00";
  const s2 = slots3[1]?.label || "Amanhã às 14:30";
  const s3 = slots3[2]?.label || "Sábado às 09:15";
  return `Tenho os seguintes horários:\n• ${s1}\n• ${s2}\n• ${s3}\nQual funciona melhor para você?`;
}

function splitSlotDateAndTime(slotObj, fallbackLabel) {
  if (slotObj) {
    const [, m, d] = String(slotObj.isoDate || "").split("-");
    const dataStr = d && m ? `${slotObj.dayLabel} (${d}/${m})` : slotObj.dayLabel;
    return { data: dataStr, horario: slotObj.startTime };
  }
  const raw = String(fallbackLabel || "Horário reservado");
  const parts = raw.split(/\s+às\s+/i);
  if (parts.length === 2) {
    return { data: parts[0].trim(), horario: parts[1].trim() };
  }
  return { data: raw, horario: "Confirmado" };
}

function emitCorporateReceptionAlert(type, lead, extra = {}) {
  const settings = getClinicSettings();
  const targetWa = settings.receptionWhatsapp || "{WHATSAPP_RECEPCAO}";
  let formattedMessage = "";
  if (type === "novo_agendamento") {
    formattedMessage =
      `🔔 NOVO AGENDAMENTO\n` +
      `Nome: ${lead.name || "Paciente"}\n` +
      `Telefone: ${lead.phone}\n` +
      `Data: ${extra.data || "-"}\n` +
      `Horário: ${extra.horario || "-"}\n` +
      `Interesse: ${extra.interesse || lead.interesse || "avaliacao"}\n` +
      `Origem: ${extra.origem || lead.origem || "whatsapp"}`;
  } else if (type === "followup_autorizado") {
    formattedMessage =
      `🔔 FOLLOW-UP AUTORIZADO\n` +
      `Nome: ${lead.name || "Paciente"}\n` +
      `Telefone: ${lead.phone}\n` +
      `Interesse: ${extra.interesse || lead.interesse || "avaliacao"}\n` +
      `Retorno sugerido: ${extra.retorno || "48h"}`;
  } else {
    formattedMessage =
      `🔔 SOLICITAÇÃO DE CONTATO HUMANO\n` +
      `Nome: ${lead.name || "Paciente"}\n` +
      `Telefone: ${lead.phone}\n` +
      `Motivo: ${extra.motivo || "Solicitação de atendimento pela equipe"}`;
  }
  return dashEngine.recordReceptionAlert({
    type,
    priority: extra.priority || "normal",
    leadPhone: lead.phone,
    leadName: lead.name || "Paciente",
    targetWhatsapp: targetWa,
    formattedMessage,
  });
}

function setCrcAssumiu(phone, active = true) {
  const db = loadDb();
  const key = Object.keys(db.leads || {}).find(
    (k) => dashEngine.normalizeLeadPhoneKey(k) === dashEngine.normalizeLeadPhoneKey(phone)
  ) || phone;
  if (db.leads[key]) {
    db.leads[key].crcAssumiu = Boolean(active);
    db.leads[key].botPaused = Boolean(active);
    if (active) {
      db.leads[key].status = "atendimento_humano";
      db.leads[key].stage = "TRANSBORDO_HUMANO";
    } else if (db.leads[key].status === "atendimento_humano") {
      db.leads[key].status = db.leads[key].bookedSlotId ? "agendado" : "qualificado";
      db.leads[key].stage = syncStageFromStatus(db.leads[key].status);
    }
    saveDb(db);
  }
  dashEngine.syncLeadCrmSnapshot(phone, {
    crcAssumiu: Boolean(active),
    status: active ? "atendimento_humano" : undefined,
  });
  return { ok: true, phone, crcAssumiu: Boolean(active) };
}

async function handleIncomingWhatsAppMessage(phone, rawText, pushName = "") {
  return withAtomicSlotLock(async () => {
    zeldaCondominio.markWhatsAppActivityOnline();
    markChatReadBySerena(phone);

    const todayIso = dashEngine.getBrtTodayIso();
    dashEngine.recordLeadInbound(phone, pushName, rawText);

    const settings = getClinicSettings();
    const assistantName = settings.assistantName || "Serena";
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
        status: pendingConf ? "agendado" : "recebido",
        stage: pendingConf ? "AGENDADO" : "ACOLHIMENTO",
        origem: "whatsapp",
        originAsked: false,
        interesse: "avaliacao",
        interestIdentified: false,
        pacienteExistente: false,
        consentimentoLgpd: false,
        lgpdConsentAt: null,
        lgpdAsked: false,
        crcAssumiu: false,
        priceQuestionCount: 0,
        awaitingFollowupAuth: false,
        awaitingBookingData: false,
        pendingSlotId: null,
        followup: { autorizado: false, dataRetorno: null, status: null },
        optout: { status: false, data: null },
        motivoPerda: null,
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
    if (!lead.status) lead.status = pendingConf ? "agendado" : "recebido";
    if (!lead.origem) lead.origem = "whatsapp";
    if (!lead.interesse) lead.interesse = "avaliacao";

    if (pendingConf) {
      lead.status = "agendado";
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

    let generatedReceptionAlert = null;

    function finalizeReply(outText, extraSync = {}) {
      // Trava corporativa absoluta: informar_precos = false
      const safeOut = outText
        ? String(outText).replace(/R\$\s*\d+[\d.,]*/gi, "valor sob avaliação clínica")
        : null;
      lead.stage = syncStageFromStatus(lead.status);
      saveDb(db);
      dashEngine.syncLeadCrmSnapshot(phone, {
        name: lead.name,
        status: lead.status,
        stage: lead.stage,
        origem: lead.origem,
        interesse: lead.interesse,
        motivoPerda: lead.motivoPerda,
        pacienteExistente: lead.pacienteExistente,
        consentimentoLgpd: lead.consentimentoLgpd,
        crcAssumiu: lead.crcAssumiu,
        lastInteractionEpochMs: Date.now(),
        ...extraSync,
      });
      if (safeOut) dashEngine.recordSerenaReply(phone, lead.stage);
      lead.__lastReceptionAlert = generatedReceptionAlert;
      return safeOut;
    }

    // 0. Se já fez Opt-Out anteriormente, silencia 100%
    if (isPhoneBlacklisted(phone) || (lead.optout && lead.optout.status)) {
      saveDb(db);
      return null;
    }

    // 1. CONTROLE CRC: Quando CRC assumir -> pausar Serena, não responder, aguardar liberação
    if ((lead.crcAssumiu && settings.crcEnabled !== false) || lead.botPaused) {
      saveDb(db);
      return null;
    }

    // 2. OPT-OUT GLOBAL / LGPD
    if (OPTOUT_CORP_REGEX.test(norm) || checkAndRegisterOptOut(phone, rawText)) {
      checkAndRegisterOptOut(phone, "nao quero");
      lead.optout = { status: true, data: new Date().toISOString() };
      lead.status = "perdido";
      lead.motivoPerda = "optout";
      lead.botPaused = true;
      lead.awaitingFollowupAuth = false;
      lead.awaitingBookingData = false;
      return finalizeReply(
        "Tudo bem. 😊\nSeu contato foi atualizado e não enviaremos novas mensagens.\nCaso precise no futuro, estaremos à disposição."
      );
    }

    // Primeira resposta do paciente: recebido -> engajado
    if (lead.status === "recebido" && !isNewLead) {
      lead.status = "engajado";
    }

    // Captura contínua de Origem e Interesse se mencionados espontaneamente
    const spontaneousOrigin = detectLeadOrigin(norm);
    if (spontaneousOrigin) {
      lead.origem = spontaneousOrigin;
      lead.originAsked = true;
    }
    const spontaneousInterest = detectLeadInterest(norm);
    if (spontaneousInterest) {
      lead.interesse = spontaneousInterest;
      lead.interestIdentified = true;
      if (lead.status === "recebido" || lead.status === "engajado") {
        lead.status = "qualificado";
      }
    }

    const openSlots = db.slots.filter((s) => !s.bookedByPhone);
    const satSlots = openSlots.filter((s) => s.isSaturday);
    const firstName = lead.name ? lead.name.split(" ")[0] : "";
    const greetComma = firstName ? `, ${firstName}` : "";
    const reqMins = parseRequestedTimeMinutes(norm);
    const isSatReq = SATURDAY_REGEX.test(norm);

    // 3. URGÊNCIA GRAVE (Prioridade Alta -> Equipe Imediatamente)
    if (SEVERE_URGENCY_REGEX.test(norm)) {
      lead.interesse = "urgencia";
      lead.interestIdentified = true;
      lead.status = "atendimento_humano";
      lead.handoffDate = todayIso;
      dashEngine.recordLeadHandoff(phone, "[URGÊNCIA GRAVE]");
      generatedReceptionAlert = emitCorporateReceptionAlert("urgencia_grave", lead, {
        priority: "alta",
        motivo: `Urgência grave relatada pelo paciente ("${text.slice(0, 90)}")`,
      });
      return finalizeReply(
        "Entendo.\nSeu relato pode indicar uma situação que merece atenção prioritária.\nVou encaminhar sua solicitação imediatamente para nossa equipe."
      );
    }

    // 4. SOLICITAÇÃO EXPLÍCITA DE ATENDIMENTO HUMANO
    if (HUMAN_REQUEST_REGEX.test(norm)) {
      lead.status = "atendimento_humano";
      lead.handoffDate = todayIso;
      dashEngine.recordLeadHandoff(phone, "[ATENDIMENTO HUMANO]");
      generatedReceptionAlert = emitCorporateReceptionAlert("atendimento_humano", lead, {
        motivo: `Solicitação direta do paciente ("${text.slice(0, 90)}")`,
      });
      return finalizeReply(
        "Claro! 😊\nVou encaminhar seu atendimento para nossa equipe.\nEm breve alguém falará com você."
      );
    }

    // 5. AGENDAMENTO JÁ EXISTENTE / CONFIRMAÇÃO DE PRESENÇA 24H (Nunca duplica leads_agendados!)
    const bookedSlotObj = lead.bookedSlotId ? db.slots.find((s) => s.id === lead.bookedSlotId) : null;
    const currentSlotLabel =
      (bookedSlotObj && bookedSlotObj.label) ||
      lead.scheduledSlotLabel ||
      (pendingConf && pendingConf.slotHint) ||
      "o seu horário reservado";
    const hasExistingBooking =
      lead.status === "agendado" ||
      lead.stage === "AGENDADO" ||
      Boolean(lead.awaitingConfirmation) ||
      Boolean(pendingConf);

    if (hasExistingBooking) {
      const wantsRescheduleExplicitly =
        APPT_RESCHEDULE_REGEX.test(norm) && !/\bdepois\s+(eu\s+)?remarco\b/i.test(norm);
      const wantsCancelOnly = APPT_CANCEL_REGEX.test(norm) && !wantsRescheduleExplicitly;

      if (wantsCancelOnly) {
        if (lead.bookedSlotId) {
          const prev = db.slots.find((s) => s.id === lead.bookedSlotId);
          if (prev) prev.bookedByPhone = null;
          lead.bookedSlotId = null;
        }
        lead.scheduledSlotLabel = null;
        lead.awaitingConfirmation = false;
        lead.confirmedPresence = false;
        lead.status = "qualificado";
        resolvePendingConfirmation(phone, "cancelled");
        dashEngine.recordOperationEvent("cancelamento", phone);
        return finalizeReply(
          `Sem problemas${greetComma}! 😊\nJá registrei o cancelamento e liberei o seu horário.\nCaso deseje reagendar futuramente, estarei à disposição no seu tempo.`
        );
      }

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
        lead.status = "agendado";
        lead.awaitingConfirmation = false;
        lead.confirmedPresence = true;
        resolvePendingConfirmation(phone, "confirmed");
        dashEngine.recordAppointmentConfirmed(phone);
        return finalizeReply(
          `Que ótimo${greetComma}! 😊 Sua presença está confirmada para ${currentSlotLabel}.\n📍 ${clinicAddress}${parkingSuffix}\nAté lá!`
        );
      }

      if (wantsRescheduleExplicitly || reqMins !== null) {
        dashEngine.recordOperationEvent("reagendamento", phone);
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
            lead.status = "agendado";
            resolvePendingConfirmation(phone, "rescheduled");
            const dt = splitSlotDateAndTime(exactNew, exactNew.label);
            return finalizeReply(
              `Tudo certo! 😊\n👤 Nome: ${lead.name || "Paciente"}\n📅 Data: ${dt.data}\n⏰ Horário: ${dt.horario}\n📍 Endereço: ${clinicAddress}${parkingSuffix}`
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
        lead.status = "agendamento_oferecido";
        resolvePendingConfirmation(phone, "rescheduling");
        const top3 = db.slots.filter((s) => !s.bookedByPhone).slice(0, 3);
        lead.offeredPairIds = top3.map((s) => s.id);
        return finalizeReply(`Sem problemas. 😊\n${formatThreeSlotsMessage(top3)}`);
      }

      if (LOCATION_REGEX.test(norm)) {
        return finalizeReply(`📍 ${clinicAddress}${parkingSuffix}\nSeu horário segue reservado para ${currentSlotLabel}. 😊`);
      }
      if (GRATITUDE_REGEX.test(norm)) {
        return finalizeReply(`Por nada${greetComma}! 😊 Estaremos aguardando você em ${currentSlotLabel}.`);
      }
      return finalizeReply(
        `Recebido${greetComma}! 😊 Seu agendamento (${currentSlotLabel}) segue confirmado em 📍 ${clinicAddress}. Precisa reagendar ou cancelar, ou posso ajudar com alguma dúvida?`
      );
    }

    // 6. PACIENTE EXISTENTE
    if (EXISTING_PATIENT_REGEX.test(norm)) {
      lead.pacienteExistente = true;
      lead.status = "atendimento_humano";
      lead.handoffDate = todayIso;
      dashEngine.recordLeadHandoff(phone, "[PACIENTE EXISTENTE]");
      generatedReceptionAlert = emitCorporateReceptionAlert("paciente_existente", lead, {
        motivo: "Paciente existente solicitou verificação de histórico/consulta",
      });
      return finalizeReply(
        "Entendi. 😊\nVou encaminhar sua solicitação para nossa equipe verificar o seu histórico."
      );
    }

    // 7. RESPOSTA À AUTORIZAÇÃO DE FOLLOW-UP (Somente mediante autorização explícita!)
    if (lead.awaitingFollowupAuth) {
      lead.awaitingFollowupAuth = false;
      if (AFFIRMATIVE_REGEX.test(norm) || /\bpode\b|\bautorizo\b|\bfuturamente\b/i.test(norm)) {
        const retDate = dashEngine.getBrtTodayIso(new Date(Date.now() + 2 * 86_400_000));
        lead.followup = { autorizado: true, dataRetorno: retDate, status: "pendente" };
        lead.status = "followup";
        generatedReceptionAlert = emitCorporateReceptionAlert("followup_autorizado", lead, {
          interesse: lead.interesse,
          retorno: retDate,
        });
        return finalizeReply(
          `Combinado${greetComma}! 😊\nRegistrei sua autorização e entraremos em contato futuramente sem nenhum compromisso.\nSempre que precisar, estamos à disposição!`
        );
      }
      if (NEGATIVE_REGEX.test(norm) || CLOSURE_NO_INTEREST_REGEX.test(norm)) {
        lead.followup = { autorizado: false, dataRetorno: null, status: null };
        lead.status = "perdido";
        lead.motivoPerda = classifyLossReasonFromText(norm, lead.priceQuestionCount || 0);
        return finalizeReply(
          `Sem problemas${greetComma}! 😊\nRespeitamos totalmente sua decisão e não enviaremos mensagens de retorno.\nCaso precise da ${clinicName} no futuro, estaremos sempre de portas abertas!`
        );
      }
    }

    // 8. COLETA DE DADOS PARA CONFIRMAR AGENDAMENTO (Nome completo + Telefone)
    if (lead.awaitingBookingData && lead.pendingSlotId) {
      const slot = db.slots.find((s) => s.id === lead.pendingSlotId);
      const digitsInMsg = text.replace(/\D+/g, "");
      if (digitsInMsg.length >= 10) {
        lead.phone = digitsInMsg;
      }
      const cleanedNameCandidate = text
        .replace(/\+?\d[\d\s().-]{7,}/g, " ")
        .replace(/\b(telefone|celular|whats|whatsapp|nome|completo|cpf|dados)\b[:\s-]*/gi, " ")
        .replace(/[•,;|/]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (cleanedNameCandidate.length >= 3 && /[A-Za-zÀ-ÿ]/.test(cleanedNameCandidate)) {
        lead.name = cleanedNameCandidate
          .split(/\s+/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(" ");
      }

      if (slot && !slot.bookedByPhone) {
        slot.bookedByPhone = phone;
        lead.bookedSlotId = slot.id;
        lead.scheduledSlotLabel = slot.label;
        lead.bookedDate = todayIso;
        lead.awaitingBookingData = false;
        lead.pendingSlotId = null;
        lead.awaitingConfirmation = false;
        lead.status = "agendado";
        lead.consentimentoLgpd = true;
        dashEngine.recordLeadBooked(phone, slot.isoDate);
        const dt = splitSlotDateAndTime(slot, slot.label);
        generatedReceptionAlert = emitCorporateReceptionAlert("novo_agendamento", lead, {
          data: dt.data,
          horario: dt.horario,
          interesse: lead.interesse,
          origem: lead.origem,
        });
        return finalizeReply(
          `Tudo certo! 😊\n👤 Nome: ${lead.name || "Paciente"}\n📅 Data: ${dt.data}\n⏰ Horário: ${dt.horario}\n📍 Endereço: ${clinicAddress}${parkingSuffix}`,
          { markBookedToday: true }
        );
      }
      lead.awaitingBookingData = false;
      lead.pendingSlotId = null;
    }

    // 9. SOLICITAÇÃO DE VALORES — CONTROLE ESTRITO (informar_precos: false)
    if (PRICE_OBJECTION_REGEX.test(norm)) {
      lead.priceQuestionCount = (Number(lead.priceQuestionCount) || 0) + 1;
      if (lead.status === "recebido" || lead.status === "engajado") {
        lead.status = "qualificado";
      }
      if (lead.priceQuestionCount >= 3) {
        return finalizeReply(
          "Entendo sua dúvida. 😊\nComo cada tratamento depende das condições clínicas observadas pelo profissional, realmente não conseguimos informar valores previamente.\nCaso prefira, posso solicitar que nossa equipe entre em contato para explicar o processo."
        );
      }
      return finalizeReply(
        "Os valores dependem da avaliação realizada pelo profissional.\nPosso verificar um horário para você?"
      );
    }

    // 10. ENCERRAMENTO / PERDA SEM INTERESSE
    if (CLOSURE_NO_INTEREST_REGEX.test(norm)) {
      lead.status = "perdido";
      lead.motivoPerda = classifyLossReasonFromText(norm, lead.priceQuestionCount || 0);
      return finalizeReply(
        `Compreendo perfeitamente${greetComma}. 😊\nAgradeço o seu contato com a ${clinicName}. Caso precise no futuro, estaremos à disposição!`
      );
    }

    // 11. PACIENTE EM DÚVIDA -> SOLICITAR AUTORIZAÇÃO DE FOLLOW-UP (Sem pressionar)
    if (HESITATION_REGEX.test(norm)) {
      lead.awaitingFollowupAuth = true;
      if (lead.status === "recebido" || lead.status === "engajado") {
        lead.status = "qualificado";
      }
      return finalizeReply(
        "Claro. 😊\nÉ uma decisão importante.\nPosso entrar em contato futuramente apenas para saber se ficou alguma dúvida?"
      );
    }

    // 12. MEDO DE DENTISTA
    if (DENTAL_FEAR_REGEX.test(norm)) {
      if (lead.status === "recebido" || lead.status === "engajado") lead.status = "qualificado";
      return finalizeReply(
        `Entendo você perfeitamente${greetComma}. 😊\nAqui na ${clinicName} respeitamos totalmente o seu tempo, e a primeira consulta é apenas uma conversa tranquila de avaliação, sem procedimentos invasivos.\nPosso verificar um horário confortável para você ou prefere tirar alguma dúvida antes?`
      );
    }

    // 13. ENDEREÇO
    if (LOCATION_REGEX.test(norm)) {
      return finalizeReply(
        `📍 ${clinicAddress}${parkingSuffix}\nCaso deseje, também posso ajudá-lo(a) a agendar uma avaliação.`
      );
    }

    // 14. EXPEDIENTE / DOMINGO
    if (SUNDAY_REGEX.test(norm)) {
      return finalizeReply(
        `Aos domingos não temos expediente na ${clinicName}. 😊\nAtendemos de segunda a sexta das 08:00 às 18:00 e aos sábados das 08:00 às 13:00.\nPosso verificar um horário disponível na semana ou no sábado?`
      );
    }

    if (HOURS_QUESTION_REGEX.test(norm) && !WANTS_SCHEDULE_REGEX.test(norm)) {
      return finalizeReply(
        `Atendemos na ${clinicName} de segunda a sexta das 08:00 às 18:00 e aos sábados das 08:00 às 13:00. 😊\nPosso verificar os horários disponíveis para você?`
      );
    }

    // 15. ETAPA DE OFERTA / SELEÇÃO DE HORÁRIOS
    if (lead.status === "agendamento_oferecido") {
      if (SLOT_REJECTION_REGEX.test(norm) || NEGATIVE_REGEX.test(norm)) {
        return finalizeReply(
          "Sem problemas. 😊\nExiste algum dia ou período que costuma ser melhor para você?"
        );
      }

      if (MORNING_REGEX.test(norm) || AFTERNOON_REGEX.test(norm) || isSatReq) {
        let filtered = openSlots;
        if (isSatReq) filtered = satSlots;
        else if (MORNING_REGEX.test(norm) && !AFTERNOON_REGEX.test(norm)) {
          filtered = openSlots.filter((s) => s.period === "manha");
        } else if (AFTERNOON_REGEX.test(norm) && !MORNING_REGEX.test(norm)) {
          filtered = openSlots.filter((s) => s.period === "tarde");
        }
        const top3 = (filtered.length >= 3 ? filtered : openSlots).slice(0, 3);
        lead.offeredPairIds = top3.map((s) => s.id);
        return finalizeReply(formatThreeSlotsMessage(top3));
      }

      let chosenSlot = null;
      if (/\b(primeir[ao]|opcao\s*1|horario\s*1|^1$)\b/i.test(norm) && lead.offeredPairIds?.[0]) {
        chosenSlot = db.slots.find((s) => s.id === lead.offeredPairIds[0]);
      } else if (/\b(segund[ao]|opcao\s*2|horario\s*2|^2$)\b/i.test(norm) && lead.offeredPairIds?.[1]) {
        chosenSlot = db.slots.find((s) => s.id === lead.offeredPairIds[1]);
      } else if (/\b(terceir[ao]|opcao\s*3|horario\s*3|^3$)\b/i.test(norm) && lead.offeredPairIds?.[2]) {
        chosenSlot = db.slots.find((s) => s.id === lead.offeredPairIds[2]);
      } else if (reqMins !== null) {
        const hhmm = `${String(Math.floor(reqMins / 60)).padStart(2, "0")}:${String(reqMins % 60).padStart(2, "0")}`;
        chosenSlot =
          db.slots.find((s) => lead.offeredPairIds?.includes(s.id) && s.startTime === hhmm && !s.bookedByPhone) ||
          db.slots.find((s) => s.startTime === hhmm && (isSatReq ? s.isSaturday : true) && !s.bookedByPhone);
      }

      if (chosenSlot && !chosenSlot.bookedByPhone) {
        const hasFullName = Boolean(lead.name && lead.name.trim().split(/\s+/).length >= 2);
        const hasValidPhone = Boolean(String(lead.phone || "").replace(/\D+/g, "").length >= 10);

        if (!hasFullName || !hasValidPhone) {
          lead.awaitingBookingData = true;
          lead.pendingSlotId = chosenSlot.id;
          return finalizeReply("Perfeito.\nPoderia me informar:\n• Nome completo\n• Telefone");
        }

        chosenSlot.bookedByPhone = phone;
        lead.bookedSlotId = chosenSlot.id;
        lead.scheduledSlotLabel = chosenSlot.label;
        lead.bookedDate = todayIso;
        lead.awaitingConfirmation = false;
        lead.status = "agendado";
        lead.consentimentoLgpd = true;
        dashEngine.recordLeadBooked(phone, chosenSlot.isoDate);
        const dt = splitSlotDateAndTime(chosenSlot, chosenSlot.label);
        generatedReceptionAlert = emitCorporateReceptionAlert("novo_agendamento", lead, {
          data: dt.data,
          horario: dt.horario,
          interesse: lead.interesse,
          origem: lead.origem,
        });
        return finalizeReply(
          `Tudo certo! 😊\n👤 Nome: ${lead.name}\n📅 Data: ${dt.data}\n⏰ Horário: ${dt.horario}\n📍 Endereço: ${clinicAddress}${parkingSuffix}`,
          { markBookedToday: true }
        );
      }
    }

    // 16. SAUDAÇÃO INICIAL CORPORATIVA
    if (isNewLead && PURE_COMPOUND_GREETING_RX.test(norm)) {
      return finalizeReply(
        `Olá! 😊\nSeja muito bem-vindo(a) à ${clinicName}.\nEu sou a ${assistantName} e estou aqui para ajudá-lo(a).\nAntes de começarmos, como posso te chamar?`
      );
    }

    // 17. CAPTURA DO NOME -> SOLICITAÇÃO DE CONSENTIMENTO LGPD
    if (
      !lead.name &&
      norm.split(/\s+/).length <= 5 &&
      !PURE_COMPOUND_GREETING_RX.test(norm) &&
      !WANTS_SCHEDULE_REGEX.test(norm) &&
      !spontaneousInterest &&
      !/^(sim|nao|ok|obrigad[oa])$/i.test(norm)
    ) {
      const cleanName = text
        .replace(/^(?:(?:oi+|ol[aá]+|bom\s+dia|boa\s+tarde|boa\s+noite)[,!?.:\s]+)*(?:eu\s+sou\s+[oa]\s+|me\s+chamo\s+|meu\s+nome\s+[eé]\s+|sou\s+[oa]\s+|pode\s+me\s+chamar\s+de\s+)?/i, "")
        .replace(/[!?.:,]+$/g, "")
        .trim();
      if (cleanName && /^[A-Za-zÀ-ÿ\s]{2,45}$/.test(cleanName)) {
        lead.name = cleanName
          .split(/\s+/)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(" ");
        lead.lgpdAsked = true;
        const firstDisp = lead.name.split(" ")[0];
        return finalizeReply(
          `Prazer em falar com você, ${firstDisp}! 😊\n\nUtilizaremos suas informações exclusivamente para atendimento, agendamentos e eventuais retornos autorizados.\nVocê concorda?`
        );
      }
    }

    // 18. RESPOSTA AO CONSENTIMENTO LGPD -> PERGUNTA DE ORIGEM DO LEAD
    if (lead.lgpdAsked && !lead.consentimentoLgpd) {
      if (NEGATIVE_REGEX.test(norm)) {
        lead.status = "perdido";
        lead.motivoPerda = "optout";
        lead.optout = { status: true, data: new Date().toISOString() };
        return finalizeReply(
          "Compreendo perfeitamente. 😊\nSem o consentimento de uso de dados não prosseguiremos com o cadastro, respeitando integralmente a LGPD.\nCaso mude de ideia no futuro, estaremos à disposição!"
        );
      }
      if (AFFIRMATIVE_REGEX.test(norm) || spontaneousOrigin || spontaneousInterest) {
        lead.consentimentoLgpd = true;
        lead.lgpdConsentAt = new Date().toISOString();
        if (!lead.originAsked && !spontaneousOrigin) {
          lead.originAsked = true;
          return finalizeReply(
            "Obrigada! 😊\nSó para entendermos melhor, como você conheceu a clínica?"
          );
        }
      }
    }

    // 19. RESPOSTA À ORIGEM DO LEAD -> IDENTIFICAR NECESSIDADE
    if (lead.originAsked && spontaneousOrigin && !spontaneousInterest && !WANTS_SCHEDULE_REGEX.test(norm)) {
      lead.origem = spontaneousOrigin;
      if (!lead.interestIdentified) {
        return finalizeReply(
          `Que ótimo saber${greetComma}! 😊\nComo posso ajudar você hoje? (Ex.: implante, ortodontia, estética, limpeza, avaliação ou urgência)`
        );
      }
    }

    // 20. ACEITE PARA VERIFICAR HORÁRIOS -> OFERTA DE 3 HORÁRIOS
    if (
      (AFFIRMATIVE_REGEX.test(norm) && (lead.interestIdentified || lead.priceQuestionCount > 0)) ||
      WANTS_SCHEDULE_REGEX.test(norm) ||
      reqMins !== null
    ) {
      if (reqMins !== null) {
        const hhmm = `${String(Math.floor(reqMins / 60)).padStart(2, "0")}:${String(reqMins % 60).padStart(2, "0")}`;
        const exactSlot = db.slots.find((s) => s.startTime === hhmm && (isSatReq ? s.isSaturday : true) && !s.bookedByPhone);
        if (exactSlot) {
          const hasFullName = Boolean(lead.name && lead.name.trim().split(/\s+/).length >= 2);
          if (!hasFullName) {
            lead.status = "agendamento_oferecido";
            lead.awaitingBookingData = true;
            lead.pendingSlotId = exactSlot.id;
            return finalizeReply("Perfeito.\nPoderia me informar:\n• Nome completo\n• Telefone");
          }
          exactSlot.bookedByPhone = phone;
          lead.bookedSlotId = exactSlot.id;
          lead.scheduledSlotLabel = exactSlot.label;
          lead.bookedDate = todayIso;
          lead.status = "agendado";
          lead.consentimentoLgpd = true;
          dashEngine.recordLeadBooked(phone, exactSlot.isoDate);
          const dt = splitSlotDateAndTime(exactSlot, exactSlot.label);
          generatedReceptionAlert = emitCorporateReceptionAlert("novo_agendamento", lead, {
            data: dt.data,
            horario: dt.horario,
            interesse: lead.interesse,
            origem: lead.origem,
          });
          return finalizeReply(
            `Tudo certo! 😊\n👤 Nome: ${lead.name}\n📅 Data: ${dt.data}\n⏰ Horário: ${dt.horario}\n📍 Endereço: ${clinicAddress}${parkingSuffix}`,
            { markBookedToday: true }
          );
        }
      }

      const pool = isSatReq ? (satSlots.length >= 3 ? satSlots : openSlots) : openSlots;
      const top3 = pool.slice(0, 3);
      lead.status = "agendamento_oferecido";
      lead.offeredPairIds = top3.map((s) => s.id);
      return finalizeReply(formatThreeSlotsMessage(top3));
    }

    // 21. FLUXOS DE INTERESSE QUALIFICADOS (Implante, Ortodontia, Estética, Limpeza, Urgência, Avaliação)
    if (spontaneousInterest) {
      lead.interesse = spontaneousInterest;
      lead.interestIdentified = true;
      lead.status = "qualificado";
      return finalizeReply(buildInterestReply(spontaneousInterest));
    }

    // 22. AGRADECIMENTO GENTIL
    if (GRATITUDE_REGEX.test(norm)) {
      return finalizeReply(
        `Imagina, por nada${greetComma}! 😊 Precisando de qualquer informação aqui na ${clinicName}, estou à disposição.`
      );
    }

    // 23. SE AINDA NÃO TEM NOME, PEDE COM ACOLHIMENTO
    if (!lead.name) {
      return finalizeReply(
        `Olá! 😊\nSeja muito bem-vindo(a) à ${clinicName}.\nEu sou a ${assistantName} e estou aqui para ajudá-lo(a).\nAntes de começarmos, como posso te chamar?`
      );
    }

    // 24. SE AINDA NÃO CONFIRMOU LGPD, SOLICITA CONSENTIMENTO
    if (!lead.consentimentoLgpd && !lead.lgpdAsked) {
      lead.lgpdAsked = true;
      return finalizeReply(
        "Utilizaremos suas informações exclusivamente para atendimento, agendamentos e eventuais retornos autorizados.\nVocê concorda?"
      );
    }

    // 25. FALLBACK EMPÁTICO CORPORATIVO (Sem pressionar e sem informar preços)
    if (lead.status === "recebido" || lead.status === "engajado") {
      lead.status = "qualificado";
    }
    return finalizeReply(
      `Entendi${greetComma}! 😊\nPara eu ajudá-lo(a) da melhor forma na ${clinicName}, você busca avaliação para algum tratamento específico (implante, ortodontia, estética, limpeza ou urgência) ou gostaria de tirar alguma dúvida sobre a clínica?`
    );
  });
}

function buildReminder24hMessage(leadName, slotLabel, targetPhone = "") {
  const settings = getClinicSettings();
  const assistantName = settings.assistantName || "Serena";
  const clinic = settings.clinicName;
  const addr = settings.clinicAddress || settings.address;
  const cleanFirst = String(leadName || "").trim().split(/\s+/)[0];
  const greet = cleanFirst && !/^(tudo|paciente|visitante|novo)/i.test(cleanFirst) ? `, ${cleanFirst}` : "";
  const msg = `Olá${greet}, tudo bem? 😊 Aqui é a ${assistantName} da ${clinic}.\n\nPassando com carinho para confirmar seu agendamento já reservado (${slotLabel || "horário agendado"}) com nosso profissional.\n\n📍 Endereço: ${addr}\n\nPodemos manter seu horário confirmado ou você precisa reagendar/cancelar?`;
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

async function forwardReceptionAlertIfConfigured(clientOrSock, alertObj) {
  try {
    if (!clientOrSock || !alertObj || !alertObj.formattedMessage) return false;
    const settings = getClinicSettings();
    const rawRec = String(settings.receptionWhatsapp || "").replace(/\D+/g, "");
    if (rawRec.length < 10) return false;
    const recDigits = rawRec.startsWith("55") ? rawRec : `55${rawRec}`;
    const isBaileys = Boolean(clientOrSock.ev) || (typeof clientOrSock.sendPresenceUpdate === "function" && !clientOrSock.getChatById);
    const recJid = isBaileys ? `${recDigits}@s.whatsapp.net` : `${recDigits}@c.us`;
    const sendFn = clientOrSock.__serenaOrigSendMessage
      ? clientOrSock.__serenaOrigSendMessage.bind(clientOrSock)
      : typeof clientOrSock.sendMessage === "function"
      ? clientOrSock.sendMessage.bind(clientOrSock)
      : null;
    if (!sendFn) return false;
    if (isBaileys) {
      await sendFn(recJid, { text: alertObj.formattedMessage });
    } else {
      await sendFn(recJid, alertObj.formattedMessage, { sendSeen: false }).catch(() =>
        sendFn(recJid, alertObj.formattedMessage)
      );
    }
    return true;
  } catch (_eRec) {
    return false;
  }
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
  try {
    const db = loadDb();
    const lead = db.leads && db.leads[targetJid];
    if (lead && lead.__lastReceptionAlert) {
      await forwardReceptionAlertIfConfigured(clientOrSock, lead.__lastReceptionAlert);
    }
  } catch (_eAlert) {}
  return reply;
}

module.exports = {
  BRASILIA_TZ,
  getBrasiliaParts,
  getClinicSettings,
  saveClinicSettings,
  setCrcAssumiu,
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
  recordOperationEvent: dashEngine.recordOperationEvent,
  runSlaSweep: dashEngine.runSlaSweep,
};

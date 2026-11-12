/**
 * serenaCore.js — Máquina de Estados e Diálogo Humanizado da Serena
 * Unidade Odontológica: OdontoCompany Bela Vista Osasco
 */
const db = require('./db');
const schedule = require('./scheduleManager');
const holidays = require('./holidays');

function pickRandom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

// ── Variações da pergunta de encerramento / follow-up ─────────────────────────
const FOLLOWUP_PHRASES = [
  'Posso te ajudar com mais alguma coisa hoje? 😊',
  'Tem mais alguma dúvida que posso esclarecer? 😊',
  'Posso te ajudar em algo mais? É só falar! 😊',
  'Ficou alguma dúvida? Estou aqui para o que precisar! 😊',
  'Tem mais alguma coisa que eu possa fazer por você hoje? 😊',
];

/**
 * Normaliza texto para comparações inteligentes (remove acentos e pontuação)
 */
function cleanText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Lista de palavras e termos que não podem ser considerados nomes válidos
 */
const INVALID_NAMES = new Set([
  'ola', 'oi', 'bom', 'boa', 'dia', 'tarde', 'noite', 'quero', 'gostaria', 'sim', 'nao', 'agendar',
  'marcar', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo', 'preco', 'valor',
  'tudo', 'bem', 'favor', 'por', 'obrigado', 'obrigada', 'valeu', 'consulta', 'dente', 'clinica',
  'odontocompany', 'serena', 'nada', 'qualquer', 'coisa', 'teste', 'ok', 'pode', 'ser', 'horario',
  'avaliacao', 'fazer', 'passar', 'marcar', 'conversar', 'saber', 'informacao', 'informacoes', 'atendimento'
]);

/**
 * Filtro de palavrões / ofensas
 */
const PROFANITY_LIST = [
  'caralho', 'porra', 'puta', 'puto', 'merda', 'bosta', 'pqp', 'filho da puta', 'fdp', 'arrombado',
  'carai', 'vai tomar no cu', 'vtnc', 'vsf', 'cu', 'buceta', 'viado', 'viadinho', 'corno', 'otario', 'cacete'
];

function containsProfanity(text) {
  const norm = cleanText(text);
  return PROFANITY_LIST.some(bad => norm === bad || norm.includes(bad));
}

/**
 * Detecta se o paciente disse expressamente que não quer informar o nome
 */
function isRefusingName(text) {
  const norm = cleanText(text);
  const triggers = [
    'nao quero falar', 'nao quero dar', 'nao vou falar', 'nao precisa saber', 'nao te interessa',
    'sem nome', 'nao quero', 'precisa de nome', 'precisa saber meu nome', 'nao vou dizer', 'depois eu falo',
    'nao quero informar', 'prefiro nao dizer', 'nao quero dizer', 'nao precisa'
  ];
  return triggers.some(t => norm.includes(t));
}

/**
 * Detecta pedido de encerramento / opt-out
 */
function isOptOut(text) {
  const norm = cleanText(text);
  // Triggers simples — qualquer ocorrência isolada
  const triggers = ['pare', 'parar', 'sair', 'cancelar tudo', 'cancela tudo', 'nao me mande mais', 'bloquear'];
  if (triggers.some(t => norm === t || norm.startsWith(t + ' ') || norm.endsWith(' ' + t) || norm.includes(' ' + t + ' '))) return true;
  // "nao quero" só é opt-out se a mensagem for muito curta e sem contexto de horário/preferência
  if (norm === 'nao quero' || norm === 'nao quero mais') return true;
  const horarioCtx = ['manha', 'tarde', 'noite', 'horario', 'dia ', 'semana', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo', 'ir ', 'agend'];
  if (norm.startsWith('nao quero ') && !horarioCtx.some(k => norm.includes(k))) return true;
  return false;
}

/**
 * Detecta recusa simples, sem alternativa de agenda ("agora não", "no momento não",
 * "depois eu vejo", "vou pensar"...). Mensagens com data/horário ("hoje não",
 * "não posso de manhã") NÃO casam, pois indicam preferência e não desistência.
 */
const DECLINE_RE = new RegExp(
  '^(?:(?:ah |ai |olha |puxa |poxa |hum )?' +
  '(?:(?:agora|por enquanto|no momento|neste momento) (?:nao|nao quero|nao posso|nao da)(?: obrigad[ao])?' +
  '|nao (?:agora|por enquanto|no momento)(?: obrigad[ao])?)' +
  '|nao quero (?:agendar|marcar)(?: agora)?' +
  '|nao tenho interesse(?: agora)?' +
  '|depois eu (?:vejo|falo|entro em contato|te chamo|retorno)' +
  '|mais tarde eu (?:vejo|falo)' +
  '|talvez depois|quem sabe depois|deixa (?:pra|para) depois|vou pensar|outra hora)$'
);

/** Recusa seca ("não", "nenhuma") — só vale como encerramento após horários oferecidos. */
const BARE_DECLINE_RE = /^(?:nao|nenhum[ao]?(?: serve| dessas| desses| das opcoes)?)(?: obrigad[ao])?$/;

function normalizeForDecline(text) {
  return cleanText(text).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSimpleDecline(text) {
  return DECLINE_RE.test(normalizeForDecline(text));
}

function isBareDecline(text) {
  return BARE_DECLINE_RE.test(normalizeForDecline(text));
}

/**
 * Detecta emergências de dor/saúde
 */
function isEmergency(text) {
  const norm = cleanText(text);
  const keywords = ['dor', 'doendo', 'dor de dente', 'muita dor', 'inchaco', 'inchado', 'inchada', 'febre', 'sangrando', 'sangramento', 'urgencia', 'emergencia', 'quebrou o dente', 'caiu o dente'];
  return keywords.some(k => norm.includes(k));
}

/**
 * Detecta pedido explícito para falar com humano / recepção / especialista
 */
function isAskingForHuman(text) {
  const norm = cleanText(text);
  // 'dentista' e 'especialista' são termos odontológicos válidos — não transferem à recepção
  const triggers = [
    'falar com recepcao', 'recepcao', 'secretaria', 'atendente', 'humano',
    'falar com alguem', 'falar com uma pessoa', 'pessoa real', 'passa pra recepcao'
  ];
  return triggers.some(t => norm.includes(t));
}

/**
 * Detecta se perguntou se é robô / IA
 */
function isAskingIfRobot(text) {
  const norm = cleanText(text);
  const triggers = ['e robo', 'e um robo', 'e uma robo', 'e robozinho', 'voce e robo', 'voce e um robo', 'voce e robo?', 'e bot', 'e uma inteligencia artificial', 'e ia'];
  return triggers.some(t => norm.includes(t));
}

/**
 * Extração e validação de Nome próprio em mensagens
 */
function extractName(text) {
  if (!text) return null;
  if (containsProfanity(text)) return null;

  let cleaned = text.replace(/^(meu nome [eé]|me chamo|sou [oa]|pode me chamar de|sou|aqui [eé]|meu nome eh|chamo-me|chamo|me chamo de)\s+/i, '');
  cleaned = cleaned.replace(/[.,!?;:\(\)\[\]"']/g, '').trim();

  const norm = cleanText(cleaned);
  if (/^(.)\1+$/.test(norm) || /^(..)\1+$/.test(norm)) {
    return null;
  }

  const words = cleaned.split(/\s+/).filter(w => w.length >= 2);
  if (words.length > 0) {
    const candidate = words[0];
    const candidateNorm = cleanText(candidate);
    
    // Rejeita qualquer termo comum, verbo ou saudação
    if (INVALID_NAMES.has(candidateNorm)) return null;
    if (containsProfanity(candidate)) return null;

    // Deve conter apenas letras
    if (!/^[a-zA-ZÀ-ÿ]+$/.test(candidate)) return null;

    return candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
  }
  return null;
}

/**
 * Extrai data e horário a partir de texto informal
 */
function parseDateInput(text) {
  const norm = cleanText(text);
  const now = new Date();

  if (norm.includes('hoje')) {
    return holidays.formatDate(now);
  }
  if (norm.includes('amanha')) {
    const tm = new Date();
    tm.setDate(now.getDate() + 1);
    return holidays.formatDate(tm);
  }

  // Regex para DD/MM ou DD/MM/AAAA
  const matchDate = text.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (matchDate) {
    const day = parseInt(matchDate[1], 10);
    const month = parseInt(matchDate[2], 10) - 1;
    const year = matchDate[3] ? (matchDate[3].length === 2 ? 2000 + parseInt(matchDate[3], 10) : parseInt(matchDate[3], 10)) : now.getFullYear();
    const parsed = new Date(year, month, day);
    if (!isNaN(parsed.getTime())) {
      return holidays.formatDate(parsed);
    }
  }

  // Dias da semana: segunda, terca, quarta, quinta, sexta, sabado
  const weekDays = [
    { name: 'domingo', day: 0 },
    { name: 'segunda', day: 1 },
    { name: 'terca', day: 2 },
    { name: 'quarta', day: 3 },
    { name: 'quinta', day: 4 },
    { name: 'sexta', day: 5 },
    { name: 'sabado', day: 6 }
  ];

  for (const wd of weekDays) {
    if (norm.includes(wd.name)) {
      const targetDay = wd.day;
      const currentDay = now.getDay();
      let diff = targetDay - currentDay;
      if (diff <= 0) diff += 7; // Próximo dia da semana
      const nextDate = new Date();
      nextDate.setDate(now.getDate() + diff);
      return holidays.formatDate(nextDate);
    }
  }

  return null;
}

/**
 * Normaliza hora/minuto para o slot mais próximo de 30 em 30min.
 */
function snapToSlot(h, m) {
  if (m > 45) { m = 0; h += 1; }
  else if (m > 15) m = 30;
  else m = 0;
  return { h, m };
}

function fmtHM(h, m) {
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

/**
 * Extrai um horário EXATO da mensagem (HH:MM, 8h, 8h30, às 8, etc.)
 * Retorna "HH:MM" ou null.
 *
 * REGRAS ANTI-FALSO-POSITIVO:
 * - Números seguidos de "/" são datas (08/07) — ignorados
 * - Números sem marcador de hora (h, :, "horas", "hs", "às") só são aceitos
 *   se forem precedidos por "às", "as", "ao" ou "horario"
 * - Nunca captura números que fazem parte de expressões de filtro
 *   ("depois das", "após as", "a partir das")
 */
function parseTimeInput(text) {
  // Remove acentos para matching, mas preserva o texto original para regex
  const norm = cleanText(text);

  // 1. Não captura expressões de filtro mínimo nem de aproximação
  if (/depois\s+d[ae]s?|ap[oó]s\s+[ao]s?|a\s+partir\s+d[ae]s?/i.test(text)) return null;
  if (/perto\s+das?|por\s+volta\s+das?|l[aá]\s+pelas?/i.test(text)) return null;

  // 2. Formatos explícitos com marcador de hora:
  //    HH:MM, HHhMM, HHh, "às HH", "as HH", "horario HH"
  //    EXCLUI números seguidos de "/" (são datas)
  const explicit = [
    // "às 10h30", "as 10:30", "10h30", "10:30"
    /(?:^|[\s,])[aà]s?\s+(\d{1,2})h(\d{2})/i,
    /(?:^|[\s,])[aà]s?\s+(\d{1,2})[h:](\d{2})/i,
    /(?:^|[\s,])(\d{1,2})h(\d{2})(?!\d)/i,
    /(?:^|[\s,])(\d{1,2}):(\d{2})(?!\d)/i,
    // "às 10h", "as 8h", "10h", "8hs", "8 horas"
    /(?:^|[\s,])[aà]s?\s+(\d{1,2})h(?!\d)/i,
    /(?:^|[\s,])(\d{1,2})\s*(?:horas|hs)(?!\d)/i,
    /(?:^|[\s,])(\d{1,2})h(?!\d)/i,
    // "às 10", "horario 10", "horario das 10" — número simples com contexto explícito
    /(?:hor[aá]rio(?:\s+das?)?\s+)(\d{1,2})(?![\d\/])/i,
    /(?:^|[\s,])[aà]s?\s+(\d{1,2})(?![\d\/h:])/i,
  ];

  for (const pat of explicit) {
    const m = text.match(pat);
    if (m) {
      let h = parseInt(m[1], 10);
      let mn = m[2] ? parseInt(m[2], 10) : 0;
      if (h >= 0 && h <= 23) {
        const snapped = snapToSlot(h, mn);
        return fmtHM(snapped.h, snapped.m);
      }
    }
  }

  // 3. Períodos informais — retorna string de período, não HH:MM
  if (norm.includes('manha') || norm.includes('cedo')) return 'manha';
  if (norm.includes('tarde')) return 'tarde';
  if (norm.includes('noite')) return 'noite'; // fora do horário — tratado no fluxo

  return null;
}

/**
 * Detecta expressão de horário MÍNIMO: "depois das X", "após as X", "a partir das X".
 * Retorna "HH:MM" (primeiro slot >= X) ou null.
 * Opera sobre texto normalizado para lidar com acentos.
 */
function parseMinTimeFilter(text) {
  const n = cleanText(text); // normalizado sem acentos
  const minPatterns = [
    /depois\s+d[ae]s?\s+(\d{1,2})(?:[h:](\d{2})?)?/,
    /a\s+partir\s+d[ae]s?\s+(\d{1,2})(?:[h:](\d{2})?)?/,
    /partir\s+d[ae]s?\s+(\d{1,2})(?:[h:](\d{2})?)?/,
    /apos\s+[ao]s?\s+(\d{1,2})(?:[h:](\d{2})?)?/,
    /apos\s+(\d{1,2})(?:[h:](\d{2})?)?/,
  ];
  for (const pat of minPatterns) {
    const m = n.match(pat);
    if (m) {
      let h = parseInt(m[1], 10);
      let mn = m[2] ? parseInt(m[2], 10) : 0;
      if (h >= 0 && h <= 23) {
        const snapped = snapToSlot(h, mn);
        return fmtHM(snapped.h, snapped.m);
      }
    }
  }
  return null;
}

/**
 * Detecta horário APROXIMADO: "perto das X", "por volta das X", "lá pelas X".
 * Retorna "HH:MM" ou null.
 */
function parseApproxTime(text) {
  const n = cleanText(text);
  const pat = /(?:perto\s+das?|por\s+volta\s+das?|la\s+pelas?)\s+(\d{1,2})(?:[h:](\d{2})?)?/;
  const m = n.match(pat);
  if (m) {
    let h = parseInt(m[1], 10);
    let mn = m[2] ? parseInt(m[2], 10) : 0;
    if (h >= 0 && h <= 23) {
      const snapped = snapToSlot(h, mn);
      return fmtHM(snapped.h, snapped.m);
    }
  }
  return null;
}

/**
 * Gera atraso humanizado aleatório entre 3 e 6 segundos
 */
function getRandomTypingDelay() {
  return Math.floor(Math.random() * (6000 - 3000 + 1)) + 3000;
}

// ── Menu de triagem (Etapa 2) ─────────────────────────────────────────────────
const TRIAGEM_MENU = (name) =>
  `Prazer, *${name}*! ✨\n\n` +
  `Me conte uma coisa: o que você precisa resolver hoje com a gente?\n\n` +
  `1️⃣ Estou sentindo dor, quebrei um dente ou é urgência\n` +
  `2️⃣ Quero repor dentes com Implantes ou Prótese\n` +
  `3️⃣ Quero alinhar meus dentes com Aparelho\n` +
  `4️⃣ Quero transformar meu sorriso (Lentes / Clareamento)\n` +
  `5️⃣ Limpeza, canal ou Check-up Geral\n\n` +
  `_(Basta digitar o número ou descrever com suas palavras!)_`;

/**
 * Interpreta a escolha do menu de triagem e retorna a categoria.
 * Retorna: 'urgencia' | 'implante' | 'aparelho' | 'estetica' | 'geral' | null
 */
function parseTriagemChoice(norm) {
  if (norm === '1' || /dor|urgencia|emergencia|quebrei|quebrou|caiu|dente quebrado/.test(norm)) return 'urgencia';
  if (norm === '2' || /implante|protese|repor dente|reposicao/.test(norm)) return 'implante';
  if (norm === '3' || /aparelho|ortodontia|alinhador|invisalign|bracket/.test(norm)) return 'aparelho';
  if (norm === '4' || /lente|faceta|clareamento|estetica|sorriso|branqueamento/.test(norm)) return 'estetica';
  if (norm === '5' || /limpeza|canal|check.?up|profilaxia|tartaro|rotina|consulta rotina/.test(norm)) return 'geral';
  return null;
}

/**
 * Mensagem de construção de valor após triagem — diferenciada por categoria.
 */
function buildTriagemValueMsg(name, category) {
  const n = name ? `, *${name}*` : '';
  if (category === 'urgencia') {
    return (
      `Compreendo${n}! Dor de dente não pode esperar. 🚨\n\n` +
      `Nossos especialistas deixam encaixes reservados exatamente para situações assim — ` +
      `para aliviar seu incômodo o mais rápido possível e com todo o cuidado.\n\n` +
      `Vou verificar o primeiro horário disponível para você agora mesmo!`
    );
  }
  if (category === 'implante') {
    return (
      `Excelente escolha${n}! Recuperar a função mastigatória e a autoestima muda totalmente o dia a dia. 😊\n\n` +
      `Nossos especialistas em implantodontia utilizam *tecnologia digital 3D* para planejar ` +
      `o resultado com precisão antes mesmo de começar.\n\n` +
      `Vamos agendar sua avaliação diagnóstica gratuita?`
    );
  }
  if (category === 'aparelho') {
    return (
      `Que ótimo${n}! Um sorriso alinhado transforma a confiança e a saúde bucal. ✨\n\n` +
      `Trabalhamos com *aparelhos convencionais e alinhadores invisíveis* — ` +
      `nosso ortodontista vai avaliar qual opção é a ideal para o seu caso.\n\n` +
      `Vamos agendar sua avaliação gratuita?`
    );
  }
  if (category === 'estetica') {
    return (
      `Excelente escolha${n}! Um sorriso renovado eleva a autoestima e muda a primeira impressão. ✨\n\n` +
      `Nossos especialistas em estética dental usam *tecnologia digital* para simular ` +
      `o resultado do seu novo sorriso antes do procedimento.\n\n` +
      `Vamos agendar sua avaliação diagnóstica gratuita?`
    );
  }
  // geral
  return (
    `Perfeito${n}! Manter a saúde bucal em dia é o melhor investimento que existe. 🦷\n\n` +
    `Nossos dentistas fazem uma *avaliação completa* para identificar tudo que precisa de atenção ` +
    `e já apresentar um plano de cuidados.\n\n` +
    `Vamos agendar sua avaliação gratuita?`
  );
}

/**
 * Processador principal do diálogo
 */
async function processMessage(phone, incomingText, whatsappSender, pushName = '') {
  const config = db.getConfig();
  if (config.serena_enabled === '0') return;

  const receptionPhone = (config.reception_phone || '').replace(/\D/g, '');
  const cleanPhone = phone.replace(/\D/g, '');

  // Regra: mensagens enviadas da recepção não são tratadas como leads
  if (receptionPhone && (cleanPhone === receptionPhone || cleanPhone.includes(receptionPhone) || receptionPhone.includes(cleanPhone))) {
    return;
  }

  // 1. Registra mensagem de entrada
  db.insertSerenaMessage(cleanPhone, 'lead', incomingText);

  let lead = db.getSerenaLead(cleanPhone);
  if (!lead) {
    // Agendamento do 1º toque de follow-up (T+30 min) para caso o lead não responda mais
    const firstFollowup = require('./serenaFollowup').computeNextFollowupDate(new Date(), 30);
    lead = db.upsertSerenaLead(cleanPhone, {
      state: 'NEW',
      origin: 'inbound_whatsapp',
      reply_count: 1,
      unanswered_bot_count: 0,
      next_followup_at: firstFollowup
    });
  } else {
    // Lead interagiu: cancela timer pendente anterior ou reagenda próximo resgate inteligente
    const currentReplies = (lead.reply_count || 0) + 1;
    const isUrgentLead = Boolean(lead.is_urgent);
    const nextMinutes = isUrgentLead ? 20 : 45; // 20m para dor, 45m para triagem/preço
    const nextRescue = require('./serenaFollowup').computeNextFollowupDate(new Date(), nextMinutes);

    lead = db.upsertSerenaLead(cleanPhone, {
      reply_count: currentReplies,
      unanswered_bot_count: 0,
      next_followup_at: nextRescue
    });
  }

  let stateData = {};
  try { stateData = JSON.parse(lead.state_data || '{}'); } catch (_) {}

  // Checa se o lead já deu opt-out ou foi assumido manualmente pela recepção / CRC
  if (lead.opt_out === 1 || lead.human === 1) {
    return;
  }

  // ── 1. Gatilho de Opt-Out / Parar ──────────────────────────────────────────
  if (isOptOut(incomingText)) {
    db.upsertSerenaLead(cleanPhone, { opt_out: 1, state: 'OPT_OUT', next_followup_at: null });
    const reply = "Tudo bem! Não enviaremos mais mensagens por aqui. Se precisar de algo no futuro, estamos sempre à disposição na OdontoCompany Bela Vista Osasco. Tenha um excelente dia!";
    await sendSerenaReply(cleanPhone, reply, whatsappSender);
    return;
  }

  // ── 2. Gatilho de Emergência (Dor, Febre, Inchaço) ──────────────────────────
  if (isEmergency(incomingText)) {
    db.upsertSerenaLead(cleanPhone, {
      state: 'EMERGENCIA',
      is_urgent: 1,
      procedure_interest: 'Dor / Urgência',
      transferred_to_reception: 1,
      reception_transfer_time: new Date().toISOString().replace('T', ' ').substring(0, 19)
    });

    const reply = "Entendo perfeitamente e vejo que é uma situação de urgência! Já estou acionando nossa equipe agora mesmo com prioridade para te atender o mais rápido possível.";
    await sendSerenaReply(cleanPhone, reply, whatsappSender);

    await notifyReception(
      `🚨 URGÊNCIA ODONTOLÓGICA!\nPaciente: ${lead.name || 'Nome a confirmar'}\nTelefone: ${cleanPhone}\nRelato: "${incomingText}"\nPor favor, entrar em contato imediatamente!`,
      whatsappSender
    );
    return;
  }

  // ── 3. Gatilho "Você é robô?" ──────────────────────────────────────────────
  if (isAskingIfRobot(incomingText)) {
    db.upsertSerenaLead(cleanPhone, {
      state: 'TRANSFERIDO_RECEPCAO',
      transferred_to_reception: 1,
      next_followup_at: null,
      reception_transfer_time: new Date().toISOString().replace('T', ' ').substring(0, 19)
    });

    const reply = "Vou te transferir agora mesmo para uma de nossas secretárias na recepção para dar continuidade ao seu atendimento com todo carinho. Um instante!";
    await sendSerenaReply(cleanPhone, reply, whatsappSender);

    await notifyReception(
      `O prospect "${lead.name || 'sem nome'}" e telefone ${cleanPhone}, está solicitando contato com a recepção. Obrigado Serena`,
      whatsappSender
    );
    return;
  }

  // ── 4. Gatilho de Solicitação de Especialista / Recepção Direta ─────────────
  if (isAskingForHuman(incomingText)) {
    db.upsertSerenaLead(cleanPhone, {
      state: 'TRANSFERIDO_RECEPCAO',
      transferred_to_reception: 1,
      next_followup_at: null,
      reception_transfer_time: new Date().toISOString().replace('T', ' ').substring(0, 19)
    });

    const reply = "Com certeza! Vou passar seu contato agora para a nossa recepção entrar em contato com você o quanto antes.";
    await sendSerenaReply(cleanPhone, reply, whatsappSender);

    await notifyReception(
      `O prospect "${lead.name || 'sem nome'}" e telefone ${cleanPhone}, está solicitando contato. Obrigado Serena`,
      whatsappSender
    );
    return;
  }

  // ── 5. Tratamento da Verificação de 2h da Recepção ("Conseguiu falar?") ──────
  if (lead.state === 'VERIFICACAO_RECEPCAO_AGUARDANDO') {
    const norm = cleanText(incomingText);
    if (norm === '1' || norm.includes('sim') || norm.includes('consegui') || norm.includes('falei')) {
      db.upsertSerenaLead(cleanPhone, { state: 'CONCLUIDO', reception_check_done: 1 });
      const reply = "Que maravilha! Fico feliz que conseguiu falar com nossa equipe. 😊";
      await sendWithFollowup(cleanPhone, reply, lead.name, whatsappSender);
      return;
    } else if (norm === '2' || norm.includes('nao') || norm.includes('ainda nao')) {
      db.upsertSerenaLead(cleanPhone, { state: 'TRANSFERIDO_RECEPCAO', reception_check_done: 1 });
      const reply = "Puxa, peço desculpas pela demora! Já reforcei o aviso com a nossa recepção com prioridade para te ligarem.";
      await sendSerenaReply(cleanPhone, reply, whatsappSender);

      await notifyReception(
        `⚠️ REFORÇO: O prospect "${lead.name || 'sem nome'}" (${cleanPhone}) informou que ainda NÃO conseguiu falar com a recepção após 2h. Favor contatar com urgência!`,
        whatsappSender
      );
      return;
    }
  }

  // ── 6. Resposta ao Lembrete de Agendamento ──────────────────────────────────
  if (lead.state === 'AGUARDANDO_CONFIRMACAO_LEMBRETE') {
    const norm = cleanText(incomingText);
    const sd = stateData;
    const apptId   = sd.reminderAppointmentId;
    const apptDate = sd.reminderDate;
    const apptTime = sd.reminderTime;
    const nome = lead.name || '';
    const formattedDate = apptDate ? schedule.formatDateBr(apptDate) : '';

    if (norm === '1' || norm.includes('confirm') || norm.includes('sim') || norm.includes('pode')) {
      // Confirmou — mantém agendamento
      if (apptId) db.updateAppointmentReminderResponse(apptId, 'confirmed');
      db.upsertSerenaLead(cleanPhone, { state: 'AGENDADO' });
      const reply = `Perfeito${nome ? ', ' + nome : ''}! Seu agendamento está confirmado para *${formattedDate} às ${apptTime}*. 😊\n\nTe esperamos com muito carinho na OdontoCompany Bela Vista Osasco!`;
      await sendWithFollowup(cleanPhone, reply, nome, whatsappSender);
      await notifyReception(`✅ Lembrete confirmado: *${nome || 'sem nome'}* (${cleanPhone}) confirmou agendamento em ${formattedDate} às ${apptTime}.`, whatsappSender);
      return;

    } else if (norm === '2' || norm.includes('reagend') || norm.includes('remarcar') || norm.includes('mudar')) {
      // Quer reagendar — cancela o atual e inicia fluxo de reagendamento
      if (apptId) {
        db.updateAppointmentReminderResponse(apptId, 'rescheduled');
        db.cancelAppointmentByPhone(cleanPhone);
      }
      db.upsertSerenaLead(cleanPhone, { state: 'AGUARDANDO_PREFERENCIA' });
      const reply = `Sem problemas${nome ? ', ' + nome : ''}! Vamos encontrar um novo horário para você. 😊\n\nQual dia e período (manhã ou tarde) fica melhor?`;
      await sendSerenaReply(cleanPhone, reply, whatsappSender);
      return;

    } else if (norm === '3' || norm.includes('cancelar') || norm.includes('nao consigo') || norm.includes('nao vou')) {
      // Quer cancelar — tenta reagendar antes de aceitar o cancelamento
      if (apptId) db.updateAppointmentReminderResponse(apptId, 'cancelled');
      db.upsertSerenaLead(cleanPhone, { state: 'TENTANDO_REAGENDAR_CANCELAMENTO' });
      const reply = `Que pena${nome ? ', ' + nome : ''}! Entendo que imprevistos acontecem. 🙏\n\nAntes de cancelar, que tal verificarmos outro horário que fique melhor para você? Cuidar do sorriso é importante! Prefere manhã ou tarde?`;
      await sendSerenaReply(cleanPhone, reply, whatsappSender);
      return;

    } else {
      // Resposta ambígua — repete o lembrete
      const reply = `${nome ? nome + ', r' : 'R'}esponda com o número da opção:\n\n*1* – ✅ Confirmo\n*2* – 🔄 Quero Reagendar\n*3* – ❌ Preciso Cancelar`;
      await sendSerenaReply(cleanPhone, reply, whatsappSender);
      return;
    }
  }

  // ── 6b. Tentando reagendar após intenção de cancelamento ────────────────────
  if (lead.state === 'TENTANDO_REAGENDAR_CANCELAMENTO') {
    const norm = cleanText(incomingText);
    const confirmaCancel = norm.includes('cancelar') || norm.includes('nao quero') || norm.includes('nao preciso') || norm === '3';

    if (confirmaCancel) {
      db.cancelAppointmentByPhone(cleanPhone);
      db.upsertSerenaLead(cleanPhone, { state: 'CONCLUIDO' });
      const reply = `Tudo bem${lead.name ? ', ' + lead.name : ''}! Cancelei seu agendamento. Lembre-se que quando quiser, nossa avaliação gratuita estará sempre disponível para você. 🦷`;
      await sendWithFollowup(cleanPhone, reply, lead.name, whatsappSender);
      await notifyReception(`❌ Cancelamento confirmado: *${lead.name || 'sem nome'}* (${cleanPhone}) cancelou o agendamento via lembrete.`, whatsappSender);
      return;
    } else {
      // Qualquer outra coisa — trata como intenção de reagendar
      db.upsertSerenaLead(cleanPhone, { state: 'AGUARDANDO_PREFERENCIA' });
      const updatedLead = db.getSerenaLead(cleanPhone);
      await handleConversationFlow(updatedLead, cleanPhone, incomingText, stateData, whatsappSender, pushName);
      return;
    }
  }

  // ── 7. Diálogo após Agendamento Concluído ───────────────────────────────────
  if (lead.state === 'AGENDADO' || lead.state === 'CONCLUIDO') {
    const norm = cleanText(incomingText);
    if (!norm.includes('cancelar') && !norm.includes('desmarcar') && !norm.includes('remarcar') && !norm.includes('mudar')) {
      // Tenta atender a intenção direta antes de responder genericamente
      db.upsertSerenaLead(cleanPhone, { state: 'AGUARDANDO_PREFERENCIA' });
      const updatedLead = db.getSerenaLead(cleanPhone);
      let updatedStateData = {};
      try { updatedStateData = JSON.parse(updatedLead.state_data || '{}'); } catch (_) {}
      const intentHandled = await handleIntentFromAnyState(updatedLead, cleanPhone, incomingText, norm, updatedStateData, lead.name, whatsappSender, pushName);
      if (intentHandled) return;
      // Fallback: saudação genérica
      const reply = lead.name
        ? `Olá ${lead.name}! Como posso te ajudar hoje?`
        : `Olá! Como posso te ajudar hoje?`;
      await sendSerenaReply(cleanPhone, reply, whatsappSender);
      return;
    }
  }

  // ── 7. Máquina de Estados Principal do Atendimento ───────────────────────────
  await handleConversationFlow(lead, cleanPhone, incomingText, stateData, whatsappSender, pushName);
}

// ── Especialidades odontológicas reconhecidas ──────────────────────────────────
const DENTAL_SPECIALTIES = [
  'implante', 'implantes', 'protese', 'proteses', 'coroa', 'coroas',
  'ortodontia', 'aparelho', 'bracket', 'alinhador', 'invisalign',
  'clareamento', 'branqueamento', 'estetica', 'lente', 'faceta', 'restauracao',
  'canal', 'endodontia', 'tratamento de canal',
  'extracao', 'dente do siso', 'siso',
  'limpeza', 'profilaxia', 'tartaro', 'gengivite', 'periodontia', 'gengiva',
  'cirurgia', 'enxerto',
  'radiografia', 'rx', 'escaneamento',
  'dente', 'dentes', 'boca', 'sorriso', 'dentista', 'odontologia', 'odontologico',
  'bruxismo', 'placa', 'placa de mordida',
  'halitose', 'mau halito',
  'pediatria', 'odontopediatria', 'dente de leite',
  'implantodontia', 'protesista', 'endodontista', 'periodontista', 'ortodontista'
];

// ── Termos claramente fora da odontologia ──────────────────────────────────────
const NON_DENTAL_KEYWORDS = [
  // Médicos e especialidades médicas
  'medico', 'medica', 'consulta medica', 'hospital', 'pronto socorro', 'upa',
  'cardiologista', 'cardiologia', 'coracao',
  'dermato', 'dermatologista', 'dermatologia', 'pele',
  'plastica', 'cirurgia plastica', 'rinoplastia', 'lipoaspiracao', 'botox',
  'psicologia', 'psicologo', 'psicologa', 'psiquiatria', 'psiquiatra',
  'nutricao', 'nutricionista', 'dieta', 'emagrecimento',
  'fisioterapia', 'fisioterapeuta', 'reabilitacao',
  'ortopedia', 'ortopedista', 'joelho', 'quadril', 'coluna', 'fratura',
  'neurologista', 'neurologia', 'enxaqueca', 'epilepsia',
  'oftalmo', 'oftalmologista', 'oftalmologia', 'olho', 'visao', 'oculos',
  'ginecologia', 'ginecologista', 'obstetricia', 'obstetra',
  'urologia', 'urologista', 'rim', 'bexiga',
  'pediatra', 'pediatria',
  'otorrino', 'otorrinolaringologista', 'ouvido', 'nariz',
  'pneumologista', 'pneumologia', 'pulmao', 'asma',
  'gastro', 'gastroenterologista', 'estomago', 'intestino', 'colite',
  'endocrinologista', 'endocrinologia', 'diabetes', 'tireoide', 'hormonio',
  'receita medica', 'prescricao', 'atestado medico',
  'clinica geral', 'clinico geral',
  // Animais
  'veterinario', 'veterinaria', 'cachorro', 'gato', 'pet',
  // Farmácia / medicamentos
  'farmacia', 'remedio', 'medicamento', 'antibiotico', 'analgesico',
  'ibuprofeno', 'dipirona', 'paracetamol',
  // Estética não-dental e serviços gerais
  'cabelo', 'cabeleireiro', 'salao', 'manicure', 'pedicure', 'esteticista',
  'academia', 'personal', 'musculacao', 'pilates', 'yoga',
  // Exames não-odontológicos
  'exame de sangue', 'hemograma', 'raio x do torax', 'ultrassom', 'mamografia',
  'colonoscopia', 'endoscopia', 'eletrocardiograma',
  // Outros serviços completamente fora de contexto
  'advogado', 'advocacia', 'juridico', 'cartorio',
  'banco', 'emprestimo', 'financiamento', 'seguro', 'plano de saude nao dental',
  'pizza', 'restaurante', 'comida', 'entrega',
  'uber', 'taxi', 'onibus', 'passagem',
  'celular', 'computador', 'internet', 'suporte tecnico',
  'aluguel', 'imovel', 'apartamento',
  'escola', 'faculdade', 'curso',
  'passaporte', 'visto', 'rg', 'cpf',
];

/**
 * Verifica se a mensagem menciona uma especialidade odontológica conhecida.
 * Retorna o termo encontrado ou null.
 */
function matchDentalSpecialty(norm) {
  return DENTAL_SPECIALTIES.find(s => norm.includes(s)) || null;
}

/**
 * Verifica se a mensagem é claramente fora da odontologia.
 * Usa word-boundary para evitar falsos positivos de substring
 * (ex: "rim" em "primeiro", "pele" em "impele", "visao" em "avaliacao").
 */
function isNonDentalTopic(norm) {
  return NON_DENTAL_KEYWORDS.some(k => {
    // Para termos com espaço (ex: "cirurgia plastica") usa includes simples
    if (k.includes(' ')) return norm.includes(k);
    // Para termos de uma palavra, exige que seja palavra inteira
    // Aceita como delimitador: início/fim de string, espaço ou qualquer não-alfanumérico
    const re = new RegExp('(?:^|[^a-z0-9])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)');
    return re.test(norm);
  });
}

/**
 * Detecta intenção clara na mensagem e a processa independentemente do estado atual.
 * Retorna true se a intenção foi tratada (e a chamada deve retornar), false caso contrário.
 * Usado para dar empatia contextual: a Serena responde ao que o paciente escreveu,
 * não ao que o fluxo "esperava".
 */
async function handleIntentFromAnyState(lead, phone, text, norm, stateData, leadName, whatsappSender, pushName) {
  // Intenção: endereço / localização / como chegar
  const isAskingAddress = [
    'endereco', 'localizacao', 'onde fica', 'como chegar', 'onde voces ficam',
    'onde e a clinica', 'onde fica a clinica', 'qual o endereco', 'me passa o endereco',
    'onde voces estao', 'como eu chego', 'tem estacionamento', 'fica onde',
    'qual e a rua', 'qual a rua', 'qual e o endereco', 'passa o endereco', 'me manda o endereco',
    'manda o endereco', 'mande o endereco', 'localizacao da clinica', 'ponto de referencia',
    'bairro', 'cep', 'qual o local', 'qual local'
  ].some(k => norm.includes(k));

  if (isAskingAddress) {
    const addressMsg =
      `📍 *Endereço da OdontoCompany Bela Vista Osasco:*\n\n` +
      `Av. Antônio Carlos Costa, 991\nBela Vista — Osasco/SP\n\n` +
      `📌 *Como chegar:*\nhttps://maps.google.com/?q=Av.+Ant%C3%B4nio+Carlos+Costa,+991+Osasco+SP\n\n` +
      `Estamos te esperando${leadName ? ', ' + leadName : ''}! 😊`;
    db.upsertSerenaLead(phone, { state: leadName ? 'AGUARDANDO_PREFERENCIA' : 'AGUARDANDO_NOME' });
    await sendSerenaReply(phone, addressMsg, whatsappSender);
    return true;
  }

  // Intenção: horário de funcionamento (apenas perguntas explícitas sobre funcionamento/abertura da clínica)
  // Se contiver horário específico (ex: "às 10h") ou for tentativa de agendamento em dia (ex: "domingo"),
  // deixa seguir para o fluxo de busca de horários.
  const hasTime = parseTimeInput(text);
  const hasDate = parseDateInput(text);
  const isAskingHours = !hasTime && !hasDate && [
    'funcionamento', 'que horas abre', 'que horas fecha', 'abre quando',
    'sabado abre', 'abre sabado', 'funciona sabado', 'funciona domingo',
    'horario de atendimento', 'horario de funcionamento', 'qual o horario de atendimento',
    'qual o horario de funcionamento', 'que dias abre', 'dias de atendimento'
  ].some(k => norm.includes(k));

  if (isAskingHours) {
    const hoursMsg =
      `🕐 *Horário de Atendimento:*\n\n` +
      `📅 *Segunda a Sexta:* das 08:00 às 18:00\n` +
      `📅 *Sábado:* das 08:00 às 13:00\n` +
      `🚫 *Domingo:* fechado\n\n` +
      `${leadName ? leadName + ', g' : 'G'}ostaria de agendar sua avaliação gratuita?`;
    db.upsertSerenaLead(phone, { state: leadName ? 'AGUARDANDO_PREFERENCIA' : 'AGUARDANDO_NOME' });
    await sendSerenaReply(phone, hoursMsg, whatsappSender);
    return true;
  }

  // Intenção: pedido de mais informações (genérico) — pergunta sobre qual procedimento
  const wantsInfo = [
    'mais informacoes', 'mais informacao', 'mais info', 'quero saber mais',
    'gostaria de saber mais', 'pode me informar', 'pode me dar mais', 'me fala mais',
    'me conta mais', 'quero entender', 'me explica', 'como funciona',
    'o que voces oferecem', 'o que voces tem', 'o que voces fazem'
  ].some(k => norm.includes(k));

  if (wantsInfo) {
    db.upsertSerenaLead(phone, { state: 'AGUARDANDO_ESPECIALIDADE' });
    const reply = `Claro${leadName ? ', ' + leadName : ''}! 😊 Sobre qual procedimento ou especialidade você gostaria de ter mais informações?`;
    await sendSerenaReply(phone, reply, whatsappSender);
    return true;
  }

  // Intenção: tópico fora da odontologia
  if (isNonDentalTopic(norm)) {
    const reply =
      `Obrigada pelo seu contato${leadName ? ', ' + leadName : ''}! 😊\n\n` +
      `Somos uma *clínica odontológica* especializada exclusivamente na saúde bucal, e infelizmente não atendemos o que você está buscando.\n\n` +
      `No que posso te ajudar:\n` +
      `🦷 Implantes e próteses dentárias\n` +
      `✨ Clareamento e estética dental\n` +
      `🔧 Ortodontia (aparelhos e alinhadores)\n` +
      `🩺 Periodontia e tratamento de gengiva\n` +
      `🔬 Endodontia (tratamento de canal)\n` +
      `👶 Odontopediatria\n` +
      `🔪 Cirurgias orais\n\n` +
      `Posso te ajudar com algum desses serviços?`;
    db.upsertSerenaLead(phone, { state: leadName ? 'AGUARDANDO_PREFERENCIA' : 'AGUARDANDO_NOME' });
    await sendSerenaReply(phone, reply, whatsappSender);
    return true;
  }

  // Intenção: agendar / avaliação + data/hora explícita
  const wantsBooking = norm.includes('agendar') || norm.includes('avaliacao') || norm.includes('consulta') || norm.includes('marcar');

  if (wantsBooking || (hasDate && hasTime)) {
    db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
    const updatedLead = db.getSerenaLead(phone);
    if (leadName) {
      await handleConversationFlow(updatedLead, phone, text, stateData, whatsappSender, pushName);
    } else {
      const ack = `Claro, posso te ajudar com isso! 😊 Antes de verificar os horários, pode me dizer seu nome?`;
      await sendSerenaReply(phone, ack, whatsappSender);
    }
    return true;
  }

  // Intenção: preços/valores — scripts diferenciados por especialidade (CFO-118/2012)
  const isAskingPrice = ['preco', 'valor', 'quanto custa', 'tabela', 'orcamento', 'quanto fica', 'custo', 'investimento', 'mensalidade', 'parcela', 'parcelamento'].some(k => norm.includes(k));
  if (isAskingPrice) {
    const isImplante = /implante|implantar|implantodontia|protese|repor dente/.test(norm);
    const isAparelho = /aparelho|ortodontia|alinhador|invisalign|bracket/.test(norm);
    const isLimpeza  = /limpeza|profilaxia|tartaro|gengivite|canal|check.?up|rotina/.test(norm);
    const isEstetica = /clareamento|branqueamento|lente|faceta|estetica|sorriso/.test(norm);

    let priceMsg;
    if (isImplante) {
      priceMsg =
        `Entendo perfeitamente sua dúvida! 😊 O investimento em um implante depende diretamente de fatores biológicos únicos: a *espessura e densidade do seu osso*, o tipo de fixação ideal e a saúde das gengivas.\n\n` +
        `Inclusive, o próprio *Conselho Federal de Odontologia* nos proíbe de passar valores sem avaliação — porque cada caso exige uma marca e técnica cirúrgica diferente, e passar um valor genérico seria irresponsável com a sua saúde.\n\n` +
        `Aqui na clínica realizamos um *planejamento 3D personalizado* para você sair da avaliação sabendo o plano exato, o tempo e as formas facilitadas de pagamento.\n\n` +
        `Aliás, uma pergunta${leadName ? ', ' + leadName : ''}: faz muito tempo que você perdeu esse dente, ou ainda está com ele no local?`;
    } else if (isAparelho) {
      priceMsg =
        `Essa é a dúvida de quase todos os nossos pacientes! 😊 O valor exato depende da *complexidade do alinhamento* da sua mordida e do tempo de tratamento estimado.\n\n` +
        `Trabalhamos com *modelos convencionais e alinhadores invisíveis*. Para te passar um orçamento justo e preciso, nosso ortodontista precisa analisar sua mordida.\n\n` +
        `O que mais tem te incomodado no seu sorriso atualmente${leadName ? ', ' + leadName : ''}: a posição dos dentes, ou você sente dores ao mastigar?`;
    } else if (isLimpeza) {
      priceMsg =
        `Trabalhamos com o protocolo completo de *profilaxia e remoção de tártaro por ultrassom*. 🦷\n\n` +
        `O dentista sempre avalia antes se há necessidade de tratar inflamação na gengiva ou focos de cárie — para garantir que seu dente fique *100% protegido*.\n\n` +
        `${leadName ? leadName + ', você' : 'Você'} sente algum sangramento na gengiva ao escovar, ou seria apenas uma manutenção de rotina?`;
    } else if (isEstetica) {
      priceMsg =
        `Ótima pergunta! 😊 O investimento em estética dental depende do *número de dentes* envolvidos e da técnica escolhida — cada sorriso é único.\n\n` +
        `O próprio *Conselho Federal de Odontologia* orienta que valores só sejam informados após avaliação clínica, pois o plano é 100% personalizado.\n\n` +
        `${leadName ? leadName + ', o' : 'O'} que mais te incomoda hoje: a cor, o formato ou o alinhamento dos dentes?`;
    } else {
      priceMsg =
        `Ótima pergunta! 😊 Os valores variam de acordo com as condições e necessidades de cada paciente — cada sorriso é único e merece um plano personalizado.\n\n` +
        `💡 O que posso *garantir* é que a OdontoCompany Bela Vista Osasco oferece:\n` +
        `✅ *As melhores condições de preço do mercado*\n` +
        `✅ *Parcelamento facilitado* — para caber no seu bolso\n` +
        `✅ Tudo apresentado de forma transparente na sua *avaliação gratuita*\n\n` +
        `A avaliação já inclui *RX Panorâmico* e *Escaneamento 5D* sem custo algum! 🦷✨`;
    }

    const continueMsg = leadName
      ? `\n\nEnquanto isso, posso já verificar um horário de avaliação gratuita para você esta semana. O que acha?`
      : `\n\nPode me dizer seu nome para eu verificar os horários disponíveis?`;
    db.upsertSerenaLead(phone, { state: leadName ? 'AGUARDANDO_PREFERENCIA' : 'AGUARDANDO_NOME' });
    await sendSerenaReply(phone, priceMsg + continueMsg, whatsappSender);
    return true;
  }

  // Intenção: convênio
  const isAskingConvenio = ['convenio', 'plano de saude', 'seguro saude', 'porto seguro', 'unimed', 'bradesco saude', 'amil', 'sulamerica', 'reembolso', 'aceita convenio', 'tem convenio'].some(k => norm.includes(k));
  if (isAskingConvenio) {
    const convenioMsg = `Trabalhamos diretamente com o convênio *Porto Seguro*! 🦷\n\nPara os demais planos e seguros saúde, emitimos *Nota Fiscal* para que você solicite o reembolso diretamente pela sua operadora.\n\nPosso agendar sua avaliação gratuita para verificarmos o melhor encaminhamento para o seu caso. O que acha?`;
    db.upsertSerenaLead(phone, { state: leadName ? 'AGUARDANDO_PREFERENCIA' : 'AGUARDANDO_NOME' });
    await sendSerenaReply(phone, convenioMsg, whatsappSender);
    return true;
  }

  // Intenção: procedimentos odontológicos genéricos
  const isAskingProcedure = ['procedimento', 'tratamento', 'implante', 'protese', 'ortodontia', 'aparelho', 'clareamento', 'canal', 'extracao', 'limpeza', 'faceta', 'restauracao', 'periodontia', 'endodontia', 'cirurgia', 'quais tratamentos', 'quais procedimentos', 'faz implante', 'faz aparelho'].some(k => norm.includes(k));
  if (isAskingProcedure) {
    const specialty = matchDentalSpecialty(norm);
    const procedureMsg = specialty
      ? `Sim, realizamos *${specialty}*! 🦷✨ Contamos com especialistas dedicados a cada área para garantir o melhor tratamento.\n\nA forma mais precisa de entender o que você precisa é através da nossa *avaliação gratuita* — nosso especialista avaliará seu caso e apresentará o plano ideal. Gostaria de agendar?`
      : `Realizamos *todos os procedimentos odontológicos*, desde consultas de rotina até cirurgias mais complexas! 🦷✨\n\nContamos com *especialistas dedicados a cada área* — ortodontia, implantes, periodontia, endodontia, estética dental, próteses e muito mais.\n\nNa sua *avaliação gratuita*, nosso especialista avaliará exatamente o que você precisa. Gostaria de agendar?`;
    db.upsertSerenaLead(phone, { state: leadName ? 'AGUARDANDO_PREFERENCIA' : 'AGUARDANDO_NOME' });
    await sendSerenaReply(phone, procedureMsg, whatsappSender);
    return true;
  }

  return false; // nenhuma intenção reconhecida — segue o fluxo normal
}

/**
 * Fluxo de Diálogo e Captação / Agendamento
 */
async function handleConversationFlow(lead, phone, text, stateData, whatsappSender, pushName = '') {
  const norm = cleanText(text);
  let currentState = lead.state || 'NEW';
  let leadName = lead.name || '';

  // ── Recusa simples ("agora não", "nenhuma"): agradece e encerra, sem reofertar horários ──
  // "Nenhuma"/"não" secos só encerram quando já foram oferecidos horários (SELECIONANDO_OPCAO);
  // nos demais estados "não" pode ser resposta a outra pergunta (ex.: "sente dor?").
  const declineStates = ['AGUARDANDO_PREFERENCIA', 'AGUARDANDO_DATA_HORA', 'SELECIONANDO_OPCAO', 'CONFIRMANDO_AGENDAMENTO'];
  if (declineStates.includes(currentState) &&
      (isSimpleDecline(text) || (currentState === 'SELECIONANDO_OPCAO' && isBareDecline(text)))) {
    db.upsertSerenaLead(phone, {
      state: 'CONCLUIDO',
      state_data: { ...stateData, needCaptured: false },
      next_followup_at: null
    });
    const reply =
      `Sem problemas${leadName ? ', ' + leadName : ''}! Agradeço muito pelo seu contato com a *OdontoCompany Bela Vista Osasco*. 😊\n\n` +
      `Quando quiser realizar sua avaliação gratuita, é só me chamar por aqui. Tenha um ótimo dia! 🦷✨`;
    await sendSerenaReply(phone, reply, whatsappSender);
    return;
  }

  // ── Tratamento de Pergunta sobre Preços/Valores ─────────────────────────────
  // Regra de negócio: Serena JAMAIS informa valores. Scripts específicos por especialidade
  // seguem as diretrizes do CFO (Resolução CFO-118/2012) — proibição de valores sem exame.
  const isAskingPrice = ['preco', 'valor', 'quanto custa', 'tabela', 'orcamento', 'quanto fica', 'custo', 'investimento', 'mensalidade', 'parcela', 'parcelamento'].some(k => norm.includes(k));
  if (isAskingPrice && currentState !== 'CONFIRMANDO_AGENDAMENTO') {
    // Detecta a especialidade mencionada para personalizar o script
    const isImplante  = /implante|implantar|implanodontia|protese|repor dente/.test(norm);
    const isAparelho  = /aparelho|ortodontia|alinhador|invisalign|bracket/.test(norm);
    const isLimpeza   = /limpeza|profilaxia|tartaro|gengivite|canal|check.?up|rotina/.test(norm);
    const isEstetica  = /clareamento|branqueamento|lente|faceta|estetica|sorriso/.test(norm);

    const detectedInterest = isImplante ? 'Implante' : isAparelho ? 'Aparelho' : isLimpeza ? 'Limpeza / Profilaxia' : isEstetica ? 'Estética Dental' : 'Geral';
    db.upsertSerenaLead(phone, { procedure_interest: detectedInterest });

    let priceMsg;
    if (isImplante) {
      priceMsg =
        `Entendo perfeitamente sua dúvida! 😊 O investimento em um implante depende diretamente de fatores biológicos únicos: a *espessura e densidade do seu osso*, o tipo de fixação ideal e a saúde das gengivas.\n\n` +
        `Inclusive, o próprio *Conselho Federal de Odontologia* nos proíbe de passar valores sem avaliação — porque cada caso exige uma marca e técnica cirúrgica diferente, e passar um valor genérico seria irresponsável com a sua saúde.\n\n` +
        `Aqui na clínica realizamos um *planejamento 3D personalizado* para você sair da avaliação sabendo o plano exato, o tempo e as formas facilitadas de pagamento.\n\n` +
        `Aliás, uma pergunta${leadName ? ', ' + leadName : ''}: faz muito tempo que você perdeu esse dente, ou ainda está com ele no local?`;
    } else if (isAparelho) {
      priceMsg =
        `Essa é a dúvida de quase todos os nossos pacientes! 😊 O valor exato depende da *complexidade do alinhamento* da sua mordida e do tempo de tratamento estimado.\n\n` +
        `Trabalhamos com *modelos convencionais e alinhadores invisíveis*. Para te passar um orçamento justo e preciso, nosso ortodontista precisa analisar sua mordida — se seu caso requer apenas pequenos ajustes ou correções mais abrangentes.\n\n` +
        `O que mais tem te incomodado no seu sorriso atualmente${leadName ? ', ' + leadName : ''}: a posição dos dentes, ou você sente dores ao mastigar?`;
    } else if (isLimpeza) {
      priceMsg =
        `Trabalhamos com o protocolo completo de *profilaxia e remoção de tártaro por ultrassom*. 🦷\n\n` +
        `O dentista sempre avalia antes se há necessidade de tratar inflamação na gengiva ou focos de cárie — para garantir que seu dente fique *100% protegido*.\n\n` +
        `${leadName ? leadName + ', você' : 'Você'} sente algum sangramento na gengiva ao escovar, ou seria apenas uma manutenção de rotina?`;
    } else if (isEstetica) {
      priceMsg =
        `Ótima pergunta! 😊 O investimento em estética dental depende do *número de dentes* envolvidos e da técnica escolhida — cada sorriso é único.\n\n` +
        `O próprio *Conselho Federal de Odontologia* orienta que valores só sejam informados após avaliação clínica, pois o plano é 100% personalizado para o seu caso.\n\n` +
        `Na avaliação gratuita, nosso especialista usa *tecnologia digital* para simular o resultado do seu novo sorriso antes de qualquer procedimento.\n\n` +
        `${leadName ? leadName + ', o' : 'O'} que mais te incomoda hoje: a cor, o formato ou o alinhamento dos dentes?`;
    } else {
      priceMsg =
        `Ótima pergunta! 😊 Os valores variam de acordo com as condições e necessidades de cada paciente — cada sorriso é único e merece um plano personalizado.\n\n` +
        `💡 O que posso *garantir* é que a OdontoCompany Bela Vista Osasco oferece:\n` +
        `✅ *As melhores condições de preço do mercado*\n` +
        `✅ *Parcelamento facilitado* — para caber no seu bolso\n` +
        `✅ Tudo apresentado de forma transparente na sua *avaliação gratuita*\n\n` +
        `A avaliação já inclui *RX Panorâmico* e *Escaneamento 5D* sem custo algum! 🦷✨`;
    }

    if (!leadName) {
      db.upsertSerenaLead(phone, { state: 'AGUARDANDO_NOME', state_data: { afterPrice: true } });
      const askName = `\n\nPor favor, como é o seu nome para melhor te atender?`;
      await sendSerenaReply(phone, priceMsg + askName, whatsappSender);
      return;
    } else {
      db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
      const continueMsg = (isImplante || isAparelho || isLimpeza || isEstetica)
        ? `\n\nEnquanto isso, posso já verificar um horário de avaliação gratuita para você esta semana. O que acha?`
        : `\n\n${leadName}, que tal agendar agora sua avaliação gratuita para conhecer todas as condições? 😄`;
      await sendSerenaReply(phone, priceMsg + continueMsg, whatsappSender);
      return;
    }
  }

  // ── Tratamento de Pergunta sobre Convênios ──────────────────────────────────
  const isAskingConvenio = ['convenio', 'plano de saude', 'seguro saude', 'porto seguro', 'unimed', 'bradesco saude', 'amil', 'sulamerica', 'reembolso', 'aceita convenio', 'tem convenio'].some(k => norm.includes(k));
  if (isAskingConvenio && currentState !== 'CONFIRMANDO_AGENDAMENTO') {
    const convenioMsg = `Trabalhamos diretamente com o convênio *Porto Seguro*! 🦷\n\nPara os demais planos e seguros saúde, emitimos *Nota Fiscal* para que você solicite o reembolso diretamente pela sua operadora.\n\nSe quiser, posso agendar sua avaliação gratuita para verificarmos o melhor encaminhamento para o seu caso. O que acha?`;
    db.upsertSerenaLead(phone, {
      state: leadName ? 'AGUARDANDO_PREFERENCIA' : 'AGUARDANDO_NOME',
      payment_modality: 'Convênio'
    });
    await sendSerenaReply(phone, convenioMsg, whatsappSender);
    return;
  }

  // ── Tratamento de Pergunta sobre Procedimentos ──────────────────────────────
  // Excluído TRIAGEM: no menu de triagem, a mensagem com "implante" etc. é
  // interpretada por parseTriagemChoice dentro do bloco TRIAGEM — não aqui.
  const isAskingProcedure = ['procedimento', 'tratamento', 'implante', 'protese', 'ortodontia', 'aparelho', 'clareamento', 'canal', 'extracao', 'limpeza', 'faceta', 'restauracao', 'periodontia', 'endodontia', 'cirurgia', 'o que voces fazem', 'o que voces tratam', 'quais tratamentos', 'quais procedimentos', 'faz implante', 'faz aparelho'].some(k => norm.includes(k));
  if (isAskingProcedure && currentState !== 'CONFIRMANDO_AGENDAMENTO' && currentState !== 'TRIAGEM') {
    const procedureMsg = `Realizamos *todos os procedimentos odontológicos*, desde consultas de rotina até cirurgias mais complexas! 🦷✨\n\nContamos com *especialistas dedicados a cada área* — ortodontia, implantes, periodontia, endodontia, estética dental, próteses e muito mais — para que você receba o tratamento mais indicado com máxima qualidade.\n\nNa sua *avaliação gratuita*, nosso especialista avaliará exatamente o que você precisa e apresentará o melhor plano de tratamento. Gostaria de agendar?`;
    db.upsertSerenaLead(phone, { state: leadName ? 'AGUARDANDO_PREFERENCIA' : 'AGUARDANDO_NOME' });
    await sendSerenaReply(phone, procedureMsg, whatsappSender);
    return;
  }

  // Tratamento de Cancelamento / Remarcação
  if (norm.includes('cancelar') || norm.includes('desmarcar')) {
    const activeApp = db.getActiveAppointmentByPhone(phone);
    if (activeApp) {
      db.cancelAppointmentByPhone(phone);
      db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
      const reply = `Seu agendamento para o dia ${schedule.formatDateBr(activeApp.date)} às ${activeApp.time} foi cancelado conforme solicitado.\n\nPara que você não perca sua avaliação gratuita (com RX Panorâmico e Escaneamento 5D), gostaria de remarcar para outro dia? Qual data ou período fica melhor para você?`;
      await sendSerenaReply(phone, reply, whatsappSender);
      return;
    }
  }

  if (norm.includes('remarcar') || norm.includes('mudar horario') || norm.includes('trocar data')) {
    db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
    const reply = `Sem problemas! Vamos encontrar um horário melhor para você. Qual dia e período (manhã ou tarde) você prefere para sua avaliação gratuita?`;
    await sendSerenaReply(phone, reply, whatsappSender);
    return;
  }

  // ── PASSO 1: Apresentação — Serena se apresenta e pergunta o nome ─────────────
  if (currentState === 'NEW') {
    // Se o WhatsApp já forneceu o nome do contato via pushName, usa direto e dispara o menu
    const nameFromPush = pushName ? extractName(pushName) : null;
    if (nameFromPush) {
      leadName = nameFromPush;
      db.upsertSerenaLead(phone, { name: leadName, state: 'TRIAGEM' });
      const greeting =
        `Olá, *${leadName}*! 😊 Sou a Serena, assistente virtual da *OdontoCompany Bela Vista Osasco*.\n\n` +
        `_Peço desculpas antecipadas por qualquer falha — estou em treinamento para melhor te atender!_ 🙏`;
      await sendSerenaReply(phone, greeting, whatsappSender);
      await sendSerenaReply(phone, TRIAGEM_MENU(leadName), whatsappSender);
      return;
    }

    const greeting =
      `Olá! Que bom ter você aqui na *OdontoCompany Bela Vista Osasco*! 😊\n\n` +
      `Eu sou a Serena, assistente virtual da clínica.\n\n` +
      `Para que eu possa te direcionar ao especialista certo, como você prefere ser chamado(a)?`;
    db.upsertSerenaLead(phone, { state: 'AGUARDANDO_NOME' });
    await sendSerenaReply(phone, greeting, whatsappSender);
    return;
  }

  // ── PASSO 1.1: Recebimento e Validação do Nome ───────────────────────────────
  if (currentState === 'AGUARDANDO_NOME') {
    // Antes de checar o nome, verifica se a mensagem carrega uma intenção clara —
    // se sim, atende a intenção imediatamente (sem forçar o nome primeiro)
    const intentHandled = await handleIntentFromAnyState(lead, phone, text, norm, stateData, leadName, whatsappSender, pushName);
    if (intentHandled) return;

    // Se o paciente recusar fornecer o nome — vai direto para o menu sem nome
    if (isRefusingName(text)) {
      db.upsertSerenaLead(phone, { state: 'TRIAGEM' });
      const reply = "Sem problemas! 😊";
      await sendSerenaReply(phone, reply, whatsappSender);
      await sendSerenaReply(phone, TRIAGEM_MENU('você'), whatsappSender);
      return;
    }

    const extracted = extractName(text);
    if (extracted) {
      leadName = extracted;
      db.upsertSerenaLead(phone, { name: leadName, state: 'TRIAGEM' });
      await sendSerenaReply(phone, TRIAGEM_MENU(leadName), whatsappSender);
      return;
    } else {
      const reply = "Por favor, como é o seu nome para melhor te atender?";
      await sendSerenaReply(phone, reply, whatsappSender);
      return;
    }
  }

  // ── PASSO 1.2: Menu de Triagem — interpreta a escolha das 5 opções ───────────
  if (currentState === 'TRIAGEM') {
    // parseTriagemChoice tem prioridade: se a mensagem corresponde a uma categoria
    // de triagem, usamos a trilha especializada antes de qualquer outra intenção.
    // handleIntentFromAnyState só é chamado para intenções não-clínicas (endereço,
    // horário, preço etc.) — e apenas se a categoria não for reconhecida.
    const category = parseTriagemChoice(norm);

    if (category === 'urgencia') {
      // Urgência — dispara emergência diretamente (mesmo fluxo do isEmergency)
      db.upsertSerenaLead(phone, {
        state: 'EMERGENCIA',
        is_urgent: 1,
        procedure_interest: 'Dor / Urgência',
        transferred_to_reception: 1,
        reception_transfer_time: new Date().toISOString().replace('T', ' ').substring(0, 19)
      });
      await sendSerenaReply(phone, buildTriagemValueMsg(leadName, 'urgencia'), whatsappSender);
      await notifyReception(
        `🚨 URGÊNCIA ODONTOLÓGICA!\nPaciente: ${leadName || 'Nome a confirmar'}\nTelefone: ${phone}\nSelecionou opção 1 (urgência/dor) no menu de triagem.\nPor favor, entrar em contato imediatamente!`,
        whatsappSender
      );
      return;
    }

    if (category) {
      // Rota B: implante / aparelho / estética / geral
      // Salva a categoria como necessidade inicial e exibe mensagem de valor
      const catLabel = category === 'implante' ? 'Implante' : category === 'aparelho' ? 'Aparelho' : category === 'estetica' ? 'Estética Dental' : 'Clínico Geral';
      db.upsertSerenaLead(phone, {
        state: 'AGUARDANDO_PREFERENCIA',
        procedure_interest: catLabel,
        state_data: { patientNeed: category, triagemCategory: category }
      });
      await sendSerenaReply(phone, buildTriagemValueMsg(leadName, category), whatsappSender);
      return;
    }

    // Não é categoria de triagem — verifica intenções diretas (endereço, horário, preço…)
    const intentHandled = await handleIntentFromAnyState(lead, phone, text, norm, stateData, leadName, whatsappSender, pushName);
    if (intentHandled) return;

    // Não reconheceu nada — re-exibe o menu
    const retry = `Não entendi muito bem. ${TRIAGEM_MENU(leadName || 'você')}`;
    await sendSerenaReply(phone, retry, whatsappSender);
    return;
  }

  // ── AGUARDANDO_ESPECIALIDADE: resposta ao "sobre qual procedimento?" ──────────
  if (currentState === 'AGUARDANDO_ESPECIALIDADE') {
    // Verifica se é fora da odontologia
    if (isNonDentalTopic(norm)) {
      const reply =
        `Obrigada pelo seu contato${leadName ? ', ' + leadName : ''}! 😊\n\n` +
        `Somos uma *clínica odontológica* especializada exclusivamente na saúde bucal, e infelizmente não atendemos o que você está buscando.\n\n` +
        `No que posso te ajudar:\n` +
        `🦷 Implantes e próteses dentárias\n` +
        `✨ Clareamento e estética dental\n` +
        `🔧 Ortodontia (aparelhos e alinhadores)\n` +
        `🩺 Periodontia e tratamento de gengiva\n` +
        `🔬 Endodontia (tratamento de canal)\n` +
        `👶 Odontopediatria\n` +
        `🔪 Cirurgias orais\n\n` +
        `Posso te ajudar com algum desses serviços?`;
      db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
      await sendSerenaReply(phone, reply, whatsappSender);
      return;
    }

    // Verifica se mencionou uma especialidade odontológica específica
    const specialty = matchDentalSpecialty(norm);
    if (specialty) {
      const infoMsg =
        `Ótima escolha${leadName ? ', ' + leadName : ''}! Contamos com um grupo de *especialistas dedicados* que atendem todas as especialidades odontológicas, incluindo *${specialty}*. 🦷✨\n\n` +
        `Para melhor te orientar sobre o seu caso específico, recomendamos uma *avaliação gratuita* com nosso especialista — ela inclui RX Panorâmico e Escaneamento 5D quando necessário, tudo sem custo!\n\n` +
        `Assim conseguimos apresentar o plano de tratamento mais adequado para você, com as melhores condições de preço e parcelamento. Gostaria de agendar?`;
      db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
      await sendSerenaReply(phone, infoMsg, whatsappSender);
      return;
    }

    // Resposta genérica / não reconhecida — reforça a clínica e convida para avaliação
    const genericMsg =
      `${leadName ? leadName + ', c' : 'C'}ontamos com especialistas em *todas as áreas da odontologia*! 🦷✨\n\n` +
      `Realizamos: implantes, próteses, ortodontia, clareamento, facetas, tratamento de canal, periodontia, cirurgias orais, odontopediatria e muito mais.\n\n` +
      `Para responder com precisão sobre o seu caso, o ideal é uma *avaliação gratuita* com nosso especialista. Gostaria de agendar?`;
    db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
    await sendSerenaReply(phone, genericMsg, whatsappSender);
    return;
  }

  // ── PASSO 2: Lead fala o problema — Serena captura a necessidade ────────────
  if (currentState === 'AGUARDANDO_PREFERENCIA') {
    // Verifica intenções diretas (endereço, horário de funcionamento, preço, convênio, procedimento)
    // antes de tentar sugerir horários automaticamente.
    // Ignoramos wantsBooking aqui para não gerar loop com o próprio AGUARDANDO_PREFERENCIA.
    const hasTimeInPref = parseTimeInput(text);
    const hasDateInPref = parseDateInput(text);

    // Endereço tem prioridade desde que não seja tentativa explícita de data/hora
    const isAskingAddress = [
      'endereco', 'localizacao', 'onde fica', 'como chegar', 'onde voces ficam',
      'onde e a clinica', 'onde fica a clinica', 'qual o endereco', 'me passa o endereco',
      'onde voces estao', 'como eu chego', 'tem estacionamento', 'fica onde',
      'qual e a rua', 'qual a rua', 'qual e o endereco', 'passa o endereco', 'me manda o endereco',
      'manda o endereco', 'mande o endereco', 'localizacao da clinica', 'ponto de referencia',
      'bairro', 'cep', 'qual o local', 'qual local'
    ].some(k => norm.includes(k));

    if (isAskingAddress && !hasTimeInPref && !hasDateInPref) {
      const addressMsg =
        `📍 *Endereço da OdontoCompany Bela Vista Osasco:*\n\n` +
        `Av. Antônio Carlos Costa, 991\nBela Vista — Osasco/SP\n\n` +
        `📌 *Como chegar:*\nhttps://maps.google.com/?q=Av.+Ant%C3%B4nio+Carlos+Costa,+991+Osasco+SP\n\n` +
        `Estamos te esperando${leadName ? ', ' + leadName : ''}! 😊`;
      db.upsertSerenaLead(phone, { state: leadName ? 'AGUARDANDO_PREFERENCIA' : 'AGUARDANDO_NOME' });
      await sendSerenaReply(phone, addressMsg, whatsappSender);
      return;
    }

    const isAskingHours = !hasTimeInPref && !hasDateInPref && [
      'funcionamento', 'que horas abre', 'que horas fecha', 'abre quando',
      'sabado abre', 'abre sabado', 'funciona sabado', 'funciona domingo',
      'horario de atendimento', 'horario de funcionamento', 'qual o horario de atendimento',
      'qual o horario de funcionamento', 'que dias abre', 'dias de atendimento'
    ].some(k => norm.includes(k));

    if (isAskingHours) {
      const hoursMsg =
        `🕐 *Horário de Atendimento:*\n\n` +
        `📅 *Segunda a Sexta:* das 08:00 às 18:00\n` +
        `📅 *Sábado:* das 08:00 às 13:00\n` +
        `🚫 *Domingo:* fechado\n\n` +
        `${leadName ? leadName + ', g' : 'G'}ostaria de agendar sua avaliação gratuita?`;
      db.upsertSerenaLead(phone, { state: leadName ? 'AGUARDANDO_PREFERENCIA' : 'AGUARDANDO_NOME' });
      await sendSerenaReply(phone, hoursMsg, whatsappSender);
      return;
    }

    // Verifica se o tópico é fora da odontologia (ex: dermatologista, cirurgia plástica)
    // Precisa acontecer ANTES do fluxo de sugestão de horários para evitar oferecer agenda
    // a quem perguntou algo completamente fora do escopo.
    if (!stateData.needCaptured && isNonDentalTopic(norm)) {
      const reply =
        `Obrigada pelo seu contato${leadName ? ', ' + leadName : ''}! 😊\n\n` +
        `Somos uma *clínica odontológica* especializada exclusivamente na saúde bucal, e infelizmente não atendemos o que você está buscando.\n\n` +
        `No que posso te ajudar:\n` +
        `🦷 Implantes e próteses dentárias\n` +
        `✨ Clareamento e estética dental\n` +
        `🔧 Ortodontia (aparelhos e alinhadores)\n` +
        `🩺 Periodontia e tratamento de gengiva\n` +
        `🔬 Endodontia (tratamento de canal)\n` +
        `👶 Odontopediatria\n` +
        `🔪 Cirurgias orais\n\n` +
        `Posso te ajudar com algum desses serviços?`;
      db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
      await sendSerenaReply(phone, reply, whatsappSender);
      return;
    }

    // Verifica se o lead está recusando a avaliação gratuita.
    // "nao quero" e "nao preciso" sozinhos só contam como recusa se não houver
    // contexto de horário/período (evita "nao quero ir de manha" virar recusa de avaliação).
    const horarioCtxEval = ['manha', 'tarde', 'noite', 'horario', 'dia ', 'semana', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo', 'ir ', 'agend'];
    const hasHorarioCtx = horarioCtxEval.some(k => norm.includes(k));
    const isRefusingEval = !hasHorarioCtx && ['nao quero avaliacao', 'nao preciso de avaliacao', 'nao tenho interesse', 'sem interesse', 'nao quero', 'nao preciso'].some(k => norm.includes(k));
    if (isRefusingEval) {
      // Oferecer falar com especialista ou recepção
      db.upsertSerenaLead(phone, { state: 'RECUSOU_AVALIACAO' });
      const reply = `Entendido, ${leadName || 'tudo bem'}! Quer que eu passe seu contato para nossa *especialista* ou para a *recepção* entrar em contato diretamente com você?`;
      await sendSerenaReply(phone, reply, whatsappSender);
      return;
    }

    // Captura da necessidade: se o paciente disse apenas "quero agendar" / "quero marcar"
    // sem informar data, hora ou contexto do tratamento — pergunta brevemente o que precisa
    const isGenericBooking = (norm.includes('agendar') || norm.includes('marcar') || norm.includes('consulta') || norm.includes('avaliacao'))
      && !parseDateInput(text) && !parseTimeInput(text) && !matchDentalSpecialty(norm);
    if (isGenericBooking && !stateData.needCaptured) {
      db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA', state_data: { ...stateData, needCaptured: true } });
      const reply = `${leadName ? 'Ótimo, ' + leadName + '!' : 'Ótimo!'} 😊 Para já deixar anotado para o nosso especialista, pode me dizer brevemente o que está precisando? _(ex: implante, aparelho, clareamento, limpeza...)_`;
      await sendSerenaReply(phone, reply, whatsappSender);
      return;
    }

    // Se acabou de responder a necessidade (needCaptured = true) — salva e avança para horários
    if (stateData.needCaptured) {
      const specialty = matchDentalSpecialty(norm) || text.trim();
      db.upsertSerenaLead(phone, { state_data: { ...stateData, patientNeed: specialty, needCaptured: false } });
      // Atualiza stateData local para o restante do fluxo
      stateData = { ...stateData, patientNeed: specialty, needCaptured: false };
    }
  }

  // ── PASSO 2.1 desvio: Lead recusou avaliação — encaminhar para recepção ──────
  if (currentState === 'RECUSOU_AVALIACAO') {
    // Empatia contextual: se mudou de ideia e quer agendar, atende direto
    const intentHandled = await handleIntentFromAnyState(lead, phone, text, norm, stateData, leadName, whatsappSender, pushName);
    if (intentHandled) return;

    const wantsHuman = norm.includes('sim') || norm.includes('pode') || norm.includes('especialista') || norm.includes('recepcao') || norm.includes('secretaria') || norm.includes('atendente') || norm === '1';
    if (wantsHuman) {
      db.upsertSerenaLead(phone, {
        state: 'TRANSFERIDO_RECEPCAO',
        transferred_to_reception: 1,
        reception_transfer_time: new Date().toISOString().replace('T', ' ').substring(0, 19)
      });
      const reply = `Com certeza! Já estou passando seu contato para nossa recepção entrar em contato com você o quanto antes. 😊`;
      await sendSerenaReply(phone, reply, whatsappSender);
      await notifyReception(
        `📋 Lead "${leadName || 'sem nome'}" (${phone}) recusou agendamento pela Serena e solicitou contato direto. Favor entrar em contato!`,
        whatsappSender
      );
      return;
    } else {
      // Lead não quer falar com ninguém — pergunta novamente
      db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
      const reply = `Certo! Como posso te ajudar então, ${leadName || ''}?`;
      await sendSerenaReply(phone, reply, whatsappSender);
      return;
    }
  }

  // ── PASSO 3: AGUARDANDO_PREFERENCIA / BUSCANDO HORÁRIO ─────────────────────
  if (currentState === 'AGUARDANDO_PREFERENCIA' || currentState === 'AGUARDANDO_DATA_HORA') {
    // Detecta se o paciente está excluindo hoje ("hoje não", "não hoje", "não consigo hoje", etc.)
    const excludesToday = [
      'hoje nao', 'nao hoje', 'nao consigo hoje', 'nao posso hoje',
      'hoje eu nao', 'hoje nao consigo', 'hoje nao posso',
      'semana que vem', 'proxima semana', 'outra semana',
      'a partir de amanha', 'a partir de segunda', 'a partir de terca',
      'a partir de quarta', 'a partir de quinta', 'a partir de sexta'
    ].some(k => norm.includes(k));

    // ── Parse centralizado de todos os sinais de tempo ───────────────────────
    const parsedDate    = parseDateInput(text);
    const parsedTime    = parseTimeInput(text);       // HH:MM | 'manha' | 'tarde' | 'noite' | null
    const minTimeFilter = parseMinTimeFilter(text);   // "depois das 14h" → "14:00" | null
    const approxTime    = parseApproxTime(text);      // "perto das 10h" → "10:00" | null
    // effectiveTime: horário exato (aproximado tem prioridade; ignora strings de período)
    const effectiveTime = approxTime || (parsedTime && parsedTime.includes(':') ? parsedTime : null);

    // Detecta período preferido a partir de múltiplas fontes
    let period = 'qualquer';
    if (effectiveTime) {
      // Horário exato → deriva período
      const h = parseInt(effectiveTime.split(':')[0], 10);
      period = h < 12 ? 'manha' : 'tarde';
    } else if (minTimeFilter) {
      // Filtro mínimo → deriva período do horário mínimo
      const h = parseInt(minTimeFilter.split(':')[0], 10);
      period = h < 12 ? 'manha' : 'tarde';
    } else {
      // Palavras-chave (remove termos de data para não confundir)
      const normNoDate = norm
        .replace(/\bamanha\b/g, '').replace(/\bhoje\b/g, '')
        .replace(/\bsegunda\b/g, '').replace(/\bterca\b/g, '')
        .replace(/\bquarta\b/g, '').replace(/\bquinta\b/g, '')
        .replace(/\bsexta\b/g, '').replace(/\bsabado\b/g, '');
      if (normNoDate.includes('manha') || normNoDate.includes('cedo')) period = 'manha';
      if (normNoDate.includes('tarde') || normNoDate.includes('final')) period = 'tarde';
      if (parsedTime === 'manha') period = 'manha';
      if (parsedTime === 'tarde') period = 'tarde';
    }

    // ── Caso especial: paciente pediu "noite" (fora do expediente) ───────────
    if (parsedTime === 'noite' && !effectiveTime && !minTimeFilter) {
      const suggestions = schedule.suggestNextAvailableSlots('qualquer', 3, 0);
      let reply =
        `⚠️ ${leadName ? leadName + ', infelizmente' : 'Infelizmente'} não temos atendimento no período da noite.\n\n` +
        `🕐 *Nosso funcionamento:*\n📅 Segunda a Sexta: 08:00 às 18:00\n📅 Sábado: 08:00 às 13:00\n\n`;
      if (suggestions.length > 0) {
        stateData.suggestedSlots = suggestions;
        db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });
        reply += `Mas tenho estes horários disponíveis para você:\n`;
        suggestions.forEach((s, idx) => {
          reply += `\n${idx + 1}️⃣ ${schedule.formatDateBr(s.date)} (${schedule.getDayNameBr(s.date)}) às ${s.time}`;
        });
        reply += `\n\nQual dessas opções fica melhor para você?`;
      } else {
        reply += `Qual período prefere — manhã ou tarde?`;
      }
      await sendSerenaReply(phone, reply, whatsappSender);
      return;
    }

    // ── Monta o prefácio de confirmação de entendimento ──────────────────────
    // A Serena repete o que entendeu antes de mostrar as opções — sem etapa extra,
    // tudo na mesma mensagem, mantendo a conversa fluida.
    function buildUnderstandingPrefix() {
      const parts = [];
      if (parsedDate) parts.push(schedule.formatDateBr(parsedDate) + ` (${schedule.getDayNameBr(parsedDate)})`);
      if (minTimeFilter)           parts.push(`a partir das ${minTimeFilter}`);
      else if (effectiveTime)      parts.push(`às ${effectiveTime}`);
      else if (period === 'manha') parts.push('pela manhã');
      else if (period === 'tarde') parts.push('à tarde');
      if (excludesToday && !parsedDate) parts.push('a partir de amanhã');

      if (!parts.length) return '';
      const understood = parts.join(', ');
      const name = leadName ? `, ${leadName}` : '';
      return `Entendido${name}! Você quer agendamento *${understood}*. 😊\n\n`;
    }

    // ── Caso: exclui hoje (sem data específica) ──────────────────────────────
    if (excludesToday && !parsedDate) {
      const suggestions = schedule.suggestNextAvailableSlots(period, 3, 1);
      if (suggestions.length > 0) {
        stateData.suggestedSlots = suggestions;
        db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });
        const prefix = buildUnderstandingPrefix();
        let sugText = `${prefix}Aqui estão as opções disponíveis:\n`;
        suggestions.forEach((s, idx) => {
          sugText += `\n${idx + 1}️⃣ ${schedule.formatDateBr(s.date)} (${schedule.getDayNameBr(s.date)}) às ${s.time}`;
        });
        sugText += `\n\nQual dessas opções fica melhor para você?`;
        await sendSerenaReply(phone, sugText, whatsappSender);
      } else {
        await sendSerenaReply(phone, `Não encontrei horários disponíveis nos próximos dias. Qual data você prefere?`, whatsappSender);
      }
      return;
    }

    // ── Caso: horário fora do expediente sem data ("às 21h", "às 7h") ────────
    if (!parsedDate && parsedTime && parsedTime.includes(':') && !minTimeFilter) {
      const timeMin = schedule.parseTimeMinutes(parsedTime);
      if (timeMin < 8 * 60 || timeMin > 18 * 60) {
        const suggestions = schedule.suggestNextAvailableSlots(period, 3, 0);
        let reply =
          `⚠️ ${leadName ? leadName + ', o' : 'O'} horário das *${parsedTime}* está fora do nosso horário de atendimento.\n\n` +
          `🕐 *Nosso funcionamento:*\n📅 Segunda a Sexta: 08:00 às 18:00\n📅 Sábado: 08:00 às 13:00\n\n`;
        if (suggestions.length > 0) {
          stateData.suggestedSlots = suggestions;
          db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });
          reply += `Mas tenho estes horários disponíveis para você:\n`;
          suggestions.forEach((s, idx) => {
            reply += `\n${idx + 1}️⃣ ${schedule.formatDateBr(s.date)} (${schedule.getDayNameBr(s.date)}) às ${s.time}`;
          });
          reply += `\n\nQual dessas opções fica melhor para você?`;
        } else {
          reply += `Qual dia e horário ficaria melhor para você dentro desse período?`;
        }
        await sendSerenaReply(phone, reply, whatsappSender);
        return;
      }
    }

    // ── Caso: filtro de horário mínimo ("depois das 14h", com ou sem data) ───
    if (minTimeFilter) {
      const targetDate = parsedDate || holidays.formatDate(new Date());
      const minMin = schedule.parseTimeMinutes(minTimeFilter);
      const dow = new Date(...targetDate.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v))).getDay();
      const maxMin = dow === 6 ? 13 * 60 : 18 * 60;
      if (minMin >= maxMin) {
        const suggestions = schedule.suggestNextAvailableSlots(period, 3, parsedDate ? 0 : 1);
        let reply =
          `⚠️ Após as *${minTimeFilter}* não temos mais atendimento ` +
          `${dow === 6 ? 'aos sábados (encerramos às 13:00)' : '(encerramos às 18:00)'}.\n\n`;
        if (suggestions.length > 0) {
          stateData.suggestedSlots = suggestions;
          db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });
          reply += `Mas tenho estas opções para você:\n`;
          suggestions.forEach((s, idx) => {
            reply += `\n${idx + 1}️⃣ ${schedule.formatDateBr(s.date)} (${schedule.getDayNameBr(s.date)}) às ${s.time}`;
          });
          reply += `\n\nQual dessas opções fica melhor para você?`;
        } else {
          reply += `Qual período prefere? Atendemos de segunda a sexta das 08:00 às 18:00.`;
        }
        await sendSerenaReply(phone, reply, whatsappSender);
        return;
      }
      const slotsAfter = schedule.getAvailableSlotsAfter(targetDate, minTimeFilter);
      const prefix = buildUnderstandingPrefix();
      if (slotsAfter.length > 0) {
        const slotsToShow = slotsAfter.slice(0, 3);
        stateData.suggestedSlots = slotsToShow.map(s => ({ date: targetDate, time: s }));
        db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });
        const formattedDate = schedule.formatDateBr(targetDate);
        const dayName = schedule.getDayNameBr(targetDate);
        let reply = `${prefix}Aqui estão os horários disponíveis no dia ${formattedDate} (${dayName}):\n`;
        slotsToShow.forEach((slot, idx) => { reply += `\n${idx + 1}️⃣ às ${slot}`; });
        reply += `\n\nQual dessas opções fica melhor para você?`;
        await sendSerenaReply(phone, reply, whatsappSender);
        return;
      } else {
        // Fallback: sem slots após minTimeFilter no dia alvo — busca nos próximos dias
        // Usa suggestNextAvailableSlotsAfter para manter o filtro de horário mínimo
        // (evita sugerir 12:30/13:00 quando o paciente pediu "depois das 14h")
        const suggestions = schedule.suggestNextAvailableSlotsAfter(minTimeFilter, 3, parsedDate ? 0 : 1);
        stateData.suggestedSlots = suggestions;
        db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });
        const targetDayLabel = parsedDate
          ? `em ${schedule.formatDateBr(targetDate)} (${schedule.getDayNameBr(targetDate)})`
          : 'para hoje';
        let reply = `${prefix}Não encontrei horários após as ${minTimeFilter} ${targetDayLabel}, mas tenho estas opções nos próximos dias:\n`;
        suggestions.forEach((s, idx) => {
          reply += `\n${idx + 1}️⃣ ${schedule.formatDateBr(s.date)} (${schedule.getDayNameBr(s.date)}) às ${s.time}`;
        });
        reply += `\n\nQual dessas opções fica melhor para você?`;
        await sendSerenaReply(phone, reply, whatsappSender);
        return;
      }
    }

    // ── Caso: apenas horário informado (sem data) — dentro do expediente ─────
    // Ex: "tem algum dia às 10h", "qual dia tem às 14h", "às 15h30 tem?"
    if (!parsedDate && effectiveTime && !minTimeFilter) {
      const timeMin = schedule.parseTimeMinutes(effectiveTime);
      // Só trata aqui se for horário dentro do expediente (fora já foi tratado acima)
      if (timeMin >= 8 * 60 && timeMin <= 18 * 60) {
        const prefix = buildUnderstandingPrefix();
        const slots = schedule.suggestDaysWithTimeSlot(effectiveTime, 3);
        if (slots.length > 0) {
          stateData.suggestedSlots = slots;
          db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });
          let reply = `${prefix}Encontrei disponibilidade às *${effectiveTime}* nos seguintes dias:\n`;
          slots.forEach((s, idx) => {
            reply += `\n${idx + 1}️⃣ ${schedule.formatDateBr(s.date)} (${schedule.getDayNameBr(s.date)}) às ${s.time}`;
          });
          reply += `\n\nQual dessas opções fica melhor para você?`;
          await sendSerenaReply(phone, reply, whatsappSender);
        } else {
          await sendSerenaReply(phone, `Não encontrei disponibilidade às *${effectiveTime}* nos próximos dias. Prefere outro horário ou que eu mostre as opções mais próximas?`, whatsappSender);
        }
        return;
      }
    }

    // ── Caso: data + hora informadas ─────────────────────────────────────────
    if (parsedDate && effectiveTime) {
      const prefix = buildUnderstandingPrefix();
      const slotValidation = schedule.validateSlotForBooking(parsedDate, effectiveTime);
      const isAvailable = db.isSlotAvailable(parsedDate, effectiveTime);

      if (!slotValidation.valid) {
        const sameDaySlots = schedule.getAvailableSlots(parsedDate, 'qualquer');
        let suggestions = [];
        if (sameDaySlots.length > 0) {
          suggestions = sameDaySlots.slice(0, 3).map(s => ({ date: parsedDate, time: s }));
        } else {
          suggestions = schedule.suggestNextAvailableSlots(period, 3);
        }
        const formattedRequested = schedule.formatDateBr(parsedDate);
        const dayRequested = schedule.getDayNameBr(parsedDate);
        let errorReply =
          `${prefix}⚠️ Infelizmente não temos atendimento nesse horário.\n\n` +
          `*Horário pedido:* ${formattedRequested} (${dayRequested}) às ${effectiveTime}\n` +
          `*Motivo:* ${slotValidation.reason}\n\n`;
        if (suggestions.length > 0) {
          stateData.suggestedSlots = suggestions;
          db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });
          errorReply += `Mas tenho estes horários disponíveis para você:\n`;
          suggestions.forEach((s, idx) => {
            errorReply += `\n${idx + 1}️⃣ ${schedule.formatDateBr(s.date)} (${schedule.getDayNameBr(s.date)}) às ${s.time}`;
          });
          errorReply += `\n\nQual dessas opções fica melhor para você?`;
        } else {
          errorReply += `Nosso atendimento é de segunda a sexta das 08:00 às 18:00 e aos sábados das 08:00 às 13:00. Qual dia e horário prefere?`;
        }
        await sendSerenaReply(phone, errorReply, whatsappSender);
        return;
      }

      if (isAvailable) {
        stateData.pendingBooking = { date: parsedDate, time: effectiveTime };
        db.upsertSerenaLead(phone, { state: 'CONFIRMANDO_AGENDAMENTO', state_data: stateData });
        const formattedDate = schedule.formatDateBr(parsedDate);
        const dayName = schedule.getDayNameBr(parsedDate);
        const reply =
          `${prefix}✅ Ótima notícia — esse horário está disponível!\n\n` +
          `📅 *${formattedDate} (${dayName}) às ${effectiveTime}*\n` +
          `⏱ Duração: aproximadamente 30 minutos\n\n` +
          `Posso confirmar seu agendamento para a avaliação gratuita? (Responda *1* para Confirmar ou *2* para escolher outro horário)`;
        await sendSerenaReply(phone, reply, whatsappSender);
        return;
      } else {
        const sameDaySlots = schedule.getAvailableSlots(parsedDate, period);
        let suggestions = [];
        if (sameDaySlots.length > 0) {
          suggestions = sameDaySlots.slice(0, 3).map(s => ({ date: parsedDate, time: s }));
        } else {
          suggestions = schedule.suggestNextAvailableSlots(period, 3);
        }
        if (suggestions.length > 0) {
          stateData.suggestedSlots = suggestions;
          db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });
          const formattedPreferred = schedule.formatDateBr(parsedDate);
          const dayPreferred = schedule.getDayNameBr(parsedDate);
          let occText =
            `${prefix}Que pena — o horário das ${effectiveTime} no dia ${formattedPreferred} (${dayPreferred}) já está ocupado. 😔\n\nMas encontrei estas opções para você:\n`;
          suggestions.forEach((s, idx) => {
            occText += `\n${idx + 1}️⃣ ${schedule.formatDateBr(s.date)} (${schedule.getDayNameBr(s.date)}) às ${s.time}`;
          });
          occText += `\n\nQual dessas opções você prefere?`;
          await sendSerenaReply(phone, occText, whatsappSender);
          return;
        }
      }
    }

    // ── Caso: só data informada — mostra slots do dia filtrados por período ───
    if (parsedDate) {
      const prefix = buildUnderstandingPrefix();
      const available = schedule.getAvailableSlots(parsedDate, period);
      if (available.length > 0) {
        const slotsToShow = available.slice(0, 3);
        stateData.suggestedSlots = slotsToShow.map(s => ({ date: parsedDate, time: s }));
        db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });
        const formattedDate = schedule.formatDateBr(parsedDate);
        const dayName = schedule.getDayNameBr(parsedDate);
        const periodLabel = period === 'manha' ? ' pela manhã' : period === 'tarde' ? ' à tarde' : '';
        let optionsText = `${prefix}Aqui estão as opções disponíveis${periodLabel} no dia ${formattedDate} (${dayName}):\n`;
        slotsToShow.forEach((slot, idx) => {
          optionsText += `\n${idx + 1}️⃣ às ${slot}`;
        });
        optionsText += `\n\nQual dessas opções fica melhor para você? (Os horários costumam preencher rápido!)`;
        await sendSerenaReply(phone, optionsText, whatsappSender);
        return;
      } else {
        const suggestions = schedule.suggestNextAvailableSlots(period, 3);
        if (suggestions.length > 0) {
          stateData.suggestedSlots = suggestions;
          db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });
          const formattedDate = schedule.formatDateBr(parsedDate);
          const dayName = schedule.getDayNameBr(parsedDate);
          let sugText = `${prefix}Para ${formattedDate} (${dayName}) não temos mais horários disponíveis, mas encontrei opções bem próximas para você:\n`;
          suggestions.forEach((s, idx) => {
            sugText += `\n${idx + 1}️⃣ ${schedule.formatDateBr(s.date)} (${schedule.getDayNameBr(s.date)}) às ${s.time}`;
          });
          sugText += `\n\nQual dessas opções você prefere?`;
          await sendSerenaReply(phone, sugText, whatsappSender);
          return;
        }
      }
    }

    // Sugere opções gerais nos próximos dias
    const suggestions = schedule.suggestNextAvailableSlots(period, 3);
    if (suggestions.length > 0) {
      stateData.suggestedSlots = suggestions;
      db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });

      let sugText = `${leadName ? leadName + ', v' : 'V'}erifiquei aqui nossa disponibilidade para te encaixar o quanto antes. Temos as seguintes opções para sua avaliação gratuita:\n`;
      suggestions.forEach((s, idx) => {
        sugText += `\n${idx + 1}️⃣ ${schedule.formatDateBr(s.date)} (${schedule.getDayNameBr(s.date)}) às ${s.time}`;
      });
      sugText += `\n\nQual dessas opções fica melhor para você? Responda com o número ou me diga outro dia/horário de sua preferência.`;
      await sendSerenaReply(phone, sugText, whatsappSender);
      return;
    } else {
      db.upsertSerenaLead(phone, { state: 'TRANSFERIDO_RECEPCAO', transferred_to_reception: 1 });
      const reply = "Nossa agenda automática para os próximos dias está bastante concorrida! Vou passar para a nossa recepção agora para verificarem um encaixe especial para você.";
      await sendSerenaReply(phone, reply, whatsappSender);
      await notifyReception(`O prospect "${leadName || 'sem nome'}" (${phone}) deseja agendamento mas a agenda automática está lotada. Favor contatar!`, whatsappSender);
      return;
    }
  }

  // PASSO 4: SELECIONANDO_OPCAO (Escolhendo 1, 2, 3...)
  if (currentState === 'SELECIONANDO_OPCAO') {
    const suggested = stateData.suggestedSlots || [];
    let selectedIndex = -1;

    // Reconhece escolha estrita de opção (evita falsos positivos como "1 dente" ou respostas a atendentes)
    const isStrictOpt1 = norm === '1' || norm === 'opcao 1' || norm === 'a' || norm === 'opcao a' || /^1\b/.test(norm) || /primeir[ao]/.test(norm);
    const isStrictOpt2 = norm === '2' || norm === 'opcao 2' || norm === 'b' || norm === 'opcao b' || /^2\b/.test(norm) || /segund[ao]/.test(norm);
    const isStrictOpt3 = norm === '3' || norm === 'opcao 3' || norm === 'c' || norm === 'opcao c' || /^3\b/.test(norm) || /terceir[ao]/.test(norm);

    if (isStrictOpt1) selectedIndex = 0;
    else if (isStrictOpt2) selectedIndex = 1;
    else if (isStrictOpt3) selectedIndex = 2;

    if (selectedIndex >= 0 && suggested[selectedIndex]) {
      const chosen = suggested[selectedIndex];
      // Avança para confirmação explícita em vez de agendar diretamente sem confirmação do paciente
      stateData.pendingBooking = { date: chosen.date, time: chosen.time };
      db.upsertSerenaLead(phone, { state: 'CONFIRMANDO_AGENDAMENTO', state_data: stateData });
      const formattedDate = schedule.formatDateBr(chosen.date);
      const dayName = schedule.getDayNameBr(chosen.date);
      const reply =
        `Perfeito${leadName ? ', ' + leadName : ''}! Selecionei para você:\n\n` +
        `📅 *${formattedDate} (${dayName}) às ${chosen.time}*\n` +
        `⏱ Duração: aproximadamente 30 minutos\n\n` +
        `Posso confirmar seu agendamento para a avaliação gratuita? (Responda *1* para Confirmar ou *2* para escolher outro horário)`;
      await sendSerenaReply(phone, reply, whatsappSender);
      return;
    }

    // Detecção de recusa / rotação de agenda ("não posso nesses dias", "nenhum dos dois", "outro dia", "outra semana")
    const isRefusingOfferedSlots = /nao posso|nenhum|nenhum dos|outro dia|outra semana|semana que vem|esses horarios nao|nao consigo nesses|nao da nesses|nao tenho como/.test(norm);
    if (isRefusingOfferedSlots) {
      const nextOffset = (stateData.rotationOffset || 0) + 3;
      const nextSuggestions = schedule.suggestNextAvailableSlots('qualquer', 3, Math.min(nextOffset, 12));
      if (nextSuggestions.length > 0) {
        stateData.rotationOffset = nextOffset;
        stateData.suggestedSlots = nextSuggestions;
        db.upsertSerenaLead(phone, { state: 'SELECIONANDO_OPCAO', state_data: stateData });

        let rotateMsg = `Sem problemas${leadName ? ', ' + leadName : ''}! Girei nossa agenda para te dar outras opções livres:\n`;
        nextSuggestions.forEach((s, idx) => {
          rotateMsg += `\n${idx + 1}️⃣ ${schedule.formatDateBr(s.date)} (${schedule.getDayNameBr(s.date)}) às ${s.time}`;
        });
        rotateMsg += `\n\nQual dessas opções fica melhor para você? Se preferir outro turno ou Sábado, é só me falar! 😊`;
        await sendSerenaReply(phone, rotateMsg, whatsappSender);
        return;
      }
    }

    // Empatia: verifica data/hora nova, filtro mínimo ou intenção diferente
    const parsedDate = parseDateInput(text);
    const parsedTime = parseTimeInput(text);
    const minTimeFilterSel = parseMinTimeFilter(text);
    if (parsedDate || parsedTime || minTimeFilterSel) {
      db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
      const updatedLead = db.getSerenaLead(phone);
      await handleConversationFlow(updatedLead, phone, text, stateData, whatsappSender, pushName);
      return;
    }

    // Empatia: outra intenção (preço, convênio, etc.)
    const intentHandled = await handleIntentFromAnyState(lead, phone, text, norm, stateData, leadName, whatsappSender, pushName);
    if (intentHandled) return;

    const repText = `${leadName ? leadName + ', d' : 'D'}igite o número da opção desejada (*1*, *2* ou *3*) ou me informe outro dia e horário que fique melhor para você!`;
    await sendSerenaReply(phone, repText, whatsappSender);
    return;
  }

  // PASSO 5: CONFIRMANDO_AGENDAMENTO
  if (currentState === 'CONFIRMANDO_AGENDAMENTO') {
    if (norm === '1' || norm.includes('sim') || norm.includes('confirma') || norm === 'pode ser' || norm.includes('ok')) {
      const pb = stateData.pendingBooking;
      if (pb) {
        await finalizeBooking(lead, phone, leadName, pb.date, pb.time, whatsappSender);
        return;
      }
    } else if (norm === '2' || norm.includes('nao') || norm.includes('outro')) {
      db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
      const reply = `Sem problemas, ${leadName || ''}! Qual outro dia ou período você prefere?`;
      await sendSerenaReply(phone, reply, whatsappSender);
      return;
    } else {
      // Empatia: mensagem fora do contexto de confirmação — atende a intenção
      const intentHandled = await handleIntentFromAnyState(lead, phone, text, norm, stateData, leadName, whatsappSender, pushName);
      if (intentHandled) return;
      // Repete a pergunta de confirmação com o slot pendente
      const pb = stateData.pendingBooking;
      if (pb) {
        const reply = `${leadName ? leadName + ', p' : 'P'}osso confirmar seu agendamento para *${schedule.formatDateBr(pb.date)} às ${pb.time}*? Responda *1* para Confirmar ou *2* para escolher outro horário.`;
        await sendSerenaReply(phone, reply, whatsappSender);
        return;
      }
    }
  }

  // Fallback padrão humanizado
  const defaultReply = `${leadName ? leadName + ', e' : 'E'}stou aqui para te ajudar a realizar sua avaliação gratuita (com RX e Escaneamento 5D inclusos). Gostaria de agendar para esta semana?`;
  await sendSerenaReply(phone, defaultReply, whatsappSender);
}

/**
 * Conclui e confirma o agendamento no sistema
 */
async function finalizeBooking(lead, phone, leadName, date, time, whatsappSender) {
  if (!leadName || leadName === 'Paciente') {
    const askFinalName = "Para finalizarmos seu agendamento no sistema da clínica, por favor, me informe seu nome:";
    db.upsertSerenaLead(phone, { state: 'AGUARDANDO_NOME_FINAL', state_data: { pendingBooking: { date, time } } });
    await sendSerenaReply(phone, askFinalName, whatsappSender);
    return;
  }

  const patientName = leadName;
  db.createAppointment(phone, patientName, date, time, 'Agendado via Serena (WhatsApp)');
  db.upsertSerenaLead(phone, { state: 'AGENDADO', followup_count: 0, next_followup_at: null });

  const formattedDate = schedule.formatDateBr(date);
  const dayName = schedule.getDayNameBr(date);

  // Recupera a necessidade capturada (se houver) para incluir no agendamento
  let stateDataFinal = {};
  try { stateDataFinal = JSON.parse(lead.state_data || '{}'); } catch (_) {}
  const patientNeed = stateDataFinal.patientNeed || '';

  const needLine = patientNeed
    ? `\n🦷 *Motivo informado:* ${patientNeed.charAt(0).toUpperCase() + patientNeed.slice(1)}`
    : '';

  const confirmMsg =
    `🎉 *Agendamento Confirmado!*\n\n` +
    `Perfeito, *${patientName}*! Sua avaliação gratuita está marcada:\n\n` +
    `📅 *Data:* ${formattedDate} (${dayName})\n` +
    `🕐 *Horário:* ${time}\n` +
    `⏱ *Duração:* aproximadamente 30 minutos\n` +
    `📍 *Local:* Av. Antônio Carlos Costa, 991 — Bela Vista, Osasco/SP` +
    needLine + `\n\n` +
    `✨ A avaliação é *100% gratuita* e inclui RX Panorâmico e Escaneamento 5D!\n\n` +
    `💰 Na consulta, nosso especialista apresentará as *melhores condições de preço e parcelamento* disponíveis para o seu caso — tudo de forma clara e sem compromisso. Te esperamos! 😊`;

  await sendWithFollowup(phone, confirmMsg, patientName, whatsappSender);

  // Notifica a recepção — inclui a necessidade do paciente quando disponível
  const needInfo = patientNeed ? ` | 🦷 Necessidade: ${patientNeed}` : '';
  await notifyReception(
    `✅ Serena agendou: *${patientName}* | 📱 ${phone} | 📅 ${formattedDate} (${dayName}) às ${time} | ⏱ 30 min${needInfo}`,
    whatsappSender
  );
}

/**
 * Envia notificação para a recepção
 */
async function notifyReception(messageText, whatsappSender) {
  const config = db.getConfig();
  const receptionPhone = (config.reception_phone || '').replace(/\D/g, '');
  if (!receptionPhone) {
    console.warn('[Serena] Número da recepção não configurado.');
    return;
  }

  try {
    await whatsappSender(receptionPhone, messageText);
  } catch (err) {
    console.error('[Serena] Erro ao enviar aviso para a recepção:', err.message);
  }
}

/**
 * Envia resposta e, após um breve intervalo, pergunta se pode ajudar em algo mais.
 * Usar apenas em pontos de encerramento real de assunto (agendamento confirmado,
 * informação fornecida, cancelamento aceito, etc.).
 */
async function sendWithFollowup(phone, messageText, leadName, whatsappSender) {
  await sendSerenaReply(phone, messageText, whatsappSender);
  await new Promise(r => setTimeout(r, 2000));
  const phrase = pickRandom(FOLLOWUP_PHRASES);
  const moreHelp = leadName ? `${leadName}, ${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}` : phrase;
  db.upsertSerenaLead(phone, { state: 'AGUARDANDO_PREFERENCIA' });
  await sendSerenaReply(phone, moreHelp, whatsappSender);
}

/**
 * Envia resposta humanizada da Serena com atraso natural + simulação de digitação.
 *
 * O whatsappSender pode ter uma propriedade `.typing` opcional:
 *   whatsappSender.typing = async (durationMs) => { ... }
 * Se presente, ativa o estado "Digitando..." no WhatsApp antes de enviar.
 * Isso humaniza a resposta e reduz a probabilidade de detecção como bot pela Meta.
 */
async function sendSerenaReply(phone, messageText, whatsappSender, isAutomatedFollowup = false) {
  const cleanPhone = String(phone || '').replace(/\D/g, '');

  // Trava anti-ban: incrementa contador de mensagens seguidas enviadas pelo bot sem resposta
  if (isAutomatedFollowup) {
    const currentLead = db.getSerenaLead(cleanPhone);
    const unanswered = (currentLead?.unanswered_bot_count || 0) + 1;
    db.upsertSerenaLead(cleanPhone, { unanswered_bot_count: unanswered });
  }

  const delay = getRandomTypingDelay();

  // Etapa 1: atraso de reação (3-6s) — simula o tempo de leitura da mensagem
  await new Promise(r => setTimeout(r, delay));

  // Etapa 2: ativa "Digitando..." por 2-4s (se suportado pelo sender)
  if (typeof whatsappSender.typing === 'function') {
    try {
      const typingMs = Math.floor(Math.random() * 2000) + 2000; // 2000–4000ms
      await whatsappSender.typing(typingMs);
    } catch (_) {}
  }

  db.insertSerenaMessage(cleanPhone, 'serena', messageText);
  try {
    await whatsappSender(cleanPhone, messageText);
  } catch (err) {
    console.error(`[Serena] Falha ao enviar resposta para ${cleanPhone}:`, err.message);
  }
}

module.exports = {
  processMessage,
  notifyReception,
  sendSerenaReply,
  cleanText
};

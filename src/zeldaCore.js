// === SERENA_RUNTIME_AUTOHOOK_START ===
try {
  const __p = require("path"), __f = require("fs");
  const __cands = [__p.join(__dirname, "configuracoes"), __p.join(__dirname, "..", "configuracoes"), __p.join(__dirname, "..", "..", "configuracoes"), __p.join(process.cwd(), "configuracoes")];
  if (process.resourcesPath) { __cands.push(__p.join(process.resourcesPath, "app", "configuracoes"), __p.join(process.resourcesPath, "configuracoes")); }
  for (const __d of __cands) { const __h = __p.join(__d, "runtimeAutoHook.cjs"); if (__f.existsSync(__h)) { require(__h); break; } }
} catch (_eAutoHook) {}
// === SERENA_RUNTIME_AUTOHOOK_END ===
/**
 * zeldaCore.js — Bot Zelda para gestão de iniciativas do Condomínio
 * Grupo: Conselho T7
 * Comandos prefixados por "Zelda," (case-insensitive)
 */
const db = require('./db');

// ── Estado de sessões interativas por usuário (em memória) ────────────────────
// Usado para fluxos de cadastro multi-passo (incluir atividade, adicionar orçamento)
const sessions = new Map();

const STATUS_LABELS = {
  em_cotacao:    '🔵 Em Cotação',
  cotado:        '🟡 Cotado',
  em_aprovacao:  '🟠 Em Aprovação',
  aprovado:      '✅ Aprovado',
  em_execucao:   '🔨 Em Execução',
  encerrado:     '🏁 Encerrado',
  negado:        '❌ Negado'
};

// Status terminais — nenhuma alteração permitida
const TERMINAL_STATUS = ['encerrado', 'negado'];

// Transições de status permitidas (de → para[])
const ALLOWED_TRANSITIONS = {
  em_cotacao:   ['cotado'],
  cotado:       ['em_aprovacao', 'em_cotacao'],
  em_aprovacao: ['cotado'],             // só volta; aprovado/negado é automático
  aprovado:     ['em_execucao'],
  em_execucao:  ['encerrado'],
  encerrado:    [],
  negado:       []
};

// Mapa de aliases de status que o usuário pode digitar
const STATUS_ALIASES = {
  'em cotacao':   'em_cotacao',
  'cotado':       'cotado',
  'em aprovacao': 'em_aprovacao',
  'aprovado':     'aprovado',
  'em execucao':  'em_execucao',
  'encerrado':    'encerrado',
  'negado':       'negado'
};

function cleanText(t) {
  if (!t) return '';
  return t.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function fmtSeq(seq) {
  return `#${String(seq).padStart(3, '0')}`;
}

function fmtValue(v) {
  if (v == null) return '—';
  return `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
}

function buildInitiativeCard(ini, quotes, votes) {
  const seqStr = fmtSeq(ini.seq);
  const statusLabel = STATUS_LABELS[ini.status] || ini.status;
  let card =
    `📋 *Iniciativa ${seqStr}*\n` +
    `📌 *Atividade:* ${ini.title}\n` +
    `👤 *Responsável:* ${ini.responsible}\n` +
    `📅 *Prazo:* ${ini.due_date || '—'}\n` +
    `🔖 *Status:* ${statusLabel}\n`;

  if (quotes && quotes.length > 0) {
    card += `\n💰 *Orçamentos:*\n`;
    quotes.forEach(q => {
      const marker = ini.supplier === q.supplier ? ' ✅' : '';
      card += `  ${q.seq}️⃣ ${q.supplier} — ${fmtValue(q.value)}${marker}\n`;
    });
  }

  if (ini.supplier) {
    card += `\n🏢 *Fornecedor aprovado:* ${ini.supplier}\n`;
    card += `💵 *Valor aprovado:* ${fmtValue(ini.approved_value)}\n`;
  }

  if (votes && votes.length > 0) {
    const approvals = votes.filter(v => v.vote === 'approve');
    const rejections = votes.filter(v => v.vote === 'reject');
    if (approvals.length > 0) {
      card += `\n✅ *Aprovações (${approvals.length}):* ${approvals.map(v => v.voter_name || v.voter_phone).join(', ')}\n`;
    }
    if (rejections.length > 0) {
      card += `❌ *Rejeições (${rejections.length}):* ${rejections.map(v => v.voter_name || v.voter_phone).join(', ')}\n`;
    }
  }

  return card.trim();
}

/**
 * Ponto de entrada principal — chamado pelo whatsapp.js para cada mensagem de grupo.
 * @param {string} groupId        - ID do grupo (@g.us)
 * @param {string} senderPhone    - número do remetente (só dígitos)
 * @param {string} senderName     - nome do contato (pushName)
 * @param {string} text           - texto da mensagem
 * @param {Function} groupSender  - async (text) => void — envia no grupo
 */
async function processGroupMessage(groupId, senderPhone, senderName, text, groupSender) {
  const config = db.getConfig();
  if (config.zelda_enabled === '0') return;

  const trimmed = text.trim();
  const prefixMatch = trimmed.match(/^@?zelda[\s,:\-–—]+/i) || (trimmed.toLowerCase() === 'zelda' ? [trimmed] : null);

  const sessionKey = `${groupId}:${senderPhone}`;
  const inSession = sessions.has(sessionKey);

  // Se não tem prefixo e não está em sessão interativa, ignora a mensagem
  if (!prefixMatch && !inSession) return;

  // Loga a mensagem recebida
  db.zeldaLogMessage(groupId, senderPhone, senderName || senderPhone, 'in', text);

  const sindicoPhone = (config.zelda_sindico_phone || '').replace(/\D/g, '');
  const minApprovals = parseInt(config.zelda_min_approvals || '3', 10);
  const isSindico = senderPhone.replace(/\D/g, '') === sindicoPhone;

  const send = async (msg) => {
    db.zeldaLogMessage(groupId, 'zelda', 'Zelda', 'out', msg);
    await groupSender(msg);
  };

  // Se o usuário está em sessão interativa, aceita a resposta com ou sem prefixo "Zelda,"
  if (inSession) {
    const rawStepInput = prefixMatch ? trimmed.slice(prefixMatch[0].length).trim() : trimmed;
    const normStepInput = cleanText(rawStepInput);
    await handleSessionStep(sessionKey, senderPhone, senderName, rawStepInput, normStepInput, send, groupId, minApprovals, isSindico);
    return;
  }

  // Extrai o comando após o prefixo da Zelda
  const rawCmd = trimmed.slice(prefixMatch[0].length).trim();
  const cmdNorm = cleanText(rawCmd);

  // ── Roteamento de comandos ─────────────────────────────────────────────────

  if (cmdNorm === '?' || cmdNorm === 'ajuda' || cmdNorm === 'help') {
    await cmdHelp(send, isSindico);
    return;
  }

  if (cmdNorm === 'incluir atividade' || cmdNorm === 'nova atividade' || cmdNorm === 'incluir') {
    await cmdStartNewInitiative(sessionKey, senderPhone, senderName, send);
    return;
  }

  if (cmdNorm === 'listar atividades' || cmdNorm === 'listar' || cmdNorm === 'lista') {
    await cmdList(send);
    return;
  }

  if (cmdNorm === 'historico' || cmdNorm === 'histórico') {
    await cmdHistory(send);
    return;
  }

  if (cmdNorm === 'arquivar tudo') {
    await cmdArchiveAll(send, isSindico, senderName);
    return;
  }

  // Zelda, detalhe 001
  const matchDetail = cmdNorm.match(/^detalhe\s+(\d+)$/);
  if (matchDetail) {
    await cmdDetail(Number(matchDetail[1]), send);
    return;
  }

  // Zelda, status 001
  const matchStatus = cmdNorm.match(/^status\s+(\d+)$/);
  if (matchStatus) {
    await cmdStatus(Number(matchStatus[1]), send);
    return;
  }

  // Zelda, adicionar orçamento 001
  const matchQuote = cmdNorm.match(/^adicionar\s+or[cç]amento\s+(\d+)$/);
  if (matchQuote) {
    await cmdStartAddQuote(sessionKey, senderPhone, senderName, Number(matchQuote[1]), send, isSindico);
    return;
  }

  // Zelda, mudar status 001 para <status>
  const matchChange = cmdNorm.match(/^mudar\s+status\s+(\d+)\s+para\s+(.+)$/);
  if (matchChange) {
    await cmdChangeStatus(Number(matchChange[1]), matchChange[2].trim(), senderPhone, senderName, send, isSindico, groupId, minApprovals, groupSender);
    return;
  }

  // Zelda, aprovar 001  |  Zelda, aprovar 001 orcamento 2
  const matchApprove = cmdNorm.match(/^aprovar\s+(\d+)(?:\s+or[cç]amento\s+(\d+))?$/);
  if (matchApprove) {
    await cmdVote(Number(matchApprove[1]), senderPhone, senderName, 'approve', matchApprove[2] ? Number(matchApprove[2]) : null, send, isSindico, minApprovals, groupId, groupSender);
    return;
  }

  // Zelda, rejeitar 001
  const matchReject = cmdNorm.match(/^rejeitar\s+(\d+)$/);
  if (matchReject) {
    await cmdVote(Number(matchReject[1]), senderPhone, senderName, 'reject', null, send, isSindico, minApprovals, groupId, groupSender);
    return;
  }

  // Zelda, comentar 001 <texto>
  const matchComment = cmdNorm.match(/^comentar\s+(\d+)\s+(.+)$/);
  if (matchComment) {
    await cmdComment(Number(matchComment[1]), senderPhone, senderName, rawCmd.replace(/^comentar\s+\d+\s+/i, '').trim(), send);
    return;
  }

  // Comando não reconhecido
  await send(`Desculpe, não entendi o comando. Digite *Zelda, ?* para ver os comandos disponíveis.`);
}

// ── Handlers de comandos ──────────────────────────────────────────────────────

async function cmdHelp(send, isSindico) {
  let msg =
    `*🤖 Zelda — Comandos disponíveis:*\n\n` +
    `*Zelda, incluir atividade* — Cadastra nova iniciativa\n` +
    `*Zelda, listar atividades* — Lista todas as atividades abertas\n` +
    `*Zelda, detalhe 001* — Ficha completa da atividade #001\n` +
    `*Zelda, status 001* — Status atual e votos da atividade #001\n` +
    `*Zelda, adicionar orçamento 001* — Adiciona orçamento à atividade #001\n` +
    `*Zelda, mudar status 001 para cotado* — Muda o status\n` +
    `*Zelda, aprovar 001* — Vota pela aprovação (escolhe orçamento se houver)\n` +
    `*Zelda, rejeitar 001* — Vota pela rejeição da atividade #001\n` +
    `*Zelda, comentar 001 seu texto* — Adiciona comentário à atividade\n` +
    `*Zelda, historico* — Lista atividades encerradas e negadas\n`;
  if (isSindico) {
    msg += `*Zelda, arquivar tudo* — Arquiva encerradas/negadas _(só síndico)_\n`;
  }
  msg += `\n*Status disponíveis:* Em Cotação → Cotado → Em Aprovação → Aprovado → Em Execução → Encerrado\n`;
  msg += `\n_Aprovação automática: ${db.getConfig().zelda_min_approvals || 3} votos aprovam; ${db.getConfig().zelda_min_approvals || 3} votos rejeitam_`;
  await send(msg);
}

async function cmdList(send) {
  const list = db.zeldaListActive();
  if (!list.length) {
    await send(`Não há atividades abertas no momento. Use *Zelda, incluir atividade* para cadastrar.`);
    return;
  }
  let msg = `*📋 Atividades abertas:*\n\n`;
  list.forEach(ini => {
    const statusLabel = STATUS_LABELS[ini.status] || ini.status;
    msg += `${fmtSeq(ini.seq)} — ${ini.title}\n   ${statusLabel} | 👤 ${ini.responsible} | 📅 ${ini.due_date || '—'}\n\n`;
  });
  msg += `_Use *Zelda, detalhe NNN* para ver detalhes completos._`;
  await send(msg);
}

async function cmdHistory(send) {
  const list = db.zeldaListArchived();
  if (!list.length) {
    await send(`Não há atividades arquivadas ainda.`);
    return;
  }
  let msg = `*📚 Histórico de atividades:*\n\n`;
  list.forEach(ini => {
    const statusLabel = STATUS_LABELS[ini.status] || ini.status;
    msg += `${fmtSeq(ini.seq)} — ${ini.title} | ${statusLabel}\n`;
  });
  await send(msg);
}

async function cmdDetail(seq, send) {
  const ini = db.zeldaGetBySeq(seq);
  if (!ini) { await send(`Atividade ${fmtSeq(seq)} não encontrada.`); return; }
  const quotes = db.zeldaGetQuotes(ini.id);
  const votes  = db.zeldaGetVotes(ini.id);
  const comments = db.zeldaGetComments(ini.id);

  let msg = buildInitiativeCard(ini, quotes, votes);

  if (comments.length > 0) {
    msg += `\n\n💬 *Comentários:*\n`;
    comments.forEach(c => {
      msg += `• [${c.created_at.substring(0, 16)}] *${c.author_name || c.author_phone}:* ${c.comment}\n`;
    });
  }
  await send(msg);
}

async function cmdStatus(seq, send) {
  const ini = db.zeldaGetBySeq(seq);
  if (!ini) { await send(`Atividade ${fmtSeq(seq)} não encontrada.`); return; }
  const config = db.getConfig();
  const min = parseInt(config.zelda_min_approvals || '3', 10);
  const votes = db.zeldaCountVotes(ini.id);
  const statusLabel = STATUS_LABELS[ini.status] || ini.status;

  let msg = `*${fmtSeq(ini.seq)} — ${ini.title}*\nStatus: ${statusLabel}\n`;
  if (ini.status === 'em_aprovacao') {
    msg += `\n✅ Aprovações: ${votes.approvals.length}/${min} — ${votes.approvals.map(v => v.voter_name || v.voter_phone).join(', ') || 'nenhuma ainda'}\n`;
    msg += `❌ Rejeições: ${votes.rejections.length}/${min} — ${votes.rejections.map(v => v.voter_name || v.voter_phone).join(', ') || 'nenhuma ainda'}\n`;
  }
  await send(msg);
}

async function cmdArchiveAll(send, isSindico, senderName) {
  if (!isSindico) {
    await send(`⛔ Apenas o síndico pode usar o comando *arquivar tudo*.`);
    return;
  }
  db.zeldaArchiveAll();
  await send(`✅ Todas as atividades encerradas e negadas foram arquivadas com sucesso.`);
}

async function cmdComment(seq, senderPhone, senderName, comment, send) {
  const ini = db.zeldaGetBySeq(seq);
  if (!ini) { await send(`Atividade ${fmtSeq(seq)} não encontrada.`); return; }
  db.zeldaAddComment(ini.id, senderPhone, senderName || senderPhone, comment);
  await send(`💬 Comentário adicionado à atividade ${fmtSeq(seq)} por ${senderName || senderPhone}.`);
}

async function cmdChangeStatus(seq, statusRaw, senderPhone, senderName, send, isSindico, groupId, minApprovals, groupSender) {
  const ini = db.zeldaGetBySeq(seq);
  if (!ini) { await send(`Atividade ${fmtSeq(seq)} não encontrada.`); return; }

  if (TERMINAL_STATUS.includes(ini.status)) {
    await send(`⛔ A atividade ${fmtSeq(seq)} está *${STATUS_LABELS[ini.status]}* e não pode mais ser alterada.`);
    return;
  }

  // Apenas responsável ou síndico podem mudar status
  const cleanSender = senderPhone.replace(/\D/g, '');
  const cleanCreator = (ini.created_by || '').replace(/\D/g, '');
  if (!isSindico && cleanSender !== cleanCreator) {
    await send(`⛔ Apenas o responsável pela atividade ou o síndico podem alterar o status.`);
    return;
  }

  const newStatus = STATUS_ALIASES[cleanText(statusRaw)];
  if (!newStatus) {
    await send(`Status inválido. Opções: _em cotação, cotado, em aprovação, em execução, encerrado_`);
    return;
  }

  if (newStatus === 'aprovado') {
    await send(`⛔ O status *Aprovado* é definido automaticamente após ${minApprovals} aprovações do conselho.`);
    return;
  }

  const allowed = ALLOWED_TRANSITIONS[ini.status] || [];
  if (!allowed.includes(newStatus)) {
    await send(`⛔ Não é possível mover de *${STATUS_LABELS[ini.status]}* para *${STATUS_LABELS[newStatus]}*.\nTransições permitidas: ${allowed.map(s => STATUS_LABELS[s]).join(', ') || 'nenhuma'}`);
    return;
  }

  db.zeldaUpdateStatus(ini.id, newStatus);

  const updatedIni = db.zeldaGetBySeq(seq);
  await send(`✅ Status da atividade ${fmtSeq(seq)} atualizado para *${STATUS_LABELS[newStatus]}* por ${senderName || senderPhone}.`);

  // Se entrou em aprovação — dispara notificação imediata com orçamentos
  if (newStatus === 'em_aprovacao') {
    await triggerApprovalRequest(updatedIni, groupId, groupSender, minApprovals);
  }
}

async function cmdVote(seq, senderPhone, senderName, vote, quoteSeqInput, send, isSindico, minApprovals, groupId, groupSender) {
  const ini = db.zeldaGetBySeq(seq);
  if (!ini) { await send(`Atividade ${fmtSeq(seq)} não encontrada.`); return; }

  if (ini.status !== 'em_aprovacao') {
    await send(`⛔ A atividade ${fmtSeq(seq)} não está em aprovação (status atual: ${STATUS_LABELS[ini.status]}).`);
    return;
  }

  if (isSindico) {
    await send(`⛔ O síndico não participa da votação conforme convenção do condomínio.`);
    return;
  }

  if (db.zeldaHasVoted(ini.id, senderPhone)) {
    await send(`⚠️ ${senderName || senderPhone}, você já registrou seu voto na atividade ${fmtSeq(seq)}.`);
    return;
  }

  // Se é aprovação e há orçamentos, precisa escolher qual
  const quotes = db.zeldaGetQuotes(ini.id);
  if (vote === 'approve' && quotes.length > 1 && !quoteSeqInput) {
    // Inicia sessão para escolher orçamento
    const sessionKey = `${groupId}:${senderPhone}`;
    sessions.set(sessionKey, { step: 'choose_quote', initiativeId: ini.id, seq: ini.seq, vote: 'approve', senderName });
    let msg = `${senderName || senderPhone}, para aprovar a atividade ${fmtSeq(seq)}, escolha o orçamento:\n\n`;
    quotes.forEach(q => { msg += `  *${q.seq}* — ${q.supplier} (${fmtValue(q.value)})\n`; });
    msg += `\nResponda com o número do orçamento (1, 2 ou 3).`;
    await send(msg);
    return;
  }

  // Valida o orçamento escolhido (se houver)
  let finalQuoteSeq = null;
  if (vote === 'approve' && quotes.length > 0) {
    finalQuoteSeq = quoteSeqInput || (quotes.length === 1 ? quotes[0].seq : null);
    if (quotes.length > 1 && !finalQuoteSeq) {
      await send(`Informe o número do orçamento: *Zelda, aprovar ${seq} orçamento N*`);
      return;
    }
  }

  db.zeldaAddVote(ini.id, senderPhone, senderName || senderPhone, vote, finalQuoteSeq);
  const counts = db.zeldaCountVotes(ini.id);

  if (vote === 'approve') {
    const chosenQuote = finalQuoteSeq ? quotes.find(q => q.seq === finalQuoteSeq) : null;
    const quoteInfo = chosenQuote ? ` — orçamento ${finalQuoteSeq} (${chosenQuote.supplier} · ${fmtValue(chosenQuote.value)})` : '';
    await send(`✅ *${senderName || senderPhone}* aprovou ${fmtSeq(seq)}${quoteInfo} — ${counts.approvals.length}/${minApprovals} aprovações`);

    if (counts.approvals.length >= minApprovals) {
      await resolveApproval(ini, counts, quotes, minApprovals, groupId, groupSender);
    }
  } else {
    await send(`❌ *${senderName || senderPhone}* rejeitou ${fmtSeq(seq)} — ${counts.rejections.length}/${minApprovals} rejeições`);

    if (counts.rejections.length >= minApprovals) {
      db.zeldaUpdateStatus(ini.id, 'negado');
      const names = counts.rejections.map(v => v.voter_name || v.voter_phone).join(', ');
      await send(
        `🚫 *Atividade ${fmtSeq(seq)} NEGADA!*\n\n` +
        `A atividade *${ini.title}* foi negada com ${counts.rejections.length} votos contrários.\n` +
        `Votaram contra: ${names}`
      );
    }
  }
}

async function resolveApproval(ini, counts, quotes, minApprovals, groupId, groupSender) {
  // Descobre o orçamento vencedor (mais votado entre as aprovações)
  const quoteTally = {};
  counts.approvals.forEach(v => {
    if (v.quote_seq) quoteTally[v.quote_seq] = (quoteTally[v.quote_seq] || 0) + 1;
  });
  let winnerQuote = null;
  if (Object.keys(quoteTally).length > 0) {
    const winnerSeq = Object.entries(quoteTally).sort((a, b) => b[1] - a[1])[0][0];
    winnerQuote = quotes.find(q => q.seq === Number(winnerSeq));
  }

  db.zeldaUpdateStatus(ini.id, 'aprovado', {
    supplier: winnerQuote ? winnerQuote.supplier : (ini.supplier || null),
    approved_value: winnerQuote ? winnerQuote.value : null
  });

  const names = counts.approvals.map(v => v.voter_name || v.voter_phone).join(', ');
  let msg =
    `🎉 *Atividade ${fmtSeq(ini.seq)} APROVADA!*\n\n` +
    `*${ini.title}* foi aprovada por ${counts.approvals.length} conselheiros.\n` +
    `Aprovadores: ${names}\n`;
  if (winnerQuote) {
    msg += `\n🏢 *Fornecedor escolhido:* ${winnerQuote.supplier}\n💵 *Valor:* ${fmtValue(winnerQuote.value)}`;
  }
  db.zeldaLogMessage(groupId, 'zelda', 'Zelda', 'out', msg);
  await groupSender(msg);
}

async function triggerApprovalRequest(ini, groupId, groupSender, minApprovals) {
  const quotes = db.zeldaGetQuotes(ini.id);
  let msg =
    `🔔 *Atividade ${fmtSeq(ini.seq)} aguarda aprovação do conselho!*\n\n` +
    `📌 *${ini.title}*\n` +
    `👤 Responsável: ${ini.responsible}\n` +
    `📅 Prazo: ${ini.due_date || '—'}\n`;

  if (quotes.length > 0) {
    msg += `\n💰 *Orçamentos:*\n`;
    quotes.forEach(q => { msg += `  ${q.seq}️⃣ ${q.supplier} — ${fmtValue(q.value)}\n`; });
  }

  msg +=
    `\nSão necessários *${minApprovals} votos* para aprovar ou negar.\n\n` +
    `✅ Para aprovar: *Zelda, aprovar ${ini.seq}*\n` +
    (quotes.length > 1 ? `   (informe o orçamento: *Zelda, aprovar ${ini.seq} orçamento N*)\n` : '') +
    `❌ Para rejeitar: *Zelda, rejeitar ${ini.seq}*`;

  db.zeldaLogMessage(groupId, 'zelda', 'Zelda', 'out', msg);
  await groupSender(msg);
}

// ── Fluxo interativo de cadastro de atividade ─────────────────────────────────
async function cmdStartNewInitiative(sessionKey, senderPhone, senderName, send) {
  sessions.set(sessionKey, { step: 'title', senderPhone, senderName });
  await send(`*Nova Atividade* 📋\n\nInforme o nome da atividade:`);
}

async function cmdStartAddQuote(sessionKey, senderPhone, senderName, seq, send, isSindico) {
  const ini = db.zeldaGetBySeq(seq);
  if (!ini) { await send(`Atividade ${fmtSeq(seq)} não encontrada.`); return; }

  if (TERMINAL_STATUS.includes(ini.status)) {
    await send(`⛔ A atividade ${fmtSeq(seq)} está encerrada/negada e não aceita novos orçamentos.`);
    return;
  }

  const existing = db.zeldaGetQuotes(ini.id);
  if (existing.length >= 3) {
    await send(`⚠️ A atividade ${fmtSeq(seq)} já possui 3 orçamentos (máximo permitido).`);
    return;
  }

  const cleanSender = senderPhone.replace(/\D/g, '');
  const cleanCreator = (ini.created_by || '').replace(/\D/g, '');
  if (!isSindico && cleanSender !== cleanCreator) {
    await send(`⛔ Apenas o responsável pela atividade ou o síndico podem adicionar orçamentos.`);
    return;
  }

  sessions.set(sessionKey, { step: 'quote_supplier', initiativeId: ini.id, seq: ini.seq, senderPhone, senderName });
  await send(`*Orçamento ${existing.length + 1} para ${fmtSeq(seq)}*\n\nInforme o nome do fornecedor:`);
}

// ── Processador de sessões interativas ───────────────────────────────────────
async function handleSessionStep(sessionKey, senderPhone, senderName, rawInput, normInput, send, groupId, minApprovals, isSindico) {
  const session = sessions.get(sessionKey);

  // Cancelamento a qualquer momento
  if (normInput === 'cancelar' || normInput === 'cancel') {
    sessions.delete(sessionKey);
    await send(`Operação cancelada.`);
    return;
  }

  switch (session.step) {
    // ── Cadastro de atividade ────────────────────────────────────────────────
    case 'title':
      session.title = rawInput;
      session.step = 'responsible';
      sessions.set(sessionKey, session);
      await send(`Responsável pela atividade:`);
      break;

    case 'responsible':
      session.responsible = rawInput;
      session.step = 'due_date';
      sessions.set(sessionKey, session);
      await send(`Data prevista (DD/MM/AAAA ou deixe em branco — responda *-* para pular):`);
      break;

    case 'due_date': {
      session.dueDate = (normInput === '-' || normInput === '') ? null : rawInput;
      sessions.delete(sessionKey);
      const ini = db.zeldaCreateInitiative(session.title, session.responsible, session.dueDate, senderPhone);
      const card = buildInitiativeCard(ini, [], []);
      await send(`✅ *Atividade criada com sucesso!*\n\n${card}`);
      break;
    }

    // ── Cadastro de orçamento ────────────────────────────────────────────────
    case 'quote_supplier':
      session.supplier = rawInput;
      session.step = 'quote_value';
      sessions.set(sessionKey, session);
      await send(`Valor do orçamento (ex: 1500,00):`);
      break;

    case 'quote_value': {
      const valueStr = rawInput.replace(/[R$\s]/g, '').replace(',', '.');
      const value = parseFloat(valueStr);
      if (isNaN(value) || value <= 0) {
        await send(`Valor inválido. Informe o valor numérico (ex: 1500,00):`);
        return;
      }
      sessions.delete(sessionKey);
      const seqAdded = db.zeldaAddQuote(session.initiativeId, session.supplier, value, senderPhone);
      const quotes = db.zeldaGetQuotes(session.initiativeId);
      await send(`✅ Orçamento ${seqAdded} adicionado à atividade ${fmtSeq(session.seq)}!\n   ${session.supplier} — ${fmtValue(value)}\n\n_Total de orçamentos: ${quotes.length}/3_`);
      break;
    }

    // ── Escolha de orçamento durante voto ────────────────────────────────────
    case 'choose_quote': {
      const chosen = parseInt(normInput, 10);
      const quotes = db.zeldaGetQuotes(session.initiativeId);
      const valid = quotes.find(q => q.seq === chosen);
      if (!valid) {
        await send(`Opção inválida. Responda com 1, 2 ou 3.`);
        return;
      }
      sessions.delete(sessionKey);
      db.zeldaAddVote(session.initiativeId, senderPhone, session.senderName || senderPhone, 'approve', chosen);
      const counts = db.zeldaCountVotes(session.initiativeId);
      await send(`✅ *${session.senderName || senderPhone}* aprovou ${fmtSeq(session.seq)} — orçamento ${chosen} (${valid.supplier} · ${fmtValue(valid.value)}) — ${counts.approvals.length}/${minApprovals} aprovações`);
      if (counts.approvals.length >= minApprovals) {
        const ini = db.zeldaGetById(session.initiativeId);
        await resolveApproval(ini, counts, quotes, minApprovals, groupId, async (m) => {
          db.zeldaLogMessage(groupId, 'zelda', 'Zelda', 'out', m);
          await send(m);
        });
      }
      break;
    }

    default:
      sessions.delete(sessionKey);
      await send(`Sessão expirada. Por favor, repita o comando.`);
  }
}

module.exports = { processGroupMessage, triggerApprovalRequest };

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

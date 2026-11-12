/**
 * serenaFollowup.js — Motor de follow-up diurno, checagem de recepção e lembretes de agendamento
 */
const db = require('./db');
const serenaCore = require('./serenaCore');
const holidays = require('./holidays');
const schedule = require('./scheduleManager');

let followupTimer = null;

/**
 * Intervalos de follow-up aprovados:
 * 1ª tentativa: +1 hora
 * 2ª tentativa: +3 horas
 * 3ª tentativa: +24 horas (1 dia)
 * 4ª tentativa: +48 horas (2 dias)
 * 5ª tentativa: +72 horas (3 dias) - encerramento amigável
 *
 * Janela diurna permitida: 08:00 às 20:00 (Segunda a Sábado).
 * Domingos e horários noturnos adiam para o próximo dia útil às 08:30.
 */

function isWithinFollowupWindow(now = new Date()) {
  const dow = now.getDay();
  if (dow === 0) return false; // Domingo não envia follow-up ativo

  const hour = now.getHours();
  const min = now.getMinutes();
  const totalMin = hour * 60 + min;

  // Seg–Sex: 08:30 (510 min) às 19:00 (1140 min) | Sáb: 08:30 (510 min) às 12:30 (750 min)
  if (dow === 6) {
    if (totalMin < 510 || totalMin >= 750) return false;
  } else {
    if (totalMin < 510 || totalMin >= 1140) return false;
  }

  const todayStr = holidays.formatDate(now);
  const holCheck = holidays.isHoliday(todayStr);
  if (holCheck.holiday) return false;

  return true;
}

function computeNextFollowupDate(now, minutesToAdd) {
  let target = new Date(now.getTime() + minutesToAdd * 60 * 1000);

  // Ajusta caso caia fora do horário comercial ético
  const dow = target.getDay();
  if (dow === 0) {
    target.setDate(target.getDate() + 1);
    target.setHours(8, 35, 0, 0);
  } else if (dow === 6 && (target.getHours() > 12 || (target.getHours() === 12 && target.getMinutes() > 30))) {
    target.setDate(target.getDate() + 2); // pula para segunda
    target.setHours(8, 35, 0, 0);
  } else if (target.getHours() >= 19) {
    target.setDate(target.getDate() + 1);
    target.setHours(8, 35, 0, 0);
  } else if (target.getHours() < 8 || (target.getHours() === 8 && target.getMinutes() < 30)) {
    target.setHours(8, 35, 0, 0);
  }

  return target.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Constrói a mensagem altamente personalizada conforme a etapa de parada (lead.state / stage),
 * contagem de respostas (0 respostas vs abandono de funil) e procedimento de interesse.
 */
function buildSmartRescueMessage(lead) {
  const config = db.getConfig();
  const clinicName = config.clinic_name || 'OdontoCompany Bela Vista Osasco';
  const name = lead.name ? lead.name.split(' ')[0] : '';
  const greet = name ? `Oi, ${name}!` : `Olá!`;
  const replyCount = Number(lead.reply_count) || 0;
  const origin = lead.origin || 'whatsapp';
  const isUrgent = Boolean(lead.is_urgent);
  const interest = lead.procedure_interest || '';
  const step = lead.followup_count || 0;

  // ───────────────────────────────────────────────────────────────────────────
  // CASO 1: LEADS QUE NÃO RESPONDERAM (0 Respostas)
  // ───────────────────────────────────────────────────────────────────────────
  if (replyCount === 0) {
    // 1B: Outbound de Disparo em Massa / Campanha
    if (origin === 'bulk_campaign') {
      return (
        `${greet} Tudo bem? Passando rapidinho porque ainda restaram 2 horários esta semana para o Check-up Digital 5D + RX Panorâmico sem custo aqui na ${clinicName}.\n\n` +
        `Quer que eu te mande os horários livres? (Digite *1* para Sim ou *PARE* para não receber mais).`
      );
    }

    // 1A: Inbound que chamou e travou no Acolhimento (não disse o nome)
    if (step === 0) {
      // Toque 1 (T + 30m): Micro-Compromisso de 1 Dígito
      return (
        `${greet} Caso esteja na correria, pode só digitar o número do que você procura aqui na ${clinicName}:\n\n` +
        `1️⃣ Dor / Urgência\n2️⃣ Implante\n3️⃣ Aparelho\n4️⃣ Estética / Limpeza\n\n(Basta responder 1, 2, 3 ou 4)`
      );
    } else {
      // Toque 2 (D + 1): Encerramento elegante / Breakup
      return (
        `${greet} Tudo bem? Vou encerrar seu pré-atendimento por aqui para não te incomodar 😊 Se ainda quiser agendar sua Avaliação Gratuita (com RX Panorâmico + Escaneamento 5D) na ${clinicName}, é só me mandar um "Oi" quando puder!`
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CASO 2: LEADS QUE RESPONDERAM (replyCount >= 1), MAS TRAVARAM ANTES DE AGENDAR
  // ───────────────────────────────────────────────────────────────────────────

  // Toque Final de Reativação (Breakup D+7 / Tentativa final)
  if (step >= 4) {
    return (
      `Oi, ${name || 'tudo bem'}? Passando apenas para dar baixa na sua pasta de pré-agendamento aqui da ${clinicName} e liberar a reserva do Escaneamento 5D 😊 Caso sua rotina tenha folgado essa semana e ainda faça sentido avaliar seu sorriso, me dê um "Oi" que olho os novos horários para você!`
    );
  }

  // 4A: Urgência / Dor aguda
  if (isUrgent || lead.state === 'EMERGENCIA') {
    return (
      `${greet} Como você mencionou incômodo/dor, ainda estou segurando aquele encaixe prioritário para não correr risco de outro paciente ocupar. Posso confirmar no seu nome? (Digite *1* para Sim ou me diga o melhor horário)`
    );
  }

  // 2: Contorno de Preço (Parou após explicação CFO)
  if (lead.state === 'CONTORNO_PRECO' || lead.state === 'AGUARDANDO_NOME') {
    return (
      `${greet} Só para te deixar 100% tranquilo(a): nossa avaliação de 30 min na ${clinicName} (com RX Panorâmico + Escaneamento 5D) é totalmente gratuita e sem nenhum compromisso de fechar na hora. Você sai com seu diagnóstico digital completo e formas de parcelamento para decidir com calma em casa. Quer que eu veja os horários disponíveis esta semana? 😊`
    );
  }

  // 3: Filtro Convênio (Tem outro plano)
  if (lead.payment_modality === 'Convênio' || lead.state === 'FILTRO_CONVENIO') {
    return (
      `${greet} Muitos pacientes que têm outros planos fazem primeiro nossa Avaliação Gratuita aqui na ${clinicName} porque já inclui o RX Panorâmico + Escaneamento 5D na hora (sem guias ou burocracia de autorização). Quer conhecer sem custo esta semana?`
    );
  }

  // 5: Pediu Reagendar no Lembrete e não cravou novo horário
  if (lead.state === 'TENTANDO_REAGENDAR_CANCELAMENTO' || lead.state === 'REAGENDAMENTO_PENDENTE') {
    const freshSlots = schedule.suggestNextAvailableSlots('qualquer', 2, 1);
    const slotA = freshSlots[0] ? `${schedule.formatDateBr(freshSlots[0].date)} às ${freshSlots[0].time}` : 'amanhã pela manhã';
    const slotB = freshSlots[1] ? `${schedule.formatDateBr(freshSlots[1].date)} às ${freshSlots[1].time}` : 'à tarde';
    return (
      `${greet} Já liberei seu horário anterior certinho. Para você não perder sua vaga da semana com o especialista, prefere remarcar para ${slotA} ou ${slotB}?`
    );
  }

  // 4B: Oferta de Horários Eletivo (Viu opções e sumiu)
  if (lead.state === 'SELECIONANDO_OPCAO' || lead.state === 'CONFIRMANDO_AGENDAMENTO') {
    return (
      `${greet} Vi que aqueles horários podem não ter batido com sua rotina 😊 Você prefere um horário no final da tarde (até 17h30) ou no Sábado de manhã (08h às 12h30) aqui na ${clinicName}?`
    );
  }

  // 1: Triagem (Viu opções 1-5 e sumiu)
  return (
    `${greet} Para facilitar: você busca resolver algum incômodo/dor rápida agora ou planejar um tratamento com calma? 😊`
  );
}

/**
 * Monta a mensagem de lembrete de acordo com o tipo.
 * Todos os tipos incluem a frase "Estamos prontos para lhe atender".
 */
function buildReminderMessage(nome, formattedDate, dayName, time, type) {
  const saudacao = nome ? `Olá, *${nome}*! 😊` : `Olá! 😊`;
  const slot = `*${formattedDate} (${dayName}) às ${time}*`;

  if (type === '1d') {
    return (
      `${saudacao}\n\n` +
      `Passando para lembrar que amanhã é o dia da sua *avaliação gratuita* na OdontoCompany Bela Vista Osasco! 🦷\n\n` +
      `📅 *Data:* ${slot}\n` +
      `⏱ *Duração:* aproximadamente 30 minutos\n` +
      `📍 *Local:* Av. Antônio Carlos Costa, 991 — Bela Vista, Osasco/SP\n\n` +
      `✨ Estamos prontos para lhe atender com todo carinho!\n\n` +
      `Por favor, confirme sua presença:\n` +
      `*1* – ✅ Confirmo\n` +
      `*2* – 🔄 Quero Reagendar\n` +
      `*3* – ❌ Preciso Cancelar`
    );
  }

  if (type === '3h') {
    return (
      `${saudacao}\n\n` +
      `Sua *avaliação gratuita* está chegando — em aproximadamente *3 horas*! 🦷\n\n` +
      `📅 *Data:* ${slot}\n` +
      `⏱ *Duração:* aproximadamente 30 minutos\n` +
      `📍 *Local:* Av. Antônio Carlos Costa, 991 — Bela Vista, Osasco/SP\n\n` +
      `✨ Estamos prontos para lhe atender!\n\n` +
      `*1* – ✅ Confirmo presença\n` +
      `*2* – 🔄 Quero Reagendar\n` +
      `*3* – ❌ Preciso Cancelar`
    );
  }

  // 1h
  return (
    `${saudacao}\n\n` +
    `Sua consulta começa em aproximadamente *1 hora*! Estamos te esperando. 🦷🌟\n\n` +
    `📅 *Data:* ${slot}\n` +
    `📍 *Local:* Av. Antônio Carlos Costa, 991 — Bela Vista, Osasco/SP\n\n` +
    `✨ *Estamos prontos para lhe atender!*\n\n` +
    `Caso precise cancelar ou reagendar de última hora:\n` +
    `*1* – ✅ Já estou a caminho!\n` +
    `*2* – 🔄 Preciso Reagendar\n` +
    `*3* – ❌ Não consigo comparecer`
  );
}

/**
 * Executa o ciclo de lembretes de agendamento (1 dia antes, 3 horas antes e 1 hora antes)
 */
async function runReminderCycle(whatsappSender) {
  try {
    const appointments = db.getAppointmentsForReminder();
    for (const appt of appointments) {
      const reminderType = appt.reminder_type; // definido pela query em db.js
      const formattedDate = schedule.formatDateBr(appt.date);
      const dayName = schedule.getDayNameBr(appt.date);
      const nome = appt.lead_name || '';

      const msg = buildReminderMessage(nome, formattedDate, dayName, appt.time, reminderType);

      db.markReminderSent(appt.id, reminderType);
      db.upsertSerenaLead(appt.lead_phone, {
        state: 'AGUARDANDO_CONFIRMACAO_LEMBRETE',
        state_data: { reminderAppointmentId: appt.id, reminderDate: appt.date, reminderTime: appt.time }
      });

      await serenaCore.sendSerenaReply(appt.lead_phone, msg, whatsappSender);
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (err) {
    console.error('[Serena Followup] Erro no ciclo de lembretes:', err.message);
  }
}

/**
 * Executa a rodada de checagem de Follow-up e Verificação da Recepção
 */
async function runFollowupCycle(whatsappSender) {
  const config = db.getConfig();
  if (config.serena_enabled === '0') return;
  if (config.serena_followup_enabled === '0') return;

  const now = new Date();

  // ── 0. Lembretes de agendamento ─────────────────────────────────────────────
  if (isWithinFollowupWindow(now)) {
    await runReminderCycle(whatsappSender);
  }

  // ── 1. Checagem de 2h da Recepção ("Conseguiu falar com a recepção?") ───────
  try {
    const awaitingReception = db.getLeadsAwaitingReceptionCheck();
    for (const lead of awaitingReception) {
      // Pergunta após 2 horas se conseguiu contato
      const checkMessage = `Olá ${lead.name ? lead.name + ', ' : ''}aqui é a Serena novamente! Gostaria de saber se você conseguiu falar com a nossa recepção?\n\n1️⃣ Sim, já conversei\n2️⃣ Ainda não`;
      db.upsertSerenaLead(lead.phone, {
        state: 'VERIFICACAO_RECEPCAO_AGUARDANDO',
        reception_check_done: 1
      });
      await serenaCore.sendSerenaReply(lead.phone, checkMessage, whatsappSender);
    }
  } catch (err) {
    console.error('[Serena Followup] Erro na checagem de recepção:', err.message);
  }

  // ── 2. Follow-ups por Inatividade ──────────────────────────────────────────
  if (!isWithinFollowupWindow(now)) {
    return; // Fora da janela diurna
  }

  try {
    const leadsForFollowup = db.getSerenaLeadsForFollowup();
    for (const lead of leadsForFollowup) {
      // Trava Anti-Ban: maxConsecutiveBotMessages = 2
      // Se a Serena já mandou 2 mensagens no vácuo sem nenhuma resposta do contato, trava o envio
      const unanswered = lead.unanswered_bot_count || 0;
      if (unanswered >= 2) {
        db.upsertSerenaLead(lead.phone, {
          next_followup_at: null,
          state: 'HIBERNANDO_30D'
        });
        continue;
      }

      const replyCount = Number(lead.reply_count) || 0;
      const origin = lead.origin || 'whatsapp';
      const isUrgent = Boolean(lead.is_urgent);
      const currentStep = lead.followup_count || 0;

      // Regras de limite e cadência por perfil:
      // Caso 1B: Outbound campanha fria (0 respostas) -> Máximo 1 toque de reaquecimento (D+3)
      if (replyCount === 0 && origin === 'bulk_campaign' && currentStep >= 1) {
        db.upsertSerenaLead(lead.phone, { next_followup_at: null, state: 'HIBERNANDO_30D' });
        continue;
      }

      // Caso 1A: Inbound acolhimento (0 respostas) -> Máximo 2 toques (T+30m e D+1), depois hiberna
      if (replyCount === 0 && currentStep >= 2) {
        db.upsertSerenaLead(lead.phone, { next_followup_at: null, state: 'HIBERNANDO_30D' });
        continue;
      }

      // Caso 2: Respondeu (replyCount >= 1) -> Até 5 toques inteligentes (T+45m/2h, D+1, D+2, D+7)
      if (currentStep >= 5) {
        db.upsertSerenaLead(lead.phone, { next_followup_at: null, state: 'CONCLUIDO' });
        continue;
      }

      const message = buildSmartRescueMessage(lead);
      const nextStep = currentStep + 1;

      // Calcula próximo intervalo em minutos
      let nextDelayMinutes = 1440; // 24h padrão
      if (replyCount === 0) {
        nextDelayMinutes = 1440; // D+1 para breakup
      } else if (isUrgent) {
        nextDelayMinutes = 1440;
      } else if (currentStep === 0) {
        nextDelayMinutes = 120; // 2h
      } else if (currentStep === 1) {
        nextDelayMinutes = 1440; // D+1
      } else if (currentStep === 2) {
        nextDelayMinutes = 2880; // D+2
      } else {
        nextDelayMinutes = 10080; // D+7
      }

      const isFinal = (replyCount === 0 && origin === 'bulk_campaign') ||
                      (replyCount === 0 && nextStep >= 2) ||
                      (nextStep >= 5);

      const nextFollowup = isFinal ? null : computeNextFollowupDate(now, nextDelayMinutes);
      const nextState = isFinal ? (replyCount === 0 ? 'HIBERNANDO_30D' : 'CONCLUIDO') : lead.state;

      db.upsertSerenaLead(lead.phone, {
        followup_count: nextStep,
        next_followup_at: nextFollowup,
        state: nextState,
        last_followup_step: `toque_${nextStep}`
      });

      await serenaCore.sendSerenaReply(lead.phone, message, whatsappSender, true);

      // Pequena pausa entre envios de follow-up para segurança
      await new Promise(r => setTimeout(r, 4000));
    }
  } catch (err) {
    console.error('[Serena Followup] Erro no ciclo de follow-up:', err.message);
  }
}

function startFollowupService(whatsappSender) {
  if (followupTimer) clearInterval(followupTimer);
  // Checa a cada 2 minutos
  followupTimer = setInterval(() => {
    runFollowupCycle(whatsappSender);
  }, 2 * 60 * 1000);
}

function stopFollowupService() {
  if (followupTimer) {
    clearInterval(followupTimer);
    followupTimer = null;
  }
}

module.exports = {
  startFollowupService,
  stopFollowupService,
  runFollowupCycle,
  computeNextFollowupDate
};

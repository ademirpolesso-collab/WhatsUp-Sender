/**
 * scheduleManager.js — Gerenciamento de horários, regras de negócio e validação da clínica
 * OdontoCompany Bela Vista Osasco
 */
const db = require('./db');
const holidays = require('./holidays');

/**
 * Horários de funcionamento:
 * Segunda a Sexta: 08:00 às 18:00 (último agendamento 18:00, clínica fecha 18:30)
 * Sábados: 08:00 às 13:00 (último agendamento 13:00, clínica fecha 13:30)
 * Domingos e Feriados: Fechado
 */

function parseTimeMinutes(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  return h * 60 + m;
}

function formatMinutesTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getDayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getDay(); // 0: Dom, 1: Seg, ..., 6: Sab
}

/**
 * Retorna os slots teóricos de 30 em 30 min para um determinado dia da semana
 */
function getSlotsForDay(dayOfWeek) {
  if (dayOfWeek === 0) return []; // Domingo fechado

  const slots = [];
  const startMin = 8 * 60; // 08:00
  let endMin = 18 * 60;   // 18:00 (Seg-Sex)
  if (dayOfWeek === 6) {
    endMin = 13 * 60;     // 13:00 (Sábado)
  }

  for (let min = startMin; min <= endMin; min += 30) {
    slots.push(formatMinutesTime(min));
  }
  return slots;
}

/**
 * Valida se uma data é elegível para agendamento
 * Antecedência mínima: 1 hora
 * Horizonte máximo: 15 dias
 */
function validateDateForBooking(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const targetDate = new Date(y, m - 1, d);
  const now = new Date();
  const todayStr = holidays.formatDate(now);

  const diffTime = targetDate.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return { valid: false, reason: 'Data no passado' };
  }
  if (diffDays > 15) {
    return { valid: false, reason: 'Agendamentos são permitidos no máximo para os próximos 15 dias' };
  }

  const dow = targetDate.getDay();
  if (dow === 0) {
    return { valid: false, reason: 'A clínica não abre aos domingos' };
  }

  const holCheck = holidays.isHoliday(dateStr);
  if (holCheck.holiday) {
    return { valid: false, reason: `Feriado (${holCheck.description})` };
  }

  return { valid: true };
}

/**
 * Valida se um horário e data específicos estão dentro do horário de funcionamento
 * Seg-Sex: 08:00 às 18:00
 * Sábados: 08:00 às 13:00
 */
function validateSlotForBooking(dateStr, timeStr) {
  const dateVal = validateDateForBooking(dateStr);
  if (!dateVal.valid) return dateVal;

  const dow = getDayOfWeek(dateStr);
  const slots = getSlotsForDay(dow);
  if (!slots.includes(timeStr)) {
    if (dow === 6) {
      return { valid: false, reason: `Aos sábados o atendimento é das 08:00 às 13:00. O horário ${timeStr} está fora do horário.` };
    }
    return { valid: false, reason: `Nosso horário de atendimento é de segunda a sexta das 08:00 às 18:00. O horário ${timeStr} está fora do expediente.` };
  }

  const now = new Date();
  const todayStr = holidays.formatDate(now);
  if (dateStr === todayStr) {
    const slotMin = parseTimeMinutes(timeStr);
    const currentMin = now.getHours() * 60 + now.getMinutes();
    if (slotMin < currentMin + 60) {
      return { valid: false, reason: 'Agendamentos para hoje necessitam de pelo menos 1 hora de antecedência.' };
    }
  }

  return { valid: true };
}

/**
 * Retorna horários disponíveis para uma data específica
 * Filtrando por período ('manha', 'tarde', 'qualquer') se solicitado
 */
function getAvailableSlots(dateStr, period = 'qualquer') {
  const dateValidation = validateDateForBooking(dateStr);
  if (!dateValidation.valid) {
    return [];
  }

  const dow = getDayOfWeek(dateStr);
  const allSlots = getSlotsForDay(dow);
  const bookedAppointments = db.getAppointmentsByDate(dateStr);
  const bookedTimes = new Set(bookedAppointments.map(a => a.time));

  const now = new Date();
  const todayStr = holidays.formatDate(now);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return allSlots.filter(slot => {
    // 1. Checa se o horário já está ocupado
    if (bookedTimes.has(slot)) return false;

    // 2. Se for hoje, checa antecedência mínima de 1 hora (60 min)
    if (dateStr === todayStr) {
      const slotMin = parseTimeMinutes(slot);
      if (slotMin < currentMinutes + 60) return false;
    }

    // 3. Filtro por período
    const slotMin = parseTimeMinutes(slot);
    if (period === 'manha' && slotMin >= 12 * 60) return false;
    if (period === 'tarde' && slotMin <= 12 * 60) return false; // 12:00 é almoço — tarde começa 12:30+

    return true;
  });
}

/**
 * Retorna horários disponíveis a partir de um horário mínimo (ex: "depois das 14h")
 * Combina com filtro de período se necessário
 */
function getAvailableSlotsAfter(dateStr, minTimeStr) {
  const dateValidation = validateDateForBooking(dateStr);
  if (!dateValidation.valid) return [];

  const dow = getDayOfWeek(dateStr);
  const allSlots = getSlotsForDay(dow);
  const bookedAppointments = db.getAppointmentsByDate(dateStr);
  const bookedTimes = new Set(bookedAppointments.map(a => a.time));

  const now = new Date();
  const todayStr = holidays.formatDate(now);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const minMin = parseTimeMinutes(minTimeStr);

  return allSlots.filter(slot => {
    if (bookedTimes.has(slot)) return false;
    if (dateStr === todayStr) {
      const slotMin = parseTimeMinutes(slot);
      if (slotMin < currentMinutes + 60) return false;
    }
    const slotMin = parseTimeMinutes(slot);
    if (slotMin < minMin) return false;

    return true;
  });
}

/**
 * Sugere dias com disponibilidade em um horário-alvo específico (ex: "às 10h").
 * Percorre os próximos dias e retorna aqueles em que aquele slot está livre.
 * @param {string} targetTime - "HH:MM"
 * @param {number} count      - máximo de dias a retornar
 */
function suggestDaysWithTimeSlot(targetTime, count = 3) {
  const suggestions = [];
  const now = new Date();

  for (let i = 0; i <= 15 && suggestions.length < count; i++) {
    const candidateDate = new Date();
    candidateDate.setDate(now.getDate() + i);
    const dateStr = holidays.formatDate(candidateDate);

    const validation = validateDateForBooking(dateStr);
    if (!validation.valid) continue;

    const available = getAvailableSlots(dateStr, 'qualquer');
    if (available.includes(targetTime)) {
      suggestions.push({ date: dateStr, time: targetTime });
    }
  }

  return suggestions;
}

/**
 * Sugere slots nos próximos dias respeitando um horário mínimo (ex: "depois das 14h").
 * Diferente de suggestNextAvailableSlots: mantém o filtro de minTime em vez de usar período.
 * @param {string} minTimeStr  - "HH:MM" — só mostra slots >= este horário
 * @param {number} count       - quantidade de sugestões
 * @param {number} startFromDay - 0 = a partir de hoje, 1 = a partir de amanhã
 */
function suggestNextAvailableSlotsAfter(minTimeStr, count = 3, startFromDay = 0) {
  const suggestions = [];
  const now = new Date();

  for (let i = startFromDay; i <= 15 && suggestions.length < count; i++) {
    const candidateDate = new Date();
    candidateDate.setDate(now.getDate() + i);
    const dateStr = holidays.formatDate(candidateDate);

    const available = getAvailableSlotsAfter(dateStr, minTimeStr);
    if (available.length > 0) {
      const daySlots = available.slice(0, 2);
      for (const slot of daySlots) {
        suggestions.push({ date: dateStr, time: slot });
        if (suggestions.length >= count) break;
      }
    }
  }

  return suggestions;
}

/**
 * Sugere as melhores opções de agendamento para os próximos dias
 * @param {string} preferredPeriod - 'manha' | 'tarde' | 'qualquer'
 * @param {number} count           - quantidade de sugestões
 * @param {number} startFromDay    - 0 = a partir de hoje (padrão), 1 = a partir de amanhã
 */
function suggestNextAvailableSlots(preferredPeriod = 'qualquer', count = 3, startFromDay = 0) {
  const suggestions = [];
  const now = new Date();

  for (let i = startFromDay; i <= 15 && suggestions.length < count; i++) {
    const candidateDate = new Date();
    candidateDate.setDate(now.getDate() + i);
    const dateStr = holidays.formatDate(candidateDate);

    const available = getAvailableSlots(dateStr, preferredPeriod);
    if (available.length > 0) {
      // Pega até 2 opções por dia para diversificar
      const daySlots = available.slice(0, 2);
      for (const slot of daySlots) {
        suggestions.push({ date: dateStr, time: slot });
        if (suggestions.length >= count) break;
      }
    }
  }

  return suggestions;
}

function formatDateBr(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function getDayNameBr(dateStr) {
  const dow = getDayOfWeek(dateStr);
  const names = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  return names[dow] || '';
}

module.exports = {
  validateDateForBooking,
  validateSlotForBooking,
  getAvailableSlots,
  getAvailableSlotsAfter,
  suggestNextAvailableSlots,
  suggestNextAvailableSlotsAfter,
  suggestDaysWithTimeSlot,
  formatDateBr,
  getDayNameBr,
  parseTimeMinutes,
  formatMinutesTime
};

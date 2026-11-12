/**
 * holidays.js — Cálculo de feriados nacionais brasileiros e gerenciamento de feriados locais
 */
const db = require('./db');

/**
 * Calcula a data da Páscoa pelo algoritmo de Meeus/Jones/Butcher
 */
function getEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Retorna os feriados nacionais oficiais para o ano especificado (fixos + móveis)
 */
function getNationalHolidays(year) {
  const easter = getEaster(year);
  const carnavalSeg = addDays(easter, -48);
  const carnavalTer = addDays(easter, -47);
  const sextaFeiraSanta = addDays(easter, -2);
  const corpusChristi = addDays(easter, 60);

  const holidays = [
    { date: `${year}-01-01`, description: 'Confraternização Universal (Ano Novo)' },
    { date: formatDate(carnavalSeg), description: 'Carnaval (Segunda-feira)' },
    { date: formatDate(carnavalTer), description: 'Carnaval (Terça-feira)' },
    { date: formatDate(sextaFeiraSanta), description: 'Sexta-feira Santa / Paixão de Cristo' },
    { date: formatDate(easter), description: 'Páscoa' },
    { date: `${year}-04-21`, description: 'Tiradentes' },
    { date: `${year}-05-01`, description: 'Dia do Trabalho' },
    { date: formatDate(corpusChristi), description: 'Corpus Christi' },
    { date: `${year}-09-07`, description: 'Independência do Brasil' },
    { date: `${year}-10-12`, description: 'Nossa Senhora Aparecida' },
    { date: `${year}-11-02`, description: 'Finados' },
    { date: `${year}-11-15`, description: 'Proclamação da República' },
    { date: `${year}-11-20`, description: 'Dia da Consciência Negra' },
    { date: `${year}-12-25`, description: 'Natal' },
  ];

  return holidays;
}

/**
 * Verifica se uma data (YYYY-MM-DD ou objeto Date) é feriado (nacional ou cadastrado no banco)
 */
function isHoliday(dateInput) {
  let dateStr = '';
  let year = 0;
  if (typeof dateInput === 'string') {
    dateStr = dateInput.substring(0, 10);
    year = parseInt(dateStr.substring(0, 4), 10);
  } else if (dateInput instanceof Date) {
    dateStr = formatDate(dateInput);
    year = dateInput.getFullYear();
  }

  if (!dateStr || isNaN(year)) return { holiday: false };

  // 1. Checa feriados nacionais calculados
  const national = getNationalHolidays(year);
  const foundNat = national.find(h => h.date === dateStr);
  if (foundNat) return { holiday: true, description: foundNat.description, type: 'nacional' };

  // 2. Checa feriados manuais do banco
  try {
    const custom = db.getCustomHolidays();
    const foundCustom = custom.find(h => h.date === dateStr);
    if (foundCustom) return { holiday: true, description: foundCustom.description, type: 'manual' };
  } catch (_) {}

  return { holiday: false };
}

module.exports = {
  getNationalHolidays,
  isHoliday,
  formatDate
};

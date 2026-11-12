/**
 * sim-scenarios.js — Catálogo de cenários de teste regressivo da Serena.
 *
 * Cada cenário define:
 *   id        — identificador único (ex: 'S01')
 *   title     — descrição legível do caso
 *   turns     — mensagens enviadas pelo paciente, em ordem
 *   pushName  — (opcional) nome fornecido pelo WhatsApp
 *   expect    — assertions automáticas sobre o resultado final:
 *     finalState    — estado do lead após o último turno
 *     notState      — estado que NÃO pode ocorrer (regressão crítica)
 *     lastContains  — substrings que a ÚLTIMA resposta deve conter (todas)
 *     lastNotContains — substrings que a última resposta NÃO pode conter (nenhuma)
 *     anyContains   — substrings que devem aparecer em QUALQUER resposta
 *     anyNotContains — substrings que NÃO podem aparecer em nenhuma resposta
 *     slotsAllAfter — todos os horários sugeridos devem ser >= este "HH:MM"
 *     slotsAllBefore — todos os horários sugeridos devem ser < este "HH:MM"
 */
module.exports = [
  // ── Cenários originais (S01–S17) ─────────────────────────────────────────────
  {
    id: 'S01',
    title: 'Primeiro contato já com intenção (reativo) — pergunta nome',
    turns: ['Oi, queria marcar uma avaliação'],
    expect: {
      finalState: 'AGUARDANDO_NOME',
      lastContains: ['chamado'],
    },
  },
  {
    id: 'S02',
    title: 'Fluxo feliz: nome → menu triagem → clareamento → pede horário',
    turns: ['Oi', 'Maria', '4', 'Sim, quero agendar'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      anyContains: ['1️⃣', '2️⃣', '3️⃣'],  // menu de triagem apareceu
      lastNotContains: ['OPT_OUT', 'recepção'],
    },
  },
  {
    id: 'S03',
    title: 'Fora do escopo (dermatologista) — recusa + convite odontológico',
    turns: ['Olá', 'Carlos', '5', 'vocês atendem dermatologista?'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      notState: 'SELECIONANDO_OPCAO',
      lastContains: ['clínica odontológica', 'saúde bucal'],
      lastNotContains: ['08:', '09:', '10:'],
    },
  },
  {
    id: 'S04',
    title: 'Falso positivo: "primeira vez" não é fora de escopo',
    turns: ['Olá', 'Ana', '5', 'É minha primeira vez, quero uma avaliação'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      lastNotContains: ['clínica odontológica', 'saúde bucal'],
    },
  },
  {
    id: 'S05',
    title: 'Horário fora do expediente com data (sábado 15h) — oferece sábado de manhã',
    turns: ['Oi', 'Paulo', '5', 'Quero agendar', 'sábado às 15h'],
    expect: {
      finalState: 'SELECIONANDO_OPCAO',
      lastContains: ['Sábado', '08:'],
      slotsAllBefore: '13:30',
    },
  },
  {
    id: 'S06',
    title: 'Horário fora do expediente: noite — informa horário e sugere opções',
    turns: ['Oi', 'Paulo', '5', 'Quero agendar', 'só consigo à noite'],
    expect: {
      finalState: 'SELECIONANDO_OPCAO',
      lastContains: ['noite'],
      lastNotContains: ['21:', '22:', '20:'],
    },
  },
  {
    id: 'S07',
    title: 'Domingo — rejeita e sugere próximos dias úteis',
    turns: ['Oi', 'Paulo', '5', 'Quero agendar', 'domingo de manhã'],
    expect: {
      finalState: 'SELECIONANDO_OPCAO',
      lastContains: ['Domingo'],
      lastNotContains: ['Domingo) às'],
    },
  },
  {
    id: 'S08',
    title: '"não quero ir de manhã" NÃO pode virar opt-out',
    turns: ['Oi', 'Lia', '5', 'Quero agendar', 'não quero ir de manhã, prefiro à tarde'],
    expect: {
      notState: 'OPT_OUT',
      finalState: 'SELECIONANDO_OPCAO',
      anyNotContains: ['Não enviaremos mais mensagens'],
    },
  },
  {
    id: 'S09',
    title: '"dentista" NÃO pode transferir à recepção',
    turns: ['Oi', 'Rui', 'Preciso ir ao dentista, faz tempo que não vou'],
    expect: {
      notState: 'TRANSFERIDO_RECEPCAO',
      anyNotContains: ['passar seu contato'],
    },
  },
  {
    id: 'S10',
    title: '"não, pode ser outro dia" na confirmação — deve RECUSAR, não confirmar',
    turns: ['Oi', 'Rui', '5', 'Quero agendar', 'quarta às 10h', 'não, pode ser outro dia'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      notState: 'AGENDADO',
      lastContains: ['outro dia', 'prefere'],
      lastNotContains: ['Agendamento Confirmado', 'avaliação gratuita está marcada'],
    },
  },
  {
    id: 'S11',
    title: 'PushName fornecido — Serena exibe menu de triagem sem perguntar nome',
    pushName: 'Joana Silva',
    turns: ['Bom dia, vocês fazem implante?'],
    expect: {
      anyContains: ['implante', 'avaliação'],
      anyNotContains: ['qual é o seu nome', 'como você prefere ser chamado'],
    },
  },
  {
    id: 'S12',
    title: 'Preço — nunca informa valor, direciona para avaliação',
    turns: ['Olá', 'Bia', 'Quanto custa um aparelho?'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      lastContains: ['avaliação'],
      lastNotContains: ['R$', 'reais', 'mensalidade'],
    },
  },
  {
    id: 'S13',
    title: 'Dor (urgência) — dispara EMERGENCIA e notifica recepção',
    turns: ['Olá, estou com muita dor de dente'],
    expect: {
      finalState: 'EMERGENCIA',
      anyContains: ['urgência'],
    },
  },
  {
    id: 'S14',
    title: '"Sim" genérico após convite fora do escopo — agenda normalmente',
    turns: ['Olá', 'Carlos', '5', 'Vocês fazem cirurgia plástica?', 'sim, tenho interesse'],
    expect: {
      finalState: 'SELECIONANDO_OPCAO',
      lastContains: ['opções'],
    },
  },
  {
    id: 'S15',
    title: '"a partir das 14h" desde SELECIONANDO_OPCAO — fallback deve sugerir slots ≥14h',
    turns: ['Oi', 'Luiza', '4', 'Sim', 'a partir das 14h'],
    expect: {
      finalState: 'SELECIONANDO_OPCAO',
      slotsAllAfter: '13:30',
      lastNotContains: ['12:30', '13:00', '12:00'],
    },
  },
  {
    id: 'S16',
    title: '"às 10h algum dia" — lista dias com slot 10:00',
    turns: ['Oi', 'Luiza', '5', 'tem horário algum dia às 10h'],
    expect: {
      finalState: 'SELECIONANDO_OPCAO',
      lastContains: ['10:00'],
      lastNotContains: ['08:00', '08:30'],
    },
  },
  {
    id: 'S17',
    title: '"qual dia tem às 10h da manhã" — lista dias com slot 10:00',
    turns: ['Oi', 'Luiza', '5', 'qual dia tem disponibilidade às 10h da manhã'],
    expect: {
      finalState: 'SELECIONANDO_OPCAO',
      lastContains: ['10:00'],
      lastNotContains: ['08:00', '08:30'],
    },
  },

  // ── Novos cenários: menu de triagem e trilhas diferenciadas (S18–S26) ─────────
  {
    id: 'S18',
    title: 'Menu de triagem — opção 1 (urgência) → dispara EMERGENCIA',
    turns: ['Oi', 'Pedro', '1'],
    expect: {
      finalState: 'EMERGENCIA',
      anyContains: ['Dor de dente não pode esperar', 'urgência'],
    },
  },
  {
    id: 'S19',
    title: 'Menu de triagem — opção 2 (implante) → Rota B com construção de valor',
    turns: ['Oi', 'João', '2'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      lastContains: ['implantodontia', '3D'],
      lastNotContains: ['clínica odontológica não atende'],
    },
  },
  {
    id: 'S20',
    title: 'Menu de triagem — opção 3 (aparelho) → Rota B',
    turns: ['Oi', 'Clara', '3'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      lastContains: ['alinhadores invisíveis'],
    },
  },
  {
    id: 'S21',
    title: 'Menu de triagem — opção 4 (estética) → Rota B',
    turns: ['Oi', 'Fernanda', '4'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      lastContains: ['tecnologia digital', 'sorriso'],
    },
  },
  {
    id: 'S22',
    title: 'Menu de triagem — opção 5 (geral) → Rota B',
    turns: ['Oi', 'Marcos', '5'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      lastContains: ['avaliação completa'],
    },
  },
  {
    id: 'S23',
    title: 'Menu de triagem — escolha por palavra-chave "implante"',
    turns: ['Oi', 'Roberto', 'quero fazer um implante'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      anyContains: ['implantodontia', '3D'],
    },
  },
  {
    id: 'S24',
    title: 'Preço de implante — script CFO com pergunta de engajamento',
    turns: ['Olá', 'Ana', 'quanto custa um implante?'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      lastContains: ['Conselho Federal de Odontologia', 'planejamento 3D'],
      lastNotContains: ['R$', 'reais', 'mensalidade'],
    },
  },
  {
    id: 'S25',
    title: 'Preço de aparelho — script CFO com pergunta de engajamento',
    turns: ['Olá', 'Bruno', 'quanto custa o aparelho invisível?'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      lastContains: ['alinhadores invisíveis', 'ortodontista'],
      lastNotContains: ['R$', 'reais'],
    },
  },
  {
    id: 'S26',
    title: 'Preço de limpeza — script CFO com pergunta de engajamento',
    turns: ['Olá', 'Carla', 'qual o valor da limpeza?'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      lastContains: ['profilaxia', 'ultrassom'],
      lastNotContains: ['R$', 'reais'],
    },
  },
  {
    id: 'S27',
    title: 'Pergunta de endereço em AGUARDANDO_PREFERENCIA — deve informar endereço e mapa sem oferecer horários',
    turns: ['Olá', 'Renato', 'onde fica a clínica? qual o endereço?'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      lastContains: ['Antônio Carlos Costa', 'maps.google.com', 'Bela Vista'],
      lastNotContains: ['Horários disponíveis', 'Opção 1', 'Opção 2'],
    },
  },
  {
    id: 'S28',
    title: 'Pergunta de endereço em TRIAGEM — deve informar endereço e mapa',
    turns: ['Olá', 'Patrícia', 'qual a localização de vocês?'],
    expect: {
      finalState: 'AGUARDANDO_PREFERENCIA',
      lastContains: ['Antônio Carlos Costa', 'maps.google.com'],
      lastNotContains: ['Horários disponíveis'],
    },
  },
  {
    id: 'S29',
    title: 'Recusa "Agora não" após "Gostaria de agendar?" — agradece e encerra sem oferecer horários',
    turns: ['Olá', 'Ademir', '4', 'Clareamento', 'Agora não'],
    expect: {
      finalState: 'CONCLUIDO',
      lastContains: ['Agradeço'],
      lastNotContains: ['1️⃣', 'Qual dessas opções'],
    },
  },
  {
    id: 'S30',
    title: 'Recusa "Nenhuma" após horários oferecidos — agradece e encerra sem reofertar',
    turns: ['Olá', 'Ademir', '4', 'Clareamento', 'Sim', 'Nenhuma'],
    expect: {
      finalState: 'CONCLUIDO',
      lastContains: ['Agradeço'],
      lastNotContains: ['1️⃣', 'Girei nossa agenda'],
    },
  },
];

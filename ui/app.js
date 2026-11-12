/**
 * app.js — lógica do renderer (frontend)
 * OdontoCompany Bela Vista Osasco — Serena Bot & WhatsApp Sender
 */

// ── Utilitários ────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  $('toast-area').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function statusBadge(s) {
  const map = {
    pending:   ['Pendente',   'badge-pending'],
    sent:      ['Enviado',    'badge-sent'],
    delivered: ['Entregue',   'badge-delivered'],
    read:      ['Lido',       'badge-read'],
    replied:   ['Respondido', 'badge-replied'],
    error:     ['Erro',       'badge-error'],
  };
  const [label, cls] = map[s] || [s, 'badge-pending'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('pt-BR');
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function askConfirm(text) {
  return new Promise(resolve => {
    const modal = $('confirm-modal');
    $('confirm-text').textContent = text;
    modal.classList.add('open');
    const done = (result) => {
      modal.classList.remove('open');
      $('btn-confirm-ok').onclick     = null;
      $('btn-confirm-cancel').onclick = null;
      resolve(result);
    };
    $('btn-confirm-ok').onclick     = () => done(true);
    $('btn-confirm-cancel').onclick = () => done(false);
  });
}

// ── Navegação ──────────────────────────────────────────────────────────────
const pages = document.querySelectorAll('.page');
const navLinks = document.querySelectorAll('nav a[data-page]');

function showPage(id) {
  pages.forEach(p => p.classList.toggle('active', p.id === 'page-' + id));
  navLinks.forEach(a => a.classList.toggle('active', a.dataset.page === id));
  if (id === 'serena')       loadSerenaDashboard();
  if (id === 'appointments') loadAppointments();
  if (id === 'dashboard')    loadDashboard();
  if (id === 'contacts')     loadContacts();
  if (id === 'messages')     loadMessages();
  if (id === 'assignments')  loadAssignments();
  if (id === 'send')         loadSendPage();
  if (id === 'status')       loadStatus();
  if (id === 'settings')     loadSettings();
  if (id === 'zelda')        zeldaRefresh();
}

navLinks.forEach(a => a.addEventListener('click', e => {
  e.preventDefault();
  showPage(a.dataset.page);
}));

// ── WhatsApp status ────────────────────────────────────────────────────────
let waConnected = false;

const SVG_LINK  = `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`;
const SVG_CHECK = `<polyline points="20 6 9 17 4 12"/>`;
const SVG_SPIN  = `<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>`;

function updateWaBadge(status, info) {
  const badge     = $('wa-badge');
  const badgeText = $('wa-badge-text');
  const btn       = $('btn-connect');
  const btnIcon   = $('btn-connect-icon');
  const btnText   = $('btn-connect-text');

  if (badge) badge.className = '';

  if (status === 'ready') {
    if (badge) badge.classList.add('connected');
    if (badgeText) badgeText.textContent = 'Conectado';
    waConnected = true;
    if (btn) {
      btn.className = 'btn btn-connected';
      btnIcon.innerHTML = SVG_CHECK;
      btnText.textContent = 'Conectado';
      btn.onclick = null;
    }
  } else if (status === 'qr' || status === 'authenticated') {
    if (badge) badge.classList.add('qr');
    if (badgeText) badgeText.textContent = 'Aguardando QR';
    waConnected = false;
    if (btn) {
      btn.className = 'btn btn-waiting';
      btnIcon.innerHTML = SVG_SPIN;
      btnText.textContent = 'Aguardando...';
      btn.onclick = null;
    }
  } else if (status === 'error') {
    if (badge) badge.classList.add('error');
    if (badgeText) badgeText.textContent = 'Erro';
    waConnected = false;
    if (btn) {
      btn.className = 'btn btn-primary';
      btnIcon.innerHTML = SVG_LINK;
      btnText.textContent = 'Conectar WhatsApp';
      btn.onclick = connectWa;
    }
  } else {
    if (badgeText) badgeText.textContent = 'Desconectado';
    waConnected = false;
    if (btn) {
      btn.className = 'btn btn-primary';
      btnIcon.innerHTML = SVG_LINK;
      btnText.textContent = 'Conectar WhatsApp';
      btn.onclick = connectWa;
    }
  }

  // Sincroniza aba Configurações
  const cfgBadge = $('cfg-wa-status-badge');
  const cfgInfo  = $('cfg-wa-connected-info');
  const btnDis   = $('btn-disconnect-cfg');
  const btnCon   = $('btn-connect-cfg');
  if (!cfgBadge) return;

  if (status === 'ready') {
    cfgBadge.className   = 'badge badge-delivered';
    cfgBadge.textContent = 'Conectado';
    const phone = info && info.phone ? info.phone : '';
    const name  = info && info.name  ? info.name  : '';
    cfgInfo.textContent  = phone ? (name ? `${name} · ${phone}` : phone) : '';
    if (btnDis) btnDis.disabled = false;
    if (btnCon) btnCon.disabled = true;
  } else if (status === 'qr' || status === 'authenticated') {
    cfgBadge.className   = 'badge badge-pending';
    cfgBadge.textContent = 'Aguardando QR';
    cfgInfo.textContent  = '';
    if (btnDis) btnDis.disabled = true;
    if (btnCon) btnCon.disabled = true;
  } else if (status === 'error') {
    cfgBadge.className   = 'badge badge-error';
    cfgBadge.textContent = 'Erro';
    cfgInfo.textContent  = '';
    if (btnDis) btnDis.disabled = true;
    if (btnCon) btnCon.disabled = false;
  } else {
    cfgBadge.className   = 'badge badge-pending';
    cfgBadge.textContent = 'Desconectado';
    cfgInfo.textContent  = '';
    if (btnDis) btnDis.disabled = true;
    if (btnCon) btnCon.disabled = false;
  }
}

if (window.api) {
  window.api.onWaStatus(status => {
    updateWaBadge(status);
    zeldaUpdateStatusBadge(status);
  });
  window.api.onWaQr(dataUrl => {
    $('qr-img-wrap').innerHTML = `<img src="${dataUrl}" style="max-width:240px;border-radius:8px" alt="QR Code" />`;
    $('qr-hint').textContent = 'Escaneie o QR Code com o WhatsApp';
    $('qr-modal').classList.add('open');
  });
  window.api.onWaReady(({ phone, name } = {}) => {
    $('qr-modal').classList.remove('open');
    updateWaBadge('ready', { phone, name });
    zeldaUpdateStatusBadge('ready');
    toast('WhatsApp conectado com sucesso!', 'success');
  });
  window.api.onWaError(msg => toast('Erro WhatsApp: ' + msg, 'error'));
  window.api.onWaAck(({ wamId, status }) => {
    const rows = document.querySelectorAll(`[data-wamid="${wamId}"]`);
    rows.forEach(r => r.innerHTML = statusBadge(status));
  });
  window.api.onWaReply(({ from }) => {
    toast(`Interação recebida de ${from}`, 'info');
    if ($('page-serena') && $('page-serena').classList.contains('active')) loadSerenaDashboard();
    if ($('page-status') && $('page-status').classList.contains('active')) loadStatus();
  });
}

if ($('btn-connect')) $('btn-connect').onclick = connectWa;
if ($('btn-connect-cfg')) $('btn-connect-cfg').addEventListener('click', connectWa);
if ($('btn-disconnect-cfg')) $('btn-disconnect-cfg').addEventListener('click', async () => {
  await window.api.waDisconnect();
  updateWaBadge('disconnected');
  toast('Desconectado', 'info');
});
if ($('btn-clear-session-cfg')) $('btn-clear-session-cfg').addEventListener('click', async () => {
  if (!(await askConfirm('Isso vai apagar a sessão salva e forçar um novo QR Code.\nContinuar?'))) return;
  toast('Limpando sessão... aguarde.', 'info');
  $('qr-img-wrap').innerHTML = '<div class="spinner"></div>';
  $('qr-hint').textContent = 'Aguardando novo QR Code...';
  $('qr-modal').classList.add('open');
  await window.api.waClearSession();
});
if ($('btn-close-qr')) $('btn-close-qr').addEventListener('click', () => $('qr-modal').classList.remove('open'));

async function connectWa() {
  if (waConnected) return;
  if ($('qr-img-wrap')) $('qr-img-wrap').innerHTML = '<div class="spinner"></div>';
  if ($('qr-hint')) $('qr-hint').textContent = 'Iniciando WhatsApp...';
  if ($('qr-modal')) $('qr-modal').classList.add('open');
  await window.api.waInit();
  setTimeout(async () => {
    const status = await window.api.waStatus();
    if (status === 'ready' && $('qr-modal')) {
      $('qr-modal').classList.remove('open');
    }
  }, 8000);
}

// ── Serena Dashboard ────────────────────────────────────────────────────────
let serenaDateFilter = '';

async function loadSerenaDashboard() {
  const dateInput = $('serena-date-filter');
  serenaDateFilter = dateInput ? dateInput.value : '';

  const [metrics, activities, cfg, waStatus] = await Promise.all([
    window.api.serenaDashboard(serenaDateFilter || null),
    window.api.serenaRecentActivity(100),
    window.api.configGet(),
    window.api.waStatus()
  ]);

  // Status da Serena
  const isEnabled = cfg.serena_enabled !== '0';
  const isConnected = waStatus === 'ready';

  const badge = $('serena-status-badge');
  const badgeText = $('serena-status-text');
  const cardStatus = $('serena-card-status');

  if (!isEnabled) {
    if (badge) {
      badge.className = 'badge badge-pending';
      if (badgeText) badgeText.textContent = 'Pausada';
      const dot = badge.querySelector('.dot');
      if (dot) dot.style.background = '#f59e0b';
    }
    if (cardStatus) {
      cardStatus.textContent = 'Pausada';
      cardStatus.style.color = '#f59e0b';
    }
  } else if (!isConnected) {
    if (badge) {
      badge.className = 'badge badge-error';
      if (badgeText) badgeText.textContent = 'WhatsApp Desconectado';
      const dot = badge.querySelector('.dot');
      if (dot) dot.style.background = '#ef4444';
    }
    if (cardStatus) {
      cardStatus.textContent = 'Aguardando WA';
      cardStatus.style.color = '#ef4444';
    }
  } else {
    if (badge) {
      badge.className = 'badge badge-delivered';
      if (badgeText) badgeText.textContent = 'Ativa (24x7)';
      const dot = badge.querySelector('.dot');
      if (dot) dot.style.background = '#10b981';
    }
    if (cardStatus) {
      cardStatus.textContent = 'Ativa (24x7)';
      cardStatus.style.color = '#10b981';
    }
  }

  const isFiltered = !!serenaDateFilter;
  const statsData = isFiltered ? metrics.filtered : metrics.accumulated;

  if ($('serena-stat-leads')) $('serena-stat-leads').textContent         = statsData.leads;
  if ($('serena-stat-responded')) $('serena-stat-responded').textContent    = statsData.responded;
  if ($('serena-stat-appointments')) $('serena-stat-appointments').textContent = statsData.appointments;

  const periodLabel = $('serena-stats-period-label');
  if (periodLabel) {
    if (isFiltered) {
      const [y, m, d] = serenaDateFilter.split('-');
      periodLabel.textContent = `📅 Exibindo dados de ${d}/${m}/${y}`;
      periodLabel.style.color = '#3b82f6';
    } else {
      periodLabel.textContent = 'Total acumulado (todos os períodos)';
      periodLabel.style.color = 'var(--muted)';
    }
  }

  const feed = $('serena-feed-container');
  if (!feed) return;
  if (!activities || activities.length === 0) {
    feed.innerHTML = '<div style="text-align:center;color:var(--muted);padding:30px">Nenhum evento registrado ainda.</div>';
    return;
  }

  feed.innerHTML = activities.map(act => {
    const isSerena = act.sender === 'serena';
    const isLead = act.sender === 'lead';
    const badgeColor = isSerena ? '#3b82f6' : '#10b981';
    const senderLabel = isSerena ? 'Serena (Atendente)' : (act.lead_name ? `${act.lead_name} (${act.lead_phone})` : act.lead_phone);

    return `
      <div style="padding:10px 14px;border-radius:8px;background:var(--bg-input);border:1px solid var(--border);display:flex;flex-direction:column;gap:4px">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-weight:600;color:${badgeColor}">
              ${escHtml(senderLabel)}
            </span>
            ${isLead ? `<button class="btn btn-outline btn-sm" style="padding:1px 6px;font-size:10px" onclick="resetSingleLead('${act.lead_phone}')" title="Reiniciar conversa deste contato">Reiniciar</button>` : ''}
          </div>
          <span style="color:var(--muted)">${fmtDate(act.created_at)}</span>
        </div>
        <div style="font-size:13px;color:var(--text);white-space:pre-wrap;line-height:1.4">
          ${escHtml(act.message)}
        </div>
      </div>
    `;
  }).join('');
}

if ($('btn-serena-refresh')) $('btn-serena-refresh').addEventListener('click', loadSerenaDashboard);
if ($('serena-date-filter')) $('serena-date-filter').addEventListener('change', loadSerenaDashboard);
if ($('btn-serena-clear-date')) $('btn-serena-clear-date').addEventListener('click', () => {
  $('serena-date-filter').value = '';
  loadSerenaDashboard();
});

if ($('btn-serena-reset-all')) $('btn-serena-reset-all').addEventListener('click', async () => {
  if (!(await askConfirm('Deseja reiniciar todas as conversas e zerar os estados da Serena?\nAssim os contatos começarão um diálogo novo com a apresentação inicial.'))) return;
  await window.api.serenaResetAll();
  loadSerenaDashboard();
  toast('Conversas e estados da Serena reiniciados com sucesso!');
});

window.resetSingleLead = async (phone) => {
  if (!(await askConfirm(`Reiniciar a conversa para o contato ${phone}?`))) return;
  await window.api.serenaResetLead(phone);
  loadSerenaDashboard();
  toast(`Contato ${phone} reiniciado!`);
};

setInterval(() => {
  if ($('page-serena') && $('page-serena').classList.contains('active')) {
    loadSerenaDashboard();
  }
}, 10000);

// ── Agendamentos ───────────────────────────────────────────────────────────
async function loadAppointments() {
  const appts = await window.api.serenaAppointments();
  const tbody = $('appointments-tbody');

  if (!tbody) return;
  if (!appts || appts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">Nenhum agendamento realizado até o momento.</td></tr>';
    return;
  }

  tbody.innerHTML = appts.map(a => `
    <tr>
      <td><strong>${escHtml(a.date.split('-').reverse().join('/'))}</strong></td>
      <td><span class="badge badge-sent">${escHtml(a.time)}</span></td>
      <td>${escHtml(a.lead_name)}</td>
      <td>${escHtml(a.lead_phone)}</td>
      <td><span class="badge ${a.status === 'confirmed' ? 'badge-delivered' : 'badge-error'}">${escHtml(a.status === 'confirmed' ? 'Confirmado' : a.status)}</span></td>
      <td style="font-size:12px;color:var(--muted)">${escHtml(a.notes || 'Avaliação OdontoCompany')}</td>
      <td style="font-size:12px;color:var(--muted)">${fmtDate(a.created_at)}</td>
    </tr>
  `).join('');
}

if ($('btn-refresh-appointments')) $('btn-refresh-appointments').addEventListener('click', loadAppointments);

// ── Dashboard de Campanhas / Disparos ──────────────────────────────────────
async function loadDashboard() {
  const [contacts, messages, logs] = await Promise.all([
    window.api.contactsList(),
    window.api.messagesList(),
    window.api.logList()
  ]);
  if ($('stat-contacts')) $('stat-contacts').textContent   = contacts.length;
  if ($('stat-messages')) $('stat-messages').textContent   = messages.length;
  if ($('stat-sent')) $('stat-sent').textContent       = logs.filter(l => l.status === 'sent').length;
  if ($('stat-delivered')) $('stat-delivered').textContent = logs.filter(l => l.status === 'delivered').length;
  if ($('stat-read')) $('stat-read').textContent       = logs.filter(l => l.status === 'read').length;
  if ($('stat-replied')) $('stat-replied').textContent    = logs.filter(l => l.status === 'replied').length;

  const tbody = $('dash-log-body');
  if (!tbody) return;
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px">Nenhum envio ainda</td></tr>';
    return;
  }
  tbody.innerHTML = logs.slice(0, 8).map(l => `
    <tr>
      <td>${escHtml(l.contact_name)}</td>
      <td>${escHtml(l.message_title)}</td>
      <td>${statusBadge(l.status)}</td>
      <td>${fmtDate(l.sent_at)}</td>
    </tr>
  `).join('');
}

// ── Contatos ───────────────────────────────────────────────────────────────
let allContacts = [];

async function loadContacts() {
  allContacts = await window.api.contactsList();
  renderContacts(allContacts);
}

function renderContacts(list) {
  if ($('contact-count')) $('contact-count').textContent = list.length;
  const tbody = $('contacts-tbody');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px">Nenhum contato cadastrado</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(c => `
    <tr>
      <td><input type="checkbox" class="chk-contact" data-id="${c.id}" /></td>
      <td>${escHtml(c.name)}</td>
      <td>${escHtml(c.phone)}</td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="deleteContact(${c.id})">Excluir</button>
      </td>
    </tr>
  `).join('');

  document.querySelectorAll('.chk-contact').forEach(chk => {
    chk.addEventListener('change', updateDeleteSelectedBtn);
  });
  updateDeleteSelectedBtn();
}

function updateDeleteSelectedBtn() {
  const any = document.querySelectorAll('.chk-contact:checked').length > 0;
  if ($('btn-delete-selected')) $('btn-delete-selected').disabled = !any;
}

if ($('chk-all-contacts')) $('chk-all-contacts').addEventListener('change', e => {
  document.querySelectorAll('.chk-contact').forEach(chk => chk.checked = e.target.checked);
  updateDeleteSelectedBtn();
});

if ($('contact-search')) $('contact-search').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  renderContacts(allContacts.filter(c => c.name.toLowerCase().includes(q) || c.phone.includes(q)));
});

if ($('btn-new-contact')) $('btn-new-contact').addEventListener('click', () => {
  $('contact-form-card').style.display = 'block';
  $('contact-name').focus();
});
if ($('btn-cancel-contact')) $('btn-cancel-contact').addEventListener('click', () => {
  $('contact-form-card').style.display = 'none';
  $('contact-name').value = '';
  $('contact-phone').value = '';
});
if ($('btn-save-contact')) $('btn-save-contact').addEventListener('click', async () => {
  const name  = $('contact-name').value.trim();
  const phone = $('contact-phone').value.trim();
  if (!name || !phone) return toast('Preencha nome e telefone', 'error');
  await window.api.contactsAdd(name, phone);
  $('contact-form-card').style.display = 'none';
  $('contact-name').value = '';
  $('contact-phone').value = '';
  loadContacts();
  toast('Contato salvo!');
});

async function deleteContact(id) {
  if (!(await askConfirm('Deseja excluir este contato?'))) return;
  await window.api.contactsDelete(id);
  loadContacts();
  toast('Contato excluído');
}

if ($('btn-delete-selected')) $('btn-delete-selected').addEventListener('click', async () => {
  const ids = Array.from(document.querySelectorAll('.chk-contact:checked')).map(c => Number(c.dataset.id));
  if (!ids.length) return;
  if (!(await askConfirm(`Excluir ${ids.length} contato(s) selecionado(s)?`))) return;
  await window.api.contactsDeleteMany(ids);
  $('chk-all-contacts').checked = false;
  loadContacts();
  toast(`${ids.length} contato(s) excluído(s)`);
});

if ($('btn-delete-all')) $('btn-delete-all').addEventListener('click', async () => {
  if (!(await askConfirm('ATENÇÃO: Isso excluirá TODOS os contatos, associações e logs.\nContinuar?'))) return;
  await window.api.contactsDeleteAll();
  loadContacts();
  toast('Todos os contatos foram excluídos');
});

if ($('btn-import-csv')) $('btn-import-csv').addEventListener('click', async () => {
  const res = await window.api.contactsImportCsv();
  if (res.ok) {
    loadContacts();
    toast(`${res.count} contatos importados do CSV!`);
  }
});

// ── Mensagens / Templates ──────────────────────────────────────────────────
let editingMsgId = null;

async function loadMessages() {
  const list = await window.api.messagesList();
  const container = $('messages-list');
  if (!container) return;
  if (!list.length) {
    container.innerHTML = '<p style="color:var(--muted);font-size:13px">Nenhum template cadastrado</p>';
    return;
  }
  container.innerHTML = list.map(m => `
    <div class="msg-card">
      <div class="msg-card-header">
        <span class="msg-card-title">${escHtml(m.title)}</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-outline btn-sm" onclick="editMessage(${m.id}, ${JSON.stringify(escHtml(m.title))}, ${JSON.stringify(escHtml(m.body))})">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="deleteMessage(${m.id})">Excluir</button>
        </div>
      </div>
      <div class="msg-card-body">${escHtml(m.body)}</div>
    </div>
  `).join('');
}

if ($('btn-new-message')) $('btn-new-message').addEventListener('click', () => {
  editingMsgId = null;
  $('msg-form-title').textContent = 'Nova mensagem';
  $('msg-title').value = '';
  $('msg-body').value = '';
  $('msg-form-card').style.display = 'block';
  $('msg-title').focus();
});
if ($('btn-cancel-message')) $('btn-cancel-message').addEventListener('click', () => {
  $('msg-form-card').style.display = 'none';
  editingMsgId = null;
});
if ($('btn-save-message')) $('btn-save-message').addEventListener('click', async () => {
  const title = $('msg-title').value.trim();
  const body  = $('msg-body').value.trim();
  if (!title || !body) return toast('Preencha título e texto', 'error');
  if (editingMsgId) {
    await window.api.messagesUpdate(editingMsgId, title, body);
    toast('Mensagem atualizada!');
  } else {
    await window.api.messagesAdd(title, body);
    toast('Mensagem criada!');
  }
  $('msg-form-card').style.display = 'none';
  editingMsgId = null;
  loadMessages();
});

function editMessage(id, title, body) {
  editingMsgId = id;
  $('msg-form-title').textContent = 'Editar mensagem';
  $('msg-title').value = title;
  $('msg-body').value = body;
  $('msg-form-card').style.display = 'block';
  $('msg-title').focus();
}

async function deleteMessage(id) {
  if (!(await askConfirm('Excluir este template de mensagem?'))) return;
  await window.api.messagesDelete(id);
  loadMessages();
  toast('Template excluído');
}

// ── Associações ────────────────────────────────────────────────────────────
async function loadAssignments() {
  const [assigns, contacts, msgs] = await Promise.all([
    window.api.assignmentsList(),
    window.api.contactsList(),
    window.api.messagesList()
  ]);

  if ($('assign-count')) $('assign-count').textContent = assigns.length;

  const selContact = $('assign-contact');
  if (selContact) {
    selContact.innerHTML = '<option value="">Selecione...</option>' +
      contacts.map(c => `<option value="${c.id}">${escHtml(c.name)} (${c.phone})</option>`).join('');
  }

  const selMsg = $('assign-message');
  if (selMsg) {
    selMsg.innerHTML = '<option value="">Selecione...</option>' +
      msgs.map(m => `<option value="${m.id}">${escHtml(m.title)}</option>`).join('');
  }

  const tbody = $('assignments-tbody');
  if (!tbody) return;
  if (!assigns.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px">Nenhuma associação cadastrada</td></tr>';
    return;
  }
  tbody.innerHTML = assigns.map(a => `
    <tr>
      <td>${escHtml(a.name)}</td>
      <td>${escHtml(a.phone)}</td>
      <td><span class="badge badge-sent">${escHtml(a.title)}</span></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteAssignment(${a.id})">Excluir</button></td>
    </tr>
  `).join('');
}

if ($('btn-new-assignment')) $('btn-new-assignment').addEventListener('click', () => {
  $('assign-form-card').style.display = 'block';
  $('assign-bulk-card').style.display = 'none';
});
if ($('btn-cancel-assignment')) $('btn-cancel-assignment').addEventListener('click', () => {
  $('assign-form-card').style.display = 'none';
});
if ($('btn-save-assignment')) $('btn-save-assignment').addEventListener('click', async () => {
  const cId = $('assign-contact').value;
  const mId = $('assign-message').value;
  if (!cId || !mId) return toast('Selecione contato e mensagem', 'error');
  await window.api.assignmentsSet(Number(cId), Number(mId));
  $('assign-form-card').style.display = 'none';
  loadAssignments();
  toast('Associação salva!');
});

async function deleteAssignment(id) {
  if (!(await askConfirm('Excluir esta associação?'))) return;
  await window.api.assignmentsDelete(id);
  loadAssignments();
  toast('Associação excluída');
}

if ($('btn-bulk-assignment')) $('btn-bulk-assignment').addEventListener('click', async () => {
  const [contacts, msgs] = await Promise.all([
    window.api.contactsList(),
    window.api.messagesList()
  ]);

  const selBulkMsg = $('assign-bulk-message');
  if (selBulkMsg) {
    selBulkMsg.innerHTML = '<option value="">Selecione...</option>' +
      msgs.map(m => `<option value="${m.id}">${escHtml(m.title)}</option>`).join('');
  }

  const bulkTbody = $('bulk-contacts-tbody');
  if (bulkTbody) {
    bulkTbody.innerHTML = contacts.map(c => `
      <tr>
        <td><input type="checkbox" class="chk-bulk-contact" data-id="${c.id}" /></td>
        <td>${escHtml(c.name)}</td>
        <td>${escHtml(c.phone)}</td>
      </tr>
    `).join('');
  }

  $('assign-bulk-card').style.display = 'block';
  $('assign-form-card').style.display = 'none';
});

if ($('btn-cancel-bulk')) $('btn-cancel-bulk').addEventListener('click', () => {
  $('assign-bulk-card').style.display = 'none';
});

if ($('btn-bulk-selected')) $('btn-bulk-selected').addEventListener('click', async () => {
  const mId = $('assign-bulk-message').value;
  if (!mId) return toast('Selecione a mensagem', 'error');
  const ids = Array.from(document.querySelectorAll('.chk-bulk-contact:checked')).map(c => Number(c.dataset.id));
  if (!ids.length) return toast('Nenhum contato selecionado', 'error');

  for (const cId of ids) {
    await window.api.assignmentsSet(cId, Number(mId));
  }
  $('assign-bulk-card').style.display = 'none';
  loadAssignments();
  toast(`${ids.length} associação(ões) criada(s)!`);
});

if ($('btn-bulk-all')) $('btn-bulk-all').addEventListener('click', async () => {
  const mId = $('assign-bulk-message').value;
  if (!mId) return toast('Selecione a mensagem', 'error');
  const contacts = await window.api.contactsList();
  if (!contacts.length) return toast('Nenhum contato cadastrado', 'error');

  for (const c of contacts) {
    await window.api.assignmentsSet(c.id, Number(mId));
  }
  $('assign-bulk-card').style.display = 'none';
  loadAssignments();
  toast(`Todas as ${contacts.length} associações foram criadas!`);
});

// ── Disparar ───────────────────────────────────────────────────────────────
let queuedJobs = [];

async function loadSendPage() {
  const cfg = await window.api.configGet();
  if (cfg.block_size && $('send-block-size'))  $('send-block-size').value = cfg.block_size;
  if (cfg.block_delay && $('send-delay')) $('send-delay').value      = cfg.block_delay;
  renderJobs();
}

if ($('btn-load-assignments')) $('btn-load-assignments').addEventListener('click', async () => {
  const [assigns, msgs] = await Promise.all([
    window.api.assignmentsList(),
    window.api.messagesList()
  ]);
  const msgMap = Object.fromEntries(msgs.map(m => [m.id, m]));
  queuedJobs = assigns.map(a => ({
    contactId:   a.contact_id,
    contactName: a.name,
    phone:        a.phone,
    messageId:   a.message_id,
    messageTitle:a.title,
    body:        (msgMap[a.message_id] || {}).body || ''
  }));
  renderJobs();
  toast(`${queuedJobs.length} destinatários carregados`);
});

if ($('btn-clear-jobs')) $('btn-clear-jobs').addEventListener('click', () => {
  queuedJobs = [];
  renderJobs();
});

function renderJobs() {
  if ($('jobs-count')) $('jobs-count').textContent = queuedJobs.length;
  const tbody = $('jobs-tbody');
  if (!tbody) return;
  if (!queuedJobs.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:16px">Nenhum job na fila</td></tr>';
    return;
  }
  tbody.innerHTML = queuedJobs.map((j, i) => `
    <tr>
      <td><input type="checkbox" checked class="chk-job" data-idx="${i}" /></td>
      <td>${escHtml(j.contactName)}</td>
      <td>${escHtml(j.phone)}</td>
      <td><span class="badge badge-sent">${escHtml(j.messageTitle)}</span></td>
      <td><button class="btn btn-danger btn-sm" onclick="removeJob(${i})">✕</button></td>
    </tr>
  `).join('');
}

function removeJob(i) {
  queuedJobs.splice(i, 1);
  renderJobs();
}

if ($('btn-start-send')) $('btn-start-send').addEventListener('click', async () => {
  if (!waConnected) return toast('Conecte o WhatsApp antes de iniciar o disparo', 'error');
  const checked = Array.from(document.querySelectorAll('.chk-job:checked')).map(c => queuedJobs[Number(c.dataset.idx)]);
  if (!checked.length) return toast('Selecione pelo menos um contato na fila', 'error');

  const bs = $('send-block-size').value;
  const ds = $('send-delay').value;

  $('btn-start-send').disabled = true;
  $('btn-cancel-send').disabled = false;
  $('send-progress').style.width = '0%';
  $('send-log-live').innerHTML = '';

  await window.api.schedulerRun(checked, bs, ds);
});

if ($('btn-cancel-send')) $('btn-cancel-send').addEventListener('click', async () => {
  await window.api.schedulerCancel();
  toast('Cancelando disparo...', 'info');
});

if (window.api) {
  window.api.onSchedulerProgress(({ current, total, contactName, phone }) => {
    const pct = Math.round((current / total) * 100);
    if ($('send-progress')) $('send-progress').style.width = pct + '%';
    if ($('send-status-text')) $('send-status-text').textContent = `Enviando ${current}/${total} (${pct}%) — ${contactName}`;
    const logDiv = $('send-log-live');
    if (logDiv) logDiv.innerHTML = `<div>✓ Enviado para ${escHtml(contactName)} (${phone})</div>` + logDiv.innerHTML;
  });

  window.api.onSchedulerWaiting(({ secondsRemaining }) => {
    if ($('send-status-text')) $('send-status-text').textContent = `Aguardando intervalo entre blocos: ${secondsRemaining}s`;
  });

  window.api.onSchedulerDone(({ totalSent }) => {
    if ($('btn-start-send')) $('btn-start-send').disabled = false;
    if ($('btn-cancel-send')) $('btn-cancel-send').disabled = true;
    if ($('send-status-text')) $('send-status-text').textContent = `Concluído: ${totalSent} mensagens processadas`;
    toast(`Disparo concluído: ${totalSent} mensagens!`);
  });
}

// ── Status Log ─────────────────────────────────────────────────────────────
let allLogs = [];

async function loadStatus() {
  allLogs = await window.api.logList();
  renderStatusLogs(allLogs);
}

function renderStatusLogs(logs) {
  const tbody = $('status-tbody');
  if (!tbody) return;
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">Nenhum log de envio</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map(l => `
    <tr>
      <td>${escHtml(l.contact_name)}</td>
      <td>${escHtml(l.contact_phone)}</td>
      <td>${escHtml(l.message_title)}</td>
      <td data-wamid="${l.wam_id || ''}">${statusBadge(l.status)}</td>
      <td style="font-size:11px;color:var(--muted)">${escHtml(l.error_msg || '—')}</td>
      <td>${fmtDate(l.sent_at)}</td>
      <td>${fmtDate(l.updated_at)}</td>
    </tr>
  `).join('');
}

if ($('btn-refresh-status')) $('btn-refresh-status').addEventListener('click', loadStatus);
if ($('btn-clear-log')) $('btn-clear-log').addEventListener('click', async () => {
  if (!(await askConfirm('Limpar histórico de envios finalizados?'))) return;
  await window.api.logClear();
  loadStatus();
  toast('Histórico limpo');
});

// ── Configurações & Feriados ───────────────────────────────────────────────
async function loadSettings() {
  const [cfg, customHolidays] = await Promise.all([
    window.api.configGet(),
    window.api.holidaysListCustom()
  ]);

  if (cfg.whatsapp_number && $('cfg-wa-number'))          $('cfg-wa-number').value             = cfg.whatsapp_number;
  if (cfg.block_size && $('cfg-block-size'))              $('cfg-block-size').value            = cfg.block_size;
  if (cfg.block_delay && $('cfg-block-delay'))            $('cfg-block-delay').value           = cfg.block_delay;
  if (cfg.reception_phone && $('cfg-reception-phone'))   $('cfg-reception-phone').value       = cfg.reception_phone;
  if (cfg.serena_enabled && $('cfg-serena-enabled'))      $('cfg-serena-enabled').value        = cfg.serena_enabled;
  if (cfg.serena_followup_enabled && $('cfg-serena-followup-enabled')) $('cfg-serena-followup-enabled').value = cfg.serena_followup_enabled;
  // Zelda
  if (cfg.zelda_group_name && $('cfg-zelda-group-name'))       $('cfg-zelda-group-name').value      = cfg.zelda_group_name;
  if (cfg.zelda_sindico_phone && $('cfg-zelda-sindico-phone'))   $('cfg-zelda-sindico-phone').value   = cfg.zelda_sindico_phone;
  if (cfg.zelda_min_approvals && $('cfg-zelda-min-approvals'))   $('cfg-zelda-min-approvals').value   = cfg.zelda_min_approvals;
  if (cfg.zelda_reminder_hour && $('cfg-zelda-reminder-hour'))   $('cfg-zelda-reminder-hour').value   = cfg.zelda_reminder_hour;
  if (cfg.zelda_enabled && $('cfg-zelda-enabled'))          $('cfg-zelda-enabled').value         = cfg.zelda_enabled;

  renderCustomHolidays(customHolidays);
}

function renderCustomHolidays(list) {
  const tbody = $('holidays-tbody');
  if (!tbody) return;
  if (!list || !list.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:10px">Nenhum feriado manual cadastrado</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(h => `
    <tr>
      <td>${escHtml(h.date.split('-').reverse().join('/'))}</td>
      <td>${escHtml(h.description)}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteCustomHoliday(${h.id})">Excluir</button></td>
    </tr>
  `).join('');
}

if ($('btn-save-config')) $('btn-save-config').addEventListener('click', async () => {
  await Promise.all([
    window.api.configSet('whatsapp_number',     $('cfg-wa-number').value.trim()),
    window.api.configSet('block_size',          $('cfg-block-size').value.trim()),
    window.api.configSet('block_delay',         $('cfg-block-delay').value.trim()),
    window.api.configSet('reception_phone',     $('cfg-reception-phone').value.trim()),
    window.api.configSet('serena_enabled',      $('cfg-serena-enabled').value),
    window.api.configSet('serena_followup_enabled', $('cfg-serena-followup-enabled').value),
    // Zelda
    window.api.configSet('zelda_group_name',    $('cfg-zelda-group-name').value.trim()),
    window.api.configSet('zelda_sindico_phone', $('cfg-zelda-sindico-phone').value.trim()),
    window.api.configSet('zelda_min_approvals', $('cfg-zelda-min-approvals').value.trim() || '3'),
    window.api.configSet('zelda_reminder_hour', $('cfg-zelda-reminder-hour').value.trim() || '9'),
    window.api.configSet('zelda_enabled',       $('cfg-zelda-enabled').value),
  ]);
  toast('Configurações salvas com sucesso!');
});

// ── BOTÃO DE ZERAR BANCO DE DADOS NA TELA DE CONFIGURAÇÕES ──────────────────
if ($('btn-reset-db')) $('btn-reset-db').addEventListener('click', async () => {
  const confirm1 = await askConfirm(
    '⚠️ ATENÇÃO!\n\nEsta ação apaga todos os leads cadastrados, históricos de conversas e agendamentos ocupados no serena-db.json.\n\nAs configurações da clínica (nome, endereço, regras) SERÃO PRESERVADAS.\n\nDeseja continuar?'
  );
  if (!confirm1) return;

  const inputConfirm = prompt('Para confirmar a exclusão definitiva de todos os dados, digite ZERAR no campo abaixo:');

  if (inputConfirm && inputConfirm.trim().toUpperCase() === 'ZERAR') {
    try {
      const res = await window.api.serenaResetDatabase();
      if (res && res.success) {
        toast('✅ Banco de dados zerado com sucesso! Configurações da clínica mantidas.', 'success');
        if ($('page-serena') && $('page-serena').classList.contains('active')) loadSerenaDashboard();
      } else {
        toast('❌ Erro ao zerar banco: ' + ((res && res.error) || 'Tente novamente.'), 'error');
      }
    } catch (err) {
      console.error('[Reset DB Error]', err);
      toast('❌ Falha ao comunicar com o processo principal.', 'error');
    }
  } else {
    toast('Operação cancelada. Texto de confirmação digitado esteve incorreto.', 'info');
  }
});

if ($('btn-add-holiday')) $('btn-add-holiday').addEventListener('click', async () => {
  const date = $('holiday-date').value;
  const desc = $('holiday-desc').value.trim();
  if (!date || !desc) return toast('Preencha a data e descrição do feriado', 'error');

  const updated = await window.api.holidaysAddCustom(date, desc);
  $('holiday-date').value = '';
  $('holiday-desc').value = '';
  renderCustomHolidays(updated);
  toast('Feriado adicionado!');
});

async function deleteCustomHoliday(id) {
  const updated = await window.api.holidaysDeleteCustom(id);
  renderCustomHolidays(updated);
  toast('Feriado removido');
}

// ── Inicialização ──────────────────────────────────────────────────────────
(async () => {
  showPage('serena');
  if (window.api && window.api.waInfo) {
    const info = await window.api.waInfo();
    updateWaBadge(info.status, info);
  }
})();

// ── Zelda — Bot de Gestão do Condomínio ────────────────────────────────────

const ZELDA_STATUS_LABELS = {
  em_cotacao:   '🔵 Em Cotação',
  cotado:       '🟡 Cotado',
  em_aprovacao: '🟠 Em Aprovação',
  aprovado:     '✅ Aprovado',
  em_execucao:  '🔨 Em Execução',
  encerrado:    '🏁 Encerrado',
  negado:       '❌ Negado'
};

const ZELDA_STATUS_COLORS = {
  em_cotacao:   '#3b82d4',
  cotado:       '#ca8a04',
  em_aprovacao: '#ea580c',
  aprovado:     '#16a34a',
  em_execucao:  '#7c5cd8',
  encerrado:    '#57606a',
  negado:       '#b91c1c'
};

function zeldaFmtValue(v) {
  if (v == null || v === '') return '—';
  return `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
}

function zeldaFmtSeq(seq) {
  return `#${String(seq).padStart(3, '0')}`;
}

let zeldaCurrentTab = 'initiatives';

function zeldaSwitchTab(tab) {
  zeldaCurrentTab = tab;
  document.querySelectorAll('.zelda-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ztab === tab);
  });
  if ($('zelda-tab-initiatives')) $('zelda-tab-initiatives').style.display = tab === 'initiatives' ? '' : 'none';
  if ($('zelda-tab-history'))     $('zelda-tab-history').style.display     = tab === 'history'     ? '' : 'none';
  if ($('zelda-tab-log'))         $('zelda-tab-log').style.display         = tab === 'log'         ? '' : 'none';

  if (tab === 'history') zeldaLoadHistory();
  if (tab === 'log')     zeldaLoadLog();
}

function zeldaUpdateStatusBadge(status) {
  const badge = $('zelda-status-badge');
  const dot   = $('zelda-status-dot');
  const text  = $('zelda-status-text');
  if (!badge) return;

  const isReady = status === 'ready';
  if (dot) dot.style.background = isReady ? '#10b981' : '#ef4444';
  if (text) text.textContent = isReady ? 'Conectada (WhatsApp Online)' : 'Desconectada (WhatsApp Offline)';
  badge.className = isReady ? 'badge badge-delivered' : 'badge badge-pending';
}

// ── CORREÇÃO DO MODAL DA ZELDA (DISPARO CONTROLADO) ─────────────────────────

function zeldaOpenNewInitiativeModal() {
  const modal = $('zelda-new-initiative-modal');
  if (!modal) return;

  if ($('zelda-input-title'))    $('zelda-input-title').value = '';
  if ($('zelda-input-resp'))     $('zelda-input-resp').value = '';
  if ($('zelda-input-status'))   $('zelda-input-status').value = 'aprovado';
  if ($('zelda-input-due'))      $('zelda-input-due').value = '';
  if ($('zelda-input-supplier')) $('zelda-input-supplier').value = '';
  if ($('zelda-input-value'))    $('zelda-input-value').value = '';

  modal.classList.add('open');
  modal.style.display = 'flex'; // Exibe o modal flutuante apenas no clique
}

function zeldaCloseNewInitiativeModal() {
  const modal = $('zelda-new-initiative-modal');
  if (!modal) return;

  modal.classList.remove('open');
  modal.style.display = 'none'; // Garante o ocultamento em todas as abas
}

// Garante o fechamento padrão no carregamento inicial da página
document.addEventListener('DOMContentLoaded', () => {
  zeldaCloseNewInitiativeModal();
});

async function zeldaSubmitNewInitiative() {
  const title    = ($('zelda-input-title')?.value || '').trim();
  const resp     = ($('zelda-input-resp')?.value || '').trim();
  const status   = $('zelda-input-status') ? $('zelda-input-status').value : 'aprovado';
  const due      = ($('zelda-input-due')?.value || '').trim();
  const supplier = ($('zelda-input-supplier')?.value || '').trim();
  const valRaw   = ($('zelda-input-value')?.value || '').replace(/[R$\s]/g, '').replace(',', '.');
  const appValue = valRaw && !isNaN(parseFloat(valRaw)) ? parseFloat(valRaw) : null;

  if (!title) {
    toast('Por favor, informe a descrição da atividade.', 'error');
    if ($('zelda-input-title')) $('zelda-input-title').focus();
    return;
  }
  if (!resp) {
    toast('Por favor, informe o responsável pela atividade.', 'error');
    if ($('zelda-input-resp')) $('zelda-input-resp').focus();
    return;
  }

  const btn = $('btn-zelda-save-initiative');
  if (btn) btn.disabled = true;

  try {
    await window.api.zeldaCreateInitiative({
      title,
      responsible: resp,
      dueDate: due || null,
      status: status || 'aprovado',
      supplier: supplier || null,
      approvedValue: appValue,
      createdBy: 'Painel Desktop'
    });
    toast('Atividade salva com sucesso!', 'success');
    zeldaCloseNewInitiativeModal();
    await zeldaRefresh();
  } catch (err) {
    console.error('[Zelda UI] Erro ao criar atividade:', err);
    toast('Erro ao salvar atividade: ' + (err.message || err), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function zeldaRefresh() {
  try {
    const cfg = await window.api.configGet();
    const groupNameLabel = $('zelda-group-name-label');
    if (groupNameLabel) groupNameLabel.textContent = cfg.zelda_group_name || '—';
  } catch (_) {}

  try {
    const waStatus = await window.api.waStatus();
    zeldaUpdateStatusBadge(waStatus);
  } catch (_) {}

  if (zeldaCurrentTab === 'initiatives') await zeldaLoadInitiatives();
  else if (zeldaCurrentTab === 'history') await zeldaLoadHistory();
  else if (zeldaCurrentTab === 'log') await zeldaLoadLog();
}

async function zeldaLoadInitiatives() {
  try {
    const list = await window.api.zeldaListActive();
    const filter = $('zelda-filter-status') ? $('zelda-filter-status').value : '';
    const filtered = filter ? list.filter(i => i.status === filter) : list;

    const lbl = $('zelda-count-label');
    if (lbl) lbl.textContent = `${filtered.length} atividade(s)`;

    const tbody = $('zelda-initiatives-body');
    if (!tbody) return;
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:24px">Nenhuma atividade encontrada.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(ini => {
      const statusLabel = ZELDA_STATUS_LABELS[ini.status] || ini.status;
      const statusColor = ZELDA_STATUS_COLORS[ini.status] || '#57606a';
      const quotes = ini.quotes || [];
      const votes  = ini.votes  || [];
      const approvals  = votes.filter(v => v.vote === 'approve');
      const rejections = votes.filter(v => v.vote === 'reject');

      let quotesHtml = '—';
      if (quotes.length > 0) {
        quotesHtml = quotes.map(q =>
          `<div style="white-space:nowrap">${q.seq}. ${escHtml(q.supplier)} — ${zeldaFmtValue(q.value)}</div>`
        ).join('');
      }

      let approvalsHtml = '—';
      if (ini.status === 'em_aprovacao' || ini.status === 'aprovado' || ini.status === 'negado') {
        approvalsHtml = `<span style="color:#16a34a">✅ ${approvals.length}</span> / <span style="color:#b91c1c">❌ ${rejections.length}</span>`;
        if (approvals.length > 0) {
          approvalsHtml += `<br><small style="color:#57606a">${approvals.map(v => escHtml(v.voter_name || v.voter_phone)).join(', ')}</small>`;
        }
      }

      return `<tr>
        <td style="font-weight:600">${zeldaFmtSeq(ini.seq)}</td>
        <td>${escHtml(ini.title)}</td>
        <td><span style="color:${statusColor};font-weight:600">${statusLabel}</span></td>
        <td>${escHtml(ini.responsible)}</td>
        <td>${escHtml(ini.due_date || '—')}</td>
        <td style="font-size:12px">${quotesHtml}</td>
        <td style="font-size:12px">${approvalsHtml}</td>
        <td style="font-size:12px">${escHtml(ini.supplier || '—')}</td>
        <td>${zeldaFmtValue(ini.approved_value)}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    console.error('[Zelda UI] Erro ao carregar atividades:', err);
  }
}

async function zeldaLoadHistory() {
  try {
    const list = await window.api.zeldaListArchived();
    const tbody = $('zelda-history-body');
    if (!tbody) return;
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px">Nenhuma atividade arquivada.</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(ini => {
      const statusLabel = ZELDA_STATUS_LABELS[ini.status] || ini.status;
      const statusColor = ZELDA_STATUS_COLORS[ini.status] || '#57606a';
      return `<tr>
        <td style="font-weight:600">${zeldaFmtSeq(ini.seq)}</td>
        <td>${escHtml(ini.title)}</td>
        <td><span style="color:${statusColor};font-weight:600">${statusLabel}</span></td>
        <td>${escHtml(ini.responsible)}</td>
        <td>${escHtml(ini.supplier || '—')}</td>
        <td>${zeldaFmtValue(ini.approved_value)}</td>
        <td style="font-size:12px">${escHtml(ini.created_at ? ini.created_at.substring(0,16) : '')}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    console.error('[Zelda UI] Erro ao carregar histórico:', err);
  }
}

async function zeldaLoadLog() {
  try {
    const msgs = await window.api.zeldaMessages(300);
    const container = $('zelda-log-list');
    if (!container) return;
    if (!msgs.length) {
      container.innerHTML = `<p style="color:var(--text-muted);text-align:center">Nenhuma mensagem registrada ainda.</p>`;
      return;
    }
    container.innerHTML = msgs.map(m => {
      const isOut = m.direction === 'out';
      const bg = isOut ? '#e8f0fe' : '#f7f8fa';
      const align = isOut ? 'right' : 'left';
      const label = isOut ? '🤖 Zelda' : `👤 ${escHtml(m.sender_name || m.sender_phone)}`;
      return `<div style="margin-bottom:8px;text-align:${align}">
        <div style="display:inline-block;max-width:80%;background:${bg};border-radius:8px;padding:7px 11px;font-size:12.5px;text-align:left">
          <div style="font-weight:600;margin-bottom:2px;color:#57606a;font-size:11px">${label} · ${escHtml(m.created_at ? m.created_at.substring(0,16) : '')}</div>
          <div style="white-space:pre-wrap">${escHtml(m.message)}</div>
        </div>
      </div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    console.error('[Zelda UI] Erro ao carregar log:', err);
  }
}

(function injectZeldaStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .zelda-tab {
      background: none; border: none; border-bottom: 3px solid transparent;
      padding: 8px 18px; cursor: pointer; font-size: 13.5px; font-weight: 500;
      color: var(--text-muted); transition: color .15s, border-color .15s;
    }
    .zelda-tab:hover { color: var(--text); }
    .zelda-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  `;
  document.head.appendChild(style);
})();
// === SERENA_RUNTIME_AUTOHOOK_START ===
try {
  const __p = require("path"), __f = require("fs");
  const __cands = [
    __p.join(__dirname, "configuracoes"),
    __p.join(__dirname, "..", "configuracoes"),
    __p.join(__dirname, "..", "..", "configuracoes"),
    __p.join(process.cwd(), "configuracoes")
  ];
  if (process.resourcesPath) {
    __cands.push(
      __p.join(process.resourcesPath, "app", "configuracoes"),
      __p.join(process.resourcesPath, "configuracoes")
    );
  }
  for (const __d of __cands) {
    const __h = __p.join(__d, "runtimeAutoHook.cjs");
    if (__f.existsSync(__h)) {
      require(__h);
      break;
    }
  }
} catch (_eAutoHook) {}
// === SERENA_RUNTIME_AUTOHOOK_END ===
/**
 * whatsapp.js — integração com whatsapp-web.js
 * Gerencia cliente, QR code, envio e eventos de status.
 */
const { Client, LocalAuth, MessageAck } = require('whatsapp-web.js');
const qrcode      = require('qrcode');
const path        = require('path');
const fs          = require('fs');
const { execSync } = require('child_process');
const db      = require('./db');
const serenaBridge = require('./serenaBridge');
const voiceTranscriber = require('./voiceTranscriber');
const zeldaCore = require('./zeldaCore');
const zeldaFollowup = require('./zeldaFollowup');

let client         = null;
let clientStatus   = 'disconnected';
let isInitializing = false;
let connectedPhone = '';
let connectedName  = '';
let mainWindow     = null;

// Cache para desduplicação de mensagens recebidas (evita duplo processamento)
const processedMessageIds = new Set();

const PAUSE_OR_RESUME_REGEX = /^#(pausar|pausa|silenciar|assumir|retomar|voltar|despausar|bot)\b/i;

function setWindow(win) { mainWindow = win; }

function emit(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function getStatus() { return clientStatus; }

function getInfo() {
  return { status: clientStatus, phone: connectedPhone, name: connectedName };
}

function findChromium() {
  // Prioriza o Google Chrome ou Microsoft Edge estável instalados no Windows
  const sysBrowser = findSystemBrowser();
  if (sysBrowser) return sysBrowser;

  const base = path.join(__dirname, '..', 'node_modules', 'puppeteer');
  try {
    const pup = require('puppeteer');
    if (pup.executablePath && typeof pup.executablePath === 'function') {
      const ep = pup.executablePath();
      if (ep && fs.existsSync(ep)) return ep;
    }
  } catch (_) {}
  const candidates = [
    path.join(base, '.local-chromium'),
    path.join(base, '.local-chrome'),
    path.join(base, 'chrome'),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const found = findExe(dir, ['chrome.exe', 'chromium.exe', 'chrome', 'chromium']);
    if (found) return found;
  }
  return null;
}

/**
 * Procura o Chrome ou o Edge instalados no Windows.
 */
function findSystemBrowser() {
  const pf    = process.env['ProgramFiles']      || 'C:\\Program Files';
  const pf86  = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA']      || '';
  const candidates = [
    path.join(pf,    'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86,  'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86,  'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf,    'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function findExe(dir, names) {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (names.includes(entry) && fs.existsSync(full)) return full;
      if (fs.statSync(full).isDirectory()) {
        const found = findExe(full, names);
        if (found) return found;
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Extrai o telefone real do destinatário quando a clínica envia uma mensagem (fromMe),
 * resolvendo inclusive chats em formato @lid.
 */
async function resolveOutgoingTargetPhone(msg) {
  let targetPhone = '';
  const rawTo = msg.to || '';

  if (rawTo.includes('@c.us')) {
    targetPhone = rawTo.replace('@c.us', '').replace(/\D/g, '');
  }

  if (!targetPhone || targetPhone.length > 13) {
    try {
      const chat = await msg.getChat();
      if (chat && chat.id && chat.id._serialized && chat.id._serialized.includes('@c.us')) {
        targetPhone = String(chat.id.user || '').replace(/\D/g, '');
      }
      if ((!targetPhone || targetPhone.length > 13) && chat && typeof chat.getContact === 'function') {
        const contact = await chat.getContact();
        if (contact) {
          if (contact.number && !contact.number.includes('lid') && contact.number.length <= 13) {
            targetPhone = contact.number.replace(/\D/g, '');
          } else if (contact.id && contact.id.user && !contact.id.user.includes('lid') && contact.id.user.length <= 13) {
            targetPhone = contact.id.user.replace(/\D/g, '');
          }
        }
      }
    } catch (_) {}
  }

  if (!targetPhone) {
    targetPhone = rawTo.replace('@lid', '').replace('@c.us', '').replace(/\D/g, '');
  }

  return targetPhone;
}

function init() {
  if (client || isInitializing) return;
  isInitializing = true;
  connectedPhone = '';
  connectedName  = '';

  const { app } = require('electron');
  const authDataPath = path.join(app.getPath('userData'), '.wwebjs_auth');
  const chromiumPath = findChromium();

  if (!chromiumPath) {
    clientStatus   = 'error';
    isInitializing = false;
    emit('wa:status', clientStatus);
    emit('wa:error', 'Nenhum navegador encontrado. Instale o Google Chrome ou o Microsoft Edge e tente novamente.');
    return;
  }

  const puppeteerOpts = {
    headless: 'new',
    dumpio: false,
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
    ]
  };
  if (chromiumPath) {
    puppeteerOpts.executablePath = chromiumPath;
  }

  const newClient = new Client({
    authStrategy: new LocalAuth({ dataPath: authDataPath }),
    puppeteer: puppeteerOpts,
  });

  newClient.on('qr', async (qr) => {
    clientStatus = 'qr';
    try {
      const dataUrl = await qrcode.toDataURL(qr);
      emit('wa:qr', dataUrl);
    } catch (e) {
      emit('wa:error', 'Erro ao gerar QR Code: ' + e.message);
    }
    emit('wa:status', clientStatus);
  });

  newClient.on('ready', () => {
    clientStatus   = 'ready';
    isInitializing = false;
    connectedPhone = newClient.info && newClient.info.wid
      ? newClient.info.wid._serialized.replace('@c.us', '').replace('@lid', '')
      : '';
    connectedName = newClient.info && newClient.info.pushname
      ? newClient.info.pushname
      : '';
    emit('wa:status', clientStatus);
    emit('wa:ready', { phone: connectedPhone, name: connectedName });

    // Agendador do motor novo da Serena (lembrete 24h + follow-up autorizado)
    if (typeof serenaBridge.startScheduler === 'function') {
      serenaBridge.startScheduler((p, t) => sendMessage(p, t));
    }

    // Inicia serviço de lembretes da Zelda
    zeldaFollowup.startZeldaFollowup((text) => {
      const config = db.getConfig();
      const groupName = (config.zelda_group_name || '').trim();
      if (!groupName) return Promise.resolve();
      return sendToGroupByName(groupName, text);
    });
  });

  newClient.on('authenticated', () => {
    emit('wa:status', 'authenticated');
  });

  newClient.on('auth_failure', (msg) => {
    clientStatus   = 'error';
    isInitializing = false;
    client         = null;
    connectedPhone = '';
    connectedName  = '';
    emit('wa:status', clientStatus);
    emit('wa:error', String(msg));
  });

  newClient.on('disconnected', (reason) => {
    clientStatus   = 'disconnected';
    isInitializing = false;
    client         = null;
    connectedPhone = '';
    connectedName  = '';
    emit('wa:status', clientStatus);
    if (typeof serenaBridge.stopScheduler === 'function') {
      serenaBridge.stopScheduler();
    }
    zeldaFollowup.stopZeldaFollowup();
  });

  newClient.on('message_ack', (msg, ack) => {
    const statusMap = {
      [MessageAck.ACK_ERROR]:   'error',
      [MessageAck.ACK_PENDING]: 'pending',
      [MessageAck.ACK_SERVER]:  'sent',
      [MessageAck.ACK_DEVICE]:  'delivered',
      [MessageAck.ACK_READ]:    'read',
      [MessageAck.ACK_PLAYED]:  'read'
    };
    const status = statusMap[ack] || 'sent';
    db.updateLogByWamId(msg.id._serialized, status);
    emit('wa:ack', { wamId: msg.id._serialized, status });
  });

  newClient.on('message', async (msg) => {
    // Desduplicação: evita que o mesmo evento seja disparado duas vezes
    const msgId = msg.id ? msg.id._serialized : null;
    if (msgId && processedMessageIds.has(msgId)) {
      return;
    }
    if (msgId) {
      processedMessageIds.add(msgId);
      if (processedMessageIds.size > 2000) {
        const first = processedMessageIds.values().next().value;
        processedMessageIds.delete(first);
      }
    }

    // ── Mensagens de GRUPO → roteadas para a Zelda ────────────────────────────
    if (!msg.fromMe && msg.from && msg.from.includes('@g.us')) {
      const config = db.getConfig();
      const groupName = (config.zelda_group_name || '').trim();
      if (groupName && msg.body && typeof msg.body === 'string') {
        try {
          const chat = await msg.getChat();
          const chatName = (chat && chat.name) ? chat.name.trim() : '';
          const normChat = chatName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const normConfigGroup = groupName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (normChat.includes(normConfigGroup) || normConfigGroup.includes(normChat)) {
            const groupId = msg.from;
            let senderPhone = '';
            let senderName  = msg._data?.notifyName || '';
            try {
              const author = msg.author || msg._data?.participant || '';
              if (author && author.includes('@c.us')) senderPhone = author.replace('@c.us', '').replace(/\D/g, '');
              if (!senderPhone) {
                const contact = await msg.getContact();
                if (contact) {
                  senderPhone = (contact.number || contact.id?.user || '').replace(/\D/g, '');
                  if (!senderName && contact.pushname) senderName = contact.pushname;
                }
              }
            } catch (_) {}

            const groupSenderFn = async (text) => {
              await chat.sendMessage(text);
            };

            zeldaCore.processGroupMessage(groupId, senderPhone, senderName, msg.body, groupSenderFn)
              .catch(err => console.error('[Zelda] Erro ao processar mensagem de grupo:', err.message));
          }
        } catch (_) {}
      }
      return;
    }

    // Mensagens enviadas pela própria conta (fromMe) são tratadas em message_create
    if (msg.fromMe) {
      return;
    }

    if (msg.from && msg.from.includes('@broadcast')) {
      return;
    }

    const rawChatId = msg.from;

    // Extração robusta do número do celular real
    let senderPhone = '';
    let pushName = msg._data?.notifyName || '';

    try {
      const author = msg.author || msg._data?.participant || '';
      if (author && author.includes('@c.us')) {
        senderPhone = author.replace('@c.us', '');
      }

      if (!senderPhone && msg.from && msg.from.includes('@c.us')) {
        senderPhone = msg.from.replace('@c.us', '');
      }

      if (!senderPhone) {
        try {
          const chat = await msg.getChat();
          if (chat && chat.id && chat.id._serialized && chat.id._serialized.includes('@c.us')) {
            senderPhone = chat.id.user;
          }
        } catch (_) {}
      }

      const contact = await msg.getContact();
      if (contact) {
        if (contact.number && !contact.number.includes('@') && !contact.number.includes('lid') && contact.number.length <= 13) {
          senderPhone = contact.number;
        } else if (contact.id && contact.id.user && !contact.id.user.includes('lid') && contact.id.user.length <= 13) {
          senderPhone = contact.id.user;
        }
        if (!pushName && contact.pushname) pushName = contact.pushname;
        if (!pushName && contact.name) pushName = contact.name;
      }
    } catch (_) {}

    senderPhone = (senderPhone || '').replace(/\D/g, '');

    if (!senderPhone || senderPhone.length > 13) {
      if (rawChatId && rawChatId.includes('@c.us')) {
        senderPhone = rawChatId.replace('@c.us', '').replace(/\D/g, '');
      } else {
        senderPhone = rawChatId.replace('@lid', '').replace('@c.us', '').replace(/\D/g, '');
      }
    }

    emit('wa:reply', { from: senderPhone, body: msg.body, timestamp: msg.timestamp });
    markReplied(senderPhone);

    const chatTarget = senderPhone + '@c.us';
    if (msg.body && typeof msg.body === 'string' && msg.body.trim()) {
      serenaBridge.handleText(newClient, chatTarget, msg.body, pushName)
        .catch(err => console.error('[Serena] Erro ao processar mensagem de', senderPhone, ':', err.message, err.stack));
    } else if (msg.type === 'ptt' || msg.type === 'audio') {
      (async () => {
        try {
          const media = await msg.downloadMedia();
          if (!media || !media.data) throw new Error('Mídia vazia');

          const audioBuffer = Buffer.from(media.data, 'base64');
          const transcribed = await voiceTranscriber.transcribe(audioBuffer);

          if (transcribed && transcribed.trim()) {
            console.log(`[Whisper] Transcrito de ${senderPhone}: "${transcribed}"`);
            await serenaBridge.handleText(newClient, chatTarget, transcribed.trim(), pushName);
          } else {
            const fallback = '🎙️ Recebi seu áudio! Infelizmente não consegui entendê-lo desta vez. Pode digitar sua mensagem por texto? Assim consigo te ajudar rapidinho! 😊';
            await serenaBridge.sendFixedReply(newClient, chatTarget, fallback);
          }
        } catch (err) {
          console.error('[Whisper] Falha ao transcrever áudio de', senderPhone, ':', err.message);
          const fallback = '🎙️ Recebi seu áudio! Infelizmente não consegui entendê-lo desta vez. Pode digitar sua mensagem por texto? Assim consigo te ajudar rapidinho! 😊';
          serenaBridge.sendFixedReply(newClient, chatTarget, fallback)
            .catch(() => {});
        }
      })();
    } else if (msg.hasMedia || msg.type === 'image' || msg.type === 'sticker') {
      const mediaReply = '📎 Recebi sua imagem! Por enquanto só consigo responder por texto — pode me dizer o que precisa digitando? Assim te ajudo com sua avaliação gratuita! 😊';
      serenaBridge.sendFixedReply(newClient, chatTarget, mediaReply)
        .catch(err => console.error('[Serena] Erro ao responder mídia para', senderPhone, ':', err.message));
    }
  });

  // ── Captura comandos #pausar / #retomar e intervenções manuais da recepção (fromMe) ──
  newClient.on('message_create', async (msg) => {
    try {
      if (!msg || !msg.fromMe) return;
      if (msg.to && (msg.to.includes('@g.us') || msg.to.includes('@broadcast'))) return;

      const text = String(msg.body || '').trim();
      const targetPhone = await resolveOutgoingTargetPhone(msg);
      if (!targetPhone) return;

      // 1. Se a recepção digitou #pausar ou #retomar explicitamente:
      if (PAUSE_OR_RESUME_REGEX.test(text)) {
        const serenaEngine = await import('../serenaEngine.mjs');
        const reply = await serenaEngine.handleIncomingWhatsAppMessage(targetPhone, text);

        // Sincroniza também na ponte serenaBridge
        if (typeof serenaBridge.handleOutgoingMessage === 'function') {
          const receptionPhone = (db.getConfig().reception_phone || '').replace(/\D/g, '');
          serenaBridge.handleOutgoingMessage({ ...msg, to: targetPhone + '@c.us' }, receptionPhone);
        }

        if (reply) {
          const replyTarget = msg.to || (targetPhone + '@c.us');
          await serenaBridge.sendFixedReply(newClient, replyTarget, reply);
          console.log(`[Serena] Comando "${text}" aplicado com sucesso para ${targetPhone}.`);
        }
        return;
      }

      // 2. Qualquer outra mensagem manual enviada pela recepção pausa o bot na conversa
      const receptionPhone = (db.getConfig().reception_phone || '').replace(/\D/g, '');
      if (serenaBridge.handleOutgoingMessage({ ...msg, to: targetPhone + '@c.us' }, receptionPhone)) {
        const serenaEngine = await import('../serenaEngine.mjs');
        await serenaEngine.handleIncomingWhatsAppMessage(targetPhone, '#pausar');
        console.log(`[Serena] CRC assumiu a conversa (${targetPhone}). Serena pausada automaticamente.`);
      }
    } catch (err) {
      console.error('[Serena] Erro ao processar message_create:', err.message);
    }
  });

  client = newClient;

  // ── Limpa processos chrome/chromium órfãos que travam o perfil wwebjs_auth ──
  try {
    const wmicOut = execSync(
      'wmic process where "name=\'chrome.exe\' or name=\'msedge.exe\' or name=\'chromium.exe\'" get ProcessId,CommandLine /FORMAT:CSV',
      { timeout: 8000, encoding: 'utf8', windowsHide: true }
    );
    const authMark = '.wwebjs_auth';
    for (const line of wmicOut.split('\n')) {
      if (!line.includes(authMark)) continue;
      const parts = line.split(',');
      const pid   = parts[parts.length - 1].trim();
      if (!pid || isNaN(Number(pid))) continue;
      try {
        execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, windowsHide: true });
        console.log(`[WA] Processo órfão eliminado: PID ${pid}`);
      } catch (_) {}
    }
  } catch (_) {}

  // Remove SingletonLock se existir
  try {
    const sessionDir = path.join(authDataPath, 'session', 'Default');
    const lockFile   = path.join(sessionDir, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      console.log('[WA] SingletonLock removido.');
    }
  } catch (_) {}

  client.initialize().catch(err => {
    clientStatus   = 'error';
    isInitializing = false;
    client         = null;
    connectedPhone = '';
    connectedName  = '';
    emit('wa:status', clientStatus);
    emit('wa:error', 'Erro ao iniciar WhatsApp: ' + err.message);
  });
}

function markReplied(phone) {
  try {
    const contacts = db.getContacts();
    const contact  = contacts.find(c => c.phone === phone || phone.includes(c.phone));
    if (contact) db.markRepliedByContactId(contact.id);
  } catch (_) {}
}

/**
 * Normaliza número brasileiro para o formato internacional (55 + DDD + número).
 */
function normalizeBrPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 12 || digits.length === 13) return digits;
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}

async function sendMessage(target, text) {
  if (!client || clientStatus !== 'ready') throw new Error('WhatsApp não está conectado');
  let chatId = target;
  if (!chatId.includes('@c.us') && !chatId.includes('@lid')) {
    chatId = normalizeBrPhone(target) + '@c.us';
  }
  
  try {
    const msg = await client.sendMessage(chatId, text);
    return msg && msg.id ? msg.id._serialized : null;
  } catch (err) {
    if (chatId.includes('@c.us')) {
      const numOnly = chatId.replace('@c.us', '');
      let altNum = '';
      if (numOnly.startsWith('55') && numOnly.length === 13) {
        altNum = numOnly.slice(0, 4) + numOnly.slice(5);
      } else if (numOnly.startsWith('55') && numOnly.length === 12) {
        altNum = numOnly.slice(0, 4) + '9' + numOnly.slice(4);
      }
      if (altNum) {
        const altChatId = altNum + '@c.us';
        const msg = await client.sendMessage(altChatId, text);
        return msg && msg.id ? msg.id._serialized : null;
      }
    }
    throw err;
  }
}

async function sendToGroupByName(groupName, text) {
  if (!client || clientStatus !== 'ready') return;
  try {
    const chats = await client.getChats();
    const normConfigGroup = (groupName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const group = chats.find(c => {
      if (!c.isGroup || !c.name) return false;
      const normChat = c.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      return normChat.includes(normConfigGroup) || normConfigGroup.includes(normChat);
    });
    if (group) await group.sendMessage(text);
  } catch (err) {
    console.error('[Zelda] Erro ao enviar para grupo:', err.message);
  }
}

async function disconnect() {
  if (typeof serenaBridge.stopScheduler === 'function') {
    serenaBridge.stopScheduler();
  }
  zeldaFollowup.stopZeldaFollowup();
  if (!client) return;
  const c = client;
  client         = null;
  clientStatus   = 'disconnected';
  isInitializing = false;
  connectedPhone = '';
  connectedName  = '';
  try {
    await c.destroy();
  } catch (_) {}
}

async function clearSessionAndReconnect() {
  await disconnect();
  await new Promise(r => setTimeout(r, 2000));
  const { app } = require('electron');
  const authDataPath = path.join(app.getPath('userData'), '.wwebjs_auth');
  try {
    fs.rmSync(authDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (err) {
    console.error('[whatsapp] Falha ao apagar .wwebjs_auth:', err.message);
  }
  init();
}

module.exports = {
  init,
  disconnect,
  getStatus,
  getInfo,
  sendMessage,
  setWindow,
  clearSessionAndReconnect,
  normalizeBrPhone
};

// === SERENA_CLINIC_CONFIG_BACKEND_START ===
try {
  const __bReq = require;
  const __bDir = __dirname;
  const __pathMod = __bReq("path");
  const __fsMod = __bReq("fs");
  const __cfgCandidates = [
    __pathMod.join(__bDir, "configuracoes"),
    __pathMod.join(__bDir, "..", "configuracoes"),
    __pathMod.join(__bDir, "..", "..", "configuracoes"),
    __pathMod.join(process.cwd(), "configuracoes")
  ];
  if (process.resourcesPath) {
    __cfgCandidates.push(
      __pathMod.join(process.resourcesPath, "app", "configuracoes"),
      __pathMod.join(process.resourcesPath, "configuracoes")
    );
  }
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
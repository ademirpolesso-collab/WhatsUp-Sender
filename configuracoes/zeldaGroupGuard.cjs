// configuracoes/zeldaGroupGuard.cjs
// Garante que a Zelda responda corretamente no grupo configurado via parâmetro (sem nomes fixos),
// corrige WWebJS.sendSeen (markedUnread), resolução de JID @g.us em fromMe, mensagens temporárias Baileys,
// WPPConnect/Venom, cache de nome de grupo e log diagnóstico em tempo real!

process.env.TZ = "America/Sao_Paulo";

const { getClinicSettings } = require("./configManager.cjs");
const { simulateHumanReactionAndTyping } = require("./antiBanEngine.cjs");
const zeldaCondominio = require("./zeldaCondominioEngine.cjs");

const ZELDA_LOOP_MARKER = zeldaCondominio.ZELDA_LOOP_MARKER;
const recentHandledMsgIds = new Set();
const groupSubjectCache = new Map();

function normalizeGroupToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactGroupToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function rememberMessageId(id) {
  if (!id) return false;
  if (recentHandledMsgIds.has(id)) return true;
  recentHandledMsgIds.add(id);
  if (recentHandledMsgIds.size > 500) {
    const first = recentHandledMsgIds.values().next().value;
    recentHandledMsgIds.delete(first);
  }
  return false;
}

function matchesConfiguredZeldaGroup(groupJid, groupName = "") {
  const settings = getClinicSettings();
  if (settings.zeldaGroupEnabled === false) {
    return { matched: false, reason: "zelda_disabled_in_settings", settings };
  }

  const configuredRaw = String(settings.zeldaGroupTarget || "").trim();
  if (!configuredRaw) {
    return { matched: false, reason: "empty_group_in_settings", settings };
  }

  const targets = configuredRaw
    .split(/[,;\n]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const cleanJid = String(groupJid || "").trim().toLowerCase();
  const jidDigits = cleanJid.split("@")[0].replace(/\D+/g, "");
  const effectiveName = String(groupName || groupSubjectCache.get(groupJid) || "").trim();
  const normSubject = normalizeGroupToken(effectiveName);
  const compSubject = compactGroupToken(effectiveName);

  for (const target of targets) {
    const lowTarget = target.toLowerCase();
    const targetDigits = lowTarget.split("@")[0].replace(/\D+/g, "");
    const normTarget = normalizeGroupToken(target);
    const compTarget = compactGroupToken(target);

    if (cleanJid && (cleanJid === lowTarget || cleanJid === lowTarget + "@g.us")) {
      return { matched: true, reason: "exact_jid", settings };
    }
    if (targetDigits.length >= 10 && jidDigits && jidDigits.includes(targetDigits)) {
      return { matched: true, reason: "jid_digits", settings };
    }
    if (
      normSubject &&
      normTarget &&
      (normSubject === normTarget || normSubject.includes(normTarget) || normTarget.includes(normSubject))
    ) {
      return { matched: true, reason: "normalized_name", settings };
    }
    if (
      compSubject.length >= 3 &&
      compTarget.length >= 3 &&
      (compSubject === compTarget || compSubject.includes(compTarget) || compTarget.includes(compSubject))
    ) {
      return { matched: true, reason: "compact_name", settings };
    }
  }

  return {
    matched: false,
    reason: effectiveName ? "group_mismatch" : "group_name_unresolved",
    settings,
  };
}

function shouldIgnoreGroupForGeneralBot(groupJid, groupName = "") {
  const check = matchesConfiguredZeldaGroup(groupJid, groupName);
  return !check.matched;
}

// Extrai o JID @g.us real mesmo em eventos message_create (fromMe: true em aparelhos conectados Multi-Device, onde msg.to pode vir como @c.us!)
function extractWwebGroupChatId(msg) {
  if (!msg || typeof msg !== "object") return "";
  const candidates = [
    msg.id && msg.id.remote,
    msg._data && msg._data.id && msg._data.id.remote,
    msg.key && msg.key.remoteJid,
    msg.remoteJid,
    msg.groupInfo && msg.groupInfo.id,
    typeof msg.chatId === "string" ? msg.chatId : msg.chatId && (msg.chatId._serialized || msg.chatId),
    msg.chat && msg.chat.id && (msg.chat.id._serialized || msg.chat.id),
    msg.from,
    msg.to,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === "string" && c.trim().endsWith("@g.us")) return c.trim();
    if (typeof c === "object") {
      if (typeof c._serialized === "string" && c._serialized.trim().endsWith("@g.us")) {
        return c._serialized.trim();
      }
      if (c.server === "g.us" && c.user) {
        return `${c.user}@g.us`;
      }
    }
  }
  return "";
}

async function scanAndCacheAllGroups(clientOrSock) {
  if (!clientOrSock) return;
  try {
    if (typeof clientOrSock.getChats === "function") {
      const chats = await clientOrSock.getChats().catch(() => []);
      for (const ch of chats || []) {
        const jid = ch?.id?._serialized || (typeof ch?.id === "string" ? ch.id : "");
        const name = String(ch?.name || ch?.formattedTitle || ch?.subject || "").trim();
        if (jid.endsWith("@g.us") && name) {
          groupSubjectCache.set(jid, name);
          zeldaCondominio.recordDiscoveredGroup(jid, name);
        }
      }
    } else if (typeof clientOrSock.groupFetchAllParticipating === "function") {
      const map = await clientOrSock.groupFetchAllParticipating().catch(() => ({}));
      for (const [jid, meta] of Object.entries(map || {})) {
        const name = String(meta?.subject || "").trim();
        if (jid.endsWith("@g.us") && name) {
          groupSubjectCache.set(jid, name);
          zeldaCondominio.recordDiscoveredGroup(jid, name);
        }
      }
    } else if (typeof clientOrSock.getAllGroups === "function") {
      const groups = await clientOrSock.getAllGroups().catch(() => []);
      for (const ch of groups || []) {
        const jid = ch?.id?._serialized || (typeof ch?.id === "string" ? ch.id : "");
        const name = String(ch?.name || ch?.formattedTitle || ch?.contact?.name || "").trim();
        if (jid.endsWith("@g.us") && name) {
          groupSubjectCache.set(jid, name);
          zeldaCondominio.recordDiscoveredGroup(jid, name);
        }
      }
    }
  } catch (_e) {}
}

async function resolveWwebGroupSubject(clientOrSock, chatId, msg) {
  let subject = String(
    msg?._data?.chat?.name ||
      msg?._data?.chat?.formattedTitle ||
      msg?._data?.subject ||
      msg?.chat?.name ||
      msg?.chat?.formattedTitle ||
      msg?.chat?.contact?.name ||
      msg?.groupInfo?.name ||
      ""
  ).trim();

  if (!subject && typeof msg?.getChat === "function") {
    const chatObj = await msg.getChat().catch(() => null);
    if (chatObj) {
      subject = String(chatObj.name || chatObj.formattedTitle || chatObj.groupMetadata?.subject || "").trim();
    }
  }

  if (!subject && groupSubjectCache.has(chatId)) {
    subject = groupSubjectCache.get(chatId) || "";
  }

  if (!subject && typeof clientOrSock?.getChatById === "function") {
    const chatObj = await clientOrSock.getChatById(chatId).catch(() => null);
    if (chatObj) {
      subject = String(chatObj.name || chatObj.formattedTitle || chatObj.contact?.name || "").trim();
    }
  }

  if (!subject && typeof clientOrSock?.getChats === "function") {
    await scanAndCacheAllGroups(clientOrSock);
    subject = groupSubjectCache.get(chatId) || "";
  }

  if (!subject && clientOrSock?.pupPage && typeof clientOrSock.pupPage.evaluate === "function") {
    try {
      const domSub = await clientOrSock.pupPage
        .evaluate((jid) => {
          try {
            const c =
              window.Store && window.Store.Chat && typeof window.Store.Chat.get === "function"
                ? window.Store.Chat.get(jid)
                : null;
            if (!c) return "";
            return String(c.name || c.formattedTitle || (c.groupMetadata && c.groupMetadata.subject) || "");
          } catch (_e) {
            return "";
          }
        }, chatId)
        .catch(() => "");
      if (domSub) subject = String(domSub).trim();
    } catch (_ePup) {}
  }

  if (subject) {
    groupSubjectCache.set(chatId, subject);
    zeldaCondominio.recordDiscoveredGroup(chatId, subject);
  }
  return subject;
}

async function resolveBaileysGroupSubject(sock, remoteJid) {
  if (groupSubjectCache.has(remoteJid)) {
    return groupSubjectCache.get(remoteJid) || "";
  }
  let subject = "";
  try {
    if (typeof sock?.groupMetadata === "function") {
      const meta = await sock.groupMetadata(remoteJid).catch(() => null);
      if (meta && meta.subject) subject = String(meta.subject).trim();
    }
    if (!subject && typeof sock?.groupFetchAllParticipating === "function") {
      await scanAndCacheAllGroups(sock);
      subject = groupSubjectCache.get(remoteJid) || "";
    }
  } catch (_e) {}
  if (subject) {
    groupSubjectCache.set(remoteJid, subject);
    zeldaCondominio.recordDiscoveredGroup(remoteJid, subject);
  }
  return subject;
}

// Desembrulha mensagens Baileys em grupos com "Mensagens Temporárias" (ephemeralMessage), viewOnce, legendas e edições!
function unwrapBaileysMessageContent(messageObj) {
  let cur = messageObj;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    if (cur.ephemeralMessage && cur.ephemeralMessage.message) {
      cur = cur.ephemeralMessage.message;
      continue;
    }
    if (cur.viewOnceMessage && cur.viewOnceMessage.message) {
      cur = cur.viewOnceMessage.message;
      continue;
    }
    if (cur.viewOnceMessageV2 && cur.viewOnceMessageV2.message) {
      cur = cur.viewOnceMessageV2.message;
      continue;
    }
    if (cur.viewOnceMessageV2Extension && cur.viewOnceMessageV2Extension.message) {
      cur = cur.viewOnceMessageV2Extension.message;
      continue;
    }
    if (cur.documentWithCaptionMessage && cur.documentWithCaptionMessage.message) {
      cur = cur.documentWithCaptionMessage.message;
      continue;
    }
    if (cur.editedMessage && cur.editedMessage.message) {
      cur = cur.editedMessage.message;
      continue;
    }
    if (cur.protocolMessage && cur.protocolMessage.editedMessage) {
      cur = cur.protocolMessage.editedMessage;
      continue;
    }
    break;
  }
  if (!cur || typeof cur !== "object") return { text: "", mentionedJids: [] };
  const text = String(
    cur.conversation ||
      cur.extendedTextMessage?.text ||
      cur.imageMessage?.caption ||
      cur.videoMessage?.caption ||
      cur.documentMessage?.caption ||
      ""
  );
  const contextInfo =
    cur.extendedTextMessage?.contextInfo ||
    cur.imageMessage?.contextInfo ||
    cur.videoMessage?.contextInfo ||
    cur.documentMessage?.contextInfo ||
    null;
  const mentionedJids = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : [];
  return { text, mentionedJids };
}

// Envio blindado para grupos em whatsapp-web.js ({ sendSeen: false }), Baileys ({ text }) e WPPConnect/Venom (sendText)
async function sendGroupReplySafe(clientOrSock, chatId, replyText, rawMsg = null) {
  const cleanReply = String(replyText || "").trim();
  zeldaCondominio.registerZeldaSentReply(cleanReply);
  const safeOut = cleanReply + ZELDA_LOOP_MARKER;
  const groupDelayMs = 350 + Math.floor(Math.random() * 400);
  try {
    if (typeof clientOrSock?.sendPresenceUpdate === "function") {
      await clientOrSock.sendPresenceUpdate("composing", chatId).catch(() => {});
    }
  } catch (_e) {}
  await new Promise((r) => setTimeout(r, groupDelayMs));
  try {
    if (typeof clientOrSock?.sendPresenceUpdate === "function") {
      await clientOrSock.sendPresenceUpdate("paused", chatId).catch(() => {});
    }
  } catch (_e2) {}

  // 1) Baileys
  if (clientOrSock.ev && typeof clientOrSock.sendMessage === "function") {
    await clientOrSock.sendMessage(chatId, { text: safeOut });
    return;
  }

  // 2) WPPConnect / Venom-bot (possui sendText nativo e não pupPage do wwebjs)
  if (typeof clientOrSock.sendText === "function" && !clientOrSock.pupPage) {
    await clientOrSock.sendText(chatId, safeOut);
    return;
  }

  // 3) whatsapp-web.js — SEMPRE passa { sendSeen: false } primeiro para impedir crash "Cannot read properties of undefined (reading 'markedUnread')" em WWebJS.sendSeen!
  const sendFn = clientOrSock.__serenaOrigSendMessage
    ? clientOrSock.__serenaOrigSendMessage.bind(clientOrSock)
    : typeof clientOrSock.sendMessage === "function"
    ? clientOrSock.sendMessage.bind(clientOrSock)
    : null;

  let lastErr = null;
  if (sendFn) {
    try {
      await sendFn(chatId, safeOut, { sendSeen: false });
      return;
    } catch (err1) {
      lastErr = err1;
    }
  }

  if (rawMsg && typeof rawMsg.getChat === "function") {
    try {
      const chatObj = await rawMsg.getChat();
      if (chatObj && typeof chatObj.sendMessage === "function") {
        await chatObj.sendMessage(safeOut, { sendSeen: false });
        return;
      }
    } catch (err2) {
      lastErr = err2;
    }
  }

  if (typeof clientOrSock.sendText === "function") {
    await clientOrSock.sendText(chatId, safeOut);
    return;
  }

  if (sendFn) {
    await sendFn(chatId, safeOut);
    return;
  }

  if (lastErr) throw lastErr;
}

async function processSingleWwebMessage(clientOrSock, msg, eventSource = "message", customZeldaHandler = null) {
  try {
    if (!msg) return;
    global.__zeldaHighLevelClientAttached = true;
    const ownPhone = String(clientOrSock?.info?.wid?.user || "").trim();
    const botProfileName = String(
      clientOrSock?.info?.pushname || clientOrSock?.user?.name || ""
    ).trim();
    zeldaCondominio.markWhatsAppActivityOnline(ownPhone || botProfileName);

    const unwrappedFallback = msg.message ? unwrapBaileysMessageContent(msg.message).text : "";
    const body = String(msg.body ?? msg.content ?? msg.caption ?? msg.text ?? unwrappedFallback ?? "");
    const isFromMe = Boolean(msg.fromMe || msg._data?.id?.fromMe || msg.key?.fromMe);
    if (!body.trim() || zeldaCondominio.isZeldaSelfEcho(body, isFromMe)) return;

    const chatId = extractWwebGroupChatId(msg);
    if (!chatId) return;

    const settings = getClinicSettings();
    if (isFromMe && settings.zeldaAllowFromMeTest === false) {
      zeldaCondominio.recordZeldaGroupDebug({
        chatId,
        groupName: groupSubjectCache.get(chatId) || "",
        configuredGroup: String(settings.zeldaGroupTarget || ""),
        senderName: botProfileName || "WhatsApp Conectado",
        senderPhone: ownPhone,
        fromMe: true,
        matched: false,
        reason: "fromMe_disabled_in_settings",
        preview: body,
        handled: false,
        replied: false,
      });
      return;
    }

    const msgUniqueId =
      msg.id?._serialized ||
      (typeof msg.id === "string" ? msg.id : msg.id?.id) ||
      `${chatId}:${body}:${msg.timestamp || msg.t || ""}`;
    if (rememberMessageId(msgUniqueId)) return;

    const groupSubject = await resolveWwebGroupSubject(clientOrSock, chatId, msg);
    let senderPushName = String(
      msg._data?.notifyName ||
        msg.notifyName ||
        msg.sender?.pushname ||
        msg.sender?.name ||
        (isFromMe ? botProfileName || "WhatsApp Conectado" : "")
    );
    let senderPhone = String(
      msg.author ||
        msg.sender?.id ||
        (isFromMe ? clientOrSock?.info?.wid?._serialized || ownPhone || "" : "") ||
        ""
    );

    try {
      if (typeof msg.getContact === "function") {
        const contactObj = await msg.getContact().catch(() => null);
        if (contactObj) {
          if (!senderPushName) {
            senderPushName = String(contactObj.pushname || contactObj.name || "");
          }
          if (contactObj.number) {
            senderPhone = String(contactObj.number);
          } else if (
            contactObj.id &&
            contactObj.id.user &&
            !String(contactObj.id._serialized || "").endsWith("@lid")
          ) {
            senderPhone = String(contactObj.id.user);
          }
        }
      }
    } catch (_lidErr) {}

    if (isFromMe && !senderPushName) {
      senderPushName = botProfileName || "WhatsApp Conectado";
    }

    const mentionedIds = Array.isArray(msg.mentionedIds)
      ? msg.mentionedIds.map((x) => (typeof x === "string" ? x : x?._serialized || ""))
      : [];
    const ownLid = String(clientOrSock?.info?.me?.lid || clientOrSock?.info?.lid?._serialized || "").split("@")[0];
    const botMentioned = Boolean(
      (ownPhone && mentionedIds.some((mId) => String(mId).includes(ownPhone))) ||
        (ownLid && mentionedIds.some((mId) => String(mId).includes(ownLid))) ||
        (botProfileName && new RegExp(`@${botProfileName.replace(/[.*+?^${}()|\[\]\\]/g, "\\$&")}\b`, "i").test(body))
    );

    const match = matchesConfiguredZeldaGroup(chatId, groupSubject);
    if (!match.matched) {
      zeldaCondominio.recordZeldaGroupDebug({
        chatId,
        groupName: groupSubject,
        configuredGroup: String(match.settings?.zeldaGroupTarget || ""),
        senderName: senderPushName,
        senderPhone,
        fromMe: isFromMe,
        matched: false,
        reason: match.reason || "group_mismatch",
        preview: body,
        handled: false,
        replied: false,
      });
      return;
    }

    const condResult = zeldaCondominio.handleZeldaCondominioCommand(
      body,
      senderPushName,
      senderPhone,
      false,
      chatId,
      botMentioned,
      botProfileName
    );
    let replyText = condResult.handled ? condResult.replyText : null;

    if (!condResult.handled && zeldaCondominio.parseZeldaTrigger(body, match.settings?.zeldaTriggerKeyword, botMentioned, botProfileName).triggered) {
      const customFn =
        customZeldaHandler ||
        global.handleZeldaGroupMessage ||
        global.zeldaResponder ||
        null;
      if (typeof customFn === "function") {
        replyText = await customFn({
          chatId,
          groupName: groupSubject,
          body,
          senderName: senderPushName,
          senderPhone,
          fromMe: isFromMe,
          settings: match.settings,
          rawMessage: msg,
        });
      }
    }

    if (replyText && String(replyText).trim()) {
      try {
        await sendGroupReplySafe(clientOrSock, chatId, replyText, msg);
        zeldaCondominio.recordZeldaGroupDebug({
          chatId,
          groupName: groupSubject,
          configuredGroup: String(match.settings?.zeldaGroupTarget || ""),
          senderName: senderPushName,
          senderPhone,
          fromMe: isFromMe,
          matched: true,
          reason: match.reason || "matched",
          preview: body,
          replyPreview: String(replyText).trim(),
          handled: true,
          replied: true,
        });
        console.log(`[ZELDA CONDOMINIO] Respondido em "${groupSubject || chatId}" (via ${eventSource}).`);
      } catch (sendErr) {
        zeldaCondominio.recordZeldaGroupDebug({
          chatId,
          groupName: groupSubject,
          configuredGroup: String(match.settings?.zeldaGroupTarget || ""),
          senderName: senderPushName,
          senderPhone,
          fromMe: isFromMe,
          matched: true,
          reason: "send_error",
          preview: body,
          replyPreview: String(replyText).trim(),
          handled: true,
          replied: false,
          error: sendErr && sendErr.message ? sendErr.message : String(sendErr),
        });
        console.warn("[ZELDA CONDOMINIO] Falha ao enviar resposta no grupo:", sendErr && sendErr.message ? sendErr.message : sendErr);
      }
    } else {
      zeldaCondominio.recordZeldaGroupDebug({
        chatId,
        groupName: groupSubject,
        configuredGroup: String(match.settings?.zeldaGroupTarget || ""),
        senderName: senderPushName,
        senderPhone,
        fromMe: isFromMe,
        matched: true,
        reason: "passive_non_command_ignored",
        preview: body,
        handled: false,
        replied: false,
      });
    }
  } catch (err) {
    console.warn("[ZELDA CONDOMINIO] Erro tratado com segurança:", err && err.message ? err.message : err);
  }
}

async function processBaileysUpsert(clientOrSock, upsert, customZeldaHandler = null) {
  try {
    global.__zeldaHighLevelClientAttached = true;
    const ownJid = String(clientOrSock?.user?.id || "");
    const ownLid = String(clientOrSock?.user?.lid || "").split(":")[0].split("@")[0];
    const ownDigits = ownJid.split(":")[0].split("@")[0].replace(/\D+/g, "");
    const botProfileName = String(clientOrSock?.user?.name || "").trim();
    zeldaCondominio.markWhatsAppActivityOnline(ownDigits || botProfileName);

    const list = (upsert && upsert.messages) || [];
    for (const m of list) {
      const remoteJid = String(m?.key?.remoteJid || "");
      if (!remoteJid.endsWith("@g.us")) continue;

      const isFromMe = Boolean(m?.key?.fromMe);
      const { text, mentionedJids } = unwrapBaileysMessageContent(m?.message);
      if (!text.trim() || zeldaCondominio.isZeldaSelfEcho(text, isFromMe)) continue;

      const settings = getClinicSettings();
      if (isFromMe && settings.zeldaAllowFromMeTest === false) {
        zeldaCondominio.recordZeldaGroupDebug({
          chatId: remoteJid,
          groupName: groupSubjectCache.get(remoteJid) || "",
          configuredGroup: String(settings.zeldaGroupTarget || ""),
          senderName: botProfileName || "WhatsApp Conectado",
          senderPhone: ownDigits,
          fromMe: true,
          matched: false,
          reason: "fromMe_disabled_in_settings",
          preview: text,
          handled: false,
          replied: false,
        });
        continue;
      }

      const uid = m?.key?.id || `${remoteJid}:${text}:${m?.messageTimestamp || ""}`;
      if (rememberMessageId(uid)) continue;

      const groupSubject = await resolveBaileysGroupSubject(clientOrSock, remoteJid);
      const senderPushName = String(m.pushName || (isFromMe ? botProfileName || "WhatsApp Conectado" : "") || "");
      const senderPhone = String(
        m?.key?.participantAlt ||
          (isFromMe ? ownDigits || ownJid : m?.key?.participant || "")
      );
      const match = matchesConfiguredZeldaGroup(remoteJid, groupSubject);
      if (!match.matched) {
        zeldaCondominio.recordZeldaGroupDebug({
          chatId: remoteJid,
          groupName: groupSubject,
          configuredGroup: String(match.settings?.zeldaGroupTarget || ""),
          senderName: senderPushName,
          senderPhone,
          fromMe: isFromMe,
          matched: false,
          reason: match.reason || "group_mismatch",
          preview: text,
          handled: false,
          replied: false,
        });
        continue;
      }

      const botMentioned = Boolean(
        (ownDigits && mentionedJids.some((j) => String(j).includes(ownDigits))) ||
          (ownLid && mentionedJids.some((j) => String(j).includes(ownLid))) ||
          (botProfileName && new RegExp(`@${botProfileName.replace(/[.*+?^${}()|\[\]\\]/g, "\\$&")}\b`, "i").test(text))
      );

      const condResult = zeldaCondominio.handleZeldaCondominioCommand(
        text,
        senderPushName,
        senderPhone,
        false,
        remoteJid,
        botMentioned,
        botProfileName
      );
      let replyText = condResult.handled ? condResult.replyText : null;

      if (!condResult.handled && zeldaCondominio.parseZeldaTrigger(text, match.settings?.zeldaTriggerKeyword, botMentioned, botProfileName).triggered) {
        const customFn =
          customZeldaHandler ||
          global.handleZeldaGroupMessage ||
          global.zeldaResponder ||
          null;
        if (typeof customFn === "function") {
          replyText = await customFn({
            chatId: remoteJid,
            groupName: groupSubject,
            body: text,
            senderName: senderPushName,
            senderPhone,
            fromMe: isFromMe,
            settings: match.settings,
            rawMessage: m,
          });
        }
      }

      if (replyText && String(replyText).trim()) {
        try {
          await sendGroupReplySafe(clientOrSock, remoteJid, replyText, m);
          zeldaCondominio.recordZeldaGroupDebug({
            chatId: remoteJid,
            groupName: groupSubject,
            configuredGroup: String(match.settings?.zeldaGroupTarget || ""),
            senderName: senderPushName,
            senderPhone,
            fromMe: isFromMe,
            matched: true,
            reason: match.reason || "matched",
            preview: text,
            replyPreview: String(replyText).trim(),
            handled: true,
            replied: true,
          });
          console.log(`[ZELDA CONDOMINIO] Respondido via Baileys em "${groupSubject || remoteJid}".`);
        } catch (sendErr) {
          zeldaCondominio.recordZeldaGroupDebug({
            chatId: remoteJid,
            groupName: groupSubject,
            configuredGroup: String(match.settings?.zeldaGroupTarget || ""),
            senderName: senderPushName,
            senderPhone,
            fromMe: isFromMe,
            matched: true,
            reason: "send_error",
            preview: text,
            replyPreview: String(replyText).trim(),
            handled: true,
            replied: false,
            error: sendErr && sendErr.message ? sendErr.message : String(sendErr),
          });
        }
      } else {
        zeldaCondominio.recordZeldaGroupDebug({
          chatId: remoteJid,
          groupName: groupSubject,
          configuredGroup: String(match.settings?.zeldaGroupTarget || ""),
          senderName: senderPushName,
          senderPhone,
          fromMe: isFromMe,
          matched: true,
          reason: "passive_non_command_ignored",
          preview: text,
          handled: false,
          replied: false,
        });
      }
    }
  } catch (_err) {}
}

// Ponte direta para janelas Electron / BrowserView / Puppeteer com web.whatsapp.com sem whatsapp-web.js/baileys
function processDirectWebBridgePayload(bridgePayload) {
  const repliesToSend = [];
  if (!bridgePayload || typeof bridgePayload !== "object") {
    return { repliesToSend, replies: repliesToSend };
  }
  try {
    const ownPhone = String(bridgePayload.ownPhone || bridgePayload.mePhone || "").trim();
    const botProfileName = String(bridgePayload.botProfileName || bridgePayload.meName || "").trim();
    if (bridgePayload.connected) {
      zeldaCondominio.markWhatsAppActivityOnline(ownPhone || botProfileName);
    }

    if (Array.isArray(bridgePayload.groups)) {
      for (const g of bridgePayload.groups) {
        if (g && g.jid && g.name) {
          groupSubjectCache.set(String(g.jid), String(g.name));
          zeldaCondominio.recordDiscoveredGroup(String(g.jid), String(g.name));
        }
      }
    }
    if (Array.isArray(bridgePayload.sidebarGroups)) {
      for (const gName of bridgePayload.sidebarGroups) {
        const cleanG = String(gName || "").trim();
        if (cleanG) {
          zeldaCondominio.recordDiscoveredGroup(`dom_grp:${cleanG}`, cleanG);
        }
      }
    }

    const incomingList = Array.isArray(bridgePayload.messages) ? bridgePayload.messages : [];
    for (const item of incomingList) {
      if (!item || typeof item !== "object") continue;
      const body = String(item.body ?? item.text ?? "").trim();
      const isFromMe = Boolean(item.fromMe);
      if (!body || zeldaCondominio.isZeldaSelfEcho(body, isFromMe)) continue;

      const chatId = String(item.chatId || "").trim();
      const groupSubject = String(
        item.groupName || item.chatTitle || bridgePayload.activeTitle || groupSubjectCache.get(chatId) || ""
      ).trim();
      if (!chatId && !groupSubject) continue;

      if (chatId && groupSubject) {
        groupSubjectCache.set(chatId, groupSubject);
        zeldaCondominio.recordDiscoveredGroup(chatId, groupSubject);
      } else if (groupSubject) {
        zeldaCondominio.recordDiscoveredGroup(`dom_grp:${groupSubject}`, groupSubject);
      }

      const uid = String(item.id || `${chatId || groupSubject}:${body}:${item.t || ""}`);
      if (rememberMessageId(uid)) continue;

      const settings = getClinicSettings();
      if (isFromMe && settings.zeldaAllowFromMeTest === false) {
        zeldaCondominio.recordZeldaGroupDebug({
          chatId: chatId || `dom_grp:${groupSubject}`,
          groupName: groupSubject,
          configuredGroup: String(settings.zeldaGroupTarget || ""),
          senderName: botProfileName || "WhatsApp Conectado",
          senderPhone: ownPhone,
          fromMe: true,
          matched: false,
          reason: "fromMe_disabled_in_settings",
          preview: body,
          handled: false,
          replied: false,
        });
        continue;
      }

      const senderName = String(
        item.senderName || item.sender || (isFromMe ? botProfileName || "WhatsApp Conectado" : "Conselheiro")
      ).trim();
      const senderPhone = String(item.senderPhone || (isFromMe ? ownPhone : "")).trim();
      const botMentioned =
        Boolean(item.botMentioned) ||
        Boolean(botProfileName && new RegExp(`@${botProfileName.replace(/[.*+?^${}()|\[\]\\]/g, "\\$&")}\b`, "i").test(body));

      const match = matchesConfiguredZeldaGroup(chatId, groupSubject);
      if (!match.matched) {
        zeldaCondominio.recordZeldaGroupDebug({
          chatId: chatId || `dom_grp:${groupSubject}`,
          groupName: groupSubject,
          configuredGroup: String(match.settings?.zeldaGroupTarget || ""),
          senderName,
          senderPhone,
          fromMe: isFromMe,
          matched: false,
          reason: match.reason || "group_mismatch",
          preview: body,
          handled: false,
          replied: false,
        });
        continue;
      }

      const condResult = zeldaCondominio.handleZeldaCondominioCommand(
        body,
        senderName,
        senderPhone,
        false,
        chatId || groupSubject,
        botMentioned,
        botProfileName
      );
      const replyText = condResult.handled && condResult.replyText ? String(condResult.replyText).trim() : "";

      if (replyText) {
        zeldaCondominio.registerZeldaSentReply(replyText);
        repliesToSend.push({
          chatId,
          groupName: groupSubject,
          text: replyText + ZELDA_LOOP_MARKER,
        });
        zeldaCondominio.recordZeldaGroupDebug({
          chatId: chatId || `dom_grp:${groupSubject}`,
          groupName: groupSubject,
          configuredGroup: String(match.settings?.zeldaGroupTarget || ""),
          senderName,
          senderPhone,
          fromMe: isFromMe,
          matched: true,
          reason: match.reason || "matched_web_bridge",
          preview: body,
          replyPreview: replyText,
          handled: true,
          replied: true,
        });
      } else {
        zeldaCondominio.recordZeldaGroupDebug({
          chatId: chatId || `dom_grp:${groupSubject}`,
          groupName: groupSubject,
          configuredGroup: String(match.settings?.zeldaGroupTarget || ""),
          senderName,
          senderPhone,
          fromMe: isFromMe,
          matched: true,
          reason: "passive_non_command_ignored",
          preview: body,
          handled: false,
          replied: false,
        });
      }
    }

    if (
      bridgePayload.connected &&
      !global.__zeldaHighLevelClientAttached &&
      typeof zeldaCondominio.popNextOutboxItemForWebBridge === "function"
    ) {
      const queuedOut = zeldaCondominio.popNextOutboxItemForWebBridge();
      if (queuedOut && queuedOut.text) {
        let matchedJid = "";
        let matchedName = queuedOut.targetGroup;
        for (const [cachedJid, cachedSub] of groupSubjectCache.entries()) {
          if (matchesConfiguredZeldaGroup(cachedJid, cachedSub).matched) {
            matchedJid = cachedJid;
            matchedName = cachedSub || matchedName;
            break;
          }
        }
        zeldaCondominio.registerZeldaSentReply(queuedOut.text);
        repliesToSend.push({
          chatId: matchedJid,
          groupName: matchedName,
          text: queuedOut.text + ZELDA_LOOP_MARKER,
        });
      }
    }
  } catch (_eBridge) {}
  return { repliesToSend, replies: repliesToSend };
}

function attachZeldaGroupListener(clientOrSock, customZeldaHandler = null) {
  if (!clientOrSock || clientOrSock.__zeldaGroupGuardAttached) return clientOrSock;
  clientOrSock.__zeldaGroupGuardAttached = true;

  // Anexa monitor real de conexão WhatsApp
  zeldaCondominio.attachConnectionMonitor(clientOrSock);

  // Varredura inicial caso já esteja conectado
  setTimeout(() => {
    scanAndCacheAllGroups(clientOrSock).catch(() => {});
  }, 1500);

  // --- MODO A: whatsapp-web.js (EventEmitter com .on('message') / .on('message_create')) ---
  if (typeof clientOrSock.on === "function" && (typeof clientOrSock.sendMessage === "function" || typeof clientOrSock.sendText === "function")) {
    clientOrSock.on("ready", () => {
      global.__zeldaHighLevelClientAttached = true;
      scanAndCacheAllGroups(clientOrSock).catch(() => {});
    });
    clientOrSock.on("message", (msg) => processSingleWwebMessage(clientOrSock, msg, "message", customZeldaHandler));
    clientOrSock.on("message_create", (msg) => {
      if (msg && (msg.fromMe || msg._data?.id?.fromMe)) {
        return processSingleWwebMessage(clientOrSock, msg, "message_create_fromMe", customZeldaHandler);
      }
      return undefined;
    });
  }

  // --- MODO B: Baileys (@whiskeysockets/baileys) ---
  if (clientOrSock.ev && typeof clientOrSock.ev.on === "function") {
    global.__zeldaHighLevelClientAttached = true;
    clientOrSock.ev.on("connection.update", (upd) => {
      if (upd && upd.connection === "open") {
        scanAndCacheAllGroups(clientOrSock).catch(() => {});
      }
    });
    clientOrSock.ev.on("groups.upsert", (groups) => {
      for (const g of groups || []) {
        if (g?.id && g?.subject) {
          groupSubjectCache.set(g.id, String(g.subject));
          zeldaCondominio.recordDiscoveredGroup(g.id, String(g.subject));
        }
      }
    });
    clientOrSock.ev.on("groups.update", (updates) => {
      for (const u of updates || []) {
        if (u?.id && u?.subject) {
          groupSubjectCache.set(u.id, String(u.subject));
          zeldaCondominio.recordDiscoveredGroup(u.id, String(u.subject));
        }
      }
    });
    clientOrSock.ev.on("messages.upsert", (upsert) =>
      processBaileysUpsert(clientOrSock, upsert, customZeldaHandler)
    );
  }

  // --- MODO C: WPPConnect / Venom-bot / Wrappers híbridos (deduplicado por rememberMessageId!) ---
  if (typeof clientOrSock.onAnyMessage === "function") {
    global.__zeldaHighLevelClientAttached = true;
    clientOrSock.onAnyMessage((msg) =>
      processSingleWwebMessage(clientOrSock, msg, "wppconnect_onAnyMessage", customZeldaHandler)
    );
  } else if (typeof clientOrSock.onMessage === "function") {
    global.__zeldaHighLevelClientAttached = true;
    clientOrSock.onMessage((msg) =>
      processSingleWwebMessage(clientOrSock, msg, "wppconnect_onMessage", customZeldaHandler)
    );
  }

  return clientOrSock;
}

module.exports = {
  ZELDA_LOOP_MARKER,
  normalizeGroupToken,
  compactGroupToken,
  matchesConfiguredZeldaGroup,
  shouldIgnoreGroupForGeneralBot,
  extractWwebGroupChatId,
  unwrapBaileysMessageContent,
  processSingleWwebMessage,
  processBaileysUpsert,
  processDirectWebBridgePayload,
  scanAndCacheAllGroups,
  attachZeldaGroupListener,
  zeldaCondominio,
};

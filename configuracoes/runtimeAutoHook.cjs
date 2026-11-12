// configuracoes/runtimeAutoHook.cjs
// Auto-hook universal em Module._load + EventEmitter.prototype.emit para conectar WhatsApp em tempo real

process.env.TZ = "America/Sao_Paulo";

const Module = require("module");
const EventEmitter = require("events");
const http = require("http");
const configMgr = require("./configManager.cjs");
const antiBan = require("./antiBanEngine.cjs");
const zeldaCond = require("./zeldaCondominioEngine.cjs");
const zeldaGuard = require("./zeldaGroupGuard.cjs");
const dashEngine = require("./serenaDashboardEngine.cjs");

const seenInboundIds = new Set();
function isDuplicateMsg(id) {
  if (!id) return false;
  if (seenInboundIds.has(id)) return true;
  seenInboundIds.add(id);
  if (seenInboundIds.size > 600) {
    const first = seenInboundIds.values().next().value;
    seenInboundIds.delete(first);
  }
  return false;
}

// Ponte HTTP local embutida (127.0.0.1:17890) caso o sincronizador-local.ps1 nao esteja rodando apos reiniciar o PC
function startEmbeddedLocalSyncServerIfFree() {
  if (global.__serenaEmbeddedSyncServerStarted) return;
  global.__serenaEmbeddedSyncServerStarted = true;

  const timer = setTimeout(() => {
    try {
      const sendCorsJson = (res, code, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(code, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Private-Network": "true",
          "Content-Length": Buffer.byteLength(body, "utf8"),
          Connection: "close",
        });
        res.end(body);
      };

      const srv = http.createServer((req, res) => {
        try {
          const method = String(req.method || "GET").toUpperCase();
          if (method === "OPTIONS") {
            res.writeHead(204, {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "*",
              "Access-Control-Allow-Private-Network": "true",
              "Content-Length": "0",
              Connection: "close",
            });
            res.end();
            return;
          }

          const rawUrl = String(req.url || "/");
          const [urlPath, rawQuery = ""] = rawUrl.split("?");

          if (method === "GET" && urlPath === "/status") {
            sendCorsJson(res, 200, {
              ok: true,
              source: "embedded_node_bridge",
              targetDir: process.cwd(),
              settings: configMgr.getClinicSettings(),
              whatsappConnection: zeldaCond.getWhatsAppConnectionStatus(),
              zeldaActivities: zeldaCond.loadActivities(),
              zeldaDiscoveredGroups: zeldaCond.getDiscoveredGroups(),
              zeldaGroupDebug: zeldaCond.getZeldaGroupDebugLog(),
            });
            return;
          }

          if (method === "GET" && urlPath === "/dashboard-metrics") {
            const params = new URLSearchParams(rawQuery);
            const dateFilter = params.get("date") || "all";
            sendCorsJson(res, 200, dashEngine.computeDashboardMetrics(dateFilter));
            return;
          }

          if (method === "GET" && urlPath === "/zelda-activities") {
            sendCorsJson(res, 200, { ok: true, activities: zeldaCond.loadActivities() });
            return;
          }

          const chunks = [];
          req.on("data", (c) => {
            chunks.push(c);
          });
          req.on("end", () => {
            try {
              const rawBody = Buffer.concat(chunks).toString("utf8");
              const parsed = rawBody.trim() ? JSON.parse(rawBody) : {};

              if (method === "POST" && urlPath === "/shutdown") {
                sendCorsJson(res, 200, { ok: true });
                try { srv.close(); } catch (_eClose) {}
                return;
              }

              if (method === "POST" && urlPath === "/zelda-activities") {
                const list = Array.isArray(parsed.activities) ? parsed.activities : [];
                const saved = zeldaCond.saveActivities(list);
                if (parsed.outboxText && String(parsed.outboxText).trim()) {
                  const st = configMgr.getClinicSettings();
                  zeldaCond.enqueueGroupMessage(String(parsed.outboxText).trim(), st.zeldaGroupTarget || "");
                }
                sendCorsJson(res, 200, { ok: true, count: saved.length, activities: saved });
                return;
              }

              if (method === "POST" && urlPath === "/sync-settings") {
                let updatedSettings = configMgr.getClinicSettings();
                if (parsed && parsed.settings && typeof parsed.settings === "object") {
                  const cur = configMgr.getClinicSettings();
                  const nextPatch = Object.assign({}, cur, parsed.settings);
                  const incGrp = String(parsed.settings.zeldaGroupTarget ?? "").trim();
                  if (!incGrp && parsed.clearZeldaGroup !== true && cur.zeldaGroupTarget) {
                    nextPatch.zeldaGroupTarget = cur.zeldaGroupTarget;
                    nextPatch.grupoZelda = cur.zeldaGroupTarget;
                  }
                  updatedSettings = configMgr.saveClinicSettings(nextPatch);
                }
                sendCorsJson(res, 200, {
                  ok: true,
                  targetDir: process.cwd(),
                  writtenCount: 1,
                  settings: updatedSettings,
                });
                return;
              }

              sendCorsJson(res, 404, { error: "Not found" });
            } catch (_eBody) {
              sendCorsJson(res, 400, { ok: false, error: "Invalid request payload" });
            }
          });
        } catch (_eReq) {
          try { res.end(); } catch (_e2) {}
        }
      });

      srv.on("error", () => {
        // Porta 17890 ja ocupada pelo sincronizador-local.ps1; segue normalmente sem conflito
      });
      srv.listen(17890, "127.0.0.1", () => {
        if (typeof srv.unref === "function") srv.unref();
      });
      if (typeof srv.unref === "function") srv.unref();
    } catch (_eSrv) {}
  }, 900);
  if (typeof timer.unref === "function") timer.unref();
}

// Scripts universais da Ponte Direta WhatsApp Web (Comet 2024-2026 window.require + Store + WPP + DOM texto puro)
// 100% passivos e isolados para grupos (@g.us): JAMAIS leem, clicam ou alteram conversas 1:1 da Serena!
const WA_WEB_BRIDGE_POLL_SCRIPT = `(function() {
  try {
    if (!/whatsapp\\.com/i.test(location.hostname)) return null;
    if (!window.__zeldaWaWebBridgeState) {
      window.__zeldaWaWebBridgeState = {
        bootedAtSec: Math.floor(Date.now() / 1000) - 5,
        initialDomSeedDone: false,
        seenIds: {}
      };
    }
    var st = window.__zeldaWaWebBridgeState;
    var hasMainChatList = Boolean(document.querySelector("#pane-side, [data-testid='chat-list'], #side"));
    var groups = [];
    var messages = [];
    var ownPhone = "";
    var botProfileName = "";

    try {
      if (window.WPP && window.WPP.conn && typeof window.WPP.conn.getMyUserId === "function") {
        var myId = window.WPP.conn.getMyUserId();
        if (myId && myId.user) ownPhone = String(myId.user);
      }
    } catch (_e0) {}

    // A) Resolucao de colecoes internas do WhatsApp Web (window.Store + WhatsApp Web Comet window.require)
    var storeChats = null;
    try {
      if (window.Store && window.Store.Chat && typeof window.Store.Chat.getModelsArray === "function") {
        storeChats = window.Store.Chat.getModelsArray();
      }
      if (window.Store && window.Store.Conn) {
        ownPhone = ownPhone || String((window.Store.Conn.wid && window.Store.Conn.wid.user) || "");
        botProfileName = botProfileName || String(window.Store.Conn.pushname || "");
      }
    } catch (_e1) {}

    if (!storeChats && typeof window.require === "function") {
      try {
        var waCol = null;
        try { waCol = window.require("WAWebCollections"); } catch (_ec1) {}
        if (waCol && waCol.Chat) {
          storeChats = typeof waCol.Chat.getModelsArray === "function" ? waCol.Chat.getModelsArray() : (waCol.Chat._models || null);
        }
        if (!storeChats) {
          var chatColMod = null;
          try { chatColMod = window.require("WAWebChatCollection"); } catch (_ec2) {}
          var cc = chatColMod && (chatColMod.ChatCollection || chatColMod.default);
          if (cc) {
            storeChats = typeof cc.getModelsArray === "function" ? cc.getModelsArray() : (cc._models || null);
          }
        }
        try {
          var connMod = window.require("WAWebConnModel");
          var connObj = connMod && (connMod.Conn || connMod.default);
          if (connObj) {
            ownPhone = ownPhone || String((connObj.wid && connObj.wid.user) || "");
            botProfileName = botProfileName || String(connObj.pushname || "");
          }
        } catch (_ec3) {}
        if (!ownPhone) {
          try {
            var mePrefs = window.require("WAWebUserPrefsMeUser");
            var meWid = mePrefs && (
              (typeof mePrefs.getMaybeMePnUser === "function" && mePrefs.getMaybeMePnUser()) ||
              (typeof mePrefs.getMaybeMeUser === "function" && mePrefs.getMaybeMeUser())
            );
            if (meWid && meWid.user) ownPhone = String(meWid.user);
          } catch (_ec4) {}
        }
      } catch (_eComet) {}
    }

    if (Array.isArray(storeChats)) {
      for (var ci = 0; ci < storeChats.length; ci++) {
        var ch = storeChats[ci];
        var jid = ch && ch.id ? String(ch.id._serialized || (ch.id.user && ch.id.server ? (ch.id.user + "@" + ch.id.server) : ch.id)) : "";
        if (!jid || jid.indexOf("@g.us") < 0) continue;
        var gName = String(
          ch.name ||
          ch.formattedTitle ||
          (ch.contact && ch.contact.name) ||
          (ch.groupMetadata && ch.groupMetadata.subject) ||
          ""
        ).trim();
        if (gName) groups.push({ jid: jid, name: gName });

        var msgsArr = [];
        if (ch.msgs) {
          if (typeof ch.msgs.getModelsArray === "function") msgsArr = ch.msgs.getModelsArray();
          else if (Array.isArray(ch.msgs._models)) msgsArr = ch.msgs._models;
        }
        var tail = msgsArr.slice(-10);
        for (var mi = 0; mi < tail.length; mi++) {
          var m = tail[mi];
          if (!m) continue;
          var mid = String((m.id && m.id._serialized) || (m.id && m.id.id) || m.id || "");
          if (!mid || st.seenIds[mid]) continue;
          var mTs = Number(m.t || 0);
          if (mTs > 0 && mTs < st.bootedAtSec) {
            st.seenIds[mid] = 1;
            continue;
          }
          var mBody = String(m.body || m.caption || m.text || "").trim();
          if (!mBody) continue;
          st.seenIds[mid] = 1;

          var mentionedList = [];
          if (Array.isArray(m.mentionedJidList)) {
            for (var mji = 0; mji < m.mentionedJidList.length; mji++) {
              var mj = m.mentionedJidList[mji];
              mentionedList.push(String((mj && mj._serialized) || (mj && mj.user) || mj || ""));
            }
          }
          var isBotMent = Boolean(
            ownPhone && mentionedList.some(function(x) { return x.indexOf(ownPhone) >= 0; })
          );

          messages.push({
            id: mid,
            chatId: jid,
            groupName: gName,
            body: mBody,
            fromMe: Boolean((m.id && m.id.fromMe) || m.fromMe),
            senderName: String(m.notifyName || (m.senderObj && (m.senderObj.pushname || m.senderObj.name)) || ""),
            senderPhone: String((m.author && (m.author.user || m.author._serialized || m.author)) || ""),
            botMentioned: isBotMent,
            t: mTs || Math.floor(Date.now() / 1000)
          });
        }
      }
    }

    // B) Fallback DOM universal no WhatsApp Web (somente grupos @g.us; ignora 100% conversas 1:1 da Serena!)
    var sideTitles = document.querySelectorAll("#pane-side span[title], [data-testid='chat-list'] span[title]");
    for (var si = 0; si < Math.min(sideTitles.length, 45); si++) {
      var tVal = String(sideTitles[si].getAttribute("title") || "").trim();
      if (tVal && tVal.length >= 2 && tVal.length <= 80 && !/^\\+?\\d[\\d\\s().-]{6,}$/.test(tVal)) {
        var existsG = false;
        for (var gi = 0; gi < groups.length; gi++) {
          if (groups[gi].name.toLowerCase() === tVal.toLowerCase()) { existsG = true; break; }
        }
        if (!existsG) groups.push({ jid: "dom_grp:" + tVal, name: tVal });
      }
    }

    var activeHeaderTitleEl = document.querySelector("#main header span[title]");
    var activeChatTitle = activeHeaderTitleEl ? String(activeHeaderTitleEl.getAttribute("title") || "").trim() : "";
    var isPhoneTitle = /^\\+?\\d[\\d\\s().-]{6,}$/.test(activeChatTitle);

    if (activeChatTitle && !isPhoneTitle) {
      var msgRows = document.querySelectorAll("#main [data-id]");
      if (!st.initialDomSeedDone) {
        for (var bi = 0; bi < msgRows.length; bi++) {
          var bid = msgRows[bi].getAttribute("data-id") || "";
          if (bid) st.seenIds[bid] = 1;
        }
        st.initialDomSeedDone = true;
      } else {
        var startIdx = Math.max(0, msgRows.length - 8);
        for (var ri = startIdx; ri < msgRows.length; ri++) {
          var row = msgRows[ri];
          var did = String(row.getAttribute("data-id") || "");
          if (!did || st.seenIds[did]) continue;
          // Isolamento absoluto da Serena: se o data-id for conversa privada (@c.us / @s.whatsapp.net sem @g.us), ignora!
          if ((did.indexOf("@c.us") >= 0 || did.indexOf("@s.whatsapp.net") >= 0) && did.indexOf("@g.us") < 0) {
            st.seenIds[did] = 1;
            continue;
          }
          var copyable = row.querySelector(
            "span.selectable-text.copyable-text, .selectable-text.copyable-text span, [data-testid='msg-container'] span.selectable-text, span._ao3e.selectable-text"
          );
          var txt = copyable ? String(copyable.innerText || copyable.textContent || "").trim() : "";
          if (!txt) continue;
          st.seenIds[did] = 1;

          var fromMeDom = did.indexOf("true_") === 0 || Boolean(row.closest(".message-out")) || Boolean(row.querySelector(".message-out"));
          var extractedJid = "";
          var jidMatch = did.match(/(\\d+[\\d-]*@g\\.us)/);
          if (jidMatch) extractedJid = jidMatch[1];

          var domSender = "";
          var prePlainHolder = row.querySelector("[data-pre-plain-text]");
          if (prePlainHolder) {
            var preAttr = String(prePlainHolder.getAttribute("data-pre-plain-text") || "");
            var senderMatch = preAttr.match(/\\]\\s*([^:]+):\\s*$/);
            if (senderMatch && senderMatch[1]) domSender = senderMatch[1].trim();
          }

          if (extractedJid || did.indexOf("@g.us") >= 0) {
            messages.push({
              id: did,
              chatId: extractedJid || ("dom_grp:" + activeChatTitle),
              groupName: activeChatTitle,
              body: txt,
              fromMe: fromMeDom,
              senderName: domSender || (fromMeDom ? (botProfileName || "WhatsApp Conectado") : "Integrante do Grupo"),
              senderPhone: fromMeDom ? ownPhone : "",
              t: Math.floor(Date.now() / 1000)
            });
          }
        }
      }
    } else if (!st.initialDomSeedDone && hasMainChatList) {
      st.initialDomSeedDone = true;
    }

    return {
      connected: hasMainChatList || Boolean(storeChats && storeChats.length > 0),
      ownPhone: ownPhone,
      botProfileName: botProfileName || "",
      groups: groups.slice(0, 45),
      messages: messages
    };
  } catch (_err) {
    return null;
  }
})();`;

const buildWaWebSendScript = (replyItem) => `(async function() {
  try {
    var targetJid = ${JSON.stringify(replyItem.chatId || "")};
    var targetName = ${JSON.stringify(replyItem.groupName || "")};
    var outText = ${JSON.stringify(replyItem.text || "")};
    if (!outText) return false;

    // 1) WPP API em background (sem mexer na tela aberta!)
    if (window.WPP && window.WPP.chat && typeof window.WPP.chat.sendTextMessage === "function" && targetJid.endsWith("@g.us")) {
      await window.WPP.chat.sendTextMessage(targetJid, outText, { createChat: false });
      return true;
    }
    // 2) Store legado em background
    if (window.Store && window.Store.Chat && window.Store.SendTextMsgToChat && targetJid.endsWith("@g.us")) {
      var c = window.Store.Chat.get(targetJid);
      if (c) {
        await window.Store.SendTextMsgToChat(c, outText);
        return true;
      }
    }
    // 3) WhatsApp Web Comet (window.require) em background — nao muda de conversa!
    if (typeof window.require === "function" && targetJid.endsWith("@g.us")) {
      try {
        var waCol2 = null;
        try { waCol2 = window.require("WAWebCollections"); } catch (_er1) {}
        var chatObj = waCol2 && waCol2.Chat && typeof waCol2.Chat.get === "function" ? waCol2.Chat.get(targetJid) : null;
        if (!chatObj) {
          var ccMod = null;
          try { ccMod = window.require("WAWebChatCollection"); } catch (_er2) {}
          var cc2 = ccMod && (ccMod.ChatCollection || ccMod.default);
          if (cc2 && typeof cc2.get === "function") chatObj = cc2.get(targetJid);
        }
        if (chatObj) {
          var sendAct = null;
          try { sendAct = window.require("WAWebSendMsgChatAction"); } catch (_er3) {}
          if (sendAct && typeof sendAct.sendTextMsgToChat === "function") {
            await sendAct.sendTextMsgToChat(chatObj, outText);
            return true;
          }
        }
      } catch (_eCometSend) {}
    }

    // 4) Fallback DOM seguro: nunca interrompe se houver rascunho ativo em outra conversa 1:1
    var activeTitleEl = document.querySelector("#main header span[title]");
    var curTitle = activeTitleEl ? String(activeTitleEl.getAttribute("title") || "").trim().toLowerCase() : "";
    var targetLower = String(targetName || "").trim().toLowerCase();
    var existingBox = document.querySelector("#main footer div[contenteditable='true']");
    if (curTitle && targetLower && curTitle !== targetLower && existingBox && String(existingBox.textContent || "").trim().length > 0) {
      return false;
    }

    if (targetLower && curTitle !== targetLower) {
      var sideSpans = document.querySelectorAll("#pane-side span[title]");
      for (var i = 0; i < sideSpans.length; i++) {
        var spTitle = String(sideSpans[i].getAttribute("title") || "").trim().toLowerCase();
        if (spTitle === targetLower || (spTitle && spTitle.indexOf(targetLower) >= 0)) {
          var rowTarget = sideSpans[i].closest("[role='listitem'], [role='row'], div[tabindex]") || sideSpans[i];
          rowTarget.click();
          await new Promise(function(r) { setTimeout(r, 450); });
          break;
        }
      }
    }
    var box = document.querySelector("#main footer div[contenteditable='true']");
    if (!box) return false;
    box.focus();
    document.execCommand("insertText", false, outText);
    await new Promise(function(r) { setTimeout(r, 180); });
    var sendBtn = document.querySelector("#main footer button[aria-label*='Enviar'], #main footer button[aria-label*='Send'], #main footer span[data-icon='send']");
    if (sendBtn) {
      var clickable = sendBtn.closest("button") || sendBtn;
      clickable.click();
      return true;
    }
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    return true;
  } catch (_eSend) {
    return false;
  }
})();`;

function attachClientOrSocketHooks(clientOrSock) {
  if (!clientOrSock || typeof clientOrSock !== "object") return clientOrSock;
  if (clientOrSock.__serenaUniversalHookAttached) return clientOrSock;
  clientOrSock.__serenaUniversalHookAttached = true;

  try { antiBan.installBulkAntiBanHook(clientOrSock); } catch (_e) {}
  try { zeldaCond.attachConnectionMonitor(clientOrSock); } catch (_e) {}
  try { zeldaGuard.attachZeldaGroupListener(clientOrSock); } catch (_e) {}

  // Captura 1:1 de entrada de leads para o Dashboard da Serena (ignora grupos @g.us!)
  if (typeof clientOrSock.on === "function") {
    clientOrSock.__serenaLeadTrackerAttached = true;
    clientOrSock.on("message", async (msg) => {
      try {
        zeldaCond.markWhatsAppActivityOnline(clientOrSock.info?.wid?.user || "");
        if (!msg || msg.fromMe) return;
        const chatId = String(msg.from || msg.id?.remote || "");
        if (!chatId || chatId.endsWith("@g.us") || chatId.endsWith("@broadcast") || chatId === "status@broadcast") return;
        const body = String(msg.body || "").trim();
        if (!body) return;
        const msgId = msg.id?._serialized || msg.id?.id || `${chatId}:${msg.timestamp || Date.now()}:${body.slice(0, 24)}`;
        if (isDuplicateMsg(msgId)) return;
        let senderPhone = chatId;
        let pushName = String(msg._data?.notifyName || "");
        try {
          if (chatId.endsWith("@lid") && typeof msg.getContact === "function") {
            const c = await msg.getContact().catch(() => null);
            if (c && c.number) senderPhone = String(c.number);
            if (c && !pushName) pushName = String(c.pushname || c.name || "");
          }
        } catch (_eLid) {}
        dashEngine.recordLeadInbound(senderPhone, pushName, body, msg.timestamp || null);
      } catch (_err) {}
    });
  }

  if (clientOrSock.ev && typeof clientOrSock.ev.on === "function") {
    clientOrSock.ev.on("messages.upsert", (upsert) => {
      try {
        zeldaCond.markWhatsAppActivityOnline(clientOrSock.user?.id || "");
        const list = (upsert && upsert.messages) || [];
        for (const m of list) {
          if (!m || m?.key?.fromMe) continue;
          const jid = String(m?.key?.remoteJid || "");
          if (!jid || jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid === "status@broadcast") continue;
          const unwrapped = typeof zeldaGuard.unwrapBaileysMessageContent === "function"
            ? zeldaGuard.unwrapBaileysMessageContent(m.message)
            : m.message;
          const txt = String(
            unwrapped?.text ||
            unwrapped?.conversation ||
            unwrapped?.extendedTextMessage?.text ||
            unwrapped?.imageMessage?.caption ||
            ""
          ).trim();
          if (!txt) continue;
          const uid = m?.key?.id || `${jid}:${m.messageTimestamp || Date.now()}`;
          if (isDuplicateMsg(uid)) continue;
          const ph = String(m?.key?.remoteJidAlt || jid);
          dashEngine.recordLeadInbound(ph, m.pushName || "", txt, Number(m.messageTimestamp || 0) || null);
        }
      } catch (_err) {}
    });
  }

  return clientOrSock;
}

const baileysProxyCache = new WeakMap();
function wrapBaileysExportsSafe(exported) {
  if (!exported || (typeof exported !== "object" && typeof exported !== "function")) return exported;
  if (baileysProxyCache.has(exported)) return baileysProxyCache.get(exported);

  const proxy = new Proxy(exported, {
    apply(target, thisArg, argArray) {
      const sock = Reflect.apply(target, thisArg, argArray);
      if (sock && typeof sock.then === "function") {
        return sock.then((s) => attachClientOrSocketHooks(s));
      }
      return attachClientOrSocketHooks(sock);
    },
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if ((prop === "default" || prop === "makeWASocket") && typeof val === "function") {
        return function (...args) {
          const sock = val.apply(this, args);
          if (sock && typeof sock.then === "function") {
            return sock.then((s) => attachClientOrSocketHooks(s));
          }
          return attachClientOrSocketHooks(sock);
        };
      }
      return val;
    },
  });

  baileysProxyCache.set(exported, proxy);
  return proxy;
}

// Monitora instancias Puppeteer / Playwright que abram web.whatsapp.com diretamente sem whatsapp-web.js/wppconnect
function attachBrowserAutomationBridge(browserOrCtx) {
  if (!browserOrCtx || typeof browserOrCtx !== "object" || browserOrCtx.__zeldaAutomationHooked) return browserOrCtx;
  browserOrCtx.__zeldaAutomationHooked = true;

  const pollPages = async () => {
    try {
      if (global.__zeldaHighLevelClientAttached) return;
      if (typeof browserOrCtx.pages !== "function") return;
      const pages = await Promise.resolve(browserOrCtx.pages()).catch(() => []);
      for (const pg of pages || []) {
        if (!pg || (typeof pg.isClosed === "function" && pg.isClosed())) continue;
        const pUrl = typeof pg.url === "function" ? String(pg.url() || "") : "";
        if (!/whatsapp\.com/i.test(pUrl)) continue;
        if (typeof pg.evaluate !== "function") continue;
        const snap = await pg.evaluate(WA_WEB_BRIDGE_POLL_SCRIPT).catch(() => null);
        if (snap && typeof zeldaGuard.processDirectWebBridgePayload === "function") {
          const res = zeldaGuard.processDirectWebBridgePayload(snap);
          if (res && Array.isArray(res.repliesToSend)) {
            for (const rep of res.repliesToSend) {
              await pg.evaluate(buildWaWebSendScript(rep)).catch(() => {});
            }
          }
        }
      }
    } catch (_ePag) {}
  };

  const t = setInterval(pollPages, 1900);
  if (typeof t.unref === "function") t.unref();
  if (typeof browserOrCtx.on === "function") {
    browserOrCtx.on("disconnected", () => clearInterval(t));
    browserOrCtx.on("close", () => clearInterval(t));
  }
  return browserOrCtx;
}

const automationProxyCache = new WeakMap();
function wrapBrowserAutomationExports(exported) {
  if (!exported || (typeof exported !== "object" && typeof exported !== "function")) return exported;
  if (automationProxyCache.has(exported)) return automationProxyCache.get(exported);

  const wrapLauncherObj = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    return new Proxy(obj, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if ((p === "launch" || p === "connect" || p === "launchPersistentContext") && typeof v === "function") {
          return async function (...args) {
            const inst = await v.apply(t, args);
            return attachBrowserAutomationBridge(inst);
          };
        }
        if ((p === "default" || p === "chromium" || p === "firefox" || p === "webkit") && v && typeof v === "object") {
          return wrapLauncherObj(v);
        }
        return v;
      },
    });
  };

  const wrapped = wrapLauncherObj(exported);
  automationProxyCache.set(exported, wrapped);
  return wrapped;
}

function looksLikeWhatsAppClientEmitter(emitter, eventName) {
  if (!emitter || typeof emitter !== "object") return false;
  if (emitter.__serenaUniversalHookAttached) return false;
  if (
    eventName !== "ready" &&
    eventName !== "authenticated" &&
    eventName !== "message" &&
    eventName !== "message_create" &&
    eventName !== "qr" &&
    eventName !== "change_state"
  ) {
    return false;
  }
  return Boolean(
    typeof emitter.sendMessage === "function" ||
    typeof emitter.sendText === "function" ||
    typeof emitter.getChats === "function" ||
    emitter.pupPage ||
    emitter.pupBrowser ||
    (emitter.options && emitter.options.authStrategy)
  );
}

function installEventEmitterFallbackHook() {
  if (!EventEmitter || !EventEmitter.prototype || EventEmitter.prototype.__serenaEmitHooked) return;
  const origEmit = EventEmitter.prototype.emit;
  if (typeof origEmit !== "function") return;

  const hookedEmit = function (eventName, ...args) {
    try {
      if (looksLikeWhatsAppClientEmitter(this, eventName)) {
        attachClientOrSocketHooks(this);
        if (eventName === "ready" || eventName === "authenticated") {
          zeldaCond.markWhatsAppActivityOnline(this.info?.wid?.user || "");
          if (typeof zeldaGuard.scanAndCacheAllGroups === "function") {
            setTimeout(() => {
              zeldaGuard.scanAndCacheAllGroups(this).catch(() => {});
            }, 1200);
          }
        }
      } else if (
        eventName === "messages.upsert" &&
        args[0] &&
        Array.isArray(args[0].messages) &&
        !global.__zeldaHighLevelClientAttached
      ) {
        // Fallback para Baileys empacotado (esbuild/webpack) onde Module._load("baileys") foi embutido no bundle
        const candidateSock = global.sock || global.whatsappSock || global.waSocket || null;
        if (candidateSock && typeof candidateSock.sendMessage === "function") {
          attachClientOrSocketHooks(candidateSock);
          zeldaGuard.processBaileysUpsert(candidateSock, args[0]).catch(() => {});
        }
      }
    } catch (_eEmitHook) {}
    return origEmit.call(this, eventName, ...args);
  };
  Object.defineProperty(hookedEmit, "__serenaEmitHooked", { value: true });
  EventEmitter.prototype.emit = hookedEmit;
}

function installRuntimeModuleHooks() {
  if (global.__serenaRuntimeAutoHookInstalled) return;
  global.__serenaRuntimeAutoHookInstalled = true;

  installEventEmitterFallbackHook();
  startEmbeddedLocalSyncServerIfFree();

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const exported = origLoad.apply(this, arguments);
    try {
      const reqStr = String(request || "");
      // 1) whatsapp-web.js (inclusive forks e subpaths)
      if (reqStr === "whatsapp-web.js" || reqStr.endsWith("/whatsapp-web.js") || reqStr.includes("whatsapp-web.js")) {
        if (exported && exported.Client && exported.Client.prototype && !exported.Client.prototype.__serenaAutoProtoHooked) {
          exported.Client.prototype.__serenaAutoProtoHooked = true;
          const origInit = exported.Client.prototype.initialize;
          if (typeof origInit === "function") {
            exported.Client.prototype.initialize = function (...args) {
              attachClientOrSocketHooks(this);
              return origInit.apply(this, args);
            };
          }
        }
      }
      // 2) Baileys (@whiskeysockets/baileys / @adiwajshing/baileys / baileys) via Proxy
      if (reqStr.includes("baileys")) {
        return wrapBaileysExportsSafe(exported);
      }
      // 3) WPPConnect / Venom
      if ((reqStr.includes("wppconnect") || reqStr.includes("venom-bot")) && exported && typeof exported.create === "function" && !exported.__serenaCreateWrapped) {
        return new Proxy(exported, {
          get(target, prop, receiver) {
            const val = Reflect.get(target, prop, receiver);
            if (prop === "create" && typeof val === "function") {
              return async function (...args) {
                const cli = await val.apply(this, args);
                return attachClientOrSocketHooks(cli);
              };
            }
            return val;
          },
        });
      }
      // 4) Puppeteer / Playwright diretos (quando mm-sender automatiza Chrome/Edge em web.whatsapp.com)
      if (
        reqStr === "puppeteer" ||
        reqStr === "puppeteer-core" ||
        reqStr === "playwright" ||
        reqStr === "playwright-core" ||
        reqStr.startsWith("puppeteer-extra")
      ) {
        return wrapBrowserAutomationExports(exported);
      }
      // 5) Electron webContents + Ponte Direta WhatsApp Web (BrowserWindow / BrowserView / WebContentsView / webview)
      if (reqStr === "electron" && exported && exported.app && typeof exported.app.on === "function" && !exported.app.__serenaUiWinHooked) {
        exported.app.__serenaUiWinHooked = true;

        const attachToElectronWebContents = (contents) => {
          if (!contents || contents.__serenaWcHooked) return;
          contents.__serenaWcHooked = true;

          let waPollTimer = null;
          const ensureWaWebPolling = () => {
            if (waPollTimer) return;
            waPollTimer = setInterval(async () => {
              try {
                if (contents.isDestroyed && contents.isDestroyed()) {
                  clearInterval(waPollTimer);
                  waPollTimer = null;
                  return;
                }
                if (global.__zeldaHighLevelClientAttached) return;
                const currentUrl = String(contents.getURL ? contents.getURL() : "");
                if (!/whatsapp\.com/i.test(currentUrl)) return;
                const snap = await contents.executeJavaScript(WA_WEB_BRIDGE_POLL_SCRIPT, true).catch(() => null);
                if (snap && typeof zeldaGuard.processDirectWebBridgePayload === "function") {
                  const res = zeldaGuard.processDirectWebBridgePayload(snap);
                  if (res && Array.isArray(res.repliesToSend)) {
                    for (const rep of res.repliesToSend) {
                      await contents.executeJavaScript(buildWaWebSendScript(rep), true).catch(() => {});
                    }
                  }
                }
              } catch (_ePoll) {}
            }, 1800);
            if (typeof waPollTimer.unref === "function") waPollTimer.unref();
          };

          // Verifica imediatamente caso a aba do WhatsApp Web ja esteja carregada
          try {
            const existingUrl = String(contents.getURL ? contents.getURL() : "");
            if (/whatsapp\.com/i.test(existingUrl)) {
              ensureWaWebPolling();
            }
          } catch (_eInitUrl) {}

          contents.on("did-navigate", (_e, navUrl) => {
            if (/whatsapp\.com/i.test(String(navUrl || ""))) ensureWaWebPolling();
          });
          contents.on("did-navigate-in-page", (_e, navUrl) => {
            if (/whatsapp\.com/i.test(String(navUrl || ""))) ensureWaWebPolling();
          });

          contents.on("did-finish-load", () => {
            try {
              const loadedUrl = String(contents.getURL ? contents.getURL() : "");
              if (/whatsapp\.com/i.test(loadedUrl)) {
                ensureWaWebPolling();
                return;
              }
              const fsMod = require("fs");
              const pathMod = require("path");
              const candidates = [
                pathMod.join(__dirname, "serena-ui-injector.html"),
                pathMod.join(process.cwd(), "configuracoes", "serena-ui-injector.html"),
              ];
              if (process.resourcesPath) {
                candidates.push(
                  pathMod.join(process.resourcesPath, "app", "configuracoes", "serena-ui-injector.html"),
                  pathMod.join(process.resourcesPath, "configuracoes", "serena-ui-injector.html")
                );
              }
              let injPath = "";
              for (const c of candidates) {
                if (fsMod.existsSync(c)) {
                  injPath = c;
                  break;
                }
              }
              if (!injPath) return;
              const rawHtml = fsMod.readFileSync(injPath, "utf-8");
              const matchScript = rawHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
              if (matchScript && matchScript[1]) {
                contents.executeJavaScript(matchScript[1]).catch(() => {});
              }
            } catch (_eExec) {}
          });
        };

        const scanAllExistingWebContents = () => {
          try {
            if (exported.webContents && typeof exported.webContents.getAllWebContents === "function") {
              const allWc = exported.webContents.getAllWebContents() || [];
              for (const wc of allWc) {
                attachToElectronWebContents(wc);
              }
            }
          } catch (_eScanWc) {}
        };

        exported.app.on("web-contents-created", (_evt, contents) => {
          try { attachToElectronWebContents(contents); } catch (_eWc) {}
        });
        exported.app.on("browser-window-created", (_evt, win) => {
          try { if (win && win.webContents) attachToElectronWebContents(win.webContents); } catch (_eBw) {}
        });
        if (typeof exported.app.whenReady === "function") {
          exported.app.whenReady().then(scanAllExistingWebContents).catch(() => {});
        }
        scanAllExistingWebContents();
        const wcScanTimer = setInterval(scanAllExistingWebContents, 4000);
        if (typeof wcScanTimer.unref === "function") wcScanTimer.unref();
      }
    } catch (_hookErr) {}
    return exported;
  };
}

installRuntimeModuleHooks();

module.exports = {
  WA_WEB_BRIDGE_POLL_SCRIPT,
  buildWaWebSendScript,
  startEmbeddedLocalSyncServerIfFree,
  installRuntimeModuleHooks,
  installEventEmitterFallbackHook,
  attachClientOrSocketHooks,
  attachBrowserAutomationBridge,
};

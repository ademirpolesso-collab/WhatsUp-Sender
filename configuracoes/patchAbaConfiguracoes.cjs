// configuracoes/patchAbaConfiguracoes.cjs
// Injeta de forma idempotente os campos Nome da Clínica e Endereço da Clínica na aba Configurações real do mm-sender
// Funciona com Electron, HTML puro, React/Vite/Vue (incluindo dist/) e Express/IPC!

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const { getClinicSettings } = require("./configManager.cjs");

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "release",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".wwebjs_auth",
  ".wwebjs_cache",
  "auth_serena",
  "configuracoes",
]);

function walkFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith("backup_antes_serena")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name.toLowerCase())) {
        walkFiles(fullPath, results);
      }
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function buildInlineUiInjectorBlock(cfg) {
  const defaultsJson = JSON.stringify({
    clinicName: cfg.clinicName || "OdontoCompany Bela Vista Osasco",
    clinicAddress: cfg.clinicAddress || "Av Antonio Carlos Costa 991",
    parkingInfo: cfg.parkingInfo || "Estacionamento no local",
  });

  return `<!-- SERENA_CLINIC_CONFIG_START -->
<script id="serena-clinic-config-inline">
(function () {
  var SERENA_DEFAULTS = ${defaultsJson};
  var STORAGE_KEY = "serena_clinic_settings_v2";

  function readNodeFsSettings() {
    try {
      var req = typeof window.require === "function" ? window.require : null;
      if (!req) return null;
      var fsMod = req("fs");
      var pathMod = req("path");
      var candidates = [];
      if (window.process && window.process.env && window.process.env.APPDATA) {
        candidates.push(pathMod.join(window.process.env.APPDATA, "mm-sender", "configuracoes", "clinic-settings.json"));
      }
      if (window.process && typeof window.process.cwd === "function") {
        candidates.push(pathMod.join(window.process.cwd(), "configuracoes", "clinic-settings.json"));
      }
      for (var i = 0; i < candidates.length; i++) {
        if (fsMod.existsSync(candidates[i])) {
          return JSON.parse(fsMod.readFileSync(candidates[i], "utf-8"));
        }
      }
    } catch (e) {}
    return null;
  }

  function writeNodeFsSettings(data) {
    try {
      var req = typeof window.require === "function" ? window.require : null;
      if (!req) return false;
      var fsMod = req("fs");
      var pathMod = req("path");
      var targets = [];
      if (window.process && window.process.env && window.process.env.APPDATA) {
        targets.push(pathMod.join(window.process.env.APPDATA, "mm-sender", "configuracoes", "clinic-settings.json"));
      }
      if (window.process && typeof window.process.cwd === "function") {
        targets.push(pathMod.join(window.process.cwd(), "configuracoes", "clinic-settings.json"));
      }
      var wrote = false;
      for (var i = 0; i < targets.length; i++) {
        try {
          fsMod.mkdirSync(pathMod.dirname(targets[i]), { recursive: true });
          fsMod.writeFileSync(targets[i], JSON.stringify(data, null, 2), "utf-8");
          wrote = true;
        } catch (errInner) {}
      }
      return wrote;
    } catch (e) {}
    return false;
  }

  function getCachedSettings() {
    var fromFs = readNodeFsSettings();
    if (fromFs && (fromFs.clinicName || fromFs.clinicAddress || fromFs.address)) {
      return {
        clinicName: fromFs.clinicName || SERENA_DEFAULTS.clinicName,
        clinicAddress: fromFs.clinicAddress || fromFs.address || SERENA_DEFAULTS.clinicAddress,
        parkingInfo: fromFs.parkingInfo || SERENA_DEFAULTS.parkingInfo || ""
      };
    }
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        return {
          clinicName: parsed.clinicName || SERENA_DEFAULTS.clinicName,
          clinicAddress: parsed.clinicAddress || parsed.address || SERENA_DEFAULTS.clinicAddress,
          parkingInfo: parsed.parkingInfo || SERENA_DEFAULTS.parkingInfo || ""
        };
      }
    } catch (e) {}
    return {
      clinicName: SERENA_DEFAULTS.clinicName,
      clinicAddress: SERENA_DEFAULTS.clinicAddress,
      parkingInfo: SERENA_DEFAULTS.parkingInfo || ""
    };
  }

  async function loadLatestSettingsAsync() {
    var current = getCachedSettings();
    try {
      if (window.electronAPI && typeof window.electronAPI.getClinicSettings === "function") {
        var ipcData = await window.electronAPI.getClinicSettings();
        if (ipcData && ipcData.clinicName) return ipcData;
      }
      var req = typeof window.require === "function" ? window.require : null;
      if (req) {
        var electron = req("electron");
        if (electron && electron.ipcRenderer) {
          var resIpc = await electron.ipcRenderer.invoke("serena:get-clinic-settings");
          if (resIpc && resIpc.clinicName) return resIpc;
        }
      }
    } catch (e) {}
    try {
      if (location.protocol.indexOf("http") === 0) {
        var resp = await fetch("/api/clinic-settings");
        if (resp.ok) {
          var httpData = await resp.json();
          if (httpData && (httpData.clinicName || httpData.clinicAddress)) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(httpData));
            return httpData;
          }
        }
      }
    } catch (e) {}
    return current;
  }

  async function persistSettingsEverywhere(payload) {
    var normalized = {
      clinicName: String(payload.clinicName || "").trim() || SERENA_DEFAULTS.clinicName,
      clinicAddress: String(payload.clinicAddress || payload.address || "").trim() || SERENA_DEFAULTS.clinicAddress,
      address: String(payload.clinicAddress || payload.address || "").trim() || SERENA_DEFAULTS.clinicAddress,
      parkingInfo: String(payload.parkingInfo || "").trim(),
      timezone: "America/Sao_Paulo",
      updatedAt: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch (e) {}

    writeNodeFsSettings(normalized);

    try {
      if (window.electronAPI && typeof window.electronAPI.saveClinicSettings === "function") {
        await window.electronAPI.saveClinicSettings(normalized);
      } else if (typeof window.require === "function") {
        var electron = window.require("electron");
        if (electron && electron.ipcRenderer) {
          await electron.ipcRenderer.invoke("serena:save-clinic-settings", normalized);
        }
      }
    } catch (e) {}

    try {
      if (location.protocol.indexOf("http") === 0) {
        await fetch("/api/clinic-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(normalized)
        });
      }
    } catch (e) {}

    try {
      await fetch("http://127.0.0.1:17890/sync-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: normalized })
      });
    } catch (e) {}

    window.dispatchEvent(new CustomEvent("serena-clinic-settings-updated", { detail: normalized }));
    return normalized;
  }

  window.getSerenaClinicSettings = getCachedSettings;
  window.saveSerenaClinicSettings = persistSettingsEverywhere;

  function isDarkBackground(el) {
    var node = el;
    while (node && node !== document.documentElement) {
      var bg = window.getComputedStyle(node).backgroundColor;
      var m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (m) {
        var alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
        if (alpha > 0.15) {
          var lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
          return lum < 0.45;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  var lastClickedTabWasConfig = false;

  function isNavOrTabElement(el) {
    if (!el || el.closest("#serena-clinic-fields-card")) return null;
    var candidate = el.closest("button, a, [role='tab'], li, [class*='tab'], [class*='nav'], [class*='menu']");
    if (!candidate) return null;
    if (candidate.querySelector("input, textarea, select")) return null;
    var label = (candidate.textContent || "").replace(/\s+/g, " ").trim();
    if (!label || label.length > 40) return null;
    return { el: candidate, label: label };
  }

  function isActiveTabElement(tabEl) {
    if (!tabEl) return false;
    if (tabEl.getAttribute("aria-selected") === "true") return true;
    if (tabEl.getAttribute("data-state") === "active") return true;
    var cls = String(tabEl.className || "");
    if (/\b(active|selected|current|ativo|ativa)\b/i.test(cls)) return true;
    return false;
  }

  function findVisibleMainPanel(excludeEl) {
    var selectors = [
      "[role='tabpanel']:not([hidden])",
      ".tab-pane.active",
      ".tab-content > .active",
      "main",
      "[class*='main-content']",
      "[class*='page-content']",
      "[class*='content-area']",
      "#content",
      ".content"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var list = document.querySelectorAll(selectors[i]);
      for (var k = 0; k < list.length; k++) {
        var p = list[k];
        if (excludeEl && excludeEl.contains(p)) continue;
        if (p.offsetHeight > 60 && p.offsetWidth > 200) {
          return p;
        }
      }
    }
    var root = document.getElementById("root") || document.getElementById("app") || document.body;
    var children = root.querySelectorAll("section, form, div");
    for (var m = 0; m < children.length; m++) {
      var box = children[m];
      if (box.closest("nav, aside, header")) continue;
      if (box.querySelectorAll("input, select, textarea, button").length >= 1 && box.offsetHeight > 80 && box.offsetWidth > 240) {
        return box;
      }
    }
    return null;
  }

  function findSettingsTabContainer() {
    var explicitSelectors = [
      "#tab-configuracoes",
      "#tab-config",
      "#configuracoes",
      "#config",
      "#aba-configuracoes",
      "#aba-config",
      "#view-configuracoes",
      "#view-config",
      "#page-configuracoes",
      "#page-config",
      "#settings-tab",
      "#tab-settings",
      "#settings",
      "[data-tab-content='configuracoes']",
      "[data-tab-content='config']",
      "[data-tab-content='settings']",
      "[data-page='configuracoes']",
      "[data-page='config']",
      "[data-view='settings']"
    ];
    for (var i = 0; i < explicitSelectors.length; i++) {
      var found = document.querySelector(explicitSelectors[i]);
      if (found && !found.closest("nav, aside, [role='tablist']")) {
        return { container: found, mode: "static-panel" };
      }
    }

    var headings = document.querySelectorAll("h1, h2, h3, h4, legend, [class*='title'], [class*='header']");
    for (var j = 0; j < headings.length; j++) {
      var h = headings[j];
      if (h.closest("nav, aside, button, a, [role='tab'], [role='navigation'], #serena-clinic-fields-card")) {
        continue;
      }
      var txt = (h.textContent || "").replace(/\s+/g, " ").trim();
      if (txt.length > 0 && txt.length <= 55 && /^(?:⚙️\s*)?(?:configura[cç][oõ]es|configura[cç][aã]o|ajustes|par[aâ]metros)\b/i.test(txt)) {
        var panel = h.closest("form, section, main, [role='tabpanel']") || h.parentElement;
        if (panel && panel.offsetHeight > 40) {
          return { container: panel, anchorHeading: h, mode: "dynamic-heading" };
        }
      }
    }

    var tabCandidates = document.querySelectorAll("button, a, [role='tab'], li");
    var activeConfigTab = null;
    for (var t = 0; t < tabCandidates.length; t++) {
      var item = tabCandidates[t];
      var itemTxt = (item.textContent || "").replace(/\s+/g, " ").trim();
      if (itemTxt.length > 0 && itemTxt.length <= 30 && /\b(configura[cç][oõ]es|configura[cç][aã]o|settings|ajustes)\b/i.test(itemTxt)) {
        if (isActiveTabElement(item)) {
          activeConfigTab = item;
          break;
        }
      }
    }

    if (activeConfigTab || lastClickedTabWasConfig) {
      var navWrap = activeConfigTab ? activeConfigTab.closest("nav, aside, [role='tablist'], header") : null;
      var mainPanel = findVisibleMainPanel(navWrap);
      if (mainPanel) {
        return { container: mainPanel, mode: "dynamic-heading" };
      }
    }

    return null;
  }

  function mountOrSyncCard() {
    if (document.querySelector("[data-serena-native-clinic-fields='true']")) {
      return;
    }

    var target = findSettingsTabContainer();
    var existingCard = document.getElementById("serena-clinic-fields-card");

    if (!target) {
      if (existingCard && existingCard.getAttribute("data-mount-mode") === "dynamic-heading") {
        existingCard.remove();
      }
      return;
    }

    if (existingCard && target.container.contains(existingCard)) {
      return;
    }
    if (existingCard) {
      existingCard.remove();
    }

    var dark = isDarkBackground(target.container);
    var cfg = getCachedSettings();

    var card = document.createElement("div");
    card.id = "serena-clinic-fields-card";
    card.setAttribute("data-mount-mode", target.mode);
    card.style.cssText = [
      "margin: 14px 0 18px 0",
      "padding: 18px 20px",
      "border-radius: 12px",
      "border: 1px solid " + (dark ? "rgba(148,163,184,0.25)" : "#cbd5e1"),
      "background: " + (dark ? "rgba(15,23,42,0.75)" : "#ffffff"),
      "color: " + (dark ? "#f8fafc" : "#0f172a"),
      "box-shadow: 0 1px 3px rgba(0,0,0,0.06)",
      "font-family: system-ui, -apple-system, sans-serif"
    ].join(";");

    var labelColor = dark ? "#cbd5e1" : "#334155";
    var subColor = dark ? "#94a3b8" : "#64748b";
    var inputBg = dark ? "#0f172a" : "#f8fafc";
    var inputBorder = dark ? "#334155" : "#cbd5e1";
    var inputText = dark ? "#f8fafc" : "#0f172a";

    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap;">' +
        '<div>' +
          '<div style="font-size:15px;font-weight:700;line-height:1.3;">Dados da Clínica (Parâmetros Dinâmicos da Serena)</div>' +
          '<div style="font-size:12px;color:' + subColor + ';margin-top:2px;">Utilizados automaticamente nas saudações, confirmações de agendamento, localização e lembretes.</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;">' +
        '<div>' +
          '<label for="serena-clinic-name-input" style="display:block;font-size:12px;font-weight:600;color:' + labelColor + ';margin-bottom:5px;">Nome da Clínica</label>' +
          '<input id="serena-clinic-name-input" name="clinicName" type="text" style="width:100%;height:38px;padding:0 12px;border-radius:8px;border:1px solid ' + inputBorder + ';background:' + inputBg + ';color:' + inputText + ';font-size:13px;outline:none;box-sizing:border-box;" />' +
        '</div>' +
        '<div>' +
          '<label for="serena-clinic-address-input" style="display:block;font-size:12px;font-weight:600;color:' + labelColor + ';margin-bottom:5px;">Endereço da Clínica</label>' +
          '<input id="serena-clinic-address-input" name="clinicAddress" type="text" style="width:100%;height:38px;padding:0 12px;border-radius:8px;border:1px solid ' + inputBorder + ';background:' + inputBg + ';color:' + inputText + ';font-size:13px;outline:none;box-sizing:border-box;" />' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;flex-wrap:wrap;">' +
        '<span id="serena-clinic-save-feedback" style="font-size:12px;font-weight:600;color:#10b981;"></span>' +
        '<button id="serena-clinic-save-btn" type="button" style="height:36px;padding:0 16px;border-radius:8px;border:none;background:#2563eb;color:#ffffff;font-size:12px;font-weight:600;cursor:pointer;">Salvar Nome e Endereço</button>' +
      '</div>';

    if (target.anchorHeading && target.anchorHeading.parentElement === target.container) {
      target.anchorHeading.insertAdjacentElement("afterend", card);
    } else {
      target.container.insertBefore(card, target.container.firstChild);
    }

    var nameInput = document.getElementById("serena-clinic-name-input");
    var addrInput = document.getElementById("serena-clinic-address-input");
    var saveBtn = document.getElementById("serena-clinic-save-btn");
    var feedback = document.getElementById("serena-clinic-save-feedback");

    if (nameInput) nameInput.value = cfg.clinicName || "";
    if (addrInput) addrInput.value = cfg.clinicAddress || cfg.address || "";

    loadLatestSettingsAsync().then(function (fresh) {
      if (!fresh) return;
      if (nameInput && document.activeElement !== nameInput && fresh.clinicName) {
        nameInput.value = fresh.clinicName;
      }
      if (addrInput && document.activeElement !== addrInput && (fresh.clinicAddress || fresh.address)) {
        addrInput.value = fresh.clinicAddress || fresh.address;
      }
    });

    function triggerSave() {
      var nVal = nameInput ? nameInput.value : "";
      var aVal = addrInput ? addrInput.value : "";
      persistSettingsEverywhere({ clinicName: nVal, clinicAddress: aVal }).then(function () {
        if (feedback) {
          feedback.textContent = "✓ Nome e Endereço salvos e aplicados em toda a aplicação!";
          setTimeout(function () {
            if (feedback) feedback.textContent = "";
          }, 3500);
        }
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", triggerSave);
    }

    var parentForm = card.closest("form");
    if (parentForm && !parentForm.getAttribute("data-serena-hooked")) {
      parentForm.setAttribute("data-serena-hooked", "1");
      parentForm.addEventListener("submit", triggerSave);
    }
  }

  var scheduled = false;
  function scheduleCheck() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      mountOrSyncCard();
    }, 120);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleCheck);
  } else {
    scheduleCheck();
  }

  var obs = new MutationObserver(scheduleCheck);
  if (document.documentElement) {
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
  }
  document.addEventListener("click", function (ev) {
    var navHit = isNavOrTabElement(ev.target);
    if (navHit) {
      if (/\b(configura[cç][oõ]es|configura[cç][aã]o|settings|ajustes|par[aâ]metros)\b/i.test(navHit.label)) {
        lastClickedTabWasConfig = true;
      } else if (navHit.el.closest("nav, aside, header, [role='tablist']") || /\b(tab|nav|menu)\b/i.test(String(navHit.el.className || ""))) {
        lastClickedTabWasConfig = false;
      }
    }
    scheduleCheck();
  }, true);
})();
</script>
<!-- SERENA_CLINIC_CONFIG_END -->`;
}

function patchHtmlFile(filePath, cfg) {
  let html = fs.readFileSync(filePath, "utf-8");
  if (!/<\/body>/i.test(html) && !/<\/html>/i.test(html)) {
    return false;
  }

  const block = buildInlineUiInjectorBlock(cfg);
  const markerRegex = /<!-- SERENA_CLINIC_CONFIG_START -->[\s\S]*?<!-- SERENA_CLINIC_CONFIG_END -->/g;

  if (markerRegex.test(html)) {
    html = html.replace(markerRegex, () => block);
  } else if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, () => block + "\n</body>");
  } else {
    html = html + "\n" + block;
  }

  fs.writeFileSync(filePath, html, "utf-8");
  return true;
}

function patchNodeBackendFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".js" && ext !== ".cjs") return false;

  let code = fs.readFileSync(filePath, "utf-8");
  // Evita tocar em arquivos ESM puros sem require ou bundles minificados
  if (code.length > 400_000) return false;
  const hasRequire = /\brequire\s*\(/.test(code);
  const hasTopImport = /^\s*import\s+/m.test(code) && !hasRequire;
  if (hasTopImport) return false;

  const hasExpress = /express\s*\(\s*\)/.test(code);
  const hasIpcMain = /\bipcMain\b/.test(code);
  if (!hasExpress && !hasIpcMain) return false;

  const relCfgPath = path
    .relative(path.dirname(filePath), path.join(ROOT_DIR, "configuracoes", "configManager.cjs"))
    .replace(/\\/g, "/");
  const normalizedReqPath = relCfgPath.startsWith(".") ? relCfgPath : "./" + relCfgPath;

  const backendHook = `
// === SERENA_CLINIC_CONFIG_BACKEND_START ===
try {
  const __serenaConfigMgr = require(${JSON.stringify(normalizedReqPath)});
  global.getSerenaClinicSettings = __serenaConfigMgr.getClinicSettings;
  global.saveSerenaClinicSettings = __serenaConfigMgr.saveClinicSettings;
  if (typeof ipcMain !== "undefined" && ipcMain && typeof ipcMain.handle === "function") {
    try { ipcMain.removeHandler("serena:get-clinic-settings"); } catch (_e) {}
    try { ipcMain.removeHandler("serena:save-clinic-settings"); } catch (_e) {}
    ipcMain.handle("serena:get-clinic-settings", () => __serenaConfigMgr.getClinicSettings());
    ipcMain.handle("serena:save-clinic-settings", (_evt, payload) => __serenaConfigMgr.saveClinicSettings(payload || {}));
  }
  if (typeof app !== "undefined" && app && typeof app.get === "function" && typeof app.post === "function" && typeof app.use === "function") {
    app.get("/api/clinic-settings", (_req, res) => {
      res.json(__serenaConfigMgr.getClinicSettings());
    });
    app.post("/api/clinic-settings", (req, res) => {
      const saved = __serenaConfigMgr.saveClinicSettings(req.body || {});
      res.json(saved);
    });
  }
} catch (_serenaHookErr) {}
// === SERENA_CLINIC_CONFIG_BACKEND_END ===
`;

  const backendMarker = /\/\/ === SERENA_CLINIC_CONFIG_BACKEND_START ===[\s\S]*?\/\/ === SERENA_CLINIC_CONFIG_BACKEND_END ===/g;
  if (backendMarker.test(code)) {
    code = code.replace(backendMarker, () => backendHook.trim());
  } else {
    code = code + "\n" + backendHook;
  }

  fs.writeFileSync(filePath, code, "utf-8");
  return true;
}

function runPatch({ triggerFrontendBuild = true } = {}) {
  const cfg = getClinicSettings();
  const allFiles = walkFiles(ROOT_DIR);

  const patchedHtml = [];
  const patchedBackend = [];

  for (const fullPath of allFiles) {
    const rel = path.relative(ROOT_DIR, fullPath).replace(/\\/g, "/");
    const lower = rel.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".ejs")) {
      if (patchHtmlFile(fullPath, cfg)) {
        patchedHtml.push(rel);
      }
    } else if (
      lower.endsWith(".js") ||
      lower.endsWith(".cjs")
    ) {
      if (!lower.startsWith("dist/") && !lower.startsWith("build/")) {
        if (patchNodeBackendFile(fullPath)) {
          patchedBackend.push(rel);
        }
      }
    }
  }

  // Se houver frontend compilado (Vite/React/Vue/TSC), recompila dist/ e garante o injetor também no dist/index.html gerado!
  const pkgFile = path.join(ROOT_DIR, "package.json");
  if (triggerFrontendBuild && fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf-8"));
      const buildScript = String((pkg.scripts && pkg.scripts.build) || "");
      const isFrontendCompiler =
        /(vite|tsc|react-scripts|webpack|parcel|rollup|esbuild|next|vue-cli|svelte)/i.test(buildScript) &&
        !/(electron-builder|electron-packager|innosetup)/i.test(buildScript);

      if (isFrontendCompiler) {
        console.log("[BUILD] Executando npm run build para atualizar dist/ com a nova aba Configurações...");
        execSync("npm run build", { cwd: ROOT_DIR, stdio: "inherit" });

        // Reaplica também em dist/index.html ou build/index.html caso o bundler tenha regerado o HTML
        for (const outHtml of ["dist/index.html", "build/index.html", "renderer/dist/index.html"]) {
          const fullOut = path.join(ROOT_DIR, outHtml);
          if (fs.existsSync(fullOut)) {
            patchHtmlFile(fullOut, cfg);
            if (!patchedHtml.includes(outHtml)) patchedHtml.push(outHtml);
          }
        }
      }
    } catch (buildErr) {
      console.warn("[AVISO] Falha opcional ao rodar npm run build:", buildErr.message);
    }
  }

  return { patchedHtml, patchedBackend, settings: cfg };
}

if (require.main === module) {
  const result = runPatch({ triggerFrontendBuild: true });
  console.log("[ABA CONFIGURAÇÕES] Arquivos HTML/UI preparados:", result.patchedHtml.join(", ") || "nenhum HTML detectado");
  if (result.patchedBackend.length > 0) {
    console.log("[BACKEND IPC/API] Rotas de configuração conectadas em:", result.patchedBackend.join(", "));
  }
}

module.exports = { runPatch };

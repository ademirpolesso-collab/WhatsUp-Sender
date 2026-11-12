// configuracoes/configManager.cjs
// Leitura e salvamento em tempo real (sem cache congelado!) de Clínica, Serena Corporativa, Anti-Ban e Grupo da Zelda

const fs = require("fs");
const path = require("path");

function resolveProjectRootDir() {
  const parent = path.resolve(__dirname, "..");
  const norm = parent.replace(/\\/g, "/").toLowerCase();
  if (norm.endsWith("/resources/app")) {
    return path.resolve(parent, "..", "..");
  }
  return parent;
}

function isMmSenderCwd() {
  try {
    return fs.existsSync(path.join(process.cwd(), "configuracoes", "configManager.cjs"));
  } catch (_e) {
    return false;
  }
}

function resolveWritableDataDir() {
  const rootDir = resolveProjectRootDir();
  const isProtectedWinDir = /program files/i.test(rootDir);
  const isPackagedSnapshot = Boolean(process.pkg) || rootDir.includes("app.asar");
  if ((isProtectedWinDir || isPackagedSnapshot) && process.env.APPDATA) {
    const appDataDir = path.join(process.env.APPDATA, "mm-sender");
    fs.mkdirSync(appDataDir, { recursive: true });
    return appDataDir;
  }
  return rootDir;
}

const DEFAULT_SETTINGS = {
  assistantName: "Serena",
  clinicName: "OdontoCompany Bela Vista Osasco",
  clinicAddress: "Av Antonio Carlos Costa 991",
  address: "Av Antonio Carlos Costa 991",
  parkingInfo: "Estacionamento no local",
  receptionName: "Recepção",
  receptionWhatsapp: "",
  crcEnabled: true,
  timezone: "America/Sao_Paulo",
  workingHoursLabel: "Seg–Sex 08:00 às 18:00 e Sábados 08:00 às 13:00 (Horário de Brasília)",
  slotDurationMinutes: 30,
  reactionDelayMinMs: 3000,
  reactionDelayMaxMs: 7000,
  typingStateMinMs: 2000,
  typingStateMaxMs: 5000,
  betweenBubblesMinMs: 4000,
  betweenBubblesMaxMs: 8000,
  bulkIntervalMinSec: 15,
  bulkIntervalMaxSec: 35,
  bulkBatchSize: 10,
  bulkBatchPauseSec: 180,
  maxActiveMessagesPerHour: 30,
  maxMessageChars: 450,
  minLeadRepliesBeforeLinks: 2,
  blockFirstMessageLinks: true,
  enableSpintax: true,
  enableOptOutBlacklist: true,
  chipWarmupDays: 21,
  zeldaGroupEnabled: true,
  zeldaGroupTarget: "",
  zeldaTriggerMode: "mention_only",
  zeldaTriggerKeyword: "zelda",
  zeldaAllowFromMeTest: true,
  zeldaCaretakerPhone: "",
  zeldaApprovalQuorum: 3,
  serenaKeepUnreadForHuman: true,
};

function getPrimaryClinicSettingsPaths() {
  const list = [];
  if (process.env.APPDATA) {
    list.push(path.join(process.env.APPDATA, "mm-sender", "configuracoes", "clinic-settings.json"));
  }
  if (process.env.LOCALAPPDATA) {
    list.push(path.join(process.env.LOCALAPPDATA, "mm-sender", "configuracoes", "clinic-settings.json"));
  }
  if (process.resourcesPath) {
    list.push(path.join(process.resourcesPath, "app", "configuracoes", "clinic-settings.json"));
    list.push(path.join(process.resourcesPath, "configuracoes", "clinic-settings.json"));
  }
  const rootDir = resolveProjectRootDir();
  list.push(path.join(__dirname, "clinic-settings.json"));
  list.push(path.join(rootDir, "configuracoes", "clinic-settings.json"));
  list.push(path.join(rootDir, "clinic-settings.json"));
  if (isMmSenderCwd()) {
    list.push(path.resolve(process.cwd(), "configuracoes", "clinic-settings.json"));
    list.push(path.resolve(process.cwd(), "clinic-settings.json"));
  }
  return Array.from(new Set(list));
}

function getLegacyFallbackPaths() {
  const list = [];
  if (process.env.APPDATA) {
    list.push(path.join(process.env.APPDATA, "mm-sender", "config.json"));
    list.push(path.join(process.env.APPDATA, "mm-sender", "settings.json"));
  }
  const rootDir = resolveProjectRootDir();
  list.push(path.join(rootDir, "config.json"));
  list.push(path.join(rootDir, "settings.json"));
  if (isMmSenderCwd()) {
    list.push(path.resolve(process.cwd(), "config.json"));
    list.push(path.resolve(process.cwd(), "settings.json"));
  }
  return Array.from(new Set(list));
}

function pickNonEmptyStr(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && c !== null) {
      const s = String(c).trim();
      if (s.length > 0) return s;
    }
  }
  return "";
}

function parseBoolLoose(val, fallback) {
  if (val === undefined || val === null || val === "") return fallback;
  if (typeof val === "boolean") return val;
  const s = String(val).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "on" || s === "sim" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "off" || s === "nao" || s === "não" || s === "no") return false;
  return fallback;
}

function mergeRawIntoSettings(merged, raw, isLegacyFile) {
  if (!raw || typeof raw !== "object") return merged;
  const assistant = pickNonEmptyStr(raw.assistantName, raw.nomeAssistente, merged.assistantName, DEFAULT_SETTINGS.assistantName);
  const name = pickNonEmptyStr(raw.clinicName, raw.nomeClinica, merged.clinicName, DEFAULT_SETTINGS.clinicName);
  const addr = pickNonEmptyStr(
    raw.clinicAddress,
    raw.address,
    raw.enderecoClinica,
    merged.clinicAddress,
    DEFAULT_SETTINGS.clinicAddress
  );
  const recName = pickNonEmptyStr(raw.receptionName, raw.nomeRecepcao, merged.receptionName, DEFAULT_SETTINGS.receptionName);
  const hasExplicitRecWa = !isLegacyFile && (raw.receptionWhatsapp !== undefined || raw.whatsappRecepcao !== undefined);
  const recWa = hasExplicitRecWa
    ? String(raw.receptionWhatsapp ?? raw.whatsappRecepcao ?? "").trim()
    : pickNonEmptyStr(raw.receptionWhatsapp, raw.whatsappRecepcao, merged.receptionWhatsapp);
  const crcOn = parseBoolLoose(raw.crcEnabled ?? raw.crcAtivo, merged.crcEnabled);

  // NUNCA usa raw.groupId (pertence a campanhas/disparos e pode estar vazio "") nem deixa string vazia sobrescrever grupo válido!
  const zeldaGrp = pickNonEmptyStr(
    raw.zeldaGroupTarget,
    raw.zeldaGroup,
    raw.zeldaGroupId,
    raw.zeldaGroupName,
    raw.grupoZelda,
    raw.nomeGrupoZelda,
    raw.groupZelda,
    merged.zeldaGroupTarget,
    DEFAULT_SETTINGS.zeldaGroupTarget
  );
  const hasExplicitCaretaker =
    !isLegacyFile &&
    (raw.zeldaCaretakerPhone !== undefined ||
      raw.whatsappZelador !== undefined ||
      raw.telefoneZelador !== undefined ||
      raw.zeladorPhone !== undefined);
  const zeldaCaretaker = hasExplicitCaretaker
    ? String(
        raw.zeldaCaretakerPhone ??
          raw.whatsappZelador ??
          raw.telefoneZelador ??
          raw.zeladorPhone ??
          ""
      ).trim()
    : pickNonEmptyStr(
        raw.zeldaCaretakerPhone,
        raw.whatsappZelador,
        raw.telefoneZelador,
        raw.zeladorPhone,
        merged.zeldaCaretakerPhone
      );
  const zeldaQuorum = Math.max(
    1,
    Number(raw.zeldaApprovalQuorum ?? raw.quorumZelda ?? merged.zeldaApprovalQuorum ?? 3) || 3
  );
  const zeldaOn = parseBoolLoose(
    raw.zeldaGroupEnabled ?? raw.zeldaEnabled ?? raw.zeldaAtiva ?? raw.ativarZelda,
    merged.zeldaGroupEnabled
  );

  // Evita espalhar campos estranhos de config.json legado por cima de clinic-settings.json
  const baseSpread = isLegacyFile ? {} : raw;
  return {
    ...merged,
    ...baseSpread,
    assistantName: assistant || DEFAULT_SETTINGS.assistantName,
    clinicName: name || DEFAULT_SETTINGS.clinicName,
    clinicAddress: addr || DEFAULT_SETTINGS.clinicAddress,
    address: addr || DEFAULT_SETTINGS.clinicAddress,
    receptionName: recName || DEFAULT_SETTINGS.receptionName,
    receptionWhatsapp: recWa,
    crcEnabled: crcOn,
    zeldaGroupTarget: zeldaGrp || DEFAULT_SETTINGS.zeldaGroupTarget,
    zeldaGroupEnabled: zeldaOn,
    zeldaCaretakerPhone: zeldaCaretaker,
    zeldaApprovalQuorum: zeldaQuorum,
    zeldaAllowFromMeTest: parseBoolLoose(raw.zeldaAllowFromMeTest, merged.zeldaAllowFromMeTest),
    serenaKeepUnreadForHuman: parseBoolLoose(
      raw.serenaKeepUnreadForHuman ?? raw.keepUnreadForHuman ?? raw.manterNaoLidaSerena,
      merged.serenaKeepUnreadForHuman
    ),
  };
}

function getClinicSettings() {
  let merged = { ...DEFAULT_SETTINGS };

  // 1) Aplica primeiro arquivos legados (menor prioridade)
  const legacyPaths = getLegacyFallbackPaths();
  for (const file of legacyPaths) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        merged = mergeRawIntoSettings(merged, raw, true);
      }
    } catch (_err) {}
  }

  // 2) Aplica todos os clinic-settings.json ordenados por updatedAtEpochMs/mtimeMs crescente (o arquivo salvo mais recentemente SEMPRE vence!)
  const existingPrimaries = [];
  for (const file of getPrimaryClinicSettingsPaths()) {
    try {
      if (fs.existsSync(file)) {
        const st = fs.statSync(file);
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        const orderTs = Number(raw?.updatedAtEpochMs || st.mtimeMs || 0);
        existingPrimaries.push({ file, raw, orderTs });
      }
    } catch (_err) {}
  }
  existingPrimaries.sort((a, b) => a.orderTs - b.orderTs);

  for (const item of existingPrimaries) {
    try {
      merged = mergeRawIntoSettings(merged, item.raw, false);
    } catch (_err) {}
  }

  return merged;
}

function saveClinicSettings(partial) {
  const current = getClinicSettings();
  const nextAssistant =
    partial && partial.assistantName !== undefined
      ? String(partial.assistantName).trim() || DEFAULT_SETTINGS.assistantName
      : current.assistantName || DEFAULT_SETTINGS.assistantName;
  const nextName =
    partial && partial.clinicName !== undefined
      ? String(partial.clinicName).trim()
      : current.clinicName;
  const rawAddr =
    partial && (partial.clinicAddress !== undefined || partial.address !== undefined)
      ? String(partial.clinicAddress ?? partial.address).trim()
      : current.clinicAddress;
  const nextRecName =
    partial && partial.receptionName !== undefined
      ? String(partial.receptionName).trim() || DEFAULT_SETTINGS.receptionName
      : current.receptionName || DEFAULT_SETTINGS.receptionName;
  const nextRecWa =
    partial && (partial.receptionWhatsapp !== undefined || partial.whatsappRecepcao !== undefined)
      ? String(partial.receptionWhatsapp ?? partial.whatsappRecepcao ?? "").trim()
      : current.receptionWhatsapp || "";
  const nextCrcEnabled =
    partial && partial.crcEnabled !== undefined
      ? parseBoolLoose(partial.crcEnabled, true)
      : current.crcEnabled !== false;
  const hasIncomingGrpField =
    partial && (partial.zeldaGroupTarget !== undefined || partial.grupoZelda !== undefined);
  const rawIncomingGrp = hasIncomingGrpField
    ? String(partial.zeldaGroupTarget ?? partial.grupoZelda ?? "").trim()
    : "";
  const nextZeldaGrp = hasIncomingGrpField
    ? rawIncomingGrp
    : current.zeldaGroupTarget || DEFAULT_SETTINGS.zeldaGroupTarget;
  const nextCaretaker =
    partial && (partial.zeldaCaretakerPhone !== undefined || partial.whatsappZelador !== undefined)
      ? String(partial.zeldaCaretakerPhone ?? partial.whatsappZelador ?? "").trim()
      : current.zeldaCaretakerPhone || "";
  const nextQuorum =
    partial && partial.zeldaApprovalQuorum !== undefined
      ? Math.max(1, Number(partial.zeldaApprovalQuorum) || 3)
      : Math.max(1, Number(current.zeldaApprovalQuorum) || 3);

  const nextKeepUnread =
    partial && (partial.serenaKeepUnreadForHuman !== undefined || partial.keepUnreadForHuman !== undefined)
      ? parseBoolLoose(partial.serenaKeepUnreadForHuman ?? partial.keepUnreadForHuman, true)
      : current.serenaKeepUnreadForHuman !== false;

  const updated = {
    ...current,
    ...partial,
    assistantName: nextAssistant,
    clinicName: nextName || DEFAULT_SETTINGS.clinicName,
    clinicAddress: rawAddr || DEFAULT_SETTINGS.clinicAddress,
    address: rawAddr || DEFAULT_SETTINGS.clinicAddress,
    receptionName: nextRecName,
    receptionWhatsapp: nextRecWa,
    crcEnabled: nextCrcEnabled,
    zeldaGroupTarget: nextZeldaGrp,
    grupoZelda: nextZeldaGrp,
    zeldaGroup: nextZeldaGrp,
    zeldaCaretakerPhone: nextCaretaker,
    whatsappZelador: nextCaretaker,
    zeldaApprovalQuorum: nextQuorum,
    serenaKeepUnreadForHuman: nextKeepUnread,
    updatedAtEpochMs: Date.now(),
    updatedAt: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
  };

  const rootDir = resolveProjectRootDir();
  const writeTargets = [
    path.join(resolveWritableDataDir(), "configuracoes", "clinic-settings.json"),
    path.join(__dirname, "clinic-settings.json"),
    path.join(rootDir, "configuracoes", "clinic-settings.json"),
    path.join(rootDir, "clinic-settings.json"),
  ];
  if (isMmSenderCwd()) {
    writeTargets.push(path.resolve(process.cwd(), "configuracoes", "clinic-settings.json"));
    writeTargets.push(path.resolve(process.cwd(), "clinic-settings.json"));
  }
  if (process.resourcesPath) {
    writeTargets.push(path.join(process.resourcesPath, "app", "configuracoes", "clinic-settings.json"));
    writeTargets.push(path.join(process.resourcesPath, "configuracoes", "clinic-settings.json"));
  }
  if (process.env.APPDATA) {
    writeTargets.unshift(
      path.join(process.env.APPDATA, "mm-sender", "configuracoes", "clinic-settings.json")
    );
  }
  if (process.env.LOCALAPPDATA) {
    writeTargets.push(
      path.join(process.env.LOCALAPPDATA, "mm-sender", "configuracoes", "clinic-settings.json")
    );
  }

  const seen = new Set();
  for (const dest of writeTargets) {
    if (seen.has(dest)) continue;
    seen.add(dest);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, JSON.stringify(updated, null, 2), "utf-8");
    } catch (_e) {}
  }

  return updated;
}

module.exports = {
  resolveWritableDataDir,
  getClinicSettings,
  saveClinicSettings,
};

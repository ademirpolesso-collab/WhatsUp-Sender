// configuracoes/sincronizador-local.cjs
// Ponte local gratuita (127.0.0.1:17890) para atualizar a pasta mm-sender automaticamente após qualquer alteração!

const http = require("http");
const fs = require("fs");
const path = require("path");
const { getClinicSettings, saveClinicSettings } = require("./configManager.cjs");
const { runPatch } = require("./patchAbaConfiguracoes.cjs");

const ROOT_DIR = path.resolve(__dirname, "..");
const PORT = 17890;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "release",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".wwebjs_auth",
  ".wwebjs_cache",
  "auth_serena",
]);

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function collectProjectSnapshot() {
  const fileTree = [];
  const candidates = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith("backup_antes_serena")) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(ROOT_DIR, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name.toLowerCase())) walk(full);
      } else if (entry.isFile()) {
        fileTree.push(rel);
        const stat = fs.statSync(full);
        if (stat.size > 0 && stat.size <= 400_000 && /\.(html|htm|tsx|jsx|vue|js|cjs|mjs|ts|json|bat|cmd|ps1|py)$/i.test(rel)) {
          if (!rel.endsWith("package-lock.json") && !rel.endsWith(".min.js")) {
            candidates.push({ full, rel, size: stat.size });
          }
        }
      }
    }
  }

  walk(ROOT_DIR);

  const keyFiles = candidates.slice(0, 35).map((c) => {
    const content = fs.readFileSync(c.full, "utf-8");
    return {
      path: c.rel,
      content: content.slice(0, 90_000),
      truncated: content.length > 90_000,
    };
  });

  return {
    folderName: path.basename(ROOT_DIR),
    targetDir: ROOT_DIR,
    fileTree,
    keyFiles,
    totalSizeKb: Math.max(1, Math.round(candidates.reduce((acc, i) => acc + i.size, 0) / 1024)),
  };
}

const server = http.createServer((req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        targetDir: ROOT_DIR,
        settings: getClinicSettings(),
      })
    );
    return;
  }

  if (req.method === "GET" && req.url === "/project-files") {
    try {
      const snap = collectProjectSnapshot();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(snap));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/sync-settings") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        let saved = getClinicSettings();
        if (parsed.settings) {
          saved = saveClinicSettings({
            clinicName: parsed.settings.clinicName,
            clinicAddress: parsed.settings.clinicAddress || parsed.settings.address,
            parkingInfo: parsed.settings.parkingInfo,
            typingDelayMinMs: parsed.settings.typingDelayMinMs,
            typingDelayMaxMs: parsed.settings.typingDelayMaxMs,
          });
        }

        let writtenCount = 0;
        if (Array.isArray(parsed.files)) {
          for (const f of parsed.files) {
            const cleanRel = String(f.path || "").replace(/^[/\\]+/, "");
            if (!cleanRel || cleanRel.includes("..")) continue;
            const dest = path.join(ROOT_DIR, cleanRel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, String(f.content || ""), "utf-8");
            writtenCount++;
          }
        }

        const patchRes = runPatch({ triggerFrontendBuild: Boolean(parsed.runBuild) });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            targetDir: ROOT_DIR,
            writtenCount: writtenCount + 1,
            patchedHtml: patchRes.patchedHtml,
            settings: saved,
          })
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.on("error", () => {
  // Já existe uma instância rodando na porta 17890
  process.exit(0);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[AUTO-SYNC] Sincronizador mm-sender ativo em http://127.0.0.1:" + PORT + " -> " + ROOT_DIR);
});

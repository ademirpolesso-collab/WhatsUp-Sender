/**
 * prebuild.js — executado antes do electron-builder
 *
 * Pré-extrai o winCodeSign manualmente usando o 7za interno,
 * ignorando symlinks (-sns), para que o electron-builder encontre
 * a pasta já pronta e não tente extrair novamente.
 *
 * Nota: a gravação de metadados no .exe (rcedit) está desabilitada via
 * "signAndEditExecutable": false no package.json, evitando o erro
 * "Unable to commit changes" que ocorre em caminhos com espaços (Google Drive).
 */
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const cacheDir   = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign');
const sevenZa    = path.join(__dirname, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const signVer    = 'winCodeSign-2.6.0';
const outDir     = path.join(cacheDir, signVer);
const markerFile = path.join(outDir, 'win', 'signtool.exe');

if (fs.existsSync(markerFile)) {
  console.log('[prebuild] winCodeSign já extraído, pulando.');
  process.exit(0);
}

// Procura pelo .7z já baixado em qualquer subdir do cacheDir
let archivePath = null;
if (fs.existsSync(cacheDir)) {
  for (const f of fs.readdirSync(cacheDir)) {
    if (f.endsWith('.7z')) {
      archivePath = path.join(cacheDir, f);
      break;
    }
  }
}

if (!archivePath) {
  console.log('[prebuild] .7z não encontrado ainda — será baixado pelo builder.');
  process.exit(0);
}

console.log(`[prebuild] Extraindo ${archivePath} para ${outDir} (ignorando symlinks)...`);
fs.mkdirSync(outDir, { recursive: true });

const result = spawnSync(sevenZa, [
  'x', archivePath,
  `-o${outDir}`,
  '-y',   // yes a tudo
  '-sns', // skip non-standard (symlinks)
  '-bd',  // sem barra de progresso
], { stdio: 'inherit' });

if (result.status !== 0 && result.status !== 2) {
  // status 2 = warnings (symlinks ignorados) — aceitável
  console.error(`[prebuild] 7za retornou ${result.status}`);
  process.exit(1);
}

// Cria arquivos placeholder para os symlinks darwin que faltam
const darwinLib = path.join(outDir, 'darwin', '10.12', 'lib');
if (fs.existsSync(darwinLib)) {
  for (const name of ['libcrypto.dylib', 'libssl.dylib']) {
    const p = path.join(darwinLib, name);
    if (!fs.existsSync(p)) {
      const base = name.replace('.dylib', '.1.0.0.dylib');
      const src  = path.join(darwinLib, base);
      try {
        if (fs.existsSync(src)) fs.copyFileSync(src, p);
        else fs.writeFileSync(p, '');
      } catch (_) {}
    }
  }
}

console.log('[prebuild] winCodeSign extraído com sucesso!');

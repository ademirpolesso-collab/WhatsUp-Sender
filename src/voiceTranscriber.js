/**
 * voiceTranscriber.js — Transcrição de áudio de voz (PTT/audio) sem custo.
 *
 * Usa whisper.cpp (binário Windows x64) + modelo ggml-tiny para português BR.
 * Na primeira chamada, faz download automático do binário e do modelo (~75 MB total).
 * Converts .ogg/.opus (formato WhatsApp) → .wav 16kHz mono via ffmpeg embarcado.
 *
 * Dependências npm: @ffmpeg-installer/ffmpeg, fluent-ffmpeg
 */
'use strict';

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const https   = require('https');
const { execFile } = require('child_process');

// ── Configuração ──────────────────────────────────────────────────────────────

// Pasta persistente onde ficam o binário e o modelo (fora do asar)
const WHISPER_DIR = path.join(os.homedir(), '.mm-whisper');

const WHISPER_EXE  = path.join(WHISPER_DIR, 'whisper-cli.exe');
const MODEL_FILE   = path.join(WHISPER_DIR, 'ggml-tiny.bin');

// Release oficial whisper.cpp para Windows x64 (binário pré-compilado v1.9.2)
const WHISPER_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip';
const MODEL_URL   = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin';

// ── Estado interno ────────────────────────────────────────────────────────────
let initPromise = null; // garante que o download só acontece uma vez
let ready = false;

// ── Helpers de download ───────────────────────────────────────────────────────

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'mm-sender/1.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error(`HTTP ${res.statusCode} ao baixar ${url}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', err => { file.close(); fs.unlink(dest, () => {}); reject(err); });
      }).on('error', err => { file.close(); fs.unlink(dest, () => {}); reject(err); });
    };
    get(url);
  });
}

async function extractZip(zipPath, destDir) {
  // Usa o 7za.exe que já vem com o electron-builder/node_modules
  const sevenZa = path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (!fs.existsSync(sevenZa)) {
    throw new Error('7za.exe não encontrado em node_modules/7zip-bin');
  }
  return new Promise((resolve, reject) => {
    execFile(sevenZa, ['x', zipPath, `-o${destDir}`, '-y', '-bd'], (err, stdout, stderr) => {
      if (err) reject(new Error(`Erro ao extrair zip: ${stderr || err.message}`));
      else resolve();
    });
  });
}

// ── Inicialização (download único) ────────────────────────────────────────────

async function ensureReady() {
  if (ready) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    fs.mkdirSync(WHISPER_DIR, { recursive: true });

    // Baixa o modelo se necessário
    if (!fs.existsSync(MODEL_FILE)) {
      console.log('[Whisper] Baixando modelo ggml-tiny (~39 MB)...');
      await download(MODEL_URL, MODEL_FILE);
      console.log('[Whisper] Modelo baixado.');
    }

    // Baixa e extrai o binário se necessário
    if (!fs.existsSync(WHISPER_EXE)) {
      const zipPath = path.join(WHISPER_DIR, 'whisper-cli.zip');
      console.log('[Whisper] Baixando whisper-bin-x64.zip (~8 MB)...');
      await download(WHISPER_URL, zipPath);
      await extractZip(zipPath, WHISPER_DIR);
      fs.unlink(zipPath, () => {});

      // Se os binários e DLLs foram extraídos dentro de uma subpasta 'Release', move para o WHISPER_DIR
      const releaseSubdir = path.join(WHISPER_DIR, 'Release');
      if (fs.existsSync(releaseSubdir) && fs.statSync(releaseSubdir).isDirectory()) {
        const files = fs.readdirSync(releaseSubdir);
        for (const file of files) {
          const src = path.join(releaseSubdir, file);
          const dest = path.join(WHISPER_DIR, file);
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          fs.renameSync(src, dest);
        }
        try { fs.rmdirSync(releaseSubdir); } catch (_) {}
      }

      // Garante que o exe foi encontrado
      if (!fs.existsSync(WHISPER_EXE)) {
        const found = fs.readdirSync(WHISPER_DIR).find(f => f.endsWith('.exe') && (f.toLowerCase().includes('whisper-cli') || f.toLowerCase() === 'main.exe'));
        if (found) fs.renameSync(path.join(WHISPER_DIR, found), WHISPER_EXE);
        else throw new Error('whisper-cli.exe não encontrado após extração');
      }
      console.log('[Whisper] Binário pronto.');
    }

    ready = true;
  })();

  return initPromise;
}

// ── Conversão ogg → wav ───────────────────────────────────────────────────────

function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    const ffmpeg = require('fluent-ffmpeg');
    ffmpeg.setFfmpegPath(ffmpegPath);

    ffmpeg(inputPath)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('error', reject)
      .on('end', resolve)
      .save(outputPath);
  });
}

// ── Transcrição principal ─────────────────────────────────────────────────────

/**
 * Transcreve um buffer de áudio (ogg/opus do WhatsApp) para texto.
 * @param {Buffer} audioBuffer — dados binários do áudio
 * @returns {Promise<string|null>} — texto transcrito ou null em caso de falha
 */
async function transcribe(audioBuffer) {
  const tmpId   = Date.now() + '_' + Math.random().toString(36).slice(2);
  const oggPath = path.join(os.tmpdir(), `mm_audio_${tmpId}.ogg`);
  const wavPath = path.join(os.tmpdir(), `mm_audio_${tmpId}.wav`);

  try {
    await ensureReady();

    // Salva o buffer como .ogg
    fs.writeFileSync(oggPath, audioBuffer);

    // Converte para .wav 16kHz mono
    await convertToWav(oggPath, wavPath);

    // Chama whisper.cpp
    const text = await new Promise((resolve, reject) => {
      execFile(
        WHISPER_EXE,
        [
          '-m', MODEL_FILE,
          '-f', wavPath,
          '-l', 'pt',        // forçar português
          '--no-timestamps', // sem carimbos de tempo
          '-otxt',           // saída em txt
          '--output-file', wavPath.replace('.wav', ''), // whisper adiciona .txt
        ],
        { timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(err.message));
          resolve(stdout.trim());
        }
      );
    });

    // Lê o .txt gerado pelo whisper (prefere o arquivo de saída sobre stdout)
    const txtPath = wavPath.replace('.wav', '.txt');
    let result = text;
    if (fs.existsSync(txtPath)) {
      result = fs.readFileSync(txtPath, 'utf8').trim();
      fs.unlink(txtPath, () => {});
    }

    return result || null;
  } catch (err) {
    console.error('[Whisper] Erro na transcrição:', err.message);
    return null;
  } finally {
    fs.unlink(oggPath, () => {});
    fs.unlink(wavPath, () => {});
  }
}

/**
 * Retorna true se o whisper já está pronto (binário + modelo presentes).
 * Útil para mostrar status na UI sem disparar download.
 */
function isReady() {
  return ready || (fs.existsSync(WHISPER_EXE) && fs.existsSync(MODEL_FILE));
}

module.exports = { transcribe, ensureReady, isReady };

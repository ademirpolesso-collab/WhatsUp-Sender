/**
 * afterPack.js
 * Cria os symlinks ausentes do winCodeSign que o 7-zip não consegue criar
 * sem privilégio de administrador no Windows.
 * Executado automaticamente pelo electron-builder após o empacotamento.
 */
const fs   = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  // Localiza a pasta do winCodeSign no cache do electron-builder
  const cacheBase = path.join(
    process.env.LOCALAPPDATA || process.env.APPDATA,
    'electron-builder', 'Cache', 'winCodeSign'
  );

  if (!fs.existsSync(cacheBase)) return;

  // Procura pela pasta extraída (qualquer subdir que contenha darwin/)
  const entries = fs.readdirSync(cacheBase);
  for (const entry of entries) {
    const darwinLib = path.join(cacheBase, entry, 'darwin', '10.12', 'lib');
    if (!fs.existsSync(darwinLib)) continue;

    // Cria os symlinks que o 7-zip não conseguiu criar
    const symlinks = [
      { link: path.join(darwinLib, 'libcrypto.dylib'),  target: 'libcrypto.1.0.0.dylib' },
      { link: path.join(darwinLib, 'libssl.dylib'),     target: 'libssl.1.0.0.dylib'    },
    ];

    for (const { link, target } of symlinks) {
      if (fs.existsSync(link)) continue; // já existe, pula
      try {
        // Cria como arquivo regular apontando para o target (fallback sem symlink real)
        const targetPath = path.join(darwinLib, target);
        if (fs.existsSync(targetPath)) {
          fs.copyFileSync(targetPath, link);
        } else {
          fs.writeFileSync(link, ''); // arquivo vazio como placeholder
        }
      } catch (_) {
        // Ignora — o builder consegue continuar mesmo sem esses arquivos macOS
      }
    }
  }
};

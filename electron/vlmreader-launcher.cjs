'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PROJECT_URL = 'https://github.com/XKRyan/VLMReader';
const VERSION = '0.6.16';
const DOWNLOAD_URL = `${PROJECT_URL}/releases/download/v${VERSION}/VLMReader-Setup-${VERSION}-x64.msi`;
// Prefix documented at https://gh-proxy.com/docs/quick-start.
const ACCELERATED_URL = `https://gh-proxy.org/${DOWNLOAD_URL}`;

async function windowsInstallLocations() {
  const keys = ['HKCU\\Software\\VLMReader\\MSI', 'HKLM\\Software\\VLMReader\\MSI'];
  return (await Promise.all(keys.map(key => new Promise(resolve => {
    execFile('reg.exe', ['query', key, '/v', 'InstallLocation'], { windowsHide: true, timeout: 1500, maxBuffer: 8192, encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? '' : /^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+)$/mi.exec(stdout)?.[1].trim() || '');
    });
  })))).filter(Boolean);
}

function createVlmReaderLauncher({ openPath, platform = process.platform, env = process.env,
  readInstallLocations = windowsInstallLocations,
  exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } },
} = {}) {
  let pending = null;
  const info = () => ({ version: VERSION, projectUrl: PROJECT_URL, downloadUrl: DOWNLOAD_URL, acceleratedUrl: ACCELERATED_URL });
  async function open() {
    if (platform !== 'win32') return { opened: false, ...info() };
    const roots = [...await readInstallLocations().catch(() => []), 'D:\\VLMReader',
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'VLMReader'),
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'VLMReader'),
      env.ProgramFiles && path.win32.join(env.ProgramFiles, 'VLMReader')].filter(Boolean);
    const candidates = [...new Set(roots.flatMap(root => [path.win32.join(root, 'release', 'win-unpacked', 'VLMReader.exe'), path.win32.join(root, 'VLMReader.exe')]))];
    for (const file of candidates) {
      if (!exists(file)) continue;
      try { if (!await openPath(file)) return { opened: true, ...info() }; } catch { /* try another installation */ }
    }
    return { opened: false, ...info() };
  }
  return { open: () => pending || (pending = open().finally(() => { pending = null; })) };
}

module.exports = { createVlmReaderLauncher, windowsInstallLocations, PROJECT_URL, DOWNLOAD_URL, ACCELERATED_URL };

'use strict';
// StudyMate is a separate local Python/FastAPI app (pywebview). PH Launcher
// must never reimplement its UI or its AI; it only detects the local install,
// starts it when needed and hands the user to the app. The same contract can
// later be used for other study companions, so VLMReader and StudyMate share
// the "study tool" card styles rather than growing two bespoke pages.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = 8765;
const PROJECT_URL = ''; // set when the repository is published
const HEALTH_PATH = '/api/health';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function existsFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function health(port = PORT, timeout = 800) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: HEALTH_PATH, timeout }, response => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

function candidateRoots({ env = process.env, configured = '' } = {}) {
  return [...new Set([
    configured,
    'D:\\deepstudy',
    'D:\\DeepStudy',
    'D:\\StudyMate',
    env.USERPROFILE && path.win32.join(env.USERPROFILE, 'deepstudy'),
    env.USERPROFILE && path.win32.join(env.USERPROFILE, 'StudyMate'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'StudyMate'),
  ].filter(Boolean))];
}

function createStudyMateLauncher({
  platform = process.platform,
  env = process.env,
  getConfiguredRoot = () => '',
  exists = existsFile,
  healthCheck = health,
  spawnProcess = spawn,
  port = PORT,
  waitAttempts = 20,
  waitMs = 500,
} = {}) {
  let pending = null;

  function find() {
    for (const root of candidateRoots({ env, configured: String(getConfiguredRoot() || '') })) {
      const candidates = [
        { root, pythonw: path.win32.join(root, '.venv', 'Scripts', 'pythonw.exe') },
        { root, pythonw: path.win32.join(root, 'Scripts', 'pythonw.exe') },
      ];
      const script = path.win32.join(root, 'deepstudy.pyw');
      for (const candidate of candidates) {
        if (exists(candidate.pythonw) && exists(script)) return { ...candidate, script };
      }
    }
    return null;
  }

  async function status() {
    const running = platform === 'win32' && await healthCheck(port);
    const found = find();
    return {
      available: Boolean(found) || running,
      running,
      path: found?.root || '',
      url: running ? `http://127.0.0.1:${port}` : '',
      projectUrl: PROJECT_URL,
    };
  }

  async function open() {
    if (platform !== 'win32') return { opened: false, available: false, projectUrl: PROJECT_URL };
    const running = await healthCheck(port);
    if (running) {
      return { opened: true, available: true, running: true, spawned: false, url: `http://127.0.0.1:${port}`, projectUrl: PROJECT_URL };
    }
    const found = find();
    if (!found) return { opened: false, available: false, running: false, projectUrl: PROJECT_URL };
    try {
      const child = spawnProcess(found.pythonw, [found.script], {
        cwd: found.root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref?.();
    } catch (error) {
      return { opened: false, available: true, running: false, path: found.root, error: error.message, projectUrl: PROJECT_URL };
    }
    for (let attempt = 0; attempt < waitAttempts; attempt += 1) {
      await sleep(waitMs);
      if (await healthCheck(port)) {
        return { opened: true, available: true, running: true, spawned: true, url: `http://127.0.0.1:${port}`, path: found.root, projectUrl: PROJECT_URL };
      }
    }
    return { opened: false, available: true, running: false, path: found.root, error: 'StudyMate 启动超时，请稍后重试', projectUrl: PROJECT_URL };
  }

  return {
    status,
    open: () => pending || (pending = open().finally(() => { pending = null; })),
  };
}

module.exports = { createStudyMateLauncher, candidateRoots, health, existsFile, PORT, PROJECT_URL };

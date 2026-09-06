'use strict';

const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';

function isDefaultOllamaEndpoint(value) {
  try {
    const endpoint = new URL(String(value || ''));
    return endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port === '11434' &&
      !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
      (endpoint.pathname === '/' || endpoint.pathname === '');
  } catch {
    return false;
  }
}

function canStartConfiguredLocalRuntime(config, { headless = false } = {}) {
  return Boolean(!headless && config?.enabled && config.provider === 'local' && String(config.localModel || '').trim() &&
    isDefaultOllamaEndpoint(config.localEndpoint));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('本地模型预热已停止');
}

// This orchestrates only an already-installed executable. Installation, model
// pulling and process termination intentionally do not exist in this runtime path.
async function ensureDefaultInstalledOllamaService({ signal, isReady, findInstalled, verifyInstalled, startService }) {
  for (const dependency of [isReady, findInstalled, verifyInstalled, startService]) {
    if (typeof dependency !== 'function') throw new TypeError('local AI runtime requires guarded service dependencies');
  }
  throwIfAborted(signal);
  if (await isReady()) return { ready: true, started: false, installed: true };
  throwIfAborted(signal);
  const executable = await findInstalled();
  throwIfAborted(signal);
  if (!executable) return { ready: false, started: false, installed: false };
  await verifyInstalled(executable);
  throwIfAborted(signal);
  await startService(executable);
  throwIfAborted(signal);
  return { ready: true, started: true, installed: true };
}

module.exports = { DEFAULT_OLLAMA_ENDPOINT, isDefaultOllamaEndpoint, canStartConfiguredLocalRuntime, ensureDefaultInstalledOllamaService };

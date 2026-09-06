'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canStartConfiguredLocalRuntime, ensureDefaultInstalledOllamaService } = require('../electron/local-ai-runtime.cjs');
const { LocalAiDeploymentManager } = require('../electron/ai-deployment.cjs');

const localConfig = { enabled: true, provider: 'local', localEndpoint: 'http://127.0.0.1:11434', localModel: 'qwen-test' };

test('only an enabled default local configuration may start Ollama at app startup', () => {
  assert.equal(canStartConfiguredLocalRuntime(localConfig), true);
  assert.equal(canStartConfiguredLocalRuntime({ ...localConfig, provider: 'api' }), false);
  assert.equal(canStartConfiguredLocalRuntime({ ...localConfig, enabled: false }), false);
  assert.equal(canStartConfiguredLocalRuntime({ ...localConfig, localEndpoint: 'http://localhost:11434' }), false);
  assert.equal(canStartConfiguredLocalRuntime({ ...localConfig, localEndpoint: 'http://127.0.0.1:11435' }), false);
  assert.equal(canStartConfiguredLocalRuntime({ ...localConfig, localEndpoint: 'http://user:pass@127.0.0.1:11434' }), false);
  assert.equal(canStartConfiguredLocalRuntime({ ...localConfig, localEndpoint: 'http://127.0.0.1:11434/?next=x' }), false);
  assert.equal(canStartConfiguredLocalRuntime(localConfig, { headless: true }), false);
});

test('the real service launcher rechecks cancellation after its readiness probe before spawning', async () => {
  const manager = new LocalAiDeploymentManager({
    getHardwareProfile: async () => ({}), configureAi: async () => {}, emit: () => {}, platform: 'win32', logPath: '',
  });
  const controller = new AbortController();
  let spawned = 0;
  manager.isApiReady = async () => { controller.abort(new Error('switched to API')); return false; };
  manager.spawnDetached = () => { spawned += 1; };
  await assert.rejects(manager.ensureOllamaService('C:/Ollama/ollama.exe', { signal: controller.signal }), /switched to API/);
  assert.equal(spawned, 0);
});

test('the real readiness wait stops when cancellation occurs during a probe', async () => {
  const manager = new LocalAiDeploymentManager({ getHardwareProfile: async () => ({}), configureAi: async () => {}, emit: () => {}, platform: 'win32', logPath: '' });
  const controller = new AbortController();
  let probes = 0;
  manager.isApiReady = async () => { probes += 1; controller.abort(new Error('settings changed')); return true; };
  await assert.rejects(manager.waitForApi(3, { signal: controller.signal }), /settings changed/);
  assert.equal(probes, 1);
});

test('installed default Ollama is verified and started without any install or download path', async () => {
  const calls = [];
  const result = await ensureDefaultInstalledOllamaService({
    isReady: async () => { calls.push('ready'); return false; },
    findInstalled: async () => { calls.push('find'); return 'C:/Ollama/ollama.exe'; },
    verifyInstalled: async (file) => { calls.push(`verify:${file}`); },
    startService: async (file) => { calls.push(`start:${file}`); },
  });
  assert.deepEqual(result, { ready: true, started: true, installed: true });
  assert.deepEqual(calls, ['ready', 'find', 'verify:C:/Ollama/ollama.exe', 'start:C:/Ollama/ollama.exe']);
});

test('API/off paths never invoke the local runtime and cancellation prevents a delayed spawn', async () => {
  let calls = 0;
  for (const config of [{ ...localConfig, provider: 'api' }, { ...localConfig, provider: 'off' }]) {
    if (canStartConfiguredLocalRuntime(config)) {
      await ensureDefaultInstalledOllamaService({ isReady: async () => { calls += 1; return true; }, findInstalled: async () => '', verifyInstalled: async () => {}, startService: async () => {} });
    }
  }
  assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(ensureDefaultInstalledOllamaService({
    signal: controller.signal,
    isReady: async () => false,
    findInstalled: async () => { controller.abort(new Error('switched')); return 'C:/Ollama/ollama.exe'; },
    verifyInstalled: async () => { calls += 1; },
    startService: async () => { calls += 1; },
  }), /switched/);
  assert.equal(calls, 0);
});

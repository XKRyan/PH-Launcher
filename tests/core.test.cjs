const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const yaml = require('js-yaml');
const {
  DOCUMENT_ASSETS: WINDOWS_RELEASE_DOCUMENT_ASSETS,
  FIXED_ASSETS: WINDOWS_RELEASE_FIXED_ASSETS,
  FIXED_MANIFEST_CONTENT: WINDOWS_RELEASE_MANIFEST,
  MANIFEST_NAME: WINDOWS_RELEASE_MANIFEST_NAME,
  NEW_MANIFEST: WINDOWS_RELEASE_NEW_MANIFEST,
  OLD_MANIFEST: WINDOWS_RELEASE_OLD_MANIFEST,
  analyzeRelease: analyzeWindowsRelease,
  validateFinalRelease: validateFinalWindowsRelease,
} = require('../scripts/windows-release-asset-repair.cjs');

const { recommendLocalModel } = require('../electron/hardware.cjs');
const {
  cleanProgressText,
  hasModel,
  isAllowedModel,
  LocalAiDeploymentManager,
  OLLAMA_MAC_BUNDLE_ID,
  OLLAMA_MAC_SHA256,
  OLLAMA_MAC_TEAM_ID,
  OLLAMA_MAC_VERSION,
  isLoopbackOllamaListener,
  parseMacLsofListeners,
  parseMacSignatureDetails,
  requiredSpaceGb,
  translatePullStatus,
} = require('../electron/ai-deployment.cjs');
const { getSiteCss } = require('../electron/site-styles.cjs');
const {
  SiteStoragePersistence,
  isAllowedSitePermission,
  isTrustedSiteUrl,
} = require('../electron/site-session.cjs');
const { OfflineDictionary, normalizeSearchKey } = require('../electron/dictionary.cjs');
const {
  PendingActionStore,
  applyActions,
  createAction,
  sanitizeToolArguments,
  toolKind,
} = require('../electron/ai-tools.cjs');
const { normalizeExtractorResult } = require('../electron/edupage-timetable.cjs');
const {
  commandTermCatalog,
  listCommandTerms,
} = require('../electron/ib-command-terms.cjs');
const {
  MAX_CUSTOM_SITES,
  customSiteOrigin,
  isTrustedCustomSiteUrl,
  normalizeCustomSites,
  normalizeCustomSiteUrl,
  removeCustomSite,
  reorderCustomSites,
  runtimeCustomSite,
  upsertCustomSite,
} = require('../electron/custom-sites.cjs');
const {
  CLEAN_DISPLAY_DEFAULTS,
  CLEAN_DISPLAY_RESET_VERSION,
  DATA_VERSION,
  normalizeCleanDisplaySettings,
} = require('../electron/site-settings.cjs');

test('hardware recommendation is conservative on low-memory and low-disk PCs', () => {
  assert.equal(recommendLocalModel({ ramGb: 7.9, vramGb: 8, diskFreeGb: 100 }).recommended, false);
  assert.equal(recommendLocalModel({ ramGb: 32, vramGb: 8, diskFreeGb: 5.9 }).recommended, false);
});

test('IB command terms are filtered by subject from one shared catalog', () => {
  const catalog = commandTermCatalog();
  const subjectIds = catalog.subjects.map((subject) => subject.id);
  assert.equal(new Set(subjectIds).size, subjectIds.length);
  assert.ok(subjectIds.includes('math-aa'));
  assert.ok(subjectIds.includes('physics'));
  assert.ok(subjectIds.includes('economics'));
  assert.ok(subjectIds.includes('history-through-2027'));
  assert.ok(subjectIds.includes('history-from-2028'));

  const mathTerms = listCommandTerms({ subjectId: 'math-aa' }).map((item) => item.id);
  const economicsTerms = listCommandTerms({ subjectId: 'economics' }).map((item) => item.id);
  assert.ok(mathTerms.includes('prove'));
  assert.ok(mathTerms.includes('write-down'));
  assert.ok(mathTerms.includes('hence-or-otherwise'));
  assert.ok(!economicsTerms.includes('prove'));
  assert.ok(economicsTerms.includes('recommend'));

  const spellingAlias = listCommandTerms({ subjectId: 'physics', query: 'analyze' });
  assert.equal(spellingAlias[0].term, 'Analyse');
  assert.match(catalog.note, /当前学科指南/);
  assert.equal(catalog.verifiedAt, '2026-09-02');
});

test('IB subject/version lists stay exact instead of merging broad cross-subject glossaries', () => {
  const expected = {
    'language-a': 'analyse comment compare compare-and-contrast contrast describe discuss evaluate examine explain explore interpret investigate justify present to-what-extent',
    'language-b': 'analyse demonstrate describe discuss evaluate examine explain identify outline present state',
    'language-ab-initio': 'analyse demonstrate describe discuss evaluate examine explain identify outline present state',
    'math-aa': 'calculate comment compare compare-and-contrast construct contrast deduce demonstrate describe determine differentiate distinguish draw estimate explain find hence hence-or-otherwise identify integrate interpret investigate justify label list plot predict prove show show-that sketch solve state suggest verify write-down',
    'math-ai': 'calculate comment compare compare-and-contrast construct contrast deduce demonstrate describe determine differentiate distinguish draw estimate explain find hence hence-or-otherwise identify integrate interpret investigate justify label list plot predict prove show show-that sketch solve state suggest verify write-down',
    biology: 'define draw label list measure state annotate calculate describe distinguish estimate identify outline analyse comment compare compare-and-contrast construct deduce design determine discuss evaluate explain justify predict sketch suggest',
    chemistry: 'draw state annotate calculate describe estimate outline comment compare contrast deduce determine discuss evaluate explain predict sketch suggest',
    physics: 'draw state annotate calculate describe estimate outline analyse determine discuss explain predict show sketch suggest',
    ess: 'define draw label list measure state annotate apply calculate describe distinguish estimate identify interpret outline analyse comment compare compare-and-contrast construct contrast deduce demonstrate derive design determine discuss evaluate examine explain justify predict sketch suggest to-what-extent',
    economics: 'define describe list outline state analyse apply comment distinguish explain suggest compare compare-and-contrast contrast discuss evaluate examine justify recommend to-what-extent calculate construct derive determine draw identify label measure plot show show-that sketch solve',
    business: 'define describe identify list outline state analyse apply comment demonstrate distinguish explain suggest compare compare-and-contrast contrast discuss evaluate examine justify recommend to-what-extent annotate calculate complete construct determine draw label plot prepare',
    'history-through-2027': 'analyse compare-and-contrast discuss evaluate examine to-what-extent',
    'history-from-2028': 'analyse discuss examine explain to-what-extent',
    geography: 'classify define describe determine estimate identify outline state analyse distinguish explain suggest compare compare-and-contrast contrast discuss evaluate examine justify to-what-extent annotate construct draw label',
    psychology: 'describe state analyse apply comment design explain interpret predict suggest compare-and-contrast discuss evaluate examine to-what-extent',
    'global-politics': 'define describe identify list outline analyse distinguish explain suggest compare compare-and-contrast contrast discuss evaluate examine justify recommend to-what-extent',
    'computer-science': 'define label list state calculate describe distinguish estimate identify outline trace compare construct deduce discuss evaluate explain justify sketch suggest to-what-extent',
    'visual-arts': 'analyse demonstrate describe evaluate examine explain justify outline present',
  };

  for (const [subjectId, source] of Object.entries(expected)) {
    const actual = listCommandTerms({ subjectId }).map((item) => item.id).sort();
    assert.deepEqual(actual, source.split(' ').sort(), subjectId);
  }

  assert.deepEqual(listCommandTerms({ subjectId: 'biology', query: 'define' })[0].objectives, ['AO1']);
  assert.deepEqual(listCommandTerms({ subjectId: 'language-a', query: 'compare' }).find((item) => item.id === 'compare').objectives, ['AO1', 'AO2', 'AO3']);
  assert.deepEqual(listCommandTerms({ subjectId: 'visual-arts', query: 'analyse' })[0].objectives, []);
});

test('AI command-term lookup accepts an optional subject without changing write permissions', () => {
  assert.deepEqual(
    sanitizeToolArguments('ib_command_lookup', { query: 'evaluate', subject: 'economics' }, {}),
    { query: 'evaluate', subject: 'economics' },
  );
  assert.deepEqual(
    sanitizeToolArguments('ib_command_lookup', { query: 'prove' }, {}),
    { query: 'prove', subject: 'all' },
  );
  assert.deepEqual(
    sanitizeToolArguments('ib_command_lookup', { subject: 'physics' }, {}),
    { query: '', subject: 'physics' },
  );
  assert.throws(() => sanitizeToolArguments('ib_command_lookup', {}, {}), /指令词或科目/);
  assert.equal(toolKind('ib_command_lookup'), 'read');
});

test('IB Docs stays an explicit non-official external link', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.match(renderer, /system\.openUrl\('https:\/\/ibdocs\.re\/'\)/);
  assert.match(renderer, /IB Docs 是第三方网站/);
  assert.match(renderer, /sample-exam-papers/);
  assert.match(page, /与 IBO 无隶属或背书关系/);
  assert.doesNotMatch(page, /(?:iframe|webview)[^>]+ibdocs\.re/i);
  assert.doesNotMatch(main, /ibdocs[^\n]+partition:/i);
});

test('hardware recommendation scales per machine', () => {
  assert.equal(recommendLocalModel({ ramGb: 8, vramGb: 0, diskFreeGb: 6 }).model, 'qwen3.5:0.8b');
  assert.equal(recommendLocalModel({ ramGb: 12, vramGb: 0, diskFreeGb: 8 }).model, 'qwen3.5:2b');
  assert.equal(recommendLocalModel({ ramGb: 20, vramGb: 0, diskFreeGb: 10 }).model, 'qwen3.5:4b');
  const highEnd = recommendLocalModel({ ramGb: 32, vramGb: 8, diskFreeGb: 20 });
  assert.equal(highEnd.model, 'qwen3.5:4b');
  assert.equal(highEnd.advancedModel, 'qwen3.5:9b');
});

test('one-click deployment only accepts reviewed models and reserves installation space', () => {
  assert.equal(isAllowedModel('qwen3.5:4b'), true);
  assert.equal(isAllowedModel('qwen3.5:27b'), false);
  assert.equal(isAllowedModel('qwen3.5:4b; Remove-Item C:\\'), false);
  assert.equal(requiredSpaceGb('qwen3.5:4b', true), 9.4);
  assert.equal(requiredSpaceGb('qwen3.5:4b', false), 5.4);
  assert.equal(requiredSpaceGb('unknown', true), Infinity);
});

test('one-click deployment sanitizes progress and recognizes installed tags', () => {
  assert.equal(cleanProgressText('\u001b[31mpulling manifest\u001b[0m\r'), 'pulling manifest');
  assert.equal(translatePullStatus('verifying sha256 digest'), '正在校验模型文件');
  assert.equal(hasModel({ models: [{ name: 'qwen3.5:2b' }] }, 'qwen3.5:2b'), true);
  assert.equal(hasModel({ models: [{ model: 'qwen3.5:4b' }] }, 'qwen3.5:2b'), false);
});

test('one-click deployment enables the detected model only after verification', async () => {
  let configured = null;
  const emitted = [];
  const manager = new LocalAiDeploymentManager({
    getHardwareProfile: async () => ({
      diskFreeGb: 20,
      recommendation: { recommended: true, model: 'qwen3.5:2b', label: '推荐 Qwen3.5 2B' },
    }),
    configureAi: async (config) => { configured = config; },
    emit: (state) => emitted.push(state.stage),
    fetchImpl: async () => { throw new Error('unexpected network request'); },
  });
  manager.findOllama = async () => 'C:\\Program Files\\Ollama\\ollama.exe';
  manager.ensureOllamaService = async () => {};
  manager.pullModel = async () => manager.update({ stage: 'downloading-model', progress: 95 });
  manager.fetchTags = async () => ({ models: [{ name: 'qwen3.5:2b' }] });

  const started = manager.start();
  assert.equal(started.running, true);
  const task = manager.activeTask;
  await task;
  assert.equal(manager.snapshot().stage, 'complete');
  assert.deepEqual(configured, {
    enabled: true,
    provider: 'local',
    localEndpoint: 'http://127.0.0.1:11434',
    localModel: 'qwen3.5:2b',
  });
  assert.ok(emitted.includes('verifying-model'));
  assert.equal(emitted.at(-1), 'complete');
});

test('model download uses the current Ollama pull API contract', async () => {
  let request = null;
  const manager = new LocalAiDeploymentManager({
    getHardwareProfile: async () => ({}),
    configureAi: async () => {},
    emit: () => {},
    fetchImpl: async (url, options) => {
      request = { url, options };
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":"success"}\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    },
  });
  await manager.pullModel('qwen3.5:0.8b');
  assert.equal(request.url, 'http://127.0.0.1:11434/api/pull');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'qwen3.5:0.8b', stream: true });
});

test('Ollama installer download resumes from a saved partial file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-resume-test-'));
  try {
    const installerPath = path.join(directory, 'OllamaSetup.exe');
    fs.writeFileSync(`${installerPath}.part`, Buffer.alloc(600_000, 1));
    fs.writeFileSync(`${installerPath}.json`, JSON.stringify({
      sourceUrl: 'https://ollama.com/download/OllamaSetup.exe',
      expectedSha256: '',
      etag: '"test-etag"',
      total: 1_200_000,
    }));
    let requestHeaders = null;
    const manager = new LocalAiDeploymentManager({
      platform: 'win32',
      downloadDirectory: directory,
      getHardwareProfile: async () => ({}),
      configureAi: async () => {},
      emit: () => {},
      fetchImpl: async (_url, options) => {
        requestHeaders = options.headers;
        return new Response(Buffer.alloc(600_000, 2), {
          status: 206,
          headers: {
            'content-length': '600000',
            'content-range': 'bytes 600000-1199999/1200000',
            etag: '"test-etag"',
          },
        });
      },
    });
    const completedPath = await manager.downloadInstaller();
    assert.equal(requestHeaders.range, 'bytes=600000-');
    assert.equal(requestHeaders['if-range'], '"test-etag"');
    assert.equal(fs.statSync(completedPath).size, 1_200_000);
    const completed = fs.readFileSync(completedPath);
    assert.equal(completed[0], 1);
    assert.equal(completed.at(-1), 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('complete installer cache is rejected when it exceeds the configured maximum', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-cache-limit-test-'));
  try {
    const url = 'https://example.test/Ollama.dmg';
    const installerPath = path.join(directory, 'Ollama.dmg');
    fs.writeFileSync(installerPath, Buffer.alloc(11, 1));
    fs.writeFileSync(`${installerPath}.json`, JSON.stringify({
      sourceUrl: url,
      expectedSha256: 'reviewed-hash',
    }));
    let fetched = false;
    const manager = new LocalAiDeploymentManager({
      platform: 'darwin',
      downloadDirectory: directory,
      getHardwareProfile: async () => ({}),
      configureAi: async () => {},
      emit: () => {},
      fetchImpl: async () => {
        fetched = true;
        throw new Error('oversized cache must fail before network access');
      },
    });
    await assert.rejects(
      manager.downloadArtifact({
        url,
        fileName: 'Ollama.dmg',
        minimumBytes: 4,
        maximumBytes: 10,
        platformName: 'macOS',
        expectedSha256: 'reviewed-hash',
      }),
      (error) => error.code === 'PH_OLLAMA_SECURITY_ERROR',
    );
    assert.equal(fetched, false);
    assert.equal(fs.existsSync(installerPath), false);
    assert.equal(fs.existsSync(`${installerPath}.json`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('installer cache with an old source URL or hash is never resumed or reused', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-cache-identity-test-'));
  try {
    const url = 'https://example.test/v2/Ollama.dmg';
    const installerPath = path.join(directory, 'Ollama.dmg');
    fs.writeFileSync(`${installerPath}.part`, Buffer.alloc(4, 1));
    fs.writeFileSync(`${installerPath}.json`, JSON.stringify({
      sourceUrl: 'https://example.test/v1/Ollama.dmg',
      expectedSha256: 'hash-v2',
      etag: '"old-etag"',
    }));
    const requests = [];
    const manager = new LocalAiDeploymentManager({
      platform: 'darwin',
      downloadDirectory: directory,
      getHardwareProfile: async () => ({}),
      configureAi: async () => {},
      emit: () => {},
      fetchImpl: async (_requestUrl, options) => {
        requests.push(options.headers);
        return new Response(Buffer.alloc(8, 2), {
          status: 200,
          headers: { 'content-length': '8', etag: '"new-etag"' },
        });
      },
    });
    let completedPath = await manager.downloadArtifact({
      url,
      fileName: 'Ollama.dmg',
      minimumBytes: 8,
      maximumBytes: 16,
      platformName: 'macOS',
      expectedSha256: 'hash-v2',
    });
    assert.equal(requests[0].range, undefined);
    assert.deepEqual(fs.readFileSync(completedPath), Buffer.alloc(8, 2));

    fs.writeFileSync(installerPath, Buffer.alloc(8, 3));
    fs.writeFileSync(`${installerPath}.json`, JSON.stringify({
      sourceUrl: url,
      expectedSha256: 'hash-v1',
    }));
    manager.fetch = async (_requestUrl, options) => {
      requests.push(options.headers);
      return new Response(Buffer.alloc(9, 4), {
        status: 200,
        headers: { 'content-length': '9' },
      });
    };
    completedPath = await manager.downloadArtifact({
      url,
      fileName: 'Ollama.dmg',
      minimumBytes: 8,
      maximumBytes: 16,
      platformName: 'macOS',
      expectedSha256: 'hash-v2',
    });
    assert.equal(requests[1].range, undefined);
    assert.deepEqual(fs.readFileSync(completedPath), Buffer.alloc(9, 4));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Ollama installer checksum must match the official release manifest', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-checksum-test-'));
  try {
    const artifactPath = path.join(directory, 'OllamaSetup.exe');
    fs.writeFileSync(artifactPath, 'hello');
    const manager = new LocalAiDeploymentManager({
      platform: 'win32',
      getHardwareProfile: async () => ({}),
      configureAi: async () => {},
      emit: () => {},
      fetchImpl: async () => new Response('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  ./OllamaSetup.exe\n'),
    });
    assert.equal(await manager.verifyOfficialChecksum(artifactPath, 'OllamaSetup.exe'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    manager.fetch = async () => new Response(`${'0'.repeat(64)}  ./OllamaSetup.exe\n`);
    await assert.rejects(manager.verifyOfficialChecksum(artifactPath, 'OllamaSetup.exe'), (error) => error.code === 'PH_OLLAMA_SECURITY_ERROR');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('local AI deployment keeps a sanitized diagnostic log', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-log-test-'));
  try {
    const logPath = path.join(directory, 'ai-deployment.jsonl');
    const manager = new LocalAiDeploymentManager({
      logPath,
      getHardwareProfile: async () => ({}),
      configureAi: async () => {},
      emit: () => {},
    });
    manager.update({ stage: 'error', detail: '连接中断\u001b[31m', error: 'fetch failed\u001b[0m' });
    const record = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(record.stage, 'error');
    assert.equal(record.detail, 'fetch failed');
    assert.equal(manager.snapshot().hasDiagnostics, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('macOS local AI deployment installs Ollama and enables the verified model in one flow', async () => {
  let configured = null;
  const calls = [];
  const manager = new LocalAiDeploymentManager({
    platform: 'darwin',
    getHardwareProfile: async () => ({
      diskFreeGb: 20,
      recommendation: { recommended: true, model: 'qwen3.5:2b', label: '推荐 Qwen3.5 2B' },
    }),
    configureAi: async (config) => { configured = config; },
    emit: () => {},
  });
  manager.findOllama = async () => '';
  manager.downloadMacInstaller = async () => {
    calls.push('download');
    return '/tmp/Ollama.dmg';
  };
  manager.verifyOfficialChecksum = async () => calls.push('checksum');
  manager.installOllamaOnMac = async () => {
    calls.push('install');
    return '/Users/student/Applications/Ollama.app/Contents/Resources/ollama';
  };
  manager.clearMacInstallerCache = () => calls.push('clear-cache');
  manager.ensureOllamaService = async () => calls.push('start');
  manager.pullModel = async () => calls.push('pull');
  manager.fetchTags = async () => ({ models: [{ name: 'qwen3.5:2b' }] });
  const started = manager.start();
  assert.equal(started.running, true);
  await manager.activeTask;
  assert.equal(manager.snapshot().stage, 'complete');
  assert.equal(manager.snapshot().running, false);
  assert.deepEqual(calls, ['download', 'checksum', 'install', 'clear-cache', 'start', 'pull']);
  assert.equal(configured.provider, 'local');
  assert.equal(configured.localModel, 'qwen3.5:2b');
});

test('macOS Ollama identity parser pins the reviewed bundle and Apple team', () => {
  assert.equal(OLLAMA_MAC_VERSION, '0.33.2');
  assert.equal(OLLAMA_MAC_SHA256, '01b844bc6058bd34fcab495e0c3e6315147d6488252f24d04ab54ef12048a56e');
  const details = parseMacSignatureDetails([
    `Identifier=${OLLAMA_MAC_BUNDLE_ID}`,
    `Authority=Developer ID Application: Infra Technologies, Inc. (${OLLAMA_MAC_TEAM_ID})`,
    'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA',
    `TeamIdentifier=${OLLAMA_MAC_TEAM_ID}`,
  ].join('\n'));
  assert.equal(details.identifier, 'com.electron.ollama');
  assert.equal(details.teamIdentifier, '3MU9H2V9Y9');
  assert.match(details.authorities[0], /Developer ID Application/);
});

test('macOS lsof listener parser accepts only loopback Ollama bindings', () => {
  const listeners = parseMacLsofListeners([
    'p120',
    'n127.0.0.1:11434',
    'p121',
    'n[::1]:11434',
  ].join('\n'));
  assert.deepEqual(listeners, [
    { processId: '120', address: '127.0.0.1:11434' },
    { processId: '121', address: '[::1]:11434' },
  ]);
  assert.equal(isLoopbackOllamaListener('127.0.0.1:11434'), true);
  assert.equal(isLoopbackOllamaListener('TCP [::1]:11434 (LISTEN)'), true);
  for (const unsafeAddress of [
    '0.0.0.0:11434',
    '*:11434',
    '[::]:11434',
    '192.168.1.8:11434',
    '[fe80::1]:11434',
  ]) {
    assert.equal(isLoopbackOllamaListener(unsafeAddress), false, unsafeAddress);
  }
});

test('macOS mount cleanup preserves the temporary directory until detach is confirmed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-ollama-'));
  const markerPath = path.join(directory, 'mounted-image-marker');
  fs.writeFileSync(markerPath, 'keep');
  const manager = new LocalAiDeploymentManager({
    platform: 'darwin',
    getHardwareProfile: async () => ({}),
    configureAi: async () => {},
    emit: () => {},
  });
  manager.temporaryDirectory = directory;
  manager.mountedMacImage = { device: '/dev/disk99s1', mountPoint: path.join(directory, 'mount') };
  manager.cleanupTemporaryDirectory();
  assert.equal(fs.existsSync(markerPath), true);
  assert.equal(manager.temporaryDirectory, directory);

  manager.mountedMacImage = null;
  manager.cleanupTemporaryDirectory();
  assert.equal(fs.existsSync(directory), false);
  assert.equal(manager.temporaryDirectory, '');
});

test('runProgram timeout converges without leaving the deployment promise pending', async () => {
  const manager = new LocalAiDeploymentManager({
    getHardwareProfile: async () => ({}),
    configureAi: async () => {},
    emit: () => {},
  });
  const startedAt = Date.now();
  await assert.rejects(
    manager.runProgram(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 }),
    /执行超时/,
  );
  assert.ok(Date.now() - startedAt < 6_500);
});

test('clean display styles are limited to approved school-site domains', () => {
  const schoolMailCss = getSiteCss('mail', 'https://mail.shphschool.com/');
  assert.match(schoolMailCss, /--ph-clean-mode:\s*1\s*!important/);
  assert.match(schoolMailCss, /--ph-green/);
  assert.match(schoolMailCss, /login-mod-wrapper\.login-mod-form/);
  assert.match(schoolMailCss, /#donwload_block \{ display: none/);
  assert.match(getSiteCss('managebac', 'https://shph.managebac.cn/login'), /--ph-green/);
  assert.match(getSiteCss('edupage', 'https://pingheschool.edupage.org/'), /--ph-green/);
  assert.match(getSiteCss('edupage', 'https://pingheschool.edupage.org/'), /kids-front-page[\s\S]*Login_0_loginFrm/);
  assert.doesNotMatch(getSiteCss('edupage', 'https://pingheschool.edupage.org/timetable/'), /kids-front-page/);
  assert.match(getSiteCss('mail', 'https://entry.mail.163.com/'), /--ph-clean-mode:\s*1/);
  assert.match(getSiteCss('managebac', 'https://shph.managebac.cn/dashboard'), /linear-gradient/);
  assert.match(getSiteCss('edupage', 'https://pingheschool.edupage.org/timetable/'), /erte-section-inner/);
  assert.equal(getSiteCss('mail', 'https://example.com/'), '');
  assert.equal(getSiteCss('edupage', 'javascript:alert(1)'), '');
});

test('clean display defaults off once and future data upgrades preserve the user choice', () => {
  assert.equal(DATA_VERSION, 2);
  assert.equal(CLEAN_DISPLAY_RESET_VERSION, 2);
  assert.deepEqual(CLEAN_DISPLAY_DEFAULTS, { mail: false, managebac: false, edupage: false });
  const previouslyEnabled = { mail: true, managebac: true, edupage: true };
  assert.deepEqual(normalizeCleanDisplaySettings(undefined, previouslyEnabled), CLEAN_DISPLAY_DEFAULTS);
  assert.deepEqual(normalizeCleanDisplaySettings(1, previouslyEnabled), CLEAN_DISPLAY_DEFAULTS);
  assert.deepEqual(normalizeCleanDisplaySettings(2, { mail: true, managebac: false, edupage: true }), {
    mail: true,
    managebac: false,
    edupage: true,
  });
  assert.deepEqual(normalizeCleanDisplaySettings(99, { mail: true, managebac: 1, edupage: false }), {
    mail: true,
    managebac: false,
    edupage: false,
  });
});

test('custom website URLs are HTTPS-only and same-origin trust never widens to subdomains or ports', () => {
  assert.equal(normalizeCustomSiteUrl('example.com/path'), 'https://example.com/path');
  assert.equal(customSiteOrigin('https://example.com/path?a=1'), 'https://example.com');
  assert.throws(() => normalizeCustomSiteUrl('http://example.com/'), /仅支持 HTTPS/);
  assert.throws(() => normalizeCustomSiteUrl('file:///tmp/example'), /仅支持 HTTPS/);
  assert.throws(() => normalizeCustomSiteUrl('javascript:alert(1)'), /仅支持 HTTPS/);
  assert.throws(() => normalizeCustomSiteUrl('https://user:secret@example.com/'), /账号或密码/);
  assert.throws(() => normalizeCustomSiteUrl('https://example.com/\n'), /无效字符/);
  assert.throws(() => normalizeCustomSiteUrl(`https://example.com/${'a'.repeat(2048)}`), /网址过长/);

  const record = { url: 'https://foo.github.io/classes/' };
  assert.equal(isTrustedCustomSiteUrl(record, 'https://foo.github.io/login'), true);
  assert.equal(isTrustedCustomSiteUrl(record, 'https://bar.foo.github.io/login'), false);
  assert.equal(isTrustedCustomSiteUrl(record, 'https://foo.github.io:444/login'), false);
  assert.equal(isTrustedCustomSiteUrl(record, 'http://foo.github.io/login'), false);
});

test('custom websites have canonical IDs, isolated sessions, safe imports and bounded CRUD', () => {
  const uuid = '12345678-1234-4123-8123-123456789abc';
  const created = upsertCustomSite([], {
    name: ' Kognity ',
    url: 'kognity.com/',
    color: 'blue',
    shortcut: ' CommandOrControl + Alt + 4 ',
    shortcutEnabled: true,
    partition: 'persist:attacker-controlled',
  }, () => uuid);
  assert.equal(created.created, true);
  assert.equal(created.site.id, `custom-${uuid}`);
  assert.equal(created.site.name, 'Kognity');
  assert.equal(created.site.url, 'https://kognity.com/');
  assert.equal(created.site.shortcut, 'CommandOrControl+Alt+4');
  assert.equal(created.site.partition, undefined);

  const runtime = runtimeCustomSite(created.site);
  assert.equal(runtime.custom, true);
  assert.equal(runtime.partition, `persist:ph-site-custom-${uuid}`);
  assert.deepEqual(runtime.trustedHosts, ['kognity.com']);

  const edited = upsertCustomSite(created.sites, { ...created.site, url: 'https://kognity.com/library' });
  assert.equal(edited.created, false);
  assert.equal(edited.site.id, created.site.id);
  assert.equal(customSiteOrigin(edited.site.url), customSiteOrigin(created.site.url));

  const unsafeImport = normalizeCustomSites([
    created.site,
    created.site,
    { ...created.site, id: 'custom-not-a-uuid', url: 'https://example.com/' },
    { id: 'custom-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'HTTP', url: 'http://example.com/' },
  ]);
  assert.deepEqual(unsafeImport, [created.site]);

  assert.deepEqual(removeCustomSite(created.sites, created.site.id), []);
  assert.throws(() => removeCustomSite([], created.site.id), /已不存在/);

  const full = Array.from({ length: MAX_CUSTOM_SITES }, (_, index) => ({
    id: `custom-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `Site ${index}`,
    url: `https://site-${index}.example/`,
    color: 'green',
    shortcut: '',
    shortcutEnabled: false,
  }));
  assert.equal(normalizeCustomSites(full).length, MAX_CUSTOM_SITES);
  assert.throws(() => upsertCustomSite(full, { name: 'Extra', url: 'https://extra.example/' }), /最多可添加/);

  const collisionUuid = uuid;
  assert.throws(
    () => upsertCustomSite(created.sites, { name: 'Collision', url: 'https://collision.example/' }, () => collisionUuid),
    /唯一的网页标识/,
  );
});

test('custom website order must contain every current ID exactly once', () => {
  const sites = [0, 1, 2].map((index) => ({
    id: `custom-11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    name: `Site ${index}`,
    url: `https://site-${index}.example/`,
    color: 'green',
    shortcut: '',
    shortcutEnabled: false,
  }));
  const reversed = reorderCustomSites(sites, sites.map((site) => site.id).reverse());
  assert.deepEqual(reversed.map((site) => site.id), sites.map((site) => site.id).reverse());
  assert.throws(() => reorderCustomSites(sites, [sites[0].id, sites[0].id, sites[2].id]), /排序数据无效/);
  assert.throws(() => reorderCustomSites(sites, [sites[0].id]), /排序数据无效/);
});

test('site permissions only allow approved capabilities when requester and embedder are trusted HTTPS hosts', () => {
  const site = { trustedHosts: ['edupage.org'] };
  const trusted = {
    topLevelUrl: 'https://pingheschool.edupage.org/timetable/',
    requestingUrl: 'https://login1.edupage.org/auth',
    embeddingUrl: 'https://pingheschool.edupage.org/',
  };
  assert.equal(isTrustedSiteUrl(site, trusted.topLevelUrl), true);
  assert.equal(isAllowedSitePermission(site, 'storage-access', trusted), true);
  assert.equal(isAllowedSitePermission(site, 'top-level-storage-access', trusted), true);
  assert.equal(isAllowedSitePermission(site, 'notifications', trusted), true);
  assert.equal(isAllowedSitePermission(site, 'camera', trusted), false);
  assert.equal(isAllowedSitePermission(site, 'storage-access', { ...trusted, requestingUrl: 'https://evil.example/' }), false);
  assert.equal(isAllowedSitePermission(site, 'storage-access', { ...trusted, embeddingUrl: 'https://evil.example/' }), false);
  assert.equal(isAllowedSitePermission(site, 'storage-access', { ...trusted, topLevelUrl: 'http://pingheschool.edupage.org/' }), false);
});

test('site storage persistence flushes changed cookies and DOM storage without reading or rewriting cookies', async () => {
  let changed;
  let cookieFlushes = 0;
  let storageFlushes = 0;
  const siteSession = {
    cookies: {
      on(event, callback) {
        assert.equal(event, 'changed');
        changed = callback;
      },
      async flushStore() { cookieFlushes += 1; },
    },
    async flushStorageData() { storageFlushes += 1; },
  };
  const persistence = new SiteStoragePersistence({ delayMs: 5 });
  persistence.watch(siteSession);
  changed();
  changed();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(cookieFlushes, 1);
  assert.equal(storageFlushes, 1);

  persistence.schedule(siteSession);
  await persistence.flushAll();
  assert.equal(cookieFlushes, 2);
  assert.equal(storageFlushes, 2);
});

test('site storage flush timeout cannot block application shutdown indefinitely', async () => {
  const never = new Promise(() => {});
  const siteSession = {
    cookies: { on() {}, flushStore: () => never },
    flushStorageData: () => never,
  };
  const persistence = new SiteStoragePersistence({ flushTimeoutMs: 10 });
  persistence.watch(siteSession);
  const startedAt = Date.now();
  await assert.rejects(persistence.flushAll(), /网站登录数据写入失败/);
  assert.ok(Date.now() - startedAt < 500);
});

test('site storage flush timeout remains referenced until its rejection is observed', () => {
  const modulePath = path.join(__dirname, '..', 'electron', 'site-session.cjs');
  const script = `
    const { SiteStoragePersistence } = require(${JSON.stringify(modulePath)});
    const never = new Promise(() => {});
    const siteSession = {
      cookies: { on() {}, flushStore: () => never },
      flushStorageData: () => never,
    };
    const persistence = new SiteStoragePersistence({ flushTimeoutMs: 10 });
    persistence.watch(siteSession);
    persistence.flushAll().then(
      () => { process.stderr.write('unexpected resolution'); process.exitCode = 2; },
      (error) => {
        if (!/网站登录数据写入失败/.test(String(error))) {
          process.stderr.write(String(error));
          process.exitCode = 3;
          return;
        }
        process.stdout.write('timeout-observed');
      },
    );
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.equal(child.stdout, 'timeout-observed');
});

test('custom website IPC cannot bypass sanitization and clearing closes every view before erasing its session', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

  assert.match(main, /ipcMain\.handle\('site:custom-upsert'/);
  assert.match(main, /assertMainRenderer\(event\)/);
  assert.match(main, /customSites: secureStore\.data\.settings\.customSites/);
  assert.match(main, /if \(site\.custom\) return callback\(false\)/);
  assert.match(main, /if \(site\.custom\) return false/);
  assert.match(main, /isTrustedPopupUrl\(site, url\)/);
  assert.match(main, /customSiteOrigin\(oldSite\.url\) !== customSiteOrigin\(result\.site\.url\)/);
  assert.match(main, /child\.destroy\(\)/);
  assert.match(main, /siteSession\.clearAuthCache\(\)/);
  assert.match(main, /siteSession\.closeAllConnections\(\)/);
  assert.match(main, /siteSession\.on\('will-download'/);
  assert.match(main, /dialog\.showSaveDialog/);
  assert.match(main, /disposeSiteView\(siteId\);\s*await clearSiteStorage\(site\)/);
  assert.match(main, /popupCssKeys/);
  assert.match(preload, /ipcRenderer\.invoke\('site:custom-upsert'/);
  assert.match(preload, /ipcRenderer\.invoke\('site:custom-remove'/);
  assert.match(preload, /ipcRenderer\.invoke\('site:custom-reorder'/);
  assert.match(renderer, /wasViewingSite[\s\S]*?navigate\('settings'\)[\s\S]*?sites\.hide\(\)/);
  assert.match(page, /id="customSiteDialog"/);
  assert.match(page, /自定义网页仅支持 HTTPS|仅支持 HTTPS/);
  assert.doesNotMatch(page, /<(?:iframe|webview)\b/i);
});

test('AI tool gateway rejects unknown, destructive and arbitrary navigation requests', () => {
  assert.equal(toolKind('create_tasks'), 'write');
  assert.equal(toolKind('preview_edupage_timetable'), 'read');
  assert.equal(toolKind('open_custom_site'), 'command');
  assert.equal(toolKind('delete_everything'), 'unknown');
  assert.throws(() => sanitizeToolArguments('delete_task', { taskId: 'x' }, {}), /未授权/);
  assert.throws(() => sanitizeToolArguments('open_launcher_page', { page: 'https://example.com' }, {}), /不支持/);
  assert.deepEqual(sanitizeToolArguments('open_launcher_page', { page: 'ibdocs' }, {}), { page: 'ibdocs' });
  const customSite = {
    id: 'custom-22222222-2222-4222-8222-222222222222',
    name: 'Kognity',
    url: 'https://kognity.com/',
    color: 'green',
    shortcut: '',
    shortcutEnabled: false,
  };
  assert.deepEqual(
    sanitizeToolArguments('open_custom_site', { siteName: 'kognity' }, { settings: { customSites: [customSite] } }),
    { siteId: customSite.id, siteName: 'Kognity' },
  );
  assert.throws(
    () => sanitizeToolArguments('open_custom_site', { siteName: 'https://example.com' }, { settings: { customSites: [customSite] } }),
    /找不到/,
  );
});

test('AI writes stay pending until a matching proposal is confirmed', () => {
  const data = { notes: [], tasks: [], schedule: [], settings: {}, focusSessions: [], ib: {} };
  const action = createAction('create_tasks', { tasks: [{ title: '完成 EE 提纲', subject: 'EE', priority: 'high' }] }, data);
  const store = new PendingActionStore();
  const proposal = store.create([action], data);
  assert.equal(data.tasks.length, 0);
  assert.equal(proposal.requiresConfirmation, true);
  assert.equal(proposal.groups[0].items[0].primary, '完成 EE 提纲');
  const committed = store.commit(proposal.id, data);
  assert.equal(committed.data.tasks.length, 1);
  assert.equal(committed.data.tasks[0].source, 'ai');
  assert.equal(committed.counts.tasksAdded, 1);
  assert.throws(() => store.commit(proposal.id, data), /过期|已经处理/);
});

test('AI proposals fail closed when launcher data changed after preview', () => {
  const data = { notes: [], tasks: [], schedule: [] };
  const action = createAction('create_notes', { notes: [{ title: '课堂问题', body: '待问老师' }] }, data);
  const store = new PendingActionStore();
  const proposal = store.create([action], data);
  data.notes.push({ id: 'manual', title: '新笔记', body: '' });
  assert.throws(() => store.commit(proposal.id, data), /数据已发生变化/);
  assert.equal(data.notes.length, 1);
});

test('schedule merge never deletes manual lessons and deduplicates exact matches', () => {
  const baseLesson = { id: 'manual', course: 'Physics', dayOfWeek: 1, start: '08:00', end: '08:45', room: '401', enabled: true };
  const data = { notes: [], tasks: [], schedule: [baseLesson] };
  const action = createAction('upsert_schedule', {
    source: 'edupage',
    lessons: [
      { course: 'Physics', dayOfWeek: 1, start: '08:00', end: '08:45', room: '401' },
      { course: 'English A', dayOfWeek: 2, start: '09:00', end: '09:45', room: '302' },
    ],
  }, data);
  const result = applyActions(data, [action]);
  assert.equal(result.data.schedule.length, 2);
  assert.equal(result.data.schedule[0].id, 'manual');
  assert.equal(result.counts.unchanged, 1);
  assert.equal(result.counts.lessonsAdded, 1);
  assert.equal(result.data.schedule[1].source, 'edupage');
});

test('EduPage timetable normalization strips URLs, rejects bad fields and blocks dynamic import', () => {
  const normalized = normalizeExtractorResult({
    url: 'https://pingheschool.edupage.org/timetable/?token=secret#private',
    title: 'Regular timetable',
    mode: 'regular',
    lessons: [
      { course: 'Math AA', dayOfWeek: 1, start: '08:00', end: '08:45', room: '201' },
      { course: '<script>alert(1)</script>', dayOfWeek: 9, start: 'bad', end: '08:45' },
    ],
  });
  assert.equal(normalized.url, 'https://pingheschool.edupage.org/timetable/');
  assert.equal(normalized.lessons.length, 1);
  assert.equal(normalized.importAllowed, true);
  assert.equal(normalized.diagnostics.rejected, 1);
  const dynamic = normalizeExtractorResult({
    url: 'https://pingheschool.edupage.org/timetable/',
    mode: 'dynamic',
    lessons: [{ course: 'Chemistry', dayOfWeek: 3, start: '10:00', end: '10:45' }],
  });
  assert.equal(dynamic.importAllowed, false);
  assert.throws(() => normalizeExtractorResult({ url: 'https://evil.example/timetable/', lessons: [] }), /只允许/);
});

test('offline dictionary resolves headwords, inflections and loose punctuation', () => {
  const databasePath = path.join(__dirname, '..', 'assets', 'dictionary', 'ecdict.db');
  const dictionary = new OfflineDictionary(databasePath);
  const info = dictionary.info();
  assert.ok(info.entryCount > 700_000);
  assert.equal(dictionary.lookup('analyze').exact.word, 'analyze');
  assert.equal(dictionary.lookup('analysed').exact.word, 'analysed');
  assert.equal(normalizeSearchKey('long-time'), 'longtime');
  assert.ok(dictionary.lookup('long-time').suggestions.some((item) => item.word === 'longtime'));
  dictionary.close();
});

test('main process keeps school views isolated and web security enabled', () => {
  const mainPath = path.join(__dirname, '..', 'electron', 'main.cjs');
  const source = fs.readFileSync(mainPath, 'utf8');
  assert.match(source, /https:\/\/mail\.shphschool\.com\//);
  assert.match(source, /https:\/\/shph\.managebac\.cn\/login/);
  assert.match(source, /https:\/\/pingheschool\.edupage\.org\//);
  assert.match(source, /partition: 'persist:ph-site-mail'/);
  assert.match(source, /partition: 'persist:ph-site-managebac'/);
  assert.match(source, /partition: 'persist:ph-site-edupage'/);
  assert.match(source, /nodeIntegration: false/);
  assert.match(source, /contextIsolation: true/);
  assert.match(source, /sandbox: true/);
  assert.match(source, /webSecurity: true/);
  assert.match(source, /setPermissionCheckHandler/);
  assert.match(source, /siteStoragePersistence\.flushAll\(\)/);
  assert.match(source, /--ph-clean-mode/);
  assert.doesNotMatch(source, /pingheschool\.edupage\.org；/);
  assert.match(source, /hiddenInset/);
  assert.match(source, /process\.platform === 'darwin'/);
  const siteSessionSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'site-session.cjs'), 'utf8');
  assert.match(siteSessionSource, /cookies\.flushStore\(\)/);
  assert.match(siteSessionSource, /flushStorageData\(\)/);
  assert.doesNotMatch(siteSessionSource, /cookies\.get\(/);
  assert.doesNotMatch(siteSessionSource, /cookies\.set\(/);
});

test('package config includes hardened Universal macOS DMG, ZIP and PKG targets', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.version, '0.5.1');
  assert.equal(packageJson.build.mac.minimumSystemVersion, '13.0');
  assert.equal(packageJson.build.mac.hardenedRuntime, true);
  assert.deepEqual(packageJson.build.mac.target, ['dmg', 'zip', 'pkg']);
  assert.match(packageJson.scripts['dist:mac'], /--universal/);
  assert.match(packageJson.scripts['dist:mac:release'], /forceCodeSigning=true/);
  assert.equal(packageJson.build.dmg.title, 'PH Launcher 安装盘 ${version}');
  assert.equal(packageJson.build.dmg.background, 'build/mac-dmg-background.png');
  assert.deepEqual(packageJson.build.dmg.window, { width: 720, height: 480 });
  assert.ok(packageJson.build.dmg.contents.some((item) => item.type === 'link' && item.path === '/Applications'));
  assert.ok(packageJson.build.dmg.contents.some((item) => item.name === '首次打开帮助.html'));
  assert.equal(packageJson.build.pkg.installLocation, '/Applications');
});

test('Windows and signed macOS releases use separate tag namespaces', () => {
  const windowsWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release-windows.yml'), 'utf8');
  const macWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release-macos.yml'), 'utf8');
  assert.match(windowsWorkflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(macWorkflow, /tags:\s*\n\s*- "mac-v\*"/);
  assert.doesNotMatch(macWorkflow, /refs\/tags\/v/);
  assert.match(macWorkflow, /mac-v\$version/);
});

test('fixed Windows 0.5.1 release requires an exact marker and publishes reviewed assets only', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'prepare-windows-release.yml'), 'utf8');
  assert.doesNotThrow(() => yaml.load(workflow, { schema: yaml.JSON_SCHEMA }));
  assert.match(workflow, /\.github\/releases\/v0\.5\.1-retry-1\.trigger/);
  assert.match(workflow, /RELEASE_TAG: v0\.5\.1/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /publish:[\s\S]*?permissions:\n\s+contents: write/);
  assert.match(workflow, /Unexpected Windows release bundle contents/);
  assert.match(workflow, /Checksum mismatch for \$fileName/);
  assert.match(workflow, /Unable to prove that \$endpoint is absent/);
  assert.match(workflow, /gh release create \$env:RELEASE_TAG @assets/);

  const marker = fs.readFileSync(path.join(__dirname, '..', '.github', 'releases', 'v0.5.1-retry-1.trigger'), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(marker, 'PH_LAUNCHER_WINDOWS_RELEASE_RETRY\ntag=v0.5.1\nversion=0.5.1\nattempt=2\npublish-release=true\n');
});

test('Windows 0.5.1 documentation asset repair is fixed, digest-bound and ASCII-only', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'normalize-v0.5.1-release-assets.yml'), 'utf8');
  assert.doesNotThrow(() => yaml.load(workflow, { schema: yaml.JSON_SCHEMA }));
  assert.match(workflow, /\.github\/releases\/v0\.5\.1\.asset-names\.trigger/);
  assert.match(workflow, /expected_tag_commit='8c88df2ce67bfe571272e71abe4efd7e4a9572d3'/);
  assert.match(workflow, /windows-release-asset-repair\.cjs analyze/);
  assert.match(workflow, /windows-release-asset-repair\.cjs verify-final/);
  assert.match(workflow, /gh api --method DELETE "repos\/\$repo\/releases\/assets\/\$manifest_id"/);
  assert.match(workflow, /gh release upload "\$tag" "\$manifest" --repo "\$repo"/);
  assert.doesNotMatch(workflow, /--clobber/);

  const marker = fs.readFileSync(path.join(__dirname, '..', '.github', 'releases', 'v0.5.1.asset-names.trigger'), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(
    marker,
    'PH_LAUNCHER_WINDOWS_ASSET_NAME_REPAIR\ntag=v0.5.1\ntarget=8c88df2ce67bfe571272e71abe4efd7e4a9572d3\nrename=ascii-docs\nregenerate-sha256=true\n',
  );

  let nextId = 1;
  const makeAsset = (expected, name = expected.name) => ({
    id: nextId++,
    name,
    size: expected.size,
    digest: `sha256:${expected.digest}`,
  });
  const makeRelease = ({ documentNames = 'old', manifest = 'old', extra = [] } = {}) => {
    const documents = WINDOWS_RELEASE_DOCUMENT_ASSETS.map((expected, index) => {
      const useOld = documentNames === 'old' || (documentNames === 'mixed' && index === 0);
      return makeAsset(expected, useOld ? expected.oldName : expected.name);
    });
    const assets = [...WINDOWS_RELEASE_FIXED_ASSETS.map((expected) => makeAsset(expected)), ...documents];
    if (manifest === 'old') assets.push(makeAsset({ ...WINDOWS_RELEASE_OLD_MANIFEST, name: WINDOWS_RELEASE_MANIFEST_NAME }));
    if (manifest === 'new') assets.push(makeAsset({ ...WINDOWS_RELEASE_NEW_MANIFEST, name: WINDOWS_RELEASE_MANIFEST_NAME }));
    return { draft: false, prerelease: false, assets: [...assets, ...extra] };
  };

  const oldPlan = analyzeWindowsRelease(makeRelease());
  assert.equal(oldPlan.renames.length, 2);
  assert.equal(oldPlan.manifestAction, 'replace');

  const mixedPlan = analyzeWindowsRelease(makeRelease({ documentNames: 'mixed' }));
  assert.equal(mixedPlan.renames.length, 1);
  assert.equal(mixedPlan.manifestAction, 'replace');

  const recoveryPlan = analyzeWindowsRelease(makeRelease({ documentNames: 'new', manifest: 'missing' }));
  assert.deepEqual(recoveryPlan.renames, []);
  assert.equal(recoveryPlan.manifestAction, 'upload');

  const finalRelease = makeRelease({ documentNames: 'new', manifest: 'new' });
  assert.deepEqual(analyzeWindowsRelease(finalRelease).renames, []);
  assert.equal(analyzeWindowsRelease(finalRelease).manifestAction, 'keep');
  assert.equal(validateFinalWindowsRelease(finalRelease), true);
  assert.equal(validateFinalWindowsRelease(finalRelease), true);

  const wrongSixth = makeRelease({ documentNames: 'new', manifest: 'missing', extra: [{
    id: nextId++, name: 'unexpected.txt', size: 1, digest: `sha256:${'0'.repeat(64)}`,
  }] });
  assert.throws(() => analyzeWindowsRelease(wrongSixth), /Unexpected release asset/);

  const duplicateDocument = makeRelease({ documentNames: 'new', manifest: 'new' });
  duplicateDocument.assets.push(makeAsset(WINDOWS_RELEASE_DOCUMENT_ASSETS[0], WINDOWS_RELEASE_DOCUMENT_ASSETS[0].oldName));
  assert.throws(() => analyzeWindowsRelease(duplicateDocument), /Expected exactly one/);

  const tampered = makeRelease({ documentNames: 'new', manifest: 'new' });
  tampered.assets.find((asset) => asset.name.endsWith('-x64.exe')).digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => analyzeWindowsRelease(tampered), /Unexpected digest/);

  assert.equal(Buffer.byteLength(WINDOWS_RELEASE_MANIFEST), 502);
  assert.equal(WINDOWS_RELEASE_NEW_MANIFEST.digest, '8a4cab0161613f77d52bc5b573cf13ca9dcdb13a738799df5e0155a24744e0b5');
});

test('macOS signing entitlements keep the hardened runtime exceptions minimal', () => {
  for (const fileName of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'build', fileName), 'utf8');
    assert.match(source, /com\.apple\.security\.cs\.allow-jit/);
    assert.doesNotMatch(source, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
    assert.doesNotMatch(source, /com\.apple\.security\.cs\.disable-library-validation/);
  }
});

test('macOS unsigned preview is isolated from the formal release configuration', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const previewConfig = require('../build/mac-preview-builder.cjs');
  assert.doesNotMatch(packageJson.build.dmg.title, /测试/);
  assert.equal(previewConfig.mac.identity, '-');
  assert.equal(previewConfig.mac.notarize, false);
  assert.equal(previewConfig.mac.hardenedRuntime, true);
  assert.deepEqual(previewConfig.mac.target, ['dmg', 'zip']);
  assert.equal(previewConfig.dmg.title, 'PH Launcher 测试安装盘 ${version}');
  assert.deepEqual(previewConfig.dmg.contents, packageJson.build.dmg.contents);
  assert.ok(previewConfig.dmg.contents.some((item) => item.name === '首次打开帮助.html'));
  assert.match(packageJson.scripts['dist:mac:preview'], /mac-preview-builder\.cjs/);

  for (const fileName of ['entitlements.mac.preview.plist', 'entitlements.mac.preview.inherit.plist']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'build', fileName), 'utf8');
    assert.match(source, /com\.apple\.security\.cs\.allow-jit/);
    assert.match(source, /com\.apple\.security\.cs\.disable-library-validation/);
    assert.doesNotMatch(source, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  }
});

test('macOS preview help never asks students to disable Gatekeeper', () => {
  const help = fs.readFileSync(path.join(__dirname, '..', 'build', 'mac-first-open-help.html'), 'utf8');
  assert.match(help, /support\.apple\.com\/zh-cn\/guide\/mac-help\/-mh40616\/mac/);
  assert.match(help, /没有 Developer ID 身份签名且未经 Apple 公证/);
  assert.doesNotMatch(help, /\b(?:xattr|spctl|sudo)\b|终端命令[^<]*(?:运行|执行)/i);
  assert.doesNotMatch(help, /<script\b/i);
});

test('application icon assets have a full-size Mac PNG and multi-frame Windows ICO', () => {
  const png = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png'));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);

  const ico = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const expectedSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  assert.equal(ico.readUInt16LE(4), expectedSizes.length);
  for (const [index, expectedSize] of expectedSizes.entries()) {
    const entryOffset = 6 + (index * 16);
    const advertisedWidth = ico[entryOffset] || 256;
    const advertisedHeight = ico[entryOffset + 1] || 256;
    const dataLength = ico.readUInt32LE(entryOffset + 8);
    const dataOffset = ico.readUInt32LE(entryOffset + 12);
    const frame = ico.subarray(dataOffset, dataOffset + dataLength);
    assert.equal(advertisedWidth, expectedSize);
    assert.equal(advertisedHeight, expectedSize);
    assert.equal(frame.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(frame.readUInt32BE(16), expectedSize);
    assert.equal(frame.readUInt32BE(20), expectedSize);
    assert.equal(frame[24], 8, `${expectedSize}px frame must use 8-bit channels`);
    assert.equal(frame[25], 6, `${expectedSize}px frame must contain RGBA pixels`);

    const idat = [];
    for (let offset = 8; offset < frame.length;) {
      const length = frame.readUInt32BE(offset);
      const type = frame.subarray(offset + 4, offset + 8).toString('ascii');
      if (type === 'IDAT') idat.push(frame.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
      if (type === 'IEND') break;
    }
    const filtered = zlib.inflateSync(Buffer.concat(idat));
    const stride = expectedSize * 4;
    const pixels = Buffer.alloc(stride * expectedSize);
    const paeth = (a, b, c) => {
      const estimate = a + b - c;
      const distanceA = Math.abs(estimate - a);
      const distanceB = Math.abs(estimate - b);
      const distanceC = Math.abs(estimate - c);
      return distanceA <= distanceB && distanceA <= distanceC ? a : distanceB <= distanceC ? b : c;
    };
    for (let y = 0; y < expectedSize; y += 1) {
      const filter = filtered[y * (stride + 1)];
      for (let x = 0; x < stride; x += 1) {
        const raw = filtered[(y * (stride + 1)) + 1 + x];
        const left = x >= 4 ? pixels[(y * stride) + x - 4] : 0;
        const above = y > 0 ? pixels[((y - 1) * stride) + x] : 0;
        const upperLeft = y > 0 && x >= 4 ? pixels[((y - 1) * stride) + x - 4] : 0;
        const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][filter];
        assert.notEqual(predictor, undefined, `unsupported PNG filter ${filter}`);
        pixels[(y * stride) + x] = (raw + predictor) & 0xff;
      }
    }
    let visiblePixels = 0;
    for (let alpha = 3; alpha < pixels.length; alpha += 4) {
      if (pixels[alpha] > 0) visiblePixels += 1;
    }
    assert.ok(
      visiblePixels > expectedSize * expectedSize * 0.5,
      `${expectedSize}px Windows icon frame must not be blank or confined to a corner`,
    );
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(packageJson.build.win.extraResources.some((item) => item.to === 'app-icon.ico'));
  assert.ok(!packageJson.build.extraResources.some((item) => item.to === 'app-icon.ico'));
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert.equal(mainSource.match(/const APP_ID = '([^']+)'/)?.[1], packageJson.build.appId);
  assert.match(mainSource, /app\.setAppUserModelId\(APP_ID\);\s*app\.whenReady\(\)/);
  assert.match(mainSource, /process\.resourcesPath, 'app-icon\.ico'/);
  assert.match(mainSource, /nativeImage\.createFromPath\(candidate\)/);
});

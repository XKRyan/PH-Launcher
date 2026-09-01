const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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
const { OfflineDictionary, normalizeSearchKey } = require('../electron/dictionary.cjs');
const {
  PendingActionStore,
  applyActions,
  createAction,
  sanitizeToolArguments,
  toolKind,
} = require('../electron/ai-tools.cjs');
const { normalizeExtractorResult } = require('../electron/edupage-timetable.cjs');

test('hardware recommendation is conservative on low-memory and low-disk PCs', () => {
  assert.equal(recommendLocalModel({ ramGb: 7.9, vramGb: 8, diskFreeGb: 100 }).recommended, false);
  assert.equal(recommendLocalModel({ ramGb: 32, vramGb: 8, diskFreeGb: 5.9 }).recommended, false);
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
  assert.match(schoolMailCss, /--ph-green/);
  assert.match(schoolMailCss, /login-mod-wrapper\.login-mod-form/);
  assert.match(schoolMailCss, /#donwload_block \{ display: none/);
  assert.match(getSiteCss('managebac', 'https://shph.managebac.cn/login'), /--ph-green/);
  assert.match(getSiteCss('edupage', 'https://pingheschool.edupage.org/'), /--ph-green/);
  assert.match(getSiteCss('mail', 'https://entry.mail.163.com/'), /--ph-clean-mode:\s*1/);
  assert.match(getSiteCss('managebac', 'https://shph.managebac.cn/dashboard'), /linear-gradient/);
  assert.match(getSiteCss('edupage', 'https://pingheschool.edupage.org/timetable/'), /erte-section-inner/);
  assert.equal(getSiteCss('mail', 'https://example.com/'), '');
  assert.equal(getSiteCss('edupage', 'javascript:alert(1)'), '');
});

test('AI tool gateway rejects unknown, destructive and arbitrary navigation requests', () => {
  assert.equal(toolKind('create_tasks'), 'write');
  assert.equal(toolKind('preview_edupage_timetable'), 'read');
  assert.equal(toolKind('delete_everything'), 'unknown');
  assert.throws(() => sanitizeToolArguments('delete_task', { taskId: 'x' }, {}), /未授权/);
  assert.throws(() => sanitizeToolArguments('open_launcher_page', { page: 'https://example.com' }, {}), /不支持/);
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
  assert.doesNotMatch(source, /pingheschool\.edupage\.org；/);
  assert.match(source, /hiddenInset/);
  assert.match(source, /process\.platform === 'darwin'/);
});

test('package config includes hardened Universal macOS DMG, ZIP and PKG targets', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(packageJson.version, '0.5.0');
  assert.equal(packageJson.build.mac.minimumSystemVersion, '13.0');
  assert.equal(packageJson.build.mac.hardenedRuntime, true);
  assert.deepEqual(packageJson.build.mac.target, ['dmg', 'zip', 'pkg']);
  assert.match(packageJson.scripts['dist:mac'], /--universal/);
  assert.match(packageJson.scripts['dist:mac:release'], /forceCodeSigning=true/);
  assert.equal(packageJson.build.pkg.installLocation, '/Applications');
});

test('macOS signing entitlements keep the hardened runtime exceptions minimal', () => {
  for (const fileName of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'build', fileName), 'utf8');
    assert.match(source, /com\.apple\.security\.cs\.allow-jit/);
    assert.doesNotMatch(source, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
    assert.doesNotMatch(source, /com\.apple\.security\.cs\.disable-library-validation/);
  }
});

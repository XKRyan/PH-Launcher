const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MODEL_FOOTPRINT_GB } = require('./hardware.cjs');

const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';
const OLLAMA_MAC_DOWNLOAD_URL = 'https://ollama.com/download/mac';
const ALLOWED_MODELS = new Set(Object.keys(MODEL_FOOTPRINT_GB));
const INSTALLER_RETRY_COUNT = 4;

function cleanProgressText(value) {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function isAllowedModel(model) {
  return ALLOWED_MODELS.has(String(model || '').trim());
}

function requiredSpaceGb(model, needsOllama) {
  const modelSize = MODEL_FOOTPRINT_GB[model];
  if (!Number.isFinite(modelSize)) return Infinity;
  return Math.round((modelSize + (needsOllama ? 6 : 2)) * 10) / 10;
}

function safeUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch {}
}

function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

function parseContentRange(value) {
  const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? 0 : Number(match[3]),
  };
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function translatePullStatus(status) {
  const clean = cleanProgressText(status).toLowerCase();
  if (!clean) return '正在准备模型文件';
  if (clean.includes('pulling manifest')) return '正在获取模型清单';
  if (clean.startsWith('pulling ')) return '正在下载模型文件';
  if (clean.includes('verifying sha256')) return '正在校验模型文件';
  if (clean.includes('writing manifest')) return '正在写入模型清单';
  if (clean.includes('removing any unused')) return '正在清理临时文件';
  if (clean === 'success') return '模型下载完成';
  return cleanProgressText(status);
}

function hasModel(tagsPayload, model) {
  const models = Array.isArray(tagsPayload?.models) ? tagsPayload.models : [];
  return models.some((item) => {
    const name = String(item?.name || item?.model || '').trim();
    return name === model || name === `${model}:latest`;
  });
}

function cancellationError() {
  const error = new Error('部署已取消');
  error.code = 'PH_DEPLOYMENT_CANCELED';
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class LocalAiDeploymentManager {
  constructor({
    getHardwareProfile,
    configureAi,
    emit,
    fetchImpl = globalThis.fetch,
    openExternal = async () => {},
    platform = process.platform,
    downloadDirectory = '',
    logPath = '',
  }) {
    this.getHardwareProfile = getHardwareProfile;
    this.configureAi = configureAi;
    this.emit = emit;
    this.fetch = fetchImpl;
    this.openExternal = openExternal;
    this.platform = platform;
    this.downloadDirectory = downloadDirectory || path.join(os.tmpdir(), 'ph-launcher-ollama-cache');
    this.logPath = logPath;
    this.abortController = null;
    this.child = null;
    this.cancelRequested = false;
    this.temporaryDirectory = '';
    this.activeTask = null;
    this.lastLoggedStage = '';
    this.state = {
      running: false,
      stage: 'idle',
      progress: 0,
      title: '尚未开始部署',
      detail: platform === 'darwin'
        ? '点击后会检测电脑、连接 Ollama，并下载推荐模型；未安装时会打开官方安装页。'
        : '点击后会检测电脑、安装或连接 Ollama，并下载推荐模型。',
      model: '',
      error: '',
      canCancel: false,
    };
  }

  snapshot() {
    return { ...this.state, hasDiagnostics: Boolean(this.logPath && fs.existsSync(this.logPath)) };
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    if (this.state.stage !== this.lastLoggedStage || patch.error) {
      this.lastLoggedStage = this.state.stage;
      this.writeDiagnostic(this.state.stage, patch.error || this.state.detail);
    }
    this.emit?.(this.snapshot());
    return this.snapshot();
  }

  diagnosticsPath() {
    return this.logPath;
  }

  writeDiagnostic(stage, detail) {
    if (!this.logPath) return;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      if (fs.existsSync(this.logPath) && fs.statSync(this.logPath).size > 256 * 1024) {
        safeUnlink(`${this.logPath}.old`);
        fs.renameSync(this.logPath, `${this.logPath}.old`);
      }
      const record = {
        time: new Date().toISOString(),
        stage: cleanProgressText(stage),
        detail: cleanProgressText(detail),
      };
      fs.appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {}
  }

  start() {
    if (this.state.running) return this.snapshot();
    this.cancelRequested = false;
    this.update({
      running: true,
      stage: 'checking',
      progress: 3,
      title: '正在检测这台电脑',
      detail: '将根据内存、显卡与磁盘空间选择合适的模型。',
      model: '',
      error: '',
      canCancel: true,
    });
    this.activeTask = this.run().catch((error) => {
      const canceled = this.cancelRequested || error?.code === 'PH_DEPLOYMENT_CANCELED' || error?.name === 'AbortError';
      if (canceled) {
        this.update({
          running: false,
          stage: 'canceled',
          title: '部署已取消',
          detail: '当前请求已停止；如果取消时正在安装 Ollama，可重新部署以完成或修复安装。',
          error: '',
          canCancel: false,
        });
      } else {
        this.update({
          running: false,
          stage: 'error',
          title: '一键部署未完成',
          detail: cleanProgressText(error?.message) || '发生未知错误，请重试或使用手动设置。',
          error: cleanProgressText(error?.message) || '未知错误',
          canCancel: false,
        });
      }
    }).finally(() => {
      this.abortController = null;
      this.child = null;
      this.activeTask = null;
      this.cleanupTemporaryDirectory();
    });
    return this.snapshot();
  }

  cancel() {
    if (!this.state.running) return this.snapshot();
    this.cancelRequested = true;
    this.update({ title: '正在停止部署', detail: '正在结束当前下载或安装步骤…', canCancel: false });
    this.abortController?.abort();
    if (this.child && !this.child.killed) this.child.kill();
    return this.snapshot();
  }

  assertNotCanceled() {
    if (this.cancelRequested) throw cancellationError();
  }

  async run() {
    const profile = await this.getHardwareProfile();
    this.assertNotCanceled();
    const recommendation = profile?.recommendation || {};
    if (!recommendation.recommended || !isAllowedModel(recommendation.model)) {
      throw new Error(recommendation.reason || '这台电脑暂不适合部署本地模型。');
    }
    const model = recommendation.model;
    this.update({ model, detail: `${recommendation.label}。正在检查本机是否已有 Ollama。`, progress: 7 });

    let ollamaPath = await this.findOllama();
    const needsOllama = !ollamaPath;
    const minimumSpace = requiredSpaceGb(model, needsOllama);
    if (Number(profile.diskFreeGb || 0) > 0 && Number(profile.diskFreeGb) < minimumSpace) {
      throw new Error(`系统盘至少需要约 ${minimumSpace} GB 可用空间；当前约 ${profile.diskFreeGb} GB。`);
    }

    if (!ollamaPath) {
      if (this.platform === 'darwin') {
        this.update({
          running: false,
          stage: 'needs-user-install',
          progress: 8,
          title: '请先安装 Ollama',
          detail: '已打开 Ollama 官方 macOS 安装页。完成安装并启动 Ollama 后，回到这里继续部署。',
          error: '',
          canCancel: false,
        });
        await this.openExternal(OLLAMA_MAC_DOWNLOAD_URL);
        return;
      }
      const installerPath = await this.downloadInstaller();
      this.assertNotCanceled();
      try {
        await this.verifyInstallerSignature(installerPath);
      } catch (error) {
        this.clearInstallerCache();
        throw error;
      }
      this.assertNotCanceled();
      await this.installOllama(installerPath);
      ollamaPath = await this.waitForOllamaExecutable();
      if (!ollamaPath) throw new Error('Ollama 安装完成后未找到程序文件；请重启 PH Launcher 后重试。');
      this.clearInstallerCache();
    } else {
      this.update({
        stage: 'starting-service',
        progress: 39,
        title: '已发现 Ollama',
        detail: '无需重复安装，正在连接本地服务。',
      });
    }

    await this.ensureOllamaService(ollamaPath);
    this.assertNotCanceled();
    await this.pullModel(model);
    this.assertNotCanceled();

    this.update({
      stage: 'verifying-model',
      progress: 97,
      title: '正在验证本地模型',
      detail: '确认模型可由 Ollama 正常读取。',
    });
    const tags = await this.fetchTags();
    if (!hasModel(tags, model)) throw new Error(`Ollama 未返回已安装的 ${model}；请重试模型下载。`);

    await this.configureAi({
      enabled: true,
      provider: 'local',
      localEndpoint: OLLAMA_ENDPOINT,
      localModel: model,
    });
    this.update({
      running: false,
      stage: 'complete',
      progress: 100,
      title: '本地 AI 已经可以使用',
      detail: `${model} 已安装、验证并自动启用。对话内容只会发送到这台电脑上的 Ollama。`,
      error: '',
      canCancel: false,
    });
  }

  async findOllama() {
    const candidates = [];
    if (this.platform === 'darwin') {
      candidates.push(
        '/Applications/Ollama.app/Contents/Resources/ollama',
        path.join(os.homedir(), 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'),
        '/opt/homebrew/bin/ollama',
        '/usr/local/bin/ollama',
      );
      const where = await this.runProgram('/usr/bin/which', ['ollama'], { timeout: 8_000, allowFailure: true, track: false });
      for (const line of String(where.stdout || '').split(/\r?\n/)) {
        if (line.trim()) candidates.push(line.trim());
      }
      for (const candidate of candidates) {
        try {
          if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
        } catch {}
      }
      return '';
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
        path.join(process.env.LOCALAPPDATA, 'Ollama', 'ollama.exe'),
      );
    }
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'));
    if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Ollama', 'ollama.exe'));

    const where = await this.runProgram('where.exe', ['ollama.exe'], { timeout: 8_000, allowFailure: true, track: false });
    for (const line of String(where.stdout || '').split(/\r?\n/)) {
      if (line.trim()) candidates.push(line.trim());
    }
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
      } catch {}
    }
    return '';
  }

  async downloadInstaller() {
    if (this.platform !== 'win32') throw new Error('此平台不支持自动安装 Windows 版 Ollama');
    this.assertNotCanceled();
    fs.mkdirSync(this.downloadDirectory, { recursive: true });
    const installerPath = path.join(this.downloadDirectory, 'OllamaSetup.exe');
    const partialPath = `${installerPath}.part`;
    const metadataPath = `${installerPath}.json`;
    if (fs.existsSync(installerPath) && fs.statSync(installerPath).size >= 1_000_000) {
      this.update({
        stage: 'downloading-installer',
        progress: 28,
        title: '已找到完整的 Ollama 安装包',
        detail: '无需重新下载，正在继续数字签名校验。',
      });
      return installerPath;
    }
    safeUnlink(installerPath);
    this.update({
      stage: 'downloading-installer',
      progress: 10,
      title: '正在下载 Ollama',
      detail: '从 Ollama 官方网站获取 Windows 安装程序；网络中断后会自动续传。',
    });
    let lastError = null;
    for (let attempt = 1; attempt <= INSTALLER_RETRY_COUNT; attempt += 1) {
      this.assertNotCanceled();
      const existingBytes = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
      const previousMetadata = readJsonFile(metadataPath);
      const headers = { 'user-agent': 'PH Launcher Local AI Deployment' };
      if (existingBytes > 0) {
        headers.range = `bytes=${existingBytes}-`;
        const validator = previousMetadata.etag || previousMetadata.lastModified;
        if (validator) headers['if-range'] = validator;
        this.update({ detail: `正在从 ${formatBytes(existingBytes)} 继续下载官方安装程序。` });
      }
      const controller = new AbortController();
      this.abortController = controller;
      let connectionTimer = setTimeout(() => controller.abort(), 45_000);
      let idleTimer = null;
      try {
        const response = await this.fetch(OLLAMA_INSTALLER_URL, {
          redirect: 'follow',
          signal: controller.signal,
          headers,
        });
        clearTimeout(connectionTimer);
        connectionTimer = null;
        if (response.status === 416) {
          safeUnlink(partialPath);
          safeUnlink(metadataPath);
          try { await response.body?.cancel(); } catch {}
          lastError = new Error('远端安装包已更新，正在从头重新下载。');
          continue;
        }
        if (!response.ok || !response.body) throw new Error(`Ollama 下载失败（HTTP ${response.status}）。`);

        let baseBytes = existingBytes;
        let append = response.status === 206 && existingBytes > 0;
        let total = Number(response.headers.get('content-length') || 0);
        if (append) {
          const range = parseContentRange(response.headers.get('content-range'));
          if (!range || range.start !== existingBytes) {
            try { await response.body.cancel(); } catch {}
            safeUnlink(partialPath);
            safeUnlink(metadataPath);
            lastError = new Error('续传位置已变化，正在重新获取完整安装包。');
            continue;
          }
          if (range.total > 0) total = range.total;
        } else {
          baseBytes = 0;
          append = false;
          safeUnlink(partialPath);
        }

        const metadata = {
          etag: response.headers.get('etag') || '',
          lastModified: response.headers.get('last-modified') || '',
          total,
        };
        fs.writeFileSync(metadataPath, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600 });
        let downloaded = baseBytes;
        let lastReported = -1;
        let lastReportedBytes = downloaded;
        const resetIdleTimer = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => controller.abort(), 90_000);
        };
        resetIdleTimer();
        const monitor = new Transform({
          transform: (chunk, _encoding, callback) => {
            resetIdleTimer();
            downloaded += chunk.length;
            const ratio = total > 0 ? Math.min(1, downloaded / total) : 0;
            const progress = total > 0 ? Math.round(10 + ratio * 18) : 14;
            if (progress !== lastReported || (total <= 0 && downloaded - lastReportedBytes >= 16 * 1024 ** 2)) {
              lastReported = progress;
              lastReportedBytes = downloaded;
              const sizeText = total > 0
                ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
                : formatBytes(downloaded);
              this.update({ progress, detail: `正在下载官方安装程序 · ${sizeText}` });
            }
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body),
          monitor,
          fs.createWriteStream(partialPath, { flags: append ? 'a' : 'w' }),
        );
        const completedBytes = fs.statSync(partialPath).size;
        if (total > 0 && completedBytes !== total) {
          throw new Error(`下载连接提前结束（${formatBytes(completedBytes)} / ${formatBytes(total)}）。`);
        }
        if (completedBytes < 1_000_000) throw new Error('下载到的 Ollama 安装程序不完整。');
        safeUnlink(installerPath);
        fs.renameSync(partialPath, installerPath);
        return installerPath;
      } catch (error) {
        if (this.cancelRequested) throw error;
        lastError = error;
        const savedBytes = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
        if (attempt < INSTALLER_RETRY_COUNT) {
          this.update({
            detail: `下载连接中断，已保留 ${formatBytes(savedBytes)}；正在自动续传（${attempt}/${INSTALLER_RETRY_COUNT}）。`,
          });
          await delay(Math.min(8_000, attempt * 2_000));
        }
      } finally {
        clearTimeout(connectionTimer);
        clearTimeout(idleTimer);
        if (this.abortController === controller) this.abortController = null;
      }
    }
    const savedBytes = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
    this.writeDiagnostic('download-error', lastError?.message || 'unknown');
    throw new Error(`Ollama 官方下载连接不稳定，已保留 ${formatBytes(savedBytes)}；点击“继续部署”会从断点续传。`);
  }

  clearInstallerCache() {
    const installerPath = path.join(this.downloadDirectory, 'OllamaSetup.exe');
    safeUnlink(installerPath);
    safeUnlink(`${installerPath}.part`);
    safeUnlink(`${installerPath}.json`);
  }

  async verifyInstallerSignature(installerPath) {
    if (this.platform !== 'win32') throw new Error('此平台不支持 Windows 安装程序签名校验');
    this.update({
      stage: 'verifying-installer',
      progress: 30,
      title: '正在验证安装程序',
      detail: '校验 Windows 数字签名，防止运行来源不明的文件。',
    });
    const script = [
      '$signature = Get-AuthenticodeSignature -LiteralPath $env:PH_OLLAMA_INSTALLER',
      '[pscustomobject]@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = await this.runProgram(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        timeout: 60_000,
        track: true,
        env: { ...process.env, PH_OLLAMA_INSTALLER: installerPath },
      },
    );
    let signature;
    try {
      signature = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, '').trim());
    } catch {
      throw new Error('无法读取 Ollama 安装程序的数字签名。');
    }
    if (signature.Status !== 'Valid' || !/(^|,\s*)O=Ollama Inc\.(,|$)/i.test(String(signature.Subject || ''))) {
      throw new Error('Ollama 安装程序的数字签名无效或发布者不匹配，已停止安装。');
    }
  }

  async installOllama(installerPath) {
    if (this.platform !== 'win32') throw new Error('此平台不支持 Windows 安装程序');
    this.update({
      stage: 'installing-ollama',
      progress: 34,
      title: '正在安装 Ollama',
      detail: '安装在当前 Windows 用户目录，无需管理员权限。',
    });
    if (process.env.LOCALAPPDATA) {
      try {
        const markerDirectory = path.join(process.env.LOCALAPPDATA, 'Ollama');
        fs.mkdirSync(markerDirectory, { recursive: true });
        fs.writeFileSync(path.join(markerDirectory, 'upgraded'), '', { mode: 0o600 });
      } catch {}
    }
    await this.runProgram(
      installerPath,
      ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'],
      { timeout: 20 * 60_000, track: true },
    );
    this.update({ progress: 38, detail: 'Ollama 安装完成，正在定位程序文件。' });
  }

  async waitForOllamaExecutable() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      this.assertNotCanceled();
      const ollamaPath = await this.findOllama();
      if (ollamaPath) return ollamaPath;
      await delay(750);
    }
    return '';
  }

  async ensureOllamaService(ollamaPath) {
    this.update({
      stage: 'starting-service',
      progress: 41,
      title: '正在启动本地 AI 服务',
      detail: '只监听本机地址，不会开放学校网页数据。',
    });
    if (await this.isApiReady()) return;

    if (this.platform === 'darwin') {
      this.spawnDetached('/usr/bin/open', ['-a', 'Ollama']);
      if (await this.waitForApi(18)) return;
      this.spawnDetached(ollamaPath, ['serve']);
      if (await this.waitForApi(20)) return;
      throw new Error('Ollama 已安装，但本地服务未能启动；请从“应用程序”打开 Ollama 后重试。');
    }

    const appExecutable = path.join(path.dirname(ollamaPath), 'ollama app.exe');
    if (fs.existsSync(appExecutable)) this.spawnDetached(appExecutable, []);
    else this.spawnDetached(ollamaPath, ['serve']);
    if (await this.waitForApi(14)) return;

    if (fs.existsSync(appExecutable)) this.spawnDetached(ollamaPath, ['serve']);
    if (await this.waitForApi(20)) return;
    throw new Error('Ollama 已安装，但本地服务未能启动；请在开始菜单打开 Ollama 后重试。');
  }

  spawnDetached(file, args) {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: this.platform === 'win32', shell: false });
      child.on('error', () => {});
      child.unref();
    } catch {}
  }

  async waitForApi(attempts) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.assertNotCanceled();
      await delay(700);
      if (await this.isApiReady()) return true;
    }
    return false;
  }

  async isApiReady() {
    try {
      const response = await this.fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: AbortSignal.timeout(2_500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async fetchTags() {
    const response = await this.fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Ollama 服务返回 ${response.status}。`);
    return response.json();
  }

  async pullModel(model) {
    this.update({
      stage: 'downloading-model',
      progress: 46,
      title: `正在下载 ${model}`,
      detail: `模型约 ${MODEL_FOOTPRINT_GB[model]} GB；下载时间取决于网络速度。`,
    });
    const controller = new AbortController();
    this.abortController = controller;
    const response = await this.fetch(`${OLLAMA_ENDPOINT}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const detail = cleanProgressText(await response.text());
      throw new Error(`模型下载失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let maxProgress = 46;
    let lastDetail = '';
    try {
      while (true) {
        this.assertNotCanceled();
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const item = this.parsePullLine(line);
          if (!item) continue;
          if (item.error) throw new Error(cleanProgressText(item.error));
          const total = Number(item.total || 0);
          const completed = Number(item.completed || 0);
          if (total > 0 && completed >= 0) {
            const ratio = Math.max(0, Math.min(1, completed / total));
            maxProgress = Math.max(maxProgress, Math.round(46 + ratio * 48));
          }
          let detail = translatePullStatus(item.status);
          if (total > 0) detail += ` · ${formatBytes(completed)} / ${formatBytes(total)}`;
          if (detail !== lastDetail || maxProgress !== this.state.progress) {
            lastDetail = detail;
            this.update({ progress: maxProgress, detail });
          }
        }
      }
      if (buffer.trim()) {
        const item = this.parsePullLine(buffer);
        if (item?.error) throw new Error(cleanProgressText(item.error));
      }
    } finally {
      if (this.abortController === controller) this.abortController = null;
      try { reader.releaseLock(); } catch {}
    }
    this.update({ progress: 95, detail: '模型文件已下载，正在进行最终校验。' });
  }

  parsePullLine(line) {
    const clean = String(line || '').trim();
    if (!clean) return null;
    try {
      return JSON.parse(clean);
    } catch {
      return null;
    }
  }

  runProgram(file, args, options = {}) {
    const timeout = Number(options.timeout || 60_000);
    const allowFailure = Boolean(options.allowFailure);
    const track = options.track !== false;
    return new Promise((resolve, reject) => {
      this.assertNotCanceled();
      const child = spawn(file, args, {
        windowsHide: this.platform === 'win32',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env || process.env,
      });
      if (track) this.child = child;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeout);
      child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-1_000_000); });
      child.once('error', (error) => {
        clearTimeout(timer);
        if (track && this.child === child) this.child = null;
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (track && this.child === child) this.child = null;
        if (this.cancelRequested) return reject(cancellationError());
        if (timedOut) return reject(new Error(`${path.basename(file)} 执行超时。`));
        if (code !== 0 && !allowFailure) {
          return reject(new Error(cleanProgressText(stderr) || `${path.basename(file)} 返回错误代码 ${code}。`));
        }
        resolve({ code, stdout, stderr });
      });
    });
  }

  cleanupTemporaryDirectory() {
    if (!this.temporaryDirectory) return;
    const temporaryRoot = path.resolve(os.tmpdir());
    const target = path.resolve(this.temporaryDirectory);
    const safePrefix = `${temporaryRoot}${path.sep}`;
    if (target.startsWith(safePrefix) && path.basename(target).startsWith('ph-launcher-ollama-')) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    }
    this.temporaryDirectory = '';
  }
}

module.exports = {
  ALLOWED_MODELS,
  OLLAMA_ENDPOINT,
  OLLAMA_INSTALLER_URL,
  OLLAMA_MAC_DOWNLOAD_URL,
  INSTALLER_RETRY_COUNT,
  LocalAiDeploymentManager,
  cleanProgressText,
  hasModel,
  isAllowedModel,
  parseContentRange,
  requiredSpaceGb,
  translatePullStatus,
};

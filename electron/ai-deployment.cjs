const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MODEL_FOOTPRINT_GB } = require('./hardware.cjs');

const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';
const OLLAMA_MAC_VERSION = '0.33.2';
const OLLAMA_MAC_SHA256 = '01b844bc6058bd34fcab495e0c3e6315147d6488252f24d04ab54ef12048a56e';
const OLLAMA_MAC_DOWNLOAD_URL = `https://github.com/ollama/ollama/releases/download/v${OLLAMA_MAC_VERSION}/Ollama.dmg`;
const OLLAMA_MAC_DOWNLOAD_PAGE = 'https://ollama.com/download/mac';
const OLLAMA_CHECKSUM_URL = 'https://github.com/ollama/ollama/releases/latest/download/sha256sum.txt';
const OLLAMA_MAC_BUNDLE_ID = 'com.electron.ollama';
const OLLAMA_MAC_TEAM_ID = '3MU9H2V9Y9';
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

function securityError(message) {
  const error = new Error(message);
  error.code = 'PH_OLLAMA_SECURITY_ERROR';
  return error;
}

function lstatOrNull(filePath) {
  try { return fs.lstatSync(filePath); } catch { return null; }
}

function isRegularFileWithoutSymlink(filePath) {
  const stat = lstatOrNull(filePath);
  return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

function isDirectoryWithoutSymlink(filePath) {
  const stat = lstatOrNull(filePath);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

function parseMacSignatureDetails(value) {
  const text = String(value || '');
  return {
    identifier: text.match(/^Identifier=(.+)$/m)?.[1]?.trim() || '',
    teamIdentifier: text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || '',
    authorities: [...text.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim()),
  };
}

function parseMacLsofListeners(value) {
  const listeners = [];
  let processId = '';
  for (const rawLine of String(value || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^p\d+$/.test(line)) {
      processId = line.slice(1);
      continue;
    }
    if (processId && line.startsWith('n')) {
      const address = line.slice(1).trim();
      if (address) listeners.push({ processId, address });
    }
  }
  return listeners;
}

function isLoopbackOllamaListener(address) {
  const normalized = String(address || '')
    .trim()
    .replace(/^TCP\s+/i, '')
    .replace(/\s+\(LISTEN\)$/i, '');
  return normalized === '127.0.0.1:11434' || normalized === '[::1]:11434';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    this.mountedMacImage = null;
    this.ollamaAppPath = '';
    this.activeTask = null;
    this.lastLoggedStage = '';
    this.state = {
      running: false,
      stage: 'idle',
      progress: 0,
      title: '尚未开始部署',
      detail: platform === 'darwin'
        ? '点击后会检测电脑、安全安装或连接 Ollama，并下载推荐模型。'
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
          detail: '当前下载请求已停止；已经安装或启动的 Ollama 可能仍在后台运行，不会被强制卸载或结束。稍后可继续部署。',
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
    if (this.state.canCancel === false) return this.snapshot();
    this.cancelRequested = true;
    this.update({ title: '正在停止部署', detail: '正在结束当前下载或安装步骤…', canCancel: false });
    this.abortController?.abort();
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      if (typeof this.child.phRequestTermination === 'function') this.child.phRequestTermination('cancel');
      else this.child.kill('SIGTERM');
    }
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
        const diskImagePath = await this.downloadMacInstaller();
        this.assertNotCanceled();
        try {
          await this.verifyOfficialChecksum(diskImagePath, 'Ollama.dmg', OLLAMA_MAC_SHA256);
          ollamaPath = await this.installOllamaOnMac(diskImagePath);
        } catch (error) {
          if (error?.code === 'PH_OLLAMA_SECURITY_ERROR') this.clearMacInstallerCache();
          throw error;
        }
        if (!ollamaPath) throw new Error('Ollama 安装完成后未找到程序文件；请重启 PH Launcher 后重试。');
        this.clearMacInstallerCache();
      } else {
        const installerPath = await this.downloadInstaller();
        this.assertNotCanceled();
        try {
          await this.verifyOfficialChecksum(installerPath, 'OllamaSetup.exe');
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
      }
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
      const appCandidates = [
        '/Applications/Ollama.app',
        path.join(os.homedir(), 'Applications', 'Ollama.app'),
      ];
      for (const appPath of appCandidates) {
        const stat = lstatOrNull(appPath);
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw securityError(`检测到异常的 Ollama 应用路径（${appPath}），已停止自动启动。请手动检查后重试。`);
        }
        await this.verifyMacOllamaApp(appPath, { silent: true });
        const cliPath = path.join(appPath, 'Contents', 'Resources', 'ollama');
        if (!isRegularFileWithoutSymlink(cliPath)) {
          throw securityError(`已安装的 Ollama 不完整（缺少 ${path.basename(cliPath)}），已停止自动启动。`);
        }
        this.ollamaAppPath = path.resolve(appPath);
        return path.resolve(cliPath);
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
    return this.downloadArtifact({
      url: OLLAMA_INSTALLER_URL,
      fileName: 'OllamaSetup.exe',
      minimumBytes: 1_000_000,
      maximumBytes: 3 * 1024 ** 3,
      platformName: 'Windows',
    });
  }

  async downloadMacInstaller() {
    if (this.platform !== 'darwin') throw new Error('此平台不支持自动安装 macOS 版 Ollama');
    return this.downloadArtifact({
      url: OLLAMA_MAC_DOWNLOAD_URL,
      fileName: 'Ollama.dmg',
      minimumBytes: 10_000_000,
      maximumBytes: 512 * 1024 ** 2,
      platformName: 'macOS',
      expectedSha256: OLLAMA_MAC_SHA256,
    });
  }

  async downloadArtifact({ url, fileName, minimumBytes, maximumBytes, platformName, expectedSha256 = '' }) {
    this.assertNotCanceled();
    this.prepareDownloadDirectory();
    const installerPath = path.join(this.downloadDirectory, fileName);
    const partialPath = `${installerPath}.part`;
    const metadataPath = `${installerPath}.json`;
    const cacheMetadata = readJsonFile(metadataPath);
    const cacheMatches = cacheMetadata.sourceUrl === url
      && String(cacheMetadata.expectedSha256 || '') === String(expectedSha256 || '');
    if ((lstatOrNull(installerPath) || lstatOrNull(partialPath)) && !cacheMatches) {
      safeUnlink(installerPath);
      safeUnlink(partialPath);
      safeUnlink(metadataPath);
    }
    const cachedStat = lstatOrNull(installerPath);
    if (cachedStat?.isSymbolicLink()) {
      safeUnlink(installerPath);
      throw securityError('Ollama 下载缓存路径异常，已停止自动安装。');
    }
    if (cachedStat?.isFile() && cachedStat.size > maximumBytes) {
      safeUnlink(installerPath);
      safeUnlink(metadataPath);
      throw securityError('Ollama 完整安装包缓存超过安全大小上限，已删除缓存并停止自动安装。');
    }
    if (cachedStat?.isFile() && cachedStat.size >= minimumBytes) {
      this.update({
        stage: 'downloading-installer',
        progress: 28,
        title: '已找到完整的 Ollama 安装包',
        detail: '无需重新下载，正在继续来源与数字签名校验。',
      });
      return installerPath;
    }
    safeUnlink(installerPath);
    if (lstatOrNull(partialPath)?.isSymbolicLink()) {
      safeUnlink(partialPath);
      safeUnlink(metadataPath);
      throw securityError('Ollama 下载断点路径异常，已停止自动安装。');
    }
    this.update({
      stage: 'downloading-installer',
      progress: 10,
      title: '正在下载 Ollama',
      detail: `从 Ollama 官方网站获取 ${platformName} 安装包；网络中断后会自动续传。`,
    });
    let lastError = null;
    for (let attempt = 1; attempt <= INSTALLER_RETRY_COUNT; attempt += 1) {
      this.assertNotCanceled();
      const existingBytes = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
      if (existingBytes > maximumBytes) {
        safeUnlink(partialPath);
        safeUnlink(metadataPath);
        throw securityError('Ollama 下载断点大小异常，已删除缓存并停止自动安装。');
      }
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
        const response = await this.fetch(url, {
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
        if (response.url) {
          let finalUrl;
          try { finalUrl = new URL(response.url); } catch {}
          if (!finalUrl || finalUrl.protocol !== 'https:') {
            try { await response.body.cancel(); } catch {}
            throw securityError('Ollama 下载发生了不安全的网络跳转，已停止自动安装。');
          }
        }

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
        if (total > maximumBytes) {
          try { await response.body.cancel(); } catch {}
          throw securityError('Ollama 官方安装包声明的大小异常，已停止自动安装。');
        }

        const metadata = {
          sourceUrl: url,
          expectedSha256: String(expectedSha256 || ''),
          etag: response.headers.get('etag') || '',
          lastModified: response.headers.get('last-modified') || '',
          total,
        };
        safeUnlink(metadataPath);
        fs.writeFileSync(metadataPath, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
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
            if (downloaded > maximumBytes) {
              callback(securityError('Ollama 下载数据超过安全大小上限，已停止自动安装。'));
              return;
            }
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
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        const flags = append
          ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow
          : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow;
        const outputHandle = fs.openSync(partialPath, flags, 0o600);
        await pipeline(Readable.fromWeb(response.body), monitor, fs.createWriteStream(null, { fd: outputHandle, autoClose: true }));
        const completedBytes = fs.statSync(partialPath).size;
        if (completedBytes > maximumBytes) throw securityError('Ollama 安装包超过安全大小上限，已停止自动安装。');
        if (total > 0 && completedBytes !== total) {
          throw new Error(`下载连接提前结束（${formatBytes(completedBytes)} / ${formatBytes(total)}）。`);
        }
        if (completedBytes < minimumBytes) throw new Error('下载到的 Ollama 安装包不完整。');
        safeUnlink(installerPath);
        fs.renameSync(partialPath, installerPath);
        return installerPath;
      } catch (error) {
        if (this.cancelRequested) throw error;
        if (error?.code === 'PH_OLLAMA_SECURITY_ERROR') {
          safeUnlink(partialPath);
          safeUnlink(metadataPath);
          throw error;
        }
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

  prepareDownloadDirectory() {
    const existing = lstatOrNull(this.downloadDirectory);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw securityError('本地 AI 下载目录异常，已停止自动安装。');
    }
    fs.mkdirSync(this.downloadDirectory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.downloadDirectory, 0o700); } catch {}
  }

  async verifyOfficialChecksum(artifactPath, artifactName, pinnedHash = '') {
    if (!isRegularFileWithoutSymlink(artifactPath)) {
      throw securityError('Ollama 安装包缓存不是安全的普通文件，已停止自动安装。');
    }
    this.update({
      stage: 'verifying-checksum',
      progress: 29,
      title: '正在核对官方校验值',
      detail: '将安装包与 Ollama 官方发布清单进行 SHA-256 对照。',
    });
    let expectedHash = String(pinnedHash || '').trim().toLowerCase();
    if (expectedHash && !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw securityError('PH Launcher 内置的 Ollama 校验值格式异常，已停止安装。');
    }
    if (!expectedHash) {
      const controller = new AbortController();
      this.abortController = controller;
      const timeout = setTimeout(() => controller.abort(), 45_000);
      let response;
      try {
        response = await this.fetch(OLLAMA_CHECKSUM_URL, {
          redirect: 'follow',
          signal: controller.signal,
          headers: { 'user-agent': 'PH Launcher Local AI Deployment' },
        });
      } catch (error) {
        if (this.cancelRequested) throw error;
        throw new Error('暂时无法取得 Ollama 官方校验清单；安装包已保留，稍后可继续部署。');
      } finally {
        clearTimeout(timeout);
        if (this.abortController === controller) this.abortController = null;
      }
      if (!response.ok) throw new Error(`Ollama 官方校验清单返回 HTTP ${response.status}。`);
      if (response.url) {
        let finalUrl;
        try { finalUrl = new URL(response.url); } catch {}
        if (!finalUrl || finalUrl.protocol !== 'https:') {
          throw securityError('Ollama 官方校验清单发生了不安全的网络跳转，已停止安装。');
        }
      }
      const checksumText = await response.text();
      if (checksumText.length > 1_000_000) throw securityError('Ollama 官方校验清单大小异常，已停止安装。');
      const pattern = new RegExp(`^([a-f0-9]{64})\\s+\\*?\\.?\\/${escapeRegExp(artifactName)}$`, 'im');
      expectedHash = checksumText.match(pattern)?.[1]?.toLowerCase() || '';
      if (!expectedHash) throw new Error(`Ollama 官方发布清单中没有 ${artifactName}，请稍后重试。`);
    }
    const actualHash = await this.sha256File(artifactPath);
    if (actualHash !== expectedHash) {
      throw securityError('Ollama 安装包的 SHA-256 与官方发布清单不一致，已删除缓存并停止安装。');
    }
    return actualHash;
  }

  sha256File(filePath) {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => {
        if (this.cancelRequested) stream.destroy(cancellationError());
        else hash.update(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(hash.digest('hex')));
    });
  }

  clearInstallerCache() {
    const installerPath = path.join(this.downloadDirectory, 'OllamaSetup.exe');
    safeUnlink(installerPath);
    safeUnlink(`${installerPath}.part`);
    safeUnlink(`${installerPath}.json`);
  }

  clearMacInstallerCache() {
    const installerPath = path.join(this.downloadDirectory, 'Ollama.dmg');
    safeUnlink(installerPath);
    safeUnlink(`${installerPath}.part`);
    safeUnlink(`${installerPath}.json`);
  }

  prepareMacApplicationsDirectory() {
    if (this.platform !== 'darwin') throw new Error('此平台不支持安装 macOS 应用');
    const homeDirectory = path.resolve(os.homedir());
    if (!isDirectoryWithoutSymlink(homeDirectory)) {
      throw securityError('当前用户目录无法安全访问，已停止自动安装 Ollama。');
    }
    const applicationsDirectory = path.join(homeDirectory, 'Applications');
    const existing = lstatOrNull(applicationsDirectory);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw securityError('当前用户的“应用程序”目录异常，已停止自动安装 Ollama。');
    }
    if (!existing) fs.mkdirSync(applicationsDirectory, { recursive: false, mode: 0o755 });
    const resolvedHome = fs.realpathSync.native(homeDirectory);
    const resolvedApplications = fs.realpathSync.native(applicationsDirectory);
    if (path.dirname(resolvedApplications) !== resolvedHome) {
      throw securityError('当前用户的“应用程序”目录指向了其他位置，已停止自动安装 Ollama。');
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const stat = fs.statSync(resolvedApplications);
    if (uid !== null && Number.isInteger(stat.uid) && stat.uid !== uid) {
      throw securityError('当前用户不拥有“应用程序”目录，已停止自动安装 Ollama。');
    }
    if ((stat.mode & 0o022) !== 0) {
      throw securityError('当前用户的“应用程序”目录允许其他账号写入，已停止自动安装 Ollama。');
    }
    return resolvedApplications;
  }

  async verifyMacOllamaApp(appPath, { silent = false } = {}) {
    if (this.platform !== 'darwin') throw new Error('此平台不支持 macOS 应用签名校验');
    const resolvedAppPath = path.resolve(appPath);
    if (!isDirectoryWithoutSymlink(resolvedAppPath)) {
      throw securityError('Ollama.app 不是安全的普通应用目录，已停止安装。');
    }
    const infoPlist = path.join(resolvedAppPath, 'Contents', 'Info.plist');
    const cliPath = path.join(resolvedAppPath, 'Contents', 'Resources', 'ollama');
    if (!isRegularFileWithoutSymlink(infoPlist) || !isRegularFileWithoutSymlink(cliPath)) {
      throw securityError('Ollama.app 文件不完整或包含异常链接，已停止安装。');
    }
    if (!silent) {
      this.update({
        stage: 'verifying-installer',
        progress: 31,
        title: '正在验证 Ollama',
        detail: '正在核对 Apple Developer ID、应用标识与 Gatekeeper 公证结果。',
      });
    }
    const stableEnvironment = { ...process.env, LC_ALL: 'C', LANG: 'C' };
    const requirement = `anchor apple generic and identifier "${OLLAMA_MAC_BUNDLE_ID}" and certificate leaf[subject.OU] = "${OLLAMA_MAC_TEAM_ID}"`;
    let signature;
    try {
      await this.runProgram(
        '/usr/bin/codesign',
        ['--verify', '--deep', '--strict', '--verbose=4', `-R=${requirement}`, resolvedAppPath],
        { timeout: 120_000, track: true, env: stableEnvironment },
      );
      signature = await this.runProgram(
        '/usr/bin/codesign',
        ['--display', '--verbose=4', resolvedAppPath],
        { timeout: 60_000, track: true, env: stableEnvironment },
      );
    } catch (error) {
      if (error?.code === 'PH_DEPLOYMENT_CANCELED') throw error;
      throw securityError('Ollama 的 Apple Developer ID 代码签名无效，已停止安装。');
    }
    const details = parseMacSignatureDetails(`${signature.stdout}\n${signature.stderr}`);
    const trustedAuthority = details.authorities.some((authority) => (
      /^Developer ID Application:/i.test(authority)
      && authority.includes(`(${OLLAMA_MAC_TEAM_ID})`)
    ));
    if (
      details.identifier !== OLLAMA_MAC_BUNDLE_ID
      || details.teamIdentifier !== OLLAMA_MAC_TEAM_ID
      || !trustedAuthority
    ) {
      throw securityError('Ollama 的 Apple 开发者签名与官方发布者不匹配，已停止安装。');
    }
    let gatekeeper;
    try {
      gatekeeper = await this.runProgram(
        '/usr/sbin/spctl',
        ['--assess', '--type', 'execute', '--verbose=4', resolvedAppPath],
        { timeout: 120_000, track: true, env: stableEnvironment },
      );
    } catch (error) {
      if (error?.code === 'PH_DEPLOYMENT_CANCELED') throw error;
      throw securityError('macOS Gatekeeper 拒绝了 Ollama，已停止安装；请勿绕过系统安全设置。');
    }
    const gatekeeperOutput = `${gatekeeper.stdout}\n${gatekeeper.stderr}`;
    if (!/\baccepted\b/i.test(gatekeeperOutput) || !/source=Notarized Developer ID/i.test(gatekeeperOutput)) {
      throw securityError('macOS Gatekeeper 未确认 Ollama 已通过公证，已停止安装；请勿绕过系统安全设置。');
    }
    return path.resolve(cliPath);
  }

  async verifyMacDiskImage(diskImagePath) {
    if (this.platform !== 'darwin') throw new Error('此平台不支持 macOS 磁盘映像校验');
    const resolvedImagePath = path.resolve(diskImagePath);
    if (!isRegularFileWithoutSymlink(resolvedImagePath)) {
      throw securityError('Ollama 磁盘映像不是安全的普通文件，已停止安装。');
    }
    this.update({
      stage: 'verifying-installer',
      progress: 30,
      title: '正在验证 Ollama 安装包',
      detail: '正在检查磁盘映像完整性与 Gatekeeper 公证状态。',
    });
    const stableEnvironment = { ...process.env, LC_ALL: 'C', LANG: 'C' };
    try {
      await this.runProgram(
        '/usr/bin/hdiutil',
        ['verify', resolvedImagePath],
        { timeout: 5 * 60_000, track: true, env: stableEnvironment },
      );
      const assessment = await this.runProgram(
        '/usr/sbin/spctl',
        ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', resolvedImagePath],
        { timeout: 120_000, track: true, env: stableEnvironment },
      );
      const output = `${assessment.stdout}\n${assessment.stderr}`;
      if (!/\baccepted\b/i.test(output) || !/source=Notarized Developer ID/i.test(output)) {
        throw securityError('macOS Gatekeeper 未确认 Ollama 安装包已通过公证，已停止安装。');
      }
    } catch (error) {
      if (error?.code === 'PH_DEPLOYMENT_CANCELED' || error?.code === 'PH_OLLAMA_SECURITY_ERROR') throw error;
      throw securityError('Ollama 磁盘映像完整性或 Gatekeeper 校验失败，已停止安装。');
    }
  }

  async readMacPlistJson(plistText, label) {
    if (!this.temporaryDirectory || !isDirectoryWithoutSymlink(this.temporaryDirectory)) {
      throw new Error('macOS 临时目录不可用。');
    }
    const plistPath = path.join(this.temporaryDirectory, `${label}-${randomUUID()}.plist`);
    fs.writeFileSync(plistPath, String(plistText || ''), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      const converted = await this.runProgram(
        '/usr/bin/plutil',
        ['-convert', 'json', '-o', '-', plistPath],
        { timeout: 20_000, track: false, ignoreCancellation: true },
      );
      return JSON.parse(converted.stdout);
    } finally {
      safeUnlink(plistPath);
    }
  }

  async findMountedMacImage(device, mountPoint) {
    try {
      const info = await this.runProgram(
        '/usr/bin/hdiutil',
        ['info', '-plist'],
        { timeout: 20_000, allowFailure: true, track: false, ignoreCancellation: true },
      );
      if (info.code !== 0) return { unknown: true };
      const payload = await this.readMacPlistJson(info.stdout, 'hdiutil-info');
      const images = Array.isArray(payload?.images) ? payload.images : [];
      const entities = images.flatMap((image) => (Array.isArray(image?.['system-entities']) ? image['system-entities'] : []));
      const match = entities.find((entity) => (
        (device && entity?.['dev-entry'] === device)
        || (mountPoint && entity?.['mount-point'] === mountPoint)
      ));
      if (!match) return null;
      return {
        device: String(match['dev-entry'] || ''),
        mountPoint: String(match['mount-point'] || ''),
      };
    } catch (error) {
      this.writeDiagnostic('mount-inspection-warning', error.message);
      return { unknown: true };
    }
  }

  async detachMacImage(device, mountPoint) {
    let currentDevice = device;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const active = await this.findMountedMacImage(currentDevice, mountPoint);
      if (!active) return true;
      if (active.unknown) {
        await delay(500 * (attempt + 1));
        continue;
      }
      if (active.device && /^\/dev\/disk\d+(s\d+)?$/.test(active.device)) currentDevice = active.device;
      const detachTarget = currentDevice || mountPoint;
      const result = await this.runProgram(
        '/usr/bin/hdiutil',
        ['detach', detachTarget],
        { timeout: 30_000, allowFailure: true, track: false, ignoreCancellation: true },
      ).catch((error) => ({ code: -1, stderr: error.message }));
      if (result.code !== 0) this.writeDiagnostic('detach-retry', result.stderr || `attempt ${attempt + 1}`);
      await delay(500 * (attempt + 1));
    }
    const active = await this.findMountedMacImage(currentDevice, mountPoint);
    return active === null;
  }

  async installOllamaOnMac(diskImagePath) {
    if (this.platform !== 'darwin') throw new Error('此平台不支持 macOS 安装程序');
    if (!isRegularFileWithoutSymlink(diskImagePath)) {
      throw securityError('Ollama 磁盘映像不是安全的普通文件，已停止安装。');
    }
    await this.verifyMacDiskImage(diskImagePath);
    this.assertNotCanceled();
    const applicationsDirectory = this.prepareMacApplicationsDirectory();
    const targetAppPath = path.join(applicationsDirectory, 'Ollama.app');
    const existingTarget = lstatOrNull(targetAppPath);
    if (existingTarget) {
      if (!existingTarget.isDirectory() || existingTarget.isSymbolicLink()) {
        throw securityError('“应用程序”中已有异常的 Ollama.app，PH Launcher 不会覆盖它。请手动检查后重试。');
      }
      const existingCli = await this.verifyMacOllamaApp(targetAppPath);
      this.ollamaAppPath = targetAppPath;
      return existingCli;
    }

    this.temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-launcher-ollama-'));
    try { fs.chmodSync(this.temporaryDirectory, 0o700); } catch {}
    const mountPoint = path.join(this.temporaryDirectory, 'mount');
    fs.mkdirSync(mountPoint, { mode: 0o700 });
    let mountedDevice = '';
    let stagingPath = path.join(applicationsDirectory, `.PH-Launcher-Ollama-${randomUUID()}.app`);
    try {
      this.update({
        stage: 'mounting-installer',
        progress: 29,
        title: '正在准备 Ollama 安装包',
        detail: '以只读方式打开官方磁盘映像。',
      });
      this.mountedMacImage = { device: '', mountPoint };
      const attach = await this.runProgram(
        '/usr/bin/hdiutil',
        ['attach', '-readonly', '-nobrowse', '-noautoopen', '-plist', '-mountpoint', mountPoint, path.resolve(diskImagePath)],
        { timeout: 120_000, track: true },
      );
      const attachPayload = await this.readMacPlistJson(attach.stdout, 'hdiutil-attach');
      const entities = Array.isArray(attachPayload?.['system-entities']) ? attachPayload['system-entities'] : [];
      const mountedEntity = entities.find((entity) => entity?.['mount-point'] === mountPoint);
      mountedDevice = String(mountedEntity?.['dev-entry'] || '');
      if (!/^\/dev\/disk\d+(s\d+)?$/.test(mountedDevice)) {
        throw securityError('无法确认 Ollama 磁盘映像的挂载设备，已停止安装。');
      }
      this.mountedMacImage = { device: mountedDevice, mountPoint };
      const sourceAppPath = path.join(mountPoint, 'Ollama.app');
      if (!isDirectoryWithoutSymlink(sourceAppPath)) {
        throw securityError('官方磁盘映像中未找到预期的 Ollama.app，已停止安装。');
      }
      await this.verifyMacOllamaApp(sourceAppPath);
      this.assertNotCanceled();
      if (lstatOrNull(targetAppPath)) {
        throw securityError('安装过程中发现已有 Ollama.app，PH Launcher 不会覆盖它。请重新检测电脑。');
      }
      this.update({
        stage: 'installing-ollama',
        progress: 35,
        title: '正在安装 Ollama',
        detail: '安装到当前用户的“应用程序”目录，不需要管理员权限。',
        canCancel: true,
      });
      await this.runProgram(
        '/usr/bin/ditto',
        ['--rsrc', '--extattr', '--acl', sourceAppPath, stagingPath],
        { timeout: 10 * 60_000, track: true },
      );
      await this.verifyMacOllamaApp(stagingPath, { silent: true });
      this.assertNotCanceled();
      this.update({
        progress: 38,
        detail: '签名与公证校验通过，正在完成安装。',
        canCancel: false,
      });
      if (lstatOrNull(targetAppPath)) {
        throw securityError('安装目标已被其他程序占用，PH Launcher 未覆盖任何文件。请重试。');
      }
      fs.renameSync(stagingPath, targetAppPath);
      stagingPath = '';
      this.ollamaAppPath = targetAppPath;
      return path.join(targetAppPath, 'Contents', 'Resources', 'ollama');
    } finally {
      const detached = await this.detachMacImage(mountedDevice, mountPoint);
      if (detached) this.mountedMacImage = null;
      else this.writeDiagnostic('detach-warning', 'Ollama disk image remains mounted; temporary directory preserved');
      if (stagingPath) this.removeOwnedMacStaging(stagingPath, applicationsDirectory);
      if (this.state.running) this.update({ canCancel: true });
      if (detached) this.cleanupTemporaryDirectory();
    }
  }

  removeOwnedMacStaging(stagingPath, applicationsDirectory) {
    const resolvedDirectory = path.resolve(applicationsDirectory);
    const resolvedStaging = path.resolve(stagingPath);
    const name = path.basename(resolvedStaging);
    if (path.dirname(resolvedStaging) !== resolvedDirectory || !/^\.PH-Launcher-Ollama-[0-9a-f-]+\.app$/i.test(name)) return;
    const stat = lstatOrNull(resolvedStaging);
    if (!stat) return;
    try {
      if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(resolvedStaging);
      else if (stat.isDirectory()) fs.rmSync(resolvedStaging, { recursive: true, force: true });
    } catch {}
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
    if (await this.isApiReady()) {
      if (this.platform === 'darwin') await this.verifyMacOllamaListener(ollamaPath);
      return;
    }

    if (this.platform === 'darwin') {
      const appPath = this.ollamaAppPath || path.resolve(path.dirname(ollamaPath), '..', '..');
      if (!isDirectoryWithoutSymlink(appPath)) {
        throw securityError('无法确认 Ollama.app 的准确位置，已停止自动启动。');
      }
      await this.verifyMacOllamaApp(appPath, { silent: true });
      this.update({
        detail: 'Ollama 已通过签名与公证校验。若系统询问，请核对名称后选择“打开”；若 Ollama 询问是否移动到系统“应用程序”，请选择暂不移动，命令行链接也可跳过。',
      });
      this.spawnDetached('/usr/bin/open', [appPath]);
      if (await this.waitForApi(35)) {
        await this.verifyMacOllamaListener(ollamaPath);
        return;
      }
      const refreshedPath = await this.findOllama();
      if (refreshedPath) ollamaPath = refreshedPath;
      this.spawnDetached(ollamaPath, ['serve'], { env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' } });
      if (await this.waitForApi(20)) {
        await this.verifyMacOllamaListener(ollamaPath);
        return;
      }
      throw new Error('Ollama 已安全安装，但本地服务未能启动。请在“应用程序”中打开 Ollama，完成 macOS 系统确认后重试。');
    }

    const appExecutable = path.join(path.dirname(ollamaPath), 'ollama app.exe');
    const localOnlyEnvironment = { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' };
    if (fs.existsSync(appExecutable)) this.spawnDetached(appExecutable, [], { env: localOnlyEnvironment });
    else this.spawnDetached(ollamaPath, ['serve'], { env: localOnlyEnvironment });
    if (await this.waitForApi(14)) return;

    if (fs.existsSync(appExecutable)) this.spawnDetached(ollamaPath, ['serve'], { env: localOnlyEnvironment });
    if (await this.waitForApi(20)) return;
    throw new Error('Ollama 已安装，但本地服务未能启动；请在开始菜单打开 Ollama 后重试。');
  }

  async verifyMacOllamaListener(ollamaPath) {
    if (this.platform !== 'darwin') return true;
    const appPath = this.ollamaAppPath || path.resolve(path.dirname(ollamaPath), '..', '..');
    await this.verifyMacOllamaApp(appPath, { silent: true });
    const expectedPaths = new Set();
    for (const candidate of [
      path.resolve(ollamaPath),
      path.join(appPath, 'Contents', 'MacOS', 'Ollama'),
    ]) {
      try { expectedPaths.add(fs.realpathSync.native(candidate)); } catch {}
    }
    const listeners = await this.runProgram(
      '/usr/sbin/lsof',
      ['-nP', '-iTCP:11434', '-sTCP:LISTEN', '-Fpn'],
      { timeout: 15_000, allowFailure: true, track: false },
    );
    const listenerRecords = parseMacLsofListeners(listeners.stdout);
    if (!listenerRecords.length || listenerRecords.some((record) => !isLoopbackOllamaListener(record.address))) {
      throw securityError('Ollama 的 11434 端口未仅绑定本机回环地址，已停止连接。请将 OLLAMA_HOST 设为 127.0.0.1:11434 后重试。');
    }
    const processIds = [...new Set(listenerRecords.map((record) => record.processId))];
    const verifiedProcessIds = new Set();
    for (const processId of processIds) {
      const files = await this.runProgram(
        '/usr/sbin/lsof',
        ['-nP', '-a', '-p', processId, '-d', 'txt', '-Fn'],
        { timeout: 15_000, allowFailure: true, track: false },
      );
      for (const line of String(files.stdout || '').split(/\r?\n/)) {
        if (!line.startsWith('n')) continue;
        try {
          if (expectedPaths.has(fs.realpathSync.native(line.slice(1)))) {
            verifiedProcessIds.add(processId);
            break;
          }
        } catch {}
      }
    }
    if (verifiedProcessIds.size === processIds.length) return true;
    throw securityError('本机 11434 端口正在响应，但无法确认监听程序来自已验证的 Ollama.app。PH Launcher 不会结束该进程，请手动检查后重试。');
  }

  spawnDetached(file, args, options = {}) {
    try {
      const child = spawn(file, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: this.platform === 'win32',
        shell: false,
        env: options.env || process.env,
      });
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
      const versionResponse = await this.fetch(`${OLLAMA_ENDPOINT}/api/version`, { signal: AbortSignal.timeout(2_500) });
      if (!versionResponse.ok) return false;
      const version = await versionResponse.json();
      if (!version || typeof version.version !== 'string' || !version.version.trim()) return false;
      const tagsResponse = await this.fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: AbortSignal.timeout(2_500) });
      if (!tagsResponse.ok) return false;
      const tags = await tagsResponse.json();
      return Boolean(tags && Array.isArray(tags.models));
    } catch {
      return false;
    }
  }

  async fetchTags() {
    const response = await this.fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Ollama 服务返回 ${response.status}。`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.models)) throw new Error('本机 11434 端口返回的内容不是可识别的 Ollama 服务。');
    return payload;
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
    const ignoreCancellation = Boolean(options.ignoreCancellation);
    return new Promise((resolve, reject) => {
      if (!ignoreCancellation) this.assertNotCanceled();
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
      let settled = false;
      let terminationRequested = false;
      let timeoutTimer = null;
      let forceTimer = null;
      let hardStopTimer = null;
      const clearTimers = () => {
        clearTimeout(timeoutTimer);
        clearTimeout(forceTimer);
        clearTimeout(hardStopTimer);
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (track && this.child === child) this.child = null;
        reject(error);
      };
      const finishResolve = (result) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (track && this.child === child) this.child = null;
        resolve(result);
      };
      const terminationError = () => {
        if (this.cancelRequested && !ignoreCancellation) return cancellationError();
        if (timedOut) return new Error(`${path.basename(file)} 执行超时。`);
        return new Error(`${path.basename(file)} 未能停止。`);
      };
      const requestTermination = (reason) => {
        if (reason === 'timeout') timedOut = true;
        if (terminationRequested || settled) return;
        terminationRequested = true;
        try { child.kill('SIGTERM'); } catch {}
        forceTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL'); } catch {}
          }
        }, 2_500);
        hardStopTimer = setTimeout(() => finishReject(terminationError()), 5_000);
      };
      child.phRequestTermination = requestTermination;
      timeoutTimer = setTimeout(() => requestTermination('timeout'), timeout);
      child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-1_000_000); });
      child.once('error', (error) => {
        finishReject(error);
      });
      child.once('close', (code) => {
        if (this.cancelRequested && !ignoreCancellation) return finishReject(cancellationError());
        if (timedOut) return finishReject(new Error(`${path.basename(file)} 执行超时。`));
        if (code !== 0 && !allowFailure) {
          return finishReject(new Error(cleanProgressText(stderr) || `${path.basename(file)} 返回错误代码 ${code}。`));
        }
        finishResolve({ code, stdout, stderr });
      });
    });
  }

  cleanupTemporaryDirectory() {
    // Keep the mount point intact if macOS could not prove that the disk image
    // was detached. Removing a live mount point can hide an attached image and
    // makes a later, explicit cleanup much harder to perform safely.
    if (this.mountedMacImage) return;
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
  OLLAMA_CHECKSUM_URL,
  OLLAMA_MAC_DOWNLOAD_URL,
  OLLAMA_MAC_DOWNLOAD_PAGE,
  OLLAMA_MAC_BUNDLE_ID,
  OLLAMA_MAC_TEAM_ID,
  OLLAMA_MAC_VERSION,
  OLLAMA_MAC_SHA256,
  INSTALLER_RETRY_COUNT,
  LocalAiDeploymentManager,
  cleanProgressText,
  hasModel,
  isAllowedModel,
  isLoopbackOllamaListener,
  parseMacLsofListeners,
  parseMacSignatureDetails,
  parseContentRange,
  requiredSpaceGb,
  translatePullStatus,
};

'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const MAX_FILE_BYTES = 20 * 1024 * 1024;
let importing = false;

async function importReadingDocument(filePath, { timeoutMs = 30000 } = {}) {
  if (importing) throw new Error('正在读取另一份文档，请稍后再试');
  if (typeof filePath !== 'string') throw new Error('请选择本地文档');
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.doc') throw new Error('旧版 .doc 请先用 Word 或 WPS 另存为 .docx，或粘贴文字');
  if (!['.docx', '.pdf', '.txt', '.md'].includes(extension)) throw new Error('支持 .docx、PDF、TXT 和 Markdown 文档');
  importing = true;
  let handle, worker;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('文件不可读取或超过 20 MB，请按章节分段');
    const chunks = []; let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, end: MAX_FILE_BYTES })) {
      bytes += chunk.length;
      if (bytes > MAX_FILE_BYTES) throw new Error('文档超过 20 MB，请按章节分段');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (!data.length) throw new Error('文档为空');
    worker = new Worker(path.join(__dirname, 'reading-document-worker.cjs'), {
      workerData: { data, extension }, resourceLimits: { maxOldGenerationSizeMb: 192 }, stdout: true, stderr: true,
    });
    // Parser diagnostics may contain document text. Do not send them to app logs.
    worker.stdout.resume(); worker.stderr.resume();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('文档读取超过 30 秒，请缩小文件或粘贴文字')), timeoutMs);
      worker.once('message', message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message); });
      worker.once('error', () => { clearTimeout(timer); reject(new Error('文档解析失败或超出内存限制，请另存后重试')); });
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('文档读取已停止，请重试或粘贴文字')); });
    });
    return { title: path.basename(filePath, extension).slice(0, 120), ...result };
  } finally {
    await worker?.terminate().catch(() => {});
    await handle?.close().catch(() => {});
    importing = false;
  }
}
module.exports = { importReadingDocument, MAX_FILE_BYTES };

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_BYTES = 24 * 1024 * 1024;
const id = value => {
  const result = String(value ?? '');
  if (!/^\d{1,18}$/.test(result)) throw new Error('请选择有效的课程作业');
  return result;
};

async function readSelectedFile(filePath) {
  const file = await fs.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw new Error('请选择 24 MB 以内的非空文件');
    // Bounded read even if another program grows the file while the picker closes.
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('文件正在变化，请保存后重新选择');
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}

function createTaskUploadManager({ getRevision, chooseFile, readFile = readSelectedFile, submit, now = Date.now }) {
  let pending = null;
  let choosing = false;
  let submitting = false;
  const clear = () => { pending = null; };
  return {
    clear,
    async prepare(courseId, taskId) {
      if (choosing || submitting) throw new Error('请先完成当前文件操作');
      const cid = id(courseId); const tid = id(taskId);
      const revision = getRevision();
      clear();
      choosing = true;
      try {
        const filePath = await chooseFile(cid, tid);
        if (!filePath) return { canceled: true };
        const bytes = Buffer.from(await readFile(filePath));
        if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('请选择 24 MB 以内的非空文件');
        if (revision !== getRevision()) throw new Error('学校账号已变化，请重新选择文件');
        const filename = path.basename(filePath);
        if (/[\r\n\x00]/.test(filename)) throw new Error('文件名包含无效字符，请重命名后再试');
        pending = { token: randomUUID(), filename, size: bytes.length, courseId: cid, taskId: tid, revision, bytes, expires: now() + 10 * 60 * 1000 };
        const { token, size } = pending;
        return { token, filename, size, courseId: cid, taskId: tid };
      } finally { choosing = false; }
    },
    cancel(token) {
      if (pending?.token === token) clear();
      return { ok: true };
    },
    async confirm(token) {
      if (!pending || typeof token !== 'string' || token !== pending.token) throw new Error('请重新选择要上传的文件');
      const entry = pending;
      clear(); // Single-use even on timeout: never blindly replay a school write.
      if (now() >= entry.expires) throw new Error('文件确认已过期，请重新选择文件');
      if (entry.revision !== getRevision()) throw new Error('学校账号已变化，请重新选择文件');
      if (submitting) throw new Error('文件正在上传，请勿重复提交');
      submitting = true;
      try {
        const result = await submit(entry.courseId, entry.taskId, { bytes: entry.bytes, filename: entry.filename });
        if (entry.revision !== getRevision()) throw new Error('学校账号已变化，上传结果未确认');
        // A successful HTTP response is not evidence of a teacher receipt.
        return { ...result, verification: 'unverified' };
      } finally { submitting = false; }
    },
  };
}

module.exports = { createTaskUploadManager, readSelectedFile, MAX_BYTES };

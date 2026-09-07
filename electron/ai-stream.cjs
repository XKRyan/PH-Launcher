'use strict';

const MAX_STREAM_BYTES = 1_000_000;

function abortError() {
  const error = new Error('AI 请求已取消');
  error.name = 'AbortError';
  return error;
}

async function readResponseText(response, onChunk, signal) {
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('AI 服务没有返回可读取的数据流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let failure = null;
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_STREAM_BYTES) throw new Error('AI 回复过长，已停止接收');
      const text = decoder.decode(value, { stream: true });
      if (text) onChunk(text);
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (signal?.aborted || failure) {
      try { await reader.cancel(signal?.reason || failure); } catch {}
    }
    try { reader.releaseLock(); } catch {}
  }
}

function ndjsonStream(onDelta) {
  let pending = '';
  let content = '';
  let finalMessage = null;
  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let item;
    try { item = JSON.parse(trimmed); } catch { throw new Error('本地 AI 返回了无法识别的数据流'); }
    if (item.error) throw new Error(String(item.error).slice(0, 240));
    const delta = String(item.message?.content || item.response || '');
    if (delta) { content += delta; onDelta(delta); }
    if (item.done) finalMessage = item.message || { role: 'assistant', content };
  };
  return {
    push(text) {
      pending += text;
      if (pending.length > MAX_STREAM_BYTES) throw new Error('AI 返回的数据块过长');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      lines.forEach(consumeLine);
    },
    finish() {
      if (pending.trim()) consumeLine(pending);
      if (!finalMessage) throw new Error('本地 AI 流提前结束，请重试');
      return { content, message: finalMessage };
    },
  };
}

async function streamOllamaChat({ fetchImpl = fetch, url, payload, signal, onDelta }) {
  const response = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal, redirect: 'error',
  });
  if (!response.ok) throw new Error(`本地 AI 返回 ${response.status}`);
  const parser = ndjsonStream(onDelta);
  await readResponseText(response, (text) => parser.push(text), signal);
  return parser.finish();
}

module.exports = { streamOllamaChat };

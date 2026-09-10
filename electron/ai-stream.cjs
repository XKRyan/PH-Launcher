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

// Tool calls arrive incrementally in both protocols, so merge them by index:
// the id and name usually come once, the JSON arguments arrive in fragments.
// Ollama sends a complete object, SSE sends string fragments.
function mergeToolCall(slot, incoming) {
  if (incoming.id) slot.id = String(incoming.id);
  const fn = incoming.function || {};
  if (fn.name) slot.name = String(slot.name || '') + String(fn.name);
  if (fn.arguments !== undefined && fn.arguments !== null) {
    const chunk = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
    slot.arguments = String(slot.arguments || '') + chunk;
  }
  return slot;
}

function collectToolCalls(slots) {
  return [...slots.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, slot]) => ({ id: slot.id, type: 'function', function: { name: slot.name, arguments: slot.arguments || '{}' } }))
    .filter((call) => call.function.name);
}

function ndjsonStream(onDelta) {
  let pending = '';
  let content = '';
  let finalMessage = null;
  const toolSlots = new Map();
  const consumeLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let item;
    try { item = JSON.parse(trimmed); } catch { throw new Error('本地 AI 返回了无法识别的数据流'); }
    if (item.error) throw new Error(String(item.error).slice(0, 240));
    const message = item.message || {};
    const delta = String(message.content || item.response || '');
    if (delta) { content += delta; onDelta(delta); }
    // Ollama reports tool calls as a (usually single) streamed message field.
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((call, index) => {
        const slot = toolSlots.get(index) || { id: '', name: '', arguments: '' };
        toolSlots.set(index, mergeToolCall(slot, call));
      });
    }
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
      if (!finalMessage && !toolSlots.size) throw new Error('本地 AI 流提前结束，请重试');
      const calls = collectToolCalls(toolSlots);
      return { content, message: finalMessage || { role: 'assistant', content }, toolCalls: calls };
    },
  };
}

// OpenAI-compatible Server-Sent Events: "data: {json}" lines ended by
// "data: [DONE]". Used by every /chat/completions provider.
function sseStream(onDelta) {
  let pending = '';
  let content = '';
  let finishReason = '';
  const toolSlots = new Map();
  const consumeData = (payload) => {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === '[DONE]') return;
    let item;
    try { item = JSON.parse(trimmed); } catch { return; }
    if (item.error) throw new Error(String(item.error?.message || item.error).slice(0, 240));
    const choice = item.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    const text = typeof delta.content === 'string' ? delta.content : '';
    if (text) { content += text; onDelta(text); }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = Number.isInteger(call.index) ? call.index : toolSlots.size;
        const slot = toolSlots.get(index) || { id: '', name: '', arguments: '' };
        toolSlots.set(index, mergeToolCall(slot, call));
      }
    }
    if (choice.finish_reason) finishReason = String(choice.finish_reason);
  };
  return {
    push(text) {
      pending += text;
      if (pending.length > MAX_STREAM_BYTES) throw new Error('AI 返回的数据块过长');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        consumeData(line.slice(5));
      }
    },
    finish() {
      if (pending.trim().startsWith('data:')) consumeData(pending.trim().slice(5));
      return { content, toolCalls: collectToolCalls(toolSlots), finishReason };
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

async function streamOpenAiChat({ fetchImpl = fetch, url, headers, payload, signal, onDelta }) {
  const response = await fetchImpl(url, {
    method: 'POST', headers, body: JSON.stringify({ ...payload, stream: true }), signal, redirect: 'error',
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`API 返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const parser = sseStream(onDelta);
  await readResponseText(response, (text) => parser.push(text), signal);
  return parser.finish();
}

module.exports = { streamOllamaChat, streamOpenAiChat, ndjsonStream, sseStream, collectToolCalls, mergeToolCall };

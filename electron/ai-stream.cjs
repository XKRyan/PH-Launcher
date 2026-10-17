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

function ndjsonStream(onDelta, onReasoning) {
  let pending = '';
  let content = '';
  let reasoning = '';
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
    // Ollama 0.6+ 把思考放在 message.thinking，与 content 分开（think:true 时才有）。
    const think = typeof message.thinking === 'string' ? message.thinking : '';
    if (think) { reasoning += think; onReasoning?.(think); }
    // Ollama reports tool calls as a (usually single) streamed message field.
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((call, index) => {
        const slot = toolSlots.get(index) || { id: '', name: '', arguments: '' };
        toolSlots.set(index, mergeToolCall(slot, call));
      });
    }
    if (item.done) {
      finalMessage = item.message || { role: 'assistant', content };
      if (item.done_reason) reasoning = reasoning || '';
    }
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
      return { content, reasoning, message: finalMessage || { role: 'assistant', content }, toolCalls: calls };
    },
  };
}

// OpenAI-compatible Server-Sent Events: "data: {json}" lines ended by
// "data: [DONE]". Used by every /chat/completions provider.
//
// Reasoning models (DeepSeek's `deepseek-flash`, and others) stream their
// chain of thought in a SEPARATE field next to `content` — `reasoning_content`
// on DeepSeek, `reasoning` on some compatible gateways. It used to be dropped
// entirely, so the user saw a long silence and assumed the app had hung.
function sseStream(onDelta, onReasoning) {
  let pending = '';
  let content = '';
  let reasoning = '';
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
    const think = typeof delta.reasoning_content === 'string' && delta.reasoning_content
      ? delta.reasoning_content
      : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
    if (think) { reasoning += think; onReasoning?.(think); }
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
      return { content, reasoning, toolCalls: collectToolCalls(toolSlots), finishReason };
    },
  };
}

async function streamOllamaChat({ fetchImpl = fetch, url, payload, signal, onDelta, onReasoning }) {
  const response = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal, redirect: 'error',
  });
  if (!response.ok) throw new Error(`本地 AI 返回 ${response.status}`);
  const parser = ndjsonStream(onDelta, onReasoning);
  await readResponseText(response, (text) => parser.push(text), signal);
  return parser.finish();
}

async function streamOpenAiChat({ fetchImpl = fetch, url, headers, payload, signal, onDelta, onReasoning }) {
  const response = await fetchImpl(url, {
    method: 'POST', headers, body: JSON.stringify({ ...payload, stream: true }), signal, redirect: 'error',
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`API 返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const parser = sseStream(onDelta, onReasoning);
  await readResponseText(response, (text) => parser.push(text), signal);
  return parser.finish();
}

// Anthropic Messages API 的 SSE：每个事件是 "event: X" + "data: {...}"。
// 文本在 content_block_delta(delta.type='text_delta').delta.text；
// 工具调用是 content_block_start(type='tool_use') 给出 id/name，
// 随后 input_json_delta.partial_json 分片拼出参数 JSON；
// 扩展思考（extended thinking）走 thinking_delta.thinking，同样与正文分开。
function anthropicSseStream(onDelta, onReasoning) {
  let pending = '';
  let content = '';
  let reasoning = '';
  let stopReason = '';
  const blocks = new Map();
  const consumeData = (payload) => {
    const trimmed = payload.trim();
    if (!trimmed) return;
    let item;
    try { item = JSON.parse(trimmed); } catch { return; }
    if (item.type === 'error') throw new Error(String(item.error?.message || item.error || 'API 返回错误').slice(0, 240));
    if (item.type === 'message_delta' && item.delta?.stop_reason) {
      stopReason = String(item.delta.stop_reason);
      return;
    }
    if (item.type === 'content_block_start' && item.content_block?.type === 'tool_use') {
      blocks.set(Number(item.index) || 0, {
        id: String(item.content_block.id || ''), name: String(item.content_block.name || ''), json: '',
      });
      return;
    }
    if (item.type === 'content_block_delta') {
      const delta = item.delta || {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        content += delta.text;
        onDelta(delta.text);
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        reasoning += delta.thinking;
        onReasoning?.(delta.thinking);
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const slot = blocks.get(Number(item.index) || 0) || { id: '', name: '', json: '' };
        slot.json = String(slot.json || '') + delta.partial_json;
        blocks.set(Number(item.index) || 0, slot);
      }
    }
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
      const toolCalls = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, slot]) => ({
        id: slot.id, type: 'function', function: { name: slot.name, arguments: slot.json || '{}' },
      })).filter((call) => call.function.name);
      return { content, reasoning, toolCalls, finishReason: stopReason };
    },
  };
}

async function streamAnthropicChat({ fetchImpl = fetch, url, headers, payload, signal, onDelta, onReasoning }) {
  const response = await fetchImpl(url, {
    method: 'POST', headers, body: JSON.stringify({ ...payload, stream: true }), signal, redirect: 'error',
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`API 返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const parser = anthropicSseStream(onDelta, onReasoning);
  await readResponseText(response, (text) => parser.push(text), signal);
  return parser.finish();
}

module.exports = {
  streamOllamaChat, streamOpenAiChat, streamAnthropicChat,
  ndjsonStream, sseStream, anthropicSseStream, collectToolCalls, mergeToolCall,
};

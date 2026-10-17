'use strict';

/**
 * AI 请求的「线格式」与空回复提示。
 *
 * 单独成模块是为了能真正单测：`main.cjs` 一 require 就会去创建窗口，
 * 而这几条规则恰恰是最容易出错、也最该有测试盯着的地方。
 */

/** provider 认得的消息键。内部字段（reasoning / finishReason）绝不能发出去。 */
const AI_WIRE_MESSAGE_KEYS = new Set(['role', 'content', 'tool_calls', 'tool_call_id', 'name']);

/**
 * 内部历史 → OpenAI 线格式。
 *
 * `passReasoning=false`：只保留 provider 认得的键。
 * `passReasoning=true`：额外给**带工具调用的 assistant 轮**补上 `reasoning_content`。
 *
 * 为什么需要后者：思考模式的 provider（DeepSeek 等）要求把思考内容原样回传，
 * 否则**工具轮的第二轮**会被 400 拒：
 *   The `reasoning_content` in the thinking mode must be passed back to the API.
 * 实测（2026-09-22）：只有带工具调用的那一轮强制要求；该字段必须是**字符串**
 * ——`""` 可以，`null` 与「字段缺失」都会被拒，所以拿不到思考时补空串而不是省略。
 */
function openAiMessages(messages, passReasoning) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (!message || typeof message !== 'object') return message;
    const out = {};
    for (const key of Object.keys(message)) {
      if (AI_WIRE_MESSAGE_KEYS.has(key)) out[key] = message[key];
    }
    if (passReasoning && out.role === 'assistant'
      && Array.isArray(out.tool_calls) && out.tool_calls.length) {
      out.reasoning_content = typeof message.reasoning === 'string' ? message.reasoning : '';
    }
    return out;
  });
}

/**
 * 这个报错是不是「必须把思考传回来」引起的？
 * 只认这一种：别的错误（鉴权、限流、网络）不能靠重试掩盖。
 */
function needsReasoningPassthrough(error) {
  return /reasoning_content/i.test(String(error?.message || ''));
}

/**
 * 回复为空时给一句**能照着修**的话。
 *
 * 为什么要单独处理：思考模式的模型会把输出预算先花在思考上，用光时 API 会返回
 * **HTTP 200 + 空 content + finish_reason=length**，并不抛异常。以前这里只会显示
 * 「没有收到有效回复」，用户不知道该改模型、改问题还是查网络。
 */
function emptyReplyMessage(finishReason, config) {
  const reason = String(finishReason || '').toLowerCase();
  const model = String(config?.apiModel || config?.localModel || '').trim() || '当前模型';
  if (reason === 'length') {
    return `模型把输出预算用完了，没能留下正文（finish_reason=length）。「${model}」`
      + '如果是会先思考的模型，思考会很占预算 —— 换一个更小的模型，或把问题问短一点再试。';
  }
  if (reason === 'content_filter') {
    return '模型判定这条请求被内容策略拦截了（finish_reason=content_filter），没有产出正文。';
  }
  return `模型「${model}」没有返回任何内容（finish_reason=${reason || '未知'}）。`
    + '常见原因：模型名写错、额度用尽、或该服务商不支持流式。可在「设置 → AI」里核对。';
}

module.exports = {
  AI_WIRE_MESSAGE_KEYS,
  openAiMessages,
  needsReasoningPassthrough,
  emptyReplyMessage,
};

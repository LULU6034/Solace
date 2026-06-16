/**
 * llm-client.js — 统一 LLM 客户端
 *
 * 封装 Anthropic SDK 和 OpenAI SDK，提供统一接口：
 * - createLLM(config) → LLM 实例
 * - llm.stream(messages, options) → AsyncGenerator<Chunk>
 * - llm.invoke(messages, options) → Response
 *
 * 支持：
 * - Claude (Anthropic SDK) — 含 extended thinking
 * - DeepSeek (OpenAI 兼容 API) — 含 reasoning_content 提取
 * - OpenAI (原生 SDK)
 */
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('llm-client');

// ── Chunk type ──
/**
 * @typedef {Object} LLMChunk
 * @property {string} [content] — text delta
 * @property {string} [reasoning] — reasoning/thinking content
 * @property {Array} [toolCalls] — accumulated tool calls
 * @property {Object} [usage] — token usage (final chunk only)
 * @property {boolean} [done] — stream finished
 */

// ── Anthropic (Claude) ──
async function* _streamClaude(messages, options, abortSignal) {
  let Anthropic;
  try {
    const mod = await import('@anthropic-ai/sdk');
    Anthropic = mod.default || mod.Anthropic;
  } catch (err) {
    log.error(`@anthropic-ai/sdk 导入失败: ${err.message}`);
    throw new Error(`@anthropic-ai/sdk 不可用: ${err.message}`);
  }

  const anthropic = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseUrl || undefined });

  const systemMsg = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const chatMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      // Handle tool result messages
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || '', content: m.content || '' }],
        };
      }
      // Handle assistant messages with tool_use blocks (both raw and OpenAI format)
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const content = [{ type: 'text', text: m.content || '' }];
        for (const tc of m.tool_calls) {
          const name = tc.function?.name || tc.name || '';
          const input = tc.function?.arguments
            ? (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
            : (tc.args || {});
          content.push({ type: 'tool_use', id: tc.id || '', name, input });
        }
        return { role: 'assistant', content };
      }
      const msg = { role: m.role, content: m.content };
      // Handle image content blocks
      if (Array.isArray(m.content)) {
        const textParts = m.content.filter(b => b.type === 'text');
        const imgParts = m.content.filter(b => b.type === 'image_url');
        if (imgParts.length > 0 && textParts.length > 0) {
          msg.content = [
            ...textParts.map(t => ({ type: 'text', text: t.text })),
            ...imgParts.map(i => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: (i.image_url?.url || '').includes('image/png') ? 'image/png' : 'image/jpeg',
                data: (i.image_url?.url || '').replace(/^data:image\/\w+;base64,/, ''),
              },
            })),
          ];
        }
      }
      return msg;
    });

  const streamOptions = {
    model: options.model || 'claude-sonnet-4-20250506',
    max_tokens: options.maxTokens || 8192,
    temperature: options.temperature ?? 0.7,
    messages: chatMessages,
    stream: true,
  };

  if (systemMsg) streamOptions.system = systemMsg;
  if (options.tools?.length) streamOptions.tools = options.tools;

  const stream = await anthropic.messages.stream(streamOptions, {
    signal: abortSignal,
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        yield { content: event.delta.text };
      } else if (event.delta.type === 'thinking_delta') {
        yield { reasoning: event.delta.thinking };
      }
    } else if (event.type === 'content_block_start') {
      if (event.content_block.type === 'tool_use') {
        yield { toolCallStart: { id: event.content_block.id, name: event.content_block.name } };
      }
    } else if (event.type === 'content_block_stop') {
      // End of a content block
    } else if (event.type === 'message_delta') {
      if (event.usage) {
        yield { usage: event.usage };
      }
    }
  }

  const finalMsg = await stream.finalMessage();
  const toolCalls = finalMsg.content
    .filter(c => c.type === 'tool_use')
    .map(tc => ({
      id: tc.id,
      name: tc.name,
      args: tc.input,
    }));

  yield { done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage: finalMsg.usage };
}

// ── OpenAI (GPT / DeepSeek) ──
async function* _streamOpenAI(messages, options, abortSignal) {
  let OpenAI;
  try {
    const mod = await import('openai');
    OpenAI = mod.default || mod.OpenAI;
  } catch (err) {
    log.error(`openai 包导入失败: ${err.message}`);
    throw new Error(`openai 包不可用: ${err.message}`);
  }

  const openai = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl || 'https://api.openai.com/v1',
  });

  const chatMessages = messages.map(m => {
    if (m.role === 'system') return { role: 'system', content: m.content };
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id || '', content: m.content || '' };
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map(tc => {
          // Handle both raw format {id, name, args} and OpenAI format {id, type:'function', function:{name, arguments}}
          const name = tc.function?.name || tc.name || '';
          const args = tc.function?.arguments || (typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}));
          return {
            id: tc.id || '',
            type: 'function',
            function: { name, arguments: args },
          };
        }),
      };
    }
    if (Array.isArray(m.content)) {
      return { role: m.role, content: m.content };
    }
    return { role: m.role, content: m.content };
  });

  const streamOptions = {
    model: options.model || 'gpt-4o',
    max_tokens: options.maxTokens || 8192,
    temperature: options.temperature ?? 0.7,
    messages: chatMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // DeepSeek 思考模式控制：
  // - thinking: { type: "enabled"|"disabled" } — 开/关思考链
  // - reasoning_effort: "high"|"max" — 思考深度（low/medium 会被映射到 high）
  // 参考: https://api-docs.deepseek.com/guides/thinking_mode
  if (options.thinkingType) {
    streamOptions.thinking = { type: options.thinkingType };
  }
  if (options.reasoningEffort && options.reasoningEffort !== 'none') {
    streamOptions.reasoning_effort = options.reasoningEffort;
  }

  if (options.tools?.length) {
    streamOptions.tools = options.tools;
    streamOptions.tool_choice = 'auto';
  }

  const stream = await openai.chat.completions.create(streamOptions, {
    signal: abortSignal,
  });

  let accumulatedToolCalls = new Map(); // index → { id, name, arguments }

  for await (const chunk of stream) {
    // Usage info
    if (chunk.usage) {
      yield { usage: chunk.usage };
    }

    const choice = chunk.choices?.[0];
    if (choice?.finish_reason && choice.finish_reason !== 'stop') {
      log.log('finish_reason:', choice.finish_reason);
    }
    const delta = choice?.delta;
    if (!delta) continue;

    // Text content
    if (delta.content) {
      yield { content: delta.content };
    }

    // Reasoning content (DeepSeek)
    if (delta.reasoning_content) {
      yield { reasoning: delta.reasoning_content };
    }

    // Tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!accumulatedToolCalls.has(idx)) {
          accumulatedToolCalls.set(idx, {
            id: tc.id || '',
            name: tc.function?.name || '',
            arguments: '',
          });
        }
        const acc = accumulatedToolCalls.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
      }
    }
  }

  const toolCalls = [...accumulatedToolCalls.values()]
    .filter(tc => tc.name)
    .map(tc => ({
      id: tc.id || '',
      name: tc.name,
      args: _safeJsonParse(tc.arguments) || {},
    }));

  yield { done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
}

// ── Unified interface ──

export function createLLM(config = {}) {
  const provider = config.provider || 'claude';
  const apiKey = config.apiKey || '';
  const baseUrl = config.baseUrl || '';
  const model = config.model || '';
  const temperature = config.temperature ?? 0.7;
  const maxTokens = config.maxTokens || 8192;
  const reasoningEffort = config.reasoningEffort || '';
  // thinkingType: "enabled" 开启思考链，"disabled" 关闭
  // V4 模型默认 enabled，设为 disabled 才能真正关闭推理
  const thinkingType = config.thinkingType || (reasoningEffort === 'none' ? 'disabled' : '');

  const providerConfig = {
    apiKey,
    baseUrl,
    model,
    temperature,
    maxTokens,
    reasoningEffort,
    thinkingType,
  };

  return {
    provider,
    config: providerConfig,

    /**
     * Stream LLM response.
     * @param {Array} messages — [{role, content}]
     * @param {Object} opts — { tools?, signal? }
     * @returns {AsyncGenerator<LLMChunk>}
     */
    async *stream(messages, opts = {}) {
      const options = {
        ...providerConfig,
        tools: opts.tools || undefined,
      };
      const abortSignal = opts.signal;

      if (provider === 'claude') {
        yield* _streamClaude(messages, options, abortSignal);
      } else {
        // deepseek, openai, and any OpenAI-compatible
        const base = provider === 'deepseek'
          ? 'https://api.deepseek.com/v1'
          : 'https://api.openai.com/v1';
        yield* _streamOpenAI(messages, { ...options, baseUrl: baseUrl || base }, abortSignal);
      }
    },

    /**
     * Non-streaming invoke.
     * @returns {Promise<{content: string, toolCalls?: Array, usage?: Object}>}
     */
    async invoke(messages, opts = {}) {
      let content = '';
      let toolCalls = null;
      let usage = null;

      for await (const chunk of this.stream(messages, opts)) {
        if (chunk.content) content += chunk.content;
        // Note: reasoning is not accumulated in invoke mode for brevity
        if (chunk.toolCalls) toolCalls = chunk.toolCalls;
        if (chunk.usage) usage = chunk.usage;
      }

      return { content: content.trim(), toolCalls, usage };
    },
  };
}

// ── Convert tools to OpenAI format ──
export function toOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

// ── Convert tools to Anthropic format ──
export function toAnthropicTools(tools) {
  return tools.map(t => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.parameters || { type: 'object', properties: {} },
  }));
}

// ── Helpers ──
function _safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

export { log };

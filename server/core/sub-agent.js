/**
 * sub-agent.js — 子 Agent 执行器
 *
 * 主 Agent 通过 spawn_agent 工具派发子任务。
 * 子 Agent 有独立的 LLM 实例 + 受限工具集 + 简化 ReAct 循环（3 轮）。
 *
 * 与 coordinator.js 的区别:
 *   - Coordinator: 多 Agent 对话/协作，关注讨论流程
 *   - Sub-agent: 单 Agent 执行具体任务 → 返回文本报告，关注结果
 */
import { createLLM, toOpenAITools, toAnthropicTools } from './llm-client.js';
import { assembleSystemPrompt } from '../lib/prompt-loader.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('sub-agent');

const MAX_ROUNDS = 3;
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 8000; // 子 Agent 总输出上限

/**
 * @param {object} opts
 * @param {object} opts.config — LLM 配置 { provider, model, apiKey, ... }
 * @param {string} opts.instruction — 子任务描述
 * @param {string[]|null} opts.toolsWhitelist — 允许的工具名列表，null=全部
 * @param {function} [opts.sendEvent] — 事件回调（可选，用于流式进度）
 * @returns {Promise<string>} 子 Agent 的文本报告
 */
export async function runSubAgent({ config, instruction, toolsWhitelist, sendEvent }) {
  const tStart = Date.now();
  const _send = (type, data) => {
    try { sendEvent?.(type, data); } catch (e) { log.warn('操作失败', e?.message || e); }
  };

  // 1. 创建 LLM（关闭思考，节省时间）
  const llm = createLLM({ ...config, reasoningEffort: 'none', temperature: 0.4, maxTokens: 2000 });

  // 2. 加载工具（白名单过滤）
  let allTools = [];
  try {
    const toolsMod = await import('../tools/index.js');
    allTools = toolsMod.getAllTools();
  } catch { allTools = []; }

  const tools = toolsWhitelist
    ? allTools.filter(t => toolsWhitelist.includes(t.name))
    : allTools;

  const toolMap = new Map(tools.map(t => [t.name, t]));
  log.log(`子 Agent 启动: ${tools.length} 个工具 (${toolsWhitelist?.join(',') || '全部'})`);

  // 3. 构建消息
  const systemPrompt = `你是专家子任务执行者。你被主 Agent 派来执行一个具体任务。

${assembleSystemPrompt('chat')}

完成子任务后返回简洁的文本报告。不需要礼貌用语（"你好"、"收到"），直接给出结果。
不要反问问题，不要请求更多信息——基于已有信息给出最佳答案。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: instruction },
  ];

  // 4. 简化的 ReAct 循环
  const isClaude = (config?.provider || 'claude') === 'claude';
  const formattedTools = isClaude ? toAnthropicTools(tools) : toOpenAITools(tools);
  const toolFailCount = new Map();

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const tRound = Date.now();

    const validMessages = messages.filter(m => m.content != null || m.tool_calls?.length);

    let accumulatedContent = '';
    let finalToolCalls = null;
    let tokenCount = 0;

    // 流式调用（带超时 + token 预算）
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

    try {
      for await (const chunk of llm.stream(validMessages, {
        tools: formattedTools,
        signal: abort.signal,
      })) {
        if (chunk.content) {
          accumulatedContent += chunk.content;
          tokenCount += Math.ceil(chunk.content.length / 2); // 粗略估计: CJK ~1char/token, EN ~4char/token, 取 2
        }
        if (chunk.toolCalls) finalToolCalls = chunk.toolCalls;
        if (tokenCount > MAX_OUTPUT_TOKENS) {
          log.log(`子 Agent 达到 token 上限 (${MAX_OUTPUT_TOKENS})，停止`);
          abort.abort(); break;
        }
      }
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') return `(子任务超时 ${TIMEOUT_MS / 1000}s)`;
      return `(子任务错误: ${err.message})`;
    }
    clearTimeout(timer);

    // 无工具调用 → 完成
    if (!finalToolCalls?.length) {
      const result = accumulatedContent.trim();
      log.log(`子 Agent 完成: ${(Date.now() - tStart) / 1000}s, ${result.length} 字`);
      return result || '(子任务完成，无输出)';
    }

    // 有工具调用 → 执行
    const fixedCalls = finalToolCalls.map((tc, i) => ({
      ...tc,
      id: tc.id || `sub_${round}_${i}_${Date.now()}`,
    }));

    // 推送 assistant 消息
    messages.push({
      role: 'assistant',
      content: accumulatedContent || null,
      tool_calls: fixedCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
        },
      })),
    });

    // 执行工具
    for (const tc of fixedCalls) {
      const tool = toolMap.get(tc.name);
      if (!tool) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `工具 '${tc.name}' 不可用（不在白名单中）`,
        });
        continue;
      }

      // 失败计数
      if ((toolFailCount.get(tc.name) || 0) >= 2) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: '该工具已失败多次，已禁用',
        });
        continue;
      }

      try {
        const result = await tool.invoke(tc.args || {});
        let resultStr;
        if (result == null || result === '') {
          resultStr = '(无输出)';
        } else if (typeof result === 'string') {
          resultStr = result.length > 40000 ? result.slice(0, 40000) + '\n...(截断)' : result;
        } else {
          resultStr = JSON.stringify(result).slice(0, 6000);
        }

        // 失败检测（与主 Agent 对齐）
        const failPatterns = [/^工具执行出错:/, /^命令执行失败/, /^文件读取失败:/, /^文件写入失败:/, /^搜索.*时遇到网络问题/, /^网页抓取失败:/, /^记忆(存储|搜索)失败:/, /^生成失败:/];
        if (failPatterns.some(p => p.test(resultStr))) {
          toolFailCount.set(tc.name, (toolFailCount.get(tc.name) || 0) + 1);
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultStr,
        });
      } catch (err) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `工具执行出错: ${err.message}`,
        });
      }
    }

    log.log(`子 Agent 第 ${round} 轮: ${(Date.now() - tRound) / 1000}s`);
  }

  // 5. 达到最大轮数 → 兜底回答
  log.log(`子 Agent 达到最大轮数，兜底回答`);
  try {
    const llmNoTools = createLLM({ ...config, reasoningEffort: 'none', temperature: 0.3, maxTokens: 500 });
    const cleanMessages = messages
      .filter(m => m.role !== 'tool' && !m.tool_calls?.length)
      .slice(-4);
    const finalMessages = [
      ...cleanMessages,
      { role: 'user', content: '请基于已有信息用一句话总结你的发现，不超过 100 字。' },
    ];
    let finalText = '', ft = 0;
    for await (const chunk of llmNoTools.stream(finalMessages)) {
      if (chunk.content) { finalText += chunk.content; ft += Math.ceil(chunk.content.length / 2); if (ft > 500) break; }
    }
    return finalText.trim() || '(子任务完成，无法总结)';
  } catch {
    return '(子任务完成，但总结失败)';
  }
}

// ═══════════════════════════════════════
// 工具定义（注册到 tools/index.js）
// ═══════════════════════════════════════

export const spawnAgent = {
  name: 'spawn_agent',
  description: `派发一个子 Agent 执行独立任务。子 Agent 有独立的 LLM 实例和受限工具集，执行完返回文本报告。
多个 spawn_agent 可以并行调用（同一轮中多次调用会自动并行执行）。
参数 instruction: 任务描述（越具体越好）
参数 tools: 允许子 Agent 使用的工具名列表（如 ["read_file","grep","glob"]），默认全部可用`,
  parameters: {
    type: 'object',
    properties: {
      instruction: { type: 'string', description: '子任务描述，越具体越好' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: '允许的工具名列表，如 ["read_file","grep","web_search"]',
      },
    },
    required: ['instruction'],
  },
  async invoke({ instruction, tools }) {
    // 这个工具由 agent.js 特殊处理（直接调 runSubAgent），
    // 但如果被独立调用，返回提示
    return 'spawn_agent 应该由 Agent 框架直接执行。如果你看到这条消息，联系开发者。';
  },
};

export const subAgentTools = [spawnAgent];

/**
 * agent.js — Agent ReAct 循环
 *
 * 两阶段架构（对应 Python agent_loop.py）：
 *   Phase 1 — Thinking: 无工具流式推理，与视觉并行
 *   Phase 2 — Answer: ReAct 循环，max 3 轮工具调用
 *
 * 改进：
 * - 循环检测（3 次相同调用 → 阻断）
 * - 工具失败计数（≥2 → 禁用）
 * - 记忆注入 + 对话后自动提取
 * - 兜底回答（达到最大轮数时）
 */
import { createLLM, toOpenAITools, toAnthropicTools } from './llm-client.js';
import { createModuleLogger } from '../lib/debug-log.js';
import { loadPrompt, assembleSystemPrompt } from '../lib/prompt-loader.js';
import { runSubAgent } from './sub-agent.js';
import { extractMemories } from '../memory/extractor.js';

const log = createModuleLogger('agent');

// 缓存动态 import，避免热路径重复加载
let _toolsModule = null;
let _kbSharedModule = null;
let _visionModule = null;
async function _getToolsModule() { if (!_toolsModule) _toolsModule = await import('../tools/index.js'); return _toolsModule; }
async function _getKBShared() { if (!_kbSharedModule) _kbSharedModule = await import('../knowledge/tools-shared.js'); return _kbSharedModule; }
async function _getVisionModule() { if (!_visionModule) _visionModule = await import('../vision/expert.js'); return _visionModule; }

const MAX_ANSWER_ROUNDS = 8;
const MAX_RESULT_CHARS = 40000;
const MAX_OBSERVATION_CHARS = 3000;
const MAX_SYSTEM_CHARS = 20000;
const TOOL_ONLY_LIMIT = 4;
const MAX_ACK_CHARS = 150;
const MAX_FALLBACK_TOKENS = 500;
// ── 动态推理力度选择 ──
// DeepSeek API reasoning_effort 支持五档: low / medium / high / max / xhigh
// low/medium → API 映射到 high（但仍传入以保持语义清晰）
// 参考: https://api-docs.deepseek.com/guides/thinking_mode
function _chooseReasoningEffort(userText, currentSetting) {
  // 用户手动关闭推理 → 保持关闭
  if (currentSetting === 'none') return 'none';

  const text = (userText || '').trim();
  const len = text.length;

  // xhigh: 数学证明、深度代码调试、超长文本分析
  if (/[证明推导数学公式定理]/.test(text)) return 'xhigh';
  if (len > 500) return 'xhigh';

  // max: 代码调试、性能优化、多跳逻辑推理
  if (/[代码debug调试bug错误报错修复优化.*性能]/.test(text)) return 'max';
  if (/[分析逻辑推理算法复杂度]/.test(text)) return 'max';
  if (len > 200) return 'max';

  // low: 简单问候、确认、单字回复
  if (/^(你好|嗨|hi|谢谢|晚安|早安|再见|拜拜|ok|好|嗯|哦|在吗|在不在)$/i.test(text)) return 'low';
  if (len < 8) return 'low';

  // medium: 一般问答、闲聊
  if (len < 40 && !/[为什么怎么如何解释]/.test(text)) return 'medium';

  // 默认：high
  return 'high';
}

function _thinkingPrompt(hasImages) {
  // 中文语境锚定：中文正文在前，英文指令在后
  let appContext = '';
  try { appContext = loadPrompt('app-guide'); } catch (e) { log.warn('操作失败', e?.message || e); }

  const langBlock = '用户只会阅读中文。你必须用中文进行所有思考和回复，包括内部推理过程。你有完整的文件读写、搜索和命令执行能力，任何任务都能完成。';
  if (hasImages) {
    return `${appContext}\n\n${langBlock}\n\n用户发送了图片，视觉分析正在后台并行进行。请用中文思考：先根据文字问题预判意图，2-3 句。`;
  }
  return `${appContext}\n\n${langBlock}\n\n用户发来了一条文字消息。请用中文思考：判断意图，2-3 句。`;
}

async function _defaultSystemPrompt(chatMode = 'chat', agentName = 'Sonder') {
  let prompt;
  try { prompt = assembleSystemPrompt(chatMode); } catch { prompt = '你是用户的朋友。简洁自然地回复。'; }

  // 替换动态占位符
  prompt = prompt.replace(/\{\{AGENT_NAME\}\}/g, agentName);

  // 注入已启用的 Skill 目录 + 路由规则
  try {
    const m = await import('../tools/skill-tools.js');
    const catalog = m.getSkillCatalog?.();
    if (catalog) prompt += `\n\n## 可用技能\n${catalog}\n\n技能路由规则：收到用户请求后，先检查以上列表是否有匹配技能。如有匹配（如用户提到"docx/pdf/pptx"），直接用对应技能处理，不要只给文字回复。`;
  } catch (e) { log.warn('操作失败', e?.message || e); }

  return prompt;
}

// ── 后处理：替换英文残留（兜底方案，优先靠提示词避免） ──
const EN_REPLACEMENTS = [
  [/\bAnd\b/g, '并且'], [/\bSo\b/g, '所以'], [/\bBut\b/g, '但是'],
  [/\bHowever\b/g, '然而'], [/\bTherefore\b/g, '因此'], [/\bThus\b/g, '因此'],
  [/\bFirst\b/g, '第一'], [/\bThen\b/g, '然后'], [/\bFinally\b/g, '最后'],
  [/\bNote that\b/gi, '注意'], [/\be\.g\./gi, '例如'], [/\bi\.e\./gi, '即'],
  [/\bOK\b/g, '好的'], [/\bYes\b/g, '是的'], [/\bNo\b/g, '不是'],
  [/\bLet me\b/gi, '我来'], [/\bI need to\b/gi, '我需要'],
  [/\bI should\b/gi, '我应该'], [/\bI will\b/gi, '我将'],
  [/\bThe user\b/gi, '用户'], [/\bBased on\b/gi, '根据'],
  [/\bAccording to\b/gi, '根据'], [/\bIn this case\b/gi, '这种情况下'],
  [/\bThis means\b/gi, '这意味着'], [/\bWe can\b/gi, '我们可以'],
  [/\bWe need to\b/gi, '我们需要'], [/\bLet's\b/gi, '让我们'],
  [/\bActually\b/gi, '实际上'], [/\bMaybe\b/gi, '也许'],
  [/\bProbably\b/gi, '可能'], [/\bDefinitely\b/gi, '肯定'],
];

function _chinesePostProcess(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  for (const [pattern, replacement] of EN_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ── Helpers ──

function _cleanHistory(messages) {
  return messages.map(m => {
    const { images, _previewImages, ...rest } = m;
    return rest;
  });
}

function _detectLoop(toolCallHistory, toolName, toolArgs) {
  const callKey = `${toolName}:${JSON.stringify(toolArgs, Object.keys(toolArgs).sort())}`;
  toolCallHistory.push(callKey);
  if (toolCallHistory.length >= 3) {
    const last3 = toolCallHistory.slice(-3);
    if (last3[0] === last3[1] && last3[1] === last3[2]) return true;
  }
  return false;
}

// ── 单工具执行 ──
async function _executeSingleTool(tc, { lcMessages, toolCallHistory, toolFailCount, toolMap, approvalTools, waitApproval, sendEvent, roundNum }) {
  const toolName = tc.name;
  const toolArgs = tc.args || {};

  if (_detectLoop(toolCallHistory, toolName, toolArgs)) {
    lcMessages.push({ role: 'tool', tool_call_id: tc.id, content: '检测到重复调用，请换一种方法完成任务。' });
    return;
  }

  sendEvent('agent_action', { tool: toolName, input: toolArgs, round: roundNum });

  if (approvalTools.has(toolName)) {
    const approved = await waitApproval(toolName, toolArgs);
    if (!approved) { lcMessages.push({ role: 'tool', tool_call_id: tc.id, content: '用户拒绝执行此操作' }); return; }
  }

  if ((toolFailCount.get(toolName) || 0) >= 2) {
    lcMessages.push({ role: 'tool', tool_call_id: tc.id, content: '该工具已连续失败多次，已被禁用。' });
    return;
  }

  let resultStr;
  const toolExec = toolMap.get(toolName);
  log.log(`工具调用: ${toolName}(${JSON.stringify(toolArgs).slice(0, 200)})`);
  if (!toolExec) {
    resultStr = `工具 '${toolName}' 不存在`;
  } else {
    try {
      const result = await toolExec.invoke(toolArgs);
      if (result == null || result === '') resultStr = '工具执行完毕（无输出）';
      else if (typeof result === 'string') resultStr = result.length > MAX_RESULT_CHARS ? result.slice(0, MAX_RESULT_CHARS) + `\n\n[... 已截断，共 ${result.length} 字符，剩余 ${result.length - MAX_RESULT_CHARS} 字符]` : result;
      else { resultStr = JSON.stringify(result) || '工具执行完毕'; if (resultStr.length > MAX_RESULT_CHARS) resultStr = resultStr.slice(0, MAX_RESULT_CHARS) + '\n\n[... JSON 截断]'; }
    } catch (err) { resultStr = `工具执行出错: ${err.message}`; }
  }

  const failPatterns = [/^工具执行出错:/, /^命令执行失败/, /^文件读取失败:/, /^文件写入失败:/, /^搜索.*时遇到网络问题/, /^网页抓取失败:/, /^记忆(存储|搜索)失败:/];
  if (failPatterns.some(p => p.test(resultStr))) {
    toolFailCount.set(toolName, (toolFailCount.get(toolName) || 0) + 1);
    if ((toolFailCount.get(toolName) || 0) >= 2) resultStr += '\n该工具已被禁用，请不要再调用。';
  }

  sendEvent('agent_observation', { tool: toolName, content: resultStr.slice(0, MAX_OBSERVATION_CHARS), round: roundNum });
  lcMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
}

// ── spawn_agent 执行 ──
async function _executeSubAgent(tc, { config, sendEvent }) {
  const toolArgs = tc.args || {};
  const instruction = toolArgs.instruction || '请执行任务';
  const toolsWhitelist = Array.isArray(toolArgs.tools) ? toolArgs.tools : null;

  try {
    return await runSubAgent({
      config,
      instruction,
      toolsWhitelist,
      sendEvent: (type, data) => {
        if (type === 'reasoning_chunk') sendEvent('reasoning_chunk', data);
      },
    });
  } catch (err) {
    return `子 Agent 执行异常: ${err.message}`;
  }
}

function _getLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i];
  }
  return null;
}

function _hasImages(messages) {
  const lastUser = _getLastUserMessage(messages);
  return !!(lastUser?.images?.length);
}

// ── Phase 1: Thinking ──

async function _runThinkingPhase(llm, userText, sendEvent, hasImages = false) {
  log.log('思考阶段开始...');
  const messages = [
    { role: 'system', content: _thinkingPrompt(hasImages) },
    { role: 'user', content: userText || '请分析' },
  ];

  let fullText = '';

  try {
    for await (const chunk of llm.stream(messages)) {
      if (chunk.reasoning) {
        sendEvent('reasoning_chunk', { content: _chinesePostProcess(chunk.reasoning) });
      }
      if (chunk.content) {
        fullText += chunk.content;
        sendEvent('reasoning_chunk', { content: _chinesePostProcess(chunk.content) });
      }
    }
  } catch (err) {
    log.error(`思考阶段异常: ${err.message}`);
    sendEvent('reasoning_chunk', { content: `\n(思考过程出错: ${err.message})\n` });
    return '';
  }

  const result = fullText.trim();
  log.log(`思考阶段完成: ${result.length} 字`);
  return result;
}

// ── Phase 2: Answer (ReAct) ──

async function _runAnswerPhase({
  llm,
  config,
  history,
  lastUserText,
  visionResult,
  memoryStore,
  sendEvent,
  waitApproval,
  tTotalStart,
  hadImages,
  chatMode = 'chat',
}) {
  if (!lastUserText && !visionResult) {
    sendEvent('done', { content: '请发送消息' });
    return;
  }

  // Build conversation messages
  // L1+L2+L4 系统提示词始终注入，agent 人格提示词附加在后面
  let agentName = config?.agentName || 'Sonder';
  if (!config?.agentName) {
    try {
      const { getAgentManager } = await import('./agent-manager.js');
      const mgr = getAgentManager();
      const active = mgr.getActiveAgent();
      if (active?.name) agentName = active.name;
    } catch (e) { log.warn('获取活跃 Agent 名字失败:', e.message); }
  }
  const assembledPrompt = await _defaultSystemPrompt(chatMode, agentName);
  // 注入用户上下文（昵称 + 时间感知）
  const nickname = config?.userNickname || '';
  const now = new Date();
  const hour = now.getHours();
  const timeCtx = hour >= 23 || hour < 6 ? '现在是深夜，语气温柔安静' : hour < 9 ? '现在是清晨' : hour < 12 ? '现在是上午' : hour < 18 ? '现在是下午' : '现在是晚上';
  const userCtx = nickname ? `\n\n## 当前上下文\n用户叫「${nickname}」。${timeCtx}（${now.toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'})}）。用合适的语气和用户交流。` : '';
  const promptWithCtx = assembledPrompt + userCtx;
  const hasExistingSystem = history.some(m => m.role === 'system');
  // 用模块级常量
  const lcMessages = hasExistingSystem
    ? [
        {
          role: 'system',
          content: (promptWithCtx + '\n\n' + history.filter(m => m.role === 'system').map(m => m.content).join('\n\n')).slice(0, MAX_SYSTEM_CHARS),
        },
        ...history.filter(m => m.role !== 'system').slice(0, -1),  // 排除最后一条用户消息，避免与 line 186 重复
      ]
    : [{ role: 'system', content: promptWithCtx.slice(0, MAX_SYSTEM_CHARS) }];

  // Inject runtime model info into system message
  const modelInfo = `\n\n[运行环境]\n当前模型: ${config?.provider || 'unknown'} / ${config?.model || 'unknown'}\n软件: Sonder (Electron + Node.js Server)`;
  if (lcMessages[0]?.role === 'system') {
    const sysContent = lcMessages[0].content + modelInfo;
    lcMessages[0] = { ...lcMessages[0], content: sysContent.length > MAX_SYSTEM_CHARS + 1000 ? sysContent.slice(0, MAX_SYSTEM_CHARS + 1000) : sysContent };
  }

  // Inject vision results
  let visionSensitive = [];
  if (visionResult) {
    const summary = visionResult.summary_text || '';
    const structured = visionResult.results || [];
    visionSensitive = visionResult.sensitive_hits || [];

    const parts = [summary];
    for (const r of structured) {
      if (r.status === 'timeout' || r.status === 'error') continue;
      const detail = r.detail || '';
      const ocr = r.ocr_text || [];
      const objects = r.objects || [];
      const quality = r.quality || '';
      if (detail) parts.push(`画面细节: ${detail.slice(0, 200)}`);
      if (ocr.length) parts.push(`图中文字: ${ocr.slice(0, 8).join('; ')}`);
      if (objects.length) parts.push(`识别物体: ${objects.slice(0, 10).join(', ')}`);
      if (quality === 'blurry') parts.push('(注意: 图片较模糊)');
    }
    const visionNote = parts.join('\n');
    lcMessages.push({
      role: 'user',
      content: `[图片分析结果]\n${visionNote}\n\n[用户消息]: ${lastUserText || '请分析这张图片'}`,
    });
  }

  // Inject conversation history (skip if personality already includes full history)
  if (!hasExistingSystem) {
    const cleaned = _cleanHistory(history);
    for (const msg of cleaned.slice(0, -1)) {
      if (!msg.content || typeof msg.content !== 'string' || !msg.content.trim()) continue;
      if (msg.role === 'user') lcMessages.push({ role: 'user', content: msg.content });
      else if (msg.role === 'assistant') lcMessages.push({ role: 'assistant', content: msg.content });
    }
  }

  // Fallback when no vision result
  if (!visionResult) {
    if (hadImages) {
      lcMessages.push({
        role: 'user',
        content: `[系统提示: 图片分析暂时不可用，请仅根据文字消息回答]\n\n[用户消息]: ${lastUserText || '请分析这张图片'}`,
      });
    } else {
      lcMessages.push({ role: 'user', content: lastUserText || '' });
    }
  }

  // Memory retrieval
  const searchQuery = lastUserText || '分析这张图片';
  if (memoryStore && memoryStore.count() > 0) {
    try {
      const memories = memoryStore.search(searchQuery, 3);
      if (memories.length > 0) {
        const ctx = '以下是之前记住的关于用户的信息:\n' +
          memories.map((m, i) => `${i + 1}. ${typeof m === 'string' ? m : m.fact || m.content || ''}`).join('\n');
        lcMessages.splice(1, 0, { role: 'user', content: `[系统提示] ${ctx}` });
      }
    } catch (err) {
      log.warn(`记忆检索失败: ${err.message}`);
    }
  }

  // ── Knowledge base injection ──
  try {
    const userText = lastUserText || '';
    // Only search if user message is substantial (>10 chars) and looks like a question/factual query
    if (userText.length > 10 && !userText.match(/^(你好|嗨|hi|hello|谢谢|晚安|早安|再见|拜拜|ok|好|嗯|哦)$/i)) {
      // 复用 kb-tools 的共享检索器（已有索引数据），而非新建空实例
      const { getRetriever, getSchema } = await _getKBShared();
      const retriever = getRetriever();
      const kbResults = await retriever.search(userText, { topK: 3 });
      if (kbResults && kbResults.length > 0) {
        // 只打开一次数据库，批量查所有结果
        const schema = await getSchema();
        const db = schema.db;
        const stmt = db.prepare('SELECT content FROM chunks WHERE id = ?');
        const contexts = [];
        for (const r of kbResults) {
          try {
            stmt.bind([r.id || r.chunkId]);
            if (stmt.step()) {
              const [content] = stmt.get();
              if (content) contexts.push(content.slice(0, 300));
            }
            stmt.reset();
          } catch (e) { log.warn('操作失败', e?.message || e); }
        }
        stmt.free();
        if (contexts.length > 0) {
          const kbContext = '\n\n[知识库参考]\n' + contexts.map((c, i) => `[${i + 1}] ${c}`).join('\n');
          if (lcMessages[0]?.role === 'system') {
            lcMessages[0] = { ...lcMessages[0], content: lcMessages[0].content + kbContext };
          }
        }
      }
    }
  } catch (err) {
    // KB injection fails silently — don't block the conversation
  }

  // Load tools
  let tools = [];
  let toolMap = new Map();
  let approvalTools = new Set(['execute_command']);
  try {
    const toolsMod = await _getToolsModule();
    tools = toolsMod.getAllTools();
    toolMap = new Map(tools.map(t => [t.name, t]));
    log.log(`已加载 ${tools.length} 个工具:`, tools.map(t => t.name).join(', '));
  } catch (err) {
    log.warn(`工具加载失败: ${err.message}`);
  }

  const isClaude = (config?.provider || 'claude') === 'claude';
  const formattedTools = isClaude ? toAnthropicTools(tools) : toOpenAITools(tools);
  const toolCallHistory = [];
  const toolFailCount = new Map();

  log.log('正式阶段开始');
  const tAnswerStart = Date.now();

  // 工具贪婪检测计数器：连续无文字输出的工具轮数
  let toolOnlyStreak = 0;

  for (let roundNum = 1; roundNum <= MAX_ANSWER_ROUNDS; roundNum++) {
    const tRound = Date.now();

    // 强制产出保护: 连续 N 轮只调工具不输出文字 → 下一轮卸掉工具
    const stripTools = toolOnlyStreak >= TOOL_ONLY_LIMIT || roundNum >= MAX_ANSWER_ROUNDS - 1;
    if (stripTools) {
      lcMessages.push({
        role: 'user',
        content: toolOnlyStreak >= TOOL_ONLY_LIMIT
          ? `[系统] 你已经连续调了 ${toolOnlyStreak} 次工具还没输出文字。现在禁止再调工具，直接基于已有信息给出答案。`
          : `[系统] 你只剩 ${MAX_ANSWER_ROUNDS - roundNum + 1} 轮了。禁止再调工具，直接给出最终答案。`,
      });
    }

    // Filter messages with null/undefined content (but keep assistant messages with tool_calls)
    const validMessages = lcMessages.filter(m => m.content != null || m.tool_calls?.length);

    let accumulatedContent = '';
    let hasStreamed = false;
    let finalToolCalls = null;
    let finalUsage = null;

    let roundTimer = null;
    let totalTimer = null;
    try {
      const roundAbort = new AbortController();
      // 总超时 120s，超过直接中断
      totalTimer = setTimeout(() => roundAbort.abort(), 180_000);
      const resetSilenceTimer = () => {
        if (roundTimer) clearTimeout(roundTimer);
        roundTimer = setTimeout(() => roundAbort.abort(), 45_000); // 45s 无新 chunk 则超时
      };
      resetSilenceTimer(); // 首个 chunk 前就开始计时
      for await (const chunk of llm.stream(validMessages, { tools: stripTools ? [] : formattedTools, signal: roundAbort.signal })) {
        resetSilenceTimer(); // 每收到一个 chunk 重置静默计时（30s 无数据则超时）
        if (chunk.reasoning) {
          sendEvent('reasoning_chunk', { content: _chinesePostProcess(chunk.reasoning) });
        }
        if (chunk.content) {
          hasStreamed = true;
          const filteredChunk = _chinesePostProcess(chunk.content);
          accumulatedContent += filteredChunk;
          sendEvent('chunk', { content: filteredChunk });
        }
        if (chunk.toolCalls) finalToolCalls = chunk.toolCalls;
        if (chunk.usage) finalUsage = chunk.usage;
      }
    } catch (err) {
      if (roundTimer) clearTimeout(roundTimer);
      if (totalTimer) clearTimeout(totalTimer);
      // 超时/中断 → 有内容直接输出，无内容走兜底 fallback
      if (err.name === 'AbortError') {
        if (accumulatedContent?.trim()) {
          sendEvent('chunk', { content: '\n\n(响应超时，以下是已有内容)\n' });
          sendEvent('done', { content: accumulatedContent.trim() });
          return;
        }
        // 无内容 → 跳出循环，后续 fallback 代码会处理
        break;
      }
      sendEvent('error', { content: `LLM 调用失败(第${roundNum}轮): ${err.message}` });
      return;
    }
    if (roundTimer) clearTimeout(roundTimer);
    if (totalTimer) clearTimeout(totalTimer);

    if (!hasStreamed && accumulatedContent) {
      sendEvent('chunk', { content: accumulatedContent });
    }

    if (finalToolCalls?.length) {
      // Fix tool call IDs if missing (streaming APIs may not provide them)
      const fixedCalls = finalToolCalls.map((tc, i) => ({
        ...tc,
        id: tc.id || `tc_${roundNum}_${i}_${Date.now()}`,
      }));

      // Push assistant message with tool_calls BEFORE tool results (API requirement)
      lcMessages.push({
        role: 'assistant',
        content: accumulatedContent || null,
        tool_calls: fixedCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args) },
        })),
      });

      // 如果第一轮有确认语（如"好的我来搜"），先推给前端播放
      // 限制 150 字，避免 TTS 消耗过大
      if (roundNum === 1 && accumulatedContent?.trim()) {
        const ack = accumulatedContent.trim();
        const shortAck = ack.length > MAX_ACK_CHARS ? ack.slice(0, MAX_ACK_CHARS).replace(/[^。！？.!?]*$/, '') + '。' : ack;
        sendEvent('speak', { content: shortAck, round: roundNum });
      }

      // ── 分离 spawn_agent 和普通工具调用 ──
      const spawnCalls = [];
      const regularCalls = [];
      for (const tc of fixedCalls) {
        if (tc.name === 'spawn_agent') spawnCalls.push(tc);
        else regularCalls.push(tc);
      }

      // 先执行普通工具（顺序）
      for (const tc of regularCalls) {
        await _executeSingleTool(tc, { lcMessages, toolCallHistory, toolFailCount, toolMap, approvalTools, waitApproval, sendEvent, roundNum });
      }

      // 并行执行所有 spawn_agent
      if (spawnCalls.length > 0) {
        log.log(`并行执行 ${spawnCalls.length} 个子 Agent`);
        const spawnResults = await Promise.allSettled(
          spawnCalls.map(tc => _executeSubAgent(tc, { config, sendEvent }))
        );
        for (let i = 0; i < spawnCalls.length; i++) {
          const tc = spawnCalls[i];
          const r = spawnResults[i];
          const content = r.status === 'fulfilled' ? r.value : `子 Agent 执行失败: ${r.reason?.message || '未知错误'}`;
          sendEvent('agent_observation', { tool: 'spawn_agent', content: content.slice(0, 500), round: roundNum });
          lcMessages.push({ role: 'tool', tool_call_id: tc.id, content });
        }
      }

      log.log(`第${roundNum}轮工具完成 (${(Date.now() - tRound) / 1000}s)`);
      // 更新工具贪婪计数器：有文字输出 → 重置，纯工具 → 递增
      toolOnlyStreak = accumulatedContent?.trim() ? 0 : toolOnlyStreak + 1;
      continue;
    }

    // Final answer
    let finalText = String(accumulatedContent || '');
    // 确保 NOW_PLAYING / MUSIC_LIST 标签原样保留（LLM 可能会吃掉）
    try {
      for (let j = lcMessages.length - 1; j >= 0; j--) {
        const tm = lcMessages[j];
        if (tm.role === 'tool' && typeof tm.content === 'string') {
          if (tm.content.includes('NOW_PLAYING')) {
            // 强制追加 NOW_PLAYING（无论 LLM 是否已包含）
            const npText = tm.content.match(/NOW_PLAYING\s*\{[\s\S]*?\}/)?.[0];
            if (npText && !finalText.includes(npText.slice(0, 50))) {
              finalText = finalText.trim() + '\n\n' + npText;
              log.log('NOW_PLAYING 已追加到回复');
            }
          }
          if (tm.content.includes('MUSIC_LIST')) {
            // 强制追加完整的 MUSIC_LIST JSON（无论 LLM 是否已包含）
            const mlMatch = tm.content.match(/MUSIC_?LIST\s*(\[[\s\S]*?\])/);
            if (mlMatch) {
              const mlText = 'MUSIC_LIST ' + mlMatch[1];
              if (!finalText.includes(mlMatch[1].slice(0, 30))) {
                finalText = finalText.trim() + '\n' + mlText;
                log.log('MUSIC_LIST 已追加到回复');
              }
            }
          }
          // 音乐控制标记：MUSIC_PAUSE / MUSIC_STOP / MUSIC_RESUME / MUSIC_VOLUME
          const mcMatch = tm.content.match(/^(MUSIC_(?:PAUSE|STOP|RESUME|VOLUME\s+[\d.]+))/m);
          if (mcMatch) {
            const mcTag = mcMatch[1].trim();
            if (!finalText.includes(mcTag)) {
              finalText = finalText.trim() + '\n' + mcTag;
              log.log(`${mcTag} 已追加到回复`);
            }
          }
        }
      }
    } catch (e) { log.warn(`音乐指令注入失败: ${e.message}`); }
    // 纯 NOW_PLAYING 无文字时补默认文本
    if (!finalText.trim() || /^\s*NOW_PLAYING\s*\{/.test(finalText.trim())) {
      finalText = '正在为你播放…\n\n' + finalText.trim();
    }
    const tTotal = (Date.now() - tTotalStart) / 1000;
    log.log(`总耗时=${tTotal}s | answer=${(Date.now() - tAnswerStart) / 1000}s/第${roundNum}轮`);

    sendEvent('done', { content: finalText.trim() });

    // Memory extraction after conversation
    if (memoryStore && history.length >= 2) {
      try {
        log.log(`[记忆] 提取开始, history=${history.length}条, memoryStore有addFact=${!!memoryStore.addFact}`);
        const countBefore = memoryStore.count?.() ?? -1;
        log.log(`[记忆] 提取前 FactStore 行数: ${countBefore}`);
        const result = await _extractAndRemember(history, config, memoryStore);
        const countAfter = memoryStore.count?.() ?? -1;
        log.log(`[记忆] 提取后 FactStore 行数: ${countAfter} (新增 ${countAfter - countBefore})`);
        if (result && result.factsText) {
          sendEvent('memory_updated', {
            content: result.factsText,
            interactionType: result.interactionType,
          });
          log.log(`记忆已提取(${result.interactionType}): ${result.factsText.slice(0, 120)}`);
        } else {
          log.log('记忆提取: 本轮无新事实（facts为空或提取失败）');
        }
      } catch (err) {
        log.error(`记忆提取失败: ${err.message}`, err.stack);
      }
    } else {
      log.log(`[记忆] 跳过提取: memoryStore=${!!memoryStore} history.length=${history.length}`);
    }

    return;
  }

  // Fallback: max rounds reached
  log.log('正式阶段达到最大轮数，兜底回答');
  // 如果最后一轮工具返回了 NOW_PLAYING，直接透传
  for (let i = lcMessages.length - 1; i >= 0; i--) {
    const m = lcMessages[i];
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.includes('NOW_PLAYING')) {
      const match = m.content.match(/NOW_PLAYING\s*(\{[\s\S]*?\})/);
      if (match) {
        try {
          const song = JSON.parse(match[1]);
          // 也附带 MUSIC_LIST（如果推荐了多首）
          let mlPart = '';
          for (let k = lcMessages.length - 1; k >= 0; k--) {
            const km = lcMessages[k];
            if (km.role === 'tool' && typeof km.content === 'string' && km.content.includes('MUSIC_LIST')) {
              const ml = km.content.match(/MUSIC_?LIST\s*(\[[\s\S]*?\])/);
              if (ml) { mlPart = '\nMUSIC_LIST ' + ml[1]; break; }
            }
          }
          const text = '正在为你播放…\n\n' + match[0] + mlPart;
          sendEvent('done', { content: text });
          log.log(`兜底透传 play_music: ${song.name}`);
          return;
        } catch (e) {
          log.warn(`NOW_PLAYING JSON 解析失败: ${e.message}`);
          // 继续走到 LLM 兜底回答
          break;
        }
      }
    }
  }
  try {
    const llmNoTools = createLLM({ ...config, timeout: 15000, maxTokens: MAX_FALLBACK_TOKENS });
    // 过滤掉 tool 消息和带 tool_calls 的 assistant 消息，只保留纯文本对话
    const cleanMessages = lcMessages
      .filter(m => m.role !== 'tool' && !m.tool_calls?.length)
      .slice(-6);
    const lcMessagesNoTools = [
      ...cleanMessages,
      { role: 'user', content: '请基于已有信息用一句话直接回答，不超过50字。' },
    ];
    let finalText = '';
    for await (const chunk of llmNoTools.stream(lcMessagesNoTools)) {
      if (chunk.content) {
        const filtered = _chinesePostProcess(chunk.content);
        finalText += filtered;
        sendEvent('chunk', { content: filtered });
      }
    }
    log.log(`兜底回答完成: ${finalText.length} 字`);
    sendEvent('done', { content: finalText.trim() || '抱歉，处理时间有点长，请再说一次？' });
  } catch (err) {
    sendEvent('error', { content: `兜底回答失败: ${err.message}` });
  }
}

// ── Memory extraction ──
// ── 冲突事件发送 (供前端 UI 展示) ──
let _conflictCallback = null;
export function onMemoryConflict(cb) { _conflictCallback = cb; }

// ── 敏感信息正则 ──
const SENSITIVE_PATTERNS = [
  /\d{15}(\d{2}[0-9Xx])?/,            // 身份证
  /\d{16,19}/,                         // 银行卡
  /1[3-9]\d{9}/,                       // 手机号
  /密码[是:：]\s*\S+/i,               // 密码
  /(password|passwd|pwd)\s*[=:：]\s*\S+/i,
  /(api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token)\s*[=:：]\s*\S+/i,  // API Key/Token
  /sk-[a-zA-Z0-9]{20,}/,              // OpenAI/DeepSeek API Key
  /(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/,  // GitHub Token
  /[1-9]\d{4,10}@(qq|163|126|sina|sohu|gmail|outlook)\.com/i,
];
function hasSensitive(text) {
  return SENSITIVE_PATTERNS.some(p => p.test(text || ''));
}

async function _extractAndRemember(messages, config, memoryStore) {
  log.log(`[记忆] _extractAndRemember 开始, messages=${messages.length}条`);
  if (!messages || messages.length < 2) {
    log.log('[记忆] 跳过: messages不足2条');
    return { factsText: '', interactionType: 'casual_chat' };
  }

  // 敏感信息检测
  const rawText = messages.map(m => m.content || '').join(' ');
  if (hasSensitive(rawText)) {
    log.warn('[记忆] 检测到敏感信息，跳过记忆存储');
    return { factsText: '', interactionType: 'casual_chat' };
  }

  // 调用多维提取器（一次 LLM 调用，三个维度）
  const extractConfig = { ...config, temperature: 0.1, maxTokens: 512 };
  // 获取已有事实，传给提取器避免重复提取
  let existingFacts = [];
  try { existingFacts = memoryStore.getAll?.() || []; } catch (e) { log.warn('[记忆] 获取已有事实失败:', e.message); }
  log.log(`[记忆] 准备调 extractMemories, provider=${extractConfig.provider}, model=${extractConfig.model}, hasApiKey=${!!extractConfig.apiKey}, existingFacts=${existingFacts.length}条`);
  const { facts, interactionType } = await extractMemories(messages, extractConfig, existingFacts);
  log.log(`[记忆] extractMemories 返回: facts=${facts?.length || 0}条, interactionType=${interactionType}`);

  if (!facts || facts.length === 0) {
    return { factsText: '', interactionType: interactionType || 'casual_chat' };
  }

  const stored = [];
  const conflicts = [];
  for (const f of facts) {
    const ft = f.text || String(f);
    if (!ft || ft.length < 2) continue;
    const importance = Math.max(0, Math.min(1, f.importance || 0.5));
    const tags = f.tags || [];
    if (f.dimension) tags.push(f.dimension);

    let blocked = false;
    if (memoryStore.search && memoryStore.addFact) {
      // 用事实维度和关键词做冲突检测（不只是字符串前缀匹配）
      const searchKey = f.dimension ? `${f.dimension} ` : '';
      const existing = memoryStore.search(searchKey + ft.slice(0, 15), 5);
      const factLower = ft.toLowerCase();
      // 提取关键实体词（"称呼"、"名字"、"住在"等）
      const topicWords = ['称呼', '名字', '叫', '住在', '喜欢', '讨厌', '工作', '职业', '过敏'];
      const factTopic = topicWords.find(w => factLower.includes(w)) || '';
      const similar = existing.find(e => {
        const ef = (e.fact || e || '').replace(/\s/g, '');
        const nf = ft.replace(/\s/g, '');
        // 同维度 + 同主题 → 可能冲突
        const sameDim = f.dimension && (e.tags || []).includes(f.dimension);
        const sameTopic = factTopic && (ef.includes(factTopic) || nf.slice(0, 4) === ef.slice(0, 4));
        return ef && nf && (sameDim || sameTopic || ef.includes(nf.slice(0, 4)) || nf.includes(ef.slice(0, 4)));
      });
      if (similar && (similar.confidence || 0.5) > 0.5 && importance < 0.95) {
        conflicts.push({ old: similar.fact || similar, new: ft, action: 'blocked' });
        blocked = true;
        log.log(`[记忆] 冲突阻止: "${ft}" (dim=${f.dimension}) — 已有: "${similar.fact?.slice(0,40)}"`);
      }
    }

    if (!blocked && memoryStore.addFact) {
      try {
        const beforeCount = memoryStore.count?.() ?? 0;
        memoryStore.addFact(ft, tags, {
          confidence: importance,
          half_life_days: importance > 0.8 ? 365 : importance > 0.5 ? 90 : 30,
          source: 'auto_extracted',
          extracted_at: new Date().toISOString(),
        });
        const afterCount = memoryStore.count?.() ?? 0;
        log.log(`[记忆] 已存储(${afterCount - beforeCount}): "${ft}" dim=${f.dimension} imp=${importance} tags=[${tags}]`);
      } catch (e) {
        log.error(`[记忆] addFact 失败: "${ft}" — ${e.message}`);
      }
    }
    stored.push(ft);
  }

  // 反馈冲突给用户
  if (conflicts.length > 0) {
    log.log(`[记忆] 冲突检测: ${conflicts.length} 条`);
    for (const c of conflicts) {
      log.log(`[记忆]   冲突: 旧="${c.old?.slice(0,40)}" ←→ 新="${c.new?.slice(0,40)}" — ${c.action}`);
    }
    // 发送冲突事件给前端 UI
    if (_conflictCallback) {
      try { _conflictCallback(conflicts); } catch (e) { log.warn('操作失败', e?.message || e); }
    }
  }
  log.log(`addFact called: ${stored.length} 条, importance ${facts.map(f=>f.importance?.toFixed(1)||'0.5').join(',')}`);

  return { factsText: stored.join('\n'), interactionType: interactionType || 'casual_chat' };
}

// 情境事件提取已移至 server/index.js post-chat

/**
 * 确保 MemoryManager 的巩固器已注入 LLM（lazy 注入，首次运行时触发）
 * 避免 index.js 异步注入和 agent.js afterTurn 之间的竞争
 */
async function _ensureConsolidatorLLM(memoryManager, config) {
  const c = memoryManager.consolidator;
  if (!c) return;
  if (c._llm) return;
  const apiKey = config?.apiKey;
  const provider = config?.provider || 'deepseek';
  if (!apiKey) { log.warn('[consolidator] 缺少 API Key，偏好归纳将跳过'); return; }
  try {
    const { createLLM } = await import('./llm-client.js');
    c.setLlm(async (prompt) => {
      const llm = createLLM({
        provider,
        model: 'deepseek-chat',
        apiKey,
        temperature: 0.3,
        maxTokens: 200,
        thinkingType: 'disabled',
      });
      const { content } = await llm.invoke([{ role: 'user', content: prompt }]);
      return content?.trim() || '';
    });
    log.log('[consolidator] LLM 已注入 (from agent.js)');
  } catch (e) {
    log.warn(`[consolidator] LLM 注入失败: ${e?.message || e}`);
  }
}

// ── Main entry ──

export async function runAgent({
  config,
  messages,
  convId,
  memoryStore,
  ragPipeline,
  sendEvent,
  waitApproval,
  memoryManager,       // MemoryManager 实例 (可选)
  userProfile,         // UserProfile 实例 (可选)
  chatMode = 'chat',   // 聊天模式: chat/voice/group
}) {
  const tTotalStart = Date.now();

  // Get last user message (must be before LLM creation for dynamic reasoning effort)
  const lastUserMsg = _getLastUserMessage(messages);
  const rawUserText = lastUserMsg?.content || '';
  // 动态追加中文后缀：对用户透明，强制模型用中文思考
  const LANG_SUFFIX = '\n\n[系统指令：请严格使用简体中文进行所有内部思考和最终回答。禁止输出英文单词或句子，专有名词除外。]';
  const userText = rawUserText + LANG_SUFFIX;
  // 同步修改 messages 中的最后一条用户消息，确保传入 LLM 的消息也带后缀
  if (lastUserMsg) lastUserMsg.content = userText;
  const hadImages = _hasImages(messages);

  // ═══ 三模式共享注入（FD语音 + 旧语音 + 文字聊天 都走这里）═══

  // 1. 共享上下文：注入来自其他模式的对话历史
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const persistDir = process.env.AGENT_PERSIST_DIR || path.join(os.homedir(), '.ai-desktop-pet');
    const sharedFile = path.join(persistDir, 'shared_history.json');
    if (fs.existsSync(sharedFile)) {
      const shared = JSON.parse(fs.readFileSync(sharedFile, 'utf-8'));
      const voiceHistory = (shared.history || []).slice(-10);
      if (voiceHistory.length > 0) {
        const seen = new Set(messages.map(m => `${m.role}:${(m.content||'').slice(0,40)}`));
        const newMsgs = voiceHistory.filter(m => !seen.has(`${m.role}:${(m.content||'').slice(0,40)}`));
        if (newMsgs.length > 0) {
          messages.unshift(...newMsgs);
        }
      }
    }
  } catch (e) { /* 静默，不影响主流程 */ }

  // 2. 音乐意图检测：涉及音乐操作时强制注入工具调用指令
  const musicIntentRe = /放[首首歌]|换[首首歌]|切[首首歌]|来[首首歌]|听[首首歌]|播[放首]|音乐|想听|上一首|下一首|不[想喜]听|这首歌|这歌|这首|来首/;
  if (musicIntentRe.test(rawUserText)) {
    messages.push({
      role: 'system',
      content: '[系统指令] 用户刚才的消息涉及音乐操作（播放/切歌/换歌）。你必须调用 recommend_music、play_music、search_music 或 play_similar 工具来实际执行，不能只口头回复。绝对不要只说"好的给你换了"但不调工具。先调工具拿到 NOW_PLAYING，再用一句话告诉用户结果。',
    });
  }

  // Create LLM
  let llm;
  try {
    // 推理力度：auto → 动态选择，手动值直接透传
    if (!config.reasoningEffort || config.reasoningEffort === 'auto') {
      const dynEffort = _chooseReasoningEffort(userText, 'auto');
      config = { ...config, reasoningEffort: dynEffort };
      log.log(`推理力度(auto→动态): ${dynEffort}`);
    } else {
      log.log(`推理力度(手动): ${config.reasoningEffort}`);
    }
    log.log(`LLM 创建: provider=${config.provider} model=${config.model}`);
    llm = createLLM(config);
    log.log(`LLM 创建成功: provider=${config.provider} model=${config.model}`);
  } catch (err) {
    sendEvent('error', { content: `创建 LLM 失败: ${err.message}` });
    return;
  }

  // ── Memory injection (Phase 3) — 合并为一次系统消息拼接 ──
  let _injectedMessages = messages;
  try {
    const nickname = config?.userNickname || config?.user_name || userProfile?.nickname || '';
    if (memoryManager) {
      const { injectMemoryContext, setLLMConfig } = await import('../memory/inject.js');
      // 设置 LLM 配置供 buildProfileSummary 使用
      if (nickname && config?.apiKey) {
        setLLMConfig({
          provider: config?.provider || 'deepseek',
          apiKey: config?.apiKey,
          baseUrl: config?.baseUrl || '',
        });
      }
      _injectedMessages = await injectMemoryContext(messages, memoryManager, userText, nickname);
    }
    // Collect all injection blocks
    const blocks = [
      userProfile?.formatForLLM(),
      nickname ? `[用户称呼] 用户希望你称呼他为/她为「${nickname}」。在所有回复中使用这个称呼。` : null,
    ].filter(Boolean);

    if (blocks.length > 0) {
      const sysIdx = _injectedMessages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) {
        _injectedMessages[sysIdx] = {
          ..._injectedMessages[sysIdx],
          content: _injectedMessages[sysIdx].content + '\n\n' + blocks.join('\n\n'),
        };
      }
    }

    // ── 背景感知预加载 (Stage 3) ──
    try {
      if (memoryManager && userProfile) {
        const { preloadContext } = await import('./preload.js');
        const bgContext = await preloadContext(memoryManager, userProfile);
        if (bgContext) {
          const sysIdx2 = _injectedMessages.findIndex(m => m.role === 'system');
          if (sysIdx2 >= 0) {
            _injectedMessages[sysIdx2] = {
              ..._injectedMessages[sysIdx2],
              content: _injectedMessages[sysIdx2].content + '\n\n' + bgContext,
            };
          }
        }
      }
    } catch (bgErr) {
      // 预加载失败静默降级，不影响对话
    }
  } catch (err) {
    log.warn(`记忆/画像注入失败: ${err.message}`);
  }
  messages = _injectedMessages;

  if (hadImages) {
    const imgs = lastUserMsg.images;

    // Start vision analysis (Phase 1a) and thinking (Phase 1b) in parallel
    let visionResult = null;
    const skipThinking = config?.reasoningEffort === 'none';

    try {
      const visionMod = await _getVisionModule();
      const visionPromise = visionMod.analyzeImages(imgs, userText, config);

      // Start thinking concurrently (skip if user turned off reasoning)
      const thinkingPromise = skipThinking
        ? Promise.resolve('')
        : _runThinkingPhase(llm, userText, sendEvent, true);

      // Wait for both
      const [vis, thinkingText] = await Promise.allSettled([visionPromise, thinkingPromise]);

      if (vis.status === 'fulfilled') {
        visionResult = vis.value;
      } else {
        log.error(`视觉分析失败: ${vis.reason?.message}`);
        sendEvent('reasoning_chunk', { content: `\n⚠️ 图片分析失败: ${vis.reason?.message}\n` });
      }
    } catch (err) {
      log.error(`视觉分析失败: ${err.message}`);
      if (!skipThinking) await _runThinkingPhase(llm, userText, sendEvent, true);
    }

    await _runAnswerPhase({
      llm, config, history: messages, lastUserText: userText,
      visionResult, memoryStore, sendEvent, waitApproval,
      tTotalStart, hadImages: true, chatMode,
    });
  } else {
    // 纯文字消息：只在 reasoningEffort='max' 时运行思考阶段
    // 简单问题跳过思考，节省延迟（如"设置在哪"/"你能做什么"等导航/能力类问题）
    const isSimpleQuestion = rawUserText && (
      rawUserText.replace(/\s/g, '').length <= 12 ||
      /^(你是谁|你能做什么|现在几点|今天.*日期|.*在哪[里]?[？?]?|怎么.*设置|帮我.*介绍)/.test(rawUserText)
    );
    const skipThinking = config?.reasoningEffort !== 'max' || isSimpleQuestion;
    if (!skipThinking) await _runThinkingPhase(llm, userText, sendEvent, false);
    await _runAnswerPhase({
      llm, config, history: messages, lastUserText: userText,
      visionResult: null, memoryStore, sendEvent, waitApproval,
      tTotalStart, hadImages: false, chatMode,
    });
  }

  // 触发后台记忆巩固（每 N 轮执行一次，非阻塞）
  if (memoryManager?.afterTurn) {
    // 确保巩固器已注入 LLM（首次运行时 lazy 注入）
    _ensureConsolidatorLLM(memoryManager, config).then(() =>
      memoryManager.afterTurn()
    ).catch(e => log.warn(`记忆巩固失败: ${e?.message || e}`));
  }
}

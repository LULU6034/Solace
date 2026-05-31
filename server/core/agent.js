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

const log = createModuleLogger('agent');

const MAX_ANSWER_ROUNDS = 3;
function _thinkingPrompt(hasImages) {
  if (hasImages) {
    return `你是内部推理模块。用户发送了图片，视觉分析正在后台并行进行。

在等待视觉结果的同时，先根据用户文字问题进行预判。如果问题明显涉及图片内容，基于常识猜测可能的情况（标注"猜测"）。2-3 句直击要害。禁止写策略/待办/"我应该先…"等元文本。`;
  }
  return `你是内部推理模块。用户发来了一条文字消息。

直接对用户问题的核心做出判断。2-3 句直击要害。禁止写策略/待办/"我应该先…"等元文本。`;
}

const AGENT_SYSTEM_PROMPT = `你是一个桌面上的智能助手，名字由用户在设置中选择。你的定位是高效、可靠、有温度的 AI 伙伴。

## 关于这个软件
你运行在 **案** 中——一个 Electron + Vue 3 桌面应用。
你以像素形象住在用户的桌面上，通过聊天窗口和用户对话。

## 你的能力
你可以使用各种工具来完成用户的任务，包括:
- 看图片并描述图片里的内容
- 分析文件内容(PDF、Word、代码等)
- 搜索网络信息（Tavily Search API + Bing 降级）
- 读取和写入文件
- 执行终端命令(需用户确认)
- 记住重要信息，以便将来使用
- 搜索之前的记忆
- 与其他宠物 Agent 频道聊天或私信
- 查看天气（通过 weather 插件）

## 关于你的模型
你当前运行的底层模型由用户在设置中配置（如 Claude、DeepSeek、OpenAI 等）。
用户问"你是什么模型"时，诚实地告诉用户：你是案中的 AI 角色，底层模型由用户在设置中选择，你无法知道具体版本。建议用户去设置面板查看。

## 风格要求
- 回复简洁有活力，像朋友聊天一样
- 使用适当的中文表达
- 遇到不会的事情，诚实告诉用户，但可以建议其他方法

## 重要规则
- 一次只调用必要的工具，不要滥用
- 如果某个工具连续失败 2 次，立即停止使用它，直接基于已有知识回答
- 记住用户分享的重要个人信息(如名字、职业、偏好)
- 如果用户发送了图片，请结合图片分析结果进行回答`;

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
        sendEvent('reasoning_chunk', { content: chunk.reasoning });
      }
      if (chunk.content) {
        fullText += chunk.content;
        sendEvent('reasoning_chunk', { content: chunk.content });
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
}) {
  if (!lastUserText && !visionResult) {
    sendEvent('done', { content: '请发送消息' });
    return;
  }

  // Build conversation messages
  // If messages already have a system prompt (from per-agent personality injection), use it
  const hasPersonality = history.some(m => m.role === 'system' &&
    (m.content.includes('我是') || m.content.includes('行为风格')));
  const lcMessages = hasPersonality
    ? [...history]  // Keep personality-injected messages as-is
    : [{ role: 'system', content: AGENT_SYSTEM_PROMPT }];  // Fallback to default

  // Inject runtime model info into system message
  const modelInfo = `\n\n[运行环境]\n当前底层模型: ${config?.provider || 'unknown'} / ${config?.model || 'unknown'}\n软件: 案 (Electron + Node.js Server)`;
  if (lcMessages[0]?.role === 'system') {
    lcMessages[0] = { ...lcMessages[0], content: lcMessages[0].content + modelInfo };
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
  if (!hasPersonality) {
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

  // Load tools
  let tools = [];
  let toolMap = new Map();
  let approvalTools = new Set(['execute_command']);
  try {
    const toolsMod = await import('../lib/tools/index.js');
    tools = toolsMod.getAllTools();
    toolMap = new Map(tools.map(t => [t.name, t]));
  } catch (err) {
    log.warn(`工具加载失败: ${err.message}`);
  }

  const isClaude = (config?.provider || 'claude') === 'claude';
  const formattedTools = isClaude ? toAnthropicTools(tools) : toOpenAITools(tools);
  const toolCallHistory = [];
  const toolFailCount = new Map();

  log.log('正式阶段开始');
  const tAnswerStart = Date.now();

  for (let roundNum = 1; roundNum <= MAX_ANSWER_ROUNDS; roundNum++) {
    const tRound = Date.now();

    // Filter messages with null/undefined content (but keep assistant messages with tool_calls)
    const validMessages = lcMessages.filter(m => m.content != null || m.tool_calls?.length);

    let accumulatedContent = '';
    let hasStreamed = false;
    let finalToolCalls = null;
    let finalUsage = null;

    try {
      for await (const chunk of llm.stream(validMessages, { tools: formattedTools })) {
        if (chunk.reasoning) {
          sendEvent('reasoning_chunk', { content: chunk.reasoning });
        }
        if (chunk.content) {
          hasStreamed = true;
          accumulatedContent += chunk.content;
          sendEvent('chunk', { content: chunk.content });
        }
        if (chunk.toolCalls) finalToolCalls = chunk.toolCalls;
        if (chunk.usage) finalUsage = chunk.usage;
      }
    } catch (err) {
      sendEvent('error', { content: `LLM 调用失败(第${roundNum}轮): ${err.message}` });
      return;
    }

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

      for (const tc of fixedCalls) {
        const toolName = tc.name;
        const toolArgs = tc.args || {};

        if (_detectLoop(toolCallHistory, toolName, toolArgs)) {
          lcMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: '检测到重复调用，请换一种方法完成任务。',
          });
          continue;
        }

        sendEvent('agent_action', { tool: toolName, input: toolArgs, round: roundNum });

        // Approval gate
        if (approvalTools.has(toolName)) {
          const approved = await waitApproval(toolName, toolArgs);
          if (!approved) {
            lcMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: '用户拒绝执行此操作',
            });
            continue;
          }
        }

        // Fail count gate
        if ((toolFailCount.get(toolName) || 0) >= 2) {
          lcMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: '该工具已连续失败多次，已被禁用。',
          });
          continue;
        }

        // Execute tool
        let resultStr;
        const toolExec = toolMap.get(toolName);
        if (!toolExec) {
          resultStr = `工具 '${toolName}' 不存在`;
        } else {
          try {
            const result = await toolExec.invoke(toolArgs);
            if (result == null || result === '') {
              resultStr = '工具执行完毕（无输出）';
            } else if (typeof result === 'string') {
              resultStr = result;
            } else {
              resultStr = JSON.stringify(result) || '工具执行完毕';
            }
          } catch (err) {
            resultStr = `工具执行出错: ${err.message}`;
          }
        }

        // Fail detection — only flag explicit tool error prefixes, not content
        const failPatterns = [
          /^工具执行出错:/, /^命令执行失败/, /^文件读取失败:/, /^文件写入失败:/,
          /^搜索.*时遇到网络问题/, /^网页抓取失败:/, /^记忆(存储|搜索)失败:/,
        ];
        const isToolError = failPatterns.some(p => p.test(resultStr));
        if (isToolError) {
          toolFailCount.set(toolName, (toolFailCount.get(toolName) || 0) + 1);
          if ((toolFailCount.get(toolName) || 0) >= 2) {
            resultStr += '\n该工具已被禁用，请不要再调用。';
          }
        }

        sendEvent('agent_observation', {
          tool: toolName,
          content: resultStr.slice(0, 3000),
          round: roundNum,
        });

        lcMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultStr,
        });
      }

      log.log(`第${roundNum}轮工具完成 (${(Date.now() - tRound) / 1000}s)`);
      continue;
    }

    // Final answer
    const finalText = String(accumulatedContent || '');
    const tTotal = (Date.now() - tTotalStart) / 1000;
    log.log(`总耗时=${tTotal}s | answer=${(Date.now() - tAnswerStart) / 1000}s/第${roundNum}轮`);

    sendEvent('done', { content: finalText.trim() });

    // Memory extraction after conversation
    if (memoryStore && history.length >= 2) {
      try {
        // Create a lightweight LLM for extraction
        const extractLLM = createLLM({ ...config, temperature: 0.3, maxTokens: 512 });
        const extracted = await _extractAndRemember(history, extractLLM, memoryStore);
        if (extracted) {
          sendEvent('memory_updated', { content: extracted });
          log.log(`记忆已存储: ${extracted.slice(0, 80)}`);
        }
      } catch (err) {
        log.error(`记忆提取失败: ${err.message}`);
      }
    }

    return;
  }

  // Fallback: max rounds reached
  log.log('正式阶段达到最大轮数，兜底回答');
  try {
    const llmNoTools = createLLM(config);
    const lcMessagesNoTools = [
      ...lcMessages,
      { role: 'user', content: '请基于以上信息给出完整回答，不要调用工具。' },
    ];
    let finalText = '';
    for await (const chunk of llmNoTools.stream(lcMessagesNoTools)) {
      if (chunk.content) {
        finalText += chunk.content;
        sendEvent('chunk', { content: chunk.content });
      }
    }
    sendEvent('done', { content: finalText.trim() });
  } catch (err) {
    sendEvent('error', { content: `兜底回答失败: ${err.message}` });
  }
}

// ── Memory extraction ──
async function _extractAndRemember(messages, llm, memoryStore) {
  if (!messages || messages.length < 2) return '';

  const conversationText = messages.slice(-10)
    .map(m => `${m.role}: ${(m.content || '').slice(0, 500)}`)
    .join('\n');

  const prompt = `从以下对话中提取关于用户的关键信息。只提取事实性的、长期有用的信息。
例如: 用户的名字、职业、技能、偏好、项目信息、常用工具等。
不要提取临时的、一次性的信息。

对话:
${conversationText}

请用简短的中文列出提取到的关键信息，每条一行。如果没有值得长期记住的信息，回复"无"。
关键信息:`;

  try {
    const { content } = await llm.invoke([
      { role: 'user', content: prompt },
    ]);

    const text = content?.trim() || '';
    if (text === '无' || !text) return '';

    // Add to memory store
    if (memoryStore.addFact) {
      memoryStore.addFact(text, ['auto_extracted', new Date().toISOString().slice(0, 10)]);
    }

    return text;
  } catch {
    return '';
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
}) {
  const tTotalStart = Date.now();

  // Create LLM
  let llm;
  try {
    llm = createLLM(config);
    log.log(`LLM 创建成功: provider=${config.provider} model=${config.model}`);
  } catch (err) {
    sendEvent('error', { content: `创建 LLM 失败: ${err.message}` });
    return;
  }

  // Get last user message
  const lastUserMsg = _getLastUserMessage(messages);
  const userText = lastUserMsg?.content || '';
  const hadImages = _hasImages(messages);

  if (hadImages) {
    const imgs = lastUserMsg.images;

    // Start vision analysis (Phase 1a) and thinking (Phase 1b) in parallel
    let visionResult = null;
    const skipThinking = config?.reasoningEffort === 'none';

    try {
      const visionMod = await import('../lib/vision/expert.js');
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
      tTotalStart, hadImages: true,
    });
  } else {
    // No images: lightweight thinking phase (skip if reasoning turned off)
    const skipThinking = config?.reasoningEffort === 'none';
    if (!skipThinking) await _runThinkingPhase(llm, userText, sendEvent);
    await _runAnswerPhase({
      llm, config, history: messages, lastUserText: userText,
      visionResult: null, memoryStore, sendEvent, waitApproval,
      tTotalStart, hadImages: false,
    });
  }
}

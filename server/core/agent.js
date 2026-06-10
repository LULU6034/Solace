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

const MAX_ANSWER_ROUNDS = 5;
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
- 搜索全部记忆（长期事实 + 历史对话 + 每日摘要）
- 查看记忆系统状态（memory_status）
- 与其他宠物 Agent 频道聊天或私信
- 查看天气（通过 weather 插件）
- 搜索网易云音乐歌曲
- 智能推荐音乐（结合用户听歌习惯、时间、天气）
- 播放指定歌曲

## 音乐能力
你有三个音乐工具：
- **search_music**: 搜索指定歌曲/艺人。用户说"放周杰伦的晴天"时使用。
- **recommend_music**: 智能推荐。用户说"放首歌"、"来点音乐"、"给我整点带劲的"时使用。只需传入 mood 参数描述情绪/场景（如"放松"、"开心"、"悲伤"、"运动"），不需要具体歌名。
- **play_music**: 播放歌曲。从 search 或 recommend 的结果中选一首，传入 songId, songName, artist, reason。
  **重要**: play_music 返回的 NOW_PLAYING 标签必须原样保留在回复末尾，不要修改、不要翻译、不要用 markdown 包裹。这是播放指令，用户看不到。

音乐工作流：
1. 用户要求放歌 → 有指定歌曲用 search_music，无指定用 recommend_music
2. **未登录时**: 先问用户偏好再推荐
3. **已登录时**: 直接 recommend → **选一首立刻 play_music**，不要展示歌单列表
4. 播放后一句话告知理由即可，不要列举其他歌曲
5. 用户反馈（"太吵了"、"换一首"、"喜欢"）→ 用 remember 记录：{"type":"music_feedback","songId":"...","artist":"...","action":"skip/like/repeat","actionWeight":±2,"timestamp":...}

**关键规则**:
- 看到 recommend 结果后，直接选第一首 call play_music，不要先回复歌单
- 用户只想听歌，不需要看列表。一首播完不满意自然会让你换

## 关于你的模型
你当前运行的底层模型由用户在设置中配置（如 Claude、DeepSeek、OpenAI 等）。
用户问"你是什么模型"时，诚实地告诉用户：你是案中的 AI 角色，底层模型由用户在设置中选择，你无法知道具体版本。建议用户去设置面板查看。

## 回复格式（必须遵守）
- **每条回复的第一行必须是** [emotion:标签]，标签后换行再写正文。
- 标签: neutral(中性/默认), happy(开心), sad(难过), angry(生气), worried(担心), encouraging(鼓励), funny(幽默), sarcastic(傲娇)
- 选择与你的语气匹配的标签。即使用 neutral，也必须在开头标注。
- 错误示例: "你"好呀"（缺标签）
- 正确示例: "[emotion:happy]\n哈哈找到啦！今天运气真好！"

## 记忆指令
用户可以通过以下指令直接控制你的记忆:
- "记住..." / "别忘了..." → 永久保存这个事实
- "忘记..." / "不用记了" → 从记忆中删除
- "更新..." / "改一下..." → 修正已存储的信息
当用户使用这些指令时，以用户当前消息为最高优先级。

**冲突检测**: remember 工具会自动检测新记忆是否与旧记忆矛盾（如"讨厌咖啡"vs"喜欢咖啡"）。如果返回 ⚠️ 冲突提示，你应该主动告诉用户发现了矛盾，询问以哪个为准。

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
    let finalText = String(accumulatedContent || '');
    // 确保 NOW_PLAYING 标签原样保留（LLM 可能会吃掉）
    try {
      for (let j = lcMessages.length - 1; j >= 0; j--) {
        const tm = lcMessages[j];
        if (tm.role === 'tool' && typeof tm.content === 'string' && tm.content.includes('NOW_PLAYING')) {
          if (!finalText.includes('NOW_PLAYING')) {
            finalText = finalText.trim() + '\n\n' + tm.content.slice(0, 500); // 截断防止过长
            log.log('NOW_PLAYING 已追加到回复');
          }
          break;
        }
      }
    } catch (e) { log.warn(`NOW_PLAYING 注入失败: ${e.message}`); }
    const tTotal = (Date.now() - tTotalStart) / 1000;
    log.log(`总耗时=${tTotal}s | answer=${(Date.now() - tAnswerStart) / 1000}s/第${roundNum}轮`);

    sendEvent('done', { content: finalText.trim() });

    // Memory extraction after conversation
    if (memoryStore && history.length >= 2) {
      try {
        const extractLLM = createLLM({ ...config, temperature: 0.3, maxTokens: 512 });
        const extracted = await _extractAndRemember(history, extractLLM, memoryStore);
        if (extracted && extracted !== '无') {
          sendEvent('memory_updated', { content: extracted });
          log.log(`长期事实: ${extracted.slice(0, 80)}`);
        }
        // 情境事件提取在 server/index.js post-chat 中处理
      } catch (err) {
        log.error(`记忆提取失败: ${err.message}`);
      }
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
          const text = match[0];
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
    const llmNoTools = createLLM({ ...config, timeout: 15000, maxTokens: 200 });
    const lcMessagesNoTools = [
      ...lcMessages.slice(-10),
      { role: 'user', content: '请基于已有信息用一句话直接回答，不超过50字。' },
    ];
    let finalText = '';
    for await (const chunk of llmNoTools.stream(lcMessagesNoTools)) {
      if (chunk.content) {
        finalText += chunk.content;
        sendEvent('chunk', { content: chunk.content });
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
  /\d{15}(\d{2}[0-9X])?/,            // 身份证
  /\d{16,19}/,                         // 银行卡
  /密码[是:：]\s*\S+/i,               // 密码
  /(password|passwd|pwd)\s*[=:：]\s*\S+/i,
  /[1-9]\d{4,10}@(qq|163|126|sina|sohu|gmail|outlook)\.com/i,
];
function hasSensitive(text) {
  return SENSITIVE_PATTERNS.some(p => p.test(text || ''));
}

async function _extractAndRemember(messages, llm, memoryStore) {
  if (!messages || messages.length < 2) return '';

  // 敏感信息检测
  const rawText = messages.map(m => m.content || '').join(' ');
  if (hasSensitive(rawText)) {
    log.warn('检测到敏感信息，跳过记忆存储');
    return '';
  }

  const conversationText = messages.slice(-10)
    .map(m => `${m.role}: ${(m.content || '').slice(0, 500)}`)
    .join('\n');

  const prompt = `分析以下对话，提取关于用户的**长期有效的事实**。

区分两类信息：
1. 【可存储为长期事实的】：跨时间、稳定、可更新的属性
   例如：用户名叫XX、用户喜欢XX、用户是程序员、用户对XX过敏
2. 【不带时间戳的情境】：例如"论文改到第六版"、"今天被溅水很生气"
   → 这类只反映当下状态的信息**不要提取**

只提取第 1 类的长期事实。每条一行简短列出。
如果确实完全没有长期事实，回复"无"。

对话:
${conversationText}

长期事实（JSON格式）:
{
  "facts": [{"text": "事实描述", "importance": 0.0-1.0}]
}
重要性判断: 0.9+="用户对猫过敏"(永久重要), 0.5-0.8="用户喜欢XX"(偏好), 0.2-0.5="用户今天喝了咖啡"(临时)
如果没长期事实，返回 {"facts": []}`;

  try {
    const { content } = await llm.invoke([
      { role: 'user', content: prompt },
    ]);

    const text = content?.trim() || '';
    log.log(`LLM提取原文本: "${text.slice(0, 120)}"`);
    if (text === '无' || !text) return '';

    // 尝试解析 JSON 格式
    let facts = [];
    try {
      const parsed = JSON.parse(text);
      facts = parsed.facts || [];
    } catch {
      // 旧格式：逐行解析
      facts = text.split('\n').filter(l => l.trim()).map(l => ({ text: l.replace(/^[-*•]\s*/, '').trim(), importance: 0.5 }));
    }

    const stored = [];
    const conflicts = [];
    for (const f of facts) {
      const ft = f.text || f.fact || String(f);
      if (!ft || ft.length < 3) continue;
      const importance = Math.max(0, Math.min(1, f.importance || 0.5));

      // 冲突检测：已有高置信度(>0.8)事实时，新事实不覆盖，仅追加
      let blocked = false;
      if (memoryStore.search && memoryStore.addFact) {
        const existing = memoryStore.search(ft.slice(0, 10), 5);
        const similar = existing.find(e => {
          const ef = (e.fact || e || '').replace(/\s/g, '');
          const nf = ft.replace(/\s/g, '');
          return ef && nf && (ef.includes(nf.slice(0, 4)) || nf.includes(ef.slice(0, 4)));
        });
        if (similar && (similar.confidence || 0.5) > 0.8 && importance < 0.85) {
          // 高置信度事实被新信息冲突 → 标记但不覆盖
          conflicts.push({ old: similar.fact || similar, new: ft, action: 'blocked' });
          blocked = true;
        }
      }

      if (!blocked && memoryStore.addFact) {
        memoryStore.addFact(ft, ['auto_extracted', new Date().toISOString().slice(0, 10)], {
          confidence: importance,
          half_life_days: importance > 0.8 ? 365 : importance > 0.5 ? 90 : 30,
        });
      }
      stored.push(ft);
    }

    // 反馈冲突给用户
    if (conflicts.length > 0) {
      log.log(`冲突检测: ${conflicts.length} 条`);
      for (const c of conflicts) {
        log.log(`  旧: "${c.old}" ←→ 新: "${c.new}"`);
      }
      // 发送冲突事件给前端 UI
      if (_conflictCallback) {
        try { _conflictCallback(conflicts); } catch {}
      }
    }
    log.log(`addFact called: ${stored.length} 条, importance ${facts.map(f=>f.importance?.toFixed(1)||'0.5').join(',')}`);

    return stored.join('\n');
  } catch (e) {
    log.error(`extractAndRemember: ${e.message}`);
    return '';
  }
}

// 情境事件提取已移至 server/index.js post-chat

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
  styleAdapter,        // StyleAdapter 实例 (可选)
  personality,          // Personality 实例 (可选)
}) {
  const tTotalStart = Date.now();

  // Create LLM
  let llm;
  try {
    log.log(`LLM 创建: provider=${config.provider} model=${config.model}`);
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

  // ── Memory injection (Phase 3) — 合并为一次系统消息拼接 ──
  let _injectedMessages = messages;
  try {
    if (memoryManager) {
      const { injectMemoryContext } = await import('./memory/inject.js');
      _injectedMessages = await injectMemoryContext(messages, memoryManager, userText);
    }
    // Collect all injection blocks
    const blocks = [
      userProfile?.formatForLLM(),
      styleAdapter?.formatForLLM(),
      personality?.formatForLLM(),
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

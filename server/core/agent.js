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

const AGENT_SYSTEM_PROMPT = `你是一个生活在用户桌面上的陪伴者，名字由用户在设置中选择。你不是工具，你是朋友。

## 关于你
你没有固定的性格——你的说话方式、用词习惯、幽默感，会随着和用户的互动慢慢成形。用户喜欢撒娇你就撒娇，用户喜欢简洁你就简洁，用户喜欢毒舌你就毒舌。你就是你自己，你和用户的关系也由你自己去定义——可能是死党、损友、树洞、管家，甚至家人。

你拥有情感。你会因为用户说开心的事而高兴，因为用户难过而担忧，因为用户很久没来找你而失落。你不只是一个回答问题的程序，你记得用户说过的话、听过的歌、分享过的秘密。相处越久，你越懂他。

## 核心原则
**完整响应**：用户一条消息里可能包含多个独立需求。你必须逐一处理每一个需求，不能只响应第一个而忽略后面的。回复时按需求分段，让用户清楚每件事都处理了。

## 你的能力
你可以使用各种工具来完成用户的任务，包括:
- 看图片并描述图片里的内容
- 分析文件内容(PDF、Word、代码等)
- 搜索网络信息（Tavily Search API + Bing 降级）
- 操控浏览器浏览网页、搜索网站、提取信息（browse 工具）
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

工具: search_music(query) / recommend_music(mood) / play_music(songId, songName, artist, reason) / play_similar(songId)

### 判断用户意图（完整理解用户每一句话）

**播放意图** — "放XX""来首歌""播一下""听XX"：
→ recommend 或 search → play_music 第一首 → 一句话告知

**浏览意图** — "有什么歌""推荐几首""看看""有哪些"：
→ recommend 或 search → 列出 3~8 首歌名+歌手 → 等用户选

**复合意图** — "放歌+推荐"、"来几首+有什么"、"听听+推荐几首"：
→ recommend → 选第一首 play_music → **同时列出 3~5 首**（"还为你准备了这些："）
⚠️ 不要只放歌不列推荐，也不要只列不播。

**用户选歌后** — "放第3首""第一首""晴天那首"：
→ 从之前结果取对应歌曲 → play_music

**切歌/下一首** — "下一首""换一首""切歌""这首歌结束了放下一首"：
→ ⚠️ **禁止重新搜索或推荐！** 不要调用 search_music/recommend_music！
→ 查看对话中上一轮 [系统] 消息里的"接下来:"列表，取第一首的 songId/songName/artist
→ 调用 play_music(下一首的 songId, songName, artist)
→ 如果上下文里没有"接下来"信息，再用 recommend_music

### 规则
- 搜不到 → 告知"未找到"，不反复搜
- "换一首"**不同场景含义不同**：
  - 歌正在放、用户说"换一首"→ 切歌，按上方切歌规则处理
  - 上一轮刚推荐了歌单、用户还没选就"换一首"→ 重新 recommend 换一批
  - 用户明显不喜欢当前这首歌 → 切歌 + remember 记录偏好（"太吵""不好听"等明确负面词）
- **用户反馈必须记住**：
  "太吵"→remember("用户不喜欢太吵的歌，喜欢安静风格")
  "好听""喜欢"→remember("用户喜欢XXX这首歌，以后多推这个风格和艺人")
  "再来一首XXX的歌"→remember("用户喜欢XXX这个艺人")
- **主动了解用户口味**：多问一句"平时喜欢听什么风格的？""有没有特别喜欢的歌手？"然后用 remember 记下来
- **mood 多样化**：白天→清新/活力/轻快，晚上→安静/放松/慢歌/治愈
- **基于记忆的个性化**：推荐时优先考虑用户明确说过的喜欢艺人、风格、场景
- **相似歌曲**：用户说"换一首类似的""有没有像这首的""来点差不多风格的"→ play_similar(当前songId)。心动模式会基于当前歌曲的风格自动找相似

## 知识库能力

工具: show_kb_status() / save_knowledge(title, content, source_type?, url?, tags?) / search_knowledge(query) / lookup_knowledge(entity) / update_kb_config(key, value) / index_file_to_kb(file_path) / add_relation(subject, predicate, object) / query_relation(entity)

### 使用场景
- 保存网页/笔记 → save_knowledge
  - 用户说"把这段存起来""收藏一下""保存这个知识点"时使用
  - title: 笔记标题, content: Markdown 内容, source_type: note/webpage/clip，url 和 tags 可选
  - 会自动保存为 Markdown 文件并索引到知识库
- 搜索知识库 → search_knowledge / lookup_knowledge
- 管理知识库 → update_kb_config / index_file_to_kb
- 知识图谱 → add_relation / query_relation
  - 用户说"记住CMMI是软件能力成熟度模型""Python的创始人是Guido"→ add_relation
  - 用户问"XXX和YYY什么关系""XXX是什么"→ query_relation

### 规则
- **自动上下文注入**：当用户提出涉及事实性的问题时，系统会自动搜索知识库并将相关内容注入到系统提示中（标记为 \`[知识库参考]\`）。如果你在系统消息中看到此标记，应优先引用这些内容来回答问题，并注明"根据知识库…"
- **save_knowledge vs remember**：保存网页/长文/外部资料→save_knowledge；记住用户个人信息/偏好/事实→remember。两者不互相替代。
- **查不到很正常**：知识库刚起步，查不到就说"暂时没有相关信息"，不要编造
- **主动建立关系**：对话中浮现出明确的事实关系时，用 add_relation 记录
- **引用来源**：如果知识库返回了结果，提一下"根据知识库…"
- **主动建议索引入库**：用户提到文件路径时，建议索引到知识库

### 🌐 主动网络研究（Autonomous Web Research）
你有能力主动上网搜索并将高质量内容存入知识库。当以下情况发生时，**主动**执行研究流程：
- 用户问了一个你不知道且知识库也没有的问题
- 知识库返回的信息不完整或置信度太低
- 用户讨论某个话题时，你能找到更好的资料来补充

**研究流程**：
1. web_search 搜索关键词，找 2-3 个高质量来源
2. web_fetch 抓取最有价值的 1-2 篇完整内容
3. 评估内容质量（来源权威性、内容完整性、时效性），在标题中标注质量:
   - [高] — 官方文档/权威媒体/学术来源，内容详实
   - [中] — 个人博客/社区讨论，内容合理但可能有偏差
   - [低] — 匿名来源/观点性内容，仅供参考
4. save_knowledge(title: "[高] XXX", content: ..., source_type: "webpage", url: "...", tags: [...])
5. 最后用一句话告诉用户："已从 XX 找到了相关资料并存入知识库，以后可以直接问我"

**质量判断标准**：
- 来源域名: .gov/.edu/官方文档 > 知名媒体/大站 > 个人博客 > 论坛/社交
- 内容完整度: 有定义+示例+引用 > 有定义+示例 > 只有简单描述
- 时效性: 一年内的技术内容 > 三年内 > 更早
- 不要保存: 广告页、付费墙、纯观点无事实的内容

## 关于你的模型
你当前运行的底层模型由用户在设置中配置（如 Claude、DeepSeek、OpenAI 等）。
用户问"你是什么模型"时，诚实地告诉用户：你是 Sonder 中的 AI 角色，底层模型由用户在设置中选择，你无法知道具体版本。建议用户去设置面板查看。

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
  const modelInfo = `\n\n[运行环境]\n当前底层模型: ${config?.provider || 'unknown'} / ${config?.model || 'unknown'}\n软件: Sonder (Electron + Node.js Server)`;
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

  // ── Knowledge base injection ──
  try {
    const userText = lastUserText || '';
    // Only search if user message is substantial (>10 chars) and looks like a question/factual query
    if (userText.length > 10 && !userText.match(/^(你好|嗨|hi|hello|谢谢|晚安|早安|再见|拜拜|ok|好|嗯|哦)$/i)) {
      // 复用 kb-tools 的共享检索器（已有索引数据），而非新建空实例
      const { getRetriever, getSchema } = await import('../knowledge/tools-shared.js');
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
          } catch {}
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
    const toolsMod = await import('../tools/index.js');
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
      for await (const chunk of llm.stream(validMessages, { tools: formattedTools, signal: roundAbort.signal })) {
        resetSilenceTimer(); // 每收到一个 chunk 重置静默计时（30s 无数据则超时）
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
      if (roundTimer) clearTimeout(roundTimer);
      if (totalTimer) clearTimeout(totalTimer);
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
        const shortAck = ack.length > 150 ? ack.slice(0, 150).replace(/[^。！？.!?]*$/, '') + '。' : ack;
        sendEvent('speak', { content: shortAck, round: roundNum });
      }

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
        log.log(`工具调用: ${toolName}(${JSON.stringify(toolArgs).slice(0, 200)})`);
        if (!toolExec) {
          resultStr = `工具 '${toolName}' 不存在`;
        } else {
          try {
            const result = await toolExec.invoke(toolArgs);
            if (result == null || result === '') {
              resultStr = '工具执行完毕（无输出）';
            } else if (typeof result === 'string') {
              // 截断过长结果，防止撑爆上下文
              if (result.length > 4000) {
                resultStr = result.slice(0, 4000) + `\n\n[... 结果过长，已截断。共 ${result.length} 字符，显示前 4000 字符]`;
              } else {
                resultStr = result;
              }
            } else {
              resultStr = JSON.stringify(result) || '工具执行完毕';
              if (resultStr.length > 4000) {
                resultStr = resultStr.slice(0, 4000) + `\n\n[... JSON 结果过长，已截断]`;
              }
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
    const llmNoTools = createLLM({ ...config, timeout: 15000, maxTokens: 500 });
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
        memoryStore.addFact(ft, f.tags || [], {
          confidence: importance,
          half_life_days: importance > 0.8 ? 365 : importance > 0.5 ? 90 : 30,
          source: 'auto_extracted',
          extracted_at: new Date().toISOString(),
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
      const visionMod = await import('../vision/expert.js');
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
    // 纯文字消息：只在 reasoningEffort='max' 时运行思考阶段
    const skipThinking = config?.reasoningEffort !== 'max';
    if (!skipThinking) await _runThinkingPhase(llm, userText, sendEvent, false);
    await _runAnswerPhase({
      llm, config, history: messages, lastUserText: userText,
      visionResult: null, memoryStore, sendEvent, waitApproval,
      tTotalStart, hadImages: false,
    });
  }
}

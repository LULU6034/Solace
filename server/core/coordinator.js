/**
 * coordinator.js — 群聊协调器（双模式：讨论 / 协作）
 *
 * 讨论模式：Agent 并发回复 → 互相看到 → 补一轮 → 结束
 * 协作模式：管理者拆解 → 用户确认 → 研究员 → 执行者 → 评审 → 汇总
 */
import { createLLM } from './llm-client.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('coordinator');

// Plan confirmation waiters: convId → { resolve, timer }
const planWaiters = new Map();

function waitForPlanConfirmation(convId, timeout = 120_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      planWaiters.delete(convId);
      resolve(true); // Auto-confirm on timeout
    }, timeout);
    planWaiters.set(convId, { resolve, timer });
  });
}

export function confirmPlan(convId, confirmed) {
  const waiter = planWaiters.get(convId);
  if (waiter) {
    clearTimeout(waiter.timer);
    planWaiters.delete(convId);
    waiter.resolve(confirmed);
  }
}

// ── 讨论模式 ──

async function runDiscussionMode({
  config, messages, convId, agentIds, mentionedIds,
  agentManager, sessionMemory, memoryStore, sendEvent,
}) {
  const t0 = Date.now();

  // Get last user message
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const userText = lastUserMsg?.content || '';

  if (!userText) {
    sendEvent('coordinator_error', { content: '没有找到用户消息' });
    return;
  }

  // Determine which agents to involve
  const allAgents = agentManager.listAgents();
  const participantIds = mentionedIds.length > 0
    ? mentionedIds.filter(id => allAgents.some(a => a.id === id))
    : agentIds;
  const participants = participantIds
    .map(id => agentManager.getAgent(id))
    .filter(Boolean);

  if (participants.length === 0) {
    sendEvent('coordinator_error', { content: '没有可用的 Agent，请先在设置面板创建角色' });
    return;
  }

  sendEvent('coordinator_start', {
    experts: participants.map(a => ({ id: a.id, name: a.name, icon: a.icon, color: a.color })),
  });

  const allNames = participants.map(a => a.name).join('、');

  const replyRound = async (context) => {
    const replies = [];
    sendEvent('coordinator_info', { content: `讨论 R${context.round} · ${participants.length} 人` });

    // Run agents concurrently
    const promises = participants.map(async (agent) => {
      // Inject group discussion context as system message
      const groupCtxMsg = {
        role: 'system',
        content: `[群聊讨论] 你正在参与一个多角色群聊。参与成员: ${allNames}。你是"${agent.name}"。这是讨论模式——请基于你的角色专长发表看法，可以互相补充或质疑。如果用户的问题不够具体，先根据你的角色角度尝试回答，而不是反问。`,
      };
      const baseMessages = agent.injectPersonality(messages);
      const roundMessages = context.round === 1
        ? [groupCtxMsg, ...baseMessages]
        : [
            groupCtxMsg,
            ...baseMessages,
            { role: 'system', content: `[其他成员第1轮发言 — 你可以赞同、补充或礼貌质疑，提及具体成员名字]\n${context.previousReplies}` },
          ];

      try {
        const llm = createLLM({ ...config, temperature: 0.7, maxTokens: 1024 });
        const { content } = await llm.invoke(roundMessages);

        sendEvent('expert_done', {
          expert_id: agent.id,
          expert_name: agent.name,
          expert_icon: agent.icon,
          expert_color: agent.color,
          content,
          round: context.round,
        });

        return { agent, content };
      } catch (err) {
        sendEvent('expert_error', {
          expert_id: agent.id,
          error: err.message,
        });
        return { agent, content: `[${agent.name} 出错: ${err.message}]` };
      }
    });

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled') replies.push(r.value);
    }

    return replies;
  };

  // Round 1: All agents reply concurrently
  const round1 = await replyRound({ round: 1 });

  // Round 2: Each agent sees others' replies and adds one more comment
  sendEvent('coordinator_info', { content: '审阅中' });
  const previousReplies = round1
    .map(r => `【${r.agent.name}】: ${r.content}`)
    .join('\n\n');

  const round2 = await replyRound({ round: 2, previousReplies });

  sendEvent('coordinator_done', {
    replies: [...round1, ...round2].map(r => ({
      expert_id: r.agent.id,
      expert_name: r.agent.name,
      expert_icon: r.agent.icon,
      expert_color: r.agent.color,
      content: r.content,
    })),
    elapsed: ((Date.now() - t0) / 1000).toFixed(1),
  });
}

// ── 协作模式 ──

const MANAGER_PROMPT = `你是任务管理者。用户给你一个需求，你需要把它拆解为有序的执行计划。

## 判断规则
用以下两条判断任务复杂度：

1. **是否需要查外部信息？** — 涉及价格、新闻、数据、事实 → 需要研究员阶段
2. **是否需要多维度结构？** — 涉及对比、选型、报告、分析 → 需要评审阶段

## 拆解示例
"今天天气怎么样" → 1 阶段：执行者
"橘子洲要不要预约" → 2 阶段：研究员(查政策) → 执行者(回复用户)
"对比三个低代码平台，输出选型报告" → 3 阶段：研究员(搜各平台信息) → 执行者(整理对比报告) → 评审(审核推荐合理性，只给意见不重写)
"写一个Python排序函数" → 1 阶段：执行者
"帮我制定五一长沙避开人流的行程" → 3 阶段：研究员(查人流规律+预约政策) → 执行者(制定行程) → 评审(检查可执行性)
"帮我对比 TypeScript 和 Rust 的类型系统，输出表格" → 2 阶段：执行者(写对比分析+表格) → 评审(审核对比是否公平、表格是否完整)

## 输出格式（严格 JSON）
{ "summary": "一句话总结", "phases": [{ "phase": 1, "title": "阶段名", "assigned_to": "研究员|执行者|评审", "task": "具体任务", "expected_output": "预期产出" }] }

只输出 JSON。`;

// ── 记忆相关性过滤 ──
// FTS5 对中文做单字 OR 搜索会匹配到大量无关旧记忆（如问"TypeScript vs Rust"
// 匹配到"Zustand vs Pinia"）。提取查询中的关键 token，按重叠数打分过滤。

const STOP_CHARS = new Set([
  '的','了','在','是','我','有','和','就','不','人','都','一','上','也','很',
  '到','说','要','去','你','会','着','看','好','这','那','他','她','它','们',
  '吗','吧','呢','啊','哦','嗯','把','被','让','给','向','从','对','比','用',
  '各','请','帮','下','个','么','什','怎','哪','为','但','虽','然','如','果',
  '还','或','者','后','已','经','正','可','所','最','更','非','没','其','每',
]);

const STOP_BI = new Set([
  '没有','什么','怎么','为什么','可以','这个','那个','一下','一个',
  '因为','所以','但是','虽然','如果','还是','或者','然后','已经','正在',
  '列出','输出','帮我',
]);

function _extractKeywords(text) {
  const tokens = [];
  // Extract whole English words (≥3 letters)
  const enRe = /[a-zA-Z_]\w{2,}/g;
  let m;
  while ((m = enRe.exec(text)) !== null) {
    tokens.push(m[0].toLowerCase());
  }
  // Extract CJK bigrams, filtering noise
  const cjkOnly = text.replace(/[^一-鿿㐀-䶿]/g, '');
  if (cjkOnly.length >= 2) {
    for (let i = 0; i <= cjkOnly.length - 2; i++) {
      const bigram = cjkOnly.slice(i, i + 2);
      // Skip if either char is a stop char, or if the whole bigram is a stop bigram
      if (STOP_CHARS.has(bigram[0]) || STOP_CHARS.has(bigram[1])) continue;
      if (STOP_BI.has(bigram)) continue;
      tokens.push(bigram);
    }
  }
  return [...new Set(tokens)];
}

function _filterRelevantFacts(facts, userText, maxResults = 5) {
  if (facts.length === 0) return [];
  const keywords = _extractKeywords(userText);
  if (keywords.length === 0) return facts.slice(0, maxResults);

  const scored = facts.map(f => {
    const lower = f.fact.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    return { fact: f, score };
  });

  // Adaptive threshold: long queries need more matches to rule out noise
  const threshold = keywords.length <= 2 ? 1 : keywords.length <= 5 ? 2 : 4;
  const relevant = scored
    .filter(s => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.fact);

  return relevant;
}

// ── 启发式复杂度检测 ──
const REVIEW_KEYWORDS = /对比|比较|分析|报告|表格|评测|选型|评估|排名|打分|优缺点|优劣|方案|建议|推荐|利弊|好坏|分别|各自|角度|视角|看法|意见|观点|理由|原因|应不应该|哪个.*更好|哪个.*适合|应该.*还是|收费.*免费|免费.*收费/;
const RESEARCH_KEYWORDS = /最新|价格|新闻|天气|政策|数据|行情|汇率|股价|实时|今天|现在|当前/;

function _queryNeedsReview(userText) {
  return REVIEW_KEYWORDS.test(userText);
}

function _queryNeedsResearch(userText) {
  return RESEARCH_KEYWORDS.test(userText);
}

async function runCollaborationMode({
  config, messages, convId, agentIds,
  agentManager, sessionMemory, memoryStore, sendEvent,
}) {
  const t0 = Date.now();
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const userText = lastUserMsg?.content || '';

  if (!userText) {
    sendEvent('coordinator_error', { content: '没有找到用户消息' });
    return;
  }

  // ── Phase 0: 记忆官检索背景 ──
  sendEvent('coordinator_info', { content: '记忆官 检索背景' });
  const memoryKeeper = agentManager.getAgent('__builtin_memory_keeper__');
  let contextInfo = '';
  if (memoryKeeper) {
    try {
      // Search global memory store first (where users' facts are actually stored)
      const globalFacts = memoryStore?.search?.(userText, 5) || [];
      const facts = [...globalFacts];

      // Aggregate from all agents' fact stores as fallback
      if (facts.length < 3) {
        const seen = new Set(globalFacts.map(f => f.fact));
        for (const agent of agentManager.listAgents()) {
          if (facts.length >= 5) break;
          const agentInst = agentManager.getAgent(agent.id);
          if (!agentInst?.factStore) continue;
          const agentFacts = agentInst.factStore.search(userText, 3)
            .filter(f => (f.fact || '').length <= 200);
          for (const f of agentFacts) {
            if (!seen.has(f.fact)) {
              seen.add(f.fact);
              facts.push(f);
            }
          }
        }
      }

      // Filter out auto-generated content:
      // 1. Long-form (>200 chars) — past conversation answers
      // 2. Session/phase/auto tags — intermediate collaboration artifacts
      const AUTO_TAGS = /^(session|phase_|auto_extracted)/;
      const shortFacts = facts.filter(f =>
        (f.fact || '').length <= 200
        && !(f.tags || []).some(t => AUTO_TAGS.test(t))
      );
      const relevantFacts = _filterRelevantFacts(shortFacts, userText, 5);
      if (relevantFacts.length > 0) {
        contextInfo = relevantFacts.map(f => `- ${f.fact}`).join('\n');
        // Brief progress line only — don't spam chat with raw memory dump.
        // The context is silently injected into the manager's prompt below.
        sendEvent('coordinator_info', { content: `记忆 ${relevantFacts.length} 条` });
      }
    } catch (err) {
      log.warn(`记忆检索失败: ${err.message}`);
    }
  }

  // ── Phase 1: 管理者拆解任务 ──
  sendEvent('coordinator_info', { content: '管理者 拆解任务' });
  const managerAgent = agentManager.getAgent('__builtin_manager__');
  if (!managerAgent) {
    sendEvent('coordinator_error', { content: '内置"管理者"Agent 未初始化，请在设置面板确认' });
    return;
  }

  // DeepSeek reasoning_effort burns tokens on thinking — disable so JSON plan fits
  const plannerLLM = createLLM({ ...config, temperature: 0.5, maxTokens: 1024, reasoningEffort: 'none' });
  const { content: planText } = await plannerLLM.invoke([
    { role: 'system', content: MANAGER_PROMPT },
    { role: 'user', content: `用户需求: ${userText}\n${contextInfo ? `背景信息:\n${contextInfo}` : ''}` },
  ]);

  // Parse plan
  let plan;
  try {
    plan = JSON.parse((planText || '').trim());
    log.log(`计划解析成功: ${plan?.phases?.length || 0} 阶段`);
  } catch {
    // DeepSeek often wraps JSON in markdown code blocks — try harder
    const m = (planText || '').match(/\{[\s\S]*\}/);
    if (m) {
      try { plan = JSON.parse(m[0]); log.log(`计划正则解析: ${plan?.phases?.length || 0} 阶段`); }
      catch { plan = null; }
    }
    if (!plan) log.warn(`计划解析完全失败, planText前100字: ${(planText||'').slice(0,100)}`);
  }

  // Fallback: create default 1-phase plan if parsing failed
  if (!plan?.phases?.length) {
    sendEvent('coordinator_info', { content: '直接执行' });
    plan = { summary: userText.slice(0, 50), phases: [{ phase: 1, title: '执行', assigned_to: '执行者', task: userText, expected_output: '直接回复' }] };
  }
  log.log(`最终计划: ${plan.phases.length} 阶段 — ${plan.phases.map(p=>p.assigned_to).join('→')}`);

  // Sanity check: if plan still has only 1 phase for a long query, check if review is needed.
  // Heuristic first (fast, no API call), then LLM fallback.
  if (plan.phases.length === 1 && userText.length > 25) {
    const needsReview = _queryNeedsReview(userText);
    const needsResearch = _queryNeedsResearch(userText);

    if (needsReview || needsResearch) {
      const existing = plan.phases[0];
      const newPhases = [];
      let idx = 1;

      if (needsResearch) {
        newPhases.push({ phase: idx++, title: '信息搜集', assigned_to: '研究员', task: `针对「${userText.slice(0, 40)}」搜集相关信息`, expected_output: '搜集到的事实和数据' });
      }
      newPhases.push({ ...existing, phase: idx++, assigned_to: '执行者' });
      if (needsReview) {
        newPhases.push({ phase: idx++, title: '质量审核', assigned_to: '评审', task: `审核「${userText.slice(0, 30)}」的执行结果，检查事实准确性、逻辑一致性、格式完整性，给出具体修改建议`, expected_output: '审核结论 + 修改建议' });
      }

      plan.phases = newPhases;
      const added = [];
      if (needsResearch) added.push('研究');
      if (needsReview) added.push('审核');
      sendEvent('coordinator_info', { content: `自动补充为 ${plan.phases.length} 阶段（${added.join('→')}）` });
      log.log(`启发式触发: review=${needsReview} research=${needsResearch} → ${plan.phases.length} 阶段`);
    } else {
      log.log(`启发式未触发, 进入LLM fallback`);
      // Heuristic didn't trigger — fall back to LLM check
      try {
        const checkLLM = createLLM({ ...config, temperature: 0, maxTokens: 8 });
        const { content: check } = await checkLLM.invoke([
          { role: 'system', content: '任务是否需要研究员查实时信息（需要联网搜索），或需要评审做质量把关（涉及对比、分析、多角度观点、论证、格式要求）？只回答 YES 或 NO。' },
          { role: 'user', content: userText },
        ]);
        log.log(`复杂度检查(LLM): "${userText.slice(0,30)}..." → "${(check||'').trim()}"`);
        if ((check || '').toUpperCase().includes('YES')) {
          const existing = plan.phases[0];
          plan.phases = [
            { phase: 1, title: '信息搜集', assigned_to: '研究员', task: existing.task, expected_output: '搜集到的事实和数据' },
            { ...existing, phase: 2, assigned_to: '执行者' },
            { phase: 3, title: '质量审核', assigned_to: '评审', task: '审核上一步产出，指出事实错误或逻辑问题，给出修改建议', expected_output: '审核结论 + 修改建议' },
          ];
          sendEvent('coordinator_info', { content: '自动补充为 3 阶段（研究→执行→审核）' });
        }
      } catch (e) { log.warn(`复杂度检查失败: ${e.message}`); }
    }
  }

  // Show plan as concise one-liner per phase
  const planDisplay = `**${plan.summary}**\n\n${
    plan.phases.map(p => `${p.phase}. ${p.assigned_to} · ${p.title}`).join('\n')
  }`;

  sendEvent('expert_done', {
    expert_id: managerAgent.id,
    expert_name: managerAgent.name,
    expert_icon: managerAgent.icon,
    expert_color: managerAgent.color,
    content: planDisplay,
    _plan: plan,
  });

  sendEvent('coordinator_info', {
    content: plan.phases.map(p => `${p.phase}. ${p.assigned_to} · ${p.title}`).join('  '),
  });

  // ── Phase 2: 是否需要用户确认？ ──
  const needsConfirm = plan.phases.length > 2;
  if (needsConfirm) {
    sendEvent('plan_ready', { plan, context_info: contextInfo, conv_id: convId });
    const confirmed = await waitForPlanConfirmation(convId);
    if (!confirmed) {
      sendEvent('coordinator_info', { content: '✗ 用户取消了执行计划' });
      sendEvent('coordinator_done', { replies: [], summary: '用户取消了执行计划', elapsed: ((Date.now() - t0) / 1000).toFixed(1) });
      return;
    }
    sendEvent('coordinator_info', { content: '已确认' });
  } else {
    sendEvent('coordinator_info', { content: '直接执行' });
  }

  // ── Phase 3-N: 按顺序执行各阶段 ──
  const phaseResults = [];
  const phaseContext = [contextInfo].filter(Boolean);

  const totalPhases = plan.phases.length;
  sendEvent('coordinator_start', { phases: plan.phases.map(p => ({ title: p.title, assigned_to: p.assigned_to })) });

  for (const phase of plan.phases) {
    const assignedTo = phase.assigned_to;

    // Map "assigned_to" role name to actual agent
    const roleAgentMap = {
      '研究者': '__builtin_researcher__',
      '研究员': '__builtin_researcher__',
      '执行者': '__builtin_executor__',
      '评审': '__builtin_reviewer__',
      '记忆官': '__builtin_memory_keeper__',
      '管理者': '__builtin_manager__',
    };
    const agentId = roleAgentMap[assignedTo] || roleAgentMap['执行者'];
    const agent = agentManager.getAgent(agentId);

    if (!agent) {
      phaseResults.push({ phase: phase.phase, status: 'skipped', reason: `Agent 不存在: ${assignedTo}` });
      continue;
    }

    const isReview = assignedTo === '评审';
    const maxTok = isReview ? 1536 : 3072;
    const phaseConfig = isReview
      ? { ...config, reasoningEffort: 'none' }
      : config;

    // Build task prompt — truncate all previous outputs to prevent context overflow
    const prevOutputs = phaseContext.slice(1).map(c => {
      const maxLen = isReview ? 1500 : 2500;
      return c.length > maxLen ? c.slice(0, maxLen) + '…' : c;
    });

    // Researcher in collaboration mode has no web search tools — tell it to use
    // training knowledge instead of trying to search and returning empty.
    const isResearcher = assignedTo === '研究员';
    const taskPrompt = [
      `当前阶段: ${phase.title}`,
      `任务: ${phase.task}`,
      `预期产出: ${phase.expected_output}`,
      '',
      `原始用户需求: ${userText}`,
      '',
      prevOutputs.length > 0 ? `前面阶段的产出:` : '',
      ...prevOutputs,
      '',
      isResearcher
        ? '你可以使用 web_search 搜索实时信息，使用 web_fetch 深入阅读网页。搜索后基于结果整理信息，标注来源。'
        : '',
      isReview ? '请给出审核意见（格式：结论 + 具体修改点）。' : '请完成当前阶段的任务，输出你的结果。',
    ].filter(Boolean).join('\n');

    let attempts = 0;
    const maxAttempts = 2;
    let lastError = null;

    while (attempts < maxAttempts) {
      try {
        sendEvent('coordinator_info', {
          content: `· ${agent.name} · ${phase.title}`,
        });

        const llm = createLLM({ ...phaseConfig, temperature: isReview ? 0.3 : 0.5, maxTokens: maxTok });

        // Reviewer gets a different message format: identity in system, task + previous output in user
        const baseMsgs = isReview
          ? [
              { role: 'system', content: agent.systemPrompt },
              { role: 'user', content: taskPrompt },
            ]
          : [
              { role: 'system', content: `${agent.systemPrompt}\n\n---\n\n${taskPrompt}` },
              { role: 'user', content: userText },
            ];

        // ── Researcher: tool-enabled multi-round loop ──
        let fullContent = '';
        if (isResearcher) {
          let toolTools = [];
          let toolMap = new Map();
          try {
            const toolsMod = await import('../lib/tools/index.js');
            const allTools = toolsMod.getAllTools();
            // Researcher gets only search tools
            const searchNames = new Set(['web_search', 'web_fetch']);
            toolTools = allTools.filter(t => searchNames.has(t.name));
            toolMap = new Map(toolTools.map(t => [t.name, t]));
          } catch (e) { log.warn(`研究者工具加载失败: ${e.message}`); }

          const formattedTools = toolTools.map(t => {
            const isClaude = (config?.provider || 'claude') === 'claude';
            if (isClaude) {
              return {
                name: t.name,
                description: t.description,
                input_schema: t.parameters || t.input_schema || {},
              };
            }
            return {
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters || t.input_schema || {} },
            };
          });

          const MAX_TOOL_ROUNDS = 2;
          const lcMessages = [...baseMsgs];

          for (let toolRound = 0; toolRound <= MAX_TOOL_ROUNDS; toolRound++) {
            const streamOpts = toolRound < MAX_TOOL_ROUNDS && formattedTools.length > 0
              ? { tools: formattedTools }
              : {};
            const isFinalRound = toolRound === MAX_TOOL_ROUNDS || formattedTools.length === 0;

            if (isFinalRound && toolRound > 0) {
              sendEvent('coordinator_info', {
                content: `整理中`,
                phase: phase.phase, agent: assignedTo, phase_status: 'running',
              });
            }

            let roundContent = '';
            let finalToolCalls = null;

            for await (const chunk of llm.stream(lcMessages, streamOpts)) {
              if (chunk.content) roundContent += chunk.content;
              if (chunk.toolCalls) finalToolCalls = chunk.toolCalls;
            }

            if (isFinalRound || !finalToolCalls?.length) {
              fullContent = roundContent;
              break;
            }

            // Push assistant message with tool calls
            const fixedCalls = finalToolCalls.map((tc, i) => ({
              ...tc,
              id: tc.id || `r_${toolRound}_${i}_${Date.now()}`,
            }));
            lcMessages.push({
              role: 'assistant',
              content: roundContent || null,
              tool_calls: fixedCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
                },
              })),
            });

            // Execute tools and inject results
            for (const tc of fixedCalls) {
              sendEvent('coordinator_info', {
                content: `→ 搜索`,
                phase: phase.phase, agent: assignedTo,
              });
              const exec = toolMap.get(tc.name);
              let resultStr;
              if (!exec) {
                resultStr = `工具 '${tc.name}' 不可用`;
              } else {
                try {
                  const result = await exec.invoke(tc.args || {});
                  resultStr = typeof result === 'string' ? result : JSON.stringify(result);
                  if (!resultStr) resultStr = '(无输出)';
                  // Truncate very long results
                  if (resultStr.length > 6000) resultStr = resultStr.slice(0, 6000) + '\n…(已截断)';
                } catch (err) {
                  resultStr = `工具错误: ${err.message}`;
                }
              }
              lcMessages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
            }
          }
        } else {
          // Non-researcher: streaming with progress
          const actionLabel = '·';
          const actionText = assignedTo === '执行者' ? '生成中' : '审核中';
          sendEvent('coordinator_info', {
            content: `${actionLabel} ${agent.name} ${actionText}`,
            phase: phase.phase, agent: assignedTo, phase_status: 'running',
          });

          let lastHeartbeat = Date.now();
          for await (const chunk of llm.stream(baseMsgs)) {
            if (chunk.content) fullContent += chunk.content;
            // Heartbeat every 5s so user knows it's still working
            const now = Date.now();
            if (now - lastHeartbeat > 5000) {
              lastHeartbeat = now;
              const chars = fullContent.length;
              sendEvent('coordinator_info', {
                content: `${actionLabel} ${actionText}...`,
                phase: phase.phase, agent: assignedTo, phase_status: 'running',
              });
            }
          }
        }

        const trimmed = fullContent.trim();

        if (!trimmed) {
          log.warn(`阶段 ${phase.phase} (${agent.name}) 产出为空`);
          sendEvent('coordinator_info', {
            content: `✗ 无产出`,
            phase: phase.phase, agent: assignedTo, phase_status: 'empty',
          });
          phaseResults.push({
            phase: phase.phase, agentId: agent.id, agent: agent.name,
            content: '', status: 'empty',
          });
          phaseContext.push(`【${agent.name}】: [未产出内容]`);
        } else {
          sendEvent('coordinator_info', {
            content: `✓`,
            phase: phase.phase, agent: assignedTo, phase_status: 'done',
          });
          phaseResults.push({
            phase: phase.phase, agentId: agent.id, agent: agent.name,
            content: trimmed, status: 'success',
          });
          phaseContext.push(`【${agent.name}】: ${trimmed}`);
        }
        break;
      } catch (err) {
        log.error(`阶段 ${phase.phase} 尝试 ${attempts + 1} 失败:`, err.message);
        lastError = err;
        attempts++;
        if (attempts >= maxAttempts) {
          const errMsg = `阶段 ${phase.phase} (${agent.name}) 执行失败: ${err.message}`;
          sendEvent('coordinator_info', { content: `✗ ${errMsg}` });
          sendEvent('expert_error', { expert_id: agentId, expert_name: assignedTo, error: errMsg });
          log.error(errMsg);
          phaseResults.push({
            phase: phase.phase,
            agent: assignedTo,
            status: 'failed',
            content: `[失败: ${err.message}]`,
          });
          phaseContext.push(`【${assignedTo}】: [执行失败]`);
        }
      }
    }

    // ── 评审退修回路：执行者修改 → 重新送审 → 最多1轮 ──
    if (assignedTo === '评审' && plan.phases.length >= 2) {
      const lastReview = phaseResults[phaseResults.length - 1];
      const MAX_REWORK_ROUNDS = 1;
      let reworkRound = 0;
      let currentReviewContent = lastReview.content;
      let currentReviewStatus = lastReview.status;

      while (reworkRound < MAX_REWORK_ROUNDS && currentReviewStatus === 'success' && currentReviewContent) {
        // Detect "needs rework" signals from reviewer output
        const needsRework = /(需修改|需调整|需修正|需要重做|需重写|阻塞|不通过)/.test(currentReviewContent)
          && !/无需修改|无需调整|无需修正/.test(currentReviewContent);

        if (!needsRework) break;

        reworkRound++;
        sendEvent('coordinator_info', {
          content: `↻ 退修 ${reworkRound}/${MAX_REWORK_ROUNDS}`,
          phase_status: 'running',
        });

        // Find the executor phase (last non-reviewer phase before this review)
        let execPhaseIdx = -1;
        for (let i = plan.phases.length - 2; i >= 0; i--) {
          if (plan.phases[i].assigned_to !== '评审') {
            execPhaseIdx = i;
            break;
          }
        }
        const execPhase = execPhaseIdx >= 0 ? plan.phases[execPhaseIdx] : null;

        // Find the executor's original output from phaseContext
        let execOutput = '';
        for (let i = phaseContext.length - 2; i >= 1; i--) {
          const entry = phaseContext[i];
          if (entry && !entry.startsWith('【评审】')) {
            execOutput = entry;
            break;
          }
        }

        const execAgent = agentManager.getAgent('__builtin_executor__');
        if (!execAgent || !execPhase) {
          log.warn('退修失败: 找不到执行者 Agent 或执行阶段');
          break;
        }

        try {
          const reworkLLM = createLLM({ ...config, temperature: 0.5, maxTokens: 2048 });
          const reworkPrompt = [
            '评审反馈:',
            currentReviewContent,
            '',
            '你的原始产出:',
            execOutput,
            '',
            '请根据评审反馈修改你的输出。只输出修改后的完整结果。',
          ].join('\n');

          sendEvent('coordinator_info', {
            content: `修改中`,
            phase_status: 'running',
          });

          let reworked = '';
          for await (const chunk of reworkLLM.stream([
            { role: 'system', content: execAgent.systemPrompt },
            { role: 'user', content: reworkPrompt },
          ])) {
            if (chunk.content) reworked += chunk.content;
          }

          if (reworked) {
            // Replace the original executor entry in phaseResults with the reworked one
            // and push the rework event
            phaseResults.push({
              phase: execPhase.phase,
              agentId: execAgent.id,
              agent: execAgent.name,
              content: reworked,
              status: 'success',
              reworkRound,
            });
            phaseContext.push(`【${execAgent.name}(退修R${reworkRound})】: ${reworked}`);

            // ── Re-review the reworked output ──
            sendEvent('coordinator_info', {
              content: `再审核`,
              phase_status: 'running',
            });

            const reReviewLLM = createLLM({ ...config, temperature: 0.3, maxTokens: 1536, reasoningEffort: 'none' });
            const reReviewPrompt = [
              `重新审核: ${phase.title}`,
              `原始任务: ${phase.task}`,
              `预期产出: ${phase.expected_output}`,
              '',
              `原始用户需求: ${userText}`,
              '',
              `执行者修改后的产出:`,
              reworked.length > 2000 ? reworked.slice(0, 2000) + '…' : reworked,
              '',
              `上一轮审核意见:`,
              currentReviewContent,
              '',
              '请审核修改后的产出。如果问题已解决，回复"通过"并简要说明；如果仍有问题，标注严重程度（阻塞/建议）并给出具体修改点。',
            ].join('\n');

            let reReviewContent = '';
            for await (const chunk of reReviewLLM.stream([
              { role: 'system', content: agent.systemPrompt },
              { role: 'user', content: reReviewPrompt },
            ])) {
              if (chunk.content) reReviewContent += chunk.content;
            }

            phaseResults.push({
              phase: phase.phase,
              agentId: agent.id,
              agent: agent.name,
              content: reReviewContent,
              status: 'success',
              reworkRound,
            });
            phaseContext.push(`【${agent.name}(再审R${reworkRound})】: ${reReviewContent}`);

            // Update for potential next iteration
            currentReviewContent = reReviewContent;
            currentReviewStatus = 'success';

            sendEvent('coordinator_info', {
              content: /通过/.test(reReviewContent)
                ? `  ✓ 通过`
                : `  △ 仍有问题`,
              phase_status: /通过/.test(reReviewContent) ? 'done' : 'running',
            });
          }
        } catch (err) {
          log.error(`退修第 ${reworkRound} 轮失败: ${err.message}`);
          break;
        }
      }
    }
  }

  // ── Final: stream reviewed output to user ──
  const execAgent = agentManager.getAgent('__builtin_executor__') || agentManager.getActiveAgent() || {};
  // Only use executor output — never fall back to reviewer or researcher content
  const execResults = phaseResults.filter(r => r.status === 'success' && r.agent === '执行者' && r.content?.trim());
  const finalContent = execResults.pop()?.content || '';
  log.log(`[最终输出] 内容长度=${finalContent.length} 阶段数=${phaseResults.length} 成功=${phaseResults.filter(r=>r.status==='success').map(r=>r.agent).join(',')} 执行者产出=${execResults.length}`);

  if (finalContent) {
    const chunkSize = 10;
    log.log(`[最终输出] 开始流式发送, ${Math.ceil(finalContent.length/chunkSize)} 块`);
    for (let i = 0; i < finalContent.length; i += chunkSize) {
      sendEvent('expert_chunk', {
        expert_id: execAgent.id || 'executor',
        expert_name: execAgent.name || '执行者',
        expert_icon: execAgent.icon || '⚡',
        expert_color: execAgent.color || '#22C55E',
        content: finalContent.slice(i, i + chunkSize),
      });
      await new Promise(r => setTimeout(r, 30));
    }
    log.log(`[最终输出] 流式完成, 发送 expert_done (streamed)`);
    // Signal completion only — content was already streamed via expert_chunk above.
    // Prevents the client from replacing incrementally-built text with a flash.
    sendEvent('expert_done', {
      expert_id: execAgent.id || 'executor',
      expert_name: execAgent.name || '执行者',
      expert_icon: execAgent.icon || '⚡',
      expert_color: execAgent.color || '#22C55E',
      _streamed: true,
    });
  } else {
    log.warn(`[最终输出] 内容为空! 阶段=${phaseResults.map(r=>r.agent+'/'+r.status).join(',')}`);
    sendEvent('expert_error', {
      expert_id: execAgent.id || 'executor',
      expert_name: execAgent.name || '执行者',
      error: '执行者未产出内容。可能是前置阶段（如研究员）未提供有效数据。试着重试或简化问题。',
    });
  }

  // Distill session memory to agent private memories
  if (sessionMemory) {
    for (const pr of phaseResults.filter(r => r.status === 'success')) {
      sessionMemory.put(convId, {
        agentId: pr.agentId || pr.agent,
        content: pr.content,
        phase: `phase_${pr.phase}`,
      });
    }
    try {
      await sessionMemory.endSession(convId, agentManager);
    } catch (err) {
      log.warn(`会话记忆蒸馏失败: ${err.message}`);
    }
  }

  sendEvent('coordinator_done', {
    replies: phaseResults.map(r => ({
      expert_id: r.agent,
      expert_name: r.agent,
      content: r.content,
    })),
    summary: finalContent?.slice(0, 100) || '协作完成',
    elapsed: ((Date.now() - t0) / 1000).toFixed(1),
  });
}

// ── Main entry ──

export async function runCoordinator({
  config, messages, convId, agentIds, mentionedIds,
  groupSettings, agentManager, sessionMemory, memoryStore, ragPipeline, sendEvent,
}) {
  const mode = groupSettings?.mode || 'discussion';

  if (mode === 'collaboration') {
    return runCollaborationMode({
      config, messages, convId, agentIds,
      agentManager, sessionMemory, memoryStore, sendEvent,
    });
  }

  // Default: discussion mode
  return runDiscussionMode({
    config, messages, convId, agentIds, mentionedIds,
    agentManager, sessionMemory, memoryStore, sendEvent,
  });
}

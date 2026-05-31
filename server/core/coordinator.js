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
    sendEvent('coordinator_info', { content: `第 ${context.round} 轮讨论 — ${participants.length} 个角色参与` });

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
            { role: 'assistant', content: `[其他成员的讨论]\n${context.previousReplies}` },
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
  sendEvent('coordinator_info', { content: '各角色正在审阅彼此回复...' });
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
"对比三个低代码平台，输出选型报告" → 3 阶段：研究员(搜各平台信息) → 执行者(整理对比报告) → 评审(审核数据+推荐合理性，只给意见不重写)
"写一个Python排序函数" → 1 阶段：执行者
"帮我制定五一长沙避开人流的行程" → 3 阶段：研究员(查人流规律+预约政策) → 执行者(制定行程) → 评审(检查可执行性，只提修改点)

## 输出格式（严格 JSON）
{ "summary": "一句话总结", "phases": [{ "phase": 1, "title": "阶段名", "assigned_to": "研究员|执行者|评审", "task": "具体任务", "expected_output": "预期产出" }] }

只输出 JSON。`;

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
  sendEvent('coordinator_info', { content: '🧠 记忆官正在检索相关背景...' });
  const memoryKeeper = agentManager.getAgent('__builtin_memory_keeper__');
  let contextInfo = '';
  if (memoryKeeper) {
    try {
      const memStore = agentManager._getEffectiveStore(memoryKeeper);
      const facts = memStore?.search?.(userText) || [];
      if (facts.length > 0) {
        contextInfo = facts.map(f => `- ${f.content || f.text || f.fact}`).join('\n');
        sendEvent('expert_done', {
          expert_id: memoryKeeper.id,
          expert_name: memoryKeeper.name,
          expert_icon: memoryKeeper.icon,
          expert_color: memoryKeeper.color,
          content: `📋 已知背景:\n${contextInfo}`,
        });
      }
    } catch { /* memory search not critical */ }
  }

  // ── Phase 1: 管理者拆解任务 ──
  sendEvent('coordinator_info', { content: '🎯 管理者正在拆解任务...' });
  const managerAgent = agentManager.getAgent('__builtin_manager__');
  if (!managerAgent) {
    sendEvent('coordinator_error', { content: '内置"管理者"Agent 未初始化，请在设置面板确认' });
    return;
  }

  const plannerLLM = createLLM({ ...config, temperature: 0.5, maxTokens: 1024 });
  const { content: planText } = await plannerLLM.invoke([
    { role: 'system', content: MANAGER_PROMPT },
    { role: 'user', content: `用户需求: ${userText}\n${contextInfo ? `背景信息:\n${contextInfo}` : ''}` },
  ]);

  // Parse plan
  let plan;
  try {
    plan = JSON.parse((planText || '').trim());
  } catch {
    const m = (planText || '').match(/\{[\s\S]*\}/);
    plan = m ? (() => { try { return JSON.parse(m[0]); } catch { return null; } })() : null;
  }

  // Fallback: create default 1-phase plan if parsing failed
  if (!plan?.phases?.length) {
    sendEvent('coordinator_info', { content: '任务简单，直接执行...' });
    plan = { summary: userText.slice(0, 50), phases: [{ phase: 1, title: '执行', assigned_to: '执行者', task: userText, expected_output: '直接回复' }] };
  }

  // Sanity check: if plan still has only 1 phase for a long query, ask LLM
  if (plan.phases.length === 1 && userText.length > 25) {
    try {
      const checkLLM = createLLM({ ...config, temperature: 0, maxTokens: 4 });
      const { content: check } = await checkLLM.invoke([
        { role: 'system', content: '判断这个任务是否需要先查资料或需要质量审核。只回答 YES 或 NO。' },
        { role: 'user', content: userText },
      ]);
      log.log(`复杂度检查: "${userText.slice(0,30)}..." → "${(check||'').trim()}"`);
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

  // Show plan as readable list, not raw JSON
  const planDisplay = `📋 **${plan.summary}**\n\n${
    plan.phases.map(p =>
      `**阶段 ${p.phase}** — ${p.assigned_to}\n> ${p.task}\n> 预期产出: ${p.expected_output}`
    ).join('\n\n')
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
    content: `📋 执行计划:\n${plan.phases.map(p => `  ${p.phase}. [${p.assigned_to}] ${p.title} — ${p.task}`).join('\n')}`,
  });

  // ── Phase 2: 是否需要用户确认？ ──
  const needsConfirm = plan.phases.length > 2;
  if (needsConfirm) {
    sendEvent('plan_ready', { plan, context_info: contextInfo, conv_id: convId });
    const confirmed = await waitForPlanConfirmation(convId);
    if (!confirmed) {
      sendEvent('coordinator_info', { content: '⏸ 用户取消了执行计划' });
      sendEvent('coordinator_done', { replies: [], summary: '用户取消了执行计划', elapsed: ((Date.now() - t0) / 1000).toFixed(1) });
      return;
    }
    sendEvent('coordinator_info', { content: '✅ 用户已确认，开始执行...' });
  } else {
    sendEvent('coordinator_info', { content: '任务简单，直接执行...' });
  }

  // ── Phase 3-N: 按顺序执行各阶段 ──
  const phaseResults = [];
  const phaseContext = [contextInfo].filter(Boolean);

  const totalPhases = plan.phases.length;
  sendEvent('coordinator_start', { phases: plan.phases.map(p => ({ title: p.title, assigned_to: p.assigned_to })) });

  for (const phase of plan.phases) {
    const assignedTo = phase.assigned_to;
    sendEvent('coordinator_info', { content: `正在: ${assignedTo} ${phase.title}`, phase: phase.phase, agent: assignedTo, phase_status: 'running' });

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

    const taskPrompt = [
      `📋 当前阶段: ${phase.title}`,
      `任务: ${phase.task}`,
      `预期产出: ${phase.expected_output}`,
      '',
      `原始用户需求: ${userText}`,
      '',
      prevOutputs.length > 0 ? `前面阶段的产出:` : '',
      ...prevOutputs,
      '',
      isReview ? '请给出审核意见（格式：结论 + 具体修改点）。' : '请完成当前阶段的任务，输出你的结果。',
    ].join('\n');

    let attempts = 0;
    const maxAttempts = 2;
    let lastError = null;

    while (attempts < maxAttempts) {
      try {
        sendEvent('coordinator_info', {
          content: `▶ 阶段 ${phase.phase}/${plan.phases.length}: ${phase.title} (${agent.name})${attempts > 0 ? ' [重试]' : ''}`,
        });

        const llm = createLLM({ ...phaseConfig, temperature: isReview ? 0.3 : 0.5, maxTokens: maxTok });

        // Reviewer gets a different message format: identity in system, task + previous output in user
        const msgs = isReview
          ? [
              { role: 'system', content: agent.systemPrompt },
              { role: 'user', content: taskPrompt },
            ]
          : [
              { role: 'system', content: `${agent.systemPrompt}\n\n---\n\n${taskPrompt}` },
              { role: 'user', content: userText },
            ];

        // All phases run silently — output buffered until after review
        let fullContent = '';
        for await (const chunk of llm.stream(msgs)) {
          if (chunk.content) fullContent += chunk.content;
        }

        sendEvent('coordinator_info', { content: `✓ ${assignedTo} 完成`, phase: phase.phase, agent: assignedTo, phase_status: 'done' });

        phaseResults.push({
          phase: phase.phase,
          agentId: agent.id,
          agent: agent.name,
          content: fullContent,
          status: 'success',
        });
        phaseContext.push(`【${agent.name}】: ${fullContent}`);
        break;
      } catch (err) {
        log.error(`阶段 ${phase.phase} 尝试 ${attempts + 1} 失败:`, err.message);
        lastError = err;
        attempts++;
        if (attempts >= maxAttempts) {
          const errMsg = `阶段 ${phase.phase} (${agent.name}) 执行失败: ${err.message}`;
          sendEvent('coordinator_info', { content: `⚠ ${errMsg}` });
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

    // If reviewer rejects, send back to executor (check last result)
    if (assignedTo === '评审' && phaseResults.length >= 2) {
      const reviewResult = phaseResults[phaseResults.length - 1];
      if (reviewResult.status === 'success' && reviewResult.content) {
        const needsRework = /(需修改|需调整|需修正|需要重做|🔴|阻塞)/.test(reviewResult.content);
        if (needsRework) {
          sendEvent('coordinator_info', { content: '🔄 评审要求修改，返回执行者修改中...', phase_status: 'running' });
          const execPhase = plan.phases[plan.phases.length - 2];
          if (execPhase) {
            const execAgent = agentManager.getAgent('__builtin_executor__');
            if (execAgent) {
              try {
                const reworkLLM = createLLM({ ...config, temperature: 0.5, maxTokens: 2048 });
                const reworkPrompt = `评审反馈: ${reviewResult.content}\n\n原始产出: ${phaseContext[phaseContext.length - 2]}\n\n请根据评审反馈修改你的输出。`;
                const { content: reworked } = await reworkLLM.invoke([
                  { role: 'system', content: execAgent.systemPrompt },
                  { role: 'user', content: reworkPrompt },
                ]);
                phaseResults.push({ phase: execPhase.phase, agentId: execAgent.id, agent: execAgent.name, content: reworked, status: 'success' });
              } catch { /* rework failed */ }
            }
          }
        }
      }
    }
  }

  // ── Final: stream reviewed output to user ──
  const execAgent = agentManager.getAgent('__builtin_executor__') || agentManager.getActiveAgent() || {};
  const finalContent = phaseResults.filter(r => r.status === 'success' && r.agent === '执行者').pop()?.content
    || phaseResults.filter(r => r.status === 'success').pop()?.content || '';
  log.log(`[最终输出] 内容长度=${finalContent.length} 阶段数=${phaseResults.length} 成功=${phaseResults.filter(r=>r.status==='success').map(r=>r.agent).join(',')}`);

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
    log.log(`[最终输出] 流式完成, 发送 expert_done`);
    sendEvent('expert_done', {
      expert_id: execAgent.id || 'executor',
      expert_name: execAgent.name || '执行者',
      expert_icon: execAgent.icon || '⚡',
      expert_color: execAgent.color || '#22C55E',
      content: finalContent,
    });
  } else {
    log.warn(`[最终输出] 内容为空!`);
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

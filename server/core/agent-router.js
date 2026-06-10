/**
 * agent-router.js — 多 Agent 编排路由 (P2)
 *
 * 管家 Sonder 根据用户意图路由到专业 Agent:
 *   FileAgent    — 文件管理、搜索、索引
 *   ScheduleAgent — 日历、提醒、闹钟
 *   MailAgent    — 邮件读取、草稿
 *   CodeAgent    — 编程协助
 *   default      — 通用对话 (Sonder 管家)
 *
 * 每个 Agent 有独立的 system prompt、工具集、记忆存储。
 */

import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('agent:router');

// ── Agent Definitions ──

const AGENT_DEFS = {
  file: {
    id: 'file',
    name: 'FileAgent',
    icon: '📁',
    systemPrompt: `你是 Sonder 文件管家。帮助用户管理本地文件。
你可以: 搜索文件、索引目录、读取文件内容、归类整理。
回复简洁实用，直接给出文件路径或操作建议。`,
    tools: ['list_files', 'search_files', 'read_file', 'index_file', 'remove_file'],
    router: /文件|目录|文件夹|找.*文档|索引|搜索文件|文件在哪|有哪些文件/,
  },
  schedule: {
    id: 'schedule',
    name: 'ScheduleAgent',
    icon: '📅',
    systemPrompt: `你是 Sonder 日程管家。帮助用户管理时间和提醒。
你可以: 创建提醒、查看日程、设置闹钟。
时间相关的问题请给出日期+时间+内容，回复简洁当面。`,
    tools: ['cron_create', 'cron_list', 'cron_delete'],
    router: /提醒|明天|几点|日程|日历|闹钟|定时|别忘了|记得|约.*时间/,
  },
  mail: {
    id: 'mail',
    name: 'MailAgent',
    icon: '✉️',
    systemPrompt: `你是 Sonder 邮件助手。帮助用户管理邮件。
目前邮件功能需要用户配置 IMAP/SMTP 账户。
你可以: 协助撰写邮件草稿、提醒查看邮件、格式化邮件内容。`,
    tools: [],
    router: /邮件|发邮件|收件箱|回复.*邮件|email|mail/,
  },
  code: {
    id: 'code',
    name: 'CodeAgent',
    icon: '💻',
    systemPrompt: `你是 Sonder 编程助手。帮助用户解决编程问题。
你可以: 解释代码、调试错误、提供代码示例。
使用技术术语（用户在编程领域有经验），回复直接给代码和分析。`,
    tools: ['list_files', 'search_files', 'read_file'],
    router: /代码|编程|bug|error|报错|函数|API|怎么写|这段代码|debug/,
  },
};

// ── Router ──

function matchAgent(userInput) {
  if (!userInput) return null;
  const scores = [];
  for (const [id, def] of Object.entries(AGENT_DEFS)) {
    const match = userInput.match(def.router);
    if (match) {
      scores.push({ id, def, score: match[0].length }); // Longer match = more specific
    }
  }
  scores.sort((a, b) => b.score - a.score);
  return scores[0] || null;
}

/**
 * Route a user message to the appropriate agent.
 * Returns { agentId, agentDef, shouldMultiAgent }.
 */
export function route(userInput) {
  const match = matchAgent(userInput);

  if (!match) {
    return { agentId: 'default', agentDef: null, shouldMultiAgent: false };
  }

  // If high confidence match, use specialist
  if (match.score > 5) {
    return {
      agentId: match.id,
      agentDef: match.def,
      shouldMultiAgent: false,
    };
  }

  return { agentId: 'default', agentDef: null, shouldMultiAgent: false };
}

/**
 * Get specialist agent system prompt with user context.
 */
export function getAgentSystemPrompt(agentId, context = {}) {
  const def = AGENT_DEFS[agentId];
  if (!def) return null;

  let prompt = def.systemPrompt;

  if (context.userProfile) {
    prompt += '\n\n[用户环境]\n';
    if (context.currentDir) prompt += `- 当前目录: ${context.currentDir}\n`;
    if (context.recentFiles) prompt += `- 最近文件: ${context.recentFiles.slice(0, 5).join(', ')}\n`;
  }

  return prompt;
}

/**
 * Get tools available to a specialist agent.
 */
export function getAgentTools(agentId) {
  const def = AGENT_DEFS[agentId];
  return def?.tools || [];
}

/**
 * List all registered specialist agents.
 */
export function listAgents() {
  return Object.entries(AGENT_DEFS).map(([id, def]) => ({
    id,
    name: def.name,
    icon: def.icon,
    toolCount: def.tools.length,
    router: def.router.source,
  }));
}

// ── Multi-Agent Collaboration ──

/**
 * Determine if a user request would benefit from multi-agent collaboration.
 * Returns array of {agentId, role, prompt} for the coordinator.
 */
export function planCollaboration(userInput) {
  const specializations = [];

  for (const [id, def] of Object.entries(AGENT_DEFS)) {
    if (def.router.test(userInput)) {
      specializations.push({
        agentId: id,
        name: def.name,
        icon: def.icon,
        systemPrompt: def.systemPrompt,
        tools: def.tools,
      });
    }
  }

  if (specializations.length <= 1) return null; // Single agent is enough

  return {
    agents: specializations,
    coordinator: {
      prompt: `你是 Sonder 管家。用户的问题涉及多个专业领域。请协调以下 Agent 共同完成: ${specializations.map(a => a.name).join('、')}。
先让各 Agent 独立分析，然后综合给出最终建议。`,
    },
  };
}

export { AGENT_DEFS };

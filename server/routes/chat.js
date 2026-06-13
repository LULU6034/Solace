// server/routes/chat.js — 对话路由
// 从 server/index.js 拆分出来的 chat handler 骨架
// MVP: 仍由 index.js 直接调用，此文件预留后续拆分

import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('routes:chat');

/** 处理 agent_chat 事件 */
export async function handleChat(event, ctx) {
  const { sessionId, message, config } = event;

  log.info('chat 事件', { sessionId, msgLen: message?.length });

  // MVP 阶段：委托回 index.js 的 runAgentLoop
  // 后续迁移：将 runAgentLoop 逻辑迁入此处
  if (ctx.runAgent) {
    return ctx.runAgent(sessionId, message, config);
  }

  return { error: 'Agent 未就绪' };
}

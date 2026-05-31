/**
 * dm-router.js — Agent 私信路由器
 *
 * 1v1 Agent DM。双向写入 dm/{peerId}.md 文件。
 * 支持异步回复——接收方 Agent 收到 DM 后可回复。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('dm-router');

const MAX_REPLIES = 3;       // Max reply rounds
const REPLY_COOLDOWN = 10_000; // 10s cooldown between replies

export class DmRouter {
  constructor({ agentsDir, agentManager, eventBus }) {
    this.agentsDir = agentsDir;
    this.agentManager = agentManager;
    this.eventBus = eventBus;
  }

  /** Get DM file path for an agent pair */
  _dmPath(agentId, peerId) {
    const dir = path.join(this.agentsDir, agentId, 'dm');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${peerId}.md`);
  }

  /** Send a DM from one agent to another */
  async sendDM({ fromAgentId, fromName, toAgentId, body }) {
    if (fromAgentId === toAgentId) {
      throw new Error('不能给自己发私信');
    }

    const timestamp = new Date().toISOString();
    const msgLine = `### ${fromName} | ${new Date(timestamp).toLocaleString('zh-CN')}\n\n${body}\n\n---\n`;

    // Write to both sides
    const senderPath = this._dmPath(fromAgentId, toAgentId);
    const receiverPath = this._dmPath(toAgentId, fromAgentId);

    fs.appendFileSync(senderPath, msgLine, 'utf-8');
    fs.appendFileSync(receiverPath, msgLine, 'utf-8');

    log.log(`DM: ${fromName} → ${toAgentId.slice(0, 8)}`);

    // Emit event for async reply
    this.eventBus?.emit('dm_received', {
      fromAgentId, fromName, toAgentId, body, timestamp,
    });

    return { fromAgentId, toAgentId, timestamp };
  }

  /** Read DM history between two agents */
  readDM(agentId, peerId, limit = 50) {
    const dmPath = this._dmPath(agentId, peerId);
    if (!fs.existsSync(dmPath)) return '';

    const content = fs.readFileSync(dmPath, 'utf-8');
    // Return last N messages
    const blocks = content.split('---\n').filter(b => b.trim());
    return blocks.slice(-Math.min(limit, blocks.length)).join('---\n').trim() + '\n---';
  }

  /** List DM peers for an agent */
  listPeers(agentId) {
    const dir = path.join(this.agentsDir, agentId, 'dm');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''));
  }

  /** Get reply cooldown (ms) */
  get replyCooldown() { return REPLY_COOLDOWN; }
  /** Get max reply rounds */
  get maxReplies() { return MAX_REPLIES; }
}

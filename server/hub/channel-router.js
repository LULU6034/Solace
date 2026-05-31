/**
 * channel-router.js — Agent 频道（群聊）路由器
 *
 * 参考 OpenHanako hub/channel-router.js:
 *   - 频道即 Markdown 文件: frontmatter(members) + 消息流
 *   - Agent 加入/离开频道
 *   - 消息投递到频道所有成员
 */
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('channel-router');

export class ChannelRouter {
  constructor({ channelsDir, agentManager, eventBus }) {
    this.channelsDir = channelsDir;
    this.agentManager = agentManager;
    this.eventBus = eventBus;
    this._writeLocks = new Map(); // channelId → Promise chain for serialized writes
    fs.mkdirSync(channelsDir, { recursive: true });
  }

  /** Create a new channel */
  createChannel({ name, description = '', members = [], createdBy = 'system' }) {
    const id = `ch_${uuidv4().slice(0, 8)}`;
    const channelPath = path.join(this.channelsDir, `${id}.md`);

    const content = `---
id: ${id}
name: ${name}
description: ${description}
members: [${members.join(', ')}]
createdBy: ${createdBy}
createdAt: ${new Date().toISOString()}
---

# ${name}

> ${description}

频道创建于 ${new Date().toLocaleString('zh-CN')}
`;

    fs.writeFileSync(channelPath, content, 'utf-8');
    log.log(`频道已创建: ${name} (${id})`);

    this.eventBus?.emit('channel_created', { id, name, members });
    return { id, name, members, path: channelPath };
  }

  /** Post a message to a channel (serialized per-channel to prevent write corruption) */
  async postMessage(channelId, { senderAgentId, senderName, body }) {
    const channelPath = path.join(this.channelsDir, `${channelId}.md`);
    if (!fs.existsSync(channelPath)) {
      throw new Error(`频道不存在: ${channelId}`);
    }

    // Serialize writes per channel to prevent interleaving
    const prev = this._writeLocks.get(channelId) || Promise.resolve();
    const writeOp = prev.then(() => {
      const timestamp = new Date().toISOString();
      const msgBlock = `\n### ${senderName} | ${new Date(timestamp).toLocaleString('zh-CN')}\n\n${body}\n\n---\n`;
      fs.appendFileSync(channelPath, msgBlock, 'utf-8');
    });
    this._writeLocks.set(channelId, writeOp);
    await writeOp;

    const timestamp = new Date().toISOString();

    // Read channel metadata to notify members
    const content = fs.readFileSync(channelPath, 'utf-8');
    const metaMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (metaMatch) {
      const members = this._parseYamlList(metaMatch[1], 'members');
      this.eventBus?.emit('channel_message', {
        channelId, senderAgentId, senderName, body, timestamp, members,
      });
    }

    log.log(`频道消息: ${channelId} <- ${senderName}`);
    return { channelId, timestamp };
  }

  /** Read channel history */
  readChannel(channelId, limit = 50) {
    const channelPath = path.join(this.channelsDir, `${channelId}.md`);
    if (!fs.existsSync(channelPath)) return null;

    const content = fs.readFileSync(channelPath, 'utf-8');
    const metaMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const meta = metaMatch ? this._parseYamlMeta(metaMatch[1]) : {};

    // Extract messages (everything after the second ---)
    const bodyStart = content.indexOf('---\n', content.indexOf('---\n') + 4) + 4;
    const body = content.slice(bodyStart);

    return {
      id: meta.id || channelId,
      name: meta.name || '',
      members: meta.members || [],
      messages: body.trim(),
    };
  }

  /** List all channels */
  listChannels() {
    const files = fs.readdirSync(this.channelsDir).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const content = fs.readFileSync(path.join(this.channelsDir, f), 'utf-8');
      const metaMatch = content.match(/^---\n([\s\S]*?)\n---/);
      const meta = metaMatch ? this._parseYamlMeta(metaMatch[1]) : {};
      const id = f.replace('.md', '');
      return { id, name: meta.name || id, members: meta.members || [] };
    });
  }

  /** Add member to channel */
  addMember(channelId, agentId) {
    const channelPath = path.join(this.channelsDir, `${channelId}.md`);
    if (!fs.existsSync(channelPath)) return false;
    let content = fs.readFileSync(channelPath, 'utf-8');
    content = content.replace(/members:\s*\[([^\]]*)\]/, (match, members) => {
      const list = members.split(',').map(s => s.trim()).filter(Boolean);
      if (!list.includes(agentId)) list.push(agentId);
      return `members: [${list.join(', ')}]`;
    });
    fs.writeFileSync(channelPath, content, 'utf-8');
    return true;
  }

  _parseYamlMeta(yamlText) {
    const meta = {};
    for (const line of yamlText.split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim();
      let value = line.slice(colon + 1).trim();
      if (value.startsWith('[')) {
        value = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      }
      meta[key] = value;
    }
    return meta;
  }

  _parseYamlList(yamlText, key) {
    const meta = this._parseYamlMeta(yamlText);
    return Array.isArray(meta[key]) ? meta[key] : [];
  }
}

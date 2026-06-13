/**
 * agent-tools.js — Agent 间通信工具
 *
 * channel_read / channel_post — 频道群聊
 * dm_send / dm_read — Agent 私信
 * agent_list — 查看其他 Agent
 */
let _channelRouter = null;
let _dmRouter = null;
let _agentManager = null;

export function setAgentServices({ channelRouter, dmRouter, agentManager }) {
  _channelRouter = channelRouter;
  _dmRouter = dmRouter;
  _agentManager = agentManager;
}

export const agentList = {
  name: 'agent_list',
  description: '列出所有可用的 Agent 及其能力。用于了解可以委派任务给谁。',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async invoke() {
    if (!_agentManager) return 'Agent 管理系统未初始化';
    const agents = _agentManager.listAgents();
    const currentId = _agentManager.activeAgentId;
    return agents.map(a =>
      `${a.id === currentId ? '👉 ' : '   '}${a.name} (${a.id.slice(0, 8)})` +
      ` | 模型: ${a.config.provider}/${a.config.model}` +
      ` | 记忆: ${a.memoryCount} 条`
    ).join('\n');
  },
};

export const channelRead = {
  name: 'channel_read',
  description: '读取频道消息历史。参数 channel_id: 频道 ID',
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: '频道 ID' },
    },
    required: ['channel_id'],
  },
  async invoke({ channel_id }) {
    if (!_channelRouter) return '频道系统未初始化';
    const channel = _channelRouter.readChannel(channel_id);
    if (!channel) return `频道不存在: ${channel_id}`;
    return `【${channel.name}】(成员: ${channel.members.join(', ')})\n\n${channel.messages || '(暂无消息)'}`;
  },
};

export const channelPost = {
  name: 'channel_post',
  description: '向频道发送消息。参数 channel_id: 频道 ID，body: 消息内容',
  parameters: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: '频道 ID' },
      body: { type: 'string', description: '消息内容' },
    },
    required: ['channel_id', 'body'],
  },
  async invoke({ channel_id, body }) {
    if (!_channelRouter) return '频道系统未初始化';
    if (!body?.trim()) return '消息不能为空';
    const result = _channelRouter.postMessage(channel_id, {
      senderAgentId: 'current',
      senderName: 'Agent',
      body: body.trim(),
    });
    return `消息已发送到频道 ${channel_id}`;
  },
};

export const channelList = {
  name: 'channel_list',
  description: '列出所有可用频道',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async invoke() {
    if (!_channelRouter) return '频道系统未初始化';
    const channels = _channelRouter.listChannels();
    if (!channels.length) return '暂无频道';
    return channels.map(c =>
      `- ${c.name} (${c.id}) | 成员: ${c.members.join(', ')}`
    ).join('\n');
  },
};

export const dmSend = {
  name: 'dm_send',
  description: '给另一个 Agent 发送私信。参数 to_agent_name: 目标 Agent 名称或 ID，body: 消息内容',
  parameters: {
    type: 'object',
    properties: {
      to_agent_name: { type: 'string', description: '目标 Agent 名称或 ID 前缀' },
      body: { type: 'string', description: '消息内容' },
    },
    required: ['to_agent_name', 'body'],
  },
  async invoke({ to_agent_name, body }) {
    if (!_dmRouter || !_agentManager) return 'DM 系统未初始化';
    if (!body?.trim()) return '消息不能为空';

    // Resolve target agent
    const agents = _agentManager.listAgents();
    const target = agents.find(a =>
      a.id.startsWith(to_agent_name) || a.name === to_agent_name
    );
    if (!target) return `找不到 Agent: ${to_agent_name}`;

    const current = _agentManager.getActiveAgent();
    if (!current) return '当前无活跃 Agent';

    try {
      await _dmRouter.sendDM({
        fromAgentId: current.id,
        fromName: current.name,
        toAgentId: target.id,
        body: body.trim(),
      });
      return `已向 ${target.name} 发送私信`;
    } catch (err) {
      return `发送失败: ${err.message}`;
    }
  },
};

export const dmRead = {
  name: 'dm_read',
  description: '读取与另一个 Agent 的私信历史。参数 peer_name: 对方 Agent 名称或 ID 前缀',
  parameters: {
    type: 'object',
    properties: {
      peer_name: { type: 'string', description: '对方 Agent 名称或 ID 前缀' },
    },
    required: ['peer_name'],
  },
  async invoke({ peer_name }) {
    if (!_dmRouter || !_agentManager) return 'DM 系统未初始化';

    const agents = _agentManager.listAgents();
    const peer = agents.find(a => a.id.startsWith(peer_name) || a.name === peer_name);
    if (!peer) return `找不到 Agent: ${peer_name}`;

    const current = _agentManager.getActiveAgent();
    if (!current) return '当前无活跃 Agent';

    const history = _dmRouter.readDM(current.id, peer.id, 20);
    return history || `(与 ${peer.name} 暂无私信记录)`;
  },
};

export function getAgentTools() {
  return [agentList, channelRead, channelPost, channelList, dmSend, dmRead];
}

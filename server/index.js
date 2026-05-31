/**
 * 案 — Node.js Agent Server
 * Hono HTTP + WebSocket, 由 Electron 主进程 spawn
 *
 * 协议: WebSocket JSON 消息, 替代 Python stdin/stdout JSON-line
 *
 * 请求类型:
 *   agent_chat         — 单 Agent 对话
 *   agent_chat_group   — 群聊/多 Expert 模式
 *   tool_approval      — 工具审批回复
 *   index_file         — 索引文件到 RAG
 *   search_rag         — 搜索 RAG
 *   get_memory_count   — 记忆数量
 *   clear_memory       — 清空记忆
 *   ping               — 健康检查
 *
 * 事件类型:
 *   chunk, reasoning_chunk, agent_action, agent_observation,
 *   done, error, tool_approval_request, memory_updated,
 *   coordinator_info, coordinator_done, coordinator_error,
 *   expert_*, security_confirm_required
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { createModuleLogger } from './lib/debug-log.js';

const _require = createRequire(import.meta.url);

// Lazy imports (matching Python's lazy import pattern for fast startup)
let _runAgent = null;
let _runAgentGroup = null;
let _FactStore = null;
let _MemoryStore = null;
let _RAGPipeline = null;
let _Hub = null;
let _AgentManager = null;
let _SkillManager = null;
let _PluginManager = null;
let _SessionMemory = null;

const log = createModuleLogger('server');

// ── Hono app (HTTP fallback) ──
const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }));

app.get('/stats', (c) => {
  const store = getMemoryStore();
  return c.json({
    memoryCount: store ? store.count() : 0,
    uptime: process.uptime(),
    pid: process.pid,
    platform: process.platform,
    cronJobs: _Hub?.scheduler?.cron?.list()?.length || 0,
    activeHeartbeats: _Hub?.scheduler?.heartbeats?.size || 0,
    agentCount: _AgentManager?.agentCount || 0,
    activeAgent: _AgentManager?.getActiveAgent()?.name || 'none',
    skillCount: _SkillManager?.count || 0,
    pluginCount: _PluginManager?.count || 0,
  });
});

// ── Agent REST API ──
app.get('/api/agents', (c) => {
  const agents = _AgentManager?.listAgents() || [];
  return c.json(agents);
});

app.post('/api/agents', async (c) => {
  const body = await c.req.json();
  const agent = await _AgentManager?.createAgent({
    name: body.name || '新宠物',
    character: body.character || 'glassesDog',
    config: body.config || {},
  });
  return c.json(agent ? { id: agent.id, name: agent.name } : { error: '创建失败' });
});

app.post('/api/agents/:id/switch', (c) => {
  const id = c.req.param('id');
  _AgentManager?.switchAgent(id);
  return c.json({ activeAgentId: _AgentManager?.activeAgentId });
});

app.delete('/api/agents/:id', (c) => {
  const id = c.req.param('id');
  try {
    _AgentManager?.deleteAgent(id);
    return c.json({ deleted: true });
  } catch (err) {
    return c.json({ deleted: false, error: err.message }, 400);
  }
});

// ── Skill REST API ──
app.get('/api/skills', (c) => {
  const skills = _SkillManager?.getAll().map(s => ({
    name: s.name,
    description: s.meta.description,
    trigger: s.meta.trigger,
    enabled: s.enabled,
    builtin: s.builtin,
  })) || [];
  return c.json(skills);
});

app.post('/api/skills/install', async (c) => {
  const body = await c.req.json();
  const { installSkill } = await import('./lib/skills/skill-installer.js');
  const targetDir = path.join(getPersistDir(), 'skills-user');
  const result = await installSkill(body.source || '', targetDir);
  if (result.success) {
    _SkillManager?.loadAll();
  }
  return c.json(result);
});

// ── Plugin REST API ──
app.get('/api/plugins', (c) => {
  const plugins = _PluginManager?.listPlugins() || [];
  return c.json(plugins);
});

app.post('/api/plugins/:id/activate', async (c) => {
  const id = c.req.param('id');
  try {
    await _PluginManager?.activatePlugin(id);
    return c.json({ activated: true });
  } catch (err) {
    return c.json({ activated: false, error: err.message }, 400);
  }
});

app.post('/api/plugins/:id/deactivate', async (c) => {
  const id = c.req.param('id');
  await _PluginManager?.deactivatePlugin(id);
  return c.json({ deactivated: true });
});

// ── Cron REST API ──
app.get('/api/cron', (c) => {
  const jobs = _Hub?.scheduler?.cron?.list() || [];
  return c.json(jobs);
});

app.post('/api/cron', async (c) => {
  const body = await c.req.json();
  const job = _Hub?.scheduler?.cron?.create({
    schedule: body.schedule || 'every 1h',
    prompt: body.prompt || '',
    label: body.label || '',
    actorAgentId: body.agentId || 'default',
  });
  return c.json(job);
});

app.delete('/api/cron/:id', (c) => {
  const id = c.req.param('id');
  const ok = _Hub?.scheduler?.cron?.delete(id) || false;
  return c.json({ deleted: ok });
});

app.get('/api/cron/:id/history', (c) => {
  const id = c.req.param('id');
  const history = _Hub?.scheduler?.cron?.getHistory(id, 20) || [];
  return c.json(history);
});

// ── WebSocket ──
const httpServer = createServer(app.fetch);
const wss = new WebSocketServer({ server: httpServer });

// Active sessions: sessionId → { ws, config, agents }
const sessions = new Map();

// Pending tool approvals: approvalId → { resolve, timer }
const pendingApprovals = new Map();

// ── Lazy initializers ──
function getFactStore() {
  if (!_FactStore) {
    const { FactStore } = _require('./lib/memory/fact-store.js');
    _FactStore = new FactStore(getPersistDir());
  }
  return _FactStore;
}

function getMemoryStore() {
  // Composite memory: FactStore (long-term) + MemoryTicker (recent window)
  if (!_MemoryStore) {
    _MemoryStore = {
      factStore: getFactStore(),
      ticker: null, // Phase 1: optional
      search(query, k = 5) {
        return this.factStore.search(query, k);
      },
      addFact(fact, tags = []) {
        return this.factStore.add({ fact, tags });
      },
      count() {
        return this.factStore.count();
      },
      clear() {
        this.factStore.clear();
      },
    };
    // Inject into tools module (breaks circular dependency via memory-store-ref.js)
    import('./lib/tools/memory-store-ref.js').then(m => m.setMemoryStore(_MemoryStore));
  }
  return _MemoryStore;
}

function getRAGPipeline() {
  if (!_RAGPipeline) {
    const { RAGPipeline } = _require('./lib/rag/pipeline.js');
    _RAGPipeline = new RAGPipeline(getPersistDir());
  }
  return _RAGPipeline;
}

function getPersistDir() {
  return process.env.AGENT_PERSIST_DIR || path.join(os.homedir(), '.ai-desktop-pet');
}

function getPort() {
  return parseInt(process.env.AGENT_PORT || '9876', 10);
}

// ── Message routing ──
function sendEvent(ws, eventType, data = {}, requestId = '') {
  if (ws.readyState !== ws.OPEN) return;
  const msg = { type: eventType, request_id: requestId, data };
  ws.send(JSON.stringify(msg));
}

async function handleAgentChat(ws, msg) {
  const requestId = msg.request_id || '';
  const config = msg.config || {};
  const messages = msg.messages || [];
  const convId = msg.conversation_id || 'default';
  const targetAgentId = msg.agent_id || _AgentManager?.activeAgentId;

  const agent = _AgentManager?.getAgent(targetAgentId);
  const agentConfig = { ...(agent?.config || {}), ...config }; // merge

  log.log(`agent_chat: agent=${agent?.name} provider=${agentConfig.provider} msgs=${messages.length}`);

  const send = (type, data) => sendEvent(ws, type, data, requestId);

  const waitApproval = (toolName, toolArgs) => {
    return new Promise((resolve) => {
      const approvalId = `${requestId}:${toolName}`;
      const timer = setTimeout(() => {
        pendingApprovals.delete(approvalId);
        resolve(false);
      }, 120_000);
      pendingApprovals.set(approvalId, { resolve, timer });
      send('tool_approval_request', { approval_id: approvalId, tool: toolName, input: toolArgs });
    });
  };

  try {
    if (!_runAgent) {
      const agentModule = await import('./core/agent.js');
      _runAgent = agentModule.runAgent;
    }

    // Inject per-agent personality
    const personalityMessages = agent
      ? agent.injectPersonality(messages)
      : messages;

    await _runAgent({
      config: agentConfig,
      messages: personalityMessages,
      convId,
      memoryStore: _AgentManager?._getEffectiveStore?.(agent) || agent?.factStore || getMemoryStore(),
      ragPipeline: getRAGPipeline(),
      sendEvent: send,
      waitApproval,
    });

    // Notify heartbeat of user activity
    if (agent) {
      const hb = _Hub?.scheduler?.heartbeats?.get(agent.id);
      if (hb) hb.notifyActivity();
    }
  } catch (err) {
    log.error(`agent_chat 失败: ${err.message}`);
    send('error', { content: err.message });
  }
}

async function handleAgentChatGroup(ws, msg) {
  const requestId = msg.request_id || '';
  const config = msg.config || {};
  const messages = msg.messages || [];
  const convId = msg.conversation_id || 'default';
  const agentIds = msg.agent_ids || [];
  const mentionedIds = msg.mentioned_ids || [];
  const groupSettings = msg.group_settings || {};

  log.log(`agent_chat_group: provider=${config.provider}, mode=${groupSettings.mode || 'discussion'}, agents=${agentIds.length}`);

  const send = (type, data) => sendEvent(ws, type, data, requestId);

  try {
    if (!_runAgentGroup) {
      const coordinatorModule = await import('./core/coordinator.js');
      _runAgentGroup = coordinatorModule.runCoordinator;
    }

    await _runAgentGroup({
      config,
      messages,
      convId,
      agentIds,
      mentionedIds,
      groupSettings,
      agentManager: _AgentManager,
      sessionMemory: _SessionMemory,
      memoryStore: getMemoryStore(),
      ragPipeline: getRAGPipeline(),
      sendEvent: send,
    });
  } catch (err) {
    log.error(`agent_chat_group 失败: ${err.message}`);
    send('coordinator_error', { content: err.message });
  }
}

// ── WebSocket connection handler ──
wss.on('connection', (ws) => {
  const sessionId = uuidv4();
  sessions.set(sessionId, { ws, createdAt: Date.now() });
  log.log(`WebSocket 连接: ${sessionId}`);

  // Send ready signal
  sendEvent(ws, 'ready', {
    persist_dir: getPersistDir(),
    session_id: sessionId,
    platform: process.platform,
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const msgType = msg.type || '';

    switch (msgType) {
      case 'agent_chat':
        handleAgentChat(ws, msg);
        break;
      case 'agent_chat_group':
        handleAgentChatGroup(ws, msg);
        break;
      case 'confirm_plan': {
        const { confirmPlan } = await import('./core/coordinator.js');
        confirmPlan(msg.conv_id || '', msg.confirmed !== false);
        break;
      }
      case 'tool_approval': {
        const approvalId = msg.approval_id || '';
        const approved = msg.approved === true;
        const pending = pendingApprovals.get(approvalId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingApprovals.delete(approvalId);
          pending.resolve(approved);
        }
        break;
      }
      case 'index_file': {
        try {
          const rag = getRAGPipeline();
          const chunks = rag.indexFile(msg.file_path || '');
          sendEvent(ws, 'file_indexed', { request_id: msg.request_id, chunks }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'error', { request_id: msg.request_id, content: err.message }, msg.request_id);
        }
        break;
      }
      case 'search_rag': {
        const rag = getRAGPipeline();
        const results = rag.search(msg.query || '', msg.k || 5);
        sendEvent(ws, 'rag_results', { request_id: msg.request_id, results }, msg.request_id);
        break;
      }
      case 'get_memory_count': {
        const store = getMemoryStore();
        sendEvent(ws, 'memory_count', { request_id: msg.request_id, count: store.count() }, msg.request_id);
        break;
      }
      case 'clear_memory': {
        getMemoryStore().clear();
        sendEvent(ws, 'memory_cleared', { request_id: msg.request_id }, msg.request_id);
        break;
      }
      case 'get_indexed_files': {
        const rag = getRAGPipeline();
        const files = rag.getIndexedFiles();
        sendEvent(ws, 'indexed_files', { request_id: msg.request_id, files }, msg.request_id);
        break;
      }
      case 'remove_file': {
        const rag = getRAGPipeline();
        rag.removeFile(msg.file_name || '');
        sendEvent(ws, 'file_removed', { request_id: msg.request_id }, msg.request_id);
        break;
      }
      // ── Cron ──
      case 'cron_create': {
        if (!_Hub) { sendEvent(ws, 'error', { content: 'Hub 未就绪' }, msg.request_id); break; }
        const job = _Hub.scheduler.cron.create({
          schedule: msg.schedule || 'every 1h',
          prompt: msg.prompt || '',
          label: msg.label || '',
          actorAgentId: msg.agent_id || 'default',
        });
        sendEvent(ws, 'cron_created', { request_id: msg.request_id, job }, msg.request_id);
        break;
      }
      case 'cron_list': {
        const jobs = _Hub?.scheduler?.cron?.list() || [];
        sendEvent(ws, 'cron_list', { request_id: msg.request_id, jobs }, msg.request_id);
        break;
      }
      case 'cron_delete': {
        if (!_Hub) { sendEvent(ws, 'error', { content: 'Hub 未就绪' }, msg.request_id); break; }
        const ok = _Hub.scheduler.cron.delete(msg.job_id || '') || false;
        sendEvent(ws, 'cron_deleted', { request_id: msg.request_id, job_id: msg.job_id, deleted: ok }, msg.request_id);
        break;
      }
      case 'cron_history': {
        const history = _Hub?.scheduler?.cron?.getHistory(msg.job_id || '', msg.limit || 20) || [];
        sendEvent(ws, 'cron_history', { request_id: msg.request_id, history }, msg.request_id);
        break;
      }
      // ── Heartbeat ──
      case 'heartbeat_start': {
        if (!_Hub) { sendEvent(ws, 'error', { content: 'Hub 未就绪' }, msg.request_id); break; }
        _Hub.scheduler.startAgentHeartbeat(msg.agent_id || 'default', msg.config || {});
        sendEvent(ws, 'heartbeat_started', { request_id: msg.request_id, agent_id: msg.agent_id }, msg.request_id);
        break;
      }
      case 'heartbeat_stop': {
        _Hub?.scheduler?.stopAgentHeartbeat(msg.agent_id || 'default');
        sendEvent(ws, 'heartbeat_stopped', { request_id: msg.request_id, agent_id: msg.agent_id }, msg.request_id);
        break;
      }
      // Notify user activity to heartbeat
      case 'user_activity': {
        const hb = _Hub?.scheduler?.heartbeats?.get(msg.agent_id || 'default');
        if (hb) hb.notifyActivity();
        break;
      }
      // ── Agent Management ──
      case 'create_agent':
        (async () => {
          if (!_AgentManager) { sendEvent(ws, 'error', { content: 'AgentManager 未就绪' }, msg.request_id); return; }
          const agent = await _AgentManager.createAgent({
            name: msg.name || '新宠物',
            character: msg.character || 'glassesDog',
            config: msg.config || {},
            identity: msg.identity || '',
            ishiki: msg.ishiki || '',
          });
          sendEvent(ws, 'agent_created', {
            request_id: msg.request_id,
            agent: agent ? { id: agent.id, name: agent.name } : null,
          }, msg.request_id);
        })();
        break;
      case 'list_agents': {
        const agents = _AgentManager?.listAgents() || [];
        sendEvent(ws, 'agent_list', { request_id: msg.request_id, agents }, msg.request_id);
        break;
      }
      case 'list_tools': {
        const { getAllTools } = await import('./lib/tools/index.js');
        const tools = getAllTools().map(t => ({
          name: t.name,
          description: t.description?.slice(0, 80) || '',
          tier: t.tier || 'general',
        }));
        sendEvent(ws, 'tool_list', { request_id: msg.request_id, tools }, msg.request_id);
        break;
      }
      case 'switch_agent':
        (async () => {
          try {
            const agent = await _AgentManager?.switchAgent(msg.agent_id);
            sendEvent(ws, 'agent_switched', {
              request_id: msg.request_id,
              activeAgentId: _AgentManager?.activeAgentId,
              name: agent?.name,
            }, msg.request_id);
          } catch (err) {
            sendEvent(ws, 'error', { content: err.message }, msg.request_id);
          }
        })();
        break;
      case 'delete_agent':
        try {
          _AgentManager?.deleteAgent(msg.agent_id);
          sendEvent(ws, 'agent_deleted', {
            request_id: msg.request_id,
            activeAgentId: _AgentManager?.activeAgentId,
          }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'error', { content: err.message }, msg.request_id);
        }
        break;
      case 'update_agent_personality':
        try {
          _AgentManager?.updateAgentPersonality(msg.agent_id || _AgentManager?.activeAgentId, {
            identity: msg.identity,
            ishiki: msg.ishiki,
          });
          sendEvent(ws, 'personality_updated', { request_id: msg.request_id }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'error', { content: err.message }, msg.request_id);
        }
        break;
      case 'toggle_shared_memory':
        _AgentManager?._setSharedMemory?.(msg.enabled);
        sendEvent(ws, 'shared_memory_toggled', { request_id: msg.request_id, enabled: msg.enabled }, msg.request_id);
        break;
      case 'get_agent_memory': {
        const agent = _AgentManager?.getAgent(msg.agent_id || _AgentManager?.activeAgentId);
        const count = agent?.factStore?.count() || 0;
        sendEvent(ws, 'agent_memory_count', { request_id: msg.request_id, count }, msg.request_id);
        break;
      }
      // ── Skills ──
      case 'skill_list': {
        const skills = _SkillManager?.getAll().map(s => ({
          name: s.name,
          description: s.meta.description,
          trigger: s.meta.trigger,
          enabled: s.enabled,
          builtin: s.builtin,
        })) || [];
        sendEvent(ws, 'skill_list', { request_id: msg.request_id, skills }, msg.request_id);
        break;
      }
      case 'skill_enable':
        _SkillManager?.setEnabled(msg.skill_name, msg.enabled !== false);
        sendEvent(ws, 'skill_enabled', { request_id: msg.request_id }, msg.request_id);
        break;
      case 'skill_install':
        (async () => {
          const { installSkill } = await import('./lib/skills/skill-installer.js');
          const targetDir = path.join(getPersistDir(), 'skills-user');
          const result = await installSkill(msg.source || '', targetDir);
          if (result.success) _SkillManager?.loadAll();
          sendEvent(ws, 'skill_installed', { request_id: msg.request_id, ...result }, msg.request_id);
        })();
        break;
      // ── Plugins ──
      case 'plugin_list': {
        const plugins = _PluginManager?.listPlugins() || [];
        sendEvent(ws, 'plugin_list', { request_id: msg.request_id, plugins }, msg.request_id);
        break;
      }
      case 'plugin_activate':
        (async () => {
          try {
            await _PluginManager?.activatePlugin(msg.plugin_id);
            sendEvent(ws, 'plugin_activated', { request_id: msg.request_id, plugin_id: msg.plugin_id }, msg.request_id);
          } catch (err) {
            sendEvent(ws, 'error', { content: err.message }, msg.request_id);
          }
        })();
        break;
      case 'plugin_deactivate':
        (async () => {
          await _PluginManager?.deactivatePlugin(msg.plugin_id);
          sendEvent(ws, 'plugin_deactivated', { request_id: msg.request_id, plugin_id: msg.plugin_id }, msg.request_id);
        })();
        break;
      case 'quit':
        // Graceful shutdown requested by Electron
        log.log('收到 quit 请求，关闭连接');
        sendEvent(ws, 'bye', { request_id: msg.request_id }, msg.request_id);
        ws.close();
        break;
      case 'ping':
        sendEvent(ws, 'pong', {
          request_id: msg.request_id,
          memory_count: getMemoryStore().count(),
          indexed_files: getRAGPipeline().getIndexedFiles().length,
        }, msg.request_id);
        break;
      default:
        log.warn(`未知消息类型: ${msgType}`);
    }
  });

  ws.on('close', () => {
    sessions.delete(sessionId);
    log.log(`WebSocket 断开: ${sessionId}`);
  });

  ws.on('error', (err) => {
    log.error(`WebSocket 错误: ${err.message}`);
  });
});

// ── Periodic cleanup ──
setInterval(() => {
  // Clean stale pending approvals (older than 5 minutes)
  const cutoff = Date.now() - 300_000;
  for (const [id, pending] of pendingApprovals) {
    if (Date.now() - pending.timer._idleStart > 300_000) {
      clearTimeout(pending.timer);
      pending.resolve(false);
      pendingApprovals.delete(id);
    }
  }

  // Clean stale sessions (no WS for 30 minutes)
  const sessionCutoff = Date.now() - 1_800_000;
  for (const [id, session] of sessions) {
    if (session.createdAt < sessionCutoff && session.ws.readyState !== session.ws.OPEN) {
      sessions.delete(id);
    }
  }
}, 60_000);

// ── Hub + AgentManager initialization ──
async function initHub() {
  if (_Hub) return;

  // 1. AgentManager first (Hub depends on it)
  const agentsDir = path.join(getPersistDir(), 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  const { AgentManager: AM } = await import('./core/agent-manager.js');
  _AgentManager = new AM({
    agentsDir,
    memoryStore: getMemoryStore(),
    ragPipeline: getRAGPipeline(),
  });

  // Initialize built-in agents (idempotent: won't recreate if already exist)
  await _AgentManager.initBuiltinAgents();

  // Session memory for collaboration mode
  const { SessionMemory } = await import('./lib/memory/session-memory.js');
  _SessionMemory = new SessionMemory();

  // Create default user agent if no non-builtin agents
  const userAgents = _AgentManager.listAgents().filter(a => !a.isBuiltin);
  if (userAgents.length === 0) {
    await _AgentManager.createAgent({
      name: 'LU',
      character: 'glassesDog',
      config: { provider: 'claude', model: 'claude-sonnet-4-20250506' },
    });
  }

  // 3. Skill Manager
  const { SkillManager } = await import('./lib/skills/skill-manager.js');
  const builtinSkillsDir = path.join(path.dirname(_require.resolve('./lib/skills/skill-manager.js')), '..', '..', 'skills-builtin');
  const userSkillsDir = path.join(getPersistDir(), 'skills-user');
  fs.mkdirSync(userSkillsDir, { recursive: true });

  _SkillManager = new SkillManager({
    skillDirs: [builtinSkillsDir, userSkillsDir],
  });
  _SkillManager.loadAll();

  // 4. Plugin Manager
  const { PluginManager } = await import('./lib/plugins/plugin-manager.js');
  const builtinPluginsDir = path.join(path.dirname(_require.resolve('./lib/plugins/plugin-manager.js')), '..', '..', 'plugins-builtin');
  const userPluginsDir = path.join(getPersistDir(), 'plugins-user');
  fs.mkdirSync(userPluginsDir, { recursive: true });

  _PluginManager = new PluginManager({
    pluginDirs: [builtinPluginsDir, userPluginsDir],
    dataDir: path.join(getPersistDir(), 'plugin-data'),
    services: {
      eventBus: null, // Set after Hub creates eventBus
      agentManager: _AgentManager,
    },
  });
  await _PluginManager.loadAll();

  // Activate built-in plugins
  for (const plugin of _PluginManager.listPlugins()) {
    try {
      await _PluginManager.activatePlugin(plugin.id);
    } catch (err) {
      log.error(`插件激活失败: ${plugin.id} — ${err.message}`);
    }
  }

  // 5. Hub
  const { Hub } = _require('./hub/index.js');
  const { ChannelRouter } = _require('./hub/channel-router.js');
  const { DmRouter } = _require('./hub/dm-router.js');

  const channelsDir = path.join(getPersistDir(), 'channels');

  const channelRouter = new ChannelRouter({
    channelsDir,
    agentManager: _AgentManager,
    eventBus: null, // Set after Hub creates eventBus
  });

  const dmRouter = new DmRouter({
    agentsDir,
    agentManager: _AgentManager,
    eventBus: null,
  });

  _Hub = new Hub({
    persistDir: getPersistDir(),
    engine: {
      executeCronJob: async (job, signal) => {
        if (!_runAgent) {
          const agentModule = await import('./core/agent.js');
          _runAgent = agentModule.runAgent;
        }
        const activeAgent = _AgentManager?.getActiveAgent();
        const config = activeAgent?.config || { provider: 'claude', model: 'claude-sonnet-4-20250506' };
        const messages = activeAgent
          ? activeAgent.injectPersonality([{ role: 'user', content: job.prompt }])
          : [{ role: 'system', content: job.prompt }];

        let resultContent = '';
        await _runAgent({
          config,
          messages,
          convId: `cron-${job.id}`,
          memoryStore: _AgentManager?._getEffectiveStore?.(activeAgent) || activeAgent?.factStore || getMemoryStore(),
          ragPipeline: getRAGPipeline(),
          sendEvent: (type, data) => {
            if (type === 'done') resultContent = data?.content || '';
          },
          waitApproval: () => Promise.resolve(true),
        });
        return { content: resultContent };
      },
    },
  });

  // Wire event bus to channel/dm/plugin services
  channelRouter.eventBus = _Hub.eventBus;
  dmRouter.eventBus = _Hub.eventBus;

  // Wire eventBus into PluginManager services (was null at construction)
  for (const [id, plugin] of (_PluginManager._plugins?.entries() || [])) {
    if (plugin.context) {
      plugin.context.services.eventBus = _Hub.eventBus;
    }
  }

  // Inject agent tools
  const { setAgentServices } = await import('./lib/tools/agent-tools.js');
  setAgentServices({ channelRouter, dmRouter, agentManager: _AgentManager });

  _Hub.start();

  // Add agent tools to tool registry
  const { getAgentTools } = await import('./lib/tools/agent-tools.js');
  const agentTools = getAgentTools();
  const { getAllTools: _origGetAll } = await import('./lib/tools/index.js');

  // Broadcast events to all WS clients
  _Hub.eventBus.subscribe('heartbeat_pulse', (event) => {
    for (const [sid, session] of sessions) {
      sendEvent(session.ws, 'heartbeat_pulse', event.data);
    }
  });

  _Hub.eventBus.subscribe('cron_job_done', (event) => {
    for (const [sid, session] of sessions) {
      sendEvent(session.ws, 'cron_job_done', event.data);
    }
  });

  _Hub.eventBus.subscribe('channel_message', (event) => {
    for (const [sid, session] of sessions) {
      sendEvent(session.ws, 'channel_message', event.data);
    }
  });

  _Hub.eventBus.subscribe('dm_received', (event) => {
    for (const [sid, session] of sessions) {
      sendEvent(session.ws, 'dm_received', event.data);
    }
  });

  // Start heartbeat for each agent
  for (const agent of _AgentManager.listAgents()) {
    _Hub.scheduler.startAgentHeartbeat(agent.id, {
      watchDirs: [path.join(os.homedir(), 'Desktop')],
    });
  }

  log.log(`Hub + AgentManager 已初始化 (${_AgentManager.agentCount} agents)`);
}

// ── Background warmup ──
function _preload() {
  // Preload heavy modules in background so first request doesn't wait
  setTimeout(async () => {
    try {
      const t0 = Date.now();
      await import('./core/agent.js');
      const t1 = Date.now();
      log.log(`预热: agent_loop (${t1 - t0}ms)`);
      await import('./core/coordinator.js');
      await import('./lib/security/gate.js');
      await import('./lib/vision/expert.js');
      const t2 = Date.now();
      log.log(`预热完成 (${t2 - t0}ms)`);
    } catch (err) {
      log.warn(`预热失败: ${err.message}`);
    }
  }, 100); // Defer so server starts first
}

// ── Start ──
const PORT = getPort();
httpServer.listen(PORT, '127.0.0.1', async () => {
  log.log(`Agent Server 已启动: http://127.0.0.1:${PORT}`);
  _preload();
  // Init Hub after server is up
  await initHub();
});

// Graceful shutdown
async function shutdown() {
  log.log('正在关闭...');
  if (_Hub) await _Hub.stop();
  wss.close(() => {
    httpServer.close(() => process.exit(0));
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, wss, getMemoryStore, getRAGPipeline, getFactStore };

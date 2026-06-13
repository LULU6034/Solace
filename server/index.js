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
import { VoiceSession, STATES } from './voice/voice-session.js';

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
let _MemoryManager = null;
let _UserProfile = null;
let _SleepMode = null;
let _EmotionTrend = null;
let _StyleAdapter = null;
let _Personality = null;
let _KnowledgeGraph = null;

const log = createModuleLogger('server');

// ── Hono app (HTTP fallback) ──
const app = new Hono();

app.get('/pets/:id/spritesheet', (c) => {
  const petId = c.req.param('id');
  const petsDir = path.join(getPersistDir(), 'agent-pets', petId);
  if (!fs.existsSync(petsDir)) return c.notFound();
  // Find spritesheet file (png or webp)
  const files = fs.readdirSync(petsDir).filter(f => f.startsWith('spritesheet'));
  if (!files.length) return c.notFound();
  const ext = path.extname(files[0]).slice(1);
  const mime = ext === 'webp' ? 'image/webp' : 'image/png';
  return new Response(fs.readFileSync(path.join(petsDir, files[0])), {
    headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' },
  });
});

app.get('/pets/imported/:id/spritesheet', (c) => {
  const petId = c.req.param('id');
  const petsDir = path.join(os.homedir(), '.ai-desktop-pet', 'imported-pets', petId);
  if (!fs.existsSync(petsDir)) return c.notFound();
  const files = fs.readdirSync(petsDir).filter(f => f.startsWith('spritesheet'));
  if (!files.length) return c.notFound();
  const ext = path.extname(files[0]).slice(1);
  const mime = ext === 'webp' ? 'image/webp' : 'image/png';
  return new Response(fs.readFileSync(path.join(petsDir, files[0])), {
    headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' },
  });
});

app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }));

app.get('/stats', async (c) => {
  const store = await getMemoryStore();
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
  const { installSkill } = await import('./skills/skill-installer.js');
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
async function getFactStore() {
  if (!_FactStore) {
    const { FactStore } = _require('./memory/fact-store-sqlite.js');
    _FactStore = new FactStore(getPersistDir());
    await _FactStore.init();
  }
  return _FactStore;
}

async function getMemoryStore() {
  if (!_MemoryStore) {
    const fs = await getFactStore();
    // ── 向量搜索 (懒加载 + LRU 缓存) ──
    let _vsCache = null, _vsReady = false;
    const _embedLRU = new Map();
    const _LRU_MAX = 50;

    _MemoryStore = {
      factStore: fs,
      ticker: null,
      search(query, k = 5) { return this.factStore.search(query, k); },
      addFact(fact, tags = [], opts = {}) { return this.factStore.add({ fact, tags, confidence: opts.confidence, half_life_days: opts.half_life_days }); },
      getAll() { return this.factStore.getAll(); },
      count() { return this.factStore.count(); },
      clear() { this.factStore.clear(); },
      softDelete(fact) { return this.factStore.softDelete(fact); },
      countDeleted() { return this.factStore.countDeleted?.() || 0; },

      async vectorSearch(query, k = 5) {
        if (!_vsReady) {
          try {
            const { getVectorSearch } = await import('./memory/vector-search.js');
            _vsCache = getVectorSearch();
            await _vsCache.init();
            _vsReady = true;
          } catch { _vsReady = true; }
        }
        if (_vsCache?.useTransformer && query?.length >= 2 && !/^\d+$/.test(query)) {
          try {
            const all = this.factStore.getAll?.() || [];
            if (all.length < 3) return this.factStore.search(query, k);

            // LRU 缓存：避免短时间重复编码
            if (_embedLRU.has(query)) {
              _embedLRU.delete(query); // move to end (LRU refresh)
              _embedLRU.set(query, true);
            } else {
              if (_embedLRU.size >= _LRU_MAX) {
                const first = _embedLRU.keys().next().value;
                _embedLRU.delete(first);
              }
              _embedLRU.set(query, true); // mark as cached
            }

            const results = await _vsCache.searchInFacts(all, query, k);
            if (results?.length) {
              const now = Date.now();
              return results.map(r => {
                const days = (now - (r.created_at || now)) / 86400000;
                const decay = Math.exp(-0.02 * Math.max(0, days));
                return { ...r, score: Math.round((r.score || 0) * decay * 100) / 100, source: 'vector' };
              });
            }
          } catch {}
        }
        // 降级: 返回带提示的结果
        const kwResults = this.factStore.search(query, k).map(r => ({ ...r, source: 'keyword' }));
        if (kwResults.length) {
          kwResults.push({ fact: '(语义搜索暂不可用，以上结果基于关键词匹配)', tags: [], source: 'system' });
        }
        return kwResults;
      },
    };
    import('./tools/memory-store-ref.js').then(m => m.setMemoryStore(_MemoryStore));
    import('./tools/index.js').then(m => { if (m.setMusicMemoryStore) m.setMusicMemoryStore(_MemoryStore); });
    // 提醒推送：广播到所有已连接 WebSocket
    import('./tools/reminder-tool.js').then(m => {
      m.setReminderSender((type, data) => {
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type, data })); });
      });
    });
  }
  return _MemoryStore;
}

async function getRAGPipeline() {
  if (!_RAGPipeline) {
    const { RAGPipeline } = _require('./rag/pipeline.js');
    _RAGPipeline = await new RAGPipeline(getPersistDir()).ready();
  }
  return _RAGPipeline;
}

// ── 知识库懒加载 ──
let _KBIndexer = null;
let _KBWatcher = null;
let _KBConfig = null;

async function getKBConfig() {
  if (!_KBConfig) {
    const { KBConfig } = await import('./knowledge/config.js');
    _KBConfig = new KBConfig();
  }
  return _KBConfig;
}

async function getKBIndexer() {
  if (!_KBIndexer) {
    const { KBIndexer } = await import('./knowledge/indexer.js');
    _KBIndexer = new KBIndexer();
  }
  return _KBIndexer;
}

async function getKBWatcher() {
  if (!_KBWatcher) {
    const idx = await getKBIndexer();
    await idx.init();
    const cfg = await getKBConfig();
    const { KBWatcher } = await import('./knowledge/watcher.js');
    _KBWatcher = new KBWatcher({ config: cfg, indexer: idx });
  }
  return _KBWatcher;
}

// ── 知识图谱 + 成长引擎懒加载 ──
let _KBGraph = null;
let _ReflectionEngine = null;
let _CuriosityEngine = null;

async function getKBGraph() {
  if (!_KBGraph) {
    await (await getKBIndexer()).init();
    const { KnowledgeGraph } = await import('./knowledge/graph.js');
    _KBGraph = new KnowledgeGraph(await getKBSchemaInternal());
  }
  return _KBGraph;
}

async function getKBSchemaInternal() {
  const idx = await getKBIndexer();
  await idx.init();
  return idx.schema;
}

async function getReflectionEngine() {
  if (!_ReflectionEngine) {
    const schema = await getKBSchemaInternal();
    const { ReflectionEngine } = await import('./knowledge/reflection.js');
    _ReflectionEngine = new ReflectionEngine({ schema, graph: await getKBGraph() });
  }
  return _ReflectionEngine;
}

async function getCuriosityEngine() {
  if (!_CuriosityEngine) {
    const schema = await getKBSchemaInternal();
    const { CuriosityEngine } = await import('./knowledge/curiosity.js');
    _CuriosityEngine = new CuriosityEngine({ schema, graph: await getKBGraph() });
  }
  return _CuriosityEngine;
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

  let _agentEmotion = 'neutral';
  const send = (type, data) => {
    if (type === 'done' && data?.content) {
      const emoMatch = data.content.match(/^\[emotion:(\w+)\]\s*/);
      if (emoMatch) {
        _agentEmotion = emoMatch[1];
      } else {
        // 后备: 关键词推断情绪
        const text = data.content.slice(0, 100);
        if (/哈哈|🎉|开心|太棒|恭喜|nice|爽/i.test(text)) _agentEmotion = 'happy';
        else if (/难过|😔|😢|伤心|心疼|节哀|抱抱/i.test(text)) _agentEmotion = 'sad';
        else if (/😤|气死|无语|过分|投诉/i.test(text)) _agentEmotion = 'angry';
        else if (/担心|焦虑|紧张|别怕|担心/i.test(text)) _agentEmotion = 'worried';
        else if (/加油|你可以|相信|没问题|试试/i.test(text)) _agentEmotion = 'encouraging';
      }
    }
    sendEvent(ws, type, data, requestId);
  };

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
      // 设置冲突回调: 将冲突事件发送到前端
      agentModule.onMemoryConflict((conflicts) => {
        sendEvent(ws, 'memory_conflict', { conflicts });
      });
    }

    // Inject per-agent personality
    const personalityMessages = agent
      ? agent.injectPersonality(messages)
      : messages;

    await _runAgent({
      config: agentConfig,
      messages: personalityMessages,
      convId,
      memoryStore: await getMemoryStore(),
      ragPipeline: await getRAGPipeline(),
      sendEvent: send,
      waitApproval,
      memoryManager: _MemoryManager || null,
      userProfile: _UserProfile || null,
      styleAdapter: _StyleAdapter || null,
      personality: _Personality || null,
    });

    // Post-chat: update memory, profile, style, knowledge graph
    if (_MemoryManager) {
      const lastUserMsg = messages[messages.length - 1];
      if (lastUserMsg?.role === 'user') {
        _MemoryManager.addTurn('user', lastUserMsg.content);
      }
    }
    const userMsg = messages.find(m => m.role === 'user');
    if (userMsg?.content) {
      _StyleAdapter?.analyzeMessage(userMsg.content);
      _Personality?.adapt('user_expanded');
      // Ingest into knowledge graph (规则 + LLM 深度推理)
      if (_KnowledgeGraph) {
        const entities = _KnowledgeGraph.ingest(userMsg.content);
        if (entities?.length) {
          log.log(`知识图谱(规则): 抽取 ${entities.length} 个实体`);
        }
        // LLM 深度推理 (异步，不阻塞回复)
        const { createLLM } = await import('./core/llm-client.js');
        _KnowledgeGraph.ingestLLM(userMsg.content, createLLM({
          provider: 'deepseek', model: 'deepseek-chat',
          apiKey: config.apiKey, temperature: 0.3, maxTokens: 300,
        })).then(result => {
          if (result?.entities?.length || result?.relations?.length) {
            log.log(`知识图谱(LLM): ${result.entities.length}实体, ${result.relations.length}关系, ${result.inferred.length}推理`);
          }
        }).catch(() => {});
      }
    }

    // 记录本次对话的情绪趋势
    if (_EmotionTrend && _agentEmotion) {
      _EmotionTrend.record(_agentEmotion);
    }

    // 提取情境事件
    if (_MemoryManager && messages.length >= 2) {
      const lastMsgs = messages.slice(-6).map(m => `${m.role}: ${(m.content || '').slice(0, 300)}`).join('\n');
      try {
        const { createLLM } = await import('./core/llm-client.js');
        const llm = createLLM({ provider: 'deepseek', model: 'deepseek-chat', apiKey: config.apiKey, temperature: 0.3, maxTokens: 200 });
        const { content } = await llm.invoke([{ role: 'user', content: `描述这段对话中的关键情境或情绪变化（一句中文，不超过50字）:\n${lastMsgs}\n情境:` }]);
        if (content && content.trim() && content.trim() !== '无') {
          const { addEpisode } = await import('./memory/episodic.js');
          addEpisode({
            id: `ep_${Date.now()}`, timestamp: Date.now(),
            context: { timeOfDay: new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening', dayOfWeek: new Date().getDay() },
            content: { keyQuote: content.trim() }, importance: 5,
          });
        }
      } catch {}
    }

    // 知识缺口检测（后台，不阻塞）
    try {
      const lastUserMsg = messages.findLast(m => m.role === 'user');
      if (lastUserMsg?.content) {
        const curiosity = await getCuriosityEngine();
        await curiosity.init();
        const gaps = await curiosity.processUserMessage(lastUserMsg.content);
        if (gaps.length > 0) {
          log.log(`好奇心: 发现 ${gaps.length} 个新知识缺口`);
        }
      }
    } catch {}

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
      memoryStore: await getMemoryStore(),
      ragPipeline: await getRAGPipeline(),
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

  // 语音会话 Map — 连接级别，跨消息持久
  let _voiceSessions;

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
          const rag = await getRAGPipeline();
          const chunks = rag.indexFile(msg.file_path || '');
          sendEvent(ws, 'file_indexed', { request_id: msg.request_id, chunks }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'error', { request_id: msg.request_id, content: err.message }, msg.request_id);
        }
        break;
      }
      case 'search_rag': {
        const rag = await getRAGPipeline();
        const results = rag.search(msg.query || '', msg.k || 5);
        sendEvent(ws, 'rag_results', { request_id: msg.request_id, results }, msg.request_id);
        break;
      }
      // ── 知识库操作 ──
      case 'kb_search': {
        try {
          const idx = await getKBIndexer();
          await idx.init();
          const results = await idx.retriever.search(msg.query || '', { topK: msg.topK || 5, rerank: msg.rerank !== false });
          sendEvent(ws, 'kb_search_result', { request_id: msg.request_id, results }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'error', { request_id: msg.request_id, content: '知识库搜索失败: ' + err.message }, msg.request_id);
        }
        break;
      }
      case 'kb_ask': {
        (async () => {
          try {
            const idx = await getKBIndexer();
            await idx.init();
            const results = await idx.retriever.search(msg.query || '', { topK: 5 });

            if (!results || results.length === 0) {
              sendEvent(ws, 'kb_ask_result', {
                request_id: msg.request_id,
                answer: '知识库中没有找到相关信息。',
                sources: [],
              }, msg.request_id);
              return;
            }

            // 读取 chunk 内容和对应文件名
            const chunkIds = results.map(r => r.id);
            const db = idx.schema.db;
            const placeholders = chunkIds.map(() => '?').join(',');
            const stmt = db.prepare(
              `SELECT c.id, c.content, f.filename FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.id IN (${placeholders})`
            );
            stmt.bind(chunkIds);

            const chunkMap = new Map();
            while (stmt.step()) {
              const row = stmt.getAsObject();
              chunkMap.set(row.id, { content: row.content, file: row.filename });
            }
            stmt.free();

            // 按检索结果顺序构建上下文
            const chunkItems = [];
            for (const r of results) {
              const info = chunkMap.get(r.id);
              if (info) {
                chunkItems.push({ id: r.id, content: info.content, file: info.file });
              }
            }

            if (chunkItems.length === 0) {
              sendEvent(ws, 'kb_ask_result', {
                request_id: msg.request_id,
                answer: '知识库中没有找到相关信息。',
                sources: [],
              }, msg.request_id);
              return;
            }

            const context = chunkItems.map((c, i) => `[${i + 1}] 文件: ${c.file}\n${c.content}`).join('\n\n');

            // 调用 LLM 生成回答
            const { createLLM } = await import('./core/llm-client.js');
            const llm = createLLM({
              provider: msg.config?.provider || 'deepseek',
              model: msg.config?.model || 'deepseek-chat',
              apiKey: msg.config?.apiKey || '',
              temperature: 0.3,
              maxTokens: 1000,
            });

            const prompt = `基于以下知识库内容回答问题。如果知识库没有相关信息，就说不知道。\n\n知识库内容:\n${context}\n\n问题: ${msg.query}\n\n回答:`;

            const { content } = await llm.invoke([
              { role: 'user', content: prompt }
            ]);

            const sources = chunkItems.map(c => ({
              chunkId: c.id,
              content: c.content.slice(0, 200),
              file: c.file,
            }));

            sendEvent(ws, 'kb_ask_result', {
              request_id: msg.request_id,
              answer: content || '知识库中没有找到相关信息。',
              sources,
            }, msg.request_id);
          } catch (err) {
            sendEvent(ws, 'error', {
              request_id: msg.request_id,
              content: '知识库问答失败: ' + err.message,
            }, msg.request_id);
          }
        })();
        break;
      }
      case 'kb_index_trigger': {
        try {
          const idx = await getKBIndexer();
          await idx.init();
          const result = await idx.fullScan();
          sendEvent(ws, 'kb_index_done', { request_id: msg.request_id, ...result }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'error', { request_id: msg.request_id, content: '知识库索引失败: ' + err.message }, msg.request_id);
        }
        break;
      }
      case 'kb_index_rebuild': {
        try {
          const idx = await getKBIndexer();
          await idx.init();
          const result = await idx.fullScan();
          sendEvent(ws, 'kb_index_done', { request_id: msg.request_id, rebuilt: true, ...result }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'error', { request_id: msg.request_id, content: '知识库重建失败: ' + err.message }, msg.request_id);
        }
        break;
      }
      case 'kb_config': {
        try {
          const cfg = await getKBConfig();
          sendEvent(ws, 'kb_config', { config: cfg.get() }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'error', { request_id: msg.request_id, content: err.message }, msg.request_id);
        }
        break;
      }
      case 'kb_config_update': {
        try {
          const cfg = await getKBConfig();
          const { key, value } = msg;
          if (!key) throw new Error('缺少 key 参数');
          cfg.set(key, value);
          cfg.save();
          // 如果更新了 watch.paths，重启监控
          if (key === 'watch.paths' || key.startsWith('watch.')) {
            const watcher = await getKBWatcher();
            await watcher.stop();
            await watcher.start();
            log.log('监控已重新启动（配置变更）');
          }
          sendEvent(ws, 'kb_config_updated', { key, value }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'error', { request_id: msg.request_id, content: '配置更新失败: ' + err.message }, msg.request_id);
        }
        break;
      }
      case 'get_memory_count': {
        const store = await getMemoryStore();
        sendEvent(ws, 'memory_count', { request_id: msg.request_id, count: store.count() }, msg.request_id);
        break;
      }
      case 'clear_memory': {
        (await getMemoryStore()).clear();
        sendEvent(ws, 'memory_cleared', { request_id: msg.request_id }, msg.request_id);
        break;
      }
      case 'hatch_pet': {
        const { hatchPet, validateHatch } = await import('./pets/hatch.js');
        const config = msg.config || {};
        try {
          const generated = await hatchPet(config, msg.description || '');
          const pet = validateHatch(generated);
          if (pet) {
            // Save hatched pet to disk
            const hatchDir = path.join(getPersistDir(), 'hatched');
            fs.mkdirSync(hatchDir, { recursive: true });
            fs.writeFileSync(path.join(hatchDir, `${pet.id}.json`), JSON.stringify(pet, null, 2));
            sendEvent(ws, 'hatch_done', { request_id: msg.request_id, pet }, msg.request_id);
          } else {
            sendEvent(ws, 'hatch_error', { request_id: msg.request_id, error: '生成失败，LLM 返回格式不正确' }, msg.request_id);
          }
        } catch (err) {
          sendEvent(ws, 'hatch_error', { request_id: msg.request_id, error: err.message }, msg.request_id);
        }
        break;
      }
      case 'get_hatched_pets': {
        const hatchDir = path.join(getPersistDir(), 'hatched');
        const pets = [];
        try {
          if (fs.existsSync(hatchDir)) {
            for (const f of fs.readdirSync(hatchDir)) {
              if (f.endsWith('.json')) {
                try { pets.push(JSON.parse(fs.readFileSync(path.join(hatchDir, f), 'utf-8'))); } catch {}
              }
            }
          }
        } catch {}
        sendEvent(ws, 'hatched_pets', { request_id: msg.request_id, pets }, msg.request_id);
        break;
      }
      case 'delete_hatched_pet': {
        const hatchDir = path.join(getPersistDir(), 'hatched');
        try { fs.unlinkSync(path.join(hatchDir, `${msg.pet_id}.json`)); } catch {}
        sendEvent(ws, 'hatch_deleted', { request_id: msg.request_id, pet_id: msg.pet_id }, msg.request_id);
        break;
      }
      case 'generate_agent_pets': {
        const { hatchSpritesheet } = await import('./pets/hatch-spritesheet.js');
        const { AGENT_PET_PRESETS } = await import('./pets/agent-pets.js');
        const imgConfig = msg.config || {};
        if (!imgConfig.apiKey) {
          sendEvent(ws, 'hatch_error', { request_id: msg.request_id, error: '请先配置百炼图片 API Key（设置 → 系统 → 图片生成 Key）' }, msg.request_id);
          break;
        }
        const petsDir = path.join(getPersistDir(), 'agent-pets');
        const results = [];
        for (const preset of AGENT_PET_PRESETS) {
          try {
            sendEvent(ws, 'coordinator_info', { content: `正在生成 ${preset.name}...` }, msg.request_id);
            const petDir = path.join(petsDir, preset.fixedId);
            // Skip if already generated
            if (fs.existsSync(path.join(petDir, 'pet.json'))) {
              results.push(JSON.parse(fs.readFileSync(path.join(petDir, 'pet.json'), 'utf-8')));
              continue;
            }
            const pet = await hatchSpritesheet(imgConfig, preset, petDir);
            results.push(pet);
          } catch (err) {
            log.error(`生成 ${preset.name} 失败: ${err.message}`);
            results.push({ ...preset, error: err.message });
          }
          // Rate limit: 百炼 ~10 req/min, wait 6s between
          if (AGENT_PET_PRESETS.indexOf(preset) < AGENT_PET_PRESETS.length - 1) {
            await new Promise(r => setTimeout(r, 6000));
          }
        }
        sendEvent(ws, 'agent_pets_ready', { request_id: msg.request_id, pets: results }, msg.request_id);
        break;
      }
      case 'get_agent_pets': {
        const petsDir = path.join(getPersistDir(), 'agent-pets');
        const pets = [];
        try {
          if (fs.existsSync(petsDir)) {
            for (const d of fs.readdirSync(petsDir)) {
              const metaPath = path.join(petsDir, d, 'pet.json');
              if (fs.existsSync(metaPath)) {
                try { pets.push(JSON.parse(fs.readFileSync(metaPath, 'utf-8'))); } catch {}
              }
            }
          }
        } catch {}
        sendEvent(ws, 'agent_pets', { request_id: msg.request_id, pets }, msg.request_id);
        break;
      }
      case 'get_indexed_files': {
        const rag = await getRAGPipeline();
        const files = rag.getIndexedFiles();
        sendEvent(ws, 'indexed_files', { request_id: msg.request_id, files }, msg.request_id);
        break;
      }
      case 'remove_file': {
        const rag = await getRAGPipeline();
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
        const { getAllTools } = await import('./tools/index.js');
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
          const { installSkill } = await import('./skills/skill-installer.js');
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
      case 'file_comment': {
        (async () => {
          try {
            const { createLLM } = await import('./core/llm-client.js');
            const filename = msg.filename || '文件';
            const llm = createLLM({ ...(msg.config || {}), temperature: 0.9, maxTokens: 64, reasoningEffort: 'none' });
            const systemPrompt = `你是一只傲娇的绿色小猫桌宠。看到主人拖来一个文件，用10个字以内简短评价。语气傲娇、可爱、带点嫌弃但其实是关心的。不要解释，只输出一句话评价。`;
            const userMsg = `文件: ${filename}`;
            let comment = '';
            for await (const chunk of llm.stream([
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMsg },
            ])) {
              if (chunk.content) comment += chunk.content;
            }
            sendEvent(ws, 'file_comment_done', { request_id: msg.request_id, comment: comment.trim().slice(0, 30) }, msg.request_id);
          } catch (err) {
            sendEvent(ws, 'file_comment_done', { request_id: msg.request_id, comment: `这什么呀…${msg.filename?.slice(0,8) || '文件'}？` }, msg.request_id);
          }
        })();
        break;
      }
      // ── Voice ──
      case 'voice_tts': {
        (async () => {
          try {
            console.log('[server] voice_tts:', msg.text?.slice(0, 30));
            const { getTTSManager } = await import('./voice/tts.js');
            const tts = getTTSManager();
            console.log('[server] TTS mode:', tts.mode);
            const chunks = [];
            for await (const chunk of tts.synthesizeStream(msg.text || '', {
              emotion: msg.emotion || 'neutral',
              voiceId: msg.voice_id || 'default_female',
              speed: msg.speed || 1.0,
            })) {
              chunks.push(chunk.audio);
              // Stream chunks to client
              sendEvent(ws, 'voice_tts_chunk', {
                request_id: msg.request_id,
                audio: chunk.audio.toString('base64'),
                sample_rate: chunk.sampleRate,
                engine: chunk.engine,
              }, msg.request_id);
            }
            sendEvent(ws, 'voice_tts_done', {
              request_id: msg.request_id,
              engine: tts.mode,
            }, msg.request_id);
          } catch (err) {
            log.error(`voice_tts 失败: ${err.message}`);
            sendEvent(ws, 'voice_tts_done', {
              request_id: msg.request_id,
              error: err.message,
            }, msg.request_id);
          }
        })();
        break;
      }

      case 'voice_session_start': {
        const sessionId = `vs_${Date.now()}`;
        const session = new VoiceSession({
          sessionId,
          agentId: msg.agent_id || 'default',
        });

        // Store session
        if (!_voiceSessions) _voiceSessions = new Map();
        _voiceSessions.set(sessionId, session);

        // Wire subtitle → client
        session.onSubtitle = (data) => {
          sendEvent(ws, 'voice_subtitle', data);
        };

        // Wire state changes → client
        session.onStateChange = (prev, next) => {
          sendEvent(ws, 'voice_state', { prev, state: next, session_id: sessionId });
        };

        // Wire error → client
        session.onError = (err) => {
          sendEvent(ws, 'voice_error', { ...err, session_id: sessionId });
        };

        sendEvent(ws, 'voice_session_ready', {
          request_id: msg.request_id,
          session_id: sessionId,
          status: 'ready',
        }, msg.request_id);
        break;
      }

      case 'voice_session_stop': {
        if (_voiceSessions) {
          const sid = msg.session_id;
          const session = sid ? _voiceSessions.get(sid) : null;
          if (session) {
            session.destroy();
            _voiceSessions.delete(sid);
          }
        }
        sendEvent(ws, 'voice_session_stopped', {
          request_id: msg.request_id,
        }, msg.request_id);
        break;
      }

      case 'voice_interrupt': {
        if (_voiceSessions && msg.session_id) {
          const session = _voiceSessions.get(msg.session_id);
          if (session) session.interrupt();
        }
        sendEvent(ws, 'voice_interrupted', {
          request_id: msg.request_id,
        }, msg.request_id);
        break;
      }

      case 'voice_status': {
        try {
          const { getTTSManager } = await import('./voice/tts.js');
          const tts = getTTSManager();
          const status = await tts.status();
          sendEvent(ws, 'voice_status_result', {
            request_id: msg.request_id,
            ...status,
          }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'voice_status_result', {
            request_id: msg.request_id,
            error: err.message,
          }, msg.request_id);
        }
        break;
      }

      case 'voice_recover': {
        try {
          const { getTTSManager } = await import('./voice/tts.js');
          const tts = getTTSManager();
          const result = await tts.attemptRecovery();
          sendEvent(ws, 'voice_recover_result', {
            request_id: msg.request_id,
            ...result,
          }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'voice_recover_result', {
            request_id: msg.request_id,
            error: err.message,
          }, msg.request_id);
        }
        break;
      }

      // ── Memory management (Phase 3) ──
      case 'memory_get_facts': {
        // 统一使用全局单例 _FactStore，避免多实例导致数据不同步
        const store = await getFactStore();
        const rows = store?.getAll?.() || [];
        const facts = rows.map(r => ({ fact: r.fact, tags: r.tags || [], confidence: r.confidence || 0.5, created_at: r.created_at }));
        sendEvent(ws, 'memory_facts', { facts }, msg.request_id);
        break;
      }
      case 'memory_get_profile': {
        const profile = _UserProfile?.export?.() || {};
        sendEvent(ws, 'memory_profile', { profile }, msg.request_id);
        break;
      }
      case 'memory_get_episodes': {
        const episodes = (_MemoryManager?.retrieval?.episodeStore?.getAll?.() || []);
        sendEvent(ws, 'memory_episodes', { episodes }, msg.request_id);
        break;
      }
      case 'memory_delete_fact': {
        _MemoryManager?.factStore?.delete?.(msg.fact_id);
        sendEvent(ws, 'memory_fact_deleted', {}, msg.request_id);
        break;
      }
      case 'memory_delete_profile': {
        _UserProfile?.delete?.(msg.key);
        sendEvent(ws, 'memory_profile_deleted', {}, msg.request_id);
        break;
      }
      case 'memory_delete_episode': {
        _MemoryManager?.retrieval?.episodeStore?.delete?.(msg.index);
        sendEvent(ws, 'memory_episode_deleted', {}, msg.request_id);
        break;
      }
      case 'memory_clear_all': {
        _MemoryManager?.factStore?.clear?.();
        if (_UserProfile) _UserProfile.attributes = {};
        _UserProfile?.save?.();
        sendEvent(ws, 'memory_cleared', {}, msg.request_id);
        break;
      }
      // ── Personality (P0) ──
      case 'personality_get': {
        sendEvent(ws, 'personality_data', { dims: _Personality?.getAll() || {} }, msg.request_id);
        break;
      }
      case 'personality_set': {
        _Personality?.set(msg.dim, msg.value);
        sendEvent(ws, 'personality_updated', { dims: _Personality?.getAll() }, msg.request_id);
        break;
      }
      case 'personality_set_batch': {
        for (const [dim, value] of Object.entries(msg.dims || {})) {
          _Personality?.set(dim, value);
        }
        sendEvent(ws, 'personality_updated', { dims: _Personality?.getAll() }, msg.request_id);
        break;
      }
      case 'personality_adapt': {
        _Personality?.adapt(msg.signal, msg.context || {});
        sendEvent(ws, 'personality_updated', { dims: _Personality?.getAll() }, msg.request_id);
        break;
      }

      case 'battery_profile': {
        log.log(`电池模式: ${msg.level} (${Math.round((msg.batteryLevel || 1) * 100)}%)`);
        if (_Personality) {
          // Reduce curiosity on low battery to save processing
          if (msg.level === 'low' || msg.level === 'critical') {
            _Personality.set('curiosity', Math.max(0.1, _Personality.get('curiosity') - 0.2));
          }
        }
        break;
      }

      // ── Agent routing ──
      case 'agent_route': {
        const { route } = await import('./core/agent-router.js');
        const result = route(msg.text || '');
        sendEvent(ws, 'agent_routed', result, msg.request_id);
        break;
      }
      case 'agent_list_specialists': {
        const { listAgents } = await import('./core/agent-router.js');
        sendEvent(ws, 'agent_specialists', { agents: listAgents() }, msg.request_id);
        break;
      }

      case 'memory_import': {
        try {
          if (msg.data?.profile) _UserProfile?.import?.(msg.data.profile);
          if (msg.data?.facts) {
            for (const f of msg.data.facts) {
              _MemoryManager?.factStore?.add?.({ fact: f.fact || f, tags: f.tags || [] });
            }
          }
          sendEvent(ws, 'memory_imported', {}, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'error', { content: err.message }, msg.request_id);
        }
        break;
      }

      case 'ping':
        sendEvent(ws, 'pong', {
          request_id: msg.request_id,
          memory_count: (await getMemoryStore()).count(),
          indexed_files: (await getRAGPipeline()).getIndexedFiles().length,
        }, msg.request_id);
        break;
      // ── Codex Pet Import ──
      case 'import_codex_pet': {
        (async () => {
          try {
            const { importFromUrl, importFromZip } = await import('./lib/codex-importer.js');
            let pet;
            if (msg.url) {
              pet = await importFromUrl(msg.url);
            } else if (msg.file_path) {
              pet = await importFromZip(msg.file_path);
            } else {
              sendEvent(ws, 'import_error', { request_id: msg.request_id, error: '请提供 url 或 file_path' }, msg.request_id);
              return;
            }
            sendEvent(ws, 'import_done', { request_id: msg.request_id, pet }, msg.request_id);
          } catch (err) {
            log.error(`Codex 导入失败: ${err.message}`);
            sendEvent(ws, 'import_error', { request_id: msg.request_id, error: err.message }, msg.request_id);
          }
        })();
        break;
      }
      case 'get_imported_pets': {
        try {
          const { listImportedPets } = await import('./lib/codex-importer.js');
          const pets = listImportedPets();
          sendEvent(ws, 'imported_pets', { request_id: msg.request_id, pets }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'import_error', { request_id: msg.request_id, error: err.message }, msg.request_id);
        }
        break;
      }
      case 'delete_imported_pet': {
        try {
          const { deleteImportedPet } = await import('./lib/codex-importer.js');
          deleteImportedPet(msg.pet_id);
          sendEvent(ws, 'import_deleted', { request_id: msg.request_id, pet_id: msg.pet_id }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'import_error', { request_id: msg.request_id, error: err.message }, msg.request_id);
        }
        break;
      }
      case 'search_codex_pets': {
        try {
          const { searchCodexPets } = await import('./lib/codex-importer.js');
          const results = await searchCodexPets(msg.query || '');
          sendEvent(ws, 'codex_search_results', { request_id: msg.request_id, pets: results }, msg.request_id);
        } catch (err) {
          sendEvent(ws, 'import_error', { request_id: msg.request_id, error: err.message }, msg.request_id);
        }
        break;
      }
      case 'import_codex_slug': {
        (async () => {
          try {
            const { importFromSlug } = await import('./lib/codex-importer.js');
            const pet = await importFromSlug(msg.slug);
            sendEvent(ws, 'import_done', { request_id: msg.request_id, pet }, msg.request_id);
          } catch (err) {
            sendEvent(ws, 'import_error', { request_id: msg.request_id, error: err.message }, msg.request_id);
          }
        })();
        break;
      }
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

  // 0. Init FactStore (async — sql.js WASM)
  await getMemoryStore();

  // 1. AgentManager first (Hub depends on it)
  const agentsDir = path.join(getPersistDir(), 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  const { AgentManager: AM } = await import('./core/agent-manager.js');
  _AgentManager = new AM({
    agentsDir,
    memoryStore: await getMemoryStore(),
    ragPipeline: getRAGPipeline(),
  });

  // Initialize built-in agents (idempotent: won't recreate if already exist)
  await _AgentManager.initBuiltinAgents();

  // Session memory for collaboration mode
  const { SessionMemory } = await import('./memory/session-memory.js');
  _SessionMemory = new SessionMemory();

  // Create default user agent if no non-builtin agents
  const userAgents = _AgentManager.listAgents().filter(a => !a.isBuiltin);
  if (userAgents.length === 0) {
    await _AgentManager.createAgent({
      name: 'LU',
      character: 'glassesDog',
      config: { provider: 'claude', model: 'deepseek-v4-pro' },
    });
  }

  // 3. Skill Manager
  const { SkillManager } = await import('./skills/skill-manager.js');
  const builtinSkillsDir = path.join(path.dirname(_require.resolve('./skills/skill-manager.js')), '..', '..', 'skills-builtin');
  const userSkillsDir = path.join(getPersistDir(), 'skills-user');
  fs.mkdirSync(userSkillsDir, { recursive: true });

  _SkillManager = new SkillManager({
    skillDirs: [builtinSkillsDir, userSkillsDir],
  });
  _SkillManager.loadAll();

  // 4. Plugin Manager
  const { PluginManager } = await import('./plugins/plugin-manager.js');
  const builtinPluginsDir = path.join(path.dirname(_require.resolve('./plugins/plugin-manager.js')), '..', '..', 'plugins-builtin');
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
        const config = activeAgent?.config || { provider: 'claude', model: 'deepseek-v4-pro' };
        const messages = activeAgent
          ? activeAgent.injectPersonality([{ role: 'user', content: job.prompt }])
          : [{ role: 'system', content: job.prompt }];

        let resultContent = '';
        await _runAgent({
          config,
          messages,
          convId: `cron-${job.id}`,
          memoryStore: await getMemoryStore(),
          ragPipeline: await getRAGPipeline(),
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

  // ── Memory + Profile + Sleep Mode (Phase 3) ──
  const { MemoryManager } = await import('./memory/index-core.js');
  // 启动时执行一次衰减
  setTimeout(async () => {
    try {
      const fs = _MemoryManager && _MemoryManager.factStore;
      if (fs && typeof fs.decayAll === 'function') {
        const n = fs.decayAll();
        if (n > 0) log.log(`启动衰减: ${n} 条更新`);
      }
    } catch {}
  }, 5000);
  _MemoryManager = await new MemoryManager({
    persistDir: getPersistDir(),
    maxTurns: 20,
  }).ready();

  const { UserProfile } = await import('./lib/user-profile.js');
  _UserProfile = new UserProfile(getPersistDir());

  const { SleepMode } = await import('./lib/sleep-mode.js');
  _SleepMode = new SleepMode({
    memoryManager: _MemoryManager,
    agentManager: _AgentManager,
    llmConfig: { provider: process.env.SLEEP_LLM_PROVIDER || 'deepseek', model: 'deepseek-chat' },
  });

  // ── Emotion + Style (Phase 4) ──
  const { EmotionTrend } = await import('./personality/emotion-trend.js');
  _EmotionTrend = new EmotionTrend(getPersistDir());

  const { StyleAdapter } = await import('./personality/injector.js');
  _StyleAdapter = new StyleAdapter(getPersistDir());

  const { Personality } = await import('./personality/index.js');
  _Personality = new Personality(getPersistDir());

  const { KnowledgeGraph } = await import('./knowledge/knowledge-graph.js');
  _KnowledgeGraph = new KnowledgeGraph({ persistDir: getPersistDir() });
  // 注入 KG 到记忆工具
  import('./tools/index.js').then(m => m.setKG?.(_KnowledgeGraph));

  // Wire sleep mode to heartbeat events
  _Hub.eventBus.subscribe('heartbeat_pulse', () => {
    _SleepMode?.notifyActivity();
    // Try to run sleep reflection
    _SleepMode?.run().catch(() => {});
  });

  // Add agent tools to tool registry
  const { getAgentTools } = await import('./lib/tools/agent-tools.js');
  const agentTools = getAgentTools();
  const { getAllTools: _origGetAll } = await import('./tools/index.js');

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
      await import('./security/gate.js');
      await import('./vision/expert.js');
      const t2 = Date.now();
      log.log(`预热完成 (${t2 - t0}ms)`);
    } catch (err) {
      log.warn(`预热失败: ${err.message}`);
    }
  }, 100); // Defer so server starts first

  // 知识库监控自动启动（延迟 5 秒，等 Hub 就绪）
  setTimeout(async () => {
    try {
      const watcher = await getKBWatcher();
      await watcher.start();
      if (watcher.isRunning) {
        log.log('知识库监控已自动启动');
      }
    } catch (err) {
      log.warn(`知识库监控启动失败: ${err.message}`);
    }
  }, 5000);

  // 反思引擎定时运行（每 10 分钟检查一次）
  setInterval(async () => {
    try {
      const engine = await getReflectionEngine();
      const result = await engine.runReflection();
      if (result.actions.length > 0) {
        log.log(`反思完成: ${result.contradictions} 矛盾, ${result.duplicates} 重复, ${result.inferences} 推理`);
      }
    } catch (err) {
      log.debug(`反思跳过: ${err.message}`);
    }
  }, 600_000); // 10 分钟
}

// ── Start ──
const PORT = getPort();
httpServer.listen(PORT, '127.0.0.1', async () => {
  log.log(`Agent Server 已启动: http://127.0.0.1:${PORT}`);
  _preload();
  // Init Hub non-blocking — server responds immediately,
  // skills/plugins/heartbeats load in background
  initHub().catch(err => { log.error(`Hub 初始化失败: ${err.message}`); log.error(err.stack); });
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

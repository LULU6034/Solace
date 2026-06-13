/**
 * Agent IPC 处理器 (v2 — Node.js Server + WebSocket)
 *
 * 连接 Node.js Agent Server 与渲染进程，替代 Python stdin/stdout 协议。
 */
const { ipcMain, BrowserWindow } = require('electron');
const { ServerBridge } = require('./server-ipc.cjs');

let bridge = null;

function getBridge() {
  if (!bridge) {
    bridge = new ServerBridge();
  }
  return bridge;
}

async function ensureAgentReady() {
  const b = getBridge();
  if (!b.isReady()) {
    console.log('[agent-ipc] 启动 Node.js Agent Server...');
    const ok = await b.start();
    if (!ok) {
      throw new Error('Agent Server 启动失败');
    }
  }
  return b;
}

function safeSend(wc, channel, data) {
  if (wc && !wc.isDestroyed()) {
    wc.send(channel, data);
  }
}

function registerAgentIPC() {
  const b = getBridge();

  // Event type mapping: server event → IPC channel
  const EVENT_MAP = {
    chunk: 'agent-chunk',
    reasoning_chunk: 'agent-reasoning-chunk',
    agent_action: 'agent-action',
    agent_observation: 'agent-observation',
    speak: 'agent-speak',
    done: 'agent-done',
    error: 'agent-error',
    tool_approval_request: 'agent-tool-approval-request',
    memory_updated: 'agent-memory-updated',
    memory_conflict: 'memory-conflict',
    coordinator_start: 'coordinator-start',
    coordinator_info: 'coordinator-info',
    coordinator_done: 'coordinator-done',
    coordinator_error: 'coordinator-error',
    coordinator_review: 'coordinator-review',
    plan_ready: 'plan-ready',
    hatch_done: 'hatch-done',
    hatch_error: 'hatch-error',
    hatched_pets: 'hatched-pets',
    hatch_deleted: 'hatch-deleted',
    agent_pets_ready: 'agent-pets-ready',
    agent_pets: 'agent-pets',
    expert_thought: 'expert-thought',
    expert_reasoning: 'expert-reasoning',
    expert_action: 'expert-action',
    expert_observation: 'expert-observation',
    expert_chunk: 'expert-chunk',
    expert_done: 'expert-done',
    expert_error: 'expert-error',
    security_confirm_required: 'security-confirm-required',
    reminder_fire: 'reminder-fire',
    reminder_list: 'reminder-list',
  };

  // agent-chat: 单 Agent 对话
  ipcMain.handle('agent-chat', async (event, { config, messages, conversationId }) => {
    const wc = event.sender;
    // 强制 DeepSeek（Claude 国内需 VPN，配置文件可能有旧值缓存）
    if (config.provider === 'claude') { config.provider = 'deepseek'; config.model = 'deepseek-v4-pro'; }
    console.log('[agent-ipc] agent-chat request, provider:', config.provider);

    const unsubs = [];

    try {
      await ensureAgentReady();

      // Subscribe to server events and forward to renderer
      for (const [serverEvent, ipcChannel] of Object.entries(EVENT_MAP)) {
        const unsub = b.on(serverEvent, (data) => {
          safeSend(wc, ipcChannel, data);
        });
        unsubs.push(unsub);
      }

      // Send request to server (AFTER registering listeners)
      const requestId = `req-${Date.now()}`;
      console.log('[agent-ipc] agent-chat START:', config.provider, config.model, 'msgs:', messages.length);

      const t0 = Date.now();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Agent 请求超时 (120s)'));
        }, 180_000);

        const doneUnsub = b.on('done', (data) => {
          clearTimeout(timer);
          doneUnsub();
          errorUnsub();
          resolve(data);
        });

        const errorUnsub = b.on('error', (data) => {
          clearTimeout(timer);
          doneUnsub();
          errorUnsub();
          reject(new Error(data?.data?.content || data?.content || 'Agent 执行失败'));
        });

        b.send({
          type: 'agent_chat',
          request_id: requestId,
          config,
          messages,
          conversation_id: conversationId || 'default',
        });
      });

      console.log('[agent-ipc] agent-chat DONE in', Date.now() - t0, 'ms');

      return result;
    } catch (err) {
      console.error('[agent-ipc] agent-chat 失败:', err);
      safeSend(wc, 'agent-error', { content: err.message });
      return { error: err.message };
    } finally {
      for (const unsub of unsubs) unsub();
    }
  });

  // agent-chat-group: 群聊 / 多 Expert 模式
  ipcMain.handle('agent-chat-group', async (event, { config, messages, conversationId, agentIds, mentionedIds, groupSettings }) => {
    const wc = event.sender;
    if (config.provider === 'claude') { config.provider = 'deepseek'; config.model = 'deepseek-v4-pro'; }
    console.log('[agent-ipc] agent-chat-group request, provider:', config.provider, 'agents:', agentIds?.length);

    const unsubs = [];
    try {
      await ensureAgentReady();

      for (const [serverEvent, ipcChannel] of Object.entries(EVENT_MAP)) {
        const unsub = b.on(serverEvent, (data) => {
          safeSend(wc, ipcChannel, data);
        });
        unsubs.push(unsub);
      }

      const requestId = `req-group-${Date.now()}`;

      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('群聊请求超时 (180s)'));
        }, 180_000);

        const doneUnsub = b.on('coordinator_done', (data) => {
          clearTimeout(timer);
          doneUnsub();
          errorUnsub();
          resolve(data);
        });
        const errorUnsub = b.on('coordinator_error', (data) => {
          clearTimeout(timer);
          doneUnsub();
          errorUnsub();
          reject(new Error(data?.data?.content || data?.content || '群聊执行失败'));
        });

        // Send AFTER registering listeners to prevent race condition
        b.send({
          type: 'agent_chat_group',
          request_id: requestId,
          config,
          messages,
          conversation_id: conversationId || 'default',
          agent_ids: agentIds,
          mentioned_ids: mentionedIds,
          group_settings: groupSettings,
        });
      });

      return result;
    } catch (err) {
      console.error('[agent-ipc] agent-chat-group 失败:', err);
      safeSend(wc, 'coordinator-error', { content: err.message });
      return { error: err.message };
    } finally {
      for (const unsub of unsubs) unsub();
    }
  });

  // agent-approve-tool: 工具审批
  ipcMain.on('agent-approve-tool', (_event, { approvalId, approved }) => {
    if (b.isReady()) {
      b.send({ type: 'tool_approval', approval_id: approvalId, approved });
    }
  });

  // agent-index-file: 索引文件
  ipcMain.handle('agent-index-file', async (_event, filePath) => {
    try {
      await ensureAgentReady();
      const requestId = `req-idx-${Date.now()}`;
      b.send({ type: 'index_file', request_id: requestId, file_path: filePath });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: '超时' }), 60_000);
        const unsub = b.on('file_indexed', (data) => {
          clearTimeout(timer); unsub(); resolve(data?.data || data);
        });
      });
    } catch (err) {
      return { error: err.message };
    }
  });

  // agent-search-rag: RAG 搜索
  ipcMain.handle('agent-search-rag', async (_event, query) => {
    try {
      await ensureAgentReady();
      const requestId = `req-rag-${Date.now()}`;
      b.send({ type: 'search_rag', request_id: requestId, query });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ results: [] }), 30_000);
        const unsub = b.on('rag_results', (data) => {
          clearTimeout(timer); unsub(); resolve(data?.data || data);
        });
      });
    } catch (err) {
      return { results: [] };
    }
  });

  // agent-get-memory-count
  ipcMain.handle('agent-get-memory-count', async () => {
    try {
      await ensureAgentReady();
      const requestId = `req-mem-${Date.now()}`;
      b.send({ type: 'get_memory_count', request_id: requestId });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ count: 0 }), 10_000);
        const unsub = b.on('memory_count', (data) => {
          clearTimeout(timer); unsub(); resolve(data?.data || data);
        });
      });
    } catch {
      return { count: 0 };
    }
  });

  // agent-clear-memory
  ipcMain.handle('agent-clear-memory', async () => {
    try {
      await ensureAgentReady();
      b.send({ type: 'clear_memory', request_id: `req-clr-${Date.now()}` });
      return {};
    } catch (err) {
      return { error: err.message };
    }
  });

  // agent-get-indexed-files
  ipcMain.handle('agent-get-indexed-files', async () => {
    try {
      await ensureAgentReady();
      const requestId = `req-files-${Date.now()}`;
      b.send({ type: 'get_indexed_files', request_id: requestId });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ files: [] }), 10_000);
        const unsub = b.on('indexed_files', (data) => {
          clearTimeout(timer); unsub(); resolve(data?.data || data);
        });
      });
    } catch {
      return { files: [] };
    }
  });

  // agent-remove-file
  ipcMain.handle('agent-remove-file', async (_event, fileName) => {
    try {
      await ensureAgentReady();
      b.send({ type: 'remove_file', request_id: `req-rm-${Date.now()}`, file_name: fileName });
      return {};
    } catch (err) {
      return { error: err.message };
    }
  });

  // agent-ping
  ipcMain.handle('agent-ping', async () => {
    try {
      if (!b.isReady()) await ensureAgentReady();
      const requestId = `req-ping-${Date.now()}`;
      b.send({ type: 'ping', request_id: requestId });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ready: false }), 5_000);
        const unsub = b.on('pong', (data) => {
          clearTimeout(timer); unsub(); resolve({ ready: true, ...(data?.data || data) });
        });
      });
    } catch (err) {
      return { ready: false, error: err.message };
    }
  });

  // agent-get-ready
  ipcMain.handle('agent-get-ready', async () => {
    try {
      await ensureAgentReady();
      return { ready: true };
    } catch (err) {
      return { ready: false, error: err.message };
    }
  });

  // ── Agent 管理 ──
  ipcMain.handle('agent-list-all', async () => {
    try {
      await ensureAgentReady();
      const requestId = `req-aglist-${Date.now()}`;
      b.send({ type: 'list_agents', request_id: requestId });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ agents: [] }), 10_000);
        const unsub = b.on('agent_list', (data) => {
          clearTimeout(timer); unsub(); resolve(data?.data || data);
        });
      });
    } catch { return { agents: [] }; }
  });

  ipcMain.handle('agent-create-new', async (_event, { name, character, config }) => {
    try {
      await ensureAgentReady();
      const requestId = `req-agcreate-${Date.now()}`;
      b.send({ type: 'create_agent', request_id: requestId, name, character: character || 'glassesDog', config: config || {} });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: '超时' }), 30_000);
        const unsub = b.on('agent_created', (data) => {
          clearTimeout(timer); unsub(); resolve(data?.data || data);
        });
      });
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('agent-create-with-personality', async (_event, { name, identity, ishiki }) => {
    try {
      await ensureAgentReady();
      const requestId = `req-agcreatep-${Date.now()}`;
      b.send({ type: 'create_agent', request_id: requestId, name, character: 'glassesDog', config: {}, identity, ishiki });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: '超时' }), 30_000);
        const unsub = b.on('agent_created', (data) => {
          clearTimeout(timer); unsub(); resolve(data?.data || data);
        });
      });
    } catch (err) { return { error: err.message }; }
  });

  // agent-confirm-plan: 用户确认/取消协作计划
  ipcMain.handle('agent-confirm-plan', async (_event, { convId, confirmed }) => {
    try {
      await ensureAgentReady();
      b.send({ type: 'confirm_plan', conv_id: convId, confirmed });
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  });

  // agent-list-tools: 获取可用工具列表
  ipcMain.handle('agent-list-tools', async () => {
    try {
      await ensureAgentReady();
      const requestId = `req-tools-${Date.now()}`;
      b.send({ type: 'list_tools', request_id: requestId });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ tools: [] }), 10_000);
        const unsub = b.on('tool_list', (data) => {
          clearTimeout(timer); unsub(); resolve(data?.data || data);
        });
      });
    } catch { return { tools: [] }; }
  });

  ipcMain.handle('agent-switch-to', async (_event, { agent_id }) => {
    try {
      await ensureAgentReady();
      const requestId = `req-agswitch-${Date.now()}`;
      b.send({ type: 'switch_agent', request_id: requestId, agent_id });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: '超时' }), 10_000);
        const unsub = b.on('agent_switched', (data) => {
          clearTimeout(timer); unsub(); resolve(data?.data || data);
        });
      });
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('agent-delete-one', async (_event, { agent_id }) => {
    try {
      await ensureAgentReady();
      const requestId = `req-agdelete-${Date.now()}`;
      b.send({ type: 'delete_agent', request_id: requestId, agent_id });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ deleted: false }), 10_000);
        const unsub = b.on('agent_deleted', (data) => {
          clearTimeout(timer); unsub(); resolve(data?.data || data);
        });
      });
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('agent-update-personality', async (_event, { identity, ishiki }) => {
    try {
      await ensureAgentReady();
      b.send({ type: 'update_agent_personality', identity, ishiki });
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('agent-toggle-shared-memory', async (_event, { enabled }) => {
    try {
      await ensureAgentReady();
      b.send({ type: 'toggle_shared_memory', enabled });
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  });

  // ── Hatch Pet ──
  ipcMain.handle('agent-hatch-pet', async (_event, { config, description }) => {
    try {
      await ensureAgentReady();
      if (!config?.apiKey) return { error: '请先在设置中配置 API Key' };
      const requestId = `req-hatch-${Date.now()}`;
      b.send({ type: 'hatch_pet', request_id: requestId, description, config });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: '生成超时 (30s)' }), 30_000);
        const doneUnsub = b.on('hatch_done', (data) => {
          clearTimeout(timer); doneUnsub(); errorUnsub();
          resolve({ pet: data?.data?.pet || data?.pet });
        });
        const errorUnsub = b.on('hatch_error', (data) => {
          clearTimeout(timer); doneUnsub(); errorUnsub();
          resolve({ error: data?.data?.error || data?.error || '生成失败' });
        });
      });
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('agent-get-hatched-pets', async () => {
    try {
      await ensureAgentReady();
      const requestId = `req-hlist-${Date.now()}`;
      b.send({ type: 'get_hatched_pets', request_id: requestId });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ pets: [] }), 5_000);
        const unsub = b.on('hatched_pets', (data) => {
          clearTimeout(timer); unsub();
          resolve({ pets: data?.data?.pets || data?.pets || [] });
        });
      });
    } catch { return { pets: [] }; }
  });

  ipcMain.handle('agent-delete-hatched-pet', async (_event, { petId }) => {
    try {
      await ensureAgentReady();
      b.send({ type: 'delete_hatched_pet', pet_id: petId });
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('agent-generate-agent-pets', async (_event, { config }) => {
    try {
      await ensureAgentReady();
      const requestId = `req-genpets-${Date.now()}`;
      b.send({ type: 'generate_agent_pets', request_id: requestId, config });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: '生成超时 (120s)' }), 120_000);
        const doneUnsub = b.on('agent_pets_ready', (data) => {
          clearTimeout(timer); doneUnsub(); errorUnsub();
          resolve({ pets: data?.data?.pets || data?.pets || [] });
        });
        const errorUnsub = b.on('hatch_error', (data) => {
          clearTimeout(timer); doneUnsub(); errorUnsub();
          resolve({ error: data?.data?.error || data?.error || '生成失败' });
        });
      });
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('agent-get-agent-pets', async () => {
    try {
      await ensureAgentReady();
      const requestId = `req-apets-${Date.now()}`;
      b.send({ type: 'get_agent_pets', request_id: requestId });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ pets: [] }), 5_000);
        const unsub = b.on('agent_pets', (data) => {
          clearTimeout(timer); unsub();
          resolve({ pets: data?.data?.pets || data?.pets || [] });
        });
      });
    } catch { return { pets: [] }; }
  });

  // ── Codex Pet Import ──
  ipcMain.handle('agent-import-codex-pet', async (_event, { url, filePath } = {}) => {
    try {
      await ensureAgentReady();
      const requestId = `req-import-${Date.now()}`;
      b.send({ type: 'import_codex_pet', request_id: requestId, url, file_path: filePath });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: '导入超时' }), 120_000);
        const doneUnsub = b.on('import_done', (data) => {
          clearTimeout(timer); doneUnsub(); errUnsub();
          resolve({ pet: data?.data?.pet || data?.pet });
        });
        const errUnsub = b.on('import_error', (data) => {
          clearTimeout(timer); doneUnsub(); errUnsub();
          resolve({ error: data?.data?.error || data?.error || '导入失败' });
        });
      });
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('agent-get-imported-pets', async () => {
    try {
      await ensureAgentReady();
      const requestId = `req-ipets-${Date.now()}`;
      b.send({ type: 'get_imported_pets', request_id: requestId });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ pets: [] }), 5_000);
        const unsub = b.on('imported_pets', (data) => {
          clearTimeout(timer); unsub();
          resolve({ pets: data?.data?.pets || data?.pets || [] });
        });
      });
    } catch { return { pets: [] }; }
  });

  ipcMain.handle('agent-delete-imported-pet', async (_event, petId) => {
    try {
      await ensureAgentReady();
      const requestId = `req-delip-${Date.now()}`;
      b.send({ type: 'delete_imported_pet', request_id: requestId, pet_id: petId });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ deleted: false }), 5_000);
        const unsub = b.on('import_deleted', (data) => {
          clearTimeout(timer); unsub();
          resolve({ deleted: true, pet_id: data?.data?.pet_id || data?.pet_id });
        });
      });
    } catch (err) { return { deleted: false, error: err.message }; }
  });

  ipcMain.handle('agent-search-codex-pets', async (_event, query) => {
    try {
      await ensureAgentReady();
      const requestId = `req-scp-${Date.now()}`;
      b.send({ type: 'search_codex_pets', request_id: requestId, query });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ pets: [] }), 10_000);
        const doneUnsub = b.on('codex_search_results', (data) => {
          clearTimeout(timer); doneUnsub(); errUnsub();
          resolve({ pets: data?.data?.pets || data?.pets || [] });
        });
        const errUnsub = b.on('import_error', (data) => {
          clearTimeout(timer); doneUnsub(); errUnsub();
          resolve({ pets: [], error: data?.data?.error || data?.error });
        });
      });
    } catch { return { pets: [] }; }
  });

  ipcMain.handle('agent-import-codex-slug', async (_event, slug) => {
    try {
      await ensureAgentReady();
      const requestId = `req-imslug-${Date.now()}`;
      b.send({ type: 'import_codex_slug', request_id: requestId, slug });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: '导入超时' }), 120_000);
        const doneUnsub = b.on('import_done', (data) => {
          clearTimeout(timer); doneUnsub(); errUnsub();
          resolve({ pet: data?.data?.pet || data?.pet });
        });
        const errUnsub = b.on('import_error', (data) => {
          clearTimeout(timer); doneUnsub(); errUnsub();
          resolve({ error: data?.data?.error || data?.error || '导入失败' });
        });
      });
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('agent-file-comment', async (_event, { filename, config } = {}) => {
    try {
      await ensureAgentReady();
      const requestId = `req-fc-${Date.now()}`;
      b.send({ type: 'file_comment', request_id: requestId, filename, config });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ comment: '嗯…还行吧' }), 8_000);
        const unsub = b.on('file_comment_done', (data) => {
          clearTimeout(timer); unsub();
          resolve({ comment: data?.data?.comment || data?.comment || '哼！' });
        });
      });
    } catch { return { comment: '懒得看了…' }; }
  });

  // ── Memory (Phase 3) ──
  const MEMORY_CHANNELS = {
    'memory-get-facts': { type: 'memory_get_facts', reply: 'memory_facts', key: 'facts' },
    'memory-get-profile': { type: 'memory_get_profile', reply: 'memory_profile', key: 'profile' },
    'memory-get-episodes': { type: 'memory_get_episodes', reply: 'memory_episodes', key: 'episodes' },
    'memory-delete-fact': { type: 'memory_delete_fact', args: (factId) => ({ fact_id: factId }), reply: 'memory_fact_deleted' },
    'memory-delete-profile': { type: 'memory_delete_profile', args: (key) => ({ key }), reply: 'memory_profile_deleted' },
    'memory-delete-episode': { type: 'memory_delete_episode', args: (index) => ({ index }), reply: 'memory_episode_deleted' },
    'memory-clear-all': { type: 'memory_clear_all', reply: 'memory_cleared' },
    'memory-import': { type: 'memory_import', args: (data) => ({ data }), reply: 'memory_imported' },
  };

  for (const [channel, cfg] of Object.entries(MEMORY_CHANNELS)) {
    ipcMain.handle(channel, async (_event, ...handlerArgs) => {
      try {
        await ensureAgentReady();
        const requestId = `req-mem-${Date.now()}`;
        const payload = cfg.args ? cfg.args(...handlerArgs) : {};
        b.send({ type: cfg.type, request_id: requestId, ...payload });
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ error: '超时' }), 10_000);
          const unsub = b.on(cfg.reply, (data) => {
            clearTimeout(timer); unsub();
            if (data.type === 'error') resolve({ error: data?.data?.content });
            else resolve({ [cfg.key || 'ok']: data?.data?.[cfg.key] || true });
          });
        });
      } catch (err) { return { error: err.message }; }
    });
  }

  // ── Knowledge Base ──
  const KB_CHANNELS = {
    'kb-search': { type: 'kb_search', args: (query, opts) => ({ query, topK: opts?.topK, rerank: opts?.rerank }), reply: 'kb_search_result', key: 'results' },
    'kb-ask': { type: 'kb_ask', args: (query, opts) => ({ query, config: opts?.config }), reply: 'kb_ask_result' },
    'kb-index-trigger': { type: 'kb_index_trigger', reply: 'kb_index_done', key: 'result' },
    'kb-index-rebuild': { type: 'kb_index_rebuild', reply: 'kb_index_done', key: 'result' },
    'kb-config': { type: 'kb_config', reply: 'kb_config', key: 'config' },
    'kb-config-update': { type: 'kb_config_update', args: (key, value) => ({ key, value }), reply: 'kb_config_updated' },
  };

  for (const [channel, cfg] of Object.entries(KB_CHANNELS)) {
    ipcMain.handle(channel, async (_event, ...handlerArgs) => {
      try {
        await ensureAgentReady();
        const requestId = `req-kb-${Date.now()}`;
        const payload = cfg.args ? cfg.args(...handlerArgs) : {};
        b.send({ type: cfg.type, request_id: requestId, ...payload });
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ error: '超时' }), 15_000);
          const unsub = b.on(cfg.reply, (data) => {
            clearTimeout(timer); unsub();
            if (data.type === 'error') resolve({ error: data?.data?.content });
            else resolve({ [cfg.key || 'ok']: data?.data?.[cfg.key] || data?.data || true });
          });
        });
      } catch (err) { return { error: err.message }; }
    });
  }

  // ── Personality (P0) ──
  for (const [channel, cfg] of Object.entries({
    'personality-get': { type: 'personality_get', reply: 'personality_data' },
    'personality-set': { type: 'personality_set', args: (opts) => ({ dim: opts.dim, value: opts.value }), reply: 'personality_updated' },
    'personality-set-batch': { type: 'personality_set_batch', args: (opts) => ({ dims: opts.dims }), reply: 'personality_updated' },
  })) {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        await ensureAgentReady();
        const payload = cfg.args ? cfg.args(...args) : {};
        const requestId = `req-pers-${Date.now()}`;
        b.send({ type: cfg.type, request_id: requestId, ...payload });
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ error: '超时' }), 10_000);
          const unsub = b.on(cfg.reply, (data) => {
            clearTimeout(timer); unsub();
            resolve(data?.data || data);
          });
        });
      } catch (err) { return { error: err.message }; }
    });
  }

  // ── 持久化事件监听（不受 agent-chat 生命周期影响）──
  // 这些事件是服务端主动推送的（提醒触发等），需要在 agent-chat 请求之外也保持监听
  b.on('reminder_fire', (data) => {
    const payload = data?.data || data || {};
    console.log('[agent-ipc] reminder_fire:', payload.task || payload.message);
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('reminder-fire', payload);
      }
    }
  });

  console.log('[agent-ipc] IPC 处理器已注册 (Node.js Server + WebSocket)');
}

function stopAgent() {
  if (bridge) {
    bridge.stop();
    bridge = null;
  }
}

module.exports = { registerAgentIPC, stopAgent, getBridge, ensureAgentReady };

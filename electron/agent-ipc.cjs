/**
 * Agent IPC 处理器 (v2 — Node.js Server + WebSocket)
 *
 * 连接 Node.js Agent Server 与渲染进程，替代 Python stdin/stdout 协议。
 */
const { ipcMain } = require('electron');
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
    done: 'agent-done',
    error: 'agent-error',
    tool_approval_request: 'agent-tool-approval-request',
    memory_updated: 'agent-memory-updated',
    coordinator_start: 'coordinator-start',
    coordinator_info: 'coordinator-info',
    coordinator_done: 'coordinator-done',
    coordinator_error: 'coordinator-error',
    coordinator_review: 'coordinator-review',
    plan_ready: 'plan-ready',
    expert_thought: 'expert-thought',
    expert_reasoning: 'expert-reasoning',
    expert_action: 'expert-action',
    expert_observation: 'expert-observation',
    expert_chunk: 'expert-chunk',
    expert_done: 'expert-done',
    expert_error: 'expert-error',
    security_confirm_required: 'security-confirm-required',
  };

  // agent-chat: 单 Agent 对话
  ipcMain.handle('agent-chat', async (event, { config, messages, conversationId }) => {
    const wc = event.sender;
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
        }, 120_000);

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
          reject(new Error('群聊请求超时 (120s)'));
        }, 120_000);

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

  console.log('[agent-ipc] IPC 处理器已注册 (Node.js Server + WebSocket)');
}

function stopAgent() {
  if (bridge) {
    bridge.stop();
    bridge = null;
  }
}

module.exports = { registerAgentIPC, stopAgent, getBridge, ensureAgentReady };

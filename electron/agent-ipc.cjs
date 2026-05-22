/**
 * Agent IPC 处理器
 * 连接 Python Agent 服务与渲染进程
 */
const { ipcMain } = require('electron');
const { PythonBridge } = require('./python-bridge.cjs');

let bridge = null;
let activeSessions = new Map(); // requestId -> { webContents, config }

function getBridge() {
  if (!bridge) {
    bridge = new PythonBridge();
  }
  return bridge;
}

/**
 * 启动 Python Agent 服务
 */
async function ensureAgentReady() {
  const b = getBridge();
  if (!b.isReady()) {
    console.log('[agent-ipc] 启动 Python Agent 服务...');
    const ok = await b.start();
    if (!ok) {
      throw new Error('Python Agent 服务启动失败,请检查 Python 环境和依赖是否安装');
    }
  }
  return b;
}

/**
 * 注册 IPC 处理器
 */
function registerAgentIPC() {
  const b = getBridge();

  // agent-chat: 启动 Agent 对话 (流式事件)
  ipcMain.handle('agent-chat', async (event, { config, messages, conversationId }) => {
    const wc = event.sender;
    console.log('[agent-ipc] agent-chat 请求, provider:', config.provider);

    try {
      await ensureAgentReady();

      // 监听 Python 事件,转发到渲染进程
      const unsubs = [];
      const eventMap = {
        'agent_thought': 'agent-thought',
        'agent_action': 'agent-action',
        'agent_observation': 'agent-observation',
        'chunk': 'agent-chunk',
        'done': 'agent-done',
        'error': 'agent-error',
        'tool_approval_request': 'agent-tool-approval-request',
        'memory_updated': 'agent-memory-updated',
      };

      for (const [pyEvent, ipcEvent] of Object.entries(eventMap)) {
        const unsub = b.on(pyEvent, (data) => {
          wc.send(ipcEvent, data);
        });
        unsubs.push(unsub);
      }

      // 发送请求到 Python
      const result = await b.sendRequest('agent_chat', {
        config,
        messages,
        conversation_id: conversationId || 'default',
      });

      // 清理事件监听
      for (const unsub of unsubs) unsub();
      return result;

    } catch (err) {
      console.error('[agent-ipc] agent-chat 失败:', err);
      wc.send('agent-error', { content: err.message || String(err) });
      return { error: err.message || String(err) };
    }
  });

  // agent-approve-tool: 工具审批响应
  ipcMain.on('agent-approve-tool', (_event, { approvalId, approved }) => {
    console.log('[agent-ipc] 工具审批:', approvalId, approved);
    if (b.isReady()) {
      b.approveTool(approvalId, approved);
    }
  });

  // agent-index-file: 索引文件到 RAG
  ipcMain.handle('agent-index-file', async (_event, filePath) => {
    try {
      await ensureAgentReady();
      const result = await b.sendRequest('index_file', { file_path: filePath }, 60000);
      return result;
    } catch (err) {
      return { error: err.message };
    }
  });

  // agent-search-rag: 搜索 RAG 文档
  ipcMain.handle('agent-search-rag', async (_event, query) => {
    try {
      await ensureAgentReady();
      const result = await b.sendRequest('search_rag', { query }, 30000);
      return result;
    } catch (err) {
      return { error: err.message };
    }
  });

  // agent-get-memory: 获取记忆数量
  ipcMain.handle('agent-get-memory-count', async () => {
    try {
      await ensureAgentReady();
      const result = await b.sendRequest('get_memory_count', {}, 10000);
      return result;
    } catch (err) {
      return { count: 0 };
    }
  });

  // agent-clear-memory: 清空记忆
  ipcMain.handle('agent-clear-memory', async () => {
    try {
      await ensureAgentReady();
      return await b.sendRequest('clear_memory', {}, 10000);
    } catch (err) {
      return { error: err.message };
    }
  });

  // agent-get-indexed-files: 获取已索引文件列表
  ipcMain.handle('agent-get-indexed-files', async () => {
    try {
      await ensureAgentReady();
      return await b.sendRequest('get_indexed_files', {}, 10000);
    } catch (err) {
      return { files: [] };
    }
  });

  // agent-remove-file: 从索引移除文件
  ipcMain.handle('agent-remove-file', async (_event, fileName) => {
    try {
      await ensureAgentReady();
      return await b.sendRequest('remove_file', { file_name: fileName }, 10000);
    } catch (err) {
      return { error: err.message };
    }
  });

  // agent-ping: 健康检查
  ipcMain.handle('agent-ping', async () => {
    try {
      if (!b.isReady()) {
        await ensureAgentReady();
      }
      const result = await b.sendRequest('ping', {}, 5000);
      return { ready: true, ...result };
    } catch (err) {
      return { ready: false, error: err.message };
    }
  });

  // agent-get-ready: 检查就绪状态 + 自动启动
  ipcMain.handle('agent-get-ready', async () => {
    try {
      await ensureAgentReady();
      return { ready: true };
    } catch (err) {
      return { ready: false, error: err.message };
    }
  });

  console.log('[agent-ipc] IPC 处理器已注册');
}

/**
 * 停止 Agent 服务
 */
function stopAgent() {
  if (bridge) {
    bridge.stop();
    bridge = null;
  }
}

module.exports = { registerAgentIPC, stopAgent, getBridge, ensureAgentReady };

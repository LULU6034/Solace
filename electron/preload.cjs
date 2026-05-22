const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openChat: () => ipcRenderer.invoke('open-chat'),
  closeChat: () => ipcRenderer.invoke('close-chat'),
  moveWindow: (dx, dy) => ipcRenderer.invoke('move-window', { dx, dy }),
  feedFile: (filePath) => ipcRenderer.invoke('feed-file', filePath),
  readFileContent: (filePath) => ipcRenderer.invoke('read-file-content', filePath),
  notifyWorking: (isWorking) => ipcRenderer.invoke('notify-working', isWorking),

  // 配置持久化（主进程写文件）
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // LLM 调用走主进程（原生 Node.js 加载 SDK，避免浏览器端 CJS 打包问题）
  llmInit: (config) => ipcRenderer.invoke('llm-init', config),
  llmChat: (config, messages) => ipcRenderer.send('llm-chat', { config, messages }),

  // Agent 模式 — Python LangChain 服务
  agentChat: (config, messages, conversationId) =>
    ipcRenderer.invoke('agent-chat', { config, messages, conversationId }),
  agentApproveTool: (approvalId, approved) =>
    ipcRenderer.send('agent-approve-tool', { approvalId, approved }),
  agentIndexFile: (filePath) =>
    ipcRenderer.invoke('agent-index-file', filePath),
  agentSearchRAG: (query) =>
    ipcRenderer.invoke('agent-search-rag', query),
  agentGetMemoryCount: () =>
    ipcRenderer.invoke('agent-get-memory-count'),
  agentClearMemory: () =>
    ipcRenderer.invoke('agent-clear-memory'),
  agentGetIndexedFiles: () =>
    ipcRenderer.invoke('agent-get-indexed-files'),
  agentRemoveFile: (fileName) =>
    ipcRenderer.invoke('agent-remove-file', fileName),
  agentPing: () =>
    ipcRenderer.invoke('agent-ping'),
  agentGetReady: () =>
    ipcRenderer.invoke('agent-get-ready'),

  onFileFed: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('file-fed', listener)
    return () => ipcRenderer.removeListener('file-fed', listener)
  },
  onWorkingState: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('working-state', listener)
    return () => ipcRenderer.removeListener('working-state', listener)
  },
  onLlmChunk: (cb) => {
    const listener = (_event, text) => cb(text)
    ipcRenderer.on('llm-chunk', listener)
    return () => ipcRenderer.removeListener('llm-chunk', listener)
  },
  onLlmDone: (cb) => {
    const listener = (_event, result) => cb(result)
    ipcRenderer.on('llm-done', listener)
    return () => ipcRenderer.removeListener('llm-done', listener)
  },

  // Agent 事件监听 (v2: 简洁命名)
  onAgentThought: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('agent-thought', listener)
    return () => ipcRenderer.removeListener('agent-thought', listener)
  },
  onAgentAction: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('agent-action', listener)
    return () => ipcRenderer.removeListener('agent-action', listener)
  },
  onAgentObservation: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('agent-observation', listener)
    return () => ipcRenderer.removeListener('agent-observation', listener)
  },
  onAgentChunk: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('agent-chunk', listener)
    return () => ipcRenderer.removeListener('agent-chunk', listener)
  },
  onAgentDone: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('agent-done', listener)
    return () => ipcRenderer.removeListener('agent-done', listener)
  },
  onAgentError: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('agent-error', listener)
    return () => ipcRenderer.removeListener('agent-error', listener)
  },
  onAgentToolApprovalRequest: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('agent-tool-approval-request', listener)
    return () => ipcRenderer.removeListener('agent-tool-approval-request', listener)
  },
  onAgentMemoryUpdated: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('agent-memory-updated', listener)
    return () => ipcRenderer.removeListener('agent-memory-updated', listener)
  },
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openChat: () => ipcRenderer.invoke('open-chat'),
  closeChat: () => ipcRenderer.invoke('close-chat'),
  moveWindow: (dx, dy) => ipcRenderer.invoke('move-window', { dx, dy }),
  feedFile: (filePath) => ipcRenderer.invoke('feed-file', filePath),
  readFileContent: (filePath) => ipcRenderer.invoke('read-file-content', filePath),
  notifyWorking: (isWorking) => ipcRenderer.invoke('notify-working', isWorking),
  pickAvatar: () => ipcRenderer.invoke('pick-avatar'),

  // 配置持久化（主进程写文件）
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // LLM 调用走主进程（原生 Node.js 加载 SDK，避免浏览器端 CJS 打包问题）
  llmInit: (config) => ipcRenderer.invoke('llm-init', config),
  llmChat: (config, messages) => ipcRenderer.send('llm-chat', { config, messages }),

  // Agent 模式 — Python LangChain 服务
  agentChat: (config, messages, conversationId) =>
    ipcRenderer.invoke('agent-chat', { config, messages, conversationId }),
  agentChatGroup: (config, messages, conversationId, agentIds, mentionedIds, groupSettings) =>
    ipcRenderer.invoke('agent-chat-group', { config, messages, conversationId, agentIds, mentionedIds, groupSettings }),
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
  // Agent 管理
  agentList: () =>
    ipcRenderer.invoke('agent-list-all'),
  agentCreate: (name, character, config) =>
    ipcRenderer.invoke('agent-create-new', { name, character, config }),
  agentCreateWithPersonality: (name, identity, ishiki) =>
    ipcRenderer.invoke('agent-create-with-personality', { name, identity, ishiki }),
  agentListTools: () =>
    ipcRenderer.invoke('agent-list-tools'),
  agentConfirmPlan: (convId, confirmed) =>
    ipcRenderer.invoke('agent-confirm-plan', { convId, confirmed }),
  agentSwitch: (agentId) =>
    ipcRenderer.invoke('agent-switch-to', { agent_id: agentId }),
  agentDelete: (agentId) =>
    ipcRenderer.invoke('agent-delete-one', { agent_id: agentId }),
  agentUpdatePersonality: (identity, ishiki) =>
    ipcRenderer.invoke('agent-update-personality', { identity, ishiki }),
  agentToggleSharedMemory: (enabled) =>
    ipcRenderer.invoke('agent-toggle-shared-memory', { enabled }),

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
  onAgentReasoningChunk: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('agent-reasoning-chunk', listener)
    return () => ipcRenderer.removeListener('agent-reasoning-chunk', listener)
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

  // Coordinator / Group Chat 事件
  onCoordinatorStart: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('coordinator-start', listener)
    return () => ipcRenderer.removeListener('coordinator-start', listener)
  },
  onCoordinatorInfo: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('coordinator-info', listener)
    return () => ipcRenderer.removeListener('coordinator-info', listener)
  },
  onCoordinatorDone: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('coordinator-done', listener)
    return () => ipcRenderer.removeListener('coordinator-done', listener)
  },
  onCoordinatorError: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('coordinator-error', listener)
    return () => ipcRenderer.removeListener('coordinator-error', listener)
  },
  onCoordinatorReview: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('coordinator-review', listener)
    return () => ipcRenderer.removeListener('coordinator-review', listener)
  },
  onExpertThought: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('expert-thought', listener)
    return () => ipcRenderer.removeListener('expert-thought', listener)
  },
  onExpertReasoning: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('expert-reasoning', listener)
    return () => ipcRenderer.removeListener('expert-reasoning', listener)
  },
  onExpertAction: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('expert-action', listener)
    return () => ipcRenderer.removeListener('expert-action', listener)
  },
  onExpertObservation: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('expert-observation', listener)
    return () => ipcRenderer.removeListener('expert-observation', listener)
  },
  onExpertChunk: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('expert-chunk', listener)
    return () => ipcRenderer.removeListener('expert-chunk', listener)
  },
  onExpertDone: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('expert-done', listener)
    return () => ipcRenderer.removeListener('expert-done', listener)
  },
  onExpertError: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('expert-error', listener)
    return () => ipcRenderer.removeListener('expert-error', listener)
  },
  onPlanReady: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('plan-ready', listener)
    return () => ipcRenderer.removeListener('plan-ready', listener)
  },
  onSecurityConfirmRequired: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('security-confirm-required', listener)
    return () => ipcRenderer.removeListener('security-confirm-required', listener)
  },
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openChat: () => ipcRenderer.invoke('open-chat'),
  closeChat: () => ipcRenderer.invoke('close-chat'),
  hatchPet: (config, description) => ipcRenderer.invoke('agent-hatch-pet', { config, description }),
  getHatchedPets: () => ipcRenderer.invoke('agent-get-hatched-pets'),
  deleteHatchedPet: (petId) => ipcRenderer.invoke('agent-delete-hatched-pet', petId),
  generateAgentPets: (config) => ipcRenderer.invoke('agent-generate-agent-pets', { config }),
  getAgentPets: () => ipcRenderer.invoke('agent-get-agent-pets'),

  // Codex Pet 导入
  importCodexPet: (opts) => ipcRenderer.invoke('agent-import-codex-pet', opts),
  importCodexSlug: (slug) => ipcRenderer.invoke('agent-import-codex-slug', slug),
  searchCodexPets: (query) => ipcRenderer.invoke('agent-search-codex-pets', query),
  getImportedPets: () => ipcRenderer.invoke('agent-get-imported-pets'),
  deleteImportedPet: (petId) => ipcRenderer.invoke('agent-delete-imported-pet', petId),
  pickCodexFile: () => ipcRenderer.invoke('pick-codex-file'),
  fileComment: (filename, config) => ipcRenderer.invoke('agent-file-comment', { filename, config }),
  readImportedSpritesheet: (petId) => ipcRenderer.invoke('read-imported-spritesheet', petId),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
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
  agentChat: (config, messages, conversationId, chatMode = 'chat', activatedSkill = '') =>
    ipcRenderer.invoke('agent-chat', { config, messages, conversationId, chatMode, activatedSkill }),
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
  onAgentSpeak: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('agent-speak', listener)
    return () => ipcRenderer.removeListener('agent-speak', listener)
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
  onMemoryConflict: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('memory-conflict', listener)
    return () => ipcRenderer.removeListener('memory-conflict', listener)
  },
  onSkillsChanged: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('skills-changed', listener)
    return () => ipcRenderer.removeListener('skills-changed', listener)
  },

  // ── Reminder ──
  onReminderFire: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('reminder-fire', listener)
    return () => ipcRenderer.removeListener('reminder-fire', listener)
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
  onHatchDone: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('hatch-done', listener)
    return () => ipcRenderer.removeListener('hatch-done', listener)
  },
  onHatchError: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('hatch-error', listener)
    return () => ipcRenderer.removeListener('hatch-error', listener)
  },
  onHatchedPets: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('hatched-pets', listener)
    return () => ipcRenderer.removeListener('hatched-pets', listener)
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

  // ── Voice ──
  voiceStartCosyVoice: () => ipcRenderer.invoke('voice-start-cosyvoice'),
  voiceStopCosyVoice: () => ipcRenderer.invoke('voice-stop-cosyvoice'),
  voiceCosyVoiceHealth: () => ipcRenderer.invoke('voice-cosyvoice-health'),
  voiceTtsSynthesize: (text, emotion, voiceId, speed) =>
    ipcRenderer.invoke('voice-tts-synthesize', { text, emotion, voiceId, speed }),
  voiceSessionStart: () => ipcRenderer.invoke('voice-session-start'),
  voiceSessionStop: () => ipcRenderer.invoke('voice-session-stop'),
  voiceInterrupt: () => ipcRenderer.invoke('voice-interrupt'),
  voiceGetVoices: () => ipcRenderer.invoke('voice-get-voices'),
  saveRecording: (dateDir, filename, blob) =>
    ipcRenderer.invoke('agent-save-recording', { dateDir, filename }),

  onVoiceChunk: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('voice-chunk', listener)
    return () => ipcRenderer.removeListener('voice-chunk', listener)
  },
  onCvTtsChunk: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('cv-tts-chunk', listener)
    return () => ipcRenderer.removeListener('cv-tts-chunk', listener)
  },
  onTtsStart: (cb) => {
    const l = (_event, d) => cb(d); ipcRenderer.on('tts-start', l)
    return () => ipcRenderer.removeListener('tts-start', l)
  },
  onTtsStop: (cb) => {
    const l = (_event, d) => cb(d); ipcRenderer.on('tts-stop', l)
    return () => ipcRenderer.removeListener('tts-stop', l)
  },
  onVoiceState: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('voice-state', listener)
    return () => ipcRenderer.removeListener('voice-state', listener)
  },
  onVoiceSubtitle: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('voice-subtitle', listener)
    return () => ipcRenderer.removeListener('voice-subtitle', listener)
  },

  // ── Memory (Phase 3) ──
  memoryGetFacts: () => ipcRenderer.invoke('memory-get-facts'),
  memoryGetProfile: () => ipcRenderer.invoke('memory-get-profile'),
  memoryGetEpisodes: () => ipcRenderer.invoke('memory-get-episodes'),
  memoryDeleteFact: (factId) => ipcRenderer.invoke('memory-delete-fact', factId),
  memoryDeleteProfile: (key) => ipcRenderer.invoke('memory-delete-profile', key),
  memoryDeleteEpisode: (index) => ipcRenderer.invoke('memory-delete-episode', index),
  memoryClearAll: () => ipcRenderer.invoke('memory-clear-all'),
  memoryImport: (data) => ipcRenderer.invoke('memory-import', data),

  // ── Voice Clone (P1) ──
  voiceCloneVoice: (opts) => ipcRenderer.invoke('voice-clone-voice', opts),
  voiceDeleteVoice: (voiceId) => ipcRenderer.invoke('voice-delete-voice', voiceId),

  // ── 记忆图谱 ──
  agentMemoryGetFacts: () => ipcRenderer.invoke('memory-get-facts'),
  agentMemoryGetEpisodes: () => ipcRenderer.invoke('memory-get-episodes'),

  // ── Knowledge Base ──
  kbSearch: (query, opts) => ipcRenderer.invoke('kb-search', query, opts),
  kbAsk: (query, opts) => ipcRenderer.invoke('kb-ask', query, opts),
  kbIndexTrigger: () => ipcRenderer.invoke('kb-index-trigger'),
  kbIndexRebuild: () => ipcRenderer.invoke('kb-index-rebuild'),
  kbGetConfig: () => ipcRenderer.invoke('kb-config'),
  kbUpdateConfig: (key, value) => ipcRenderer.invoke('kb-config-update', key, value),

  // ── Battery ──
  onBatteryProfile: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('battery-profile', listener)
    return () => ipcRenderer.removeListener('battery-profile', listener)
  },

  // ── Window State ──
  onWindowMaximizedChange: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('window-maximized-change', listener)
    return () => ipcRenderer.removeListener('window-maximized-change', listener)
  },

  // ── Netease Music ──
  neteaseLoginStatus: () => ipcRenderer.invoke('netease-login-status'),
  neteaseQrCreate: () => ipcRenderer.invoke('netease-qr-create'),
  neteaseQrCheck: (params) => ipcRenderer.invoke('netease-qr-check', params),
  neteaseBrowserLogin: () => ipcRenderer.invoke('netease-browser-login'),
  neteaseCookieLogin: (cookie) => ipcRenderer.invoke('netease-cookie-login', cookie),
  neteaseLogout: () => ipcRenderer.invoke('netease-logout'),
  neteaseUserPlaylists: (params) => ipcRenderer.invoke('netease-user-playlists', params || {}),
  neteaseLikedSongs: (params) => ipcRenderer.invoke('netease-liked-songs', params || {}),
  neteaseDailySongs: () => ipcRenderer.invoke('netease-daily-songs'),
  neteasePersonalFm: () => ipcRenderer.invoke('netease-personal-fm'),
  neteaseIntelligenceList: (params) => ipcRenderer.invoke('netease-intelligence-list', params),
  neteaseSearch: (params) => ipcRenderer.invoke('netease-search', params),
  neteaseSongUrl: (params) => ipcRenderer.invoke('netease-song-url', params),
  neteaseSongDetail: (params) => ipcRenderer.invoke('netease-song-detail', params),
  neteaseLyric: (params) => ipcRenderer.invoke('netease-lyric', params),
  neteaseRecommendPlaylists: () => ipcRenderer.invoke('netease-recommend-playlists'),
  neteasePlaylistDetail: (params) => ipcRenderer.invoke('netease-playlist-detail', params),
  // Skill 管理
  skillList: () => ipcRenderer.invoke('skill-list'),
  skillEnable: (name, enabled) => ipcRenderer.invoke('skill-enable', { name, enabled }),
  skillInstall: (source) => ipcRenderer.invoke('skill-install', { source }),
  skillUninstall: (name) => ipcRenderer.invoke('skill-uninstall', { name }),
  // ── 自动更新 ──
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateGetVersion: () => ipcRenderer.invoke('update:get-version'),
  onUpdateStatus: (cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },
});

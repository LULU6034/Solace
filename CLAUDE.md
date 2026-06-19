# AI 桌面宠物

Electron + Vue 3 + Canvas 2D 桌面宠物。

## Design System
Always read docs/DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.

## 启动

```powershell
cd D:\Project\ai-desktop-pet-electron
npm run dev           # Vite + Electron 同时启动
```

前端预览: http://localhost:5173/

## 技术栈

- Electron 42 — 透明无边框窗口、系统托盘、IPC
- Vue 3 + Vite 8 — SFC 前端
- Canvas 2D — 像素精灵渲染
- Hono — HTTP 框架 (server/index.js)
- ws — WebSocket 服务
- Anthropic SDK / OpenAI SDK — LLM 流式输出
- sql.js — SQLite (纯 JS/WASM)

## 项目结构

```
electron/
  main.cjs              — 主进程：窗口管理、托盘、IPC、快捷键
  preload.cjs           — contextBridge 暴露 API（70+ IPC 通道）
  ipc/                  — IPC handler（按功能域分组）
    agent-ipc.cjs       — Agent Server 通信
    voice-ipc.cjs       — 语音 TTS/STT
    netease-ipc.cjs     — 网易云音乐 API
    server-ipc.cjs      — Node.js Server 桥接
    llm-ipc.cjs         — LLM SDK 加载
    battery-monitor.cjs — 电池监控
server/
  bootstrap.js          — Server 入口（由 Electron spawn）
  index.js              — Hono HTTP + WebSocket 主文件（2037行）
  core/                 — Agent 核心（7文件）
    agent.js            — Agent 循环（950行）
    agent-manager.js    — Agent 生命周期管理
    agent-router.js     — 多 Agent 路由
    coordinator.js      — 群聊 Coordinator
    llm-client.js       — 统一 LLM 客户端
    sub-agent.js        — 子 Agent 调度
    preload.js          — 对话预加载器
  tools/                — Agent 工具集（13文件）
    index.js, music-tools.js, web-tools.js, file-tools.js, file-ops-tools.js
    skill-tools.js, browser-tool.js, agent-tools.js, command-tool.js
    docx-tool.js, memory-tools.js, memory-store-ref.js, reminder-tool.js
  memory/               — 记忆系统（12文件）
    fact-store-sqlite.js, fact-store-enhanced.js — 事实存储
    episodic.js         — 情境记忆（392条/12天）
    short-term.js       — 短期记忆
    medium-term.js      — 中期记忆
    consolidator.js     — 记忆巩固（合并阈值 0.55，每3轮运行）
    session-memory.js   — 协作模式会话记忆
    index-core.js       — MemoryManager 入口
    extractor.js        — LLM 记忆提取（多维：identity/preference/state）
    retrieval.js        — 多源记忆检索
    inject.js           — 记忆注入提示词
    vector-search.js    — 语义向量搜索
  knowledge/            — 知识库 RAG（18文件）
    indexer.js, retriever.js, chunker.js, embedder.js, graph.js
    reflection.js, curiosity.js, memory-graph.js, watcher.js ...
  voice/                — 语音系统（10文件）
    voice-session.js    — 旧版语音会话
    full-duplex.js      — 新版全双工语音（VAD + 实时 ASR + TTS）
    tts.js, stt.js      — CosyVoice TTS/STT
    dashscope-asr.js    — 阿里 DashScope 实时 ASR (Qwen3)
    deepgram-asr.js     — Deepgram 情绪引擎
    sensevoice-asr.js   — SenseVoice ASR
    minimax-tts.js      — MiniMax TTS（语速已调至 0.90）
    vad-node.js         — 语音活动检测
    circuit-breaker.js  — TTS 熔断保护
  hub/                  — 消息中枢（event-bus, scheduler, channel-router, dm-router）
  skills/               — Skill 管理
  plugins/              — 插件系统
  prompts/              — 提示词模板（default/voice/group/app-guide/tools-guide）
  desk/                 — 后台任务（cron-store, heartbeat）
  pets/                 — Agent 宠物孵化（agent-pets, hatch, hatch-spritesheet）
  rag/                  — RAG 管道
  security/             — 安全网关
  lib/                  — 工具函数（debug-log, prompt-loader, sleep-mode, user-profile, image-gen, codex-importer）
  config/               — 运行时配置
src/
  main.js               — 入口
  App.vue               — 主聊天窗口（玻璃态 UI）
  pages/                — 页面组件
    chat/               — ChatPage, GroupChatPage
    voice/              — VoiceChat, VoiceClonePanel
    music/              — MusicPanel, TopMiniPlayer
    memory/             — MemoryPanel, MemoryGraphPage, ConflictDialog
    knowledge/          — KnowledgePage
    roles/              — RolesPage
    settings/           — SettingsPanel, PrivacyPanel, SkillSettingsPanel
  composables/          — Vue composables（6个）
    useVoice.js, useAmbientSound.js, useFullDuplex.js
    useInstantResponse.js, useUnifiedParticles.js, useAudioContext.js
  llm/                  — 前端 LLM 适配器 (LLMProvider.ts, types.ts)
  store/                — 状态管理 (llmStore.ts)
  animations/           — GSAP 动画 (gsap.ts)
  styles/               — CSS (tokens.css, chat.css)
docs/                   — 设计文档
  DESIGN.md, REVIEW.md, VOICE-DESIGN.md, KNOWLEDGE-BASE-DESIGN.md
```

## 语音系统的两种模式

### VoiceSession（voice-session.js）— 旧模式
- 触发：按住空格说话
- 流程：STT 识别 → Agent 对话 → CosyVoice TTS → 播放
- 状态机：IDLE → LISTENING → THINKING → SPEAKING → IDLE

### FullDuplexSession（full-duplex.js）— 全双工模式
- 触发：底部全双工按钮
- 流程：麦克风 PCM → VAD 分段 → DashScope Qwen3 实时 ASR → Agent → MiniMax TTS → 音频流
- 支持实时打断：Agent 说话时检测新语音 → 中断 TTS → 切换聆听
- 上下文持久化：对话历史保存到 `~/.ai-desktop-pet/fd_voice_history.json`
- 音色感知：音量/语速/情绪适应
- 标点语调：`！`→升调 `？`→升调 `~`→柔和 `...`→停顿  `*词*`→重读
- 情绪推断：Agent 未标 [emotion:xxx] 时自动从标点+关键词推断
- Agent 身份：动态名称（随活跃 Agent），禁止自称 AI

## 记忆系统

| 组件 | 文件 | 用途 |
|------|------|------|
| FactStore | fact-store-sqlite.js | 事实持久化（sql.js） |
| FactStoreEnhanced | fact-store-enhanced.js | 增强事实存储（衰减+搜索） |
| EpisodicMemory | episodic.js | 情境事件（392条/12天） |
| ShortTermMemory | short-term.js | 短期对话缓存 |
| MediumTermMemory | medium-term.js | 中期记忆 |
| MemoryConsolidator | consolidator.js | 去重合并（阈值 0.55，每3轮） |
| SessionMemory | session-memory.js | 协作会话记忆 |
| VectorSearch | vector-search.js | 语义向量搜索 |
| MemoryManager | index-core.js | 管理器入口 |
| Extractor | extractor.js | LLM 多维提取 |
| Retrieval | retrieval.js | 多源检索 |
| Inject | inject.js | 注入提示词 |

## 已完成功能

- 多对话标签页、多 LLM provider 流式输出
- 全双工语音（VAD + 实时 ASR + Agent + TTS + 打断 + 上下文持久化）
- 音乐集成（网易云登录/搜索/播放/歌单/推荐）
- 知识库 RAG（索引/搜索/自动监控）
- 记忆系统（事实+情境+向量搜索+巩固+提取）
- Agent 群聊 / Coordinator 模式
- Skill 系统 + 插件系统
- Cron 定时任务 + Heartbeat
- 安全网关 + 敏感文件过滤
- 2026-06-15：全代码库审查 + 安全加固
- 2026-06-19：前端视觉升级 + 按钮统一 + 语音上下文持久化 + 时间感知 + 代码全面审查修复

## 配置白名单

saveConfig 允许的字段：`provider, apiKey, visionApiKey, dashscopeApiKey, minimaxApiKey, model, baseUrl, deepseekApiKey, deepgramApiKey, hotwords`

## 架构债务

- [ ] server/index.js 拆分（2037行 → routes/http.js + routes/ws.js + init/bootstrap.js）
- [ ] 12 个大文件 >500 行需拆分
- [ ] tools/index.js memory-store-ref.js 循环依赖 → DI 重构
- [ ] agent.js _runAnswerPhase 拆分
- [ ] README.md 更新（当前为 Vue 3 默认模板）
- [ ] Electron 打包（electron-builder）
- [ ] 清理遗留文件 detroit-demo.html

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

- Product ideas/brainstorming → /office-hours
- Strategy/scope → /plan-ceo-review
- Architecture → /plan-eng-review
- Design system/plan review → /design-consultation or /plan-design-review
- Full review pipeline → /autoplan
- Bugs/errors → /investigate
- QA/testing site behavior → /qa or /qa-only
- Code review/diff check → /review
- Visual polish → /design-review
- Ship/deploy/PR → /ship or /land-and-deploy
- Save progress → /context-save
- Resume context → /context-restore

## Karpathy Rules

From [andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills).

### 1. Think Before Coding
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First
- No features beyond what was asked. No abstractions for single-use code.
- If you write 200 lines and it could be 50, rewrite it.

### 3. Surgical Changes
- Touch only what you must. Don't "improve" adjacent code.
- Match existing style, even if you'd do it differently.

### 4. Goal-Driven Execution
- "Fix the bug" → first write a test that reproduces it, then make it pass.
- State success criteria before implementing. Loop until verified.

## 记忆规则

当用户说"保存"、"记住"、"记下来"时，必须执行：
1. 把改动写入 `C:\Users\L\.claude\projects\C--Users-L\memory\ai-desktop-pet-latest-changes.md`
2. 列出所有未解决的问题（含症状、排查方向）
3. 用户需求和偏好写入对应记忆文件
4. 不要只靠 CLAUDE.md — 它会被覆盖，记忆文件是持久的

# AI 桌面宠物

Electron + Vue 3 + Canvas 2D 桌面宠物，灵感来自 HermesPet。

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.

## 启动

```powershell
cd D:\Project\ai-desktop-pet-electron
npm run dev           # Vite + Electron 同时启动
```

前端预览: http://localhost:5173/
宠物窗口: http://localhost:5173/pet.html

## 技术栈

- Electron 42 — 透明无边框窗口、系统托盘、IPC
- Vue 3 + Vite 8 — SFC 前端
- Canvas 2D — 14×10 viewBox 像素精灵渲染
- Zustand 5 — 状态管理
- Anthropic SDK / OpenAI SDK — LLM 流式输出

## 项目结构

```
electron/
  main.cjs              — 主进程：窗口管理、托盘、IPC、快捷键、STT
  preload.cjs           — contextBridge 暴露 API
  ipc/                  — IPC handler（按功能域分组）
    agent-ipc.cjs       — Agent Server 通信
    voice-ipc.cjs       — 语音 TTS/STT
    netease-ipc.cjs     — 网易云音乐 API
    server-ipc.cjs      — Node.js Server 桥接(WebSocket)
    llm-ipc.cjs         — LLM SDK 加载
    battery-monitor.cjs — 电池监控
server/
  bootstrap.js          — Server 入口（由 Electron spawn）
  index.js              — Express HTTP + WebSocket 主文件
  core/                 — Agent 核心
    agent.js            — 两阶段 Agent 循环(Thinking → ReAct)
    llm-client.js       — 统一 LLM 客户端(Claude/DeepSeek/OpenAI)
    sub-agent.js        — 子 Agent 调度
    memory-agent.js     — 记忆提取 Agent
    pipeline.js         — 流式管道
    stream-queue.js     — 流式消息队列
  tools/                — Agent 工具集(13文件)
    index.js            — 工具注册 + 加载
    music-tools.js      — 音乐搜索/推荐/播放
    web-tools.js        — 网页搜索/抓取
    file-tools.js       — 文件读写
    skill-tools.js      — Skill 安装/管理
    ...
  memory/               — 记忆系统(10文件)
    fact-store-sqlite.js, episodic.js, short-term.js, medium-term.js
    vector-search.js, retrieval.js, inject.js ...
  knowledge/            — 知识库 RAG(18文件)
    indexer.js, retriever.js, chunker.js, embedder.js, graph.js ...
  voice/                — 语音(3文件)
    voice-session.js, tts.js, streaming-tts.js
  vision/               — 视觉分析(expert.js)
  hub/                  — 消息中枢(5文件)
  skills/               — Skill 管理(skill-manager.js, skill-installer.js)
  plugins/              — 插件系统(plugin-manager.js)
  prompts/              — 提示词模板
    default.txt, voice.txt, group.txt, app-guide.txt, tools-guide.txt
    personality/, system/, tasks/, templates/, versioning/
  desk/                 — 桌面宠物逻辑
  pets/                 — Agent 宠物孵化
  rag/                  — RAG 检索
  security/             — 安全网关
  lib/                  — 纯工具函数(debug-log, prompt-loader...)
src/
  main.js               — 聊天窗口入口
  App.vue                — 聊天主界面
  PetApp.vue             — Canvas 动画循环 + 闲逛 + 拖放喂食
  pages/                 — 页面组件
    chat/                — ChatPage, GroupChatPage
    voice/               — VoiceChat, VoiceClonePanel
    music/               — MusicPanel, TopMiniPlayer
    memory/              — MemoryPanel, MemoryGraphPage, ConflictDialog
    knowledge/           — KnowledgePage
    roles/               — RolesPage
    settings/            — SettingsPanel, PrivacyPanel, SkillSettingsPanel
  composables/           — Vue composables
    useVoice.js, useAmbientSound.js, useInstantResponse.js
    useUnifiedParticles.js, useAudioContext.js
  llm/                   — 前端 LLM 适配器
    LLMProvider.ts, types.ts
  store/                 — llmStore.ts
  animations/            — GSAP 动画(gsap.ts)
  styles/                — CSS(tokens.css, chat.css)
skills-builtin/         — 内置 Skill(8个: code-assistant/music-expert/web-researcher...)
plugins-builtin/        — 内置插件(weather/)
data/                   — 运行时数据(gitignore)
  cache/, knowledge_base/, vector_store/, users/
scripts/                — 运维脚本
docs/                   — 设计文档
tests/                  — 测试(e2e/integration/unit)

## 已完成

### 2026-06-15 全代码库审查 + 安全加固
- [x] 25 项审查问题全修复 (P0:6, P1:9, P2:6, P3:4)
- [x] taskkill /f /im python.exe → 精准 PID SIGTERM
- [x] 移除硬编码 Tavily API Key → 环境变量
- [x] 移除硬编码开发者路径 → 系统提示词不再泄露
- [x] 安全网关接入主聊天流程（red 级别拦截）
- [x] saveConfig 白名单过滤 + feedFile/readFileContent 路径验证
- [x] Electron sandbox:true + IPC 2MB 消息限制
- [x] 五维人格系统全链路删除 (5文件+5文件引用)
- [x] 设置面板三板块重构 (服务商/隐私/音乐)
- [x] 工具安全加固 (base64传参、异步exec、注入修复)

### 历史
- [x] 宠物窗口：透明 Canvas，requestAnimationFrame 60fps 渲染
- [x] 2 个像素精灵：glassesDog（镜框小狗）、clawd（龙虾）
- [x] 宠物切换：双击切换角色
- [x] 宠物闲逛：随机间隔窗口移动
- [x] 聊天窗口：HermesPet 风格 UI，玻璃态透明窗口
- [x] 多对话标签页：支持 8 个，右键重命名/关闭
- [x] 3 个 LLM provider：Claude(Anthropic) / DeepSeek / OpenAI，流式输出
- [x] 设置面板：API Key 配置，模型选择
- [x] 窗口展开/收起动画（easeOutCubic）
- [x] 拖放文件喂食：拖到宠物窗口触发聊天分析
- [x] 敏感文件过滤：黑名单关键词（薪资/密码/.env/身份证等）
- [x] 宠物拒绝动画：敏感文件抖动
- [x] 宠物进食动画 + AI 工作状态呼吸
- [x] 系统托盘：显示/隐藏/聊天/退出
- [x] 图片粘贴到聊天

## 待修复 / 待实现

### Bug
- [x] **聊天窗口闪退**：已修复 — app.disableHardwareAcceleration() + crashed 事件自动重建 + backgroundColor 显式透明
- [x] **ChatBubble.vue / ChatInput.vue / ConfigPanel.vue**：已清理，3 个孤立文件已删除

### 功能
- [x] 宠物走动动画（原地踏步 450ms 预备 + 离散步伐 + 250ms 收尾）
- [x] 全局快捷键（Ctrl+Shift+P 切换宠物显示）
- [x] 语音输入（Web Speech API，支持中文，连续识别）
- [x] 更多宠物角色（5 个：镜框小狗 / Clawd 龙虾 / 小黑猫 / 小黄鸟 / 小狐狸）
- [ ] Electron 打包（electron-builder）
- [ ] 宠物窗口始终置底（桌面壁纸层）而非 alwaysOnTop

### 架构债务 (2026-06-15 审查标记)
- [ ] server/index.js 上帝文件 (1700+行) → 拆分为 routes/http, routes/ws, init/bootstrap
- [ ] 12 个大文件 >500 行需拆分 (coordinator, reflection, MusicPanel, music-tools...)
- [ ] 75 处空 catch{} 需加 log.warn()
- [ ] 18 处 console.log 需替换为 debug-log 模块
- [ ] tools/index.js memory-store-ref.js 可变单例循环依赖 → DI 重构
- [ ] agent.js _runAnswerPhase 404 行 → 拆分为 5 个函数
- [ ] tools/index.js → ToolRegistry 类替代硬编码数组

## 关键 IPC 通道

| 通道 | 方向 | 用途 |
|------|------|------|
| open-chat | renderer→main | 打开聊天窗口 |
| close-chat | renderer→main | 关闭聊天窗口 |
| move-window | renderer→main | 移动宠物窗口 |
| feed-file | renderer→main | 拖放文件喂给 AI |
| read-file-content | renderer→main | 读取文件内容 |
| notify-working | renderer→main | 通知宠物 AI 工作状态 |
| working-state | main→renderer | 宠物接收工作状态 |
| file-fed | main→renderer | 聊天窗口接收喂食文件 |

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
- Ask: "Would a senior engineer say this is overcomplicated?"

### 3. Surgical Changes
- Touch only what you must. Don't "improve" adjacent code.
- Match existing style, even if you'd do it differently.
- Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution
- "Fix the bug" → first write a test that reproduces it, then make it pass.
- State success criteria before implementing. Loop until verified.

## 记忆规则

当用户说"保存"、"记住"、"记下来"时，必须执行：
1. 把今天做的所有改动写入 `C:\Users\L\.claude\projects\C--Users-L\memory\ai-desktop-pet-latest-changes.md`
2. 列出所有未解决的问题（含症状、排查方向）
3. 用户提出的需求和偏好写入对应记忆文件（如 api-keys-config.md）
4. 不要只靠 `CLAUDE.md` —— 它会被覆盖。记忆文件是持久的

# 项目结构重构方案 v2

> 以 `my_agent_project` 三层架构（记忆→性格→表达）为模板，映射到 Electron + Vue 3 + Node.js 技术栈

---

## 一、映射关系

`my_agent_project`（Python 参考架构）→ `ai-desktop-pet-electron`（当前项目）

```
my_agent_project              →  ai-desktop-pet-electron        说明
──────────────────────────────────────────────────────────────────
config/                       →  server/config/                 配置管理（YAML + schema）
agent/core.py                 →  server/core/agent.js           Agent 主循环
agent/state.py                →  server/core/agent-state.js     ★ 新增：Agent 状态机
agent/context.py              →  server/core/context.js          ★ 新增：上下文窗口管理
agent/memory/                 →  server/memory/                 记忆系统（合并双轨）
agent/personality/            →  server/personality/            性格系统（已有雏形）
agent/prompts/                →  server/prompts/                 ★ 新增：提示词管理
agent/planner/                →  server/planner/                 ★ 新增：规划模块
tools/                        →  server/tools/                  工具系统
workflows/                    →  server/workflows/               ★ 新增：多 Agent 编排
api/                          →  server/routes/                 接口层（WS 事件路由）
evaluation/                   →  evaluation/                     ★ 新增：评估系统
observability/                →  server/observability/           ★ 新增：可观测性
data/                         →  data/                          运行时数据
scripts/                      →  scripts/                       运维脚本
tests/                        →  tests/                         测试
docs/                         →  docs/                          文档
—                             →  src/                           Electron 专属：前端
—                             →  electron/                      Electron 专属：桌面壳
```

---

## 二、目标结构

```
ai-desktop-pet-electron/
├── README.md
├── CLAUDE.md
├── package.json
├── vite.config.js
├── index.html
├── .gitignore
├── .vscode/
│
├── config/                              # ★ 新增：配置管理
│   ├── default.yaml                     # 默认配置
│   ├── development.yaml                 # 开发环境
│   ├── production.yaml                  # 生产环境
│   └── schema.js                        # 配置校验
│
├── server/                              # ── Agent Server ──
│   ├── bootstrap.js                     # 入口
│   ├── index.js                         # WS 连接管理 + 事件路由（瘦身至 ~5KB）
│   │
│   ├── config/                          # ★ 新增：后端配置
│   │   ├── index.js
│   │   ├── loader.js                    # YAML 加载 + schema 校验
│   │   ├── personality/
│   │   │   ├── ocean-baseline.yaml      # OCEAN 基线
│   │   │   ├── style-templates.yaml     # 风格模板
│   │   │   └── evolution-rules.yaml     # 演化规则
│   │   └── tool-policies.yaml           # 工具权限策略
│   │
│   ├── core/                            # Agent 核心
│   │   ├── agent.js                     # Agent 主循环
│   │   ├── agent-state.js               # ★ 新增：状态机（idle/listening/thinking/speaking/executing）
│   │   ├── context.js                   # ★ 新增：上下文窗口管理
│   │   ├── agent-manager.js             # Agent 生命周期管理
│   │   ├── agent-router.js              # Agent 路由分发
│   │   ├── coordinator.js               # 多 Agent 协调
│   │   ├── agent-pets.js                # 宠物 Agent
│   │   └── llm-client.js                # LLM API 客户端
│   │
│   ├── memory/                          # ★ 统一记忆模块
│   │   ├── index.js                     # MemoryManager 门面
│   │   ├── base.js                      # ★ 新增：记忆基类
│   │   ├── fact-store.js                # SQLite 事实存储
│   │   ├── episodic.js                  # 情景记忆
│   │   ├── short-term.js                # 短期缓冲
│   │   ├── medium-term.js               # 中期记忆
│   │   ├── working.js                   # ★ 新增：工作记忆
│   │   ├── retrieval.js                 # 多路检索（语义+时序+性格）
│   │   ├── compression.js               # ★ 新增：记忆压缩
│   │   ├── forgetting.js                # ★ 新增：遗忘策略
│   │   ├── encoding.js                  # ★ 新增：多尺度编码
│   │   ├── vector-search.js             # 向量检索
│   │   ├── inject.js                    # 上下文注入
│   │   └── session-memory.js            # 会话记忆
│   │
│   ├── personality/                     # ★ 扩展：性格系统
│   │   ├── index.js                     # PersonalityManager 门面
│   │   ├── schema.js                    # ★ 新增：性格数据结构（OCEAN + 风格 + 语言模式）
│   │   ├── ocean.js                     # ★ 新增：大五人格计算
│   │   ├── state-affect.js              # ★ 新增：情绪状态管理
│   │   ├── initializer.js               # ★ 新增：性格初始化
│   │   ├── updater.js                   # ★ 新增：性格更新器
│   │   ├── model.js                     # ★ 新增：性格演化模型
│   │   ├── extractor.js                 # ★ 新增：性格特征提取
│   │   ├── conflict-detector.js         # ★ 新增：性格冲突检测
│   │   ├── injector.js                  # 性格注入 Prompt
│   │   ├── tracker.js                   # ★ 新增：演化追踪
│   │   ├── summarizer.js                # ★ 新增：性格摘要生成
│   │   ├── id-rag.js                    # ★ 新增：身份知识图谱
│   │   └── emotion-trend.js             # 情绪趋势分析
│   │
│   ├── prompts/                         # ★ 新增：提示词管理
│   │   ├── index.js                     # PromptManager 门面
│   │   ├── system/                      # 系统提示
│   │   │   ├── base.md                  # 基础系统提示
│   │   │   ├── personality-aware.md     # 性格感知系统提示
│   │   │   └── tool-use.md              # 工具使用提示
│   │   ├── tasks/                       # 任务提示
│   │   │   ├── search.md
│   │   │   ├── chat.md
│   │   │   └── reminder.md
│   │   ├── personality/                 # 性格注入模板
│   │   │   ├── ocean-block.md
│   │   │   ├── style-block.md
│   │   │   └── speech-block.md
│   │   ├── templates/                   # 动态模板
│   │   └── versioning/                  # ★ 新增：版本管理
│   │       └── index.js
│   │
│   ├── planner/                         # ★ 新增：规划模块
│   │   ├── index.js                     # Planner 门面
│   │   ├── base.js                      # 规划基类
│   │   ├── react.js                     # ReAct 规划器
│   │   ├── cot.js                       # Chain-of-Thought 规划器
│   │   └── graph.js                     # DAG 任务图
│   │
│   ├── workflows/                       # ★ 新增：多 Agent 编排
│   │   ├── index.js                     # WorkflowManager 门面
│   │   ├── orchestrator.js              # 编排器
│   │   ├── graph.js                     # 图流程
│   │   └── nodes/                       # 工作流节点
│   │       ├── search.js
│   │       ├── reason.js
│   │       └── execute.js
│   │
│   ├── tools/                           # 工具系统
│   │   ├── index.js                     # 工具注册表
│   │   ├── base.js                      # ★ 新增：工具基类
│   │   ├── registry.js                  # ★ 新增：工具注册
│   │   ├── agent-tools.js               # Agent 工具集
│   │   ├── command-tool.js              # 命令执行
│   │   ├── file-tools.js                # 文件操作
│   │   ├── memory-tools.js              # 记忆工具
│   │   ├── reminder-tool.js             # 提醒工具
│   │   ├── web-tools.js                 # 网页搜索/抓取
│   │   └── music-tools.js               # 音乐工具
│   │
│   ├── routes/                          # ★ 接口层（原散落在 index.js）
│   │   ├── index.js                     # 路由注册表
│   │   ├── chat.js                      # 对话路由
│   │   ├── voice.js                     # 语音路由
│   │   ├── music.js                     # 音乐路由
│   │   ├── memory.js                    # 记忆路由
│   │   ├── knowledge.js                 # 知识库路由
│   │   ├── personality.js               # 性格管理路由
│   │   └── admin.js                     # 管理路由
│   │
│   ├── knowledge/                       # 知识库
│   │   ├── index.js
│   │   ├── chunker.js
│   │   ├── embedder.js
│   │   ├── vector.js
│   │   ├── bm25.js
│   │   ├── retriever.js
│   │   ├── indexer.js
│   │   ├── graph.js
│   │   ├── parser.js
│   │   ├── schema.js
│   │   ├── watcher.js
│   │   ├── cache.js
│   │   ├── config.js
│   │   ├── curiosity.js
│   │   ├── reflection.js
│   │   ├── tools.js
│   │   └── tools-shared.js
│   │
│   ├── voice/                           # 语音
│   │   ├── index.js
│   │   ├── voice-session.js
│   │   ├── tts.js
│   │   └── streaming-tts.js
│   │
│   ├── observability/                   # ★ 新增：可观测性
│   │   ├── index.js
│   │   ├── logger.js                    # 结构化日志
│   │   ├── tracer.js                    # 执行追踪
│   │   ├── cost-tracker.js              # Token 成本追踪
│   │   └── personality-monitor.js       # 性格监控
│   │
│   ├── hub/                             # 事件总线（不动）
│   │   ├── index.js
│   │   ├── event-bus.js
│   │   ├── channel-router.js
│   │   ├── dm-router.js
│   │   └── scheduler.js
│   │
│   ├── security/                        # 安全
│   │   └── gate.js
│   │
│   ├── rag/                             # RAG
│   │   └── pipeline.js
│   │
│   ├── plugins/                         # 插件系统
│   │   └── plugin-manager.js
│   │
│   ├── skills/                          # 技能系统
│   │   ├── skill-manager.js
│   │   └── skill-installer.js
│   │
│   ├── vision/                          # 视觉
│   │   └── expert.js
│   │
│   ├── pets/                            # 宠物后端
│   │   ├── agent-pets.js
│   │   ├── hatch.js
│   │   └── hatch-spritesheet.js
│   │
│   ├── desk/                            # 桌面常驻
│   │   ├── cron-store.js
│   │   └── heartbeat.js
│   │
│   ├── characters/                      # 角色定义
│   ├── plugins-builtin/                 # 内置插件
│   ├── skills-builtin/                  # 内置技能
│   │
│   └── lib/                             # 纯工具函数
│       ├── debug-log.js
│       ├── image-gen.js
│       ├── codex-importer.js
│       ├── user-profile.js
│       └── sleep-mode.js
│
├── src/                                 # ── 前端 ──
│   ├── main.js                          # 入口
│   ├── App.vue                          # 根组件
│   ├── PetApp.vue                       # 宠物窗口
│   │
│   ├── pages/                           # 页面组件（按功能域分组）
│   │   ├── chat/
│   │   │   ├── ChatPage.vue
│   │   │   ├── GroupChatPage.vue
│   │   │   └── AgentSteps.vue
│   │   ├── voice/
│   │   │   ├── VoiceChat.vue
│   │   │   └── VoiceClonePanel.vue
│   │   ├── music/
│   │   │   ├── MusicPanel.vue
│   │   │   ├── MusicPlayer.vue
│   │   │   └── TopMiniPlayer.vue
│   │   ├── memory/
│   │   │   ├── MemoryPanel.vue
│   │   │   ├── MemoryGraph.vue
│   │   │   ├── MemoryGraphPage.vue
│   │   │   └── ConflictDialog.vue
│   │   ├── knowledge/
│   │   │   └── KnowledgePage.vue
│   │   ├── roles/
│   │   │   └── RolesPage.vue
│   │   ├── personality/
│   │   │   └── PersonalityPanel.vue
│   │   └── settings/
│   │       ├── SettingsPanel.vue
│   │       └── PrivacyPanel.vue
│   │
│   ├── composables/                     # Vue composables
│   │   ├── useVoice.js
│   │   ├── useAmbientSound.js
│   │   ├── useAnimOrchestrator.js
│   │   ├── useInstantResponse.js
│   │   └── useUnifiedParticles.js
│   │
│   ├── llm/                             # LLM 适配器
│   │   ├── LLMProvider.ts
│   │   ├── types.ts
│   │   └── adapters/
│   │
│   ├── pets/                            # 宠物精灵渲染
│   ├── animations/                      # 动画
│   ├── store/                           # Zustand
│   ├── assets/                          # 静态资源
│   └── styles/                          # 全局样式
│
├── electron/                            # ── Electron 桌面壳 ──
│   ├── main.cjs                         # 主进程
│   ├── preload.cjs                      # 预加载
│   └── ipc/                             # IPC handler
│       ├── agent-ipc.cjs
│       ├── voice-ipc.cjs
│       ├── netease-ipc.cjs
│       ├── server-ipc.cjs
│       ├── llm-ipc.cjs
│       └── battery-monitor.cjs
│
├── data/                                # ★ 新增：运行时数据（gitignore）
│   ├── vector_store/
│   ├── knowledge_base/
│   ├── cache/
│   └── users/
│       └── {user_id}/
│           ├── personality.json
│           ├── memory.db
│           └── logs/
│
├── evaluation/                          # ★ 新增：评估系统
│   ├── metrics/
│   │   ├── personality.js
│   │   ├── persona-score.js
│   │   └── memory.js
│   ├── benchmarks/
│   └── runner.js
│
├── tests/                               # ★ 重构：测试目录
│   ├── unit/
│   │   ├── memory/
│   │   ├── personality/
│   │   └── tools/
│   ├── integration/
│   └── e2e/
│
├── scripts/                             # 运维脚本
│   ├── clone-voice.mjs
│   ├── recover-memory.py
│   ├── setup-cosyvoice.sh
│   ├── start-cosyvoice.sh
│   ├── test-memory.mjs
│   ├── clean-dirty-tags.mjs
│   └── cosyvoice-server.py
│
└── docs/                                # 文档
    ├── architecture.md
    ├── DESIGN.md
    ├── REVIEW.md
    ├── VOICE-DESIGN.md
    ├── personality-system.md
    ├── restructure-plan.md
    └── api-reference.md
```

---

## 三、新增模块详细设计

### 3.1 `server/config/` — 配置管理

对标 `my_agent_project/config/`。当前项目的配置散落在 `.env`、`electron/main.cjs`（safeStorage）、硬编码常量三处。

```
server/config/
├── index.js              # getConfig(key), loadConfig(env)
├── loader.js             # YAML 加载 + schema 校验
├── default.yaml          # 默认值
├── personality/
│   ├── ocean-baseline.yaml
│   ├── style-templates.yaml
│   └── evolution-rules.yaml
└── tool-policies.yaml    # 工具权限
```

**实现要点**：
- 用 `js-yaml`（已安装）加载 YAML
- 环境变量覆盖 YAML 值
- schema.js 用 JSON Schema 校验关键配置
- 性格相关的 YAML 直接从 `my_agent_project` 的设计移植

### 3.2 `server/core/agent-state.js` — Agent 状态机

对标 `agent/state.py`。当前 Agent 没有明确的状态机，状态隐式分布在 `agent-ipc.cjs` 和 `VoiceChat.vue` 中。

```
状态定义:
  idle        → 空闲，等待唤醒
  listening   → 语音监听中
  thinking    → LLM 推理中
  speaking    → TTS 播放中
  executing   → 工具执行中
  sleeping    → 睡眠模式

状态转换:
  idle → listening  (用户点击语音按钮 / 唤醒词)
  listening → thinking  (语音识别完成)
  thinking → speaking  (LLM 生成回复)
  thinking → executing  (需要调用工具)
  executing → thinking  (工具结果返回，继续推理)
  speaking → idle  (播放完成)
  * → sleeping  (超时无交互)
  sleeping → idle  (唤醒)
```

**实现要点**：
- 纯状态机，不依赖任何框架
- 每个转换触发事件（通过 hub/event-bus）
- 前端通过 IPC 订阅状态变化，驱动 UI

### 3.3 `server/core/context.js` — 上下文窗口管理

对标 `agent/context.py`。当前上下文管理在 `agent.js` 的 `buildMessages()` 中硬编码。

**功能**：
- 动态上下文窗口分配（system prompt / memory / conversation / tools）
- Token 预算管理（按模型不同限制不同）
- 记忆注入优先级排序
- 工具结果截断策略

### 3.4 `server/memory/` — 统一记忆系统（扩展）

对标 `agent/memory/`。在合并 `core/memory/` + `lib/memory/` 的基础上，补齐参考架构中的模块。

**新增文件**：
| 文件 | 来源 | 说明 |
|------|------|------|
| `base.js` | 新增 | 记忆基类，定义 store/recall/forget 接口 |
| `working.js` | 新增 | 工作记忆：当前会话的临时信息 |
| `compression.js` | 新增 | 记忆压缩：长对话 → 摘要 |
| `forgetting.js` | 新增 | 遗忘策略：低价值记忆清理 |
| `encoding.js` | 新增 | 多尺度编码：事实 → 信念 → 模式 |

**现有文件归并**：
| 现有位置 | 新位置 |
|----------|--------|
| `server/core/memory/episodic.js` | `server/memory/episodic.js` |
| `server/core/memory/fact-store-enhanced.js` | 合并到 `server/memory/fact-store.js` |
| `server/core/memory/short-term.js` | `server/memory/short-term.js` |
| `server/core/memory/medium-term.js` | `server/memory/medium-term.js` |
| `server/core/memory/vector-search.js` | `server/memory/vector-search.js` |
| `server/core/memory/retrieval.js` | `server/memory/retrieval.js` |
| `server/core/memory/inject.js` | `server/memory/inject.js` |
| `server/core/memory/index.js` | 合并到 `server/memory/index.js` |
| `server/lib/memory/fact-store.js` | `server/memory/fact-store.js` |
| `server/lib/memory/session-memory.js` | `server/memory/session-memory.js` |

### 3.5 `server/personality/` — 性格系统（扩展）

对标 `agent/personality/`。当前只有 3 个文件（`personality.js`、`style-adapter.js`、`emotion-trend.js`），需要扩展到 12 个文件。

**新增文件**：
| 文件 | 说明 |
|------|------|
| `schema.js` | 性格数据结构定义：OCEAN 五维度 + 风格 + 语言模式 |
| `ocean.js` | 大五人格计算：维度读取、归一化、边界约束 |
| `state-affect.js` | 情绪状态管理：当前情绪 + 唤醒度 + 效价 |
| `initializer.js` | 性格初始化：从角色模板 + 用户偏好初始化 |
| `updater.js` | 性格更新器：处理显式/隐式反馈信号 |
| `model.js` | 演化模型：基于规则的增量更新 |
| `extractor.js` | 特征提取：从对话中提取性格信号 |
| `conflict-detector.js` | 冲突检测：新观察 vs 已有性格的矛盾 |
| `tracker.js` | 演化追踪：记录每次性格变化的 delta + 原因 |
| `summarizer.js` | 性格摘要：生成人类可读的性格描述 |
| `id-rag.js` | 身份知识图谱：信念-特质-价值观的结构化建模 |

**现有文件归并**：
| 现有位置 | 新位置 | 说明 |
|----------|--------|------|
| `server/core/personality.js` | `server/personality/index.js` | 重命名，作为门面 |
| `server/core/style-adapter.js` | `server/personality/injector.js` | 重命名，语义更清晰 |
| `server/core/emotion-trend.js` | `server/personality/emotion-trend.js` | 直接移动 |

### 3.6 `server/prompts/` — 提示词管理

对标 `agent/prompts/`。当前所有 prompt 以模板字符串硬编码在 `agent.js` 中，随着系统复杂化会变得不可维护。

```
server/prompts/
├── index.js              # PromptManager: 加载、渲染、缓存
├── system/
│   ├── base.md           # 基础系统提示（角色定义）
│   ├── personality-aware.md  # 注入性格参数的系统提示
│   └── tool-use.md       # 工具使用说明
├── tasks/
│   ├── search.md         # 搜索任务提示
│   ├── chat.md           # 闲聊任务提示
│   └── reminder.md       # 提醒任务提示
├── personality/
│   ├── ocean-block.md    # OCEAN 维度注入块
│   ├── style-block.md    # 风格注入块
│   └── speech-block.md   # 语言模式注入块
├── templates/            # 动态模板（运行时拼接）
└── versioning/
    └── index.js          # 模板版本管理
```

**实现要点**：
- 模板以 Markdown 文件存储，用 `{{placeholder}}` 语法
- `PromptManager` 负责加载 + 渲染 + 缓存
- 版本化：每次修改生成新版本，旧版本保留用于 A/B 对比

### 3.7 `server/planner/` — 规划模块

对标 `agent/planner/`。当前 Agent 使用简单的 ReAct 循环，没有独立的规划抽象。

```
server/planner/
├── index.js              # Planner 门面：根据任务类型选择规划器
├── base.js               # 规划基类：plan(goal) → steps[]
├── react.js              # ReAct 规划器：Thought → Action → Observation 循环
├── cot.js                # Chain-of-Thought 规划器：逐步推理
└── graph.js              # DAG 任务图：复杂多步任务的依赖图
```

### 3.8 `server/workflows/` — 多 Agent 编排

对标 `workflows/`。当前只有简单的单 Agent 循环（`agent.js`），没有多 Agent 协作。

```
server/workflows/
├── index.js              # WorkflowManager 门面
├── orchestrator.js       # 编排器：任务分解 → Agent 分配 → 结果聚合
├── graph.js              # 图流程：节点 + 边 + 条件
└── nodes/                # 可复用工作流节点
    ├── search.js         # 搜索节点
    ├── reason.js         # 推理节点
    └── execute.js        # 执行节点
```

### 3.9 `server/routes/` — 接口层

对标 `api/routes/`。当前所有 WS 事件处理逻辑全塞在 `server/index.js`（64KB），需要拆分。

```
server/routes/
├── index.js              # 路由注册表：eventType → handler
├── chat.js               # 'chat' 事件 → agent.js 调用
├── voice.js              # 'voice_start', 'voice_input', 'voice_stop'
├── music.js              # 'search_music', 'play_music', 'recommend_music'
├── memory.js             # 'memory_get_facts', 'memory_store', 'memory_recall'
├── knowledge.js          # 'knowledge_index', 'knowledge_search'
├── personality.js        # 'personality_get', 'personality_update'
└── admin.js              # 'server_status', 'clear_cache'
```

**现有内容拆分**：`server/index.js` 中的 IPC handler 逻辑按事件类型分配到以上文件。

### 3.10 `server/observability/` — 可观测性

对标 `observability/`。当前日志用 `console.log` 散落各处，没有结构化日志和成本追踪。

```
server/observability/
├── index.js              # 初始化
├── logger.js             # 结构化日志（JSON 格式，带 timestamp + module + traceId）
├── tracer.js             # 请求追踪：每个对话轮次一个 traceId
├── cost-tracker.js       # Token 成本追踪：按模型/会话/用户统计
└── personality-monitor.js  # 性格漂移监控：记录每次 OCEAN 变化
```

### 3.11 `evaluation/` — 评估系统

对标 `evaluation/`。当前没有自动化评估，全靠人工测试。

```
evaluation/
├── metrics/
│   ├── personality.js    # 性格一致性评估
│   ├── persona-score.js  # 人设一致性评分
│   └── memory.js         # 记忆召回准确率
├── benchmarks/           # 基准测试数据集（人工构建）
└── runner.js             # 批量运行器
```

**初期范围**：先建目录和接口，基准数据集后续补充。

### 3.12 `data/` — 运行时数据目录

对标 `data/`。当前运行时数据散落在 `electron/` 的 `app.getPath('userData')` 和 `AGENT_PERSIST_DIR` 两处。统一到一个清晰的运行时数据目录，加入 `.gitignore`。

---

## 四、实施计划

### Phase 1：清理（零风险，不影响运行）

| 步骤 | 操作 | 文件数 |
|------|------|--------|
| 1.1 | 根目录文档 `DESIGN.md`, `REVIEW.md`, `VOICE-DESIGN.md` → `docs/` | 3 移动 |
| 1.2 | `test-memory.mjs`, `clean-dirty-tags.mjs` → `scripts/` | 2 移动 |
| 1.3 | 删除 `python/agent_loop.py`, `agent_service.py`, `memory_store.py`, `rag_pipeline.py`, `security_gate.py`, `vision_expert.py`, `intent_coordinator.py`, `diag.py`, `voice-features.py`, `tools/` | ~12 删除 |
| 1.4 | `python/cosyvoice-server.py` → `scripts/cosyvoice-server.py` | 1 移动 |
| 1.5 | 删除 `electron/python-bridge.cjs` | 1 删除 |
| 1.6 | 创建空目录结构：`config/`, `data/`, `evaluation/`, `tests/` | 0 文件 |
| 1.7 | 更新 `.gitignore`（加 `data/`, `.env`） | 1 编辑 |

### Phase 2：前端重组（`src/`）

| 步骤 | 操作 | 文件数 |
|------|------|--------|
| 2.1 | 创建 `src/pages/{chat,voice,music,memory,knowledge,roles,personality,settings}/` | — |
| 2.2 | 移动组件到对应 pages 子目录 | 17 移动 |
| 2.3 | `src/lib/*.js`（composables）→ `src/composables/` | 5 移动 |
| 2.4 | `src/lib/llm/` → `src/llm/` | 4 移动 |
| 2.5 | 更新所有 import 路径（Vue components + JS imports） | ~30 编辑 |
| 2.6 | 验证：`npm run dev` 启动不报错 | — |

### Phase 3：后端重组（`server/`）

| 步骤 | 操作 | 文件数 |
|------|------|--------|
| 3.1 | 创建新目录结构（memory、knowledge、tools、voice、personality、prompts、planner、workflows、routes、observability、config） | — |
| 3.2 | 合并 memory：`core/memory/` + `lib/memory/` → `server/memory/` | ~10 移动+合并 |
| 3.3 | 上提 `lib/knowledge/` → `server/knowledge/` | ~18 移动 |
| 3.4 | 上提 `lib/tools/` + `lib/music/tools.js` → `server/tools/` | ~9 移动 |
| 3.5 | 新建 `server/voice/`：从 `core/voice-session.js`, `core/tts.js`, `core/streaming-tts.js` | 3 移动 |
| 3.6 | 扩展 `server/personality/`：合并 `core/personality.js`, `core/style-adapter.js`, `core/emotion-trend.js` + 新增骨架文件 | 3 移动 + 9 新建 |
| 3.7 | 新建 `server/prompts/`：从 `agent.js` 提取提示词模板为 `.md` 文件 | ~6 新建 |
| 3.8 | 新建 `server/planner/`：从 `agent.js` 提取 ReAct 循环 | ~4 新建 |
| 3.9 | 新建 `server/workflows/`：骨架 | ~4 新建 |
| 3.10 | 上提 `lib/security/`, `lib/rag/`, `lib/plugins/`, `lib/skills/`, `lib/vision/`, `lib/desk/` | ~10 移动 |
| 3.11 | 拆分 `server/index.js`：路由逻辑散到 `server/routes/` | 1 拆分 → ~8 |
| 3.12 | `server/lib/` 仅保留纯工具函数 | — |
| 3.13 | 新建 `server/config/`：迁移硬编码常量 | ~4 新建 |
| 3.14 | 新建 `server/observability/`：骨架 | ~4 新建 |
| 3.15 | 更新所有 require 路径 | ~50 编辑 |
| 3.16 | 验证：`npm run dev` 启动 + Agent 对话 + 语音 + 音乐 | — |

### Phase 4：Electron 整理

| 步骤 | 操作 | 文件数 |
|------|------|--------|
| 4.1 | 创建 `electron/ipc/`，移入 6 个 IPC 文件 | 6 移动 |
| 4.2 | 更新 `main.cjs` 和 `preload.cjs` 的 require 路径 | 2 编辑 |

### Phase 5：收尾

| 步骤 | 操作 | 文件数 |
|------|------|--------|
| 5.1 | 更新 `CLAUDE.md` 项目结构图 | 1 编辑 |
| 5.2 | 全量功能验证 | — |
| 5.3 | `git commit` 提交最终状态 | — |

---

## 五、风险与策略

### 关键风险

| 风险 | 缓解 |
|------|------|
| `server/index.js` 拆分后事件路由断裂 | 保留旧文件不改，新 routes 逐步切流 |
| memory 合并导致两套 fact-store 数据不一致 | Phase 3.2 先做只读合并，写路径保持单点 |
| 大范围 rename 后 import 漏改 | 每步跑 `npm run dev`，报错即时修 |
| 新建 skeleton 文件引发 "空模块" 报错 | 骨架文件只导出空对象，不引入调用链 |

### 回滚策略

每个 Phase 做完后独立 `git commit`。任一 Phase 出问题，`git reset --hard` 回到上一个 commit。

### 不建议改动的

- `node_modules/` 中的 patch（`@neteasecloudmusicapienhanced` 等）
- `package.json` 的依赖声明
- `vite.config.js`、`index.html`
- Vue 组件内部逻辑（只移文件不改代码）

---

## 六、文件统计

| 阶段 | 新建 | 移动 | 删除 | 编辑 | 合计 |
|------|------|------|------|------|------|
| Phase 1 | 0 | 6 | ~14 | 1 | ~21 |
| Phase 2 | 0 | 26 | 0 | ~30 | ~56 |
| Phase 3 | ~30 | ~53 | 0 | ~50 | ~133 |
| Phase 4 | 0 | 6 | 0 | 2 | ~8 |
| Phase 5 | 0 | 0 | 0 | 1 | ~1 |
| **合计** | **~30** | **~91** | **~14** | **~84** | **~219** |

---

## 七、关键设计细节（评审补充）

### 7.1 性格演化的触发机制

**问题**：`personality/updater.js` 需要一个触发时机——每次对话结束后分析反馈/情绪/冲突，更新 OCEAN 参数。当前 `runAgentLoop` 没有明确的"结束回调"。

**方案**：在 `agent.js` 主循环结束时通过 `hub/event-bus` 发射事件：

```
agent.js runAgentLoop() 结束点
  → hub.emit('conversation:turn:ended', { userId, messages, toolCalls, duration })
  → personality/index.js 订阅该事件
    → updater.update(turnData)        // 提取信号，计算 delta
    → conflict-detector.check()       // 冲突检测
    → ocean.applyDelta(delta)         // 应用更新
    → tracker.log(change)             // 记录演化
    → summarizer.regenerate()         // 重新生成性格摘要
```

**实现**：Phase 3.5 做 `personality/` 扩展时，先在 `index.js` 中订阅 `conversation:turn:ended`，updater 先做简单规则（用户点赞 → agreeableness +0.005），演化模型后续接入。

### 7.2 记忆检索的性格加权

**问题**：`retrieval.js` 的三路检索中，"性格感知"不是简单向量相似度——需要根据当前性格参数调整检索权重。

**方案**：在 `retrieval.js` 中实现 `personaWeightedScore(memory, personality)`：

```
// 举例：开放性高的用户，对 "novelty" 标签的记忆加权
function personaWeightedScore(memory, personality) {
  let weight = 1.0
  if (personality.ocean.openness > 0.7 && memory.tags.includes('novelty')) {
    weight *= 1.3
  }
  if (personality.ocean.agreeableness > 0.7 && memory.tags.includes('social')) {
    weight *= 1.2
  }
  return memory.similarity * weight
}
```

**实现**：Phase 3.2 memory 合并时实现简单加权函数。ID-RAG 知识图谱的深度加权留到后续迭代。

### 7.3 提示词模板渲染缓存

**问题**：每个对话轮次都要渲染 system prompt，包含 personality 注入块，纯字符串拼接有性能损耗。

**方案**：
- 模板引擎选型：用项目已有的 `marked` 做 Markdown 渲染，占位符用简单的 `{{key}}` 正则替换（不需要额外安装 nunjucks）
- 缓存策略：`PromptManager` 根据 `personality.hash` + `config.hash` 做 key，缓存渲染后的 system prompt
- 失效时机：性格参数变化或系统配置更新时清缓存

```
class PromptManager {
  constructor() {
    this._cache = new Map()  // key: "ocean:0.7:0.5:0.6:0.8:0.3|style:0.4:0.9:..."
  }
  buildSystemPrompt(personality, config) {
    const key = hash(personality) + '|' + hash(config)
    if (this._cache.has(key)) return this._cache.get(key)
    const rendered = this._render('system/personality-aware.md', { personality, config })
    this._cache.set(key, rendered)
    return rendered
  }
}
```

**实现**：Phase 3.7 prompts 模块建立时一起实现。

### 7.4 状态机与前端联动

**问题**：`VoiceChat.vue` 中硬编码了 `isThinking`、`isSpeaking` 等布尔变量，与后端状态不同步。

**方案**：
- 后端：`agent-state.js` 状态转换时通过 `event-bus` 广播 `agent:state:changed` 事件
- IPC 层：`agent-ipc.cjs` 订阅该事件，转发给 renderer
- 前端：新增 `src/composables/useAgentState.js`，单一订阅点

```
// useAgentState.js
export function useAgentState() {
  const state = ref('idle')
  const sub = window.electronAPI?.onAgentStateChanged((s) => { state.value = s })
  onUnmounted(sub)
  return {
    state,                           // 'idle' | 'listening' | 'thinking' | 'speaking' | 'executing'
    isIdle: computed(() => state.value === 'idle'),
    isThinking: computed(() => state.value === 'thinking'),
    isSpeaking: computed(() => state.value === 'speaking'),
  }
}
```

**实现**：Phase 3.1 建 `agent-state.js` 时同步建 `useAgentState.js`，Phase 2 重构 VoiceChat.vue 时替换硬编码变量。

### 7.5 用户数据迁移脚本

**问题**：`data/users/{user_id}/` 需要从当前存储位置迁移：
- `electron.app.getPath('userData')` → `facts_*.db`, `memory_*.db`
- `AGENT_PERSIST_DIR` → 知识库、向量索引
- `config.enc`（safeStorage 加密的配置）

**方案**：在 Phase 3 开始前执行 `scripts/migrate-user-data.js`：

```
1. 检测旧数据位置：
   - Windows: %APPDATA%/ai-desktop-pet-electron/
   - AGENT_PERSIST_DIR 环境变量
2. 检测新数据位置：
   - $PROJECT_ROOT/data/users/default/
3. 迁移逻辑：
   - facts_*.db → data/users/default/memory.db
   - knowledge/ 目录 → data/knowledge_base/
   - config.enc → 保持不变（Electron safeStorage 绑定机器）
4. 迁移后不删除旧文件，记录 .migrated 标记文件
```

**实现**：Phase 3 开始前（Phase 2.6 之后）编写并执行。

### 7.6 routes 渐进式切换（双写策略）

**问题**：`server/index.js` 拆分后，事件可能因为新 handler 未注册而丢失。

**方案**：不直接删除旧代码，采用双写 + 开关：

```
// server/index.js 改造
const { chatRouter } = require('./routes/chat')
const USE_NEW_ROUTES = process.env.USE_NEW_ROUTES === 'true'

ws.on('message', (raw) => {
  const event = JSON.parse(raw)

  if (USE_NEW_ROUTES && chatRouter.canHandle(event.type)) {
    chatRouter.handle(event)           // 新路由
  } else {
    handleEventLegacy(event)            // 旧逻辑（保留不动）
  }
})
```

**切换步骤**：
1. Phase 3.11：创建 `routes/` 文件，旧逻辑完整保留
2. 设置 `USE_NEW_ROUTES=true` 测试新路由
3. 确认稳定后删除旧代码，移除开关

### 7.7 LLM 客户端改造（返回 token 统计）

**问题**：`cost-tracker.js` 需要 token 消耗数据，但 `llm-client.js` 当前不返回 `usage`。

**方案**：修改 `llm-client.js` 的流式调用，在 `stream.on('end')` 时从最后一个 chunk 或累积计算得出 token 数：

```
// llm-client.js 改动
async function chatCompletion(messages, options) {
  // ... 现有流式逻辑 ...

  return {
    content: fullText,
    usage: {
      promptTokens: lastChunk?.usage?.prompt_tokens || estimateTokens(messages),
      completionTokens: lastChunk?.usage?.completion_tokens || estimateTokens(fullText),
      totalTokens: (lastChunk?.usage?.total_tokens) ||
        estimateTokens(messages) + estimateTokens(fullText),
    },
  }
}
```

**实现**：Phase 3.14 observability 模块建立时同步改造 llm-client.js。

### 7.8 最小可运行重构（MVP）

**目的**：降低风险，在 1-2 天内验证重构正确性，避免大爆炸式改动。

**MVP 范围**（Phase 3 精简版）：

| 模块 | MVP 实现 | 后续补齐 |
|------|----------|----------|
| `memory/` | 合并双轨 + `retrieval.js` 简单语义召回 | 性格加权、压缩、遗忘 |
| `personality/` | 仅 `schema.js` + `injector.js`（性格注入 prompt） | updater、ocean、conflict-detector |
| `prompts/` | 仅 `system/base.md` + `personality-aware.md` | tasks、versioning |
| `routes/` | 仅 `chat.js` 处理 chat 事件，其余仍在 index.js | voice、music、memory 等 |
| `agent-state.js` | 状态定义 + event-bus 广播 | 完整状态转换逻辑 |
| `config/` | `default.yaml` + 简单 loader | personality 子配置 |

**MVP 验证通过后**，逐步添加：性格演化、规划器、工作流、可观测性、评估系统。

---

## 八、依赖关系图

```
Phase 1 (清理)
  └─→ Phase 2 (前端) ──→ Phase 2.6 验证
        └─→ Phase 3 MVP (后端核心链路) ──→ Phase 3.16 验证
              ├─→ Phase 3 扩展 (性格/规划/工作流)
              ├─→ Phase 4 (Electron IPC)
              └─→ Phase 5 (收尾)
```

MVP 链路（最优先）：
```
memory 合并 → personality schema + injector → prompts 基础 → routes/chat → agent-state → 验证
```

# 提示词管理系统 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 将 Agent 系统提示词从代码中硬编码重构为四层文件化管理架构（软件说明书 + 工具说明书 + 动态人格档案 + 模式行为规则），三个对话页面各自使用对应的 L4 提示词。

**架构:** 四层拼装模型，L1+L2 为静态共享 .txt 文件，L3 由 personality/styleAdapter/userProfile 代码动态生成，L4 按 chat_mode 加载对应 .txt。`prompt-loader.js` 新增 `assembleSystemPrompt(mode)` 函数统一拼装入口。客户端通过 `chat_mode` 参数告知服务端当前页面。

**技术栈:** Node.js + Hono WebSocket + Vue 3 + Electron IPC，无新增依赖。

---

## 当前链路分析

```
ChatPage ──agentChat()──→ server/index.js ──runAgent()──→ agent.js
                                                          │
                                    无 system 消息 → _defaultSystemPrompt() → loadPrompt('default')
                                    有 system 消息 → 保留（VoiceChat 走的这条，但内容是硬编码英文）

VoiceChat ──agentChat()──→ (同上，但 messages[0] 是硬编码英文 system prompt)

GroupChatPage ──agentChatGroup()──→ coordinator.js（完全不同的路径）
```

**核心问题:**
1. VoiceChat 用硬编码英文 prompt，没用 `voice.txt`
2. 服务端无法区分 ChatPage 和 VoiceChat（都走 `agentChat`）
3. 没有 `app-guide.txt` 和 `tools-guide.txt`
4. `prompt-loader.js` 只加载单个文件，没有拼装能力
5. L3 人格档案已存在但拼装逻辑散落在 `runAgent()` 中

---

## 文件结构

```
修改:
  server/lib/prompt-loader.js      — 新增 assembleSystemPrompt(mode)
  server/core/agent.js             — 调用 assembleSystemPrompt 替代 _defaultSystemPrompt
  server/index.js                  — 提取 chat_mode 传给 runAgent
  src/pages/voice/VoiceChat.vue    — 删除硬编码 system prompt，传 chat_mode='voice'
  src/pages/chat/ChatPage.vue      — 清理 legacy 硬编码，传 chat_mode='chat'
  src/pages/chat/GroupChatPage.vue — 传 chat_mode='group'
  electron/preload.cjs             — agentChat 增加 chat_mode 参数透传
  electron/ipc/agent-ipc.cjs       — 转发 chat_mode

新建:
  server/prompts/app-guide.txt     — L1 软件说明书
  server/prompts/tools-guide.txt   — L2 工具说明书
  server/prompts/group.txt         — L4 群聊规则

不改动（已可用）:
  server/prompts/default.txt       — L4 私聊规则（内容后续迭代）
  server/prompts/voice.txt         — L4 语音规则（内容后续迭代）
  server/personality/index.js      — L3 人格档案（formatForLLM 已有）
  server/personality/injector.js   — L3 风格适配（formatForLLM 已有）
  server/lib/user-profile.js       — L3 用户画像（formatForLLM 已有）
```

---

### Task 1: 创建 L1 — 软件说明书

**文件:**
- Create: `server/prompts/app-guide.txt`

- [ ] **Step 1: 编写 app-guide.txt**

```txt
## 关于 Sonder

你是 Sonder，运行在用户 Windows 桌面的 Electron 应用里。

### 软件布局
- 左侧竖排菜单栏：对话、群聊、语音、角色、知识库 五个入口
- 右下角齿轮图标：设置面板入口
- 顶部标题栏：Mini 音乐播放器（显示当前播放歌曲，点击可展开完整播放器）
- 中间区域：当前页面的内容

### 功能模块

**对话（默认页）** — 你和用户的 1v1 私聊空间。这是用户最常用的页面。

**群聊** — 多个 Agent 协作讨论。用户可以创建群聊，选择参与的 Agent。支持讨论模式和协作模式（多阶段规划→执行→审核）。

**语音** — 语音对话模式。用户通过麦克风说话，你用 TTS 语音回复。回复会自动转成语音播放。

**角色** — 管理 Agent 角色/人格。用户可以创建自定义 Agent，设置名称、头像、性格。也可以进入设置面板配置 LLM 提供商、API Key、模型等。

**知识库** — 管理知识文档。支持搜索、索引文件、保存网页内容、知识图谱关系查询。

**设置面板**（左侧菜单底部齿轮图标）— 包含：
- LLM 配置：提供商选择、API Key、模型切换
- 天气：城市设置
- 记忆：记忆系统管理
- 人格：Agent 人格维度调整
- 语音 TTS：声音克隆、TTS 引擎配置
- 隐私：数据管理
- 关于：版本信息

### 音乐系统
- 顶部 Mini 播放器显示当前歌曲，点击展开完整播放器
- 支持搜索网易云音乐歌曲、智能推荐、播放控制
- 用户听歌行为会被记录，用于个性化推荐

### 文件喂食
- 用户可以把文件拖到对话框或粘贴图片
- 支持 PDF、代码文件、图片等格式
- PDF 扫描件可用 read_file_page 逐页查看

### 导航指引
当用户问"XX在哪"或"怎么设置XX"时，根据上述布局给出具体指引。
例如："设置入口在左侧菜单最下面的齿轮图标"。
```

- [ ] **Step 2: 提交**

```bash
git add server/prompts/app-guide.txt
git commit -m "feat: add L1 app-guide prompt"
```

---

### Task 2: 创建 L2 — 工具说明书

**文件:**
- Create: `server/prompts/tools-guide.txt`

- [ ] **Step 1: 编写 tools-guide.txt**

```txt
## 工具说明书

### 一、工具选择速查

| 场景 | 用这个 | 不用那个 |
|------|--------|----------|
| 搜索网络信息 | web_search | web_fetch（只取单页） |
| 打开网页/电商/视频 | browse | web_fetch（拿不到JS内容） |
| 读纯文本/API返回 | web_fetch | browse（太重） |
| 记住用户偏好/事实 | remember | save_knowledge（那是存文档的） |
| 保存网页/长文/外部资料 | save_knowledge | remember |
| 搜索个人记忆 | recall | search_knowledge（那是知识库） |
| 搜索知识库 | search_knowledge | recall |
| 播放指定歌曲 | play_music | — |
| 推荐歌曲 | recommend_music | search_music（除非用户明确搜特定歌） |
| 搜特定歌名/艺人 | search_music | recommend_music |
| 切歌/下一首 | play_music（从上文"接下来"列表取） | 不要重新 search/recommend |
| 用户说"类似" | play_similar | 不要 search |

### 二、工具分类详解

#### 网络工具
- **web_search(query)** — 搜索引擎。返回摘要列表。适合查事实、资讯。
- **web_fetch(url)** — 抓取单个 URL 的文本内容。适合读文档、API 响应。**不能**用于需要 JS 渲染的网站。
- **browse(action, url, ...)** — 真实浏览器。能渲染 JS、过验证码。适合电商、视频网站、需要交互的页面。重武器，别滥用。

#### 文件工具
- **read_file(file_path)** — 读文本/代码/PDF。PDF 文字可提取，扫描件不可。
- **read_file_page(file_path, page)** — 逐页查看 PDF 扫描件。read_file 读不到文字时用。
- **read_image(file_path)** — 读图片文件，返回 base64。
- **write_file(file_path, content)** — 写入文件。
- **list_files(dir_path)** — 列目录。

#### 记忆工具
- **remember(content)** — 记住用户偏好/事实。自动检测冲突。**冲突时**告诉用户发现矛盾，询问以哪个为准。
- **recall(query)** — 搜索全部记忆（语义向量搜索 + 时间衰减）。用户问"我之前说过什么"时用。
- **forget(key)** — 删除记忆。需要用户明确确认。
- **update_memory(key, new_content)** — 修改已有记忆。先 recall 找到旧记忆再改。
- **memory_status()** — 查看记忆系统状态。

#### 音乐工具（8个）
- **search_music(query)** — 搜歌名/艺人/专辑。
- **recommend_music(mood)** — 智能推荐。结合听歌习惯+时间+天气。
- **play_music(songId, songName, artist, reason)** — 播放。reason 一句话说明为什么选这首。
- **play_similar(songId)** — 心动模式，基于当前歌曲风格找相似。
- **pause_music() / resume_music() / stop_music()** — 播放控制。
- **set_volume(level)** — 0-100。

**音乐核心链路:**
```
"放歌" → recommend_music → play_music 第一首 → 告知 + 附推荐列表
"搜晴天" → search_music("晴天") → 列结果 → 用户选 → play_music
"下一首" → 从"接下来:"列表取第一首 → play_music（不要重新搜索！）
"类似的" → play_similar(当前songId)
用户说"太吵"/"好听" → remember 记录偏好
```

#### 知识库工具
- **search_knowledge(query)** — 全文搜索知识库。
- **lookup_knowledge(entity)** — 精确查找实体。
- **save_knowledge(title, content, source_type, url, tags)** — 保存文档。source_type: note/webpage/clip。
- **show_kb_status()** — 查看知识库状态。
- **update_kb_config(key, value)** — 配置知识库。
- **index_file_to_kb(file_path)** — 索引文件到知识库。

#### 知识图谱工具
- **add_relation(subject, predicate, object)** — 建立三元组关系。如 add_relation("Python", "创始人", "Guido van Rossum")。
- **query_relation(entity)** — 查询实体关联。

#### Agent 通信工具
- **agent_list()** — 列出所有可用 Agent。
- **channel_list()** — 列出所有频道。
- **channel_read(channel_id)** — 读频道消息。
- **channel_post(channel_id, body)** — 发频道消息。
- **dm_send(to_agent_name, body)** — 发私信给其他 Agent。
- **dm_read(peer_name)** — 读私信历史。

#### 提醒工具
- **schedule_reminder(time, content)** — 设置提醒。
- **cancel_reminder(id)** — 取消提醒。
- **list_reminders()** — 列出所有提醒。

#### 命令工具
- **execute_command(command)** — 执行终端命令。需要用户确认。不支持交互式命令，超时 30 秒。

### 三、通用规则

1. **一次只调用必要的工具**，不要滥用
2. **连续失败 2 次** → 停止用该工具，基于已有知识回答
3. **搜不到 → 告知**，不反复搜
4. **工具结果引用**：知识库返回的 → "根据知识库…"；记忆返回的 → "我记得你之前说过…"
5. **execute_command 需要用户确认**，其他工具直接执行
```

- [ ] **Step 2: 提交**

```bash
git add server/prompts/tools-guide.txt
git commit -m "feat: add L2 tools-guide prompt"
```

---

### Task 3: 增强 prompt-loader — 新增拼装函数

**文件:**
- Modify: `server/lib/prompt-loader.js`

- [ ] **Step 1: 在文件末尾添加 `assembleSystemPrompt()` 和 `listPromptFiles()`**

在现有 `clearPromptCache` 导出后追加:

```javascript
/**
 * 拼装完整 system prompt: L1 + L2 + L4
 * L3 人格档案由 agent.js 动态注入，不在此处理
 *
 * @param {'chat'|'voice'|'group'} mode
 * @returns {string}
 */
export function assembleSystemPrompt(mode = 'chat') {
  const parts = [];

  // L1: 软件说明书（所有模式共享）
  try { parts.push(loadPrompt('app-guide')); } catch {}

  // L2: 工具说明书（所有模式共享）
  try { parts.push(loadPrompt('tools-guide')); } catch {}

  // L4: 模式行为规则
  const modeFile = mode === 'voice' ? 'voice' : mode === 'group' ? 'group' : 'default';
  try { parts.push(loadPrompt(modeFile)); } catch { parts.push(loadPrompt('default')); }

  return parts.join('\n\n');
}

/** 列出 prompts 目录下所有 .txt 文件（调试用） */
export function listPromptFiles() {
  try {
    return readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.txt'));
  } catch {
    return [];
  }
}
```

同时在文件顶部 `import` 区域添加 `readdirSync`:

```javascript
import { readFileSync, existsSync, readdirSync } from 'fs';
```

- [ ] **Step 2: 验证 prompt-loader 语法正确**

```bash
cd D:\Project\ai-desktop-pet-electron
node -e "import('./server/lib/prompt-loader.js').then(m => { console.log('assembleSystemPrompt:', typeof m.assembleSystemPrompt); console.log('listPromptFiles:', typeof m.listPromptFiles); console.log('OK'); })"
```
预期: 输出 `assembleSystemPrompt: function`, `listPromptFiles: function`, `OK`

- [ ] **Step 3: 提交**

```bash
git add server/lib/prompt-loader.js
git commit -m "feat: add assembleSystemPrompt() to prompt-loader"
```

---

### Task 4: 更新 agent.js — 使用新拼装函数

**文件:**
- Modify: `server/core/agent.js`

- [ ] **Step 1: 更新 import**

将第 16 行:
```javascript
import { loadPrompt } from '../lib/prompt-loader.js';
```
改为:
```javascript
import { loadPrompt, assembleSystemPrompt } from '../lib/prompt-loader.js';
```

- [ ] **Step 2: 替换 `_defaultSystemPrompt` 函数**

删除第 32-34 行:
```javascript
function _defaultSystemPrompt() {
  try { return loadPrompt('default'); } catch { return '你是用户的 AI 陪伴者。简洁自然地回复。'; }
}
```

替换为:
```javascript
function _defaultSystemPrompt(chatMode = 'chat') {
  try { return assembleSystemPrompt(chatMode); } catch { return '你是用户的 AI 陪伴者。简洁自然地回复。'; }
}
```

- [ ] **Step 3: 更新 `runAgent` 函数签名和调用**

在 `runAgent` 解构参数中添加 `chatMode`（约第 664-675 行）:
```javascript
export async function runAgent({
  config,
  messages,
  convId,
  memoryStore,
  ragPipeline,
  sendEvent,
  waitApproval,
  memoryManager,
  userProfile,
  styleAdapter,
  personality,
  chatMode = 'chat',   // ← 新增
}) {
```

在 `_runAnswerPhase` 解构中添加 `chatMode`（约第 101 行）:
```javascript
async function _runAnswerPhase({
  llm,
  config,
  history,
  lastUserText,
  visionResult,
  memoryStore,
  sendEvent,
  waitApproval,
  tTotalStart,
  hadImages,
  chatMode = 'chat',   // ← 新增
}) {
```

将第 123 行:
```javascript
    : [{ role: 'system', content: _defaultSystemPrompt() }];  // Fallback to default
```
改为:
```javascript
    : [{ role: 'system', content: _defaultSystemPrompt(chatMode) }];  // Fallback: L1+L2+L4
```

- [ ] **Step 4: 更新 `runAgent` 调用 `_runAnswerPhase` 处，传递 `chatMode`**

找到 `runAgent` 中调用 `_runAnswerPhase` 的位置（约 750-760 行），在参数对象中添加:
```javascript
chatMode,
```

- [ ] **Step 5: 验证语法**

```bash
cd D:\Project\ai-desktop-pet-electron
node -e "import('./server/core/agent.js').then(() => console.log('OK')).catch(e => console.error(e.message))"
```
预期: 输出 `OK`（可能会有缺少依赖的警告，但不应有语法错误）

- [ ] **Step 6: 提交**

```bash
git add server/core/agent.js
git commit -m "feat: agent uses assembleSystemPrompt with chatMode"
```

---

### Task 5: 更新服务端 — 传递 chat_mode

**文件:**
- Modify: `server/index.js`

- [ ] **Step 1: 在 `handleAgentChat` 中提取 `chat_mode` 并传递**

找到第 404 行附近 `const convId = msg.conversation_id || 'default';`，在其后添加:
```javascript
const chatMode = msg.chat_mode || 'chat';
```

找到约第 458 行 `await _runAgent({` 的参数对象，添加:
```javascript
chatMode,
```

- [ ] **Step 2: 在 `agent_chat_group` 处理中也添加 chat_mode**

找到处理 `agent_chat_group` 的区域（约 556 行），确保也提取 `chat_mode` 并传递给 coordinator:
```javascript
const chatMode = msg.chat_mode || 'group';
```

> 注意: GroupChat 走 coordinator 路径，如果 coordinator 内部也调用 runAgent，需要把 chatMode 透传下去。检查 coordinator.js 是否有此路径。

- [ ] **Step 3: 验证语法**

```bash
cd D:\Project\ai-desktop-pet-electron
node --check server/index.js
```
预期: 无输出（无错误）

- [ ] **Step 4: 提交**

```bash
git add server/index.js
git commit -m "feat: pass chat_mode from client to runAgent"
```

---

### Task 6: 修复 VoiceChat — 删除硬编码 system prompt

**文件:**
- Modify: `src/pages/voice/VoiceChat.vue`

- [ ] **Step 1: 定位硬编码 system prompt**

找到约第 146-148 行的硬编码 system prompt:
```javascript
var messages = [
  { role: "system", content: "You are Sonder, a voice assistant. CRITICAL: Every reply MUST start with [emotion:xxx]..." },
```

- [ ] **Step 2: 删除 system prompt，改为空数组**

替换为:
```javascript
var messages = [];
```

> 说明: 不再发送 system prompt。服务端检测到无 system 消息后，会用 `assembleSystemPrompt('voice')` 拼装 L1+L2+L4(voice.txt)。

- [ ] **Step 3: 找到 `agentChat` 调用处，添加 `chat_mode: 'voice'`**

VoiceChat 调用 `agentChat` 的行（约第 283 行）:
```javascript
window.electronAPI?.agentChat?.(agentConfig, messages, convId)
```

改为:
```javascript
window.electronAPI?.agentChat?.({ config: agentConfig, messages, conversation_id: convId, chat_mode: 'voice' })
```

> 注意: 先确认 `electronAPI.agentChat` 当前的参数签名。查看 `electron/preload.cjs` 和 `electron/ipc/agent-ipc.cjs` 中 agentChat 的定义，可能需要调整。

- [ ] **Step 4: 提交**

```bash
git add src/pages/voice/VoiceChat.vue
git commit -m "fix: VoiceChat uses server-side voice prompt instead of hardcoded English"
```

---

### Task 7: 确认 IPC 链路支持 chat_mode

**文件:**
- Modify: `electron/preload.cjs`（如果需要）
- Modify: `electron/ipc/agent-ipc.cjs`（如果需要）

- [ ] **Step 1: 检查 preload.cjs 中 agentChat 的暴露方式**

```bash
grep -n "agentChat" electron/preload.cjs
```

预期看到类似:
```javascript
agentChat: (config, messages, convId) => ipcRenderer.invoke('agent:chat', { config, messages, conversation_id: convId }),
```

需要确认参数是单个对象还是多个位置参数。如果是多参数形式，改为单对象:
```javascript
agentChat: (params) => ipcRenderer.invoke('agent:chat', params),
```

- [ ] **Step 2: 检查 agent-ipc.cjs 中 handler 的转发**

```bash
grep -n "agent:chat\|agent_chat" electron/ipc/agent-ipc.cjs
```

确保 `chat_mode` 字段能从 IPC 参数透传到 WebSocket 消息。通常 IPC handler 做:
```javascript
ipcMain.handle('agent:chat', async (event, params) => {
  ws.send(JSON.stringify({ type: 'agent_chat', ...params }));
});
```

如果已经是这种透传方式，则不需要修改。确认 `chat_mode` 在 `params` 中即可。

- [ ] **Step 3: 统一 ChatPage 的调用方式**

检查 `src/pages/chat/ChatPage.vue` 中 `agentChat` 的调用，确保参数格式与 VoiceChat 一致，并添加 `chat_mode: 'chat'`。

- [ ] **Step 4: 提交（如有修改）**

```bash
git add electron/preload.cjs electron/ipc/agent-ipc.cjs
git commit -m "fix: ensure chat_mode passes through IPC chain"
```

---

### Task 8: 创建 L4 — 群聊规则文件

**文件:**
- Create: `server/prompts/group.txt`

- [ ] **Step 1: 编写 group.txt**

```txt
## 群聊规则

你是群聊中的一个参与者。这里可能有多个 Agent 和用户一起聊天。

### 行为准则
1. **不要抢话**：等其他 Agent 说完再发言，避免刷屏
2. **有针对性**：如果用户 @你 或明确对你说话，优先回应
3. **尊重其他 Agent**：可以赞同、补充、或礼貌地提出不同意见
4. **保持自然**：像真实群聊一样，偶尔插话可以，但别每条都回
5. **协作意识**：其他 Agent 擅长的领域，可以让它们先回答

### 格式
- 每条回复第一行: [emotion:标签]
- 标签: neutral/happy/sad/angry/worried/encouraging/funny/sarcastic

### 风格
- 回复简洁，2-4 句为宜
- 群聊不是私聊，不用每次都跟用户建立情感连接
- 可以 @其他Agent 来协作（如 @研究员 帮我查一下）
```

- [ ] **Step 2: 提交**

```bash
git add server/prompts/group.txt
git commit -m "feat: add L4 group chat prompt"
```

---

### Task 9: 清理 ChatPage legacy 硬编码 prompt

**文件:**
- Modify: `src/pages/chat/ChatPage.vue`

- [ ] **Step 1: 删除 `runLegacy` 中的硬编码 system prompt**

找到第 335 行 `runLegacy` 函数中的:
```javascript
{role:'system',content:'你是一个桌面上的智能助手。回复简洁高效。'}
```

替换为无 system 消息:
```javascript
[...c.history]
```

> 说明: `runLegacy` 是 LLM SDK 直接调用（不走 server/agent），所以也无法用 assembleSystemPrompt。但 legacy 路径仅当 agentChat 失败时作为降级，极少走到。这里保持最小改动，让 history 直接作为 messages。

- [ ] **Step 2: 确认主路径 ChatPage 已传 chat_mode**

检查 `runAgent` 函数调用 `agentChat` 的位置（约第 333 行），确保参数包含 `chat_mode: 'chat'`。如果 Task 7 已统一处理，此处可能不需要改动。

- [ ] **Step 3: 提交**

```bash
git add src/pages/chat/ChatPage.vue
git commit -m "fix: remove legacy hardcoded system prompt from ChatPage"
```

---

### Task 10: 端到端验证

- [ ] **Step 1: 启动应用**

```powershell
cd D:\Project\ai-desktop-pet-electron
npm run dev
```

- [ ] **Step 2: 测试 ChatPage（私聊）**

1. 打开应用，默认在对话页
2. 发送一条消息
3. 观察: Agent 回复应体现 L1 软件知识 + L2 工具知识 + L4 私聊风格
4. 测试: "设置在哪里" → Agent 应能指引"左侧菜单底部齿轮图标"
5. 测试: "放首歌" → Agent 应走音乐链路

- [ ] **Step 3: 测试 VoiceChat（语音）**

1. 切换到语音页面
2. 发送一条消息
3. 确认: 回复简短、适合 TTS、无 markdown
4. 确认: 不再出现英文 prompt 的痕迹（原硬编码是英文的）

- [ ] **Step 4: 测试 GroupChatPage（群聊）**

1. 切换到群聊页面
2. 发送一条消息
3. 确认: Agent 群聊风格正常，不会刷屏

- [ ] **Step 5: 测试热加载（可选）**

```powershell
$env:PROMPT_HOT_RELOAD = "true"
# 修改 server/prompts/default.txt → 保存 → 发送消息 → 确认新 prompt 生效
```

- [ ] **Step 6: 如有问题，调试并修复**

查看控制台是否有 prompt 加载错误。确认 `assembleSystemPrompt` 返回非空字符串。

---

## 自审清单

**规范覆盖:**
- [x] L1 软件说明书 → Task 1
- [x] L2 工具说明书 → Task 2
- [x] L3 动态人格档案 → 已有，不需要改
- [x] L4 三个模式各自提示词 → Task 8 (group) + 已有 default.txt/voice.txt
- [x] 共享层拼装 → Task 3 (prompt-loader)
- [x] 客户端区分 chat_mode → Task 5/6/7/9
- [x] VoiceChat 硬编码清理 → Task 6
- [x] 端到端验证 → Task 10

**无占位符:** 所有步骤都给出了具体代码和命令。

**类型一致性:**
- `chatMode` 参数类型统一为 `'chat' | 'voice' | 'group'`
- `assembleSystemPrompt(mode)` 入参与 `_defaultSystemPrompt(chatMode)` 一致
- IPC 参数 `chat_mode` 字段名与 WebSocket 消息保持一致

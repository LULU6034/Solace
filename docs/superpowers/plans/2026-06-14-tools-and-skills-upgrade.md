# 工具 + Skill + Agent/Workflow 升级 — 详细设计方案

> 关联：Coordinator 现有讨论/协作模式 → 扩展为通用 spawn_agent  
> 关联：现有 read_file/write_file → 补 Edit/Glob/Grep

---

## 一、Edit 工具

### 1.1 参数

```
edit_file(file_path, old_string, new_string)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| file_path | string | 绝对路径 |
| old_string | string | 要替换的文本（必须文件中唯一） |
| new_string | string | 替换后的文本 |

### 1.2 行为

```
1. read file → content
2. 统计 old_string 在 content 中出现次数
   - 0 次 → 返回错误 "未找到匹配文本"
   - >1 次 → 返回错误 + 每次出现的行号，提示需要更精确的上下文
   - 1 次 → 替换
3. write file
4. 返回 "已替换，文件 {path}"
```

### 1.3 安全

- 限制在 `process.cwd()` 或 `~/.ai-desktop-pet/workspace/` 内
- 禁止操作 `node_modules/`、`.git/`
- `old_string` 长度 ≥ 10 字符（防止误匹配短串）

### 1.4 实现

```js
// server/tools/file-ops-tools.js
export const editFile = {
  name: 'edit_file',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async invoke({ file_path, old_string, new_string }) {
    // safety: path validation
    // read → count matches → replace → write
    const content = fs.readFileSync(file_path, 'utf-8');
    const count = (content.match(escapeRegex(old_string)) || []).length;
    if (count === 0) return '未找到匹配文本';
    if (count > 1) {
      const lines = findLineNumbers(content, old_string);
      return `匹配文本出现 ${count} 次，请提供更精确的上下文:\n${lines}`;
    }
    const updated = content.replace(old_string, new_string);
    fs.writeFileSync(file_path, updated);
    return `已替换 ${file_path} 中的 1 处匹配`;
  }
};
```

---

## 二、Glob 工具

### 2.1 参数

```
glob(pattern, directory?)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| pattern | string | glob 模式，支持 `**` `*` `?` `[abc]` `{a,b}` |
| directory | string | 搜索根目录，默认工作目录 |

### 2.2 行为

```
1. 解析 pattern → 递归遍历 directory
2. 匹配文件名 → 收集路径列表
3. 按修改时间降序排列
4. 最多返回 200 条
5. 自动跳过 node_modules、.git、.next 等
```

### 2.3 示例

```
glob("**/*.vue")      → ["src/App.vue", "src/pages/chat/ChatPage.vue", ...]
glob("*.js", "server") → ["server/index.js", "server/bootstrap.js"]
```

### 2.4 实现

```js
// 手写递归 + 简易 glob 匹配（零依赖）
function matchGlob(pattern, filename) {
  // 转换：** → .*, * → [^/]*, ? → [^/], {a,b} → (a|b)
  const re = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/<<GLOBSTAR>>/g, '.*')
    .replace(/\{([^}]+)\}/g, (_, g) => `(${g.split(',').join('|')})`);
  return new RegExp(`^${re}$`).test(filename);
}
```

---

## 三、Grep 工具

### 3.1 参数

```
grep(pattern, path?, glob_filter?)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| pattern | string | 正则表达式 |
| path | string | 搜索目录/文件，默认工作目录 |
| glob_filter | string | 文件名过滤，如 `"*.vue"` 或 `"*.{js,ts}"` |

### 3.2 行为

```
1. 用 glob_filter 缩小文件范围（调 Glob 逻辑）
2. 逐个读文件 → 按行匹配 pattern
3. 每文件最多返回 10 条匹配
4. 总输出上限 5000 字符，超出截断
5. 跳过 >5MB 的文件、二进制文件
```

### 3.3 输出格式

```
src/ChatPage.vue:42:  import { ref, computed } from 'vue'
src/ChatPage.vue:179: function renderMarkdown(t) { ...
server/agent.js:32:   function _defaultSystemPrompt(chatMode = 'chat') {
```

### 3.4 实现

```js
export const grep = {
  name: 'grep',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob_filter: { type: 'string' },
    },
    required: ['pattern'],
  },
  async invoke({ pattern, path: dir, glob_filter }) {
    // 1. 收集文件列表（glob_filter 过滤）
    // 2. 逐个读 → 按行匹配 → 收集
    // 3. 截断到 5000 字符
    const re = new RegExp(pattern, 'gi');
    const results = [];
    const files = collectFiles(dir || '.', glob_filter);
    for (const f of files) {
      if (fs.statSync(f).size > 5_000_000) continue;
      const lines = fs.readFileSync(f, 'utf-8').split('\n');
      let count = 0;
      for (let i = 0; i < lines.length && count < 10; i++) {
        if (re.test(lines[i])) {
          results.push(`${f}:${i + 1}:  ${lines[i].trim().slice(0, 120)}`);
          count++;
        }
      }
    }
    const out = results.join('\n');
    return out.length > 5000 ? out.slice(0, 5000) + '\n...(截断)' : out;
  }
};
```

---

## 四、spawn_agent — 子任务系统

### 4.1 架构

```
用户消息 → 主 Agent（全部工具，含 spawn_agent）
               │
               ├─ spawn_agent("审查安全性", [read_file, grep, glob])
               │     └─ 子 Agent.run() → 返回文本报告
               │
               ├─ spawn_agent("检查性能", [read_file, grep])
               │     └─ 子 Agent.run() → 返回文本报告
               │
               └─ 主 Agent 汇总 → 回复用户
```

### 4.2 工具定义

```
spawn_agent(instruction, tools?, model?)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| instruction | string | 任务描述 |
| tools | string[] | 可用工具名列表，默认全部 |
| model | string | 模型名，默认同主 Agent |

### 4.3 子 Agent 行为

- **System prompt**：`你是专家执行者。完成用户指定的子任务，返回简洁的文本报告。不需要礼貌用语，直接给结果。`
- **思考阶段**：关闭（reasoningEffort='none'）
- **工具循环**：max 3 轮（vs 主 Agent 5 轮）
- **超时**：120s
- **上下文**：独立，不共享主 Agent 的记忆/历史

### 4.4 并行规则

主 Agent 可以在同一轮中调用多个 `spawn_agent`——每个 `spawn_agent` 是一个独立 tool call。Agent 框架按工具顺序执行，但我们可以优化为 `Promise.all`：

```js
// agent.js: 多 tool_calls 同时 spawn 时并行执行
const spawnCalls = fixedCalls.filter(tc => tc.name === 'spawn_agent');
const regularCalls = fixedCalls.filter(tc => tc.name !== 'spawn_agent');

// 先执行常规工具（如 read_file），再并行 spawn
for (const tc of regularCalls) { await executeTool(tc); }
if (spawnCalls.length > 0) {
  const results = await Promise.all(spawnCalls.map(tc => executeTool(tc)));
}
```

### 4.5 实现文件

`server/core/sub-agent.js`（新建）

```js
import { createLLM } from './llm-client.js';
import { assembleSystemPrompt } from '../lib/prompt-loader.js';

export async function runSubAgent({ config, instruction, toolsWhitelist, sendEvent }) {
  const llm = createLLM({ ...config, reasoningEffort: 'none' });
  
  // 加载被允许的工具
  const allTools = (await import('../tools/index.js')).getAllTools();
  const tools = toolsWhitelist
    ? allTools.filter(t => toolsWhitelist.includes(t.name))
    : allTools;

  const systemPrompt = `你是专家子任务执行者。
${assembleSystemPrompt('chat')}

完成以下子任务，返回简洁的文本报告。不需要礼貌用语，直接给结果。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: instruction },
  ];

  // 简化的 ReAct 循环（max 3 轮）
  // ... 复用 agent.js 的核心逻辑，但简化
  // 返回 finalText
}
```

### 4.6 agent.js 改动

在 `_runAnswerPhase` 的工具执行循环中，检测 `spawn_agent` 调用：

```js
// agent.js 工具执行部分
if (tc.name === 'spawn_agent') {
  const subResult = await runSubAgent({
    config,
    instruction: tc.args.instruction,
    toolsWhitelist: tc.args.tools || null,
    sendEvent, // 透传事件（可转发 reasoning_chunk）
  });
  resultStr = subResult;
}
```

---

## 五、Workflow 编排规则

### 5.1 设计原则

不加新工具。在 `tools-guide.txt` 加一节，教 Agent 何时及如何分阶段执行。

### 5.2 规则内容

```markdown
### 任务编排

复杂任务分三阶段：

**Phase 1 — 调查**
- 用 glob/grep 了解代码结构
- 用 read_file 精读关键文件
- 用 web_search 查外部资料（如果需要）
- 输出：发现汇总（不要改代码）

**Phase 2 — 规划**
- 列出要修改的文件和改动点
- 如果用户要求"先出方案"，在此阶段汇报并等待确认
- 如果用户说"直接改"，跳过确认

**Phase 3 — 执行 + 验证**
- 用 edit_file 逐个修改
- 修改完用 grep 验证改动是否正确
- 最后读一遍修改过的文件确认

**并行场景**
- 需要多个独立搜索/分析 → 用 spawn_agent 并行
- 多个文件互不依赖 → 可以同时 edit_file
```

### 5.3 现有 Coordinator 的改造

Coordinator 已有三阶段（讨论→执行→审核），但写死了。改为：

1. 保留 Coordinator 的讨论/协作模式（多 Agent 自然对话）
2. 新增规则驱动模式：tools-guide.txt 里的 Phase 1/2/3 是**默认策略**，Agent 根据任务复杂度自己判断用几步

---

## 六、Skill 系统升级

### 6.1 社区注册表（零成本方案）

**GitHub Topic：`sonder-skill`**

- 搜索方式：`web_search("topic:sonder-skill 翻译 site:github.com")`
- tools-guide.txt 加：
  ```
  搜索社区 Skill: web_search("topic:sonder-skill <关键词>")
  ```

### 6.2 `/skill名` 触发

**前端 ChatPage.vue — `handleSend()`：**

```js
async function handleSend() {
  let t = text.value.trim();
  
  // 检测 /skill名 触发
  let activatedSkill = null;
  if (t.startsWith('/')) {
    const skillName = t.split(' ')[0].slice(1); // 提取 skill 名
    t = t.slice(skillName.length + 1).trim();    // 去掉 /skill名
    if (!t) t = '请执行你的任务';
    activatedSkill = skillName;
  }
  
  // ... 发送消息时附加 activatedSkill
  const result = await window.electronAPI.agentChat(pc, ph, convId, 'chat', activatedSkill);
}
```

**后端 server/index.js — `handleAgentChat()`：**

```js
async function handleAgentChat(ws, msg) {
  const activatedSkill = msg.activated_skill;
  
  if (activatedSkill) {
    const skill = _SkillManager?.findSkill(activatedSkill);
    if (skill?.body) {
      // 注入到消息前
      messages.unshift({
        role: 'system',
        content: `[已激活 Skill: ${skill.name}]\n${skill.body}`,
      });
    }
  }
  // ... 继续正常流程
}
```

**preload.cjs** — `agentChat` 加参数：

```js
agentChat: (config, messages, convId, mode, activatedSkill) =>
  ipcRenderer.invoke('agent-chat', { config, messages, conversation_id: convId, chat_mode: mode, activated_skill: activatedSkill }),
```

### 6.3 工具权限

**SKILL.md frontmatter 扩展：**

```yaml
---
name: web-research
description: 深度网络研究报告生成
tools:
  - web_search
  - web_fetch
  - write_file
  - read_file
---

# 正文...
```

**SkillManager 解析：**

```js
// skill-manager.js parseSkillMetadata() 加一行
meta.tools = Array.isArray(parsed.tools) ? parsed.tools : [];
```

**spawn_agent 使用权限：**

当 Agent 通过 `/skill名` 激活一个 skill 时，该 skill 的 `tools` 字段自动作为 `spawn_agent` 的 `toolsWhitelist`。

### 6.4 前端 Skill 管理 UI

**组件：`src/pages/settings/SkillSettingsPanel.vue`**

```vue
<template>
  <div class="skill-settings">
    <div class="skill-header">
      <input v-model="searchQuery" placeholder="搜索 Skill..." class="setting-input" />
      <button @click="showInstall = true" class="setting-btn primary">从 GitHub 安装</button>
    </div>

    <!-- 内置 Skill -->
    <div class="skill-section">
      <h4>内置 Skill</h4>
      <div v-for="s in builtinSkills" :key="s.name" class="skill-card">
        <div class="skill-info">
          <span class="skill-name">{{ s.name }}</span>
          <span class="skill-desc">{{ s.meta.description }}</span>
        </div>
        <button @click="toggleSkill(s)" class="toggle-btn" :class="{ on: s.enabled }">
          {{ s.enabled ? '✓' : '—' }}
        </button>
      </div>
    </div>

    <!-- 用户 Skill -->
    <div class="skill-section">
      <h4>用户 Skill</h4>
      <div v-for="s in userSkills" :key="s.name" class="skill-card">
        <div class="skill-info">
          <span class="skill-name">{{ s.name }}</span>
          <span class="skill-desc">{{ s.meta.description }}</span>
          <span v-if="s.meta.tools?.length" class="skill-tools">
            {{ s.meta.tools.join(', ') }}
          </span>
        </div>
        <button @click="toggleSkill(s)" class="toggle-btn" :class="{ on: s.enabled }">
          {{ s.enabled ? '✓' : '—' }}
        </button>
        <button @click="uninstallSkill(s)" class="danger-btn-sm">卸载</button>
      </div>
    </div>

    <!-- 安装弹窗 -->
    <div v-if="showInstall" class="modal-overlay" @click.self="showInstall = false">
      <div class="modal-box">
        <h4>安装 Skill</h4>
        <input v-model="installUrl" placeholder="GitHub URL 或 owner/repo" class="setting-input" />
        <div class="modal-actions">
          <button @click="doInstall" class="setting-btn primary">安装</button>
          <button @click="showInstall = false" class="setting-btn">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const skills = ref([])
const searchQuery = ref('')
const showInstall = ref(false)
const installUrl = ref('')

const builtinSkills = computed(() =>
  skills.value.filter(s => s.builtin && matchSearch(s)))
const userSkills = computed(() =>
  skills.value.filter(s => !s.builtin && matchSearch(s)))

function matchSearch(s) {
  const q = searchQuery.value.toLowerCase()
  return !q || s.name.toLowerCase().includes(q) || s.meta.description?.toLowerCase().includes(q)
}

async function loadSkills() {
  skills.value = await window.electronAPI?.skillList() || []
}

async function toggleSkill(s) {
  await window.electronAPI?.skillEnable(s.name, !s.enabled)
  s.enabled = !s.enabled
}

async function doInstall() {
  const result = await window.electronAPI?.skillInstall(installUrl.value)
  if (result?.success) {
    installUrl.value = ''
    showInstall.value = false
    await loadSkills()
  } else {
    alert('安装失败: ' + (result?.error || '未知错误'))
  }
}

async function uninstallSkill(s) {
  if (!confirm(`确定卸载 "${s.name}"？`)) return
  await window.electronAPI?.skillUninstall(s.name)
  await loadSkills()
}

onMounted(loadSkills)
</script>
```

**IPC 补充（preload.cjs）：**

```js
skillList: () => ipcRenderer.invoke('skill-list'),
skillEnable: (name, enabled) => ipcRenderer.invoke('skill-enable', { name, enabled }),
skillInstall: (source) => ipcRenderer.invoke('skill-install', { source }),
skillUninstall: (name) => ipcRenderer.invoke('skill-uninstall', { name }),
```

**设置面板注册：**

在 `SettingsPanel.vue` 的侧边栏菜单加一项 `Skills`，对应 `SkillSettingsPanel`。

---

## 七、完整数据流

### 7.1 用户发 `/translate 你好`

```
ChatPage.vue
  │ 检测 /translate → activatedSkill = "translate", text = "你好"
  │
  ├─ IPC: agentChat(config, history, convId, 'chat', 'translate')
  │
  ├─ Electron main → agent-ipc.cjs → WebSocket → server/index.js
  │
  ├─ handleAgentChat()
  │    ├─ 查找 Skill "translate" → 获取 body + tools
  │    ├─ 注入 system message: [已激活 Skill: translate]\n{body}
  │    ├─ 限制工具集为 skill.tools（如果声明了）
  │    └─ runAgent({ ..., toolsWhitelist: skill.tools })
  │
  └─ 返回回复 → 前端显示
```

### 7.2 Agent spawn 子 Agent

```
Agent 调用 spawn_agent("审查安全", [read_file, grep, glob])
  │
  ├─ agent.js 工具执行循环
  │    ├─ 检测 tc.name === 'spawn_agent'
  │    ├─ 调用 runSubAgent({ instruction, toolsWhitelist })
  │    │    ├─ 创建独立 LLM 实例
  │    │    ├─ 加载白名单工具
  │    │    ├─ 简化的 ReAct 循环（3 轮）
  │    │    └─ 返回 finalText
  │    └─ 把结果作为 tool result 注入 lcMessages
  │
  └─ 主 Agent 继续执行 → 汇总所有 spawn 结果 → 回复用户
```

### 7.3 Workflow 编排

```
用户: "重构这个项目的认证模块"

Agent 内部决策（根据 tools-guide.txt 规则）:
  │
  ├─ Phase 1 — 调查
  │    glob("**/auth*") + glob("**/login*") + glob("**/session*")
  │    grep("authenticate|login|verifyToken", "src/")
  │    read_file 关键文件
  │
  ├─ Phase 2 — 规划（如果用户说"先出方案"则汇报）
  │    spawn_agent("分析认证模块结构", [read_file])
  │    输出改动计划
  │
  ├─ Phase 3 — 执行
  │    edit_file 逐个修改
  │    grep 验证改动正确性
  │
  └─ 汇报用户
```

---

## 八、实施文件清单

| 文件 | 操作 | 内容 |
|------|------|------|
| `server/tools/file-ops-tools.js` | 新建 | Edit + Glob + Grep |
| `server/tools/index.js` | 改 | 注册新工具 |
| `server/core/sub-agent.js` | 新建 | runSubAgent() |
| `server/core/agent.js` | 改 | spawn_agent 工具调用 + 并行优化 |
| `server/prompts/tools-guide.txt` | 改 | 加编排规则 + Glob/Grep/Edit/spawn 说明 |
| `src/pages/settings/SkillSettingsPanel.vue` | 新建 | Skill 管理 UI |
| `src/pages/settings/SettingsPanel.vue` | 改 | 加 Skills 标签 |
| `electron/preload.cjs` | 改 | skillList/Enable/Install/Uninstall + activatedSkill |
| `electron/ipc/agent-ipc.cjs` | 改 | agentChat 透传 activatedSkill |
| `server/index.js` | 改 | handleAgentChat 处理 activatedSkill |
| `server/skills/skill-manager.js` | 改 | 解析 tools 字段 |

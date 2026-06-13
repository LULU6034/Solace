# 浏览器操控集成方案 (Stagehand)

## 一、为什么选 Stagehand

| | browser-use (Python) | Stagehand (Node.js) |
|---|---|---|
| 技术栈 | Python，需跨语言桥接 | **Node.js，零依赖引入** |
| 架构 | AI Agent 自主决策 | **AI 引导 + 确定性代码混合** |
| 稳定性 | 全 AI 决策，可能跑偏 | **关键路径确定性，AI 只在需要时介入** |
| 成本 | 每步都调 LLM | **智能缓存，大幅降低 LLM 调用** |
| 集成 | 需要 Python 进程 + HTTP 服务 | **直接 import，同进程** |
| 成熟度 | 较新，API 变动频繁 | 较成熟，Playwright 生态 |

## 二、架构

```
┌───────────────────────────────────────────────────┐
│ Agent Server (server/)                            │
│                                                   │
│  core/agent.js                                    │
│    → 调用 browse(task)                            │
│       ↓                                          │
│  tools/browser-tool.js ★ 新增                    │
│    → stagehand.act(task) 或 stagehand.extract()  │
│    → 直接返回结果（无需跨进程通信）              │
│                                                   │
│  ⚠ 没有 Python 进程，没有 HTTP 桥接 ⚠            │
└───────────────────────────────────────────────────┘
```

**相比 browser-use 方案的优势：**
- 少了 `scripts/browser-server.py`（不需要）
- 少了 `electron/ipc/browser-ipc.cjs`（不需要）
- 少了进程 spawn/kill 管理
- 少了 HTTP 通信层
- Stagehand 内置 AI 缓存，重复搜索不调 LLM

---

## 三、文件结构

```
新增 1 个文件，改动 2 个文件：

server/tools/browser-tool.js    ★ 新建  browse + extract 工具
server/tools/index.js            改动  注册工具
server/core/agent.js             改动  TOOLS 列表加描述

不动: electron/ scripts/ src/ memory/ knowledge/ voice/ ...
```

---

## 四、核心实现

### 4.1 `server/tools/browser-tool.js`

```js
import { Stagehand } from '@browserbasehq/stagehand';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('browser-tool');

let _stagehand = null;  // 浏览器实例复用
let _lastTask = '';     // 缓存对比

async function getStagehand() {
  if (!_stagehand) {
    _stagehand = new Stagehand({
      env: 'LOCAL',
      headless: true,
      // 复用项目 DeepSeek 做 AI fallback
      modelName: process.env.LLM_MODEL || 'deepseek-chat',
      modelClientOptions: {
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: process.env.DEEPSEEK_API_KEY,
      },
    });
    await _stagehand.init();
    log.log('Stagehand 浏览器已启动');
  }
  return _stagehand;
}

// ── 工具 1: 浏览并提取 ──
export const browseTool = {
  name: 'browse',
  description: '让浏览器完成网页任务——搜索、浏览、提取信息。' +
    '用户说"帮我搜一下""查一查""打开网站看看"时使用。',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '浏览任务（中文描述，如"搜索京东机械键盘并提取价格"）' },
      url: { type: 'string', description: '指定起始 URL（可选）' },
      max_steps: { type: 'number', default: 8 },
    },
    required: ['task'],
  },
  async invoke({ task, url, max_steps = 8 }) {
    const stagehand = await getStagehand();
    const page = await stagehand.page();

    // 缓存：相同任务跳过 AI，直接回放
    if (task === _lastTask) {
      log.log('命中缓存，跳过 LLM 调用');
    }

    try {
      // Stagehand 混合模式：
      // 1. AI 分析 task → 确定导航目标
      // 2. 确定性代码执行导航/搜索/提取
      const result = await stagehand.act({
        action: task,
        maxSteps: max_steps,
      });

      _lastTask = task;

      // 提取页面文本
      const text = await page.evaluate(() => document.body.innerText);
      const summary = text.slice(0, 3000); // 限制返回长度

      return JSON.stringify({
        success: result.success,
        summary: summary.replace(/\s+/g, ' ').trim(),
        url: page.url(),
        steps: result.steps || 0,
      });
    } catch (err) {
      log.error('browse 失败:', err.message);
      return `浏览失败: ${err.message}`;
    }
  },
};

// ── 工具 2: 结构化提取 ──
export const extractTool = {
  name: 'browse_extract',
  description: '从当前页面提取结构化数据（商品列表、价格、链接等）。先 browse 再 extract。',
  ...

// ── 工具 3: 截图 ──
export const screenshotTool = {
  name: 'browse_screenshot',
  description: '对当前浏览器页面截图',
  ...
```

### 4.2 `server/tools/index.js` 注册

```js
import { browseTool, extractTool, screenshotTool } from './browser-tool.js';

// 仅当 Stagehand 已安装时注册
let browserTools = [];
try {
  require.resolve('@browserbasehq/stagehand');
  browserTools = [browseTool, extractTool, screenshotTool];
} catch {}
```

### 4.3 `server/core/agent.js` 系统 Prompt 追加

```
TOOLS available: ..., browse(?search JD mechanical keyboards?max_steps=8).
When user asks to search/check/look up something on a website, use browse.
```

---

## 五、混合模式策略

Stagehand 的核心优势——**AI 引导 + 确定性代码**：

```
AI 做的事情（灵活，成本高）:
  └─ 解析 task 描述 → 确定"我要搜索京东机械键盘"
  └─ 识别页面结构 → 找到搜索框、结果列表
  └─ 首次执行（无缓存时）

确定性代码（稳定，成本零）:
  └─ 导航到 URL → page.goto(url)  ← Playwright 原生
  └─ 输入文本 → page.fill(selector, text)
  └─ 点击 → page.click(selector)
  └─ 等待加载 → page.waitForSelector()
  └─ 提取数据 → page.evaluate()

缓存路径（零成本）:
  └─ 相同 task → 跳过 AI，直接回放上次的动作序列
  └─ 相同网站模式 → 复用 DOM selector
```

---

## 六、使用示例

```
用户: "帮我在淘宝搜一下机械键盘，看看200以内有什么好的"

Agent 调用: browse({
  task: "在淘宝搜索机械键盘，筛选价格200以下，提取前5个商品名称价格",
  max_steps: 10
})

Stagehand 执行:
  AI 阶段（仅首次）:
    1. 分析 task → goal: 淘宝搜索+筛选+提取
    2. 识别淘宝 DOM 结构 → 搜索框、价格筛选、结果列表
  
  确定性阶段:
    3. navigate → https://www.taobao.com
    4. fill → 搜索框 = "机械键盘"
    5. click → 搜索按钮
    6. click → 价格筛选 0-200
    7. extract → 前5个商品名称+价格

返回: "淘宝200以内机械键盘:
       1. 达尔优 EK815 机械键盘 ¥169
       2. 雷柏 V500PRO 机械键盘 ¥139
       ...
       当前页面: https://s.taobao.com/search?q=..."

缓存: 下次搜"机械键盘"相关 → 跳过 AI 步骤 → 零 LLM 成本
```

## 七、安全约束

| 规则 | 实现 |
|------|------|
| 禁止操作本地文件 | Stagehand 初始化屏蔽 `file://` |
| 敏感域名确认 | 涉及到支付/银行/邮箱 → Agent 先口头确认 |
| 超时保护 | `act({ timeout: 60000 })` |
| 步数限制 | `maxSteps` 默认 8，最大 15 |
| 可见模式 | 设置面板开关，默认无头 |

## 八、依赖

```json
// package.json 新增
{
  "@browserbasehq/stagehand": "^1.x",
  "playwright": "^1.40"  // Stagehand 依赖，可能已安装
}
```

安装：`npm i @browserbasehq/stagehand`（自动装 Playwright + Chromium）

---

## 九、与 browser-use 方案对比

| | Stagehand (新方案) | browser-use (旧方案) |
|---|---|---|
| 新增文件 | **1 个**（browser-tool.js） | 4 个（含 Python 服务 + IPC） |
| 跨语言通信 | **无** | Python HTTP + Node fetch |
| 进程管理 | **无**（同进程 import） | spawn/kill Python 子进程 |
| 缓存 | **内置**（相同 task 零 LLM） | 无 |
| LLM 调用 | AI 只做规划，执行用确定性代码 | 每步都调 LLM |
| 成本 | 低（缓存 + 混合执行） | 高（全 AI 决策） |
| 可预测性 | 高（关键路径确定性） | 中（AI 自由发挥） |

## 十、实施步骤

1. `npm i @browserbasehq/stagehand playwright`
2. 创建 `server/tools/browser-tool.js`（~150 行）
3. `server/tools/index.js` 注册工具
4. `server/core/agent.js` 系统 prompt 加 `browse`
5. 测试：Agent → browse → 浏览器自动操作 → 返回结果

---

## 十、落地注意事项

### 10.1 启动预热

Stagehand 首次初始化会下载 Chromium（~150MB），可能耗时 10-30 秒。**必须在服务启动时预初始化**，不能等到 Agent 第一次调用才加载。

```js
// server/tools/browser-tool.js
let _stagehand = null;
let _initPromise = null;

// 服务启动时调用（非阻塞）
export function preInitBrowser() {
  if (!_initPromise) {
    _initPromise = (async () => {
      try {
        const { Stagehand } = await import('@browserbasehq/stagehand');
        _stagehand = new Stagehand({
          env: 'LOCAL',
          headless: true,
          // 隔离 Electron 的 Chrome
          browserConfig: {
            userDataDir: path.join(os.tmpdir(), 'sonder-browser-data'),
            args: [
              '--remote-debugging-port=9223',  // 不与 Electron 冲突
              '--no-sandbox',
              '--disable-gpu',                 // 无头模式不需要 GPU
              '--disable-dev-shm-usage',
            ],
          },
        });
        await _stagehand.init();
        log.log('Stagehand 预热完成');
      } catch (err) {
        log.error('Stagehand 预热失败:', err.message);
        _stagehand = null;
        _initPromise = null;
      }
    })();
  }
  return _initPromise;
}
```

### 10.2 缓存 Key 设计

不能简单做字符串全匹配——标点、大小写、空格差异会导致相同任务不命中。

```js
function normalizeTask(task) {
  return task
    .toLowerCase()
    .replace(/[，。！？、；：“”"'\-\s]+/g, ' ')  // 标点→空格
    .replace(/\s+/g, ' ')                          // 合并空格
    .trim();
}

// 缓存 key = 归一化 task + 可选 site
function cacheKey(task, site = '') {
  const base = normalizeTask(task);
  return site ? `${base}@${site.replace(/^https?:\/\//, '')}` : base;
}
```

### 10.3 AI 规划降级

Stagehand 的 `act()` 依赖 AI 理解任务并找到正确的 DOM 元素。如果 AI 规划失败（无法理解任务 / 找不到元素 / 超时），必须有降级路径。

```js
async function browseWithFallback(task, url, maxSteps) {
  const stagehand = await getStagehandIdle();
  const page = stagehand.page;

  try {
    // 主路径：Stagehand AI 引导
    const result = await stagehand.act({ action: task, maxSteps });
    if (result.success) return formatResult(page, result);
    log.warn('Stagehand act 失败，降级 Playwright');
  } catch (err) {
    log.warn(`Stagehand 异常: ${err.message}，降级 Playwright`);
  }

  // 降级路径：纯 Playwright 确定性操作
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText);
    return {
      success: true,
      degraded: true,
      summary: text.slice(0, 2000).replace(/\s+/g, ' ').trim(),
      url: page.url(),
    };
  }
  throw new Error('Stagehand 规划失败且无降级 URL');
}
```

### 10.4 Electron 浏览器隔离

Stagehand 启动的 Playwright Chromium 与 Electron 内嵌的 Chromium 是**两个独立进程**。需要确保：

| 冲突点 | 隔离方案 |
|--------|----------|
| `userDataDir` | 指定 `os.tmpdir()/sonder-browser-data`，不用默认路径 |
| 调试端口 | `--remote-debugging-port=9223`（Electron 可能占用 9222） |
| GPU 资源 | 无头模式 `--disable-gpu` |
| 内存 | 单例复用，不重复创建浏览器实例 |
| 清理 | `will-quit` 时调用 `_stagehand.close()` |

```js
// 优雅关闭
export async function closeBrowser() {
  if (_stagehand) {
    try {
      await _stagehand.close();
      _stagehand = null;
      log.log('Stagehand 浏览器已关闭');
    } catch (err) {
      log.warn('Stagehand 关闭异常:', err.message);
    }
  }
}
```

### 10.5 浏览器实例空闲管理

复用浏览器时，如果上一个任务还在执行，新的 `act()` 调用会冲突。

```js
let _busy = false;
let _pendingQueue = [];

async function getStagehandIdle() {
  if (_busy) {
    // 排队等待（最多等 30 秒）
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('浏览器繁忙超时')), 30000);
      _pendingQueue.push(() => { clearTimeout(timer); resolve(_stagehand); });
    });
  }
  _busy = true;
  return _stagehand;
}

function releaseStagehand() {
  _busy = false;
  const next = _pendingQueue.shift();
  if (next) next();
}
```

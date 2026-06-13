# Sonder 知识库系统设计文档 v2

> 状态：设计评审通过，待实施
> 最后更新：2026-06-12

---

## 1. 概述

### 1.1 定位

为 Sonder（AI 桌面宠物）构建**本地优先、语义检索增强的个人知识管理系统**。

与现有记忆系统形成互补，共同构成 Agent 的认知基础：

```
记忆系统 (Memory)              知识库 (Knowledge Base)
─────────────────              ──────────────────────
关于用户本人                   关于世界
"用户喜欢周杰伦"               "周杰伦 1979 年生于台湾"
"用户昨天心情不好"             "Python 3.12 新增 type 语句"
私有、敏感                     可共享、跨会话持久
4 层记忆架构                   事实库 + 图谱 + 文档库
```

### 1.2 核心功能

| 功能 | 说明 |
|------|------|
| **文件夹自动索引** | 监控本地目录，文档变更后自动解析入库，用户零迁移成本 |
| **混合语义检索** | BM25 关键词 + 向量语义 + RRF 融合，理解自然语言提问 |
| **笔记/网页收藏** | 对话中一键保存内容，自动入库并立即可检索 |
| **知识图谱** | 实体关系网络可视化，点击溯源原始文档 |
| **Agent 自主成长** | 被动提取 → 定期反思 → 好奇心驱动，知识库持续进化 |

### 1.3 设计原则

- **本地优先**：全部数据存本地，零外部依赖（除 LLM API）
- **无侵入接入**：监控已有文件夹，用户不需要迁移任何文件
- **CPU 可运行**：bge-micro-v2 仅 17MB embedding 模型，无需 GPU
- **与 Agent 深度集成**：不是独立系统，是 Agent 认知能力的有机部分
- **渐进复杂度**：初期保持简单，内置性能监控，瓶颈出现时自动升级

---

## 2. 技术选型

关键决策：**全部在现有 Node.js 栈内实现，不引入 Python。**

| 组件 | 选型 | 理由 |
|------|------|------|
| 运行时 | Node.js (现有) | 复用 Electron 主进程 |
| 数据库 | sql.js (SQLite WASM) | 已是项目依赖 |
| 向量模型 | bge-micro-v2 (Xenova) | 已是项目依赖，384 维，CPU 友好 |
| 向量存储 | 初期 JSON 文件 + 性能监控 | 简单可调试；>5000 条升级 sqlite-vec 或 hnswlib-node |
| BM25 | 自实现增量 BM25 | ~150 行 JS，支持 add/remove 文档，零依赖 |
| 文件监控 | chokidar + 定时全量兜底 | Node.js 生态标准，跨平台 |
| 文档解析 | marked (.md) / 原样 (.txt) / pdf-parse (.pdf) / cheerio (.html) | 覆盖主要格式 |
| 图谱渲染 | 自研 Canvas 2D + 分页加载 | 复用 MemoryGraphPage 力导向引擎 |

### 2.1 不引入的依赖及其替代方案

| 原方案依赖 | 为什么不引入 | 替代方案 |
|-----------|-------------|---------|
| Python / FastAPI | 跨语言调用复杂，部署负担 | Node.js 原生实现 |
| FAISS | 原生绑定需要编译，WASM 版功能受限 | 初期 JSON + 性能监控，后期 sqlite-vec |
| Neo4j | 需要独立服务进程 | SQLite 边表 + 递归 CTE |
| ECharts / G6 | 体积大（>1MB），样式定制受限 | 复用现有 Canvas 2D 力导向引擎 |
| rank_bm25 (Python) | 需要 Python | 自实现 BM25（~150 行 JS） |

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                   用户界面 (Electron Renderer)                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ KnowledgePage│  │ KnowledgeGraph│  │ 内联知识卡片/ChatPage │   │
│  │ (文档管理)   │  │ (力导向图)    │  │ (消息右键收藏)       │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │ IPC
┌─────────────────────────────────────────────────────────────────┐
│                 核心服务 (Electron Main Process)                  │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │ HybridRetriever  │  │ KnowledgeGraph   │                     │
│  │ • BM25 关键词    │  │ • 实体归一化     │                     │
│  │ • 向量语义       │  │ • 关系管理       │                     │
│  │ • RRF 融合       │  │ • 子图查询(CTE)  │                     │
│  │ • 语义缓存       │  │ • 分页加载       │                     │
│  └────────┬─────────┘  └────────┬─────────┘                     │
│           │                     │                                │
│  ┌────────┴─────────────────────┴──────────────────────────┐    │
│  │                    kb-core.js                            │    │
│  │  • 实体链接  • 事实去重  • 交叉验证  • 置信度管理       │    │
│  │  • 语义缓存  • 文档评分  • 类型分流(memory/knowledge)   │    │
│  └────────┬─────────────────────────────────────────────────┘    │
│           │                                                      │
│  ┌────────┴──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ FolderWatcher     │  │ DocParser     │  │ GrowthEngine     │  │
│  │ • chokidar 增量   │  │ • 多格式解析  │  │ • 被动提取      │  │
│  │ • hash 去重       │  │ • 分层分块    │  │ • 定时反思      │  │
│  │ • 定时全量兜底    │  │ • 元数据提取  │  │ • 好奇心驱动    │  │
│  └──────────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                         存储层                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │ 原始文件 │ │ SQLite   │ │ 向量索引 │ │ BM25 倒排索引    │   │
│  │ (镜像)   │ │ (sql.js) │ │ (JSON→   │ │ (增量可维护)     │   │
│  │          │ │          │ │  自动升级)│ │                  │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 存储设计

### 4.1 文件布局

```
~/.ai-desktop-pet/
├── agent-data/              # 现有：Agent 运行时数据
├── memory/                  # 现有：记忆系统
├── knowledge-base/          # 新增：知识库根目录
│   ├── kb.sqlite            # 元数据 + 事实 + 图谱 + 反思日志
│   ├── vectors.json         # 向量索引（<5000 条时使用）
│   ├── bm25-index.json      # BM25 倒排索引
│   ├── collections/         # 收藏笔记（.md 文件）
│   │   └── 2026-06-12_机器学习笔记.md
│   ├── chunks/              # 文档切片缓存（可选）
│   └── cache/               # 语义缓存
│       └── query-cache.json
└── config/
    └── kb-config.yaml       # 知识库配置
```

### 4.2 SQLite Schema

```sql
-- ═══════════════════════════════════════
-- 文件索引
-- ═══════════════════════════════════════
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  ext TEXT,
  hash TEXT,                     -- SHA256 去重
  size_bytes INTEGER,
  last_modified INTEGER,
  last_indexed INTEGER,
  chunk_count INTEGER DEFAULT 0,
  access_count INTEGER DEFAULT 0,    -- 用户/LLM 引用次数，影响检索权重
  importance_score REAL DEFAULT 0.5, -- 文档重要性评分
  status TEXT DEFAULT 'active',
  metadata TEXT                      -- JSON: {title, author, tags, source_type, …}
);

-- ═══════════════════════════════════════
-- 文档切片
-- ═══════════════════════════════════════
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT REFERENCES files(id),
  chunk_index INTEGER,
  content TEXT NOT NULL,
  token_count INTEGER,
  embedding_id TEXT,               -- 向量索引 key
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- ═══════════════════════════════════════
-- 实体（归一化）
-- ═══════════════════════════════════════
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,       -- 规范名称
  type TEXT,                       -- PERSON / ORG / CONCEPT / EVENT / TECH / PLACE / …
  aliases TEXT,                    -- JSON: ["别名1", "别名2"]
  description TEXT,
  first_seen_at INTEGER,
  doc_count INTEGER DEFAULT 0
);

-- ═══════════════════════════════════════
-- 事实（知识三元组）
-- ═══════════════════════════════════════
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES entities(id),
  predicate TEXT NOT NULL,          -- is_a / created_by / depends_on / has_property / …
  object_id TEXT REFERENCES entities(id),  -- 可为 null（当 object 是字面量时）
  object_value TEXT,                -- 字面量值
  confidence REAL DEFAULT 0.5,
  source_type TEXT,                 -- conversation / document / search / inference / user / collection
  source_id TEXT,                   -- 指向 chunk_id 或 conversation_id
  created_at INTEGER,
  updated_at INTEGER,
  verified_by TEXT,                 -- user_direct / user_implicit / cross_validation / null
  status TEXT DEFAULT 'active',     -- active / deprecated / contested / pending
  embedding_id TEXT                 -- 向量索引 key（可选）
);

-- ═══════════════════════════════════════
-- 关系边（图谱查询优化）
-- ═══════════════════════════════════════
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_entity TEXT REFERENCES entities(id),
  to_entity TEXT REFERENCES entities(id),
  relation_type TEXT NOT NULL,
  fact_id TEXT REFERENCES facts(id),
  confidence REAL,
  weight REAL DEFAULT 1.0
);

-- ═══════════════════════════════════════
-- 知识缺口（好奇心驱动）
-- ═══════════════════════════════════════
CREATE TABLE gaps (
  id TEXT PRIMARY KEY,
  entity_name TEXT,
  missing_info TEXT,
  context TEXT,
  priority REAL DEFAULT 0.5,
  status TEXT DEFAULT 'open',       -- open / asked_user / searched / resolved
  created_at INTEGER,
  resolved_at INTEGER
);

-- ═══════════════════════════════════════
-- 反思日志
-- ═══════════════════════════════════════
CREATE TABLE reflections (
  id TEXT PRIMARY KEY,
  type TEXT,                        -- dedup / contradiction / inference / gap_discovery
  summary TEXT,
  detail TEXT,                      -- JSON
  affected_facts TEXT,              -- JSON: 涉及的事实 ID 列表
  actions_taken TEXT,               -- JSON
  created_at INTEGER
);

-- ═══════════════════════════════════════
-- 语义缓存
-- ═══════════════════════════════════════
CREATE TABLE query_cache (
  id TEXT PRIMARY KEY,
  query_hash TEXT UNIQUE,           -- query 的归一化 hash
  query_text TEXT,
  result_json TEXT,                 -- 缓存结果
  hit_count INTEGER DEFAULT 1,
  created_at INTEGER,
  last_hit_at INTEGER,
  ttl_seconds INTEGER DEFAULT 3600  -- 1 小时过期
);

-- ═══════════════════════════════════════
-- 索引
-- ═══════════════════════════════════════
CREATE INDEX idx_chunks_file ON chunks(file_id);
CREATE INDEX idx_facts_subject ON facts(subject_id);
CREATE INDEX idx_facts_object ON facts(object_id);
CREATE INDEX idx_facts_status ON facts(status);
CREATE INDEX idx_facts_confidence ON facts(confidence);
CREATE INDEX idx_edges_from ON edges(from_entity);
CREATE INDEX idx_edges_to ON edges(to_entity);
CREATE INDEX idx_gaps_status ON gaps(status);
CREATE INDEX idx_files_path ON files(path);
CREATE INDEX idx_query_cache_hash ON query_cache(query_hash);
```

### 4.3 向量存储（自动升级策略）

```javascript
// vectors.json — 初期格式
{
  "dim": 384,
  "engine": "bge-micro-v2",
  "count": 3842,                    // 当前条目数
  "threshold": 5000,                // 超过此值自动升级
  "entries": {
    "chunk_abc123": [0.012, -0.034, ...],
    "chunk_def456": [0.056, 0.023, ...],
  }
}

// 性能监控 → 自动升级逻辑
async function vectorSearch(queryEmbedding, topK) {
  const count = await db.get('SELECT COUNT(*) as c FROM chunks');
  if (count > VECTOR_THRESHOLD) {
    log.warn(`向量条目 ${count} 超过阈值 ${VECTOR_THRESHOLD}，切换到 hnswlib`);
    await migrateToHNSW();
  }
  return bruteForceSearch(queryEmbedding, topK);
}
```

### 4.4 BM25 增量索引

```javascript
// bm25-index.json — 可增量更新的倒排索引
{
  "k1": 1.5, "b": 0.75,
  "doc_count": 500,
  "avgdl": 320.5,
  "terms": {
    "知识库": {
      "df": 12,                      // 文档频率
      "postings": {
        "chunk_abc123": { "tf": 3 },
        "chunk_def456": { "tf": 1 }
      }
    }
  }
}

class IncrementalBM25 {
  addDocument(docId, tokens) { /* 增量更新 df + postings + avgdl */ }
  removeDocument(docId)     { /* 反向操作 */ }
  updateDocument(docId, tokens) { this.removeDocument(docId); this.addDocument(docId, tokens); }
  flush()                   { /* 完整重建一次，修正浮点累积误差 */ }
  search(query, k)          { /* 标准 BM25 评分 */ }
}
```

---

## 5. 模块详细设计

### 5.1 模块 A：文件夹监控与自动索引

#### 5.1.1 工作流

```
chokidar.watch(paths, { recursive: true, ignoreInitial: true })
  ├── 'add' / 'change' → debounce(2s) → hash 对比 → 解析 → 分块 → 嵌入 → 写入
  ├── 'unlink' → 标记 status='deleted'，全量扫描时清理
  └── 定时全量扫描 (24h) → 找出 mtime > last_indexed → 增量更新

可靠性保障:
  - 定时全量扫描兜底（chokidar 在 WSL/网络驱动上可能漏事件）
  - SHA256 hash 去重（文件移动/重命名不会造成重复索引）
  - 手动"强制重建全部索引"按钮
```

#### 5.1.2 分块策略

```javascript
const chunkConfig = {
  maxTokens: 512,
  overlapTokens: 64,
  separators: [            // 优先级递减
    '\n\n',                // 段落
    '\n',
    '。', '！', '？',     // 中文句末
    '. ', '! ', '? ',     // 英文句末
    '；', ';',
    '，', ',',            // 最后手段
  ]
};
```

#### 5.1.3 文档重要性评分

影响检索时的排序权重：

```javascript
// 综合评分 = 访问频率 + LLM 引用次数 + 文件新鲜度
function calculateImportance(file) {
  const daysSinceModified = (Date.now() - file.last_modified) / 86400000;
  const freshnessScore = Math.exp(-0.05 * daysSinceModified);     // 最近修改的权重高
  const accessScore = Math.log2(file.access_count + 1) / 10;     // 常被引用的权重高
  return clamp(freshnessScore * 0.4 + accessScore * 0.6 + 0.3, 0, 1);
}
```

### 5.2 模块 B：混合检索引擎

#### 5.2.1 检索流程

```
用户 Query
    │
    ├── 语义缓存检查 (query_hash → 命中则直接返回)
    │
    ├─→ BM25 检索 (增量索引)
    │     • 中文分词：Unigram + Bigram
    │     • BM25 评分
    │     • 返回 TopK=30
    │
    ├─→ 向量检索 (auto: JSON 全量 / hnswlib)
    │     • bge-micro-v2 编码 query
    │     • 余弦相似度
    │     • 返回 TopK=30
    │
    └─→ RRF 融合 (k=60)
          score(d) = Σ 1/(k + rank_i(d))
          取 TopN=10
              │
              ├─→ LLM 重排序（挑最相关 3~5 个，自动附引用标记）
              │
              └─→ 写入语义缓存
```

#### 5.2.2 核心接口

```javascript
class HybridRetriever {
  constructor({ bm25, vectorStore, fusionK = 60, cacheTTL = 3600 }) { … }

  async search(query, { topK = 10, rerank = true } = {}) {
    // 0. 语义缓存
    const cached = this.cache.get(query);
    if (cached) { this.cache.touch(cached.id); return cached.results; }

    // 1. 并行检索
    const [bm25Results, vectorResults] = await Promise.all([
      this.bm25.search(query, 30),
      this.vector.search(query, 30),
    ]);

    // 2. RRF 融合
    let results = this.rrfFusion(bm25Results, vectorResults, this.fusionK);

    // 3. 文档重要性加权
    results = await this.applyImportanceBoost(results);

    // 4. LLM 重排序
    if (rerank && results.length > 5) {
      results = await this.llmRerank(query, results.slice(0, 10), topK);
    } else {
      results = results.slice(0, topK);
    }

    // 5. 写缓存
    this.cache.set(query, results);
    return results;
  }

  // 语义缓存：归一化 query 后取 hash
  normalizeQuery(query) {
    return query.toLowerCase().replace(/\s+/g, ' ').trim();
  }
}
```

### 5.3 模块 C：笔记/网页收藏

```javascript
// Agent 工具
export const saveKnowledge = {
  name: 'save_knowledge',
  description: `保存网页或笔记到长期知识库。用户说"记住这个""收藏一下""存起来"时使用。`,
  parameters: {
    type: 'object',
    properties: {
      title:       { type: 'string' },
      content:     { type: 'string', description: 'Markdown 格式正文' },
      source_type: { type: 'string', enum: ['note', 'webpage', 'clip'] },
      url:         { type: 'string' },
      tags:        { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'content'],
  },
  async invoke({ title, content, source_type = 'note', url = '', tags = [] }) {
    // 写入 → 增量索引 → 返回确认
    const filepath = writeCollectionFile(title, content, source_type, url, tags);
    kbIndexer.indexFile(filepath).catch(e => log.warn('索引收藏失败:', e.message));
    return `已保存到知识库：${title}`;
  },
};
```

前端入口：
- ChatPage/VoiceChat 消息气泡右键菜单 → "收藏到知识库"
- 对话中直接说 "把这段存起来"

### 5.4 模块 D：知识图谱

#### 5.4.1 实体关系抽取（分阶段）

```
Phase 1 — 手动标注（立即）
  Agent 工具: add_relation(subject, predicate, object)
  用户说 "记住 XXX 是 YYY 的 ZZZ" → Agent 调用工具写入

Phase 2 — 对话自动提取（同时）
  每轮对话后 LLM 提取 → 区分 facts.type → 分别写入 memory / knowledge-base
  置信度: 0.6~0.8，标记 source_type='conversation'

Phase 3 — 文档批量提取（选装，默认关闭）
  extraction.auto_from_docs: false
  开启后每篇文档索引时 LLM 扫描提取（耗 token，用户主动触发）
```

#### 5.4.2 图查询

```javascript
class KnowledgeGraph {
  // 获取实体子图（默认 1 跳，通过 SQLite 递归 CTE）
  async getSubgraph(entityName, { hops = 1, limit = 50 } = {}) { … }

  // 搜索实体（支持模糊匹配别名）
  async searchEntities(query, { type = null, limit = 20 } = {}) { … }

  // 两实体间最短路径
  async findPath(from, to, { maxHops = 4 } = {}) { … }

  // 分页加载（前端按需加载，避免一次渲染上千节点）
  async getEdgesPaginated(entityId, { page = 0, pageSize = 50 } = {}) { … }
}
```

#### 5.4.3 前端可视化

复用 `MemoryGraphPage.vue` 的 Canvas 2D 力导向引擎，增加：

- **按实体类型着色**：人物=暖色、技术=冷色、概念=中性
- **节点大小**：按关联边数缩放
- **默认 1 跳子图**：点击节点展开更多
- **渲染上限**：最多 200 节点，超出时分页加载
- **点击节点**：侧边栏展示详情（关联事实 + 来源文档链接）
- **Hover**：显示完整关系链
- **搜索框**：定位实体

### 5.5 模块 E：Agent 成长引擎

#### 5.5.1 被动提取 + 类型分流

每轮对话后，一次 LLM 调用同时提取两类事实：

```javascript
// LLM system prompt 中定义判别规则
const extractionPrompt = `
对于每条提取的事实，标记 type:
  "memory"    — 关于用户本人的偏好、经历、状态
  "knowledge" — 关于外部世界的客观知识

示例:
  "用户喜欢周杰伦"     → type: "memory"
  "周杰伦 1979 年生"   → type: "knowledge"
  "用户昨天加班到很晚"  → type: "memory"
  "React 19 引入 RSC"   → type: "knowledge"
`;

// 后端分流
function routeFact(fact) {
  if (fact.type === 'memory') {
    memoryStore.addFact(fact);
  } else {
    knowledgeBase.addFact(fact);
  }
}
```

#### 5.5.2 定期反思（后台异步）

```
触发条件: 累计 5 轮对话 或 距上次反思 > 10 分钟
执行方式: 后台异步，不阻塞用户对话
优先处理: confidence 在 0.4~0.7 之间的事实

反思流程:
  1. 取候选事实 → LLM 分析
  2. 矛盾检测 → 双方降 0.2，标记 contested
  3. 合并检测 → 归一化实体名
  4. 推理: A→B + B→C ⟹ A→C (confidence = min(A→B, B→C) × 0.7)
  5. 写入 reflections 表 + 更新 facts
```

#### 5.5.3 好奇心驱动

```
对话中实时检测:
  1. 用户提到概念 X → 知识库无 → gap, priority=0.7
  2. 某事实 confidence < 0.4 → 需要验证 → gap
  3. 实体关系不完整 → gap

行为策略:
  priority > 0.7 + 上下文合适 → 自然追问
    "你刚才提到的 XX，能多跟我说说吗？我很想了解一下。"
  
  priority 0.4~0.7 → 积累到 5 个缺口，一次问一个
  
  priority < 0.4 → 不打扰用户，后台标记
  
  confidence < 0.5 的新事实 → 不直接入库 → 转 gap → 待确认
```

#### 5.5.4 置信度与验证

```
生命周期:
  0.0 ────────────────────────────── 1.0
  猜测       推断       确认       铁证
  
  来源:
    conversation → 默认 0.6
    user_direct  → 0.95（用户明确说"记住…"）
    document     → 0.7
    inference    → 0.3（推理得出）
    search       → 0.5

  自动调整:
    - 与新事实矛盾 → 双方各降 0.2，标记 contested
    - 3 个月未被引用 → ×0.9
    - 两个独立来源一致 → 取 max，+0.1 奖励
    - 用户主动纠正 → 旧事实 deprecated，新事实 0.9+

  待确认机制:
    - confidence < 0.5 的新事实 → status='pending' → 转为 gap
    - 前端展示 "这个对吗？" 确认按钮
```

---

## 6. Agent 工具接口

```javascript
export const kbTools = [
  {
    name: 'search_knowledge',
    description: '搜索知识库，查找关于某主题的已知信息。用户问"你知道XXX吗""帮我查一下"时使用。',
    params: { query: { type: 'string' } },
    invoke: ({ query }) => hybridRetriever.search(query, { topK: 5 }),
  },
  {
    name: 'save_knowledge',
    description: '保存网页或笔记到长期知识库。',
    params: { title, content, source_type, url, tags },
    invoke: (args) => kbManager.save(args),
  },
  {
    name: 'add_relation',
    description: '添加实体关系。用户说"记住XXX是YYY的ZZZ"时使用。',
    params: { subject, predicate, object },
    invoke: ({ subject, predicate, object }) =>
      kbGraph.addRelation(subject, predicate, object, { source: 'user', confidence: 0.95 }),
  },
  {
    name: 'lookup_knowledge',
    description: '精确查找某实体的所有已知信息。',
    params: { entity: { type: 'string' } },
    invoke: ({ entity }) => kbGraph.getEntityWithFacts(entity),
  },
];
```

---

## 7. 接口协议

### 7.1 IPC 接口

```
Renderer → Main (invoke):
  kb:search          { query, topK? }          → 搜索结果列表
  kb:ask             { question }              → RAG 增强回答 + 引用来源
  kb:save            { title, content, … }     → 保存确认
  kb:graph-nodes     { query?, limit? }        → 实体列表
  kb:graph-edges     { entityId, hops?, page? }→ 边列表（分页）
  kb:index-trigger   {}                        → 手动触发全量扫描
  kb:index-rebuild   {}                        → 强制重建全部索引
  kb:config          {}                        → 获取配置
  kb:config-update   { config }                → 更新配置

Main → Renderer (send):
  kb:index-progress  { file, status, progress }
  kb:index-complete  { total_files, new_chunks, duration }
  kb:reflection-done { summary }
```

### 7.2 REST API（可选，供外部工具调用）

```
POST /api/kb/search      { query, topK? }
POST /api/kb/ask         { question }
POST /api/kb/save        { title, content, source_type, url?, tags? }
GET  /api/kb/graph/nodes?query=&limit=
GET  /api/kb/graph/edges?entityId=&hops=&page=
POST /api/kb/index/trigger
```

---

## 8. 实现计划

### Phase 1：存储 + 基础检索（预计 2-3 天）

```
□ 创建 knowledge-base/ 目录结构
□ kb-schema.js — 初始化 SQLite 表 + 索引
□ kb-embedder.js — 封装 bge-micro-v2 调用（复用现有 Xenova pipeline）
□ kb-bm25.js — 增量 BM25 实现（add/remove/search/flush）
□ kb-vector.js — 向量存储 + 性能监控 + 自动升级逻辑
□ kb-retriever.js — 混合检索 + RRF 融合 + 语义缓存
□ kb-cache.js — query 归一化 + hash + TTL 管理
□ kb-tools.js — search_knowledge / lookup_knowledge
□ Agent 集成 — 注册工具，更新系统提示
□ 简单验证脚本：node scripts/test-kb.js
```

### Phase 2：文件监控 + 文档摄入（预计 2-3 天）

```
□ kb-config.js — 配置加载 + 默认值
□ kb-parser.js — .md (marked) / .txt / .html (cheerio) 解析
□ kb-chunker.js — 分层分块策略
□ kb-indexer.js — 分块 → 嵌入 → 写 DB → 更新向量 → 更新 BM25
□ kb-watcher.js — chokidar 增量 + 定时全量兜底
□ 文档重要性评分
□ IPC 注册 kb:index-* / kb:search
□ 前端 KnowledgePage.vue — 基础文档列表 + 搜索框
```

### Phase 3：知识图谱（预计 2-3 天）

```
□ kb-graph.js — 实体归一化、addRelation、getSubgraph、分页查询
□ Agent 对话提取增强 — type 分流 memory/knowledge
□ add_relation 工具
□ 前端 KnowledgeGraph.vue — 力导向图（复用引擎 + 类型着色 + 分页加载）
□ 实体搜索框 + 详情侧边栏
□ 用户确认/纠正 UI（"这个对吗？" 按钮）
```

### Phase 4：成长引擎（预计 2 天）

```
□ kb-extraction.js — 对话事实提取 + type 分流
□ kb-reflection.js — 定时反思循环（后台异步）
□ kb-curiosity.js — 缺口检测 + 追问策略
□ pending 事实 → gap 转换
□ 反思报告写入 reflections 表
```

### Phase 5：收藏 + 高级功能（预计 1-2 天）

```
□ save_knowledge 工具
□ 消息右键 → 收藏到知识库
□ pdf-parse 集成
□ 知识库页面完整搜索 UI
□ RAG 问答端点 kb:ask
```

### Phase 6：优化（持续）

```
□ 向量存储升级（>5000 条 → hnswlib-node 或 sqlite-vec）
□ BM25 定期 flush 修正浮点误差
□ 跨文档矛盾检测
□ 多模态支持（图片 OCR → tesseract.js）
□ 联邦检索（外部 API：arXiv、GitHub 等）
```

---

## 9. 配置

```yaml
# kb-config.yaml
data_root: ~/.ai-desktop-pet/knowledge-base

watch:
  paths:
    - ~/Documents/notes
  recursive: true
  extensions: [.md, .txt, .pdf, .html]
  full_scan_interval_hours: 24
  max_file_size_mb: 50

retrieval:
  fusion_method: rrf             # rrf | weighted
  rrf_k: 60
  top_k: 10
  rerank: true                   # LLM 重排序
  cache_ttl_seconds: 3600        # 语义缓存过期时间

chunking:
  max_tokens: 512
  overlap_tokens: 64

vector:
  threshold: 5000                # 超过此值自动升级索引
  upgrade_strategy: hnswlib      # hnswlib | sqlite-vec

extraction:
  auto_from_docs: false          # 索引时自动提取关系（耗 token）
  auto_from_conversation: true   # 对话后自动提取
  min_confidence_for_storage: 0.5  # 低于此值转为 pending

growth:
  reflection_min_conversations: 5
  reflection_interval_minutes: 10
  curiosity_max_gaps_per_turn: 1
  max_pending_gaps: 20
  auto_search: false             # Agent 主动上网查资料
```

---

## 10. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| 向量 >5000 条性能下降 | 中 | 中 | 内置性能监控，自动升级 hnswlib |
| BM25 增量累积误差 | 低 | 低 | 定期 flush 全量重建（每天/每周） |
| chokidar 漏事件 | 中 | 中 | 定时全量扫描 + 手动强制重建按钮 |
| LLM 实体提取质量差 | 高 | 低 | 低置信度转 pending，用户确认机制 |
| 反思循环频繁调 LLM | 中 | 中 | 后台异步 + 优先高价值事实 + 缓存结果 |
| 图谱节点过多导致前端卡顿 | 中 | 中 | 默认 1 跳 + 最多 200 节点 + 分页加载 |
| 跨平台路径兼容（Win/Mac/Linux） | 低 | 低 | pathlib 风格处理，chokidar 已验证跨平台 |

---

## 11. 附录：记忆 vs 知识 判别规则

LLM 提取 prompt 中的判别指南：

```
对于以下事实，分类为 memory 或 knowledge：

→ memory（用户相关，隐私敏感）：
  - 用户偏好: "用户喜欢/讨厌/想…"
  - 用户经历: "用户昨天/曾经/正在…"
  - 用户状态: "用户是/感觉/认为…"
  - 用户社交: "用户的朋友/同事/家人…"
  - 用户计划: "用户打算/计划/要…"

→ knowledge（客观知识，可共享）：
  - 事物定义: "XX 是一种/指的是/用于…"
  - 事实陈述: "XX 发生在/位于/创建于…"
  - 技术信息: "XX 支持/需要/依赖…"
  - 人物信息: "XX 是/生于/创作了…"（非用户本人）
  - 关系信息: "XX 和 YY 是/属于/影响…"

边界案例:
  "用户说 Python 很好用" → memory（用户的观点）
  "Python 是一种编程语言" → knowledge（客观事实）
  "用户用 Python 写了一个脚本" → memory（用户的经历）
  "Python 3.12 新增 type 语句" → knowledge（技术事实）
```

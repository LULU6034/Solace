/**
 * memory-tools.js — 记忆工具（完整版）
 *
 * remember / recall / forget / update_memory / memory_status
 * recall 优先向量搜索，降级关键词；整合 KG 关系查询
 */
import { getMemoryStore } from './memory-store-ref.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

// ── 帮助函数 ──
function estTokens(text) { return Math.ceil((text || '').length / 4); }
function _now() { return new Date(); }
function _fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── 情景记忆索引 ──
function _indexPath() {
  return path.join(process.env.HOME || process.env.USERPROFILE || '', '.ai-desktop-pet', 'memory', 'episode_index.json');
}
function _epDir() {
  return path.join(process.env.HOME || process.env.USERPROFILE || '', '.ai-desktop-pet', 'memory', 'episodes');
}

function _tokenize(text) {
  const t = (text || '').toLowerCase().replace(/[^一-龥a-zA-Z0-9]/g, ' ');
  const words = t.split(/\s+/).filter(w => w.length > 0);
  const tokens = [];
  for (const w of words) {
    if (/^[a-zA-Z0-9]+$/.test(w)) { tokens.push(w); continue; }
    for (let i = 0; i < w.length; i++) {
      tokens.push(w[i]);
      if (i + 1 < w.length) tokens.push(w[i] + w[i + 1]);
    }
  }
  return [...new Set(tokens)];
}

function loadEpisodeIndex() {
  try {
    const p = _indexPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return {}; }
}

function searchEpisodicByIndex(query, k = 5) {
  const qTokens = _tokenize(query);
  if (!qTokens.length) return [];
  const idx = loadEpisodeIndex();
  if (!Object.keys(idx).length) return _searchEpisodicFallback(query, k);

  // 倒排索引查询
  const hits = new Map(); // file → { line, score }
  for (const tok of qTokens) {
    const posting = idx[tok];
    if (!posting) continue;
    for (const entry of posting) {
      const key = entry.file + '|' + entry.line;
      hits.set(key, (hits.get(key) || 0) + entry.score);
    }
  }

  // 按分数排序，取 top 文件
  const fileScores = new Map();
  for (const [key, score] of hits) {
    const file = key.split('|')[0];
    fileScores.set(file, (fileScores.get(file) || 0) + score);
  }
  const topFiles = [...fileScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([f]) => f);

  // 只读命中的文件
  const results = [];
  const baseDir = _epDir();
  for (const file of topFiles) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(baseDir, file), 'utf-8'));
      const eps = Array.isArray(data) ? data : [data];
      for (const ep of eps) {
        if (!ep?.content?.keyQuote) continue;
        const text = (ep.content.keyQuote || '') + ' ' + (ep.content.topic || '');
        const tTokens = _tokenize(text);
        const overlap = qTokens.filter(t => tTokens.includes(t)).length;
        if (overlap >= 2) {
          const daysAgo = (Date.now() - (ep.timestamp || 0)) / 86400000;
          const decay = Math.exp(-0.05 * Math.max(0, daysAgo));
          results.push({
            text: ep.content.keyQuote,
            topic: ep.content.topic || '',
            date: _fmtDate(ep.timestamp),
            score: Math.round(overlap * decay * 10) / 10,
            layer: '情景记忆',
          });
        }
      }
    } catch {}
  }

  return results.sort((a, b) => b.score - a.score).slice(0, k);
}

// 降级：遍历 JSON 文件（索引损坏或无索引时）
function _searchEpisodicFallback(query, k = 5) {
  try {
    const baseDir = _epDir();
    if (!fs.existsSync(baseDir)) return [];
    const files = fs.readdirSync(baseDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 14);
    const results = [];
    const qTokens = _tokenize(query);
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(baseDir, file), 'utf-8'));
        for (const ep of (Array.isArray(data) ? data : [data])) {
          if (!ep?.content?.keyQuote) continue;
          const text = (ep.content.keyQuote || '');
          const tTokens = _tokenize(text);
          const overlap = qTokens.filter(t => tTokens.includes(t)).length;
          if (overlap >= 2) {
            const daysAgo = (Date.now() - (ep.timestamp || 0)) / 86400000;
            results.push({
              text: ep.content.keyQuote,
              date: _fmtDate(ep.timestamp),
              score: Math.round(overlap * Math.exp(-0.05 * Math.max(0, daysAgo)) * 10) / 10,
              layer: '情景记忆',
            });
          }
        }
      } catch {}
    }
    return results.sort((a, b) => b.score - a.score).slice(0, k);
  } catch { return []; }
}

// ── KG 查询 ──
let _kgCache = null;
function getKG() {
  if (!_kgCache) {
    try {
      // KnowledgeGraph 是全局单例，从 index.js 创建的
      const { getVectorSearch } = _require('./vector-search.js'); // trigger import
    } catch {}
  }
  return _kgCache;
}
function setKG(kg) { _kgCache = kg; }

function searchKG(query) {
  if (!_kgCache?.graph?.queryRelations) return [];
  try {
    return _kgCache.graph.queryRelations(query, 6);
  } catch { return []; }
}

// ── 中期摘要搜索 ──
function searchMediumTerm(query, k = 3) {
  try {
    const baseDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.ai-desktop-pet', 'memory', 'summaries');
    if (!fs.existsSync(baseDir)) return [];
    const files = fs.readdirSync(baseDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 7);
    const results = [];
    const qLower = (query || '').toLowerCase();
    const qTokens = _tokenize(query);
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(baseDir, file), 'utf-8'));
        const text = (data.summary || '') + ' ' + (data.topics || []).join(' ');
        const tTokens = _tokenize(text);
        const overlap = qTokens.filter(t => tTokens.includes(t)).length;
        if (overlap >= 2 || (qLower && text.toLowerCase().includes(qLower))) {
          results.push({ text: data.summary, date: file.replace('.json', ''), turnCount: data.turnCount, layer: '中期摘要' });
        }
      } catch {}
    }
    return results.slice(0, k);
  } catch { return []; }
}

// ═══════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════

// ── 冲突检测 ──
const SENTIMENT_PAIRS = [
  ['喜欢', '讨厌'], ['爱', '恨'], ['爱', '讨厌'], ['喜欢', '不喜欢'],
  ['是', '不是'], ['有', '没有'], ['会', '不会'], ['能', '不能'],
  ['想', '不想'], ['愿意', '不愿意'], ['可以', '不可以'],
  ['经常', '从不'], ['总是', '从不'], ['每天', '从不'],
];
// 提取实体关键词（去情感词后的剩余名词/动词）
function _extractSubject(text) {
  const sentimentWords = new Set(SENTIMENT_PAIRS.flat());
  const cleaned = text.replace(/[，。！？、；：""''（）\s]/g, ' ').replace(/[{}\[\]"']/g, '');
  const words = cleaned.split(/\s+/).filter(w => w.length >= 2 && !sentimentWords.has(w));
  return words.join(' ').slice(0, 60);
}
// 判断情感极性: 1=正向, -1=负向, 0=中性
function _sentimentPolarity(text) {
  const pos = ['喜欢','爱','是','有','会','能','想','愿意','可以','经常','总是','每天','好','对','正确'];
  const neg = ['讨厌','恨','不喜欢','不是','没有','不会','不能','不想','不愿意','不可以','从不','坏','错','错误'];
  let score = 0;
  for (const w of pos) { if (text.includes(w)) score += 1; }
  for (const w of neg) { if (text.includes(w)) score -= 1; }
  if (score > 0) return 1;
  if (score < 0) return -1;
  return 0;
}

function _detectConflict(newFact, oldFact) {
  const newSubj = _extractSubject(newFact);
  const oldSubj = _extractSubject(oldFact);
  if (!newSubj || !oldSubj || newSubj.length < 2 || oldSubj.length < 2) return false;
  // 主体相似度: 简单用 bigram 重叠
  const newTokens = _tokenize(newSubj);
  const oldTokens = _tokenize(oldSubj);
  const overlap = newTokens.filter(t => oldTokens.includes(t)).length;
  if (overlap < Math.min(2, Math.min(newTokens.length, oldTokens.length))) return false;
  // 极性相反
  return _sentimentPolarity(newFact) * _sentimentPolarity(oldFact) < 0;
}

export const remember = {
  name: 'remember',
  description: `记住重要信息。会自动检测与旧记忆的冲突。
参数 content: 要记住的内容，tags: 标签列表`,
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要记住的内容' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签' },
    },
    required: ['content'],
  },
  async invoke({ content, tags = [] }) {
    if (!content?.trim()) return '记忆内容不能为空';
    const store = getMemoryStore();
    if (!store) return '记忆存储未初始化';

    // 冲突检测
    const existing = store.getAll?.() || [];
    const conflicts = [];
    for (const f of existing) {
      const oldText = f.fact || f.text || f.content || '';
      if (!oldText || oldText === content.trim()) continue;
      if (_detectConflict(content.trim(), oldText)) {
        conflicts.push(oldText);
      }
    }

    store.addFact(content.trim(), tags);

    if (conflicts.length) {
      const conflictList = conflicts.map(c => `  · ${c}`).join('\n');
      return `⚠️ 检测到与旧记忆冲突:\n${conflictList}\n\n已保存新记忆: ${content.slice(0, 80)}。建议告知用户此冲突。`;
    }
    return `已记住: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`;
  },
};

export const recall = {
  name: 'recall',
  description: `搜索全部记忆系统。优先使用语义向量搜索，结果带时间衰减。
参数 query: 搜索关键词
参数 k: 返回数量(默认5)
参数 layer: "facts"(长期事实) / "episodes"(历史对话) / "summaries"(每日摘要) / "kg"(知识图谱) / "all"(全部,默认)`,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词或问题' },
      k: { type: 'integer', description: '返回数量，默认5' },
      layer: { type: 'string', description: '层级: facts, episodes, summaries, kg, all' },
    },
    required: ['query'],
  },
  async invoke({ query, k = 5, layer = 'all' }) {
    if (!query?.trim()) return '搜索关键词不能为空';
    const store = getMemoryStore();
    if (!store) return '记忆存储未初始化';
    const maxK = Math.min(k || 5, 10);
    const allResults = [];

    // 1. 长期事实 — 向量优先
    if (layer === 'all' || layer === 'facts') {
      try {
        let facts;
        if (typeof store.vectorSearch === 'function') {
          facts = await store.vectorSearch(query, maxK);
        } else {
          facts = store.search(query, maxK);
        }
        for (const f of (facts || [])) {
          const text = f.fact || f.text || f.content || '';
          if (text && f.source !== 'system') {
            allResults.push({ text, tags: f.tags || [], score: f.score || 5,
              source: f.source || 'keyword', layer: '长期记忆' });
          }
        }
        // 降级提示
        const hint = (facts || []).find(f => f.source === 'system');
        if (hint) allResults.push({ text: '⚠️ ' + hint.fact, score: 0, source: 'system', layer: '系统' });
      } catch {}
    }

    // 2. 知识图谱
    if (layer === 'all' || layer === 'kg') {
      try {
        const kgResults = searchKG(query);
        if (kgResults.length) {
          allResults.push(...kgResults.map(r => ({
            text: r.text, score: 6, layer: '知识图谱',
          })));
        }
      } catch {}
    }

    // 3. 情景记忆 — 索引优先
    if (layer === 'all' || layer === 'episodes') {
      try {
        const eps = searchEpisodicByIndex(query, Math.ceil(maxK / 2));
        allResults.push(...eps);
      } catch {}
    }

    // 4. 中期摘要
    if (layer === 'all' || layer === 'summaries') {
      try {
        const sums = searchMediumTerm(query, Math.ceil(maxK / 2));
        allResults.push(...sums);
      } catch {}
    }

    if (!allResults.length) return `未找到关于 "${query}" 的记忆`;

    const sorted = allResults.sort((a, b) => (b.score || 5) - (a.score || 5)).slice(0, maxK);
    return sorted.map((r, i) => {
      const date = r.date ? ` (${r.date})` : '';
      const src = r.source ? ` [${r.source}]` : '';
      const layerTag = r.layer ? ` · ${r.layer}` : '';
      return `${i + 1}. ${r.text}${date}${src}${layerTag}`;
    }).join('\n');
  },
};

export const forget = {
  name: 'forget',
  description: `删除一条记忆。需要用户明确确认后才能调用。
参数 content: 要忘记的记忆内容（全文匹配），或 id: 记忆 ID`,
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要忘记的记忆内容' },
    },
    required: ['content'],
  },
  async invoke({ content }) {
    if (!content?.trim()) return '请提供要忘记的记忆内容';
    const store = getMemoryStore();
    if (!store) return '记忆存储未初始化';
    const ok = store.softDelete(content.trim());
    return ok ? `已遗忘: ${content.slice(0, 60)}` : '未找到匹配的记忆';
  },
};

export const updateMemory = {
  name: 'update_memory',
  description: `修改一条已存在的记忆。先调用 recall 找到旧记忆，确认后再调用此工具。
参数 oldContent: 旧的记忆内容（原文），newContent: 修改后的内容`,
  parameters: {
    type: 'object',
    properties: {
      oldContent: { type: 'string', description: '旧的记忆内容' },
      newContent: { type: 'string', description: '新的记忆内容' },
    },
    required: ['oldContent', 'newContent'],
  },
  async invoke({ oldContent, newContent }) {
    if (!oldContent?.trim() || !newContent?.trim()) return '旧内容和新内容都不能为空';
    const store = getMemoryStore();
    if (!store) return '记忆存储未初始化';
    store.softDelete(oldContent.trim());
    store.addFact(newContent.trim(), []);
    return `已更新: ${newContent.slice(0, 80)}`;
  },
};

export const memoryStatus = {
  name: 'memory_status',
  description: '查看记忆系统状态：各层数量、最早/最新日期、健康度',
  parameters: { type: 'object', properties: {}, required: [] },
  async invoke() {
    const store = getMemoryStore();
    if (!store) return '记忆存储未初始化';
    const parts = [];

    // 长期事实
    try {
      const count = store.count() || 0;
      const deleted = store.countDeleted ? store.countDeleted() : 0;
      parts.push(`长期事实: ${count} 条${deleted ? `（${deleted} 条待清理）` : ''}`);
    } catch { parts.push('长期事实: 不可用'); }

    // 情景记忆
    try {
      const ed = _epDir();
      if (fs.existsSync(ed)) {
        const files = fs.readdirSync(ed).filter(f => f.endsWith('.json')).sort();
        if (files.length) {
          const earliest = files[0].replace('.json', '');
          const latest = files[files.length - 1].replace('.json', '');
          parts.push(`情景记忆: ${files.length} 天（${earliest} ~ ${latest}）`);
        } else { parts.push('情景记忆: 暂无'); }
      } else { parts.push('情景记忆: 暂无'); }
    } catch { parts.push('情景记忆: 不可用'); }

    // 中期摘要
    try {
      const sd = path.join(process.env.HOME || process.env.USERPROFILE || '', '.ai-desktop-pet', 'memory', 'summaries');
      if (fs.existsSync(sd)) {
        const files = fs.readdirSync(sd).filter(f => f.endsWith('.json'));
        parts.push(`中期摘要: ${files.length} 天`);
      } else { parts.push('中期摘要: 暂无'); }
    } catch { parts.push('中期摘要: 不可用'); }

    // 知识图谱
    try {
      if (_kgCache?.graph?.stats) {
        const s = _kgCache.graph.stats;
        parts.push(`知识图谱: ${s.nodes} 实体 / ${s.edges} 关系`);
      } else { parts.push('知识图谱: 未加载'); }
    } catch { parts.push('知识图谱: 不可用'); }

    // 情景索引
    try {
      const idxPath = _indexPath();
      if (fs.existsSync(idxPath)) {
        const idx = loadEpisodeIndex();
        parts.push(`情景索引: ${Object.keys(idx).length} 关键词`);
      } else { parts.push('情景索引: 未构建'); }
    } catch { parts.push('情景索引: 不可用'); }

    const health = count => count > 100 ? '记忆数量较多，建议定期清理' : count < 3 ? '记忆较少，多互动可以让我更懂你' : '记忆数量适中';

    return `📊 记忆系统状态\n${parts.map(p => `  · ${p}`).join('\n')}\n  · ${health(store.count?.() || 0)}`;
  },
};

// 导出 KG setter 供 index.js 使用
export { setKG };

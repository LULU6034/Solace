/**
 * memory-tools.js — 记忆管理工具（Stage 5：MemoryManager 模式）
 *
 * remember / recall / forget / update_memory / memory_status
 * recall 优先向量搜索，降级关键词；整合情景索引和中期摘要。
 *
 * 通过 setMemoryManagerForTools(mm) 注入 MemoryManager 实例，
 * 由 server/index.js 在初始化时调用。
 */
import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { createModuleLogger } from '../lib/debug-log.js';
import { searchEpisodesByIndex } from '../memory/episodic.js';
import { searchByTopic } from '../memory/medium-term.js';

const log = createModuleLogger('memory-tools');

// ── MemoryManager 引用（由 server/index.js 注入）──
let _memoryManager = null;

/**
 * 注入 MemoryManager 实例，供所有记忆工具使用。
 * 由 server/index.js 在 MemoryManager 创建后调用。
 */
export function setMemoryManagerForTools(mm) {
  _memoryManager = mm;
}

// ── 辅助函数 ──
function _fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _epDir() {
  return path.join(os.homedir(), '.ai-desktop-pet', 'memory', 'episodes');
}

function _summariesDir() {
  return path.join(os.homedir(), '.ai-desktop-pet', 'memory', 'summaries');
}

// ── KG 引用（独立于 MemoryManager，由 setKG 注入）──
let _kgCache = null;
export function setKG(kg) { _kgCache = kg; }

function searchKG(query) {
  if (!_kgCache?.graph?.queryRelations) return [];
  try {
    return _kgCache.graph.queryRelations(query, 6);
  } catch { return []; }
}

// ── 冲突检测（remember 工具使用）──
const SENTIMENT_PAIRS = [
  ['喜欢', '讨厌'], ['爱', '恨'], ['爱', '讨厌'], ['喜欢', '不喜欢'],
  ['是', '不是'], ['有', '没有'], ['会', '不会'], ['能', '不能'],
  ['想', '不想'], ['愿意', '不愿意'], ['可以', '不可以'],
  ['经常', '从不'], ['总是', '从不'], ['每天', '从不'],
];

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

function _extractSubject(text) {
  const sentimentWords = new Set(SENTIMENT_PAIRS.flat());
  const cleaned = text.replace(/[，。！？、；：""''（）\s]/g, ' ').replace(/[{}\[\]"']/g, '');
  const words = cleaned.split(/\s+/).filter(w => w.length >= 2 && !sentimentWords.has(w));
  return words.join(' ').slice(0, 60);
}

function _sentimentPolarity(text) {
  const pos = ['喜欢', '爱', '是', '有', '会', '能', '想', '愿意', '可以', '经常', '总是', '每天', '好', '对', '正确'];
  const neg = ['讨厌', '恨', '不喜欢', '不是', '没有', '不会', '不能', '不想', '不愿意', '不可以', '从不', '坏', '错', '错误'];
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
  const newTokens = _tokenize(newSubj);
  const oldTokens = _tokenize(oldSubj);
  const overlap = newTokens.filter(t => oldTokens.includes(t)).length;
  if (overlap < Math.min(2, Math.min(newTokens.length, oldTokens.length))) return false;
  return _sentimentPolarity(newFact) * _sentimentPolarity(oldFact) < 0;
}

// ═══════════════════════════════════════
// Tool 1: remember — 记住新信息
// ═══════════════════════════════════════
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
    if (!_memoryManager?.factStore) return '记忆系统未就绪';
    const store = _memoryManager.factStore;

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

    store.addFact?.(content.trim(), tags)
      || store.add?.({ fact: content.trim(), tags });

    if (conflicts.length) {
      const conflictList = conflicts.map(c => `  · ${c}`).join('\n');
      return `⚠️ 检测到与旧记忆冲突:\n${conflictList}\n\n已保存新记忆: ${content.slice(0, 80)}。建议告知用户此冲突。`;
    }
    return `已记住: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`;
  },
};

// ═══════════════════════════════════════
// Tool 2: recall — 搜索全部记忆层
// ═══════════════════════════════════════
export const recall = {
  name: 'recall',
  description: `搜索用户的记忆库。可以查询用户说过的话、偏好、经历等。用于回答"你记得我..."类问题。
参数 query: 搜索关键词`,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词或问题' },
    },
    required: ['query'],
  },
  async invoke({ query }) {
    if (!query?.trim()) return '搜索关键词不能为空';
    if (!_memoryManager) return '记忆系统未就绪';

    const store = _memoryManager.factStore;
    const allResults = [];
    const maxResults = 5;

    // 1. 长期事实 — 向量搜索优先，降级 LIKE
    if (store) {
      try {
        let facts;
        if (typeof store.vectorSearch === 'function') {
          facts = await store.vectorSearch(query, maxResults);
        } else if (typeof store.search === 'function') {
          facts = store.search(query, maxResults);
        }
        for (const f of (facts || [])) {
          const text = f.fact || f.text || f.content || '';
          if (text && f.source !== 'system') {
            allResults.push({
              text,
              tags: f.tags || [],
              score: f.score || f._score || 5,
              source: f.source || 'keyword',
              layer: '长期记忆',
            });
          }
        }
      } catch (e) { log.warn('事实搜索失败', e?.message || e); }
    }

    // 2. 情景记忆 — 倒排索引搜索 (from episodic.js)
    try {
      const eps = searchEpisodesByIndex(query, null, maxResults);
      for (const ep of eps) {
        allResults.push({
          text: ep.content?.keyQuote || ep.text || '',
          date: _fmtDate(ep.timestamp),
          score: ep._score || ep.importance || 3,
          topic: ep.content?.topic || '',
          layer: '情景记忆',
        });
      }
    } catch (e) { log.warn('情景搜索失败', e?.message || e); }

    // 3. 中期摘要 — 关键词匹配 (from medium-term.js)
    try {
      const sums = searchByTopic(query);
      for (const s of (sums || []).slice(0, 3)) {
        allResults.push({
          text: s.summary || '',
          date: s.date || '',
          score: s._score || 3,
          layer: '中期摘要',
          turnCount: s.turnCount,
        });
      }
    } catch (e) { log.warn('摘要搜索失败', e?.message || e); }

    // 4. 知识图谱
    try {
      const kgResults = searchKG(query);
      for (const r of (kgResults || []).slice(0, 2)) {
        allResults.push({ text: r.text || '', score: 6, layer: '知识图谱' });
      }
    } catch (e) { log.warn('知识图谱搜索失败', e?.message || e); }

    if (!allResults.length) return `未找到关于 "${query}" 的记忆`;

    // 排序、去重、截取 top 5
    const seen = new Set();
    const sorted = allResults
      .filter(r => {
        const key = (r.text || '').slice(0, 40);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (b.score || 5) - (a.score || 5))
      .slice(0, maxResults);

    return sorted.map((r, i) => {
      const date = r.date ? ` (${r.date})` : '';
      const layerTag = r.layer ? ` · ${r.layer}` : '';
      const extra = r.turnCount ? ` [${r.turnCount}轮]` : '';
      return `${i + 1}. ${r.text}${date}${extra}${layerTag}`;
    }).join('\n');
  },
};

// ═══════════════════════════════════════
// Tool 3: memory_status — 记忆状态概览
// ═══════════════════════════════════════
export const memoryStatus = {
  name: 'memory_status',
  description: '查看记忆库状态：各层记忆数量、日期范围、健康度。用户问"你记得我什么"或"还记得多少关于我的事"时使用。',
  parameters: { type: 'object', properties: {}, required: [] },
  async invoke() {
    if (!_memoryManager) return '记忆系统未就绪';
    const store = _memoryManager.factStore;
    const parts = [];

    // 长期事实
    try {
      const count = typeof store?.count === 'function' ? store.count() : (store?.getAll?.()?.length || 0);
      parts.push(`长期记忆: ${count} 条`);
    } catch { parts.push('长期记忆: 不可用'); }

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
      const sd = _summariesDir();
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
      const idxPath = path.join(os.homedir(), '.ai-desktop-pet', 'memory', 'episode_index.json');
      if (fs.existsSync(idxPath)) {
        const idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
        parts.push(`情景索引: ${Object.keys(idx).length} 关键词`);
      } else { parts.push('情景索引: 未构建'); }
    } catch { parts.push('情景索引: 不可用'); }

    // 热门标签
    try {
      const all = store?.getAll?.() || [];
      const tagCount = {};
      for (const f of all) {
        for (const t of (f.tags || [])) {
          tagCount[t] = (tagCount[t] || 0) + 1;
        }
      }
      const topTags = Object.entries(tagCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([t, c]) => `#${t}(${c})`)
        .join(' ');
      if (topTags) parts.push(`热门标签: ${topTags}`);
    } catch { /* 静默跳过 */ }

    const totalFacts = typeof store?.count === 'function' ? store.count() : (store?.getAll?.()?.length || 0);
    const health = totalFacts > 100
      ? '记忆数量较多，建议定期清理'
      : totalFacts < 3
        ? '记忆较少，多互动可以让我更懂你'
        : '记忆数量适中';

    return `📊 记忆系统状态\n${parts.map(p => `  · ${p}`).join('\n')}\n  · ${health}`;
  },
};

// ═══════════════════════════════════════
// Tool 4: forget — 软删除一条记忆
// ═══════════════════════════════════════
export const forget = {
  name: 'forget',
  description: '删除用户指定的一条记忆。需用户明确确认后才执行。参数 content: 要删除的记忆内容关键词',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要删除的记忆关键词' },
    },
    required: ['content'],
  },
  async invoke({ content }) {
    if (!content?.trim()) return '请提供要忘记的记忆内容';
    if (!_memoryManager?.factStore) return '记忆系统未就绪';
    const store = _memoryManager.factStore;

    // 搜索匹配的记忆
    const all = store.getAll?.() || [];
    const matches = all.filter(f => {
      const text = (f.fact || f.text || f.content || '').toLowerCase();
      return text.includes(content.trim().toLowerCase());
    });

    if (!matches.length) return `未找到关于 "${content}" 的记忆`;

    if (matches.length > 1) {
      // 多条匹配，列出让用户指定
      const list = matches.slice(0, 5).map((m, i) =>
        `${i + 1}. ${(m.fact || m.text || m.content || '').slice(0, 80)}`
      ).join('\n');
      return `找到 ${matches.length} 条匹配记忆:\n${list}\n\n请指定要删除哪一条的具体内容。`;
    }

    // 精确一条：软删除
    const target = matches[0];
    const targetText = target.fact || target.text || target.content || '';
    const ok = typeof store.softDelete === 'function'
      ? store.softDelete(targetText)
      : false;

    return ok
      ? `已遗忘: ${targetText.slice(0, 60)}`
      : `删除失败: 无法操作 "${targetText.slice(0, 60)}"`;
  },
};

// ═══════════════════════════════════════
// Tool 5: update_memory — 更新一条记忆
// ═══════════════════════════════════════
export const updateMemory = {
  name: 'update_memory',
  description: '更新用户的一条记忆。先用 recall 展示旧内容，用户确认后再用此工具更新。参数 oldContent: 旧记忆关键词, newContent: 新记忆内容',
  parameters: {
    type: 'object',
    properties: {
      oldContent: { type: 'string', description: '旧记忆的关键词' },
      newContent: { type: 'string', description: '新的记忆内容' },
    },
    required: ['oldContent', 'newContent'],
  },
  async invoke({ oldContent, newContent }) {
    if (!oldContent?.trim() || !newContent?.trim()) return '旧内容和新内容都不能为空';
    if (!_memoryManager?.factStore) return '记忆系统未就绪';
    const store = _memoryManager.factStore;

    // 搜索旧记忆
    const all = store.getAll?.() || [];
    const matches = all.filter(f => {
      const text = (f.fact || f.text || f.content || '').toLowerCase();
      return text.includes(oldContent.trim().toLowerCase());
    });

    if (!matches.length) return `未找到匹配 "${oldContent}" 的记忆。请先用 recall 确认旧记忆内容。`;

    if (matches.length > 1) {
      const list = matches.slice(0, 5).map((m, i) =>
        `${i + 1}. ${(m.fact || m.text || m.content || '').slice(0, 80)}`
      ).join('\n');
      return `找到 ${matches.length} 条匹配记忆:\n${list}\n\n请指定要更新哪一条的具体内容。`;
    }

    // 软删除旧记忆 + 添加新记忆
    const target = matches[0];
    const targetText = target.fact || target.text || target.content || '';
    if (typeof store.softDelete === 'function') {
      store.softDelete(targetText);
    }

    // 添加新记忆，标记来源
    (typeof store.addFact === 'function'
      ? store.addFact(newContent.trim(), [], { source: 'user_corrected' })
      : store.add?.({ fact: newContent.trim(), tags: [], source: 'user_corrected' }));

    return `已更新:\n  旧: ${targetText.slice(0, 60)}\n  新: ${newContent.slice(0, 80)}`;
  },
};

// ── 工具列表（便捷导入）──
export const memoryTools = [remember, recall, forget, updateMemory, memoryStatus];

/**
 * retrieval.js — Mixed retrieval scheduler
 *
 * Queries all four memory layers in parallel with graceful degradation.
 * Each layer has a 3s timeout; failures are skipped silently.
 * 支持向量语义搜索 (bge-micro-v2)，降级到 LIKE 搜索。
 */

import { ShortTermMemory } from './short-term.js';
import * as mediumTerm from './medium-term.js';
import * as episodic from './episodic.js';
import { FactStoreEnhanced } from './fact-store-enhanced.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('mem:retrieval');

// ── Config ──
const LAYER_TIMEOUT_MS = 3000;

// ── Helpers ──

/** Run a fn with a timeout; return fallback on timeout or error. */
async function withTimeout(promise, ms, fallback = []) {
  let timer;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    const result = await Promise.race([promise, timed]);
    return result;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// ── MemoryRetrieval ──

export class MemoryRetrieval {
  constructor(opts = {}) {
    this.shortTerm = opts.shortTerm || new ShortTermMemory();
    this.factStore = opts.factStore || null;
    this._vectorSearch = null;
    this._vectorReady = false;
  }

  /** 懒加载向量搜索引擎 (bge-micro-v2) */
  async _initVector() {
    if (this._vectorReady) return;
    try {
      const { getVectorSearch } = await import('./vector-search.js');
      this._vectorSearch = getVectorSearch();
      await this._vectorSearch.init();
      // 将已有事实加入向量索引
      if (this._vectorSearch.useTransformer && this.factStore) {
        const all = this.factStore.getAll?.() || [];
        for (const f of all) {
          const text = typeof f === 'string' ? f : (f.fact || f.content || '');
          if (text) await this._vectorSearch.addDocument(text, text);
        }
      }
      this._vectorReady = true;
      log.log(`向量搜索: ${this._vectorSearch.useTransformer ? 'bge-micro-v2' : 'TF-IDF 降级'}`);
    } catch (err) {
      log.warn(`向量搜索初始化失败: ${err.message}`);
      this._vectorReady = true; // 标记为已尝试，不再重试
    }
  }

  /**
   * Retrieve context from all four memory layers for a session.
   *
   * @param {Object} session — { sessionId, userId, ... }
   * @param {string} query — the user's current input / query
   * @param {Object} [opts] — { maxTurns?, maxSummaries?, maxEpisodes?, maxFacts? }
   * @returns {Promise<{
   *   shortTerm: Array,
   *   mediumSummaries: Array,
   *   episodes: Array,
   *   facts: Array,
   * }>}
   */
  async retrieve(session, query = '', opts = {}) {
    const historyLen = this.shortTerm.size;
    // 动态调整：对话越长，减少历史摘要/情景的数量，优先保留近期对话和事实
    const maxTurns = opts.maxTurns ?? 20;
    const maxSummaries = historyLen > 15 ? 1 : historyLen > 10 ? 2 : 3;
    const maxEpisodes = historyLen > 15 ? 1 : historyLen > 10 ? 2 : 3;
    const maxFacts = opts.maxFacts ?? 5;

    // Short-term: always returns everything
    const shortTerm = this.shortTerm.getAll().slice(-maxTurns);

    // 并行初始化向量搜索（非阻塞）
    this._initVector().catch(() => {});

    // Run medium/episodic/fact in parallel
    const [mediumRaw, episodesRaw, factsRaw] = await Promise.all([
      withTimeout(
        Promise.resolve().then(() => {
          const summaries = mediumTerm.searchByTopic(query);
          return summaries.map(s => s.summary).filter(Boolean);
        }),
        LAYER_TIMEOUT_MS
      ),
      withTimeout(Promise.resolve(episodic.searchEpisodes({ query, minImportance: 3 })), LAYER_TIMEOUT_MS),
      withTimeout(
        this.factStore
          ? Promise.resolve().then(async () => {
              const high = this.factStore.getHighImportance?.(0.7) || [];
              let search = this.factStore.search(query, maxFacts);

              // 向量语义搜索补充 (如果可用)
              if (this._vectorSearch?.useTransformer && query?.trim()) {
                try {
                  const vecResults = await this._vectorSearch.searchInFacts(
                    this.factStore.getAll?.() || [],
                    query,
                    maxFacts
                  );
                  // 合并: 向量结果 (高相关性) + LIKE 结果 (去重)
                  const seen = new Set(high.map(h => h.fact).concat(search.map(s => s.fact)));
                  for (const vr of vecResults) {
                    if (!seen.has(vr.text) && seen.size < maxFacts + high.length) {
                      search.push({ fact: vr.text, tags: [], score: vr.score, source: 'vector' });
                      seen.add(vr.text);
                    }
                  }
                } catch { /* 向量搜索失败，静默降级 */ }
              }

              // 优先返回高重要性的，其次搜索匹配的
              return [...high, ...search.filter(f => !high.some(h => h.fact === f.fact))];
            })
          : Promise.resolve([]),
        LAYER_TIMEOUT_MS
      ),
    ]);

    // Medium-term: already keyword-filtered by searchByTopic
    const mediumSummaries = (mediumRaw || []).slice(0, maxSummaries);

    // Episodic: 已加权排序（_score = importance × 时间衰减 × 情绪/话题加权）
    const episodes = (episodesRaw || [])
      .sort((a, b) => (b._score || b.importance || 0) - (a._score || a.importance || 0))
      .slice(0, maxEpisodes);

    return { shortTerm, mediumSummaries, episodes, facts: factsRaw || [] };
  }

  /**
   * Format retrieved context as a string for injection into LLM system prompt.
   * @param {Object} result — the return value of retrieve()
   * @returns {string}
   */
  formatForLLM(result) {
    const parts = [];

    // Short-term (conversation history)
    if (result.shortTerm?.length) {
      parts.push('## 最近对话');
      for (const turn of result.shortTerm) {
        const role = turn.role === 'user' ? '用户' : '宠物';
        parts.push(`- **${role}**: ${turn.text || turn.content || ''}`);
      }
    }

    // Medium-term summaries
    if (result.mediumSummaries?.length) {
      parts.push('\n## 对话摘要');
      for (const s of result.mediumSummaries) {
        parts.push(`- ${s.summary || s.text || ''}`);
      }
    }

    // Episodes
    if (result.episodes?.length) {
      parts.push('\n## 相关记忆');
      for (const e of result.episodes) {
        parts.push(`- ${e.text || e.content || e.title || ''}`);
      }
    }

    // Facts
    if (result.facts?.length) {
      parts.push('\n## 已知信息');
      for (const f of result.facts) {
        const factText = f.fact || f.text || f.content || JSON.stringify(f);
        parts.push(`- ${factText}`);
      }
    }

    return parts.join('\n');
  }
}

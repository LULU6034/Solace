/**
 * kb-bm25.js — 增量 BM25 全文检索索引
 *
 * 纯 JavaScript 实现，零依赖。支持增量添加、删除、更新文档，
 * 以及基于 BM25 算法的全文检索。适用于知识库的稀疏检索层，
 * 可与向量检索 (kb-vector.js) 结合使用实现混合检索。
 *
 * 设计要点：
 *   - 倒排索引: term → { df, postings: docId → tf }
 *   - 正排索引: docId → Map<term, tf>，用于 O(|doc|) 高效删除
 *   - 文档长度单独存储，avgdl 实时计算
 *   - 搜索时对每个唯一查询词项累加 BM25 得分
 *   - toJSON/fromJSON 使用纯对象格式，支持文件持久化
 */

import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('kb-bm25');

// ── IncrementalBM25 ──

export class IncrementalBM25 {
  /**
   * @param {object} [opts]
   * @param {number} [opts.k1=1.5]  TF 饱和参数，控制词频对评分的影响
   * @param {number} [opts.b=0.75]  文档长度归一化参数 (0 = 无归一化, 1 = 完全归一化)
   */
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;

    /** @type {Map<string, { df: number, postings: Map<string, number> }>} 倒排索引 */
    this._index = new Map();

    /** @type {Map<string, Map<string, number>>} 正排索引: docId → (term → tf) */
    this._docTfs = new Map();

    /** @type {Map<string, number>} docId → 文档长度 */
    this._docLengths = new Map();

    /** @type {number} 所有文档长度总和 */
    this._totalDocLength = 0;
  }

  // ── 计数 ──

  /** @returns {number} 文档总数 */
  get docCount() {
    return this._docLengths.size;
  }

  /** @returns {number} 平均文档长度（无文档时返回 0） */
  get avgdl() {
    const n = this.docCount;
    return n === 0 ? 0 : this._totalDocLength / n;
  }

  // ── 增 ──

  /**
   * 添加一篇文档。
   * 若 docId 已存在则先移除再添加（等价于 updateDocument）。
   *
   * @param {string}   docId  文档唯一标识
   * @param {string[]} tokens 预分词后的词项数组
   */
  addDocument(docId, tokens) {
    if (typeof docId !== 'string') {
      throw new TypeError('IncrementalBM25.addDocument: docId 必须是 string');
    }
    if (!Array.isArray(tokens)) {
      throw new TypeError('IncrementalBM25.addDocument: tokens 必须是数组');
    }

    // 若已存在，先移除旧数据
    if (this._docLengths.has(docId)) {
      this._removeDocumentInternal(docId);
    }

    const len = tokens.length;
    if (len === 0) {
      // 无词项文档：记录长度为 0，不参与倒排索引
      this._docLengths.set(docId, 0);
      return;
    }

    // 统计词频，构建正排索引
    /** @type {Map<string, number>} term → tf */
    const tfMap = new Map();
    for (const term of tokens) {
      tfMap.set(term, (tfMap.get(term) || 0) + 1);
    }
    this._docTfs.set(docId, tfMap);

    // 更新倒排索引
    for (const [term, tf] of tfMap) {
      let entry = this._index.get(term);
      if (!entry) {
        entry = { df: 0, postings: new Map() };
        this._index.set(term, entry);
      }
      entry.df += 1;
      entry.postings.set(docId, tf);
    }

    // 记录文档长度
    this._docLengths.set(docId, len);
    this._totalDocLength += len;
  }

  // ── 删 ──

  /**
   * 移除一篇文档。
   *
   * @param {string} docId
   * @returns {boolean} 是否成功移除（docId 不存在时返回 false）
   */
  removeDocument(docId) {
    if (!this._docLengths.has(docId)) return false;
    this._removeDocumentInternal(docId);
    return true;
  }

  /**
   * 内部删除：不检查 docId 是否存在的快速路径。
   * 调用方需确保 docId 存在于 this._docLengths 中。
   *
   * @param {string} docId
   */
  _removeDocumentInternal(docId) {
    const len = this._docLengths.get(docId);

    // 通过正排索引获取该文档的全部词项，更新倒排索引
    const tfMap = this._docTfs.get(docId);
    if (tfMap) {
      for (const term of tfMap.keys()) {
        const entry = this._index.get(term);
        if (entry) {
          entry.postings.delete(docId);
          entry.df -= 1;
          // 若该词项不再被任何文档引用，从索引中移除
          if (entry.df === 0) {
            this._index.delete(term);
          }
        }
      }
      this._docTfs.delete(docId);
    }

    this._docLengths.delete(docId);
    this._totalDocLength -= len;
  }

  // ── 改 ──

  /**
   * 更新一篇文档（等价于 remove + add）。
   *
   * @param {string}   docId
   * @param {string[]} tokens 预分词后的新词项数组
   */
  updateDocument(docId, tokens) {
    this.removeDocument(docId);
    this.addDocument(docId, tokens);
  }

  // ── 查 ──

  /**
   * BM25 全文检索。
   *
   * 对每个唯一查询词项在倒排索引中查找匹配的文档，
   * 累加每个文档的 BM25 得分，最后按得分降序返回 top-k。
   *
   * BM25 公式：
   *   IDF(term) = ln((N - df + 0.5) / (df + 0.5) + 1)
   *   TF(doc, term) = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgdl))
   *   score(doc) = Σ IDF(term) * TF(doc, term)
   *
   * @param {string[]} queryTokens 预分词的查询词项数组
   * @param {number}   [k=30]      返回的最大结果数
   * @returns {Array<{ docId: string, score: number }>} 按 score 降序排列
   */
  search(queryTokens, k = 30) {
    if (!Array.isArray(queryTokens)) {
      throw new TypeError('IncrementalBM25.search: queryTokens 必须是数组');
    }
    if (this.docCount === 0) return [];

    const N = this.docCount;
    const avgdl = this.avgdl;
    const { k1, b } = this;

    // 去重查询词项
    const uniqueTerms = [...new Set(queryTokens)];

    /** @type {Map<string, number>} docId → 累加得分 */
    const scores = new Map();

    for (const term of uniqueTerms) {
      const entry = this._index.get(term);
      if (!entry) continue;

      const { df, postings } = entry;

      // IDF（Robertson–Spärck Jones 平滑）
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      if (idf <= 0) continue;

      // 对该词项的所有匹配文档累加得分
      for (const [docId, tf] of postings) {
        const docLen = this._docLengths.get(docId) || 0;

        // TF 归一化
        const tfNorm =
          (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgdl));

        const termScore = idf * tfNorm;
        scores.set(docId, (scores.get(docId) || 0) + termScore);
      }
    }

    // 排序 → 取 top-k
    const results = [];
    for (const [docId, score] of scores) {
      results.push({ docId, score });
    }
    results.sort((a, b) => b.score - a.score);

    const top = results.slice(0, k);
    log.debug(`BM25 搜索完成: ${results.length} 条候选, 返回 top-${top.length}`);
    return top;
  }

  // ── 维护 ──

  /**
   * 刷新内部状态以防止浮点漂移。
   *
   * 随着大量增量添加/删除，_totalDocLength 可能因浮点舍入误差
   * 而逐渐偏离真实值，进而影响 avgdl 和 BM25 排序精度。
   * 此方法从 _docLengths 重新计算 _totalDocLength，重置漂移。
   */
  flush() {
    let sum = 0;
    for (const len of this._docLengths.values()) {
      sum += len;
    }
    this._totalDocLength = sum;
    log.debug(`flush: _totalDocLength 已重算为 ${sum}`);
  }

  // ── 序列化 ──

  /**
   * 序列化为纯 JSON 对象，用于文件持久化。
   * 所有 Map 转换为普通对象，确保 JSON.stringify 可直接处理。
   *
   * @returns {object}
   */
  toJSON() {
    // 倒排索引: Map → 普通对象
    const index = {};
    for (const [term, entry] of this._index) {
      const postings = {};
      for (const [docId, tf] of entry.postings) {
        postings[docId] = tf;
      }
      index[term] = { df: entry.df, postings };
    }

    // 正排索引: Map<docId, Map<term, tf>> → 普通对象
    const docTfs = {};
    for (const [docId, tfMap] of this._docTfs) {
      docTfs[docId] = Object.fromEntries(tfMap);
    }

    // 文档长度: Map → 普通对象
    const docLengths = Object.fromEntries(this._docLengths);

    return {
      k1: this.k1,
      b: this.b,
      index,
      docTfs,
      docLengths,
      totalDocLength: this._totalDocLength,
    };
  }

  /**
   * 从 JSON 对象反序列化，恢复索引状态。
   *
   * @param {object} json - 由 toJSON() 生成的对象
   * @returns {IncrementalBM25}
   * @throws {TypeError} 传入非对象时抛出
   */
  static fromJSON(json) {
    if (!json || typeof json !== 'object') {
      throw new TypeError('IncrementalBM25.fromJSON: json 必须是对象');
    }

    const {
      k1 = 1.5,
      b = 0.75,
      index = {},
      docTfs = {},
      docLengths = {},
      totalDocLength = 0,
    } = json;

    const instance = new IncrementalBM25({ k1, b });

    // 恢复倒排索引
    for (const [term, entry] of Object.entries(index)) {
      const postings = new Map();
      if (entry.postings && typeof entry.postings === 'object') {
        for (const [docId, tf] of Object.entries(entry.postings)) {
          if (typeof tf === 'number') {
            postings.set(docId, tf);
          }
        }
      }
      instance._index.set(term, { df: entry.df || 0, postings });
    }

    // 恢复正排索引
    for (const [docId, tfObj] of Object.entries(docTfs)) {
      if (tfObj && typeof tfObj === 'object') {
        const tfMap = new Map();
        for (const [term, tf] of Object.entries(tfObj)) {
          if (typeof tf === 'number') {
            tfMap.set(term, tf);
          }
        }
        if (tfMap.size > 0) {
          instance._docTfs.set(docId, tfMap);
        }
      }
    }

    // 恢复文档长度
    for (const [docId, len] of Object.entries(docLengths)) {
      if (typeof len === 'number') {
        instance._docLengths.set(docId, len);
      }
    }

    instance._totalDocLength = typeof totalDocLength === 'number' ? totalDocLength : 0;

    log.log(
      `fromJSON: 已恢复 ${instance.docCount} 篇文档, ${instance._index.size} 个词项`,
    );
    return instance;
  }
}

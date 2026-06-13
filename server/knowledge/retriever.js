/**
 * kb-retriever.js — 混合检索引擎
 *
 * 结合 BM25 稀疏检索 + 向量稠密检索，使用 RRF (Reciprocal Rank Fusion)
 * 融合两种结果，提供比单一检索方式更准确的知识库搜索结果。
 *
 * 设计要点：
 *   - 依赖注入：BM25、向量存储、嵌入器、缓存均通过构造函数注入
 *   - RRF 融合：1 / (k + rank) 公式，k 可配置（默认 60）
 *   - 分词：CJK 字符 bigram + unigram，英文按词边界分割，停用词过滤
 *   - 缓存：可选的 KBCache 实例，TTL 默认 3600 秒
 *   - 并行：BM25 和向量搜索通过 Promise.all 同时进行
 *   - search 返回统一格式，包含各检索器的原始排名和得分
 */

import { IncrementalBM25 } from './bm25.js';
import { KBVectorStore } from './vector.js';
import { KBEmbedder } from './embedder.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('kb-retriever');

// ── 停用词表 ──

const STOP_WORDS = new Set([
  '的', '是', '在', '和', '了', '有', '也', '不', '这', '那', '就',
  '都', '要', '会', '可以', '能', '对', '把', '被', '让', '从',
  '到', '与', '或', '但', '而', '如果', '因为', '所以', '虽然',
  '一个', '什么', '没有', '这个', '那个',
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '它们',
  '哪', '怎么', '为什么', '如何',
]);

// ── CJK Unicode 范围 ──

/** CJK 统一表意文字: 一 (U+4E00) – 鿿 (U+9FFF)，以及扩展 A: 㐀 (U+3400) – 䶿 (U+4DBF) */
const CJK_RE = /[一-鿿㐀-䶿]/;

/** 非英文小写字母、非数字、非 CJK 的连续字符 —— 用于英文分词分割 */
const NON_TOKEN_RE = /[^a-z0-9一-鿿㐀-䶿]+/;

// ── HybridRetriever ──

export class HybridRetriever {
  /**
   * @param {object} [opts]
   * @param {IncrementalBM25} [opts.bm25]        - BM25 检索器实例，未提供则惰性创建
   * @param {KBVectorStore}  [opts.vectorStore]  - 向量存储实例，未提供则惰性创建
   * @param {KBEmbedder}     [opts.embedder]     - 嵌入模型实例，未提供则惰性创建
   * @param {import('./kb-cache.js').KBCache|null} [opts.cache=null] - 缓存实例（可选，默认无缓存）
   * @param {number}         [opts.fusionK=60]   - RRF 融合参数 k
   */
  constructor({ bm25, vectorStore, embedder, cache = null, fusionK = 60 } = {}) {
    this._bm25 = bm25 || new IncrementalBM25();
    this._vectorStore = vectorStore || new KBVectorStore();
    this._embedder = embedder || new KBEmbedder();
    this._cache = cache || null;
    this._fusionK = fusionK;
    // BM25 写入计数器：达到阈值时自动 flush 防止浮点漂移
    this._bm25WriteCount = 0;
  }

  // ── 搜索 ──

  /**
   * 混合检索：BM25 + 向量搜索 + RRF 融合。
   *
   * 流程：
   *   1. 检查缓存，命中则直接返回缓存结果
   *   2. 对查询文本分词（供 BM25 使用）
   *   3. 获取查询文本的向量嵌入（供向量搜索使用）
   *   4. 并行执行 BM25 和向量搜索，各取 top-30
   *   5. RRF 融合两个结果集的排名
   *   6. 按融合得分降序排列，取 topK
   *   7. 若启用缓存，将结果写入缓存
   *
   * @param {string}  query             - 原始查询文本
   * @param {object}  [opts]
   * @param {number}  [opts.topK=10]    - 返回的最大结果数
   * @param {boolean} [opts.rerank=false] - 是否启用二次排序（预留）
   * @returns {Promise<Array<{
   *   id: string,
   *   score: number,
   *   sources: { bm25_rank: number|null, bm25_score: number|null,
   *              vector_rank: number|null, vector_score: number|null }
   * }>>}
   */
  async search(query, { topK = 10, rerank = false } = {}) {
    // 1. 检查缓存
    if (this._cache) {
      const cached = this._cache.get(query);
      if (cached) {
        log.debug(`缓存命中: "${query}"`);
        return cached;
      }
    }

    // 2. 分词
    const tokens = this._tokenize(query);

    // 3. 获取查询向量
    const queryEmbedding = await this._embedder.embed(query);

    // 4. 并行检索：BM25 + 向量搜索，各取 top-30
    const [bm25Results, vectorResults] = await Promise.all([
      this._bm25.search(tokens, 30),
      this._vectorStore.search(queryEmbedding, 30),
    ]);

    // 5. RRF 融合
    const fused = this._rrfFusion(bm25Results, vectorResults, this._fusionK);

    // 6. 按融合得分降序排列，取 topK
    const top = fused.slice(0, topK);

    log.debug(
      `混合检索完成: BM25 ${bm25Results.length} 条 + 向量 ${vectorResults.length} 条 → 融合 ${fused.length} 条，返回 top-${top.length}`,
    );

    // 7. 缓存结果
    if (this._cache) {
      this._cache.set(query, top);
    }

    return top;
  }

  // ── 索引管理 ──

  /**
   * 索引单个知识块：分词 + 嵌入 + 同时加入 BM25 和向量索引。
   *
   * @param {string} chunkId - 块唯一标识
   * @param {string} content - 块文本内容
   */
  async indexChunk(chunkId, content) {
    const tokens = this._tokenize(content);
    const embedding = await this._embedder.embed(content);

    this._bm25.addDocument(chunkId, tokens);
    await this._vectorStore.add(chunkId, embedding);

    // 每 100 次写入自动 flush BM25，防止 _totalDocLength 浮点漂移
    this._bm25WriteCount++;
    if (this._bm25WriteCount >= 100) {
      this._bm25.flush();
      this._bm25WriteCount = 0;
      log.debug('BM25 自动 flush（累计 100 次写入）');
    }

    log.debug(`已索引块: ${chunkId}`);
  }

  /**
   * 从两个索引中移除指定知识块。
   *
   * @param {string} chunkId - 块唯一标识
   * @returns {Promise<boolean>} 是否在任一索引中成功移除
   */
  async removeChunk(chunkId) {
    const bm25Removed = this._bm25.removeDocument(chunkId);
    const vectorRemoved = await this._vectorStore.remove(chunkId);

    if (bm25Removed || vectorRemoved) {
      log.debug(`已移除块: ${chunkId}`);
    }
    return bm25Removed || vectorRemoved;
  }

  /**
   * 重建 BM25 索引（重新创建 IncrementalBM25 实例，清空全部文档）。
   */
  async rebuildBM25() {
    const count = this._bm25.docCount;
    this._bm25 = new IncrementalBM25();
    log.log(`BM25 索引已重建，此前 ${count} 篇文档`);
  }

  // ── 内部分词 ──

  /**
   * 对文本做分词处理。
   *
   * - CJK 字符（范围 一-鿿 / 㐀-䶿）：提取字符 bigram（相邻 CJK 字符对）
   *   和 unigram（单字符）
   * - 英文/数字：转小写后按 /[^a-z0-9一-鿿㐀-䶿]+/ 分割
   * - 过滤停用词
   * - 返回去重后的词项数组
   *
   * @param {string} text - 原始文本
   * @returns {string[]} 去重后的词项数组
   */
  _tokenize(text) {
    if (!text || typeof text !== 'string') return [];

    const lower = text.toLowerCase();
    const tokens = [];

    // 逐字符处理：CJK 字符拆为 bigram+unigram，非 CJK 字符累积为英文单词
    let englishBuf = '';

    for (let i = 0; i < lower.length; i++) {
      const ch = lower[i];

      if (CJK_RE.test(ch)) {
        // 先提交累积的英文缓冲区
        if (englishBuf.length > 0) {
          _splitAndAdd(englishBuf, tokens);
          englishBuf = '';
        }

        // 添加 unigram（单 CJK 字符）
        tokens.push(ch);

        // 添加 bigram（当前字符与前一个 CJK 字符组成的对）
        if (i > 0) {
          const prev = lower[i - 1];
          if (CJK_RE.test(prev)) {
            tokens.push(prev + ch);
          }
        }
      } else {
        // 非 CJK 字符：累积到英文缓冲区
        englishBuf += ch;
      }
    }

    // 提交剩余的英文缓冲区
    if (englishBuf.length > 0) {
      _splitAndAdd(englishBuf, tokens);
    }

    // 去重 + 过滤停用词
    const seen = new Set();
    const result = [];
    for (const token of tokens) {
      if (STOP_WORDS.has(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      result.push(token);
    }

    return result;
  }

  // ── RRF 融合 ──

  /**
   * Reciprocal Rank Fusion (RRF)。
   *
   * 对每个唯一文档 ID，累加其在各检索器中的 RRF 得分：
   *   score(d) = Σ_i 1 / (k + rank_i(d))
   *
   * 其中 rank_i(d) 是文档 d 在第 i 个检索器结果列表中的排名（1-indexed，
   * 第一个结果为 rank=1）。未出现在某检索器结果中的文档不参与该项求和。
   *
   * 注意：BM25 结果使用 docId 字段，向量结果使用 id 字段，此处统一处理
   * 并规范化输出为 id 字段。
   *
   * @param {Array<{ docId: string, score: number }>} bm25Results  - BM25 搜索结果
   * @param {Array<{ id: string, score: number }>}    vectorResults - 向量搜索结果
   * @param {number} k - RRF 平滑参数
   * @returns {Array<{ id: string, score: number, sources: object }>} 按融合得分降序排列
   */
  _rrfFusion(bm25Results, vectorResults, k) {
    /** @type {Map<string, { id: string, score: number, sources: object }>} */
    const docMap = new Map();

    // 处理 BM25 结果（字段名为 docId）
    for (let i = 0; i < bm25Results.length; i++) {
      const { docId, score } = bm25Results[i];
      const rank = i + 1;
      const rrfScore = 1 / (k + rank);

      let entry = docMap.get(docId);
      if (!entry) {
        entry = {
          id: docId,
          score: 0,
          sources: {
            bm25_rank: null,
            bm25_score: null,
            vector_rank: null,
            vector_score: null,
          },
        };
        docMap.set(docId, entry);
      }

      entry.score += rrfScore;
      entry.sources.bm25_rank = rank;
      entry.sources.bm25_score = score;
    }

    // 处理向量结果（字段名为 id）
    for (let i = 0; i < vectorResults.length; i++) {
      const { id, score } = vectorResults[i];
      const rank = i + 1;
      const rrfScore = 1 / (k + rank);

      let entry = docMap.get(id);
      if (!entry) {
        entry = {
          id,
          score: 0,
          sources: {
            bm25_rank: null,
            bm25_score: null,
            vector_rank: null,
            vector_score: null,
          },
        };
        docMap.set(id, entry);
      }

      entry.score += rrfScore;
      entry.sources.vector_rank = rank;
      entry.sources.vector_score = score;
    }

    // 按融合得分降序排列
    return [...docMap.values()].sort((a, b) => b.score - a.score);
  }
}

// ── 内部分词辅助函数 ──

/**
 * 按非字母/非 CJK 字符分割字符串，并将非空片段追加到 tokens 数组。
 *
 * @param {string}   buf    - 待分割的英文缓冲区
 * @param {string[]} tokens - 目标词项数组
 */
function _splitAndAdd(buf, tokens) {
  const parts = buf.split(NON_TOKEN_RE);
  for (const part of parts) {
    if (part.length > 0) {
      tokens.push(part);
    }
  }
}

/**
 * kb-vector.js — 知识库向量存储
 *
 * 基于内存 + JSON 文件持久化的轻量向量存储。
 * 条目数 < 5000 时使用暴力余弦相似度搜索。
 * 条目数 >= 5000 时自动启用 bucketing 优化：
 *   按前 3 个维度的符号将条目分入 8 (2^3) 个桶，
 *   搜索时只搜匹配桶 + 1 个相邻桶，约 3-4x 加速。
 *
 * 设计要点：
 *   - 嵌入向量以 number[] 形式存储在内存中（JSON 可序列化）
 *   - add/search 时在 number[] 和 Float32Array 之间转换
 *   - add 时预计算 ||embedding||，避免搜索时重复计算
 *   - 幂等操作：重复 add 同一 id 会覆盖
 *   - save/load 使用 JSON 格式，path 可配置
 *
 * 存储格式 (vectors.json)：
 *   {
 *     "version": 1,
 *     "dim": 384,
 *     "engine": "bge-micro-v2",
 *     "count": N,
 *     "threshold": 5000,
 *     "entries": {
 *       "id1": { "v": [0.012, -0.034, ...], "n": 1.0 },
 *       ...
 *     }
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('kb-vector');

// ── 默认路径 ──

/**
 * 获取向量文件的默认存储路径。
 * 目录不存在时自动创建。
 * @returns {string}
 */
function _defaultIndexPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = path.join(home, '.ai-desktop-pet', 'knowledge-base');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'vectors.json');
}

// ── KBVectorStore ──

export class KBVectorStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.dim=384]         向量维度
   * @param {string|null} [opts.indexPath=null] 持久化文件路径，null 则使用默认路径
   */
  constructor({ dim = 384, indexPath = null } = {}) {
    this._dim = dim;
    this._indexPath = indexPath || _defaultIndexPath();
    this._engine = 'bge-micro-v2';
    /** @type {Map<string, { embedding: number[], norm: number }>} */
    this._entries = new Map();
    this._threshold = 5000;
    this._warned = false;

    // Bucketing 优化 (count >= 5000 时自动启用)
    /** @type {Array<Array<{ id: string, embedding: number[], norm: number }>>} */
    this._buckets = null;
    this._bucketsBuilt = false;
  }

  // ── 计数 ──

  /** @returns {number} 当前条目数 */
  get count() {
    return this._entries.size;
  }

  // ── 增 ──

  /**
   * 添加单条向量。
   * 若 id 已存在则覆盖。
   * 输入 Float32Array 会转换为 number[] 存储，同时预计算 L2 范数。
   * @param {string} id              唯一标识
   * @param {Float32Array} embedding 向量（会被转为 number[] 存储）
   */
  async add(id, embedding) {
    if (!(embedding instanceof Float32Array)) {
      throw new TypeError('KBVectorStore.add: embedding 必须是 Float32Array');
    }
    if (embedding.length !== this._dim) {
      throw new Error(
        `KBVectorStore.add: 向量维度不匹配，期望 ${this._dim}，实际 ${embedding.length}`,
      );
    }

    // Float32Array → number[]
    const arr = Array.from(embedding);
    const norm = _l2NormArr(arr);
    this._entries.set(id, { embedding: arr, norm });
    this._bucketsBuilt = false;
  }

  /**
   * 批量添加向量。
   * @param {Array<{ id: string, embedding: Float32Array }>} entries
   */
  async addBatch(entries) {
    if (!Array.isArray(entries)) {
      throw new TypeError('KBVectorStore.addBatch: entries 必须是数组');
    }

    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string') {
        throw new TypeError('KBVectorStore.addBatch: 每个 entry 必须有 string 类型的 id');
      }
      const emb = entry.embedding;
      if (!(emb instanceof Float32Array)) {
        throw new TypeError(
          `KBVectorStore.addBatch: entry "${entry.id}" 的 embedding 必须是 Float32Array`,
        );
      }
      if (emb.length !== this._dim) {
        throw new Error(
          `KBVectorStore.addBatch: entry "${entry.id}" 向量维度不匹配，期望 ${this._dim}，实际 ${emb.length}`,
        );
      }

      // Float32Array → number[]
      const arr = Array.from(emb);
      const norm = _l2NormArr(arr);
      this._entries.set(entry.id, { embedding: arr, norm });
    }

    log.log(`批量添加 ${entries.length} 条向量，当前总数 ${this.count}`);
    this._bucketsBuilt = false;
  }

  // ── 删 ──

  /**
   * 删除一条向量。
   * @param {string} id
   * @returns {Promise<boolean>} 是否成功删除（id 不存在时返回 false）
   */
  async remove(id) {
    const deleted = this._entries.delete(id);
    if (deleted) this._bucketsBuilt = false;
    return deleted;
  }

  // ── 改 ──

  /**
   * 更新一条向量（等价于 remove + add）。
   * id 不存在时等同于 add。
   * @param {string} id
   * @param {Float32Array} embedding
   */
  async update(id, embedding) {
    await this.remove(id);
    await this.add(id, embedding);
  }

  // ── 查 ──

  /**
   * 余弦相似度搜索。
   *
   * 条目数 < threshold 时使用暴力搜索（精确）。
   * 条目数 >= threshold 时自动启用 bucketing 加速（近似，约 3-4x 加速）。
   *
   * @param {Float32Array} queryEmbedding 查询向量
   * @param {number} [topK=30]           返回的 top-K 数量
   * @returns {Promise<Array<{ id: string, score: number }>>} 按相似度降序排列
   */
  async search(queryEmbedding, topK = 30) {
    if (!(queryEmbedding instanceof Float32Array)) {
      throw new TypeError('KBVectorStore.search: queryEmbedding 必须是 Float32Array');
    }
    if (queryEmbedding.length !== this._dim) {
      throw new Error(
        `KBVectorStore.search: 查询向量维度不匹配，期望 ${this._dim}，实际 ${queryEmbedding.length}`,
      );
    }

    // 阈值警告
    if (this.count > this._threshold && !this._warned) {
      this._warned = true;
      log.warn(
        `向量存储条目数 (${this.count}) 已超过阈值 (${this._threshold})。` +
          '已启用 bucketing 加速搜索。',
      );
    }

    // 零向量检查
    const queryNorm = _l2Norm(queryEmbedding);
    if (queryNorm === 0) {
      log.warn('查询向量为零向量，返回空结果');
      return [];
    }

    // 按条目数选择搜索策略
    if (this.count > this._threshold) {
      // 自动构建/重建桶
      if (!this._bucketsBuilt) {
        this._rebuildBuckets();
      }
      return this._searchBucketed(queryEmbedding, topK, queryNorm);
    }

    // 暴力搜索（条目数少时精确高效）
    return this._searchBruteForce(queryEmbedding, topK, queryNorm);
  }

  /**
   * 暴力余弦搜索（原有逻辑，提取为独立方法供 fallback 使用）。
   *
   * @param {Float32Array} queryEmbedding
   * @param {number} topK
   * @param {number} queryNorm 预计算的查询向量 L2 范数
   * @returns {Array<{ id: string, score: number }>}
   */
  _searchBruteForce(queryEmbedding, topK, queryNorm) {
    const results = [];

    for (const [id, { embedding, norm }] of this._entries) {
      if (norm === 0) continue;

      const storedVec = new Float32Array(embedding);
      const dot = _dotProduct(queryEmbedding, storedVec);
      const score = dot / (queryNorm * norm);
      results.push({ id, score });
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, topK);

    log.debug(`搜索完成 (暴力): ${results.length} 条候选，返回 top-${top.length}`);
    return top;
  }

  // ── Bucketing 加速 ──

  /**
   * 计算条目所属的桶索引。
   * 使用前 3 个维度的符号位 → 0-7 (3 bit)。
   * dim < 3 时仅用可用维度填充。
   *
   * @param {number[]} embedding
   * @returns {number} 0-7
   */
  _getBucketIndex(embedding) {
    let idx = 0;
    const limit = Math.min(3, embedding.length);
    for (let i = 0; i < limit; i++) {
      if (embedding[i] >= 0) {
        idx |= (1 << i);
      }
    }
    // dim < 3 时剩余位保持 0，对分布影响可忽略
    return idx;
  }

  /**
   * 重建所有桶。
   * 遍历 _entries，按 _getBucketIndex 分入 8 个桶。
   * 桶内存储 { id, embedding, norm } 引用，避免数据拷贝。
   */
  _rebuildBuckets() {
    this._buckets = Array.from({ length: 8 }, () => []);

    for (const [id, { embedding, norm }] of this._entries) {
      const bucketIdx = this._getBucketIndex(embedding);
      this._buckets[bucketIdx].push({ id, embedding, norm });
    }

    this._bucketsBuilt = true;
    log.log(
      `Bucketing 已重建: ${this.count} 条 → 8 桶, ` +
        `分布: [${this._buckets.map((b) => b.length).join(', ')}]`,
    );
  }

  /**
   * Bucketing 加速搜索。
   *
   * 只搜索 query 所在的桶 + 1 个相邻桶（共最多 2 个桶），
   * 将候选项减少到约 1/4，带来约 3-4x 加速。
   * 相邻桶选择另一符号位取反的桶（flip bit 0），以覆盖符号边界噪声。
   *
   * @param {Float32Array} queryEmbedding
   * @param {number} topK
   * @param {number} queryNorm
   * @returns {Array<{ id: string, score: number }>}
   */
  _searchBucketed(queryEmbedding, topK, queryNorm) {
    const queryArr = Array.from(queryEmbedding);
    const primaryBucket = this._getBucketIndex(queryArr);
    // 相邻桶：翻转最低位，覆盖符号边界附近的向量
    const adjacentBucket = primaryBucket ^ 1;

    const candidateBuckets = [primaryBucket];
    if (adjacentBucket !== primaryBucket && adjacentBucket < 8) {
      candidateBuckets.push(adjacentBucket);
    }

    const results = [];
    const exactSearch = this._searchBruteForce.bind(this);

    for (const bucketIdx of candidateBuckets) {
      const bucket = this._buckets[bucketIdx];
      if (!bucket || bucket.length === 0) continue;

      for (const { id, embedding, norm } of bucket) {
        if (norm === 0) continue;

        const storedVec = new Float32Array(embedding);
        const dot = _dotProduct(queryEmbedding, storedVec);
        const score = dot / (queryNorm * norm);
        results.push({ id, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, topK);

    log.debug(
      `搜索完成 (bucketed): 桶 ${primaryBucket}(${this._buckets[primaryBucket]?.length || 0})` +
        ` + 相邻桶 ${adjacentBucket}(${this._buckets[adjacentBucket]?.length || 0})` +
        ` = ${results.length} 条候选, top-${top.length}`,
    );
    return top;
  }

  // ── 持久化 ──

  /**
   * 保存到磁盘。
   * 写入 JSON 文件，entries 格式为 { v: number[], n: number }。
   * 使用原子写入（先写 .tmp 再 rename）防止写入中断导致文件损坏。
   */
  async save() {
    const entries = {};
    for (const [id, { embedding, norm }] of this._entries) {
      entries[id] = { v: embedding, n: norm };
    }

    const data = {
      version: 1,
      dim: this._dim,
      engine: this._engine,
      count: this.count,
      threshold: this._threshold,
      entries,
    };

    const dir = path.dirname(this._indexPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 原子写入：先写临时文件再重命名
    const tmp = this._indexPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, this._indexPath);

    log.log(`已保存 ${this.count} 条向量到 ${this._indexPath}`);
  }

  /**
   * 从磁盘加载。
   * 支持旧格式（entries 值为裸数组）和新格式（{ v: [...], n: ... }）。
   * 旧格式会重新计算 norm。
   */
  async load() {
    if (!fs.existsSync(this._indexPath)) {
      log.log(`向量文件不存在，使用空 store: ${this._indexPath}`);
      return;
    }

    const raw = fs.readFileSync(this._indexPath, 'utf-8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      log.warn(`向量文件解析失败，使用空 store: ${err.message}`);
      return;
    }

    // 校验格式
    if (!data || typeof data !== 'object') {
      log.warn('向量文件格式无效，使用空 store');
      return;
    }

    this._dim = data.dim || this._dim;
    this._engine = data.engine || this._engine;
    this._threshold = data.threshold || this._threshold;

    const entries = data.entries;
    if (!entries || typeof entries !== 'object') {
      log.warn('向量文件中无 entries，使用空 store');
      return;
    }

    let loaded = 0;
    for (const [id, rawValue] of Object.entries(entries)) {
      // 支持新格式 { v: [...], n: ... } 和旧格式 [...]
      let arr;
      let norm;

      if (Array.isArray(rawValue)) {
        // 旧格式：entries[id] = [0.012, -0.034, ...]
        arr = rawValue;
        norm = _l2NormArr(arr);
      } else if (rawValue && typeof rawValue === 'object' && Array.isArray(rawValue.v)) {
        // 新格式：entries[id] = { v: [...], n: ... }
        arr = rawValue.v;
        norm = typeof rawValue.n === 'number' ? rawValue.n : _l2NormArr(arr);
      } else {
        continue;
      }

      if (arr.length !== this._dim) {
        log.warn(`跳过 id="${id}": 维度不匹配 (${arr.length} vs ${this._dim})`);
        continue;
      }

      this._entries.set(id, { embedding: arr, norm });
      loaded++;
    }

    log.log(`已从 ${this._indexPath} 加载 ${loaded} 条向量`);
    this._bucketsBuilt = false;
  }

  /**
   * 清空所有条目（不写盘，调用 save() 才会持久化）。
   */
  async clear() {
    const count = this.count;
    this._entries.clear();
    this._warned = false;
    this._buckets = null;
    this._bucketsBuilt = false;
    log.log(`已清空 ${count} 条向量`);
  }
}

// ── 内部工具函数 ──

/**
 * L2 范数 (Euclidean norm) —— Float32Array 版本
 * @param {Float32Array} vec
 * @returns {number}
 */
function _l2Norm(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

/**
 * L2 范数 (Euclidean norm) —— number[] 版本
 * @param {number[]} arr
 * @returns {number}
 */
function _l2NormArr(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i] * arr[i];
  }
  return Math.sqrt(sum);
}

/**
 * 向量点积
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
function _dotProduct(a, b) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

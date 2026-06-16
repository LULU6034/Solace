/**
 * fact-store-enhanced.js — Enhanced FactStore (sql.js, 纯 JS)
 *
 * 在 FactStore 基础上添加置信度和衰减、向量语义搜索。
 * 简化版 — sql.js 不支持 FTS5，使用 LIKE 搜索。
 * 向量搜索使用 bge-micro-v2 (384维)，降级回退到 LIKE。
 */
import path from 'node:path';
import { FactStore as _FactStore } from './fact-store-sqlite.js';
import { createModuleLogger } from '../lib/debug-log.js';

export { _FactStore as FactStore };

const log = createModuleLogger('fact-store-enhanced');

export class FactStoreEnhanced extends _FactStore {
  /** @type {import('sql.js').Database|null} */
  #_db = null;

  constructor(persistDir) {
    super(persistDir);
    // 向量搜索
    this._embedder = null;
    this._embedderLoading = false;
    this._vectorColumnReady = false;
    this._hasVectorColumn = false;
    // LRU 嵌入缓存: text → {vector, ts}
    this._embeddingCache = new Map();
    this._embeddingCacheMax = 50;
    this._embeddingCacheTTL = 60000;
  }

  /** 兼容父类通过 this.db 读写数据库 */
  get db() { return this.#_db; }
  set db(v) { this.#_db = v; }

  async init() {
    await super.init();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS facts_meta (
        id TEXT PRIMARY KEY,
        confidence REAL NOT NULL DEFAULT 0.5,
        half_life_days INTEGER NOT NULL DEFAULT 30,
        source TEXT
      )
    `);
    this._ensureVectorColumn();
    this._save();
  }

  /** 确保 facts 表有 vector 列（用于存储 384 维嵌入向量 JSON） */
  _ensureVectorColumn() {
    if (this._vectorColumnReady) return;
    try {
      const cols = this.db.exec('PRAGMA table_info(facts)');
      const names = (cols[0]?.values || []).map(r => r[1]);
      if (!names.includes('vector')) {
        this.db.run('ALTER TABLE facts ADD COLUMN vector TEXT DEFAULT NULL');
        this._save();
        log.log('已添加 vector 列');
      }
      this._hasVectorColumn = true;
    } catch (e) {
      log.warn('添加 vector 列失败: ' + (e?.message || e));
      this._hasVectorColumn = false;
    }
    this._vectorColumnReady = true;
  }

  add(entry) {
    const result = super.add(entry);
    const id = _mkId(entry.fact);
    this.db.run(
      `INSERT OR REPLACE INTO facts_meta (id, confidence, half_life_days, source) VALUES (?, ?, ?, ?)`,
      [id, entry.confidence ?? 0.5, entry.half_life_days ?? (entry.confidence > 0.8 ? 365 : 90), entry.source ?? null]
    );
    this._save();
    return result;
  }

  /** 获取高重要性事实 (>= minConfidence) */
  getHighImportance(minConfidence = 0.7) {
    return this.getByConfidence(minConfidence);
  }

  /** 衰减所有事实置信度 */
  decayAll() {
    const all = this._queryAll(
      'SELECT m.id, m.confidence, m.half_life_days, f.created_at FROM facts_meta m JOIN facts f ON m.id = f.id'
    );
    let decayed = 0;
    for (const r of all) {
      const ageHours = ((Date.now() - (r.created_at || Date.now())) / 3600000);
      const halfLife = (r.half_life_days || 30) * 24;
      const newConf = parseFloat(((r.confidence || 0.5) * Math.pow(2, -ageHours / halfLife)).toFixed(4));
      if (newConf < 0.05) {
        this.db.run('DELETE FROM facts_meta WHERE id = ?', [r.id]);
        this.db.run('DELETE FROM facts WHERE id = ?', [r.id]);
        decayed++;
      } else if (Math.abs(newConf - (r.confidence || 0.5)) > 0.01) {
        this.db.run('UPDATE facts_meta SET confidence = ? WHERE id = ?', [newConf, r.id]);
        decayed++;
      }
    }
    if (decayed > 0) this._save();
    return decayed;
  }

  addBatch(entries) {
    const result = super.addBatch(entries);
    for (const e of entries) {
      this.db.run(
        `INSERT OR REPLACE INTO facts_meta (id, confidence, half_life_days, source) VALUES (?, ?, ?, ?)`,
        [_mkId(e.fact), e.confidence ?? 0.5, e.half_life_days ?? (e.confidence > 0.8 ? 365 : 90), e.source ?? null]
      );
    }
    this._save();
    return result;
  }

  updateConfidence(id, newConfidence) {
    this.db.run('UPDATE facts_meta SET confidence = ? WHERE id = ?',
      [Math.max(0, Math.min(1, newConfidence)), id]);
    this._save();
  }

  getByConfidence(minConfidence = 0.7) {
    return this._queryAll(
      `SELECT f.id, f.fact, f.tags, f.created_at, m.confidence, m.half_life_days, m.source
       FROM facts f JOIN facts_meta m ON f.id = m.id
       WHERE m.confidence >= ? ORDER BY m.confidence DESC`, [minConfidence]
    ).map(r => ({ ...r, tags: _safeJson(r.tags) || [] }));
  }

  decayCheck() {
    const now = Date.now();
    const all = this._queryAll(
      `SELECT f.id, f.fact, f.tags, f.created_at, m.confidence, m.half_life_days, m.source
       FROM facts f JOIN facts_meta m ON f.id = m.id WHERE m.confidence > 0`
    );
    const decayed = all.filter(r => (now - r.created_at) / 86400000 > r.half_life_days);
    for (const r of decayed) {
      this.db.run('UPDATE facts_meta SET confidence = ? WHERE id = ?',
        [Math.max(0, r.confidence * 0.5), r.id]);
    }
    if (decayed.length > 0) this._save();
    return decayed.map(r => ({ ...r, tags: _safeJson(r.tags) || [], action: 'confidence_halved' }));
  }

  // ═══════════════════════════════════════════════════════════
  // 向量语义搜索 (bge-micro-v2, 384 维)
  // ═══════════════════════════════════════════════════════════

  /** 懒加载 bge-micro-v2 嵌入模型 */
  async _initEmbedder() {
    if (this._embedder) return this._embedder;
    if (this._embedderLoading) {
      // 等待并发加载完成
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (this._embedder) return this._embedder;
        if (!this._embedderLoading) break;
      }
      return null;
    }
    this._embedderLoading = true;
    try {
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = path.join(process.cwd(), 'public', 'models');
      try {
        env.allowRemoteModels = false;
        this._embedder = await pipeline('feature-extraction', 'Xenova/bge-micro-v2', {
          local_files_only: true,
        });
      } catch {
        env.allowRemoteModels = true;
        this._embedder = await pipeline('feature-extraction', 'Xenova/bge-micro-v2');
      }
      if (this._embedder) log.log('bge-micro-v2 嵌入模型加载成功');
    } catch (err) {
      log.warn('bge-micro-v2 加载失败: ' + (err?.message || err));
    }
    this._embedderLoading = false;
    return this._embedder;
  }

  /**
   * 为文本生成 384 维归一化嵌入向量
   * 带 LRU 缓存（50 条, TTL 60s）
   * @returns {Promise<number[]|null>}
   */
  async _generateEmbedding(text) {
    if (!text?.trim()) return null;

    // LRU 缓存命中检查
    const cached = this._embeddingCache.get(text);
    if (cached && (Date.now() - cached.ts) < this._embeddingCacheTTL) {
      return cached.vector;
    }

    await this._initEmbedder();
    if (!this._embedder) return null;

    try {
      const result = await this._embedder(text.slice(0, 512), {
        pooling: 'mean',
        normalize: true,
      });
      const vector = Array.from(result.data);

      // LRU 淘汰
      if (this._embeddingCache.size >= this._embeddingCacheMax) {
        const firstKey = this._embeddingCache.keys().next().value;
        this._embeddingCache.delete(firstKey);
      }
      this._embeddingCache.set(text, { vector, ts: Date.now() });
      return vector;
    } catch (err) {
      log.warn('生成嵌入失败: ' + (err?.message || err));
      return null;
    }
  }

  /**
   * 添加事实并生成向量嵌入
   * @param {string} fact - 事实文本
   * @param {string[]} tags - 标签
   * @param {{confidence?:number, half_life_days?:number, source?:string, session_id?:string}} meta
   * @returns {Promise<string>} 事实 ID
   */
  async addFactWithVector(fact, tags = [], meta = {}) {
    if (!this._ready) throw new Error('FactStore not initialized — call init() first');
    this._ensureVectorColumn();

    const id = _mkId(fact);
    const tagsJson = JSON.stringify(tags || []);
    const createdAt = Date.now();
    const confidence = meta.confidence ?? 0.5;
    const halfLifeDays = meta.half_life_days ?? (confidence > 0.8 ? 365 : confidence > 0.5 ? 90 : 30);
    const uid = this.userId;
    const source = meta.source ?? null;

    // 生成向量嵌入（失败则存 NULL，降级到 LIKE）
    const vec = await this._generateEmbedding(fact);
    const hasVector = this._hasVectorColumn && vec;
    const vectorJson = hasVector ? JSON.stringify(vec) : null;

    // Upsert: 同内容事实更新而非重复插入
    const existing = this._queryOne(
      'SELECT id FROM facts WHERE fact = ? AND user_id = ? AND deleted_at IS NULL',
      [fact, uid]
    );
    if (existing) {
      if (hasVector) {
        this.db.run(
          'UPDATE facts SET tags = ?, created_at = ?, confidence = ?, half_life_days = ?, vector = ? WHERE id = ?',
          [tagsJson, createdAt, confidence, halfLifeDays, vectorJson, existing.id]
        );
      } else {
        this.db.run(
          'UPDATE facts SET tags = ?, created_at = ?, confidence = ?, half_life_days = ? WHERE id = ?',
          [tagsJson, createdAt, confidence, halfLifeDays, existing.id]
        );
      }
    } else {
      if (hasVector) {
        this.db.run(
          'INSERT INTO facts (id, fact, tags, created_at, session_id, user_id, confidence, half_life_days, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, fact, tagsJson, createdAt, meta.session_id || null, uid, confidence, halfLifeDays, vectorJson]
        );
      } else {
        this.db.run(
          'INSERT INTO facts (id, fact, tags, created_at, session_id, user_id, confidence, half_life_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, fact, tagsJson, createdAt, meta.session_id || null, uid, confidence, halfLifeDays]
        );
      }
    }

    // 同步维护 facts_meta 表
    this.db.run(
      'INSERT OR REPLACE INTO facts_meta (id, confidence, half_life_days, source) VALUES (?, ?, ?, ?)',
      [id, confidence, halfLifeDays, source]
    );

    this._save();
    return id;
  }

  /**
   * 向量语义搜索
   * 将查询编码为嵌入，与数据库中所有已存储向量计算余弦相似度
   * 降级策略: 无向量 → 回退到 LIKE 搜索
   * @param {string} query - 搜索查询
   * @param {number} k - 返回 top-k 结果
   * @returns {Promise<Array>}
   */
  async vectorSearch(query, k = 5) {
    if (!this._ready) return [];
    const normalized = String(query || '').trim();
    if (!normalized || this.count() === 0) return [];

    // 1. 生成查询向量
    const queryVec = await this._generateEmbedding(normalized);

    if (queryVec) {
      // 2. 加载所有已存储向量的行
      const rows = this._queryAll(
        `SELECT id, fact, tags, created_at, confidence, half_life_days, vector
         FROM facts
         WHERE deleted_at IS NULL AND vector IS NOT NULL AND user_id = ?`,
        [this.userId]
      );

      if (rows.length > 0) {
        // 3. 计算余弦相似度
        const scored = rows.map(row => {
          let vec;
          try { vec = JSON.parse(row.vector); } catch { return null; }
          if (!vec || vec.length !== queryVec.length) return null;
          const sim = _cosineSimilarity(queryVec, vec);
          return { ...row, tags: _safeJson(row.tags) || [], _score: sim };
        }).filter(Boolean);

        scored.sort((a, b) => b._score - a._score);
        log.log(`向量搜索 "${normalized.slice(0,30)}": ${scored.length} 条匹配`);
        return scored.slice(0, k);
      }
    }

    // 4. 降级: LIKE 搜索
    log.log(`向量搜索降级为 LIKE: "${normalized.slice(0, 30)}"`);
    return this.search(normalized, k);
  }
}

function _mkId(fact) {
  let hash = 0;
  for (let i = 0; i < fact.length; i++) { hash = ((hash << 5) - hash) + fact.charCodeAt(i); hash |= 0; }
  return `f_${Math.abs(hash).toString(36)}_${fact.length}`;
}

function _safeJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/** 余弦相似度: dot(a,b) / (norm(a) * norm(b)) */
function _cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

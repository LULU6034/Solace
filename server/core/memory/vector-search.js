/**
 * vector-search.js — 语义向量检索 (P1)
 *
 * 使用 bge-micro-v2 (Xenova/Transformers.js) 做本地嵌入，
 * 对记忆进行语义搜索，替代纯关键词 LIKE 匹配。
 *
 * 降级策略: Transformers.js 加载失败 → 回退到 TF-IDF 词袋模型
 */

import { createModuleLogger } from '../../lib/debug-log.js';

const log = createModuleLogger('mem:vector');

// ── TF-IDF 降级实现 (零依赖) ──
class TfIdfIndex {
  constructor() {
    this.documents = [];
    this.idf = new Map();   // term → idf score
    this.tf = [];            // per-doc term frequency map
  }

  addDocument(id, text) {
    const terms = this._tokenize(text);
    const tf = new Map();
    for (const t of terms) {
      tf.set(t, (tf.get(t) || 0) + 1);
      this.idf.set(t, (this.idf.get(t) || 0) + 1);
    }
    // Normalize TF
    const maxFreq = Math.max(...tf.values(), 1);
    for (const [t, f] of tf) tf.set(t, f / maxFreq);

    this.documents.push({ id, text });
    this.tf.push(tf);
  }

  search(query, k = 5) {
    const queryTerms = this._tokenize(query);
    if (queryTerms.length === 0) return [];

    // Compute IDF
    const N = this.documents.length;
    const idf = new Map();
    for (const [t, df] of this.idf) {
      idf.set(t, Math.log((N + 1) / (df + 1)) + 1);
    }

    // Query TF
    const queryTf = new Map();
    for (const t of queryTerms) {
      queryTf.set(t, (queryTf.get(t) || 0) + 1);
    }
    const qMax = Math.max(...queryTf.values(), 1);
    for (const [t, f] of queryTf) queryTf.set(t, f / qMax);

    // Cosine similarity
    const scores = this.tf.map((docTf, i) => {
      let dot = 0, qNorm = 0, dNorm = 0;
      for (const [t, qv] of queryTf) {
        const dv = docTf.get(t) || 0;
        dot += qv * (idf.get(t) || 1) * dv * (idf.get(t) || 1);
      }
      for (const [, dv] of docTf) {
        dNorm += Math.pow(dv * (idf.get([...docTf.keys()].find(k => docTf.get(k) === dv) || '') || 1), 2);
      }
      for (const [, qv] of queryTf) {
        qNorm += Math.pow(qv * (idf.get([...queryTf.keys()].find(k => queryTf.get(k) === qv) || '') || 1), 2);
      }
      const sim = dot / (Math.sqrt(dNorm) * Math.sqrt(qNorm) + 1e-8);
      return { idx: i, score: sim };
    });

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, k).map(s => ({
      ...this.documents[s.idx],
      score: Math.round(s.score * 100) / 100,
    }));
  }

  _tokenize(text) {
    // 中文: 单字 + 双字组合
    const t = (text || '').toLowerCase().replace(/[^一-龥a-zA-Z0-9]/g, ' ');
    const words = t.split(/\s+/).filter(w => w.length > 0);
    const tokens = [];
    for (const w of words) {
      if (/^[a-zA-Z0-9]+$/.test(w)) {
        tokens.push(w);
      } else {
        // 中文分词: 单字 + bigram
        for (let i = 0; i < w.length; i++) {
          tokens.push(w[i]);
          if (i + 1 < w.length) tokens.push(w[i] + w[i + 1]);
        }
      }
    }
    return tokens;
  }

  clear() {
    this.documents = [];
    this.idf.clear();
    this.tf = [];
  }

  get size() { return this.documents.length; }
}

// ── Transformer 向量检索 (bge-micro-v2) ──
let _pipeline = null;
let _pipelineLoading = false;

async function _loadEmbeddingModel() {
  if (_pipeline) return _pipeline;
  if (_pipelineLoading) {
    // Wait for concurrent load
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (_pipeline) return _pipeline;
      if (!_pipelineLoading) break;
    }
    return null;
  }
  _pipelineLoading = true;
  try {
    const { pipeline, env } = await import('@xenova/transformers');
    env.allowRemoteModels = false;
    _pipeline = await pipeline('feature-extraction', 'Xenova/bge-micro-v2', {
      local_files_only: true,
    });
    log.log('bge-micro-v2 加载成功');
  } catch (err) {
    log.warn(`bge-micro-v2 加载失败: ${err.message}，回退 TF-IDF`);
  }
  _pipelineLoading = false;
  return _pipeline;
}

export class VectorSearch {
  constructor() {
    this.index = new TfIdfIndex();
    this.embeddings = [];    // [{id, text, vector: Float32Array}]
    this.useTransformer = false;
    this._ready = false;
  }

  async init() {
    if (this._ready) return;
    const model = await _loadEmbeddingModel();
    if (model) {
      this._pipeline = model;
      this.useTransformer = true;
    }
    this._ready = true;
  }

  async addDocument(id, text) {
    if (!text?.trim()) return;
    this.index.addDocument(id, text);

    if (this.useTransformer && this._pipeline) {
      try {
        const result = await this._pipeline(text.slice(0, 512), {
          pooling: 'mean',
          normalize: true,
        });
        this.embeddings.push({
          id,
          text,
          vector: new Float32Array(result.data),
        });
        // 最多保留 1000 条向量
        if (this.embeddings.length > 1000) this.embeddings.shift();
      } catch (err) {
        log.warn(`嵌入失败: ${err.message}`);
      }
    }
  }

  async search(query, k = 5) {
    if (!this._ready) await this.init();

    if (this.embeddings.length > 0 && this.useTransformer && this._pipeline) {
      try {
        const qResult = await this._pipeline(query.slice(0, 512), {
          pooling: 'mean',
          normalize: true,
        });
        const qVec = new Float32Array(qResult.data);

        const scores = this.embeddings.map((doc, i) => {
          let dot = 0;
          for (let j = 0; j < qVec.length; j++) {
            dot += qVec[j] * doc.vector[j];
          }
          return { idx: i, score: dot, id: doc.id, text: doc.text };
        });

        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, k).map(s => ({
          id: s.id,
          text: s.text,
          score: Math.round(s.score * 100) / 100,
        }));
      } catch (err) {
        log.warn(`向量搜索失败: ${err.message}，回退 TF-IDF`);
      }
    }

    // 回退 TF-IDF
    return this.index.search(query, k).map(r => ({
      id: r.id,
      text: r.text,
      score: r.score,
    }));
  }

  async searchInFacts(facts, query, k = 5) {
    // 对事实列表做即时索引+搜索
    const tmp = new TfIdfIndex();
    for (const f of facts) {
      const text = typeof f === 'string' ? f : (f.fact || f.content || '');
      tmp.addDocument(text, text);
    }
    return tmp.search(query, k);
  }

  clear() {
    this.index.clear();
    this.embeddings = [];
  }

  get documentCount() {
    return this.useTransformer ? this.embeddings.length : this.index.size;
  }
}

// 单例
let _instance = null;
export function getVectorSearch() {
  if (!_instance) _instance = new VectorSearch();
  return _instance;
}

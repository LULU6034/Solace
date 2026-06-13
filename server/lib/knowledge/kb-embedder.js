/**
 * kb-embedder.js — 知识库向量嵌入封装
 *
 * 封装 bge-micro-v2 模型（Xenova Transformers.js），为知识库的
 * 语义检索提供文本向量化能力。
 *
 * 设计要点：
 *   - 384 维向量，模型仅 ~17MB，CPU 友好
 *   - 懒加载：首调 ensureLoaded() / embed() 时才加载模型
 *   - 模块级单例缓存 pipeline，多次实例化不会重复加载
 *   - 加载失败不抛异常，由调用方检查 this._pipeline 决定降级策略
 *   - 复用 vector-search.js 已验证的 Xenova pipeline 加载模式
 */

import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('kb-embedder');

// ── 模块级单例 pipeline 缓存 ──
let _pipeline = null;
let _pipelineLoading = false;

/**
 * 加载 bge-micro-v2 embedding pipeline（模块级单例）。
 * 支持并发调用：后续调用者等待首个加载完成。
 * @returns {Promise<object|null>} pipeline 实例，失败返回 null
 */
async function _loadPipeline() {
  if (_pipeline) return _pipeline;

  // 并发调用守卫：等待首个加载完成（最多 30 秒）
  if (_pipelineLoading) {
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
    // 尝试从缓存加载；如果缓存没有且网络不通，优雅降级
    try {
      env.allowRemoteModels = false;
      _pipeline = await pipeline('feature-extraction', 'Xenova/bge-micro-v2', {
        local_files_only: true,
      });
    } catch {
      // 缓存不存在，尝试在线下载
      try {
        env.allowRemoteModels = true;
        _pipeline = await pipeline('feature-extraction', 'Xenova/bge-micro-v2');
      } catch (e2) {
        log.warn(`bge-micro-v2 不可用（网络不通且无缓存）: ${e2.message}`);
      }
    }
    log.log('bge-micro-v2 embedding 模型加载成功');
  } catch (err) {
    log.warn(`bge-micro-v2 加载失败: ${err.message}`);
  }
  _pipelineLoading = false;
  return _pipeline;
}

// ── KBEmbedder ──

export class KBEmbedder {
  constructor() {
    /** @type {object|null} Xenova pipeline 引用 */
    this._pipeline = null;
    /** @type {boolean} 是否已尝试加载（无论成功与否） */
    this._loaded = false;
  }

  /**
   * 确保模型已加载。幂等，多次调用安全。
   * 加载成功后 this._pipeline 指向模块级缓存的 pipeline。
   * 加载失败时 this._pipeline 为 null，调用方应自行降级。
   */
  async ensureLoaded() {
    if (this._loaded) return;
    this._pipeline = await _loadPipeline();
    this._loaded = true;
  }

  /**
   * 对单条文本做向量嵌入。
   * @param {string} text - 输入文本
   * @returns {Promise<Float32Array>} 384 维归一化向量
   * @throws {Error} 模型未加载时抛出
   */
  async embed(text) {
    if (!this._loaded) await this.ensureLoaded();
    if (!this._pipeline) {
      throw new Error('KBEmbedder: embedding 模型未加载，无法生成向量');
    }

    const trimmed = String(text || '').trim();
    if (!trimmed) {
      // 空文本返回零向量
      return new Float32Array(384);
    }

    const result = await this._pipeline(trimmed.slice(0, 512), {
      pooling: 'mean',
      normalize: true,
    });
    return new Float32Array(result.data);
  }

  /**
   * 批量文本向量嵌入。
   * 逐条调用 pipeline（bge-micro-v2 单次只接受一条文本）。
   * @param {string[]} texts - 输入文本数组
   * @returns {Promise<Float32Array[]>} 384 维向量数组，顺序与输入一致
   * @throws {Error} 模型未加载时抛出
   */
  async embedBatch(texts) {
    if (!this._loaded) await this.ensureLoaded();
    if (!this._pipeline) {
      throw new Error('KBEmbedder: embedding 模型未加载，无法生成向量');
    }

    const results = [];
    for (const text of texts) {
      const trimmed = String(text || '').trim();
      if (!trimmed) {
        results.push(new Float32Array(384));
        continue;
      }
      const result = await this._pipeline(trimmed.slice(0, 512), {
        pooling: 'mean',
        normalize: true,
      });
      results.push(new Float32Array(result.data));
    }
    return results;
  }

  /** @returns {number} 向量维度 */
  get dim() {
    return 384;
  }

  /** @returns {string} 模型名称 */
  get modelName() {
    return 'bge-micro-v2';
  }
}

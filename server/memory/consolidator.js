/**
 * consolidator.js — 记忆巩固器
 *
 * 后台定期运行（默认每 5 轮对话），对事实记忆执行三种操作：
 * 1. 合并相似事实 — 同一维度下相似度 > 阈值的两条事实合并为一条
 * 2. 解决冲突 — 同一实体出现相反情感时，置信度高者获胜
 * 3. 归纳偏好 — 将同维度多个事实用 LLM 总结为一条摘要
 *
 * 设计原则：
 * - 后台运行：使用 setImmediate 避免阻塞对话主流程
 * - 幂等性：重复运行不会产生副作用
 * - 容错：所有操作包裹 try/catch，失败仅记录日志不抛出
 */
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('mem:consolidator');

// ── Helpers ──

/** 从事实文本生成确定性的 ID（与 fact-store-sqlite.js 中的 _mkId 保持一致） */
function _mkId(fact) {
  let hash = 0;
  for (let i = 0; i < fact.length; i++) { hash = ((hash << 5) - hash) + fact.charCodeAt(i); hash |= 0; }
  return `f_${Math.abs(hash).toString(36)}_${fact.length}`;
}

/** Jaccard 相似度（基于字符集合，适用于无向量嵌入时的降级方案） */
function jaccardSimilarity(a, b) {
  const setA = new Set(String(a || '').split(''));
  const setB = new Set(String(b || '').split(''));
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

/** 余弦相似度（两个等长数值向量） */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

// ── 情感冲突正则 ──
const SENTIMENT_RE = /(喜欢|讨厌|不喜欢|爱吃|不爱吃)(.+)/;
const OPPOSITES = {
  '喜欢': ['讨厌', '不喜欢'],
  '讨厌': ['喜欢'],
  '不喜欢': ['喜欢'],
  '爱吃': ['不爱吃'],
  '不爱吃': ['爱吃'],
};

export class MemoryConsolidator {
  /**
   * @param {object} factStore - 事实存储实例（FactStore 或 FactStoreEnhanced）
   * @param {object} episodicStore - 情景记忆存储（预留，当前未使用）
   * @param {object} [options]
   * @param {number} [options.mergeThreshold=0.85] - 合并相似度阈值
   * @param {number} [options.runInterval=5] - 每 N 轮执行一次巩固
   */
  constructor(factStore, episodicStore, options = {}) {
    this.factStore = factStore;
    this.episodicStore = episodicStore;
    this.mergeThreshold = options.mergeThreshold ?? 0.85;
    this.runInterval = options.runInterval ?? 5;
    this.turnCount = 0;
    this._running = false;
    this._llm = null;
  }

  /** 注入 LLM 调用函数（async fn，接收 prompt 字符串，返回响应文本）。归纳偏好前必须调用。 */
  setLlm(fn) { this._llm = fn; }

  /**
   * 每轮对话后调用。
   * 按 runInterval 间隔触发巩固，使用 setImmediate 切到后台避免阻塞。
   * @returns {Promise<boolean>} 本轮是否执行了巩固
   */
  async afterTurn() {
    this.turnCount++;
    if (this.turnCount % this.runInterval !== 0) return false;
    if (this._running) return false; // 上一轮巩固尚未完成，跳过
    this._running = true;
    // 切到下一轮事件循环，避免阻塞当前对话响应
    await new Promise(resolve => { setImmediate(resolve); });
    try {
      await this.consolidate();
      return true;
    } finally {
      this._running = false;
    }
  }

  /** 执行全部三种巩固操作，各自独立容错 */
  async consolidate() {
    log.log('记忆巩固开始...');
    let merged = 0, resolved = 0, summarized = null;
    try {
      merged = await this._mergeSimilarFacts();
    } catch (e) { log.warn('合并相似事实失败: ' + (e?.message || e)); }
    try {
      resolved = await this._resolveConflicts();
    } catch (e) { log.warn('解决冲突失败: ' + (e?.message || e)); }
    try {
      summarized = await this._summarizeDimension('preference', 5);
    } catch (e) { log.warn('归纳偏好失败: ' + (e?.message || e)); }
    log.log(`记忆巩固完成: 合并${merged}条, 解决${resolved}冲突, 归纳偏好${summarized ? '1' : '0'}条`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Operation 1: 合并相似事实
  // ═══════════════════════════════════════════════════════════════

  /**
   * 在同一维度标签内查找相似度 > mergeThreshold 的事实对，保留置信度更高者。
   * - 有向量嵌入能力时使用余弦相似度，否则降级为 Jaccard 字符相似度
   * - 保留方置信度 +0.1（上限 0.99），被合并方置信度降至 0.01（软删除）
   * - 跳过置信度 < 0.3 的弱事实
   * @returns {Promise<number>} 合并的对数
   */
  async _mergeSimilarFacts() {
    const allFacts = this._getAllFacts();
    if (!allFacts || allFacts.length < 2) return 0;

    // 过滤低置信度事实
    const candidates = allFacts.filter(f => (f.confidence ?? 0.5) >= 0.3);
    if (candidates.length < 2) return 0;

    // 按维度标签分组（无标签的归入 _uncategorized）
    const byDimension = new Map();
    for (const f of candidates) {
      const tags = f.tags || [];
      if (tags.length === 0) {
        if (!byDimension.has('_uncategorized')) byDimension.set('_uncategorized', []);
        byDimension.get('_uncategorized').push(f);
      } else {
        for (const tag of tags) {
          if (!byDimension.has(tag)) byDimension.set(tag, []);
          byDimension.get(tag).push(f);
        }
      }
    }

    // 检测向量嵌入能力
    const hasVectorCapability = typeof this.factStore._generateEmbedding === 'function';

    let merged = 0;
    for (const [, facts] of byDimension) {
      if (facts.length < 2) continue;

      for (let i = 0; i < facts.length; i++) {
        if ((facts[i].confidence ?? 0.5) < 0.3) continue;
        for (let j = i + 1; j < facts.length; j++) {
          if ((facts[j].confidence ?? 0.5) < 0.3) continue;
          // 跳过精确相同文本（已经由 addFactWithVector 的 upsert 处理）
          if (facts[i].fact === facts[j].fact) continue;

          let sim;
          if (hasVectorCapability) {
            try {
              const [vecA, vecB] = await Promise.all([
                this.factStore._generateEmbedding(facts[i].fact),
                this.factStore._generateEmbedding(facts[j].fact),
              ]);
              sim = (vecA && vecB) ? cosineSimilarity(vecA, vecB) : jaccardSimilarity(facts[i].fact, facts[j].fact);
            } catch {
              sim = jaccardSimilarity(facts[i].fact, facts[j].fact);
            }
          } else {
            sim = jaccardSimilarity(facts[i].fact, facts[j].fact);
          }

          if (sim > this.mergeThreshold) {
            const a = facts[i], b = facts[j];
            if ((a.confidence ?? 0.5) >= (b.confidence ?? 0.5)) {
              const newConf = Math.min(0.99, (a.confidence ?? 0.5) + 0.1);
              this._updateConfidence(a, newConf);
              this._updateConfidence(b, 0.01);
              log.log(`合并: "${a.fact.slice(0, 30)}" (sim=${sim.toFixed(3)}) 保留, "${b.fact.slice(0, 30)}" 软删除`);
            } else {
              const newConf = Math.min(0.99, (b.confidence ?? 0.5) + 0.1);
              this._updateConfidence(b, newConf);
              this._updateConfidence(a, 0.01);
              log.log(`合并: "${b.fact.slice(0, 30)}" (sim=${sim.toFixed(3)}) 保留, "${a.fact.slice(0, 30)}" 软删除`);
            }
            merged++;
          }
        }
      }
    }

    return merged;
  }

  // ═══════════════════════════════════════════════════════════════
  // Operation 2: 解决冲突
  // ═══════════════════════════════════════════════════════════════

  /**
   * 查找关于同一实体的相反情感事实（如 "喜欢摇滚" vs "讨厌摇滚"），
   * 置信度高者获胜，低者置信度降至 0.1。
   * @returns {Promise<number>} 解决的冲突数
   */
  async _resolveConflicts() {
    const allFacts = this._getAllFacts();
    if (!allFacts || allFacts.length < 2) return 0;

    // 提取包含情感模式的事实
    const sentimentFacts = [];
    for (const f of allFacts) {
      if ((f.confidence ?? 0.5) < 0.3) continue;
      const m = SENTIMENT_RE.exec(f.fact);
      if (m) {
        sentimentFacts.push({
          sentiment: m[1],
          entity: m[2].trim(),
          ...f,
        });
      }
    }

    if (sentimentFacts.length < 2) return 0;

    // 按实体分组
    const byEntity = new Map();
    for (const sf of sentimentFacts) {
      const key = sf.entity;
      if (!byEntity.has(key)) byEntity.set(key, []);
      byEntity.get(key).push(sf);
    }

    let resolved = 0;
    for (const [entity, facts] of byEntity) {
      if (facts.length < 2) continue;

      for (let i = 0; i < facts.length; i++) {
        const opposites = OPPOSITES[facts[i].sentiment];
        if (!opposites) continue;
        for (let j = i + 1; j < facts.length; j++) {
          if (opposites.includes(facts[j].sentiment)) {
            const a = facts[i], b = facts[j];
            if ((a.confidence ?? 0.5) >= (b.confidence ?? 0.5)) {
              this._updateConfidence(b, 0.1);
              log.log(`冲突解决: "${a.sentiment}${entity}"(置信度${(a.confidence ?? 0.5).toFixed(2)}) 击败 "${b.sentiment}${entity}"(${(b.confidence ?? 0.5).toFixed(2)})`);
            } else {
              this._updateConfidence(a, 0.1);
              log.log(`冲突解决: "${b.sentiment}${entity}"(置信度${(b.confidence ?? 0.5).toFixed(2)}) 击败 "${a.sentiment}${entity}"(${(a.confidence ?? 0.5).toFixed(2)})`);
            }
            resolved++;
          }
        }
      }
    }

    return resolved;
  }

  // ═══════════════════════════════════════════════════════════════
  // Operation 3: 归纳偏好
  // ═══════════════════════════════════════════════════════════════

  /**
   * 当某维度（如 "preference"）下的事实数量 >= minCount 时，
   * 调用 LLM 生成一条摘要事实，降低源事实置信度。
   * @param {string} dimension - 维度标签
   * @param {number} [minCount=5] - 触发归纳的最小事实数
   * @returns {Promise<string|null>} 生成的摘要文本，或 null
   */
  async _summarizeDimension(dimension, minCount = 5) {
    if (!this._llm) {
      log.warn('未注入 LLM（调用 setLlm()），跳过偏好归纳');
      return null;
    }

    const allFacts = this._getAllFacts();
    const dimensionFacts = allFacts.filter(f =>
      (f.tags || []).includes(dimension) && (f.confidence ?? 0.5) >= 0.3
    );

    if (dimensionFacts.length < minCount) return null;

    // 构建归纳提示
    const factList = dimensionFacts.map(f => `- ${f.fact}`).join('\n');
    const dimensionLabel = dimension === 'preference' ? '偏好' : dimension;
    const prompt = [
      `将以下关于用户${dimensionLabel}的事实归纳为一句简洁流畅的摘要。`,
      `保留所有关键信息，不遗漏任何提及的项目或类别。`,
      ``,
      factList,
      ``,
      `请直接返回一句中文摘要，不加前缀、编号或标记。`,
    ].join('\n');

    let summary;
    try {
      summary = await Promise.race([
        this._llm(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('LLM归纳超时(30s)')), 30_000)),
      ]);
    } catch (e) {
      log.warn('LLM归纳调用失败: ' + (e?.message || e));
      // 降级：直接拼接去除情感前缀的事实文本
      summary = dimensionFacts
        .map(f => f.fact.replace(/^(喜欢|讨厌|不喜欢|爱吃|不爱吃)/, '').trim())
        .filter(Boolean)
        .join('、');
      if (summary) summary = `用户偏好包括: ${summary}`;
    }

    if (!summary || typeof summary !== 'string' || !summary.trim()) return null;
    summary = summary.trim().slice(0, 500);

    // 计算源事实平均置信度
    const avgConf = dimensionFacts.reduce((s, f) => s + (f.confidence ?? 0.5), 0) / dimensionFacts.length;

    // 存储归纳事实
    const addMethod = typeof this.factStore.addFactWithVector === 'function'
      ? 'addFactWithVector'
      : typeof this.factStore.addFact === 'function'
        ? 'addFact'
        : typeof this.factStore.add === 'function'
          ? 'add'
          : null;

    if (addMethod) {
      try {
        if (addMethod === 'addFactWithVector') {
          await this.factStore.addFactWithVector(summary, [dimension, '_summarized'], {
            confidence: Math.round(avgConf * 100) / 100,
            half_life_days: 90,
            source: `consolidator:summarize_${dimension}`,
          });
        } else if (addMethod === 'addFact') {
          this.factStore.addFact(summary, [dimension, '_summarized'], {
            confidence: Math.round(avgConf * 100) / 100,
            half_life_days: 90,
          });
        } else {
          this.factStore.add({
            fact: summary,
            tags: [dimension, '_summarized'],
            confidence: Math.round(avgConf * 100) / 100,
            half_life_days: 90,
          });
        }
        log.log(`归纳${dimensionLabel}: "${summary.slice(0, 60)}" (来源${dimensionFacts.length}条, 置信度${(avgConf).toFixed(2)})`);
      } catch (e) {
        log.warn('存储归纳事实失败: ' + (e?.message || e));
      }
    }

    // 降低源事实的置信度（因子 0.5）
    for (const f of dimensionFacts) {
      this._updateConfidence(f, Math.max(0.01, (f.confidence ?? 0.5) * 0.5));
    }

    return summary;
  }

  // ═══════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════

  /**
   * 获取所有未删除的事实。
   * 优先使用 getByConfidence(0)（返回含 id 的结果），降级为 getAll()。
   * @returns {Array<{id?:string, fact:string, tags:string[], confidence:number, ...}>}
   */
  _getAllFacts() {
    try {
      if (typeof this.factStore.getByConfidence === 'function') {
        return this.factStore.getByConfidence(0);
      }
      if (typeof this.factStore.getAll === 'function') {
        return this.factStore.getAll();
      }
      return [];
    } catch (e) {
      log.warn('获取事实列表失败: ' + (e?.message || e));
      return [];
    }
  }

  /**
   * 更新事实置信度。
   * - FactStoreEnhanced: 使用 updateConfidence(id, newConf)
   * - 普通 FactStore: 极低置信度时使用 softDelete 软删除
   * - 同时更新本地引用中的 confidence 字段，确保同轮巩固中的后续比较使用新值
   * @param {object} fact - 事实对象
   * @param {number} newConf - 新置信度 (0~1)
   */
  _updateConfidence(fact, newConf) {
    try {
      const clamped = Math.max(0, Math.min(1, newConf));
      const id = fact.id || _mkId(fact.fact);

      if (typeof this.factStore.updateConfidence === 'function') {
        this.factStore.updateConfidence(id, clamped);
      } else if (clamped <= 0.02 && typeof this.factStore.softDelete === 'function') {
        // 降级方案：极低置信度视为软删除
        this.factStore.softDelete(fact.fact);
      }

      // 更新本地引用中的置信度，确保同轮内后续比较使用新值（幂等安全）
      if (fact && typeof fact === 'object') {
        fact.confidence = clamped;
      }
    } catch (e) {
      log.warn('更新置信度失败: ' + (e?.message || e));
    }
  }
}

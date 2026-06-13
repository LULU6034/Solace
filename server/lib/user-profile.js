/**
 * user-profile.js — 动态用户画像
 *
 * 每个属性有:
 * - confidence: 0~1 置信度，新证据确认/否定时调整
 * - lastUpdated: 最后更新时间戳
 * - halfLife: 半衰期（小时），时效性强的属性衰减快
 * - sources: 证据来源计数
 *
 * 衰减公式: weight_new = weight_old * 2^(-delta_h / half_life)
 * 合并规则: 新证据与旧值一致 → 置信度增加 (上限 0.95)
 *          新证据与旧值相悖 → 置信度降低，触发冲突解决
 */

import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from './debug-log.js';

const log = createModuleLogger('mem:profile');

// ── Default half-lives (hours) ──
const DEFAULT_HALF_LIFE = {
  // Surface preferences (short half-life)
  mood: 0.5,               // 情绪 — 30分钟
  currentProject: 24,      // 当前项目 — 1天
  interest: 168,           // 兴趣话题 — 7天

  // Deep traits (long half-life)
  personality_openness: 720,      // 开放性 — 30天
  personality_conscientiousness: 720,
  personality_extraversion: 720,
  personality_agreeableness: 720,
  personality_neuroticism: 720,   // 神经质 — 30天

  // Explicit knowledge
  name: 8760,              // 姓名 — 1年（几乎不变）
  location: 2160,          // 位置 — 90天
  occupation: 2160,        // 职业 — 90天
  language: 8760,          // 语言 — 1年

  // Default
  _default: 168,           // 7天
};

const CONFIDENCE_MAX = 0.95;
const CONFIDENCE_MIN = 0.05;
const CONFLICT_THRESHOLD = 0.4; // 低于此置信度标记为冲突

export class UserProfile {
  constructor(persistDir) {
    this.filePath = persistDir
      ? path.join(persistDir, 'user-profile.json')
      : null;
    this.attributes = {}; // { key: { value, confidence, lastUpdated, halfLife, sources } }
    this.load();
  }

  // ── CRUD ──

  /**
   * Update or create an attribute with evidence.
   * @param {string} key — attribute key
   * @param {*} value — new evidence value
   * @param {number} weight — evidence weight (0~1, default 0.5)
   */
  update(key, value, weight = 0.5) {
    const now = Date.now();
    const halfLife = DEFAULT_HALF_LIFE[key] || DEFAULT_HALF_LIFE._default;

    if (this.attributes[key]) {
      const attr = this.attributes[key];

      // Apply decay first
      const deltaH = (now - attr.lastUpdated) / (1000 * 60 * 60);
      const decay = Math.pow(2, -deltaH / halfLife);
      attr.confidence *= decay;

      // Merge: consistent evidence raises confidence, contradictory lowers it
      if (this._valueMatch(attr.value, value)) {
        attr.confidence = Math.min(CONFIDENCE_MAX,
          attr.confidence + weight * (1 - attr.confidence));
        attr.sources++;
      } else {
        // Conflict — reduce confidence
        attr.confidence = Math.max(CONFIDENCE_MIN,
          attr.confidence - weight * 0.3);
        attr.sources++;
        if (attr.confidence < CONFLICT_THRESHOLD) {
          log.log(`冲突: ${key} = "${attr.value}" vs "${value}" (conf=${attr.confidence.toFixed(2)})`);
          attr._conflictingValue = value;
        }
      }

      attr.lastUpdated = now;
      attr.value = attr.confidence >= CONFLICT_THRESHOLD ? attr.value : value;
    } else {
      // New attribute
      this.attributes[key] = {
        value,
        confidence: Math.min(0.6, weight),
        lastUpdated: now,
        halfLife,
        sources: 1,
      };
    }

    this.save();
    return this.attributes[key];
  }

  /** Get attribute with current confidence (decay applied) */
  get(key) {
    const attr = this.attributes[key];
    if (!attr) return null;

    // Apply time decay
    const now = Date.now();
    const deltaH = (now - attr.lastUpdated) / (1000 * 60 * 60);
    const decay = Math.pow(2, -deltaH / (attr.halfLife || DEFAULT_HALF_LIFE._default));
    const effectiveConfidence = attr.confidence * decay;

    return { ...attr, confidence: effectiveConfidence };
  }

  /** Remove attribute */
  delete(key) {
    delete this.attributes[key];
    this.save();
  }

  /** Get all high-confidence attributes (above threshold) */
  getHighConfidence(threshold = 0.5) {
    const result = {};
    for (const [key, attr] of Object.entries(this.attributes)) {
      const effective = this.get(key);
      if (effective && effective.confidence >= threshold) {
        result[key] = effective;
      }
    }
    return result;
  }

  /** Format profile for LLM system prompt */
  formatForLLM() {
    const attrs = this.getHighConfidence(0.5);
    const lines = [];
    for (const [key, attr] of Object.entries(attrs)) {
      const label = PROFILE_LABELS[key] || key;
      lines.push(`- ${label}: ${attr.value} (置信度 ${(attr.confidence * 100).toFixed(0)}%)`);
    }
    if (lines.length === 0) return null;
    return '## 用户画像\n' + lines.join('\n');
  }

  /** Prune expired low-confidence attributes */
  prune(confidenceThreshold = 0.1) {
    const now = Date.now();
    let removed = 0;
    for (const [key, attr] of Object.entries(this.attributes)) {
      const deltaH = (now - attr.lastUpdated) / (1000 * 60 * 60);
      const decay = Math.pow(2, -deltaH / (attr.halfLife || DEFAULT_HALF_LIFE._default));
      const effective = attr.confidence * decay;
      if (effective < confidenceThreshold && attr.halfLife < 720) {
        // Only prune short-half-life items
        delete this.attributes[key];
        removed++;
      }
    }
    if (removed > 0) {
      log.log(`剪除 ${removed} 个过期属性`);
      this.save();
    }
  }

  /** Export as plain object */
  export() {
    const result = {};
    for (const [key, attr] of Object.entries(this.attributes)) {
      result[key] = { ...attr, effectiveConfidence: this.get(key)?.confidence };
    }
    return result;
  }

  /** Import from plain object */
  import(data) {
    for (const [key, attr] of Object.entries(data)) {
      this.attributes[key] = { ...attr, lastUpdated: Date.now() };
    }
    this.save();
  }

  // ── Persistence ──

  load() {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath)) {
        this.attributes = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        log.log(`加载用户画像: ${Object.keys(this.attributes).length} 属性`);
      }
    } catch (err) {
      log.warn(`加载画像失败: ${err.message}`);
      this.attributes = {};
    }
  }

  save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.attributes, null, 2));
    } catch (err) {
      log.warn(`保存画像失败: ${err.message}`);
    }
  }

  // ── Internal ──

  _valueMatch(a, b) {
    if (a === b) return true;
    if (typeof a === 'string' && typeof b === 'string') {
      return a.toLowerCase().includes(b.toLowerCase()) ||
             b.toLowerCase().includes(a.toLowerCase());
    }
    return false;
  }
}

// ── Chinese labels for profile keys ──
const PROFILE_LABELS = {
  name: '名字',
  location: '所在地',
  occupation: '职业',
  language: '语言',
  interest: '兴趣',
  currentProject: '当前项目',
  mood: '心情',
  personality_openness: '开放性',
  personality_conscientiousness: '尽责性',
  personality_extraversion: '外向性',
  personality_agreeableness: '宜人性',
  personality_neuroticism: '情绪稳定性',
};

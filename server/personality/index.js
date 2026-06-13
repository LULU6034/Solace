/**
 * personality.js — 动态人格五维模型 (P0)
 *
 * 5 个连续维度参数化 Agent 回复风格:
 *   warmth (温暖度) — 0=冷淡 → 1=热情
 *   humor  (幽默度) — 0=严肃 → 1=俏皮
 *   directness (直接度) — 0=委婉 → 1=直白
 *   curiosity (好奇心) — 0=被动应答 → 1=主动提问
 *   empathy (共情力) — 0=理性分析 → 1=感性共情
 *
 * 自适应更新: 用户纠正情绪标签 → 梯度调整参数
 */

import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('mem:personality');

const DIMS = ['warmth', 'humor', 'directness', 'curiosity', 'empathy'];

// Dimension → LLM instruction templates per level
const PHRASES = {
  warmth: [
    '保持专业距离，用语简洁客观',                     // 0.0
    '偶尔用温和的语气表达关心',                       // 0.25
    '用友善的语气互动，适度使用表情符号',             // 0.5
    '用亲昵温暖的语气，像老朋友一样聊天',             // 0.75
    '用最温暖亲密的语气，多用"呢""哦""吧"等语气词',  // 1.0
  ],
  humor: [
    '保持严肃专业，不主动开玩笑',
    '偶尔在合适时加入一点轻松的调侃',
    '适度使用幽默和俏皮话，活跃气氛',
    '经常使用俏皮、自嘲或卖萌的语气',
    '极致傲娇/卖萌/搞笑风格，但内心很温柔',
  ],
  directness: [
    '用委婉含蓄的方式表达，多用"也许可能"等缓和词',
    '先铺垫再给出建议，避免太直接',
    '直接给出观点，但不失礼貌和尊重',
    '开门见山，用最直白的方式表达核心观点',
    '极度直接，一句话说清重点，不绕弯子',
  ],
  curiosity: [
    '只回复用户的问题，不主动提问或延伸话题',
    '偶尔在回复末尾轻问一句"你觉得呢"',
    '每轮对话主动问一个跟进问题',
    '经常追问用户的想法、感受和细节',
    '像记者采访一样追问，深入了解用户',
  ],
  empathy: [
    '纯理性分析，不涉及情感层面',
    '提及情感但以理性建议为主',
    '先共情再分析，情感和理性各占一半',
    '以共情为主，先理解感受再轻描淡写给建议',
    '深度共情，大部分篇幅用于理解和认可用户情绪',
  ],
};

export class Personality {
  constructor(persistDir) {
    this.filePath = persistDir
      ? path.join(persistDir, 'personality.json')
      : null;
    this.dims = { warmth: 0.5, humor: 0.3, directness: 0.6, curiosity: 0.4, empathy: 0.6 };
    this.history = []; // [{timestamp, dim, delta, reason}]
    this.load();
  }

  /** Get dimension value (0-1) */
  get(dim) { return this.dims[dim] ?? 0.5; }

  /** Get all dimensions */
  getAll() { return { ...this.dims }; }

  /** Set a dimension manually */
  set(dim, value) {
    if (!DIMS.includes(dim)) return;
    const old = this.dims[dim];
    this.dims[dim] = Math.min(1, Math.max(0, value));
    this.history.push({
      timestamp: Date.now(),
      dim,
      delta: this.dims[dim] - old,
      reason: 'manual',
    });
    this.save();
  }

  /**
   * Adaptive update based on user feedback.
   * @param {string} signal — 'emotion_corrected', 'user_interrupted', 'user_expanded', 'user_ignored'
   * @param {object} context — { correctedEmotion, ... }
   */
  adapt(signal, context = {}) {
    switch (signal) {
      case 'emotion_corrected': {
        // User corrected the emotion tag → move dimensions
        const emo = context.correctedEmotion;
        const HEURISTICS = {
          sad:       { warmth: +0.05, empathy: +0.05 },
          angry:     { directness: -0.03, empathy: +0.02 },
          worried:   { empathy: +0.05, humor: -0.03 },
          encouraging: { warmth: +0.03, empathy: +0.02 },
          funny:     { humor: +0.05 },
          gentle:    { warmth: +0.05, directness: -0.02 },
          sarcastic: { humor: +0.03, directness: +0.02 },
        };
        const heur = HEURISTICS[emo] || {};
        for (const [dim, delta] of Object.entries(heur)) {
          this._adjust(dim, delta, `emotion corrected to ${emo}`);
        }
        break;
      }
      case 'user_interrupted':
        this._adjust('curiosity', -0.05, 'user interrupted');
        this._adjust('directness', +0.03, 'user interrupted');
        break;
      case 'user_expanded':
        this._adjust('curiosity', +0.03, 'user asked follow-up');
        break;
      case 'user_ignored':
        this._adjust('curiosity', -0.02, 'user ignored question');
        break;
    }
    this.save();
  }

  /** Generate LLM system prompt with personality instructions */
  formatForLLM() {
    const lines = [];
    for (const dim of DIMS) {
      const v = this.dims[dim];
      const idx = Math.min(4, Math.floor(v * 5));
      const label = DIM_LABELS[dim];
      const phrase = PHRASES[dim][idx];
      if (phrase) lines.push(`- ${label}(level ${idx}/4): ${phrase}`);
    }
    return '## Agent 人格参数\n' + lines.join('\n');
  }

  _adjust(dim, delta, reason) {
    const old = this.dims[dim];
    this.dims[dim] = Math.min(1, Math.max(0, old + delta));
    if (old !== this.dims[dim]) {
      this.history.push({ timestamp: Date.now(), dim, delta, reason });
    }
  }

  load() {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        this.dims = { ...this.dims, ...data.dims };
        this.history = data.history || [];
      }
    } catch {}
  }

  save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({ dims: this.dims, history: this.history.slice(-50) }, null, 2));
    } catch {}
  }
}

const DIM_LABELS = {
  warmth: '温暖度', humor: '幽默度', directness: '直接度',
  curiosity: '好奇心', empathy: '共情力',
};

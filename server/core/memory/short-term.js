/**
 * short-term.js — 短期工作记忆缓冲区
 *
 * 动态控制: 20轮上限 + 8000 token 总上限 + 简短确认压缩
 */
import { createModuleLogger } from '../../lib/debug-log.js';

const log = createModuleLogger('short-term');
const MAX_TURNS = 20;
const MAX_TOKENS = 8000;
const COMPRESSIBLE = /^(嗯|好的|明白了|收到|哦|行|知道了|OK|好的呢|没问题|可以的呢?|哈哈|嘿嘿)[\s。！!]*$/;

function estTokens(text) { return Math.ceil((text || '').length / 4); }

export class ShortTermMemory {
  constructor(maxTurns = MAX_TURNS) {
    this.maxTurns = maxTurns;
    this._turns = [];
    this._summaryBuffer = [];
    log.log(`init: maxTurns=${maxTurns} maxTokens=${MAX_TOKENS}`);
  }

  add(role, content, metadata = {}) {
    let text = content || '';
    if (role === 'assistant' && COMPRESSIBLE.test(text.trim())) {
      text = text.trim().slice(0, 10);
    }
    const turn = { role, content: text, timestamp: new Date().toISOString(), tokens: estTokens(text) };
    if (metadata.emotion) turn.emotion = metadata.emotion;
    this._turns.push(turn);

    // Token 超限 → 旧轮送入摘要缓冲区
    while (this.totalTokens > MAX_TOKENS && this._turns.length > 2) {
      this._summaryBuffer.push(this._turns.shift());
    }
    // 轮数超限
    while (this._turns.length > this.maxTurns) {
      this._summaryBuffer.push(this._turns.shift());
    }
  }

  drainSummaryBuffer() { const b = [...this._summaryBuffer]; this._summaryBuffer = []; return b; }

  getAll() { return this._turns.map(t => ({ role: t.role, content: t.content })); }

  getLast(n = 1) { return this._turns.slice(-n).map(t => ({ role: t.role, content: t.content })); }

  clear() { this._turns = []; this._summaryBuffer = []; }

  get size() { return this._turns.length; }

  get totalTokens() { return this._turns.reduce((s, t) => s + (t.tokens || 0), 0); }
}

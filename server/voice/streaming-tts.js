/**
 * streaming-tts.js — 流式 TTS 管线核心（纯服务端，无浏览器依赖）
 *
 * SentenceBuffer: LLM token 流 → 按中文标点拆分为可朗读短句
 * StreamingTTSManager: 接受拆分后的句子，管理播放队列和生命周期
 *
 * 浏览器端播放实现 → src/lib/streaming-tts-client.js
 */

import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('tts:stream');

// ── Sentence Buffer ──

const SENTENCE_BOUNDARY = /[。！？；\n！？…\.\!\?\;\n]+/;
const MIN_SPEAKABLE_LEN = 4;
const MAX_SPEAKABLE_LEN = 40;

export class SentenceBuffer {
  constructor(opts = {}) {
    this.minLen = opts.minSpeakableLen || MIN_SPEAKABLE_LEN;
    this.maxLen = opts.maxSpeakableLen || MAX_SPEAKABLE_LEN;
    this.buffer = '';
    this.emotion = 'neutral';
  }

  feed(chunk, emotion = null) {
    if (emotion) this.emotion = emotion;
    if (!chunk) return [];

    this.buffer += chunk;
    const sentences = [];
    const re = new RegExp(SENTENCE_BOUNDARY.source, 'g');
    let lastEnd = 0, match;

    while ((match = re.exec(this.buffer)) !== null) {
      const segment = this.buffer.slice(lastEnd, match.index + match[0].length).trim();
      if (segment.length >= this.minLen) {
        sentences.push({ text: segment, emotion: this.emotion });
        lastEnd = match.index + match[0].length;
      }
    }

    const remaining = this.buffer.slice(lastEnd);
    if (remaining.length >= this.maxLen) {
      const lastComma = Math.max(
        remaining.lastIndexOf('，'), remaining.lastIndexOf(','),
        remaining.lastIndexOf('、')
      );
      if (lastComma > this.minLen) {
        sentences.push({ text: remaining.slice(0, lastComma + 1).trim(), emotion: this.emotion });
        lastEnd += lastComma + 1;
      } else {
        sentences.push({ text: remaining.slice(0, this.maxLen).trim(), emotion: this.emotion });
        lastEnd += this.maxLen;
      }
    }

    this.buffer = this.buffer.slice(lastEnd).trim();
    return sentences;
  }

  flush() {
    const remaining = this.buffer.trim();
    this.buffer = '';
    return remaining.length > 0
      ? [{ text: remaining, emotion: this.emotion }]
      : [];
  }

  reset() { this.buffer = ''; this.emotion = 'neutral'; }
}

// ── Streaming TTS Manager (纯逻辑，不绑定播放后端) ──

export class StreamingTTSManager {
  constructor(opts = {}) {
    this.buffer = new SentenceBuffer({
      minSpeakableLen: opts.minSpeakableLen || 4,
      maxSpeakableLen: opts.maxSpeakableLen || 40,
    });
    this.playQueue = [];
    this.isPlaying = false;
    this.interrupted = false;
    this.onSentence = opts.onSentence || (() => {});   // ({text, emotion}) → Promise<void>
    this.onIdle = opts.onIdle || (() => {});
    this._emotionTagRe = /^\[emotion:(\w+)\]\s*/;
  }

  async feedLLMChunk(chunk) {
    if (this.interrupted) return;
    let cleaned = chunk;
    let detectedEmotion = null;
    const emoMatch = cleaned.match(this._emotionTagRe);
    if (emoMatch) {
      detectedEmotion = emoMatch[1];
      cleaned = cleaned.replace(this._emotionTagRe, '');
    }

    // 传递情绪给 buffer，使断句后的每句话都携带正确的情绪标签
    const sentences = this.buffer.feed(cleaned, detectedEmotion);
    for (const s of sentences) this.playQueue.push(s);
    if (!this.isPlaying) this._drainQueue();
  }

  async finalize() {
    for (const s of this.buffer.flush()) this.playQueue.push(s);
    while (this.playQueue.length > 0 || this.isPlaying) {
      await new Promise(r => setTimeout(r, 50));
    }
    this.onIdle();
  }

  interrupt() {
    this.interrupted = true;
    this.playQueue = [];
    this.buffer.reset();
    this.isPlaying = false;
  }

  reset() {
    this.interrupted = false;
    this.playQueue = [];
    this.buffer.reset();
    this.isPlaying = false;
  }

  async _drainQueue() {
    if (this.interrupted || this.playQueue.length === 0) {
      this.isPlaying = false;
      return;
    }
    this.isPlaying = true;
    const sentence = this.playQueue.shift();
    try {
      await this.onSentence(sentence);
    } catch (err) {
      log.warn(`TTS sentence failed: ${err.message}`);
    }
    if (!this.interrupted) setImmediate(() => this._drainQueue());
    else this.isPlaying = false;
  }
}

export function createStreamingPipeline(opts = {}) {
  return new StreamingTTSManager(opts);
}

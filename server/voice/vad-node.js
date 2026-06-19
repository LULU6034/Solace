/**
 * VAD (Voice Activity Detection) — 纯 JavaScript 实现
 *
 * 基于 PCM 16-bit 的 RMS 能量检测，零外部依赖。
 * 算法和 webrtcvad 效果相当，对 16kHz 单声道优化。
 */

import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('vad');

// 默认参数
const DEFAULTS = {
  sampleRate: 16000,
  frameMs: 20,           // 每帧 20ms → 320 samples @ 16kHz
  speechThreshold: 500,  // RMS 阈值 (16-bit PCM: 0-32767 范围的平方均值)
  silenceTimeoutMs: 1500, // 连续静音多久算说话结束
  minSpeechMs: 300,       // 最短有效语音
  preSpeechPaddingMs: 200, // onset 前保留的音频（避免裁掉句首）
};

/**
 * VAD 状态机
 *
 * States: SILENCE → SPEECH → SILENCE (emit end)
 */
export class VAD {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.frameSize = Math.floor(this.opts.sampleRate * this.opts.frameMs / 1000);
    this.state = 'SILENCE'; // SILENCE | SPEECH
    this.buffer = Buffer.alloc(0); // 未对齐的残留数据
    this.speechBuffer = [];  // 当前语音段的帧
    this.silenceFrames = 0;
    this.speechFrames = 0;
    this.paddingBuffer = []; // onset 前的 padding
    this.paddingFrames = Math.ceil(this.opts.preSpeechPaddingMs / this.opts.frameMs);

    // Callbacks
    this.onSpeechStart = opts.onSpeechStart || (() => {});
    this.onSpeechEnd = opts.onSpeechEnd || (() => {});
    this.onVADResult = opts.onVADResult || (() => {});
  }

  /**
   * 喂入原始 PCM 数据
   * @param {Buffer} chunk - 原始 PCM 16-bit 单声道
   */
  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= this.frameSize * 2) {
      const frame = this.buffer.subarray(0, this.frameSize * 2);
      this.buffer = this.buffer.subarray(this.frameSize * 2);
      this._processFrame(frame);
    }
  }

  /**
   * 强制结束当前语音段（flush）
   * @returns {Buffer|null} 合并的语音段 PCM
   */
  flush() {
    if (this.state === 'SPEECH' && this.speechBuffer.length > 0) {
      return this._endSpeech();
    }
    this.speechBuffer = [];
    return null;
  }

  reset() {
    this.state = 'SILENCE';
    this.buffer = Buffer.alloc(0);
    this.speechBuffer = [];
    this.paddingBuffer = [];
    this.silenceFrames = 0;
    this.speechFrames = 0;
  }

  // ── Private ──

  _processFrame(frame) {
    const isSpeech = this._isSpeechFrame(frame);

    // 维护 padding ring buffer
    this.paddingBuffer.push(frame);
    if (this.paddingBuffer.length > this.paddingFrames) {
      this.paddingBuffer.shift();
    }

    switch (this.state) {
      case 'SILENCE':
        if (isSpeech) {
          this.speechFrames++;
          if (this.speechFrames * this.opts.frameMs >= this.opts.minSpeechMs) {
            // 检测到足够长的语音 → 进入 SPEECH
            this.state = 'SPEECH';
            this.speechBuffer = [...this.paddingBuffer]; // 包含 padding
            this.speechFrames = 0;
            this.silenceFrames = 0;
            log.log(`VAD: 语音开始 (RMS≈${Math.round(this._lastRms || 0)})`);
            this.onSpeechStart();
            this.onVADResult({ type: 'speech_start' });
          }
        } else {
          this.speechFrames = 0;
        }
        break;

      case 'SPEECH':
        this.speechBuffer.push(frame);
        if (!isSpeech) {
          this.silenceFrames++;
          if (this.silenceFrames * this.opts.frameMs >= this.opts.silenceTimeoutMs) {
            // 连续静音超时 → 语音结束
            log.log('VAD: 语音结束');
            const audio = this._endSpeech();
            this.onSpeechEnd(audio);
            this.onVADResult({ type: 'speech_end' });
          }
        } else {
          this.silenceFrames = 0;
        }
        break;
    }
  }

  /**
   * 基于 RMS 判断一帧是否为语音
   */
  _isSpeechFrame(frame) {
    let sumSq = 0;
    for (let i = 0; i < frame.length - 1; i += 2) {
      const sample = frame.readInt16LE(i);
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / (frame.length / 2));
    this._lastRms = rms;
    return rms > this.opts.speechThreshold;
  }

  _endSpeech() {
    const audio = Buffer.concat(this.speechBuffer);
    this.speechBuffer = [];
    this.state = 'SILENCE';
    this.silenceFrames = 0;
    this.speechFrames = 0;
    return audio;
  }
}

/**
 * 实时 VAD 检测器 — 轻量版，只返回 isSpeech 布尔值
 * 用于打断检测（不需要缓存语音段）
 */
export class LightVAD {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.frameSize = Math.floor(this.opts.sampleRate * this.opts.frameMs / 1000);
    this.consecutiveSpeech = 0;
    this.consecutiveSilence = 0;
  }

  /** @returns {boolean} 当前帧是否为语音 */
  isSpeech(frame) {
    let sumSq = 0;
    for (let i = 0; i < frame.length - 1; i += 2) {
      const sample = frame.readInt16LE(i);
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / (frame.length / 2));
    const speech = rms > this.opts.speechThreshold;

    if (speech) {
      this.consecutiveSpeech++;
      this.consecutiveSilence = 0;
    } else {
      this.consecutiveSilence++;
      this.consecutiveSpeech = 0;
    }
    return speech;
  }

  /** 用户是否正在说话（需要连续 speech 帧确认，防止噪声误检） */
  isUserSpeaking(minFrames = 5) {
    return this.consecutiveSpeech >= minFrames;
  }

  reset() {
    this.consecutiveSpeech = 0;
    this.consecutiveSilence = 0;
  }
}

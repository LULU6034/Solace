/**
 * TTS Client — Sonder 语音合成客户端
 *
 * 引擎: CosyVoice2-0.5B (本地 Python HTTP)
 * 降级: 纯文字模式
 *
 * 支持流式合成 (chunked WAV) 和批量合成
 */

import http from 'node:http';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('tts');

// ── CosyVoice Provider ──

class CosyVoiceProvider {
  constructor(host = '127.0.0.1', port = 5001) {
    this.base = `http://${host}:${port}`;
    this.healthy = false;
    this.consecutiveErrors = 0;
  }

  async healthCheck() {
    try {
      const res = await this._get('/health');
      this.healthy = res.status === 'ok';
      if (this.healthy) this.consecutiveErrors = 0;
      return this.healthy;
    } catch {
      this.consecutiveErrors++;
      this.healthy = false;
      return false;
    }
  }

  /** Stream TTS — returns async iterable of {sampleRate, audio: Buffer} chunks */
  async *synthesizeStream(text, { emotion = 'neutral', voiceId = 'default_female', speed = 1.0 } = {}) {
    const body = JSON.stringify({ text, emotion, voice_id: voiceId, speed, stream: true });
    const res = await this._post('/tts/generate', body, { stream: true });

    if (res.statusCode === 503) {
      throw new Error('CosyVoice model not loaded');
    }

    // Read chunks from streaming response
    for await (const chunk of res) {
      if (chunk.length > 44) { // WAV header is 44 bytes, skip empty
        yield { sampleRate: 24000, audio: chunk };
      }
    }

    this.consecutiveErrors = 0;
    this.healthy = true;
  }

  /** Batch TTS — returns {sampleRate, audio: Buffer} */
  async synthesize(text, { emotion = 'neutral', voiceId = 'default_female', speed = 1.0 } = {}) {
    const body = JSON.stringify({ text, emotion, voice_id: voiceId, speed, stream: false });
    const res = await this._post('/tts/generate', body);

    if (res.statusCode === 503) throw new Error('CosyVoice model not loaded');
    if (res.statusCode !== 200) throw new Error(`CosyVoice error: ${res.statusCode}`);

    const buffers = [];
    for await (const chunk of res) buffers.push(chunk);
    const audio = Buffer.concat(buffers);
    const sampleRate = parseInt(res.headers['x-sample-rate'] || '24000', 10);

    this.consecutiveErrors = 0;
    this.healthy = true;
    return { sampleRate, audio };
  }

  async getVoices() {
    try {
      const res = await this._get('/tts/voices');
      return res.voices || [];
    } catch { return []; }
  }

  _get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${this.base}${path}`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Invalid JSON: ${data.slice(0,200)}`)); }
        });
      }).on('error', reject);
    });
  }

  _post(path, body, opts = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.base}${path}`);
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        resolve(res); // Return raw response (for both stream and batch)
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

// ── TTS Manager ──

const DEGRADE_THRESHOLD = 3;         // 3 consecutive errors → degrade
const RECOVERY_INTERVAL_MS = 300_000; // 5 minutes between recovery attempts

class TTSManager {
  constructor(opts = {}) {
    this.cosyvoice = new CosyVoiceProvider(opts.cosyvoiceHost || '127.0.0.1', opts.cosyvoicePort || 5001);
    this.mode = 'cosyvoice'; // 'cosyvoice' | 'textonly'
    this.lastRecoveryAttempt = 0;
  }

  /** Get current TTS status */
  async status() {
    const cvOk = await this.cosyvoice.healthCheck();
    return {
      mode: this.mode,
      cosyvoice: { healthy: cvOk, errors: this.cosyvoice.consecutiveErrors },
    };
  }

  /**
   * Synthesize speech — streaming.
   * CosyVoice → text-only on failure, auto-recover.
   */
  async *synthesizeStream(text, opts = {}) {
    // Try recovery if in degraded mode
    if (this.mode === 'textonly' && Date.now() - this.lastRecoveryAttempt > RECOVERY_INTERVAL_MS) {
      this.lastRecoveryAttempt = Date.now();
      const ok = await this.cosyvoice.healthCheck();
      if (ok) {
        log.log('CosyVoice recovered, switching back');
        this.mode = 'cosyvoice';
      }
    }

    if (this.mode === 'cosyvoice') {
      try {
        for await (const chunk of this.cosyvoice.synthesizeStream(text, opts)) {
          yield { ...chunk, engine: 'cosyvoice' };
        }
        this.cosyvoice.consecutiveErrors = 0;
        this.cosyvoice.healthy = true;
        return;
      } catch (err) {
        this.cosyvoice.consecutiveErrors++;
        this.cosyvoice.healthy = false;
        log.warn(`CosyVoice failed (${this.cosyvoice.consecutiveErrors}/${DEGRADE_THRESHOLD}): ${err.message}`);
        if (this.cosyvoice.consecutiveErrors >= DEGRADE_THRESHOLD) {
          log.warn('Degrading to text-only mode');
          this.mode = 'textonly';
        }
        // Fall through to text-only
      }
    }

    // text-only mode
    log.warn('TTS in text-only mode');
    yield { sampleRate: 24000, audio: Buffer.alloc(0), engine: 'textonly' };
  }

  /** Non-streaming synthesize */
  async synthesize(text, opts = {}) {
    const chunks = [];
    for await (const chunk of this.synthesizeStream(text, opts)) {
      chunks.push(chunk.audio);
    }
    return { sampleRate: 24000, audio: Buffer.concat(chunks), engine: this.mode };
  }

  /** Manual recovery attempt */
  async attemptRecovery() {
    this.lastRecoveryAttempt = Date.now();
    const ok = await this.cosyvoice.healthCheck();
    if (ok) {
      this.mode = 'cosyvoice';
      return { recovered: true, engine: 'cosyvoice' };
    }
    return { recovered: false, engine: 'textonly' };
  }
}

// Singleton
let _ttsManager = null;

export function getTTSManager(opts) {
  if (!_ttsManager) {
    _ttsManager = new TTSManager(opts);
  }
  return _ttsManager;
}

export { CosyVoiceProvider, TTSManager };

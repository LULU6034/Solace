/**
 * MiniMax TTS 客户端 — 服务端版
 *
 * 从 electron/ipc/voice-ipc.cjs 迁移到服务端，
 * 全双工架构下 TTS 直接由服务器调用，不走 Electron IPC。
 *
 * API: POST https://api.minimax.chat/v1/t2a_v2
 * 模型: speech-2.8-turbo
 */

import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('minimax-tts');

// ── 情绪预设 ──
const EMOTION_PRESETS = {
  happy:       { speedMul: 0.98 },
  sad:         { speedMul: 0.78 },
  angry:       { speedMul: 1.02 },
  worried:     { speedMul: 0.82 },
  encouraging: { speedMul: 0.94 },
  funny:       { speedMul: 0.96 },
  sarcastic:   { speedMul: 0.94 },
  gentle:      { speedMul: 0.75 },
  neutral:     { speedMul: 0.90 },
};

// ── 音色 ──
const MINIMAX_VOICES = {
  default_female: 'Chinese (Mandarin)_Unrestrained_Young_Man',
  default_male: 'male-qn-jingying',
  gentle_female: 'female-yousheng',
  young_male: 'male-qn-qingse',
};

const MINIMAX_TTS_URL = 'https://api.minimax.chat/v1/t2a_v2';

/**
 * MiniMax TTS 管理器
 */
export class MiniMaxTTS {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || '';
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  /**
   * 合成语音（非流式，返回完整音频 Buffer）
   *
   * @param {string} text - 要合成的文本
   * @param {object} opts
   * @param {string} opts.emotion - 情绪标签
   * @param {string} opts.voiceId - 音色 ID
   * @param {number} opts.speed - 语速倍数
   * @returns {Promise<{audio: Buffer, mime: string, duration: number}>}
   */
  async synthesize(text, opts = {}) {
    if (!this.apiKey) throw new Error('MiniMax API Key 未配置');
    if (!text?.trim()) return { audio: Buffer.alloc(0), mime: 'audio/mp3', duration: 0 };

    const voiceId = MINIMAX_VOICES[opts.voiceId] || MINIMAX_VOICES.default_female;
    const preset = EMOTION_PRESETS[opts.emotion] || EMOTION_PRESETS.neutral;
    const speed = Math.max(0.5, Math.min(2.0, (parseFloat(opts.speed) || 1.0) * preset.speedMul));

    log.log(`TTS: "${text.slice(0, 30)}..." | len=${text.length} | speed=${speed}`);

    // 用外部传入的 signal（支持打断取消），否则用 30 秒超时兜底
    const signal = opts.signal || AbortSignal.timeout(30_000);

    try {
      const res = await fetch(MINIMAX_TTS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'speech-2.8-turbo',
          text,
          stream: false,
          voice_setting: {
            voice_id: voiceId,
            speed,
            vol: 1.0,
          },
          audio_setting: {
            sample_rate: 32000,
            format: 'mp3',
          },
          language_boost: 'auto',
        }),
        signal,
      });

      const json = await res.json();

      if (json.base_resp?.status_code !== 0) {
        throw new Error(json.base_resp?.status_msg || 'MiniMax API error');
      }

      const audioRaw = json.data?.audio || json.audio;
      if (!audioRaw) throw new Error('MiniMax 返回空音频');

      // MiniMax 返回 hex 编码的 mp3
      const audioBuf = Buffer.from(audioRaw, 'hex');
      log.log(`TTS 完成: ${audioBuf.length} bytes`);

      return {
        audio: audioBuf,
        mime: 'audio/mp3',
        duration: 0, // MiniMax 不返回时长
      };
    } catch (err) {
      log.error('MiniMax TTS 失败:', err.message);
      throw err;
    }
  }
}

// ── 文本预处理（与前端 VoiceChat.vue 一致）──
export function polishForTTS(text) {
  return (text || '')
    .replace(/\[(?:emotion:\w+|speed:[\d.]+)\]/g, '')
    .replace(/\bspeed:[\d.]+\b/gi, '')
    .replace(/\*([^*]+)\*/g, '……$1……')
    // 中文语气词 → 已被确认可用的 MiniMax 发声标签
    .replace(/(?<!\()哈{3,}/g, '(laughs)')
    .replace(/(?<!\()哈哈(?!哈)/g, '(chuckle)')
    .replace(/(?<!\()嘿嘿/g, '(chuckle)')
    .replace(/(?<!\()嘻嘻/g, '(chuckle)')
    .replace(/(?<!\()咳咳/g, '(coughs)')
    .replace(/(?<!\()唉/g, '(sighs)')
    .replace(/(?<!\()哼哼/g, '(groans)')
    // 英文单词 → 标签（只加括号，已有括号的不重复加）
    .replace(/(?<!\()\bbreaths?\b(?![\s]*\))/gi, '(breath)')
    .replace(/(?<!\()\bchuckles?\b(?![\s]*\))/gi, '(chuckle)')
    .replace(/(?<!\()\bcoughs?\b(?![\s]*\))/gi, '(coughs)')
    .replace(/(?<!\()\bexhales?\b(?![\s]*\))/gi, '(exhale)')
    .replace(/(?<!\()\bgroans?\b(?![\s]*\))/gi, '(groans)')
    .replace(/(?<!\()\binhales?\b(?![\s]*\))/gi, '(inhale)')
    .replace(/(?<!\()\blaughs?\b(?![\s]*\))/gi, '(laughs)')
    .replace(/(?<!\()\bsighs?\b(?![\s]*\))/gi, '(sighs)')
    .replace(/(?<!\()\bsnorts?\b(?![\s]*\))/gi, '(snorts)')
    .replace(/(?<!\()\bsniffs?\b(?![\s]*\))/gi, '(sniffs)')
    // 修复多括号: (((xxx))) → (xxx)（Agent 偶尔多加括号）
    .replace(/\(+\((laughs|chuckle|sighs|coughs|breath|inhale|exhale|snorts|sniffs|groans)\)\)+/gi, '($1)')
    .replace(/[，,]\s*/g, '，')
    .replace(/[。.]\s*/g, '。')
    .replace(/[？?]\s*/g, '？')
    .replace(/[！!]\s*/g, '！')
    .replace(/[；;]\s*/g, '；')
    .replace(/([。？！])/g, '$1 ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 清理显示文本：去掉速度标签、MiniMax 发声标签，保留中文语气词 */
export function cleanDisplayText(text) {
  return (text || '')
    .replace(/\bspeed:[\d.]+\b/gi, '')
    .replace(/\[emotion:\w+\]/gi, '')
    .replace(/\(+(laughs|chuckle|sighs|coughs|breath|inhale|exhale|snorts|sniffs|groans)\)+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

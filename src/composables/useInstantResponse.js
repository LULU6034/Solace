/**
 * instant-response.js — 雾蓝风格即时语音反馈
 *
 * 用户说完 → 立即播放预合成短音频 → LLM 响应到达后无缝切换
 * 预合成音频: 纯 Web Audio API，无网络/文件依赖
 *
 * 类型:
 *   ack: 柔和的确认音 (80ms) — 用户说完瞬间播放
 *   thinking_start: 持续微弱低频音 — 表示正在思考
 *   error: 柔和低沉提示 — 出错
 */

const TONES = {
  ack: {
    // 柔和双音 — 低→高，像轻触水晶杯
    duration: 0.08,
    build(ac, t) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, t);
      osc.frequency.linearRampToValueAtTime(780, t + 0.04);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.04, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
      osc.start(t); osc.stop(t + 0.12);
    },
  },
  thinking_start: {
    // 极轻柔低吟
    duration: 0.5,
    build(ac, t) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(180, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.025, t + 0.3);
      gain.gain.linearRampToValueAtTime(0.015, t + 0.5);
      osc.start(t); osc.stop(t + 0.5);
    },
  },
  error: {
    // 柔和低音下沉 — 不刺耳
    duration: 0.2,
    build(ac, t) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(300, t);
      osc.frequency.linearRampToValueAtTime(160, t + 0.15);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.04, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      osc.start(t); osc.stop(t + 0.25);
    },
  },
};

import { getSharedAudioContext } from './useAudioContext.js';

export function playInstantTone(type = 'ack') {
  try {
    const ac = getSharedAudioContext();
    const tone = TONES[type];
    if (tone) {
      tone.build(ac, ac.currentTime);
    }
  } catch {
    // Silently fail — audio feedback is non-critical
  }
}

export function unlockAudio() {
  getSharedAudioContext().resume();
}

export function speakInstant(text, rate = 1.2) {
  try {
    const synth = window.speechSynthesis;

    if (!speakInstant._voicesLoaded) {
      const voices = synth?.getVoices() || [];
      speakInstant._voice = voices.find(v => v.lang.startsWith('zh-CN') && v.localService)
        || voices.find(v => v.lang.startsWith('zh-CN'))
        || voices.find(v => v.lang.startsWith('zh'))
        || voices[0];
      speakInstant._voicesLoaded = true;
      speakInstant._useServer = (voices.length === 0);
    }

    if (speakInstant._useServer) {
      window.electronAPI?.voiceTtsSynthesize?.(text, 'neutral', 'default_female', rate)
        .then(r => {
          if (r?.audio) {
            const raw = Uint8Array.from(atob(r.audio), c => c.charCodeAt(0))
            const blob = new Blob([raw], { type: 'audio/wav' })
            const url = URL.createObjectURL(blob)
            const a = new Audio(url)
            a.onended = () => URL.revokeObjectURL(url)
            a.play().catch(() => {})
          }
        }).catch(() => {})
      return;
    }

    if (synth && speakInstant._voice) {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate; u.volume = 0.9; u.lang = 'zh-CN';
      u.voice = speakInstant._voice;
      setTimeout(() => synth.speak(u), 50);
    }
  } catch (e) {}
}

export function preCacheVoice() {
  const voices = window.speechSynthesis?.getVoices() || [];
  speakInstant._voice = voices.find(v => v.lang.startsWith('zh-CN') && v.localService)
    || voices.find(v => v.lang.startsWith('zh-CN'))
    || voices[0];
  return !!speakInstant._voice;
}

if (typeof window !== 'undefined') {
  window.speechSynthesis?.addEventListener?.('voiceschanged', preCacheVoice);
}

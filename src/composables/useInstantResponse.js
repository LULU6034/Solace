/**
 * instant-response.js — 即时语音反馈 (0ms 延迟)
 *
 * 用户说完 → 立即播放预合成短音频 → LLM 响应到达后无缝切换
 *
 * 预合成音频: 使用 Web Audio API 生成，无需网络/文件加载
 * 类型:
 *   - ack: 短促确认音 (100ms) — 用户说完瞬间播放
 *   - thinking: 持续微弱音 (循环) — 表示正在思考
 *   - backchannel: "嗯" / "哦" — 自然反馈词
 *
 * 延迟分析:
 *   audioCtx.currentTime 精度: ~3ms
 *   oscillator.start(t): ~0ms (计划在 t 时刻开始)
 *   总用户感知延迟: <10ms
 */

const TONES = {
  ack: {
    // Soft rising "bliip" — 确认收到
    duration: 0.12,
    build(ac, t) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, t);
      osc.frequency.linearRampToValueAtTime(1200, t + 0.06);
      osc.frequency.linearRampToValueAtTime(900, t + 0.12);
      gain.gain.setValueAtTime(0.06, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.15);
      osc.start(t); osc.stop(t + 0.15);
    },
  },
  thinking_start: {
    // Very soft low hum — 开始思考
    duration: 0.5,
    build(ac, t) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220, t);
      gain.gain.setValueAtTime(0.02, t);
      gain.gain.linearRampToValueAtTime(0.04, t + 0.25);
      gain.gain.linearRampToValueAtTime(0.02, t + 0.5);
      osc.start(t); osc.stop(t + 0.5);
    },
  },
  error: {
    // Soft "bloop" — 出错提示
    duration: 0.2,
    build(ac, t) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(400, t);
      osc.frequency.linearRampToValueAtTime(200, t + 0.15);
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.25);
      osc.start(t); osc.stop(t + 0.25);
    },
  },
};

/**
 * Play an instant acknowledgment tone.
 * Returns immediately (schedules in Web Audio future).
 */
export function playInstantTone(type = 'ack') {
  try {
    // Reuse or create AudioContext — lazy init
    if (!playInstantTone._ac) {
      playInstantTone._ac = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ac = playInstantTone._ac;
    if (ac.state === 'suspended') ac.resume();

    const tone = TONES[type];
    if (tone) {
      tone.build(ac, ac.currentTime);
    }
  } catch {
    // Silently fail — audio feedback is non-critical
  }
}

/** Resume AudioContext (call in click handler to unlock audio) */
export function unlockAudio() {
  playInstantTone._ac?.resume();
}

/**
 * Speak a short pre-written phrase using SpeechSynthesis.
 * Blocks any currently-playing speech (interrupts).
 */
export function speakInstant(text, rate = 1.2) {
  try {
    const synth = window.speechSynthesis;

    // First call: check voice availability
    if (!speakInstant._voicesLoaded) {
      const voices = synth?.getVoices() || [];
      speakInstant._voice = voices.find(v => v.lang.startsWith('zh-CN') && v.localService)
        || voices.find(v => v.lang.startsWith('zh-CN'))
        || voices.find(v => v.lang.startsWith('zh'))
        || voices[0];
      speakInstant._voicesLoaded = true;
      speakInstant._useServer = (voices.length === 0);
      console.log('[speakInstant] voices:', voices.length, 'server fallback:', speakInstant._useServer);
    }

    // 本地语音不可用 → 走 CosyVoice
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

    // 本地语音
    if (synth && speakInstant._voice) {
      console.log('[speakInstant] local speak:', text.slice(0, 30));
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate; u.volume = 0.9; u.lang = 'zh-CN';
      u.voice = speakInstant._voice;
      u.onstart = () => console.log('[speakInstant] local speak started');
      u.onend = () => console.log('[speakInstant] local speak ended');
      u.onerror = (e) => console.warn('[speakInstant] local speak error:', e.error);
      setTimeout(() => synth.speak(u), 50);
    } else {
      console.log('[speakInstant] no local voice available, no server fallback');
    }
  } catch (e) { console.warn('[speakInstant] error:', e.message); }
}

/** Pre-cache Chinese voice for instant use */
export function preCacheVoice() {
  const voices = window.speechSynthesis?.getVoices() || [];
  speakInstant._voice = voices.find(v => v.lang.startsWith('zh-CN') && v.localService)
    || voices.find(v => v.lang.startsWith('zh-CN'))
    || voices[0];
  return !!speakInstant._voice;
}

// Auto-cache on voice list change
if (typeof window !== 'undefined') {
  window.speechSynthesis?.addEventListener?.('voiceschanged', preCacheVoice);
}

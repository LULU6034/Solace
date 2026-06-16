/**
 * Ambient Sound — 雾蓝风格环境音效
 *
 * 零文件依赖，纯 Web Audio API 合成。
 * idle: 以太风 — 极低频正弦波 + 慢 LFO，像远处风声
 * listening: 柔铃 — 散开的柔和正弦短音
 * thinking: 轻脉 — 极轻柔的低频脉冲，像心跳
 */

import { getSharedAudioContext } from './useAudioContext.js';

class AmbientSound {
  constructor() {
    this.ac = null;
    this.masterGain = null;
    this.activeNodes = [];
    this.mode = null;
  }

  _ensureContext() {
    if (!this.ac) {
      this.ac = getSharedAudioContext();
      this.masterGain = this.ac.createGain();
      this.masterGain.gain.value = 0;
      this.masterGain.connect(this.ac.destination);
    }
    if (this.ac.state === 'suspended') this.ac.resume();
  }

  async start(mode = 'idle') {
    this._ensureContext();
    this.stop();
    this.mode = mode;

    switch (mode) {
      case 'idle': this._etherWind(); break;
      case 'listening': this._softChime(); break;
      case 'thinking': this._gentlePulse(); break;
      case 'error': this._softBell(); break;
    }

    this.masterGain.gain.setTargetAtTime(1, this.ac.currentTime, 1.5);
  }

  transition(mode) {
    if (mode === this.mode) return;
    this.start(mode);
  }

  stop() {
    this._clearNodes();
    this.mode = null;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(0, this.ac.currentTime, 1);
    }
  }

  setVolume(v) {
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(v, this.ac.currentTime, 0.5);
    }
  }

  destroy() {
    this._clearNodes();
    if (this.ac) {
      this.ac.close();
      this.ac = null;
    }
  }

  // ═══════════════════════════════════════
  //  Sound generators
  // ═══════════════════════════════════════

  _etherWind() {
    // 极低频正弦波 + 慢 LFO 调制，像远处微风
    const now = this.ac.currentTime;

    // 基频 — 极低，几乎听不到，提供"存在感"
    const osc = this.ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 38;

    // LFO 调制频率 — 慢速起伏
    const lfo = this.ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.12; // 8秒一个周期
    const lfoGain = this.ac.createGain();
    lfoGain.gain.value = 3; // ±3Hz 偏移
    lfo.connect(lfoGain).connect(osc.frequency);

    // 泛音 — 轻微的第二频段
    const osc2 = this.ac.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 56;
    const lfo2 = this.ac.createOscillator();
    lfo2.type = 'sine';
    lfo2.frequency.value = 0.09;
    const lfoGain2 = this.ac.createGain();
    lfoGain2.gain.value = 2;
    lfo2.connect(lfoGain2).connect(osc2.frequency);

    // 低通滤波
    const lp = this.ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 120;
    lp.Q.value = 0.3;

    const gain = this.ac.createGain();
    gain.gain.value = 0.04;

    osc.connect(lp);
    osc2.connect(lp);
    lp.connect(gain).connect(this.masterGain);

    osc.start(now); osc2.start(now);
    lfo.start(now); lfo2.start(now);

    this._addNode(osc, osc2, lfo, lfo2, lfoGain, lfoGain2, lp, gain);
  }

  _softChime() {
    // 柔和散开的几个正弦短音 — 冰晶轻碰
    const now = this.ac.currentTime;
    const freqs = [880, 1100, 1320];
    for (let i = 0; i < freqs.length; i++) {
      const osc = this.ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freqs[i];
      const gain = this.ac.createGain();
      const t = now + i * 0.08;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.05, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
      osc.connect(gain).connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.9);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    }
  }

  _gentlePulse() {
    // 极轻柔低频脉冲 — 像远处心跳
    const now = this.ac.currentTime;

    const osc = this.ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 50;

    const lfo = this.ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 1.2; // 72bpm 心跳节奏
    const lfoGain = this.ac.createGain();
    lfoGain.gain.value = 4;
    lfo.connect(lfoGain).connect(osc.frequency);

    const gain = this.ac.createGain();
    gain.gain.value = 0.02;
    // 脉动音量
    const volLfo = this.ac.createOscillator();
    volLfo.type = 'sine';
    volLfo.frequency.value = 1.2;
    const volLfoGain = this.ac.createGain();
    volLfoGain.gain.value = 0.01;
    volLfo.connect(volLfoGain);
    volLfoGain.connect(gain.gain);

    const lp = this.ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 100;

    osc.connect(lp).connect(gain).connect(this.masterGain);
    osc.start(now);
    lfo.start(now);
    volLfo.start(now);

    this._addNode(osc, lfo, volLfo, lfoGain, volLfoGain, lp, gain);
  }

  _softBell() {
    // 柔和低音铃 — 不刺耳的提醒
    const now = this.ac.currentTime;
    const osc = this.ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(260, now);
    osc.frequency.linearRampToValueAtTime(180, now + 0.6);
    const gain = this.ac.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.06, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    osc.connect(gain).connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 1.3);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }

  // ═══════════════════════════════════════

  _addNode(...nodes) {
    this.activeNodes.push(...nodes);
  }

  _clearNodes() {
    for (const n of this.activeNodes) {
      try { n.stop?.(); n.disconnect?.(); } catch {}
    }
    this.activeNodes = [];
    if (this._timers) {
      this._timers.forEach(clearInterval);
      this._timers = [];
    }
  }
}

let _instance = null;
export function getAmbientSound() {
  if (!_instance) _instance = new AmbientSound();
  return _instance;
}
export { AmbientSound };

/**
 * Ambient Sound — Web Audio 合成的环境音效
 *
 * 零文件依赖，纯 Web Audio API 合成。
 *
 * 用法:
 *   import { AmbientSound } from './ambient-sound.js'
 *   const ambient = new AmbientSound()
 *   ambient.start('idle')
 *   ambient.transition('thinking')
 *   ambient.stop()
 */

import { getSharedAudioContext } from './useAudioContext.js';

class AmbientSound {
  constructor() {
    this.ac = null;
    this.masterGain = null;
    this.activeNodes = [];
    this.mode = null;
    this._initOnInteraction = null;
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
      case 'idle': this._fireplace(); break;
      case 'listening': this._windChime(); break;
      case 'thinking': this._lowHum(); break;
      case 'error': this._lowBell(); break;
    }

    // Fade in
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

  _fireplace() {
    // Filtered white noise with random crackle bursts
    const now = this.ac.currentTime;
    const duration = 999; // effectively infinite

    // Base noise (gentle rumble)
    const bufSize = this.ac.sampleRate * 2;
    const noiseBuf = this.ac.createBuffer(1, bufSize, this.ac.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = this.ac.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;

    // Low-pass filter for warmth
    const lp = this.ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 600;
    lp.Q.value = 0.5;

    const gain = this.ac.createGain();
    gain.gain.value = 0.06;

    noise.connect(lp).connect(gain).connect(this.masterGain);
    noise.start(now);
    this._addNode(noise, lp, gain);

    // Periodic crackle (every 0.3-1.5s random burst)
    const crackleTimer = setInterval(() => {
      if (this.mode !== 'idle') return;
      const burst = this.ac.createBufferSource();
      const blen = this.ac.sampleRate * 0.04;
      const bdata = this.ac.createBuffer(1, blen, this.ac.sampleRate).getChannelData(0);
      for (let i = 0; i < blen; i++) {
        bdata[i] = Math.random() * 2 - 1;
        // Shaped envelope: sharp attack, quick decay
        bdata[i] *= Math.exp(-i / (this.ac.sampleRate * 0.015));
      }
      burst.buffer = this.ac.createBuffer(1, blen, this.ac.sampleRate);
      burst.buffer.getChannelData(0).set(bdata);

      const bg = this.ac.createGain();
      bg.gain.value = 0.25 + Math.random() * 0.15;
      burst.connect(bg).connect(this.masterGain);
      burst.start();
      burst.onended = () => { burst.disconnect(); bg.disconnect(); };
    }, 400 + Math.random() * 800);

    this._timers = this._timers || [];
    this._timers.push(crackleTimer);
  }

  _windChime() {
    // Two quick sine tones with decay — like a wind chime
    const now = this.ac.currentTime;
    const freqs = [1200, 1600, 2100];
    for (const f of freqs) {
      const osc = this.ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const gain = this.ac.createGain();
      gain.gain.setValueAtTime(0.08, now + Math.random() * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
      osc.connect(gain).connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 1.3);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    }
  }

  _lowHum() {
    // Very low sustained hum — creates thinking atmosphere
    const now = this.ac.currentTime;
    const osc = this.ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 55; // Low A

    const osc2 = this.ac.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 82; // Slightly detuned

    const gain = this.ac.createGain();
    gain.gain.value = 0.04;

    const lp = this.ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 200;

    osc.connect(gain);
    osc2.connect(gain);
    gain.connect(lp).connect(this.masterGain);
    osc.start(now);
    osc2.start(now);
    this._addNode(osc, osc2, gain, lp);
  }

  _lowBell() {
    // Low bell tone — error notification
    const now = this.ac.currentTime;
    const osc = this.ac.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.linearRampToValueAtTime(120, now + 0.8);
    const gain = this.ac.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);
    osc.connect(gain).connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 1.6);
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

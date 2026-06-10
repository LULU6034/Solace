/**
 * Voice Session Manager — 语音会话状态机
 *
 * 状态: IDLE → LISTENING → THINKING → SPEAKING → IDLE
 *
 * 管理单次语音对话的完整生命周期：
 * - STT 识别
 * - LLM 对话
 * - TTS 合成与流式播放
 * - 打断检测
 * - 降级处理
 */

import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('voice-session');

// ── State Machine ──
const STATES = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
};

const STATE_TRANSITIONS = {
  [STATES.IDLE]:      [STATES.LISTENING],
  [STATES.LISTENING]: [STATES.THINKING, STATES.IDLE],
  [STATES.THINKING]:  [STATES.SPEAKING, STATES.IDLE, STATES.LISTENING],
  [STATES.SPEAKING]:  [STATES.IDLE, STATES.LISTENING],
};

// ── Silence detection ──
const SILENCE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes → auto return to IDLE
const TURN_SILENCE_MS = 2000;              // 2s silence → end of turn

class VoiceSession {
  constructor(opts = {}) {
    this.sessionId = opts.sessionId || generateId();
    this.agentId = opts.agentId || 'default';
    this.state = STATES.IDLE;
    this.createdAt = Date.now();

    // TTS playback
    this.ttsQueue = [];
    this.currentTtsChunk = null;
    this.isPlaying = false;

    // Interruption
    this.pendingCancels = [];
    this.interruptRequested = false;

    // Turn tracking
    this.turnCount = 0;
    this.turns = []; // { role, text, emotion, timestamp }

    // Callbacks
    this.onStateChange = opts.onStateChange || (() => {});
    this.onSubtitle = opts.onSubtitle || (() => {});
    this.onError = opts.onError || (() => {});

    // Timers
    this.silenceTimer = null;
    this.thinkTimer = null;

    // Silence tracking
    this.lastActivity = Date.now();
    this.silenceCheckInterval = setInterval(() => this._checkSilence(), 30_000);
  }

  // ── State transitions ──

  transition(newState, reason = '') {
    if (!STATE_TRANSITIONS[this.state]?.includes(newState)) {
      log.warn(`无效状态转换: ${this.state} → ${newState} (${reason})`);
      this.onError({ type: 'invalid_transition', message: `不能从 ${this.state} 切换到 ${newState}` });
      return false;
    }

    const oldState = this.state;
    this.state = newState;
    this.lastActivity = Date.now();

    log.log(`State: ${oldState} → ${newState} (${reason})`);
    this.onStateChange({ oldState, newState, reason, sessionId: this.sessionId });

    // Clear think timer when leaving THINKING
    if (oldState === STATES.THINKING && this.thinkTimer) {
      clearTimeout(this.thinkTimer);
      this.thinkTimer = null;
    }

    return true;
  }

  // ── Public API ──

  /** User starts speaking — move to LISTENING */
  startListening() {
    if (this.state === STATES.SPEAKING) {
      // Interrupt: stop playing
      this.interruptRequested = true;
      this._clearTtsQueue();
    }
    this.transition(STATES.LISTENING, 'user started speaking');
    this._resetSilenceTimer();
  }

  /** STT complete — move to THINKING, call LLM */
  async submitSpeech(text, { onLLMChunk, onLLMDone } = {}) {
    if (this.state !== STATES.LISTENING) return null;

    this.transition(STATES.THINKING, 'speech submitted');
    this.turnCount++;
    this.turns.push({
      role: 'user',
      text,
      emotion: null, // filled by emotion detector
      timestamp: Date.now(),
    });

    // Emit subtitle
    this.onSubtitle({ role: 'user', text, turnId: this.turnCount });

    // Set thinking timeout
    this.thinkTimer = setTimeout(() => {
      if (this.state === STATES.THINKING) {
        log.warn('LLM thinking timeout (15s)');
        this.onError({ type: 'thinking_timeout', message: 'LLM 响应超时' });
      }
    }, 15_000);

    return { sessionId: this.sessionId, turnId: this.turnCount, text };
  }

  /** LLM streaming response — queue TTS chunks */
  enqueueTtsChunk(text, emotion = 'neutral') {
    if (this.state !== STATES.THINKING && this.state !== STATES.SPEAKING) return;

    // First chunk → transition to SPEAKING
    if (this.state === STATES.THINKING) {
      this.transition(STATES.SPEAKING, 'first TTS chunk');
    }

    this.ttsQueue.push({ text, emotion, timestamp: Date.now() });

    // Emit subtitle
    this.onSubtitle({
      role: 'agent',
      text,
      emotion,
      turnId: this.turnCount,
      isStreaming: true,
    });
  }

  /** LLM done — complete this turn */
  completeTurn(agentText, emotion = 'neutral') {
    this.turns.push({
      role: 'agent',
      text: agentText,
      emotion,
      timestamp: Date.now(),
    });

    this.onSubtitle({
      role: 'agent',
      text: agentText,
      emotion,
      turnId: this.turnCount,
      isStreaming: false,
    });

    this.transition(STATES.IDLE, 'turn complete');
  }

  /** TTS playback finished for current queue */
  playbackComplete() {
    this.isPlaying = false;
    this.ttsQueue = [];

    // If idle after playback, reset
    if (this.state === STATES.SPEAKING) {
      this.transition(STATES.IDLE, 'playback complete');
    }
  }

  /** User explicitly ends session */
  stop() {
    this._clearTtsQueue();
    this.interruptRequested = false;
    this.transition(STATES.IDLE, 'user stopped');
    this._clearTimers();
  }

  /** Full cleanup */
  destroy() {
    this.stop();
    clearInterval(this.silenceCheckInterval);
  }

  // ── Interruption ──

  /** Check if interrupt was requested */
  isInterrupted() {
    if (this.interruptRequested) {
      this.interruptRequested = false;
      return true;
    }
    return false;
  }

  // ── Internal ──

  _clearTtsQueue() {
    this.ttsQueue = [];
    this.isPlaying = false;
  }

  _resetSilenceTimer() {
    this.lastActivity = Date.now();
  }

  _checkSilence() {
    if (this.state === STATES.IDLE) return;
    if (Date.now() - this.lastActivity > SILENCE_TIMEOUT_MS) {
      log.log('Silence timeout, returning to IDLE');
      this.transition(STATES.IDLE, 'silence timeout (10min)');
    }
  }

  _clearTimers() {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.thinkTimer);
  }
}

function generateId() {
  return `vs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export { VoiceSession, STATES };

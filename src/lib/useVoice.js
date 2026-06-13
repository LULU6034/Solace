/**
 * useVoice.js — 前端语音 Composable
 *
 * 管理:
 *  - Web Audio API 录音 (MediaRecorder / ScriptProcessor)
 *  - STT (Web Speech API)
 *  - TTS 播放 (流式音频块)
 *  - VAD 打断检测 (AnalyserNode)
 *  - 状态管理
 *
 * 用法:
 *   const voice = useVoice()
 *   await voice.startListening()
 *   voice.onChunk = (text) => { ... }
 *   voice.stopListening()
 */

import { ref, reactive, computed } from 'vue'

// ── Voice states ──
export const VoiceState = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  MUTED: 'muted',
  ERROR: 'error',
}

// ── Audio config ──
const AUDIO_CONFIG = {
  sampleRate: 24000,
  channelCount: 1,
  vadThreshold: 0.08,       // RMS threshold for voice activity
  vadSilenceMs: 2000,       // Silence duration before auto-stop
  thinkingTimeoutMs: 15000, // Max thinking time
}

export function useVoice() {
  // ── State ──
  const state = ref(VoiceState.IDLE)
  const error = ref(null)
  const isMuted = ref(false)
  const currentSubtitle = ref('')
  const agentEmotion = ref('neutral')
  const userEmotion = ref('neutral')
  const turnCount = ref(0)
  const sessionId = ref(null)
  const isDndActive = ref(false)          // 勿扰模式
  const dndReason = ref('')              // 勿扰原因
  const backchannelText = ref('')        // 自然反馈词
  const selectedMicId = ref('default')   // 选中麦克风
  const selectedSpeakerId = ref('default') // 选中扬声器

  // ── Audio context (lazy init) ──
  let audioCtx = null
  let analyser = null
  let mediaStream = null
  let mediaRecorder = null
  let audioChunks = []

  // ── Devices ──
  let availableMics = []
  let availableSpeakers = []
  let dndTimer = null
  let dndConfig = { enabled: true, start: '22:00', end: '08:00' }

  // ── STT ──
  let recognition = null
  let recognitionActive = false

  // ── TTS playback ──
  let ttsQueue = []
  let isPlaying = false
  let currentAudio = null  // Currently playing Audio element (for interrupt)
  let isInterrupted = false
  let currentSource = null
  let ttsStartTime = 0

  // ── VAD ──
  let vadInterval = null
  let silenceStart = 0
  let speakingStart = 0

  // ── Callbacks ──
  let onChunkCallback = null
  let onStateChangeCallback = null
  let onSubtitleCallback = null

  // ────────────────
  //  Audio setup
  // ────────────────

  /** Enumerate audio devices (mics + speakers) */
  async function enumerateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      availableMics = devices.filter(d => d.kind === 'audioinput').map(d => ({
        id: d.deviceId, label: d.label || `麦克风 ${d.deviceId.slice(0, 8)}`
      }))
      availableSpeakers = devices.filter(d => d.kind === 'audiooutput').map(d => ({
        id: d.deviceId, label: d.label || `扬声器 ${d.deviceId.slice(0, 8)}`
      }))
    } catch (e) {
      console.warn('[useVoice] enumerateDevices failed:', e.message)
    }
  }

  async function initAudio(micId = null) {
    if (audioCtx) return

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: AUDIO_CONFIG.sampleRate,
      })

      // Enumerate devices first
      await enumerateDevices()

      // Build getUserMedia constraints
      const audioConstraints = {
        sampleRate: AUDIO_CONFIG.sampleRate,
        channelCount: AUDIO_CONFIG.channelCount,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
      const targetMic = micId || selectedMicId.value
      if (targetMic && targetMic !== 'default') {
        audioConstraints.deviceId = { exact: targetMic }
      }

      // Request microphone
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })

      // Create analyser for VAD
      const source = audioCtx.createMediaStreamSource(mediaStream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)

      console.log('[useVoice] Audio initialized')
    } catch (err) {
      console.error('[useVoice] Audio init failed:', err)
      error.value = err.message === 'Permission denied' || err.name === 'NotAllowedError'
        ? '麦克风权限被拒绝，请在系统设置中允许麦克风访问'
        : `音频初始化失败: ${err.message}`
      setState(VoiceState.ERROR)
      throw err
    }
  }

  // ────────────────
  //  Do Not Disturb
  // ────────────────

  function loadDndConfig() {
    try {
      const saved = localStorage.getItem('sonder-dnd-config')
      if (saved) dndConfig = JSON.parse(saved)
    } catch {}
  }

  function checkDnd() {
    if (!dndConfig.enabled) { isDndActive.value = false; return false }
    const [sh, sm] = dndConfig.start.split(':').map(Number)
    const [eh, em] = dndConfig.end.split(':').map(Number)
    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const startMin = sh * 60 + sm
    const endMin = eh * 60 + em

    let inDnd
    if (startMin <= endMin) {
      inDnd = nowMin >= startMin && nowMin < endMin
    } else {
      // Overnight range (e.g., 22:00-08:00)
      inDnd = nowMin >= startMin || nowMin < endMin
    }
    isDndActive.value = inDnd
    dndReason.value = inDnd
      ? `勿扰时段 (${dndConfig.start}-${dndConfig.end})`
      : ''
    if (inDnd && !isMuted.value) {
      isMuted.value = true
    }
    return inDnd
  }

  function startDndTimer() {
    loadDndConfig()
    checkDnd()
    dndTimer = setInterval(checkDnd, 60_000) // Check every minute
  }

  // ────────────────
  //  Backchanneling (自然反馈词)
  // ────────────────

  const BACKCHANNELS = [
    { text: '嗯', weight: 40 },
    { text: '嗯嗯', weight: 20 },
    { text: '哦', weight: 15 },
    { text: '这样啊', weight: 10 },
    { text: '然后呢', weight: 5 },
    { text: '我明白', weight: 5 },
    { text: '原来如此', weight: 3 },
    { text: '是吗', weight: 2 },
  ]

  function triggerBackchannel() {
    if (state.value !== VoiceState.LISTENING) return
    // Weighted random selection
    const total = BACKCHANNELS.reduce((s, b) => s + b.weight, 0)
    let r = Math.random() * total
    for (const bc of BACKCHANNELS) {
      r -= bc.weight
      if (r <= 0) {
        backchannelText.value = bc.text
        break
      }
    }
    // Fade out after 800ms
    setTimeout(() => { backchannelText.value = '' }, 800)
  }

  // ────────────────
  //  Sound Effects (Web Audio API)
  // ────────────────

  /** Generate a simple tone / noise sound effect */
  function playSoundEffect(type) {
    if (!audioCtx || isMuted.value) return
    const t = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)

    switch (type) {
      case 'listen_start':  // Soft rising tone
        osc.type = 'sine'; osc.frequency.setValueAtTime(400, t)
        osc.frequency.linearRampToValueAtTime(800, t + 0.15)
        gain.gain.setValueAtTime(0.01, t)
        gain.gain.linearRampToValueAtTime(0.08, t + 0.1)
        gain.gain.linearRampToValueAtTime(0, t + 0.3)
        osc.start(t); osc.stop(t + 0.3)
        break
      case 'listen_end':    // Soft descending tone
        osc.type = 'sine'; osc.frequency.setValueAtTime(600, t)
        osc.frequency.linearRampToValueAtTime(300, t + 0.15)
        gain.gain.setValueAtTime(0.06, t)
        gain.gain.linearRampToValueAtTime(0, t + 0.25)
        osc.start(t); osc.stop(t + 0.25)
        break
      case 'interrupt':     // Sharp short "blip"
        osc.type = 'square'; osc.frequency.setValueAtTime(1000, t)
        osc.frequency.linearRampToValueAtTime(200, t + 0.1)
        gain.gain.setValueAtTime(0.05, t)
        gain.gain.linearRampToValueAtTime(0, t + 0.15)
        osc.start(t); osc.stop(t + 0.15)
        break
      case 'thinking':      // Soft pulsing
        osc.type = 'triangle'; osc.frequency.setValueAtTime(500, t)
        osc.frequency.linearRampToValueAtTime(700, t + 0.3)
        osc.frequency.linearRampToValueAtTime(500, t + 0.6)
        gain.gain.setValueAtTime(0.03, t)
        gain.gain.linearRampToValueAtTime(0.06, t + 0.3)
        gain.gain.linearRampToValueAtTime(0, t + 0.7)
        osc.start(t); osc.stop(t + 0.7)
        break
      case 'degrade':       // Warning beep
        osc.type = 'square'; osc.frequency.setValueAtTime(880, t)
        osc.frequency.setValueAtTime(440, t + 0.1)
        gain.gain.setValueAtTime(0.04, t)
        gain.gain.linearRampToValueAtTime(0, t + 0.2)
        osc.start(t); osc.start(t + 0.12)  // Second beep
        osc.stop(t + 0.25)
        break
    }
  }

  // ────────────────
  //  VAD (Voice Activity Detection)
  // ────────────────

  function startVAD() {
    if (!analyser) return
    silenceStart = Date.now()
    speakingStart = 0

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)

    vadInterval = setInterval(() => {
      analyser.getByteFrequencyData(dataArray)

      // Calculate RMS
      let sum = 0
      for (let i = 0; i < bufferLength; i++) {
        sum += (dataArray[i] - 128) * (dataArray[i] - 128)
      }
      const rms = Math.sqrt(sum / bufferLength) / 128

      if (rms > AUDIO_CONFIG.vadThreshold) {
        // Voice detected
        silenceStart = Date.now()
        if (!speakingStart) {
          speakingStart = Date.now()
        }
        // Agent 说话时，需持续 800ms 人声才算打断，避免杂音/回声误触发
        if (state.value === VoiceState.SPEAKING && speakingStart > 0 && Date.now() - speakingStart > 800) {
          interruptAgent()
        }
        // Backchannel after ~1.5s of continuous speech
        if (Date.now() - speakingStart > 1500 && Math.random() < 0.25) {
          triggerBackchannel()
        }
      } else {
        // Silence
        if (speakingStart && Date.now() - silenceStart > AUDIO_CONFIG.vadSilenceMs) {
          // User stopped speaking for >2s
          if (state.value === VoiceState.LISTENING) {
            stopListening()
          }
          speakingStart = 0
        }
      }
    }, 100) // Check every 100ms
  }

  function stopVAD() {
    clearInterval(vadInterval)
    vadInterval = null
  }

  // ────────────────
  //  STT (Web Speech API)
  // ────────────────

  function initSTT() {
    if (recognition) return

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      console.warn('[useVoice] Web Speech API not available')
      return
    }

    recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    let finalTranscript = ''

    recognition.onresult = (event) => {
      let interim = ''
      let final = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          final += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }

      if (final) {
        finalTranscript += final
        currentSubtitle.value = finalTranscript
        silenceStart = Date.now() // Reset silence timer on final result
      }

      if (interim) {
        currentSubtitle.value = finalTranscript + interim
      }
    }

    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      if (state.value === VoiceState.LISTENING) error.value = `语音识别错误: ${event.error}`
    }

    recognition.onend = () => {
      recognitionActive = false
      // If we're still listening, restart
      if (state.value === VoiceState.LISTENING && !recognitionActive) {
        try {
          recognition.start()
          recognitionActive = true
        } catch {}
      }
    }
  }

  // ────────────────
  //  TTS Playback (Browser SpeechSynthesis)
  // ────────────────

  // Emotion → speechSynthesis parameters
  const EMOTION_PARAMS = {
    neutral:     { rate: 1.0, pitch: 1.0, volume: 0.9 },
    happy:       { rate: 1.15, pitch: 1.2, volume: 1.0 },
    sad:         { rate: 0.85, pitch: 0.85, volume: 0.7 },
    angry:       { rate: 1.2, pitch: 1.1, volume: 1.0 },
    worried:     { rate: 0.9, pitch: 0.9, volume: 0.8 },
    encouraging: { rate: 1.0, pitch: 1.1, volume: 0.95 },
    funny:       { rate: 1.2, pitch: 1.25, volume: 1.0 },
    sarcastic:   { rate: 1.05, pitch: 1.0, volume: 0.85 },
    gentle:      { rate: 0.9, pitch: 0.95, volume: 0.75 },
  }

  function speakText(text, emotion = 'neutral', speed = 1.0) {
    if (isMuted.value) return

    // Cancel any ongoing speech
    window.speechSynthesis?.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    const params = EMOTION_PARAMS[emotion] || EMOTION_PARAMS.neutral

    utterance.rate = params.rate * speed
    utterance.pitch = params.pitch
    utterance.volume = params.volume
    utterance.lang = 'zh-CN'

    // Select best Chinese voice
    const voices = window.speechSynthesis.getVoices()
    const zhVoice = voices.find(v => v.lang.startsWith('zh-CN') && v.localService)
      || voices.find(v => v.lang.startsWith('zh-CN'))
      || voices.find(v => v.lang.startsWith('zh'))
    if (zhVoice) utterance.voice = zhVoice

    utterance.onstart = () => { isPlaying = true; _duckMusic() }
    utterance.onend = () => { isPlaying = false; _unduckMusic() }
    utterance.onerror = (e) => {
      console.warn('[useVoice] TTS error:', e.error)
      isPlaying = false
      _unduckMusic()
    }

    window.speechSynthesis.speak(utterance)
  }

  // ── 浏览器内置 TTS（聊天页面用）──
  function speakViaBrowser(text, emotion = 'neutral', speed = 1.0) {
    if (!text?.trim() || isMuted.value) return
    speakText(text, emotion, speed)
  }

  // ── CosyVoice TTS（语音页面用，流式接收 + 顺序播放）──
  let _cvBusy = false; let _cvQueue = []; let _cvChunkSub = null
  let _ms = null; let _msBuf = null; let _msPending = []; let _msUrl = null; let _msReady = false
  let _msPreBufferMin = 2;

  function _flushPending() {
    if (!_msReady || !_msBuf || _msBuf.updating || _msPending.length === 0) {
      if (_msReady && _msPending.length > 0) {
        _msBuf?.addEventListener?.('updateend', _flushPending, { once: true })
      }
      return
    }
    const chunk = _msPending.shift()
    if (chunk !== null) {
      try {
        _msBuf.appendBuffer(chunk)
      } catch (e) {
        if (e.name === 'QuotaExceededError') {
          _msPending.unshift(chunk)
          _msBuf.addEventListener('updateend', _flushPending, { once: true })
          return
        }
        console.warn('[useVoice] appendBuffer failed:', e.message)
      }
    }
    _msBuf.addEventListener('updateend', _flushPending, { once: true })
  }

  function _startMediaSource() {
    if (_ms) return
    _ms = new MediaSource()
    _msUrl = URL.createObjectURL(_ms)
    _msPending = []
    _msReady = false
    const a = new Audio(_msUrl)
    a.preload = 'auto'
    currentAudio = a
    _ms.addEventListener('sourceopen', () => {
      const ms = _ms; // 捕获引用防止被 _stopStream 清空
      if (!ms) return;
      try {
        _msBuf = ms.addSourceBuffer('audio/mpeg')
        _msBuf.mode = 'sequence'
        _msReady = true
        const waitForBuffer = () => {
          if (_msPending.length >= _msPreBufferMin) {
            _flushPending()
          } else if (_msPending.length > 0) {
            setTimeout(waitForBuffer, 50)
          }
        }
        waitForBuffer()
      } catch (e) {
        console.warn('[useVoice] SourceBuffer init failed:', e.message)
      }
    })
    a.play().catch(() => {})
    a.onended = () => {
      URL.revokeObjectURL(_msUrl)
      _msUrl = null
      currentAudio = null
    }
  }

  function _endMediaSource() {
    _msPending.push(null)
    let retries = 0
    const finalize = () => {
      // 等待所有 chunk 被消费
      if (_msPending.length > 1) { setTimeout(finalize, 50); return }
      if (!_ms || _ms.readyState !== 'open' || !_msBuf) {
        _ms = null; _msBuf = null; _msReady = false; return
      }
      if (_msBuf.updating) {
        // 最后一块还在写入中，等它完成
        if (retries++ < 60) { _msBuf.addEventListener('updateend', finalize, { once: true }); return }
        // 超时兜底
        try { _ms.endOfStream() } catch {}
        _ms = null; _msBuf = null; _msReady = false; return
      }
      // 安全关闭
      try { _ms.endOfStream() } catch {}
      _ms = null; _msBuf = null; _msReady = false
    }
    finalize()
  }

  function _stopStream() {
    if (_ms) {
      if (_ms.readyState === 'open') {
        try {
          if (_msBuf && !_msBuf.updating) {
            _msBuf.onupdateend = null
            _ms.endOfStream()
          }
        } catch {}
      }
    }
    _ms = null; _msBuf = null; _msPending = []; _msReady = false
    if (_msUrl) { URL.revokeObjectURL(_msUrl); _msUrl = null }
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio = null } catch {}
    }
  }

  // ── 音乐闪避：TTS 说话时降低音乐音量 ──
  const DUCK_VOLUME = 0.12
  const FADE_MS = 250
  let _preDuckVolume = null
  let _duckFadeTimer = null

  function _cancelFade() {
    if (_duckFadeTimer) { clearInterval(_duckFadeTimer); _duckFadeTimer = null }
  }

  function _fadeMusicTo(targetVol) {
    const a = window.__musicAudio
    if (!a || a.paused) return
    const from = a.volume
    if (Math.abs(from - targetVol) < 0.01) return
    const steps = 8
    const delta = (targetVol - from) / steps
    const stepMs = FADE_MS / steps
    let i = 0
    _cancelFade()
    _duckFadeTimer = setInterval(() => {
      i++
      if (i >= steps || !window.__musicAudio) { a.volume = targetVol; _cancelFade() }
      else { a.volume = Math.max(0, Math.min(1, from + delta * i)) }
    }, stepMs)
  }

  function _duckMusic() {
    const a = window.__musicAudio
    // 只要音频元素存在且有 src（可能正在缓冲），就执行闪避
    if (!a || !a.src || a.volume <= DUCK_VOLUME + 0.05) return
    _cancelFade()
    if (_preDuckVolume == null) _preDuckVolume = a.volume
    _fadeMusicTo(DUCK_VOLUME)
  }

  function _unduckMusic() {
    const a = window.__musicAudio
    if (!a || _preDuckVolume == null) { _preDuckVolume = null; return }
    const target = _preDuckVolume
    _preDuckVolume = null
    if (a.paused) return
    _fadeMusicTo(target)
  }

  async function _processCvQueue() {
    if (_cvBusy || _cvQueue.length === 0) return
    _cvBusy = true
    setState(VoiceState.SPEAKING)
    _duckMusic()
    const { text, emotion, speed, resolve } = _cvQueue.shift()
    _stopStream()
    _startMediaSource()

    // 只注册一次 chunk 订阅，所有句子共享
    if (!_cvChunkSub) {
      _cvChunkSub = window.electronAPI?.onCvTtsChunk?.((data) => {
        if (isInterrupted || !data?.audio) return
        try {
          const raw = Uint8Array.from(atob(data.audio), c => c.charCodeAt(0))
          if (raw.length < 10) return
          _msPending.push(raw)
          _flushPending()
        } catch (e) {
          console.warn('[useVoice] TTS chunk decode failed:', e.message)
        }
      })
    }

    try {
      await window.electronAPI?.voiceTtsSynthesize?.(text, emotion, 'default_female', speed)
      // IPC chunk 可能还在路上，等待 + 排空
      await new Promise(done => setTimeout(done, 500))
      while (_msPending.length > 0) {
        await new Promise(done => setTimeout(done, 200))
      }
      if (_msPending.length === 0) {
        await new Promise(done => setTimeout(done, 200))
      }
      while (_msPending.length > 0) {
        await new Promise(done => setTimeout(done, 200))
      }
      // 关键修复：等 SourceBuffer 完成处理再 endOfStream
      if (_msBuf?.updating) {
        await new Promise(d => { _msBuf.addEventListener('updateend', d, { once: true }) })
      }
      _endMediaSource()
      // 等待 Audio 播放完毕（无超时限制）
      if (currentAudio && !currentAudio.ended) {
        await new Promise(d => { currentAudio.onended = d })
      }
    } catch (e) { console.warn('[useVoice] CosyVoice failed:', e.message) }
    _stopStream()
    resolve?.(); _cvBusy = false
    if (_cvQueue.length === 0) { setState(VoiceState.IDLE); _unduckMusic() }
    if (!isInterrupted) _processCvQueue()
  }

  function speakViaCosyVoice(text, emotion = 'neutral', speed = 1.0) {
    if (!text?.trim()) return Promise.resolve()
    return new Promise(resolve => {
      _cvQueue.push({ text: text.trim(), emotion, speed, resolve })
      _processCvQueue()
    })
  }

  function stopPlayback() {
    window.speechSynthesis?.cancel()
    isPlaying = false; ttsQueue = []
    _cvQueue = []; _cvBusy = false
    _stopStream()
    if (currentAudio) { try { currentAudio.stop?.() } catch {}; currentAudio = null }
    isInterrupted = true
    _unduckMusic()
  }

  function clearInterrupt() {
    isInterrupted = false
  }

  // ────────────────
  //  Agent interruption
  // ────────────────

  function interruptAgent() {
    playSoundEffect('interrupt')
    stopPlayback()
    window.electronAPI?.voiceInterrupt?.()
    setState(VoiceState.LISTENING)
    // Reset STT for new input
    if (recognition && recognitionActive) {
      try { recognition.stop() } catch {}
    }
    initSTT()
    if (recognition) {
      try { recognition.start(); recognitionActive = true } catch {}
    }
  }

  /** 静默关闭 STT（不改变状态，不播放音效） */
  function stopRecognition() {
    if (recognition && recognitionActive) {
      try { recognition.stop() } catch {}
      recognitionActive = false
    }
  }

  // ── Do Not Disturb config ──
  function setDndConfig(config) {
    dndConfig = { ...dndConfig, ...config }
    localStorage.setItem('sonder-dnd-config', JSON.stringify(dndConfig))
    checkDnd()
  }

  function getDndConfig() { return { ...dndConfig } }

  // ────────────────
  //  Public API
  // ────────────────

  async function startListening() {
    // Check DND
    if (checkDnd()) {
      error.value = `当前处于勿扰时段 (${dndConfig.start}-${dndConfig.end})`
      return
    }
    try {
      await initAudio(selectedMicId.value)
      initSTT()

      setState(VoiceState.LISTENING)
      startVAD()
      playSoundEffect('listen_start')

      if (recognition) {
        try {
          recognition.start()
          recognitionActive = true
        } catch (err) {
          // Already started — ignore
        }
      }

      // Start recording for saving
      audioChunks = []
      mediaRecorder = new MediaRecorder(mediaStream, {
        mimeType: 'audio/webm;codecs=opus',
      })
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data)
      }
      mediaRecorder.start(1000) // 1s chunks

      console.log('[useVoice] Listening started')
    } catch (err) {
      console.error('[useVoice] Start listening failed:', err)
      setState(VoiceState.ERROR)
    }
  }

  function stopListening() {
    stopVAD()
    playSoundEffect('listen_end')

    if (recognition && recognitionActive) {
      try { recognition.stop() } catch {}
      recognitionActive = false
    }

    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop()
    }

    setState(VoiceState.THINKING)
    playSoundEffect('thinking')
    console.log('[useVoice] Listening stopped')

    // Return the transcript
    const text = currentSubtitle.value.trim()
    currentSubtitle.value = ''
    backchannelText.value = ''

    // Save recording
    if (audioChunks.length > 0) {
      const blob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' })
      saveRecording(blob)
    }

    return text
  }

  function saveRecording(blob) {
    // Save to disk via IPC (if configured)
    const saveMode = localStorage.getItem('sonder-recording-save') || '7days'
    if (saveMode === 'never') return

    const now = new Date()
    const dateDir = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
    const filename = `${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}-turn${turnCount.value}.opus`

    // Save via electron API
    window.electronAPI?.saveRecording?.(dateDir, filename, blob)
  }

  function toggleMute() {
    isMuted.value = !isMuted.value
    if (isMuted.value) {
      stopPlayback()
    }
    return isMuted.value
  }

  function setState(newState) {
    const oldState = state.value
    state.value = newState
    if (onStateChangeCallback) {
      onStateChangeCallback({ oldState, newState })
    }
  }

  // ── Event handlers (for IPC events from main process) ──

  function bindIPCEvents() {
    let _ttsChunks = [];
    let _ttsTimer = null;
    window.electronAPI?.onVoiceChunk?.((data) => {
      if (isMuted.value) return;
      if (data.engine === 'textonly') return;
      try {
        const raw = typeof data.audio === 'string'
          ? Uint8Array.from(atob(data.audio), c => c.charCodeAt(0))
          : new Uint8Array(data.audio || data);
        if (raw.length < 10) return;
        _ttsChunks.push(raw);
        clearTimeout(_ttsTimer);
        _ttsTimer = setTimeout(() => {
          if (_ttsChunks.length === 0) return;
          const all = new Blob(_ttsChunks, { type: 'audio/mp3' });
          _ttsChunks = [];
          const url = URL.createObjectURL(all);
          const a = new Audio(url);
          a.onended = () => URL.revokeObjectURL(url);
          a.play().catch(() => {});
        }, 300);
      } catch (e) { /* ignore */ }
    })

    // Voice state changes
    window.electronAPI?.onVoiceState?.((data) => {
      if (data.state) setState(data.state)
      if (data.error) error.value = data.error
    })

    // Subtitle updates
    window.electronAPI?.onVoiceSubtitle?.((data) => {
      if (data.text) currentSubtitle.value = data.text
      if (data.emotion) agentEmotion.value = data.emotion
      if (onSubtitleCallback) onSubtitleCallback(data)
    })
  }

  // ── Event callbacks ──

  function onChunk(cb) { onChunkCallback = cb }
  function onStateChange(cb) { onStateChangeCallback = cb }
  function onSubtitle(cb) { onSubtitleCallback = cb }

  // ── Cleanup ──

  function destroy() {
    stopVAD()
    stopPlayback()
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop())
    }
    if (audioCtx) {
      audioCtx.close()
    }
    audioCtx = null
    analyser = null
    mediaStream = null
  }

  return {
    // State
    state,
    error,
    isMuted,
    currentSubtitle,
    agentEmotion,
    userEmotion,
    turnCount,
    sessionId,
    isDndActive,
    dndReason,
    backchannelText,
    selectedMicId,
    selectedSpeakerId,

    // Actions
    initAudio,
    startListening,
    stopListening,
    stopPlayback,
    speakText,
    speakViaBrowser,
    speakViaCosyVoice,
    interruptAgent,
    stopRecognition,
    clearInterrupt,
    toggleMute,
    setState,
    destroy,

    // Devices & DND
    enumerateDevices,
    setDndConfig,
    getDndConfig,
    startDndTimer,
    checkDnd,
    playSoundEffect,
    triggerBackchannel,

    // Events
    onChunk,
    onStateChange,
    onSubtitle,
    bindIPCEvents,

    // Device lists (reactive)
    availableMics: () => availableMics,
    availableSpeakers: () => availableSpeakers,
  }
}

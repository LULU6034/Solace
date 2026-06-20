/**
 * useFullDuplex.js — 全双工语音 Composable
 *
 * 管理:
 *  - 麦克风 PCM 采集 (ScriptProcessorNode, 16kHz, 16bit, 单声道)
 *  - WebSocket 连接 (/ws/voice)
 *  - TTS 音频回放 (MediaSource 流式)
 *  - 状态同步、字幕
 *
 * 用法:
 *   const fd = useFullDuplex()
 *   await fd.start(config, conversationHistory)
 *   fd.stop()
 */

import { ref, shallowRef } from 'vue'

// ── 状态 ──
export const FDState = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  LISTENING: 'listening',
  THINKING: 'thinking',
  EXECUTING: 'executing',
  SPEAKING: 'speaking',
  ERROR: 'error',
}

export function useFullDuplex() {
  const state = ref(FDState.IDLE)
  const error = ref(null)
  const subtitle = ref(null)       // { role, text, isStreaming }
  const agentText = ref('')        // 流式 Agent 回复
  const partialAsr = ref('')       // ASR 中间结果
  const asrConfirm = ref('')       // ASR 确认文本（处理前展示，用户可看到并打断）
  const audioLevel = ref(0)         // 实时麦克风音量 (0-1)，驱动语音波形条
  const userEmotion = ref('neutral') // 用户情绪（声学检测）
  const turnCount = ref(0)
  const sessionId = ref(null)

  // ── WebSocket ──
  let ws = null
  let wsUrl = ''

  // ── Audio capture ──
  let audioCtx = null
  let scriptNode = null
  let mediaStream = null
  let isCapturing = false

  // ── Audio playback (MediaSource) ──
  let mediaSource = null
  let sourceBuffer = null
  let audioQueue = []
  let isPlaying = false
  let currentPlayAudio = null
  let _discardAudio = false  // 打断后丢弃残留在途的音频帧

  // ── Callbacks ──
  let onStateChangeCb = null
  let onAudioStartCb = null   // TTS 音频开始播放时回调
  let onTtsEndCb = null       // TTS 音频全部播完时回调
  let _pendingTtsText = ''    // 最近一个 TTS 音频帧对应的文本

  /**
   * 启动全双工会话
   * @param {object} config - { apiKey, provider, model, dashscopeApiKey, minimaxApiKey, serverPort }
   * @param {Array} history - 对话历史 [{ role, content }]
   */
  async function start(config, history = []) {
    if (state.value === FDState.LISTENING || state.value === FDState.THINKING) {
      console.warn('[FD] 已在运行中')
      return
    }

    const port = config.serverPort || 19876
    wsUrl = `ws://127.0.0.1:${port}`

    state.value = FDState.CONNECTING
    error.value = null

    try {
      // 直接连接 WebSocket（浏览器 WebSocket 自带连接拒绝错误提示）
      await connectWS(config, history)
      // 启动麦克风采集
      await startCapture()
      state.value = FDState.LISTENING
      console.log('[FD] 全双工会话已启动')
    } catch (err) {
      console.error('[FD] 启动失败:', err)
      error.value = err.message
      state.value = FDState.ERROR
      throw err
    }
  }

  /**
   * 停止全双工会话
   */
  function stop() {
    console.log('[FD] 停止全双工会话')
    _discardAudio = true
    isCapturing = false
    stopCapture()
    stopPlayback()
    if (ws) {
      try { ws.send(JSON.stringify({ type: 'stop' })) } catch {}
      try { ws.close(1000) } catch {}
      ws = null
    }
    state.value = FDState.IDLE
    agentText.value = ''
    partialAsr.value = ''
    subtitle.value = null
    asrConfirm.value = ''
  }

  /**
   * 手动打断 Agent
   */
  function interrupt() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'interrupt' }))
    }
    stopPlayback()
    state.value = FDState.LISTENING
  }

  // ═══════════════════════
  //  WebSocket
  // ═══════════════════════

  async function waitForServer(healthUrl, maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch(healthUrl)
        if (res.ok) {
          console.log('[FD] 服务器就绪 (第', i + 1, '次检查)')
          return true
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error(`服务器未启动: ${healthUrl}`)
  }

  function connectWS(config, history) {
    return new Promise((resolve, reject) => {
      console.log('[FD] 正在连接:', wsUrl)

      ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        console.log('[FD] WS 已连接，发送 init')
        // 发送初始化消息
        ws.send(JSON.stringify({
          type: 'init',
          config: {
            apiKey: config.apiKey || '',
            provider: config.provider || 'deepseek',
            model: config.model || 'deepseek-v4-pro',
            dashscopeApiKey: config.dashscopeApiKey || '',
            minimaxApiKey: config.minimaxApiKey || '',
            deepgramApiKey: config.deepgramApiKey || '',
          },
          history: history || [],
        }))
        // 不在这里 resolve，等收到 ready 消息
      }

      ws.onmessage = (event) => {
        // 二进制音频帧
        if (event.data instanceof ArrayBuffer) {
          handleAudioFrame(new Uint8Array(event.data))
          return
        }

        // JSON 消息
        try {
          const msg = JSON.parse(event.data)
          handleMessage(msg, resolve, reject)
        } catch (e) {
          console.warn('[FD] 无法解析消息:', e)
        }
      }

      ws.onerror = (err) => {
        console.error('[FD] WS 错误:', err?.message || err, '| URL:', wsUrl)
        // 检查服务器是否可达
        fetch(`http://127.0.0.1:${config.serverPort || 19876}/health`)
          .then(r => r.json())
          .then(h => console.log('[FD] 服务器健康检查:', h))
          .catch(() => console.error('[FD] 服务器完全不可达'))
        reject(new Error(`WebSocket 连接失败: ${wsUrl}`))
      }

      ws.onclose = (ev) => {
        console.log('[FD] WS 已断开, code:', ev.code, 'reason:', ev.reason)
        if (state.value !== FDState.IDLE) {
          state.value = FDState.IDLE
          onStateChangeCb?.(FDState.IDLE)
        }
      }

      // 10 秒超时
      setTimeout(() => {
        if (state.value === FDState.CONNECTING) {
          reject(new Error(`WebSocket 连接超时: ${wsUrl}`))
        }
      }, 10_000)
    })
  }

  function handleMessage(msg, resolve, reject) {
    switch (msg.type) {
      case 'ready':
        if (msg.request_id) break
        sessionId.value = msg.sessionId
        resolve()
        break

      case 'state':
        const newState = mapServerState(msg.state)
        if (newState !== state.value) {
          state.value = newState
          onStateChangeCb?.(newState)
          // 新 Agent 回复开始 → 允许接收音频
          if (newState === FDState.SPEAKING) _discardAudio = false
        }
        break

      case 'subtitle':
        subtitle.value = {
          role: msg.role,
          text: msg.text,
          isStreaming: false,
        }
        turnCount.value = msg.turnId || turnCount.value
        // 用户消息到 → 清除 agent_text 和确认
        if (msg.role === 'user') {
          agentText.value = ''
          asrConfirm.value = ''
        }
        break

      case 'agent_chunk':
        agentText.value += msg.content || ''
        break

      case 'asr_partial':
        partialAsr.value = msg.text || ''
        break

      case 'asr_confirm':
        asrConfirm.value = msg.text || ''  // 展示识别结果，用户可在此期间打断
        break

      case 'emotion':
        userEmotion.value = msg.emotion || 'neutral'
        break

      case 'music_play':
        // 触发音乐播放
        console.log('[FD] 🎵 music_play 事件收到:', JSON.stringify(msg.song || msg).slice(0, 200));
        if (msg.song?.songId) {
          const songId = String(msg.song.songId);

          // 如果服务端已经带了 URL（play_music 工具已获取），直接用
          const playMusic = (url) => {
            if (window.__musicAudio) { window.__musicAudio.pause(); }
            const a = new Audio(url);
            a.volume = 0.6;
            window.__musicAudio = a;
            window.__musicCurrentTrack = msg.song;
            // 同步播放状态到服务端
            const sendStatus = (status) => { try { ws.send(JSON.stringify({ type: 'music_status', status })); } catch {} };
            a.addEventListener('play', () => sendStatus('playing'));
            a.addEventListener('pause', () => sendStatus('paused'));
            a.addEventListener('ended', () => sendStatus('ended'));
            a.play().then(() => console.log('[FD] ✅ 播放开始:', msg.song.name)).catch(e => console.warn('[FD] ❌ 播放失败:', msg.song.name, e.message));
            window.dispatchEvent(new CustomEvent('music-nowplaying', { detail: msg.song }));
          };

          if (msg.song.url) {
            console.log('[FD] 🎵 使用服务端URL直接播放');
            playMusic(msg.song.url);
            break;
          }

          // 否则通过 IPC 获取 URL
          console.log('[FD] 🎵 通过IPC获取歌曲URL:', msg.song.name, songId);
          const electronAPI = window.electronAPI;
          if (!electronAPI?.neteaseSongUrl) {
            console.error('[FD] ❌ electronAPI.neteaseSongUrl 不可用!');
            break;
          }
          electronAPI.neteaseSongUrl({ songId, level: 'higher' }).then(r => {
            console.log('[FD] 🎵 neteaseSongUrl 返回:', JSON.stringify({ok: r?.ok, error: r?.error, hasUrl: !!r?.data?.url}));
            if (r?.ok && r?.data?.url) {
              playMusic(r.data.url);
            } else {
              console.warn('[FD] ❌ 歌曲无URL:', JSON.stringify(r).slice(0, 200));
            }
          }).catch(e => console.warn('[FD] ❌ neteaseSongUrl 调用失败:', e.message));
        } else {
          console.warn('[FD] ⚠️ music_play 事件缺少 songId:', msg);
        }
        break

      case 'music_pause':
        if (window.__musicAudio) {
          window.__musicAudio.pause();
          try { ws.send(JSON.stringify({ type: 'music_status', status: 'paused' })); } catch {}
        }
        break

      case 'music_stop':
        if (window.__musicAudio) {
          window.__musicAudio.pause();
          window.__musicAudio.currentTime = 0;
          try { ws.send(JSON.stringify({ type: 'music_status', status: 'stopped' })); } catch {}
        }
        break

      case 'music_resume':
        if (window.__musicAudio) {
          window.__musicAudio.play().catch(() => {});
        }
        break

      case 'music_volume':
        if (window.__musicAudio && msg.level != null) {
          window.__musicAudio.volume = Math.max(0, Math.min(1, msg.level));
        }
        break

      case 'music_list':
        if (msg.songs?.length) {
          localStorage.setItem('music-playlist', JSON.stringify(msg.songs));
          window.dispatchEvent(new CustomEvent('music-playlist-updated'));
        }
        break

      case 'interrupted':
        console.log('[FD] Agent 被打断')
        agentText.value = ''
        stopPlayback()
        break

      case 'stopped':
        console.log('[FD] 服务端会话已停止:', msg.sessionId)
        _discardAudio = true
        stopPlayback()
        state.value = FDState.IDLE
        agentText.value = ''
        partialAsr.value = ''
        asrConfirm.value = ''
        onStateChangeCb?.(FDState.IDLE)
        break

      case 'tts_audio':
        // 保存 TTS 文本（与后面的二进制音频帧配对，用于气泡同步）
        _pendingTtsText = msg.text || ''
        break

      case 'tts_error':
        console.warn('[FD] TTS 错误:', msg.message)
        error.value = `TTS 失败: ${msg.message}`
        break

      case 'tts_stop':
        stopPlayback()
        break

      case 'error':
        console.error('[FD] 服务端错误:', msg.message)
        error.value = msg.message
        // 不改变状态，让用户知道有错误但继续运行
        break
    }
  }

  function mapServerState(s) {
    const map = {
      'idle': FDState.IDLE,
      'listening': FDState.LISTENING,
      'thinking': FDState.THINKING,
      'executing': FDState.EXECUTING,
      'speaking': FDState.SPEAKING,
    }
    return map[s] || FDState.IDLE
  }

  // ═══════════════════════
  //  音频采集 (Mic → PCM)
  // ═══════════════════════

  async function startCapture() {
    if (isCapturing) return

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,     // Lumi OS 实测保留浏览器降噪不影响中文识别
        autoGainControl: true,
      },
    })

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 16000,
    })
    console.log('[FD] ⚠️ AudioContext 实际采样率:', audioCtx.sampleRate, 'Hz (期望16000)')
    if (audioCtx.sampleRate !== 16000) {
      console.error('[FD] ❌ 采样率不匹配! 实际=' + audioCtx.sampleRate + ' 期望=16000')
    }

    // 监听 AudioContext 状态变化，防止浏览器自动暂停
    const ctx = audioCtx;  // 捕获引用，防止 close 后变 null
    ctx.addEventListener('statechange', () => {
      if (!ctx || !isCapturing) return;
      console.log(`[FD] 🔔 AudioContext 状态变更: ${ctx.state}`);
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
        console.warn('[FD] ⚠️ AudioContext 被暂停，尝试恢复...');
        ctx.resume().then(() => console.log('[FD] ✅ AudioContext 已恢复')).catch(e => console.error('[FD] ❌ AudioContext 恢复失败:', e));
      }
    });

    const source = audioCtx.createMediaStreamSource(mediaStream)

    // ScriptProcessor: bufferSize=1024 → 64ms @ 16kHz
    scriptNode = audioCtx.createScriptProcessor(1024, 1, 1)

    let _debugFrameCount = 0;
    let _debugLastLog = Date.now();

    scriptNode.onaudioprocess = (event) => {
      if (!isCapturing || !ws || ws.readyState !== WebSocket.OPEN) {
        _debugFrameCount++;
        const now = Date.now();
        if (now - _debugLastLog > 5000) {
          console.warn(`[FD] ⚠️ onaudioprocess 被阻塞! isCapturing=${isCapturing} wsReady=${ws?.readyState} audioCtxState=${audioCtx?.state} 5秒内${_debugFrameCount}帧被丢弃`);
          _debugFrameCount = 0; _debugLastLog = now;
        }
        return;
      }

      _debugFrameCount++;
      const now = Date.now();
      if (now - _debugLastLog > 5000) {
        console.log(`[FD] 🎤 onaudioprocess 正常: 5秒内 ${_debugFrameCount} 帧, audioCtx.state=${audioCtx?.state}, ws.readyState=${ws?.readyState}`);
        _debugFrameCount = 0; _debugLastLog = now;
      }

      const input = event.inputBuffer.getChannelData(0)
      // 计算 RMS 音量（驱动前端语音波形条）
      let sumSq = 0
      for (let i = 0; i < input.length; i++) sumSq += input[i] * input[i]
      const rms = Math.sqrt(sumSq / input.length)
      if (_debugFrameCount % 4 === 0) audioLevel.value = Math.min(1, rms * 4)  // 4倍增益，0-1范围
      // Float32 [-1, 1] → Int16 PCM (小端序)
      const pcm = new Int16Array(input.length)
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]))
        pcm[i] = Math.round(s < 0 ? s * 32768 : s * 32767)
      }

      const buffer = new Uint8Array(pcm.buffer)
      try {
        ws.send(buffer)
      } catch (e) {
        console.warn('[FD] 发送音频帧失败:', e.message)
      }
    }

    source.connect(scriptNode)
    scriptNode.connect(audioCtx.destination)
    isCapturing = true
    console.log('[FD] 音频采集已启动 (16kHz, ScriptProcessor, 1024 buffer)')
  }

  function stopCapture() {
    if (scriptNode) {
      scriptNode.disconnect()
      scriptNode = null
    }
    if (audioCtx) {
      try { audioCtx.close() } catch {}
      audioCtx = null
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop())
      mediaStream = null
    }
    isCapturing = false
  }

  // ═══════════════════════
  //  TTS 音频回放
  // ═══════════════════════

  function handleAudioFrame(data) {
    if (_discardAudio) return  // 打断后丢弃残留音频
    audioQueue.push(data)
    if (!isPlaying) {
      playNextInQueue()
    }
  }

  function playNextInQueue() {
    if (audioQueue.length === 0) {
      isPlaying = false
      onTtsEndCb?.()
      return
    }

    isPlaying = true
    const data = audioQueue.shift()
    const blob = new Blob([data], { type: 'audio/mp3' })
    const url = URL.createObjectURL(blob)

    const audio = new Audio(url)
    currentPlayAudio = audio

    audio.onended = () => {
      URL.revokeObjectURL(url)
      currentPlayAudio = null
      playNextInQueue()
    }

    audio.onerror = (e) => {
      console.warn('[FD] 音频播放错误:', e)
      URL.revokeObjectURL(url)
      currentPlayAudio = null
      playNextInQueue()
    }

    audio.play().then(() => {
      onAudioStartCb?.()  // 通知气泡可以显示了
    }).catch(err => {
      console.warn('[FD] 音频播放失败:', err.message)
      URL.revokeObjectURL(url)
      currentPlayAudio = null
      playNextInQueue()
    })
  }

  function stopPlayback() {
    _discardAudio = true
    audioQueue = []
    if (currentPlayAudio) {
      try {
        currentPlayAudio.onended = null
        currentPlayAudio.pause()
        currentPlayAudio.remove()        // 彻底销毁，不留残留
      } catch {}
      currentPlayAudio = null
    }
    isPlaying = false
  }

  // ═══════════════════════
  //  状态监听
  // ═══════════════════════

  function onStateChange(cb) {
    onStateChangeCb = cb
  }

  return {
    state,
    error,
    subtitle,
    agentText,
    partialAsr,
    asrConfirm,
    audioLevel,
    userEmotion,
    turnCount,
    sessionId,
    start,
    stop,
    interrupt,
    onStateChange,
    onAudioStart: (cb) => { onAudioStartCb = cb },
    onTtsEnd: (cb) => { onTtsEndCb = cb },
    _audioQueueLen: () => audioQueue.length,
    _hasActiveAudio: () => !!(currentPlayAudio && !currentPlayAudio.paused),
    _pendingTtsText: () => _pendingTtsText,
  }
}

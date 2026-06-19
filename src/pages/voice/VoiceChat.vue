<template>
  <div class="voice-page" @click="onPageClick" @wheel="onWheel">
    <div class="voice-viz">
      <div class="viz-halo-wrap" ref="haloWrap">
        <canvas ref="haloCanvas"></canvas>
      </div>
      <div class="vvstat">{{ exprLabel }}</div>
    </div>

    <div class="voice-subtitle-area" v-if="activeSubtitle">
      <div class="voice-subtitle-bubble" :class="{ fadeOut: subtitleFading, hearing: activeSubtitle.role === 'hearing' }">
        <span class="subtitle-role-tag">{{ activeSubtitle.role === "user" ? "You" : activeSubtitle.role === "hearing" ? "识别" : "Sonder" }}</span>
        <span class="subtitle-text">{{ activeSubtitle.text }}</span>
        <span v-if="streamingText" class="streaming-cursor">|</span>
      </div>
    </div>

    <div class="voice-bottom-bar">
      <!-- 重置 -->
      <button class="voice-action-btn" @click.stop="resetContext" title="清除对话">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
        </svg>
      </button>

      <!-- 全双工 -->
      <button class="voice-action-btn voice-fd-btn" :class="{ active: fdActive }" @click.stop="toggleFD">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        <span class="fd-dot" v-if="fdActive"></span>
      </button>

      <!-- FD：打断 -->
      <button v-if="fdActive && fdState === 'speaking'" class="voice-interrupt-btn" @click.stop="fdInterrupt" title="打断">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/></svg>
        <span>打断</span>
      </button>

      <!-- 输入框：非FD时按住空格说话，FD时输入文字 -->
      <input ref="textInputEl" v-model="textInput" class="voice-text-input"
        :placeholder="fdActive ? '输入后回车发送' : '按住空格说话'"
        @keydown.enter.prevent.stop="sendText" @blur="onTextBlur" />
    </div>

    <div class="voice-error-banner" v-if="ttsUnavailable">
      <span class="error-dot"></span><span class="error-msg">{{ degradeNotice }}</span>
      <button class="error-retry-btn" @click="attemptRecovery">Retry</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue"
import { useVoice, VoiceState } from "../../composables/useVoice.js"
import { useFullDuplex, FDState } from "../../composables/useFullDuplex.js"
import { _up } from "../../composables/useUnifiedParticles.js"
import { getAmbientSound } from "../../composables/useAmbientSound.js"
import { playInstantTone, unlockAudio } from "../../composables/useInstantResponse.js"

const voice = useVoice()
const fd = useFullDuplex()
const ambient = getAmbientSound()
const props = defineProps({ isDark: Boolean, agentConfig: Object })

const textInput = ref(""), textInputEl = ref(null), showTextInput = ref(false)
const activeSubtitle = ref(null), streamingText = ref(""), subtitleFading = ref(false)
const ttsUnavailable = ref(false), degradeNotice = ref(""), isSpeaking = ref(false)
const haloCanvas = ref(null), haloWrap = ref(null)

// ── 全双工模式 ──
const fdActive = ref(false)
const fdState = ref('idle')
const fdError = ref('')

const _textThinking = ref(false), _textSpeaking = ref(false)
const isListening = computed(() => fdActive.value ? fdState.value === 'listening' : voice.state.value === VoiceState.LISTENING)
const isThinking = computed(() => fdActive.value ? fdState.value === 'thinking' : voice.state.value === VoiceState.THINKING)

const exprLabel = computed(() => {
  if (fdActive.value) {
    const map = { listening: '全双工 · 聆听中', thinking: '全双工 · 思考中', executing: '全双工 · 执行中', speaking: '全双工 · 回复中', idle: '全双工 · 连接中...', completed: '全双工 · 完成', error: '全双工 · 异常' }
    const base = map[fdState.value] || '全双工 · 就绪'
    return contextCount.value > 0 ? `${base}  ·  已聊 ${contextCount.value} 轮` : base
  }
  const base = isListening.value ? "聆听中 · 随时可以说话"
    : isThinking.value ? "思考中 · 请稍候"
    : isSpeaking.value ? "回复中 · 正在说话"
    : "待命中 · 按住空格键说话"
  return contextCount.value > 0 ? `${base}  ·  已聊 ${contextCount.value} 轮` : base
})

// ── 全双工切换 ──
var _fdWatchers = []  // 存储 FD 模式下创建的 watch 的 unwatch 函数
async function toggleFD() {
  if (fdActive.value) {
    fd.stop()
    clearInterval(_duckTimer); _duckTimer = null
    for (var _uw = 0; _uw < _fdWatchers.length; _uw++) { try { _fdWatchers[_uw]() } catch {} }
    _fdWatchers = []
    clearTimeout(_userSubTimer)
    fdActive.value = false
    fdState.value = 'idle'
    return
  }

  // 立即反馈：显示连接中状态
  fdState.value = 'connecting'
  // 不显示启动文字，直接连接

  try {
    var config = await window.electronAPI?.loadConfig()
    if (!config) {
      var saved = localStorage.getItem('llm-config')
      if (saved) { try { config = JSON.parse(saved) } catch {} }
    }
    if (!config) {
      pushSubtitle('agent', '请先在设置中配置 API Key', false)
      return
    }

    fd.onStateChange(function(s) { fdState.value = s })
    // 监听 FD 字幕
    _fdWatchers.push(watch(function() { return fd.subtitle.value }, function(sub) {
      if (!sub?.text) return
      if (sub.role === 'agent') {
        // Agent 字幕：直接显示，覆盖用户气泡和前一个 Agent 气泡
        _lastAgentSub = { role: 'agent', text: sub.text }
        pushSubtitle('agent', sub.text)
        try { localStorage.setItem('voice-last-subtitle', JSON.stringify({ role: 'agent', text: sub.text, ts: Date.now() })) } catch {}
      } else {
        // 用户字幕：直接显示，不淡出，和 Agent 气泡一样持久
        pushSubtitle('user', sub.text)
      }
    }))
    // 监听 FD agent 文本
    _fdWatchers.push(watch(function() { return fd.agentText.value }, function(t) {
      if (t) streamingText.value = t
    }))
    // 监听 FD ASR 部分结果
    _fdWatchers.push(watch(function() { return fd.partialAsr.value }, function(t) {
      if (t && fdState.value === 'listening') {
        activeSubtitle.value = { role: 'user', text: t }
      }
    }))
    // 监听 FD ASR 确认
    _fdWatchers.push(watch(function() { return fd.asrConfirm.value }, function(t) {
      if (t) {
        activeSubtitle.value = { role: 'hearing', text: t }
        setTimeout(() => { if (fd.asrConfirm.value === t) fd.asrConfirm.value = '' }, 500)
      }
    }))

    await fd.start({
      apiKey: config.apiKey,
      provider: config.provider || 'deepseek',
      model: config.model || 'deepseek-chat',
      dashscopeApiKey: config.dashscopeApiKey || '',
      minimaxApiKey: config.minimaxApiKey || '',
      deepgramApiKey: config.deepgramApiKey || '',
      serverPort: 19876,
    }, voiceHistory.slice(-20))

    fdActive.value = true
    _startDucking()
    _up?.switchPage('voice')
    ambient.transition('listening')
  } catch (err) {
    console.error('[VoiceChat] 全双工启动失败:', err)
    pushSubtitle('agent', '全双工模式启动失败: ' + err.message, false)
    fdActive.value = false
  }
}

function fdInterrupt() {
  fd.interrupt()
  fdState.value = 'listening'
}

var _musicVol = 0.3
var _pendingSubtitle = null, _pendingTimer = null
var _duckTimer = null
var _userSubTimer = null
var _completedTimer = null, _waitAudioTimer = null, _onKeyDown = null, _onKeyUp = null, _lastAgentSub = null
function _startDucking() {
  clearInterval(_duckTimer)
  _duckTimer = setInterval(function() {
    if (!fdActive.value) { clearInterval(_duckTimer); _duckTimer = null; return }
    // 检查是否有 FD TTS 音频在播放，或 Agent 正在思考/执行/说话
    var isProcessing = fdActive.value && (fd.state.value === 'listening' || fd.state.value === 'thinking' || fd.state.value === 'executing' || fd.state.value === 'speaking')
    var hasTts = (fd._audioQueueLen && fd._audioQueueLen() > 0) || fd._hasActiveAudio?.() || isProcessing
    // 音乐 ducking
    if (hasTts && window.__musicAudio && !window.__musicAudio.paused && window.__musicAudio.volume > 0.04) {
      _musicVol = window.__musicAudio.volume
      window.__musicAudio.volume = 0.03
    } else if (!hasTts && window.__musicAudio && window.__musicAudio.volume < 0.04 && !window.__musicAudio.paused) {
      window.__musicAudio.volume = _musicVol
    }
    // 气泡同步：TTS 播放时显示 Agent 字幕
    if (hasTts && _pendingSubtitle) {
      var _ps = _pendingSubtitle; _pendingSubtitle = null
      clearTimeout(_userSubTimer); clearTimeout(_pendingTimer)
      pushSubtitle('agent', _ps.text)
    }
  }, 100)
}
watch(() => voice.state.value, s => {
  isSpeaking.value = s === VoiceState.SPEAKING
  // 声音开始播放 → 同步显示气泡
  if (s === VoiceState.SPEAKING && _pendingSubtitle) {
    var _ps = _pendingSubtitle; _pendingSubtitle = null; pushSubtitle(_ps.role, _ps.text)
  }
  // 声音真正结束（不是超时猜测）→ 清除 _textSpeaking，让光环正确过渡
  if (s !== VoiceState.SPEAKING && _textSpeaking.value) {
    _textSpeaking.value = false
  }
  // Agent 说话时自动降低音乐音量
  if ((s === VoiceState.SPEAKING || s === VoiceState.LISTENING) && window.__musicAudio && !window.__musicAudio.paused) {
    _musicVol = window.__musicAudio.volume
    window.__musicAudio.volume = 0.03  // Agent说话或用户说话时都降低音乐
  } else if (s !== VoiceState.SPEAKING && s !== VoiceState.LISTENING && window.__musicAudio && window.__musicAudio.volume < 0.04 && !window.__musicAudio.paused) {
    window.__musicAudio.volume = _musicVol
  }
})

function onPageClick(e) {
  if (e.target.closest(".voice-interrupt-btn, .voice-text-input")) return
  unlockAudio(); showTextInput.value = !showTextInput.value
  if (showTextInput.value) nextTick(() => textInputEl.value?.focus())
}
function onWheel() {}
function onTextBlur() {}

function pushSubtitle(role, text, persist) {
  if (subtitleFading.value) subtitleFading.value = false
  // 清理 agent 气泡里的 markdown 格式（不再显示 ** # > 等字符）
  if (role === 'agent' && text) {
    text = text.replace(/^\[emotion:\w+\]\s*/,'').replace(/\*\*/g, '').replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()
  }
  activeSubtitle.value = { role, text }
  // 只持久化真正的对话消息，系统提示不存
  if (persist !== false && text && (role === 'agent' || role === 'user')) {
    try { localStorage.setItem('voice-last-subtitle', JSON.stringify({ role, text, ts: Date.now() })) } catch {}
  }
}

async function startVoice() {
  if (voice.state.value === VoiceState.LISTENING) return
  await voice.startListening()
  _up?.updateAudio({ volume: 0.3, speaking: true }); ambient.transition("listening")
}
async function stopVoice() {
  if (voice.state.value !== VoiceState.LISTENING) return
  var text = voice.stopListening()
  if (!text || text.length < 2) { _up?.updateAudio({ volume: 0, speaking: false }); ambient.transition("idle"); return }
  pushSubtitle("user", text)
  _up?.switchPage("voice"); _up?.updateAudio({ volume: 0, speaking: false, thinking: true }); ambient.transition("thinking")
  _textThinking.value = true
  try { var result = await callAgentVoice(text); if (result?.text) { _textSpeaking.value = true; pushSubtitle("agent", result.text) } }
  catch (err) { console.error("[Voice] Agent call failed:", err); _textSpeaking.value = false }
  finally { _textThinking.value = false }
  _up?.updateAudio({ volume: 0, speaking: false, thinking: false }); ambient.transition("idle")
}

var voiceHistory = (function() { try { var h = JSON.parse(localStorage.getItem('voice-history') || '[]'); return Array.isArray(h) ? h.slice(-50) : []; } catch(e) { return []; } })()
var voiceSessionId = null
const contextCount = ref(0)

function _saveVoiceHistory() {
  try {
    var data = JSON.stringify(voiceHistory.slice(-50))
    localStorage.setItem('voice-history', data)
    // 验证写入成功
    var verify = localStorage.getItem('voice-history')
    if (verify !== data) console.warn('[VoiceChat] 历史保存验证失败')
  } catch(e) { console.warn('[VoiceChat] 历史保存异常:', e.message) }
  contextCount.value = Math.floor(voiceHistory.filter(function(m) { return m.role === 'user' }).length)
}
function resetContext() {
  voiceHistory = []; _saveVoiceHistory(); contextCount.value = 0
  voiceSessionId = "voice_" + Date.now()
  localStorage.setItem('voice-session-id', voiceSessionId)
  localStorage.removeItem('voice-last-subtitle')
  voice.stopPlayback()
  pushSubtitle("agent", "已清除对话记忆，重新开始。", false)
}

// 初始化时计算已有轮数
contextCount.value = Math.floor(voiceHistory.filter(function(m) { return m.role === 'user' }).length)
async function callAgentVoice(text) {
  if (!voiceSessionId) voiceSessionId = "voice_" + Date.now()
  var convId = voiceSessionId, fullText = "", emotion = "neutral", baseSpeed = 1.0, spokenLen = 0
  // 解析 Agent 回复中的 [emotion:xxx] 标签
  function parseEmotion(text) { var m = text.match(/^\[emotion:(\w+)\]/); if (m) { emotion = m[1]; return text.replace(m[0], '').trim(); } return text; }
  // 解析 Agent 回复中的 [speed:X] 标签 (X=0.5~2.0)，Agent 可主动控制语速
  function parseSpeed(text) { var m = text.match(/^\[speed:([\d.]+)\]/); if (m) { baseSpeed = Math.max(0.5, Math.min(2.0, parseFloat(m[1]) || 1.0)); return text.replace(m[0], '').trim(); } return text; }
  function parseTags(text) { text = parseEmotion(text); text = parseSpeed(text); return text; }
  // 智能情绪推断：Agent 没写 [emotion:xxx] 时根据文本内容推断
  function detectEmotion(text) {
    var t = text.slice(0, 120);
    if (/🎉|哈哈|太棒|恭喜|nice|开心|喜欢|好听|真棒|推荐.*给你|为你/.test(t)) return 'happy';
    if (/难过|😔|😢|伤心|心疼|节哀|抱抱|抱歉|对不起/.test(t)) return 'sad';
    if (/😤|气死|无语|过分|投诉|别烦/.test(t)) return 'angry';
    if (/担心|焦虑|别怕|紧张|万一|会不会/.test(t)) return 'worried';
    if (/加油|你可以|相信|没问题|试试|勇敢/.test(t)) return 'encouraging';
    if (/温柔|慢慢|轻轻|安静|晚安|睡吧/.test(t)) return 'gentle';
    return emotion; // 保持已有标签或默认 neutral
  }
  // TTS 文本预处理：标点中文化 + 断句增强
  function polishForTTS(t) {
    return (t||'').replace(/^\[(?:emotion:\w+|speed:[\d.]+)\]\s*\n?/g,'').replace(/\*([^*]+)\*/g, '……$1……')
      // 中文语气词 → MiniMax 发声标签
      .replace(/(?<!\()哈{3,}/g, '(laughs)')
      .replace(/(?<!\()哈哈(?!哈)/g, '(chuckle)')
      .replace(/(?<!\()嘿嘿/g, '(chuckle)')
      .replace(/(?<!\()嘻嘻/g, '(chuckle)')
      .replace(/(?<!\()咳咳/g, '(coughs)')
      .replace(/(?<!\()唉/g, '(sighs)')
      .replace(/(?<!\()哼哼/g, '(groans)')
      // 英文单词 → 标签（已有括号的不重复加）
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
      // 标点中文化 + 断句增强
      .replace(/[，,]\s*/g, '，')
      .replace(/[。.]\s*/g, '。')                    // 统一句号
      .replace(/[？?]\s*/g, '？')                    // 统一问号 → 升调
      .replace(/[！!]\s*/g, '！')                    // 统一感叹号
      .replace(/[；;]\s*/g, '；')                    // 统一分号
      .replace(/([。？！])/g, '$1 ')                // 句末加空格给 TTS 断句
      .replace(/\s{2,}/g, ' ')                       // 合并多余空格
      .trim();
  }
        // ── Agent 独立情绪系统 (多维) ──
  var _mood = (function() {
    try { return JSON.parse(localStorage.getItem("agent-mood") || "{}") } catch(e) { return {} }
  })()
  var _dims = ["angry","happy","sad","playful","gentle","encouraging"]
  for (var _di = 0; _di < _dims.length; _di++) {
    var _dk = _dims[_di]; if (!_mood[_dk]) _mood[_dk] = { v: 0, reason: "" }
  }
  _mood.lastUpdate = _mood.lastUpdate || 0
  var _now = Date.now(), _elapsed = (_now - _mood.lastUpdate) / 60000
  if (_elapsed > 0.5) {
    for (var _di = 0; _di < _dims.length; _di++) {
      _mood[_dims[_di]].v = Math.max(0, _mood[_dims[_di]].v - Math.floor(_elapsed))
    }
  }
  var _raw = voiceHistory.filter(function(m) { return m.role === "user" }).map(function(m) { return m.content || "" })
  var _last = _raw[_raw.length-1] || ""
  var _last3 = _raw.slice(-3)
  // 不耐烦
  var _same3 = _last3.length >= 3 && _last3.every(function(t) { return t === _last3[0] })
  var _sim = 0
  for (var _si = 0; _si < _last3.length; _si++) { for (var _sj = _si+1; _sj < _last3.length; _sj++) { if (_last3[_si] && _last3[_sj] && (_last3[_si].slice(0,4) === _last3[_sj].slice(0,4) || (_last3[_si].length > 2 && _last3[_sj].includes(_last3[_si].slice(0,4))))) _sim++ } }
  if (_same3) { _mood.angry.v = Math.min(10, _mood.angry.v + 3); _mood.angry.reason = "用户反复说同一句话" }
  else if (_sim >= 2) { _mood.angry.v = Math.min(10, _mood.angry.v + 2); _mood.angry.reason = "用户反复问类似问题" }
  else if (_last3.length >= 3 && _last3.every(function(t) { return t.length < 4 })) { _mood.angry.v = Math.min(10, _mood.angry.v + 1); _mood.angry.reason = "用户连续敷衍" }
  // 开心
  if (/哈哈|嘿嘿|笑死|好开心|太棒|牛逼|厉害|恭喜|通过了|拿到了|成功了/.test(_last)) { _mood.happy.v = Math.min(10, _mood.happy.v + 3); _mood.happy.reason = "用户分享好消息" }
  else if (/开心|高兴|不错|挺好的|喜欢/.test(_last)) { _mood.happy.v = Math.min(10, _mood.happy.v + 1); _mood.happy.reason = "用户情绪积极" }
  // 难过
  if (/难过|伤心|崩溃|撑不住|好累|失眠|睡不着|孤独|失败|分手|失去/.test(_last)) { _mood.sad.v = Math.min(10, _mood.sad.v + 3); _mood.sad.reason = "用户说了伤心事" }
  else if (/累了|疲惫|没力气|不想|算了吧/.test(_last)) { _mood.sad.v = Math.min(10, _mood.sad.v + 1); _mood.sad.reason = "用户情绪低落" }
  // 调皮
  if (/逗你|开玩笑|哈哈|骗你|嘿嘿|略略略|笨蛋|傻瓜/.test(_last)) { _mood.playful.v = Math.min(10, _mood.playful.v + 3); _mood.playful.reason = "用户在逗你" }
  // 温柔
  var _hour = new Date().getHours()
  if (_hour >= 23 || _hour < 6) { _mood.gentle.v = Math.min(10, _mood.gentle.v + 2); _mood.gentle.reason = "夜深了" }
  else if (/晚安|睡了|困了|休息/.test(_last)) { _mood.gentle.v = Math.min(10, _mood.gentle.v + 3); _mood.gentle.reason = "用户要休息" }
  // 鼓励
  if (/我不行|好难|做不到|害怕|担心|紧张|焦虑|怎么办|帮帮我/.test(_last)) { _mood.encouraging.v = Math.min(10, _mood.encouraging.v + 3); _mood.encouraging.reason = "用户需要鼓励" }
  else if (/加油|帮我|教我|怎么/.test(_last)) { _mood.encouraging.v = Math.min(10, _mood.encouraging.v + 1); _mood.encouraging.reason = "用户在求助" }
  _mood.lastUpdate = _now
  try { localStorage.setItem("agent-mood", JSON.stringify(_mood)) } catch(e) {}
  var _topMood = "gentle", _topV = 0, _topReason = ""
  for (var _di = 0; _di < _dims.length; _di++) {
    if (_mood[_dims[_di]].v > _topV) { _topMood = _dims[_di]; _topV = _mood[_dims[_di]].v; _topReason = _mood[_dims[_di]].reason }
  }

  // system prompt 由服务端 assembleSystemPrompt("voice") 生成
  var messages = [
    ...voiceHistory.slice(-20), { role: "user", content: text }
  ]
  var _mCtx2=window.__musicCurrentTrack;if(_mCtx2&&_mCtx2.songId){try{var _pl2=JSON.parse(localStorage.getItem("music-playlist")||"[]");var _ci2=_pl2.findIndex(function(s){return String(s.songId)===String(_mCtx2.songId)});var _ctx2="[系统] 当前播放: "+_mCtx2.name+" - "+(_mCtx2.artist||"");if(_ci2>=0&&_ci2<_pl2.length-1){var _n2=_pl2.slice(_ci2+1,_ci2+4).map(function(s){return s.name+" - "+s.artist+" (songId="+s.songId+")"}).join("; ");if(_n2)_ctx2+="。接下来: "+_n2}if(_ci2>0){var _pv2=_pl2[_ci2-1];if(_pv2)_ctx2+="。上一首: "+_pv2.name+" - "+_pv2.artist+" (songId="+_pv2.songId+")"}messages.push({role:"user",content:_ctx2})}catch(e){}}
  // 注入 Agent 情绪（概率触发，避免每轮都刻意）
  var _emotionMap = { angry:"sarcastic", happy:"happy", sad:"sad", playful:"funny", gentle:"gentle", encouraging:"encouraging" }
  // 弱情绪(3-5) 30%触发，中(6-7) 60%，强(8+) 90%
  var _roll = Math.random()
  if (_topV >= 8 || (_topV >= 6 && _roll < 0.9) || (_topV >= 3 && _roll < 0.4)) {
    messages.push({ role: "system", content: "（你现在的感觉：有点" + _topReason + "）" })
  }
  var agentConfig = await window.electronAPI?.loadConfig()
  if (!agentConfig) {
    var saved = localStorage.getItem('llm-config')
    if (saved) { try { agentConfig = JSON.parse(saved) } catch {} }
  }
  if (!agentConfig) { pushSubtitle("agent", "请先在设置中配置 API Key"); return { text: "请先在设置中配置 API Key", emotion: "worried" } }
  agentConfig.reasoningEffort = 'none'
  agentConfig.userNickname = localStorage.getItem('user-nickname') || ''
  playInstantTone("ack")
  return await new Promise(function(resolve) {
    var timer = setTimeout(function() {
      cleanup(); voice.speakViaCosyVoice(polishForTTS(fullText), emotion, baseSpeed)
      voiceHistory.push({ role: "user", content: text }); _saveVoiceHistory(); resolve({ text: fullText || "Okay.", emotion })
    }, 120000)
    function onChunk(data) {
      var d = data?.data || data; if (!d?.content) return
      fullText += d.content; streamingText.value = fullText.replace(/^\[(?:emotion:\w+|speed:[\d.]+)\]\s*/,'')
      // 不在此处 pushSubtitle，避免气泡比 TTS 早出现太多
    }
    function onDone(data) {
      clearTimeout(timer); cleanup()
      var d = data?.data || data; if (d?.content) fullText = d.content
      // 提取情感标签
      fullText = parseTags(fullText);
      // 若 Agent 没写标签，根据文本内容智能推断
      if (emotion === 'neutral') emotion = detectEmotion(fullText);
      // 保存歌单 + 清理 MUSIC_LIST（不朗读）
      try {
        var mlMatch = fullText.match(/MUSIC_?LIST\s*(\[[\s\S]*?\])/);
        var songs = null;
        if (mlMatch) { try { songs = JSON.parse(mlMatch[1]); } catch(e) {} }
        if (!songs) {
          var objs = [], re2 = /\{[^}]+\}/g, om2;
          var tail2 = (fullText.match(/MUSIC_?LIST\s*([\s\S]*?)$/) || [])[1] || '';
          while ((om2 = re2.exec(tail2)) !== null) {
            try { var o2 = JSON.parse(om2[0]); var oid = o2.songId || o2.songld || o2.id; if (oid && o2.name) objs.push({ songId: String(oid), name: o2.name, artist: o2.artist || '', cover: o2.cover || '' }); } catch(e) {}
          }
          if (objs.length) songs = objs;
        }
        if (songs && songs.length) {
          var newPl = [];
          for (var si = 0; si < songs.length; si++) {
            var sid3 = songs[si].songId || songs[si].songld || songs[si].id;
            if (sid3) newPl.push({ songId: String(sid3), name: songs[si].name || '', artist: songs[si].artist || '', cover: songs[si].cover || '' });
          }
          if (newPl.length) { localStorage.setItem('music-playlist', JSON.stringify(newPl)); window.dispatchEvent(new CustomEvent('music-playlist-updated')); console.log('[Voice] 歌单已替换:', newPl.length, '首'); }
        }
      } catch(e) { console.warn('[Voice] MUSIC_LIST parse error:', e); }
      fullText = fullText.replace(/MUSIC_?LIST[\s\S]*$/i, '').trim();
      // 解析音乐控制指令（暂停/继续/停止/音量）
      var ctrlMatch = fullText.match(/MUSIC_(PAUSE|RESUME|STOP|VOLUME\s+[\d.]+)/i);
      if (ctrlMatch) {
        var cmd = ctrlMatch[1].toUpperCase();
        fullText = fullText.replace(ctrlMatch[0], '').trim();
        if (cmd === 'STOP' || cmd === 'PAUSE') {
          window.__musicAudio?.pause();
          if (cmd === 'STOP') { window.__musicCurrentTrack = null; window.dispatchEvent(new CustomEvent('music-nowplaying', { detail: null })); }
        } else if (cmd === 'RESUME') {
          window.__musicAudio?.play().catch(function(){});
        } else if (cmd.startsWith('VOLUME')) {
          var vol = parseFloat(cmd.split(/\s+/)[1]) || 0.5;
          if (window.__musicAudio) window.__musicAudio.volume = vol;
        }
      }
      // 解析音乐播放指令
      var musicMatch = fullText.match(/NOW_PLAYING\s*(\{[\s\S]*?\})/)
      if (musicMatch) {
        try {
          var song = JSON.parse(musicMatch[1])
          fullText = fullText.replace(musicMatch[0], '').trim()
          if (!fullText) fullText = '正在播放 ' + song.name
          // 清理 markdown 格式，避免 TTS 读特殊字符
          fullText = fullText.replace(/\*\*|[*_`#>\\\-\[\]()|{}]/g, '').replace(/  +/g, ' ').trim()
          var remain = fullText.slice(spokenLen).trim()
          if (remain.length > 0) voice.speakViaCosyVoice(polishForTTS(remain), emotion, baseSpeed)
          // 立即 resolve，不阻塞 UI；音乐播放放后台
          voiceHistory.push({ role: "user", content: text }, { role: "assistant", content: fullText || "Okay." }); _saveVoiceHistory()
          if (voiceHistory.length > 50) voiceHistory.splice(0, 4)
          resolve({ text: fullText || "Okay.", emotion }); streamingText.value = ""
          // 后台获取歌曲 URL 并播放
          if (!window.__musicAudio) window.__musicAudio = new Audio();
          window.electronAPI?.neteaseSongUrl({ songId: song.songId, level: 'higher' }).then(function(r) {
            var url = r?.ok ? (r.data?.url || null) : null
            if (!url) {
              return window.electronAPI?.neteaseSongUrl({ songId: song.songId, level: 'standard' })
            }
            return { ok: true, data: { url: url } }
          }).then(function(r2) {
            if (r2?.ok && r2.data?.url) {
              window.__musicAudio.src = r2.data.url
              // Agent 还在说话时降低音乐音量，说完自动恢复
              if (voice.state.value === VoiceState.SPEAKING) { _musicVol = window.__musicAudio.volume || 0.3; window.__musicAudio.volume = 0.12 }
              window.__musicAudio.play().catch(function(e) { console.warn('[Voice] play() 失败:', e.message) })
              var sid = String(song.songId);
              window.__musicCurrentTrack = { songId: sid, name: song.name, artist: song.artist || '', cover: song.cover || '' };
              try {
                var pl = JSON.parse(localStorage.getItem('music-playlist') || '[]');
                pl = pl.filter(function(s) { return String(s.songId) !== sid; });
                pl.unshift({ songId: sid, name: song.name, artist: song.artist || '', cover: song.cover || '' });
                if (pl.length > 30) pl.length = 30;
                localStorage.setItem('music-playlist', JSON.stringify(pl));
                window.dispatchEvent(new CustomEvent('music-playlist-updated'));
              } catch(e) {}
              window.dispatchEvent(new CustomEvent('music-nowplaying', {
                detail: { songId: song.songId, name: song.name, artist: song.artist, cover: song.cover || '', reason: song.reason || '' }
              }))
              console.log('[Voice] 播放开始:', song.name)
            } else {
              console.warn('[Voice] 歌曲无播放源:', song.name)
            }
          }).catch(function(err) {
            console.error('[Voice] 播放出错:', err)
          })
          return
        } catch (e) { console.error('[Voice] NOW_PLAYING 解析失败:', e) }
      }
      var remain = fullText.slice(spokenLen).trim()
      // 清理 markdown 格式（**粗体**、链接、代码等）
      remain = remain.replace(/\*\*|[*_`#>\\\-\[\]()|{}]/g, '').replace(/  +/g, ' ').trim()
      _pendingSubtitle = { role: "agent", text: fullText }
        if (remain.length > 0) voice.speakViaCosyVoice(polishForTTS(remain), emotion, baseSpeed)
      voiceHistory.push({ role: "user", content: text }, { role: "assistant", content: fullText || "Okay." }); _saveVoiceHistory()
      if (voiceHistory.length > 50) voiceHistory.splice(0, 4)
      resolve({ text: fullText || "Okay.", emotion }); streamingText.value = ""
    }
    function onError() { clearTimeout(timer); cleanup(); resolve({ text: "Connection failed.", emotion: "worried" }) }
    var _activeVoiceCall = convId
    function cleanup() { unsub0?.(); unsub1?.(); unsub2?.(); unsub3?.(); _activeVoiceCall = null }
    // 确认语事件（Agent 说"好的这就搜"后立即播放，同时后台搜）
    var unsub0 = window.electronAPI?.onAgentSpeak?.((data) => {
      if (_activeVoiceCall !== convId) return
      var d = data?.data || data
      if (d?.content) voice.speakViaCosyVoice(polishForTTS(d.content), emotion, baseSpeed)
    })
    var unsub1 = window.electronAPI?.onAgentChunk?.((data) => { if (_activeVoiceCall === convId && data?.content) onChunk(data) })
    var unsub2 = window.electronAPI?.onAgentDone?.((data) => { if (_activeVoiceCall === convId) onDone(data) })
    var unsub3 = window.electronAPI?.onAgentError?.((data) => { if (_activeVoiceCall === convId) onError(data) })
    window.electronAPI?.agentChat?.(agentConfig, messages, convId, "voice").catch(function(err) {
      clearTimeout(timer); cleanup()
      var errText = "Connection failed: " + err.message
      voice.speakViaCosyVoice(errText, "worried", baseSpeed); resolve({ text: errText, emotion: "worried" })
    })
  })
}

async function sendText() {
  var t = textInput.value.trim(); if (!t || isListening.value || isThinking.value) return
  voice.stopPlayback(); voice.stopRecognition(); voice.clearInterrupt(); window.electronAPI?.voiceInterrupt?.()
  textInput.value = ""; showTextInput.value = false; pushSubtitle("user", t)
  _up?.switchPage("voice"); _up?.updateAudio({ volume: 0, speaking: false, thinking: true }); ambient.transition("thinking")
  _textThinking.value = true
  try { var result = await callAgentVoice(t); if (result?.text) { _textSpeaking.value = true; pushSubtitle("agent", result.text) } }
  catch (err) { console.error(err); _textSpeaking.value = false }
  finally { _textThinking.value = false }
  _up?.updateAudio({ volume: 0, speaking: false, thinking: false }); ambient.transition("idle")
}

function attemptRecovery() { ttsUnavailable.value = false; degradeNotice.value = "" }

/* ═══════════════════════════════════════════
   双瞳动画引擎
   ═══════════════════════════════════════════ */

// ═══════════════════ Claude Halo Canvas 2D 渲染引擎 ═══════════════════
// 摘自 github.com/Houyusu/claude-halo — 弧段光环 + 流体形变 + 呼吸辉光
let _hCtx, _hTime, _hRaf, _hCfg, _hMorph, _hLifecycle, _hEntryStart, _hPulseSettle, _hLastT

var HALO_CFG = {
  idle:         {color:"#aaaaaa",halo:"#cccccc",period:6.0,dashes:[60,30],               ms:0,  md:0,   amin:0.30,amax:0.42,br:0,  rp:0,   rpperiod:0},
  listening:    {color:"#33cc55",halo:"#bbffcc",period:3.0,dashes:[70,35,45,30,25,20],   ms:0.6,md:0.4, amin:0.45,amax:0.85,br:4.5,rp:0,   rpperiod:0},
  thinking:     {color:"#ff8830",halo:"#ffdbb8",period:2.4,dashes:[70,35,45,30,25,20],   ms:0.6,md:0.4, amin:0.45,amax:0.90,br:5.2,rp:0,   rpperiod:0},
  executing:    {color:"#3399ff",halo:"#bbddff",period:1.3,dashes:[50,25,20,20,35,25,25,22],ms:1.2,md:0.28,amin:0.60,amax:0.90,br:0,  rp:0,   rpperiod:0},
  speaking:     {color:"#3399ff",halo:"#bbddff",period:1.3,dashes:[50,25,20,20,35,25,25,22],ms:1.2,md:0.28,amin:0.60,amax:0.90,br:0,  rp:0,   rpperiod:0},
  completed:    {color:"#33cc55",halo:"#bbffcc",period:5.0,dashes:[70,35,45,30,25,20],   ms:0.5,md:0.3, amin:0.38,amax:0.84,br:6.0,rp:0,   rpperiod:0},
  error:        {color:"#ee3333",halo:"#ffcccc",period:2.8,dashes:[80,50,30,25],          ms:1.8,md:0.5, amin:0.52,amax:0.94,br:2.0,rp:0,   rpperiod:0},
}

function _hHex(h) { var m=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h); return m?[parseInt(m[1],16),parseInt(m[2],16),parseInt(m[3],16)]:[255,255,255] }
function _hLerp(a,b,t){return a+(b-a)*t}
function _hLerpRgb(a,b,t){return[Math.round(_hLerp(a[0],b[0],t)),Math.round(_hLerp(a[1],b[1],t)),Math.round(_hLerp(a[2],b[2],t))]}
function _hRgba(r,g,b,a){return"rgba("+r+","+g+","+b+","+a+")"}

function _hMorphDash(a,b,t){
  var nA=a.length/2,nB=b.length/2,nFloat=_hLerp(nA,nB,t),nDraw=Math.max(1,Math.ceil(nFloat)),res=[]
  var tA=a.reduce(function(s,v){return s+v},0),tB=b.reduce(function(s,v){return s+v},0)
  var tT=_hLerp(tA,tB,t)
  for(var i=0;i<nDraw;i++){var f=i/nDraw,ia=Math.floor(f*nA)%nA,ib=Math.floor(f*nB)%nB
    var dl=_hLerp(a[ia*2],b[ib*2],t),gl=_hLerp(a[ia*2+1],b[ib*2+1],t),bs=nDraw<=nFloat?1:1-(nDraw-nFloat)
    bs=Math.max(0.02,bs);res.push(dl*bs,gl*bs)}
  var cur=res.reduce(function(s,v){return s+v},0)
  if(cur>0){var sc=tT/cur;for(var j=0;j<res.length;j++)res[j]*=sc}
  return res
}

function _hMorphCfg(a,b,t){
  if(!a||!b)return _hCfg
  return {color:_hLerpRgb(_hHex(a.color),_hHex(b.color),t),halo:_hLerpRgb(_hHex(a.halo),_hHex(b.halo),t),
    period:_hLerp(a.period,b.period,t),ms:_hLerp(a.ms,b.ms,t),md:_hLerp(a.md,b.md,t),
    amin:_hLerp(a.amin,b.amin,t),amax:_hLerp(a.amax,b.amax,t),
    br:_hLerp(a.br,b.br,t),rp:_hLerp(a.rp,b.rp,t),rpperiod:_hLerp(a.rpperiod,b.rpperiod,t),
    dashes:_hMorphDash(a.dashes,b.dashes,t)}
}

function _hDrawRing(cx,cy,R,cfg,aMul,tOff){
  if(aMul<=0.001||!cfg||!cfg.color)return
  var t=_hTime+(tOff||0),mrgb=Array.isArray(cfg.color)?cfg.color:_hHex(cfg.color)
  var hrgb=Array.isArray(cfg.halo)?cfg.halo:_hHex(cfg.halo)
  var breathe=0
  if(cfg.br>0){var ph=(t%cfg.br)/cfg.br;breathe=Math.max(0,Math.sin(ph*Math.PI*2))}
  var alpha=(cfg.br>0?cfg.amin+(cfg.amax-cfg.amin)*breathe:cfg.amax)*aMul
  var offset=((t/cfg.period)*Math.PI*2)%(Math.PI*2)
  var rawSum=cfg.dashes.reduce(function(a,b){return a+b},0)
  var hlw=Math.max(R*0.28,1.5),haext=hlw/R,minGap=haext*1.20
  var rawAng=[]
  for(var i=0;i<cfg.dashes.length;i++){
    var morph=Math.sin(t*cfg.ms+i*2.1),ang=(cfg.dashes[i]/rawSum)*Math.PI*2
    if(i%2===0){ang*=1+cfg.md*morph;ang=Math.max(0.02,ang)}
    else{ang*=1-cfg.md*0.5*morph;ang=Math.max(minGap,ang)}
    rawAng.push(ang)}
  var dSum=0,gSum=0
  for(var j=0;j<rawAng.length;j++){if(j%2===0)dSum+=rawAng[j];else gSum+=rawAng[j]}
  var dTgt=Math.PI*2-gSum,dScl=dSum>0.001?dTgt/dSum:1
  var cumul=0
  for(var k=0;k<rawAng.length;k++){
    var ang=k%2===0?rawAng[k]*dScl:rawAng[k],a0=cumul-offset,a1=a0+ang;cumul+=ang
    if(k%2===1)continue
    _hCtx.strokeStyle=_hRgba(hrgb[0],hrgb[1],hrgb[2],alpha*0.55);_hCtx.lineWidth=hlw;_hCtx.lineCap="round"
    _hCtx.beginPath();_hCtx.arc(cx,cy,R,a0,a1,false);_hCtx.stroke()
    var mid=_hLerpRgb(hrgb,mrgb,0.5);_hCtx.strokeStyle=_hRgba(mid[0],mid[1],mid[2],alpha*0.85)
    _hCtx.lineWidth=Math.max(R*0.16,1);_hCtx.lineCap="round"
    _hCtx.beginPath();_hCtx.arc(cx,cy,R,a0,a1,false);_hCtx.stroke()
    _hCtx.strokeStyle=_hRgba(mrgb[0],mrgb[1],mrgb[2],alpha);_hCtx.lineWidth=Math.max(R*0.10,1)
    _hCtx.lineCap="round";_hCtx.beginPath();_hCtx.arc(cx,cy,R,a0,a1,false);_hCtx.stroke()}
}

function _hDrawBridge(cx,cy,R,a,b,t){
  var ga=Math.sin(t*Math.PI)*0.32;if(ga<0.005)return
  var mid=_hLerpRgb(_hHex(a.color),_hHex(b.color),t)
  _hCtx.strokeStyle=_hRgba(mid[0],mid[1],mid[2],ga*0.22);_hCtx.lineWidth=Math.max(R*0.50,3.5);_hCtx.lineCap="round"
  _hCtx.beginPath();_hCtx.arc(cx,cy,R,0,Math.PI*2,false);_hCtx.stroke()
  _hCtx.strokeStyle=_hRgba(mid[0],mid[1],mid[2],ga*0.40);_hCtx.lineWidth=Math.max(R*0.22,1.8);_hCtx.lineCap="round"
  _hCtx.beginPath();_hCtx.arc(cx,cy,R,0,Math.PI*2,false);_hCtx.stroke()
}

function _hRpulse(cfg,tNow){
  if(!cfg.rp||cfg.rpperiod<=0)return 1;if(_hPulseSettle<=0)return 1
  var e=tNow-_hPulseSettle;if(e<0)return 1
  var ramp=Math.min(1,Math.max(0,e-0.20)/0.50),erp=cfg.rp*(1-Math.pow(1-ramp,3));if(erp<=0.001)return 1
  return 1+erp*Math.sin((tNow%cfg.rpperiod)/cfg.rpperiod*Math.PI*2)
}

var _hTarget = 'idle', _hCurrent = 'idle', _hMorphFrom = null, _hMorphStart = 0, _hMorphing = false
_hEntryStart = 0; _hLifecycle = 'entering'; _hTime = 0; _hLastT = null; _hRaf = null

function _hInit(){
  var c=haloCanvas.value; if(!c)return
  _hCtx=c.getContext('2d'); _hPulseSettle=0
  _hCfg=HALO_CFG.idle; _hTarget='idle'; _hCurrent='idle'
  _hLifecycle='entering'; _hEntryStart=null; _hMorphing=false; _hMorphFrom=null
  _hResize(); _hLastT=null; _hRaf=requestAnimationFrame(_hFrame)
}
function _hResize(){
  var c=haloCanvas.value; if(!c||!_hCtx)return
  var el=haloWrap.value; var w=el?el.clientWidth:300,h=el?el.clientHeight:300
  var dpr=window.devicePixelRatio||1
  c.width=w*dpr;c.height=h*dpr;_hCtx.setTransform(dpr,0,0,dpr,0,0)
}
function _hFrame(ts){
  _hRaf=requestAnimationFrame(_hFrame)
  if(!_hLastT)_hLastT=ts
  var dt=(ts-_hLastT)/1000;if(dt<=0)dt=0.016;else if(dt>0.1)dt=0.1
  _hLastT=ts;_hTime+=dt
  var w=haloCanvas.value.clientWidth,h=haloCanvas.value.clientHeight
  var cx=Math.floor(w/2),cy=Math.floor(h/2),baseR=Math.min(w,h)*0.38
  var es=1,ea=1
  if(_hLifecycle==='entering'){
    if(!_hEntryStart)_hEntryStart=ts
    var raw=Math.min((ts-_hEntryStart)/550,1)
    var c1=1.70158,eb=1+(c1+1)*Math.pow(raw-1,3)+c1*Math.pow(raw-1,2)
    es=0.2+0.8*eb;ea=1-Math.pow(1-raw,3)
    if(raw>=1)_hLifecycle='active'
  }
  var targetCfg = HALO_CFG[_hTarget]
  var actCfg=_hMorphing&&_hMorphFrom&&targetCfg?_hMorphCfg(_hMorphFrom,targetCfg,Math.min((ts-_hMorphStart)/420,1)):_hCfg
  if(!actCfg)return
  var rpF=_hRpulse(actCfg,_hTime),RR=baseR*es*rpF
  _hCtx.clearRect(0,0,w,h)
  if(_hLifecycle==='active'&&_hTarget!==_hCurrent&&!_hMorphing&&HALO_CFG[_hTarget]){
    _hPulseSettle=0;_hMorphFrom=_hCfg;_hMorphStart=ts;_hMorphing=true
  }
  if(_hLifecycle!=='active'){_hDrawRing(cx,cy,RR,_hCfg,ea,0)}
  else if(_hMorphing){
    var el=ts-_hMorphStart,rm=Math.min(el/420,1)
    var tE=rm<0.5?2*rm*rm:1-Math.pow(-2*rm+2,2)/2
    var interp=_hMorphCfg(_hMorphFrom,HALO_CFG[_hTarget],tE)
    _hDrawRing(cx,cy,RR,interp,ea,0);_hDrawBridge(cx,cy,RR,_hMorphFrom,HALO_CFG[_hTarget],tE)
    if(rm>=1){_hMorphing=false;_hCurrent=_hTarget;_hCfg=HALO_CFG[_hTarget];_hMorphFrom=null
      if(HALO_CFG[_hTarget].rp>0)_hPulseSettle=_hTime+0.06}
  }else{_hDrawRing(cx,cy,RR,_hCfg,ea,0)}
}

function _hSetState(name){
  if(_hTarget===name && _hLifecycle==='active')return
  _hTarget=name
  // 跳过进入动画，直接切状态
  if(_hLifecycle!=='active'){ _hLifecycle='active'; _hEntryStart=null }
}
function _hDispose(){
  if(_hRaf){cancelAnimationFrame(_hRaf);_hRaf=null}
  _hCtx=null
}

// ── 提醒监听：收到服务端推送的提醒后自动触发 Agent 回复 ──
let _unsubReminder = null

onMounted(async function() {
  // 恢复会话 ID（刷新/重启后保持上下文连续性）
  voiceSessionId = localStorage.getItem('voice-session-id') || ("voice_" + Date.now())
  localStorage.setItem('voice-session-id', voiceSessionId)
  // 恢复最后一条气泡
  try {
    var saved = JSON.parse(localStorage.getItem('voice-last-subtitle'))
    // 只恢复 5 分钟内的气泡，更旧的不显示（避免重启后弹出上次的旧消息）
    if (saved?.text && saved.role !== 'system' && Date.now() - (saved.ts || 0) < 300_000) {
      activeSubtitle.value = { role: saved.role || 'agent', text: saved.text }
    }
  } catch {}
  voice.bindIPCEvents(); voice.startDndTimer()
  _up?.switchPage("voice"); _up?.updateAudio({ volume: 0, speaking: false }); ambient.start("idle"); ambient.setVolume(0.1)
  nextTick(function() { _hInit() })
  watch(function() {
    if (fdActive.value) return fdState.value
    if (_textSpeaking.value) return 'speaking'
    if (_textThinking.value) return 'thinking'
    return isSpeaking.value ? 'speaking' : isListening.value ? 'listening' : isThinking.value ? 'thinking' : 'idle'
  }, function(s, prev) {
    clearTimeout(_completedTimer); clearInterval(_waitAudioTimer)
    if (prev === 'speaking' && s === 'idle') {
      // FD 模式：服务端提前发 idle，等音频真正播完再变绿
      if (fdActive.value) {
        _waitAudioTimer = setInterval(function() {
          if (!fd._hasActiveAudio?.() && !fd._audioQueueLen?.()) {
            clearInterval(_waitAudioTimer); _waitAudioTimer = null
            _hSetState('completed')
            _completedTimer = setTimeout(function() { _hSetState('idle') }, 3000)
          }
        }, 150)
        return  // 不立即切状态，等音频播完
      }
      // 旧语音模式：说话完成 → 绿色 → 3秒后自动变灰
      _hSetState('completed')
      _completedTimer = setTimeout(function() { _hSetState('idle') }, 3000)
    } else if (prev !== 'speaking' || s !== 'idle') {
      _hSetState(s)
    }
  }, { immediate: true })
  voice.onStateChange(function(data) {
    switch (data.newState) {
      case VoiceState.THINKING:
        _up?.switchPage("voice"); _up?.updateAudio({ volume: 0, speaking: false, thinking: true }); ambient.transition("thinking"); break
      case VoiceState.SPEAKING:
        _up?.updateAudio({ volume: 0.6, speaking: true, thinking: false }); ambient.transition("idle"); break
    }
  })
  _onKeyDown = function(e) {
    if (e.target.closest("input, textarea")) return
    if (fdActive.value) return
    if (e.code === "Space" && e.target === document.body) { e.preventDefault(); startVoice() }
    if (e.code === "Escape") { voice.interruptAgent(); streamingText.value = "" }
    if (e.code === "Enter") { e.preventDefault(); showTextInput.value = true; nextTick(function() { textInputEl.value?.focus() }) }
  }
  _onKeyUp = function(e) { if (e.code === "Space" && !fdActive.value) stopVoice() }
  document.addEventListener("keydown", _onKeyDown)
  document.addEventListener("keyup", _onKeyUp)

  // 持久化提醒监听 — 提醒触发时自动让 Agent 通知用户
  _unsubReminder = window.electronAPI?.onReminderFire?.(function(data) {
    var task = data?.task || data?.message || '提醒'
    console.log('[VoiceChat] 提醒触发:', task)
    var msg = '[系统提醒] 你之前设置的提醒时间到了：「' + task + '」。请用一两句话自然、友好地提醒用户。不要用 emoji。'
    callAgentVoice(msg).then(function(result) {
      if (result?.text) pushSubtitle('agent', result.text)
    }).catch(function(err) {
      console.error('[VoiceChat] 提醒 Agent 调用失败:', err)
    })
  })
})

onUnmounted(function() {
  clearTimeout(_completedTimer); clearInterval(_waitAudioTimer)
  clearInterval(_duckTimer)
  document.removeEventListener('keydown', _onKeyDown)
  document.removeEventListener('keyup', _onKeyUp)
  _hDispose()
  if (fdActive.value) { fd.stop(); fdActive.value = false }
  if (_unsubReminder) { _unsubReminder(); _unsubReminder = null }
  _up?.switchPage("chat"); _up?.updateAudio({ volume: 0, speaking: false }); ambient.stop()
})
</script>

<style scoped>
.voice-page {
  position: relative; width: 100%; height: 100%;
  background:
    radial-gradient(ellipse 80% 60% at 50% 35%, rgba(109,124,255,0.06) 0%, transparent 60%),
    radial-gradient(ellipse 60% 50% at 20% 80%, rgba(155,140,240,0.04) 0%, transparent 50%),
    radial-gradient(ellipse 60% 50% at 80% 20%, rgba(120,160,240,0.03) 0%, transparent 50%),
    linear-gradient(175deg, #eef0f8 0%, #e4e7f4 30%, #e8e4f6 60%, #ebe8f5 100%);
  overflow: hidden;
}
.voice-page::after {
  content: ''; position: absolute; inset: 0;
  background-image:
    radial-gradient(circle at 30% 25%, rgba(88,104,240,0.03) 1px, transparent 1px),
    radial-gradient(circle at 70% 60%, rgba(88,104,240,0.02) 1px, transparent 1px);
  background-size: 48px 48px, 64px 64px;
  pointer-events: none; z-index: 0;
}

.voice-viz {
  position: absolute; top: 42%; left: 50%; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center;
  z-index: 2; pointer-events: none;
}
.voice-viz::before {
  content: ''; position: absolute; inset: 0; border-radius: 20px;
  background: radial-gradient(ellipse at 50% 35%, rgba(92,128,224,0.06) 0%, transparent 60%);
}
/* ── 双瞳 v2：柱状双眸 · 梭形横瞳 + 旋转张望 ── */
.viz-eyes { display: flex; gap: 80px; position: relative; z-index: 1; }

/* 眼部单元 — 极缓侧摆 (5.8s, 模拟身体重心自然转移) */
.eye-unit {
  animation: idleSway 5.8s ease-in-out infinite;
  will-change: transform;
}
@keyframes idleSway {
  0%, 100% { transform: rotate(0deg); }
  30% { transform: rotate(1.5deg); }
  70% { transform: rotate(-1.5deg); }
}

/* 眼部容器 — 绕底部旋转 (张望) */
.eye-canvas {
  position: relative;
  width: 72px; height: 130px;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.45s cubic-bezier(0.2, 1.2, 0.4, 1);
  will-change: transform;
}
.eye-canvas.look-around {
  animation: lookAround 0.9s cubic-bezier(0.2, 1.2, 0.4, 1) forwards;
}
@keyframes lookAround {
  0%   { transform: rotate(0deg); }
  25%  { transform: rotate(16deg); }
  50%  { transform: rotate(0deg); }
  75%  { transform: rotate(-16deg); }
  100% { transform: rotate(0deg); }
}

/* 核心柱体 — 纯色 + 多层投影 */
.eye-pillar {
  position: absolute; top: 50%; left: 50%;
  width: 42px; height: 96px;
  border-radius: 26px;
  transform: translate(-50%, -50%);
  transition: width 0.55s cubic-bezier(0.2, 1.1, 0.4, 1),
              height 0.55s cubic-bezier(0.2, 1.1, 0.4, 1),
              border-radius 0.55s cubic-bezier(0.2, 1.1, 0.4, 1),
              clip-path 0.55s cubic-bezier(0.2, 1.1, 0.4, 1),
              box-shadow 0.55s cubic-bezier(0.2, 1.1, 0.4, 1);
  will-change: transform, width, height, border-radius, clip-path, box-shadow;
}
/* 左眼 — 深海蓝 */
.eye-l .eye-pillar {
  background: linear-gradient(180deg, #98b8f8, #5c80e0);
  box-shadow: 0 0 10px rgba(92,128,224,0.28), 0 3px 8px rgba(0,0,0,0.06),
              inset 0 1px 1px rgba(255,255,255,0.5);
}
/* 右眼 — 暮光紫 */
.eye-r .eye-pillar {
  background: linear-gradient(180deg, #b8a8f8, #7c68e0);
  box-shadow: 0 0 10px rgba(124,104,224,0.28), 0 3px 8px rgba(0,0,0,0.06),
              inset 0 1px 1px rgba(255,255,255,0.5);
}

/* 呼吸光晕 — 轻量 */
@keyframes pillarGlowL {
  0%   { box-shadow: 0 0 4px rgba(92,128,224,0.12), 0 3px 8px rgba(0,0,0,0.06),
                     inset 0 1px 1px rgba(255,255,255,0.5); }
  100% { box-shadow: 0 0 14px rgba(92,128,224,0.28), 0 3px 8px rgba(0,0,0,0.06),
                     inset 0 1px 1px rgba(255,255,255,0.5); }
}
@keyframes pillarGlowR {
  0%   { box-shadow: 0 0 4px rgba(124,104,224,0.12), 0 3px 8px rgba(0,0,0,0.06),
                     inset 0 1px 1px rgba(255,255,255,0.5); }
  100% { box-shadow: 0 0 14px rgba(124,104,224,0.28), 0 3px 8px rgba(0,0,0,0.06),
                     inset 0 1px 1px rgba(255,255,255,0.5); }
}
.eye-l .eye-pillar { animation: pillarGlowL 3s infinite alternate ease-in-out, pillarBreathe 4.2s ease-in-out infinite; }
.eye-r .eye-pillar { animation: pillarGlowR 3s infinite alternate ease-in-out, pillarBreathe 4.2s ease-in-out infinite; }

/* 柱子呼吸微动 (4.2s, 极缓 scaleY, 模拟胸腔起伏) */
@keyframes pillarBreathe {
  0%, 100% { transform: translate(-50%, -50%) scaleY(1); }
  50% { transform: translate(-50%, -50%) scaleY(1.04); }
}

/* ═══ 表情形态 ═══ */

/* 睁眼 (默认) */
.eye-pillar.open {
  width: 42px; height: 96px; border-radius: 26px;
  clip-path: inset(0% 0% 0% 0% round 26px);
}

/* 聆听 — 竖瞳张大 */
.eye-pillar.listen-pillar {
  width: 44px; height: 114px; border-radius: 28px;
  clip-path: inset(0% 0% 0% 0% round 28px);
  box-shadow: 0 0 16px rgba(92,128,224,0.3), 0 3px 8px rgba(0,0,0,0.06),
              inset 0 1px 1px rgba(255,255,255,0.5) !important;
}

/* 思考 — 轻眯 (半横态) */
.eye-pillar.think-pillar {
  width: 60px; height: 24px; border-radius: 0;
  clip-path: polygon(0% 25%, 10% 5%, 90% 5%, 100% 25%,
                     100% 75%, 90% 95%, 10% 95%, 0% 75%);
}

/* 深眯 — 梭形横瞳 */
.eye-pillar.squint-pillar {
  width: 74px; height: 14px; border-radius: 0;
  clip-path: polygon(0% 20%, 12% 0%, 88% 0%, 100% 20%,
                     100% 80%, 88% 100%, 12% 100%, 0% 80%);
  box-shadow: 0 0 14px rgba(92,128,224,0.25), 0 4px 10px rgba(0,0,0,0.08),
              inset 0 1px 2px rgba(255,255,255,0.5) !important;
}
/* 梭形右眼配色 */
.eye-r .eye-pillar.squint-pillar {
  box-shadow: 0 0 14px rgba(124,104,224,0.25), 0 4px 10px rgba(0,0,0,0.08),
              inset 0 1px 2px rgba(255,255,255,0.5) !important;
}

/* 开心 — 凝视放大 */
.eye-pillar.happy-pillar {
  width: 46px; height: 110px; border-radius: 30px;
  clip-path: inset(0% 0% 0% 0% round 30px);
  box-shadow: 0 0 20px rgba(92,128,224,0.35), 0 3px 8px rgba(0,0,0,0.06),
              inset 0 1px 1px rgba(255,255,255,0.5) !important;
}
.eye-r .eye-pillar.happy-pillar {
  box-shadow: 0 0 20px rgba(124,104,224,0.35), 0 3px 8px rgba(0,0,0,0.06),
              inset 0 1px 1px rgba(255,255,255,0.5) !important;
}

/* 闭眼 */
.eye-pillar.closed-pillar {
  width: 42px; height: 3px; border-radius: 13px;
  clip-path: none;
  box-shadow: 0 0 3px rgba(92,128,224,0.1), 0 1px 2px rgba(0,0,0,0.04),
              inset 0 0px 1px rgba(255,255,255,0.3) !important;
}

/* 眨眼 — 瞬闪压扁 */
.eye-pillar.blink-pillar {
  width: 42px; height: 5px; border-radius: 14px;
  clip-path: none;
  transition: all 0.1s cubic-bezier(0.4, 0, 0.2, 1) !important;
}

/* 光晕元素 */
.eye-glow {
  position: absolute; bottom: -12px; left: 50%; transform: translateX(-50%);
  width: 52px; height: 120px; border-radius: 50%;
  filter: blur(16px); opacity: 0.25; pointer-events: none;
  will-change: opacity;
}
.eye-l .eye-glow { background: radial-gradient(ellipse at center, rgba(92,128,224,0.35) 0%, transparent 70%); }
.eye-r .eye-glow { background: radial-gradient(ellipse at center, rgba(124,104,224,0.35) 0%, transparent 70%); }

.viz-halo-wrap {
  width: 300px; height: 300px; position: relative; z-index: 2; margin: 0 auto;
  border-radius: 50%;
  box-shadow: 0 0 100px rgba(88,104,240,0.04);
}
.viz-halo-wrap canvas { display: block; width: 100%; height: 100%; border-radius: 50%; }

.vvstat { font-size: 11px; font-weight: 450; letter-spacing: 0.04em; color: rgba(0,0,0,0.30); position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 8px; }
.vvd { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: 0.3; animation: vdPulse 2.5s ease-in-out infinite; }
@keyframes vdPulse { 0%,100% { opacity: 0.12; transform: scale(0.8); } 50% { opacity: 0.55; transform: scale(1.15); } }

.voice-subtitle-area { position: absolute; bottom: 24%; left: 50%; transform: translateX(-50%); z-index: 10; pointer-events: none; width: 85%; max-width: 520px; max-height: 38%; overflow-y: auto; }
.voice-subtitle-bubble {
  background: rgba(255,255,255,0.65);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  border: 1px solid rgba(0,0,0,0.06);
  border-radius: 14px;
  padding: 12px 20px;
  text-align: left;
  color: var(--text-secondary);
  word-break: break-word;
  white-space: normal;
  box-shadow:
    0 1px 1px rgba(255,255,255,0.6) inset,
    0 2px 12px rgba(0,0,0,0.04),
    0 8px 32px rgba(88,104,240,0.03);
  transition: opacity 0.3s ease, transform 0.3s ease;
  animation: bubbleEnter 0.3s ease-out;
}
@keyframes bubbleEnter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
.voice-subtitle-bubble.fadeOut { opacity: 0; transform: translateY(-10px); transition: opacity 0.35s ease, transform 0.35s ease; }
.voice-subtitle-bubble.hearing { background: rgba(255,250,238,0.72); border-color: rgba(200,165,80,0.15); box-shadow: 0 1px 1px rgba(255,250,238,0.6) inset, 0 2px 12px rgba(180,140,60,0.03); }
.subtitle-role-tag { display: block; font-size: 10px; color: rgba(88,104,240,0.4); text-transform: uppercase; margin-bottom: 3px; letter-spacing: 1.8px; font-weight: 600; }
.subtitle-text { color: rgba(0,0,0,0.68); font-size: 14px; line-height: 1.55; word-break: break-word; white-space: normal; display: block; }
.streaming-cursor { display: inline-block; width: 1.5px; height: 14px; background: rgba(109,124,255,0.5); margin-left: 2px; vertical-align: text-bottom; animation: blink 0.7s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }

.voice-bottom-bar { position: absolute; bottom: 36px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; z-index: 20; }

/* 通用动作按钮 */
.voice-action-btn {
  width: 42px; height: 42px; border-radius: 14px;
  border: 1px solid rgba(0,0,0,0.07);
  background: rgba(255,255,255,0.45);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: rgba(0,0,0,0.32);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: all 0.3s cubic-bezier(0.22, 0.61, 0.36, 1);
  position: relative;
  box-shadow: 0 1px 2px rgba(0,0,0,0.03);
}
.voice-action-btn:hover {
  background: rgba(88,104,240,0.08);
  border-color: rgba(88,104,240,0.18);
  color: #5868f0;
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(88,104,240,0.06), 0 1px 2px rgba(0,0,0,0.04);
}

/* 全双工按钮 */
.voice-fd-btn.active { background: rgba(88,104,240,0.1); border-color: rgba(88,104,240,0.25); color: #5868f0; box-shadow: 0 1px 8px rgba(88,104,240,0.06); }
.fd-dot { position: absolute; top: 10px; right: 10px; width: 6px; height: 6px; border-radius: 50%; background: #5868f0; box-shadow: 0 0 6px rgba(88,104,240,0.3); animation: fdDotPulse 1.5s ease-in-out infinite; }
@keyframes fdDotPulse { 0%,100%{opacity:0.35} 50%{opacity:1} }

/* 打断按钮 */
.voice-interrupt-btn {
  display: flex; align-items: center; gap: 6px; padding: 0 18px; height: 42px;
  border-radius: 14px; border: 1px solid rgba(220,80,60,0.15);
  background: rgba(220,80,60,0.04); color: #c04a3a;
  cursor: pointer; font-size: 12px; font-weight: 500;
  transition: all 0.25s cubic-bezier(0.22, 0.61, 0.36, 1);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.voice-interrupt-btn:hover { background: rgba(220,80,60,0.08); transform: translateY(-1px); border-color: rgba(220,80,60,0.25); }

/* 文字输入 */
.voice-text-input {
  width: 150px; height: 42px; padding: 0 16px; flex-shrink: 0;
  border: 1px solid rgba(0,0,0,0.07); border-radius: 14px;
  font-size: 12px; font-weight: 450;
  background: rgba(255,255,255,0.45);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: rgba(0,0,0,0.55); outline: none; font-family: inherit;
  box-shadow: 0 1px 2px rgba(0,0,0,0.03);
  transition: all 0.3s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.voice-text-input:focus { border-color: rgba(88,104,240,0.22); width: 200px; box-shadow: 0 0 0 3px rgba(88,104,240,0.04); color: rgba(0,0,0,0.7); }
.voice-text-input::placeholder { color: rgba(0,0,0,0.18); font-weight: 400; }
.voice-error-banner { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 10px; background: rgba(255,59,48,0.06); border: 1px solid rgba(255,59,48,0.1); z-index: 30; }
.error-msg { font-size: 11px; color: var(--text-secondary); }
.error-retry-btn { padding: 2px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-card); color: var(--text-secondary); cursor: pointer; font-size: 10px; font-weight: 500; transition: all var(--duration-fast) var(--ease-btn); }
.error-retry-btn:hover { background: var(--bg-sidebar-hover); color: var(--text-primary); border-color: var(--border-strong); }
</style>

<template>
  <div class="voice-page" @click="onPageClick" @wheel="onWheel">
    <div class="voice-viz">
      <div class="viz-eyes">
        <div class="eye-unit eye-l" ref="eyeLRef">
          <div class="eye-canvas" ref="canvasLRef">
            <div class="eye-pillar" ref="pillarLRef"></div>
            <div class="eye-glow" ref="glowLRef"></div>
          </div>
        </div>
        <div class="eye-unit eye-r" ref="eyeRRef">
          <div class="eye-canvas" ref="canvasRRef">
            <div class="eye-pillar" ref="pillarRRef"></div>
            <div class="eye-glow" ref="glowRRef"></div>
          </div>
        </div>
      </div>

      <div class="vvbar"><div class="vvfill" ref="vfillRef"></div></div>
      <div class="vvstat"><span class="vvd"></span>{{ exprLabel }}</div>
    </div>

    <div class="voice-subtitle-area" v-if="activeSubtitle">
      <div class="voice-subtitle-bubble" :class="{ fadeOut: subtitleFading }">
        <span class="subtitle-role-tag">{{ activeSubtitle.role === "user" ? "You" : "Sonder" }}</span>
        <span class="subtitle-text">{{ activeSubtitle.text }}</span>
        <span v-if="streamingText" class="streaming-cursor">|</span>
      </div>
    </div>

    <div class="voice-bottom-bar">
      <button class="voice-reset-btn" @click.stop="resetContext" title="清除对话记忆">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
          </svg>
        </button>
      <button class="voice-mic-btn" :class="micBtnClass" @mousedown="startVoice" @mouseup="stopVoice">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
      </button>
      <div class="voice-text-slide" :class="{ visible: showTextInput }">
        <input ref="textInputEl" v-model="textInput" class="voice-text-input-slide" placeholder="输入文字按回车发送" @keydown.enter.prevent.stop="sendText" @blur="onTextBlur" />
        <button class="voice-send-slide-btn" @click.stop="sendText" :disabled="!textInput.trim()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        </button>
      </div>
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
import { _up } from "../../composables/useUnifiedParticles.js"
import { getAmbientSound } from "../../composables/useAmbientSound.js"
import { playInstantTone, unlockAudio } from "../../composables/useInstantResponse.js"

const voice = useVoice()
const ambient = getAmbientSound()
const props = defineProps({ isDark: Boolean, agentConfig: Object })

const textInput = ref(""), textInputEl = ref(null), showTextInput = ref(false)
const activeSubtitle = ref(null), streamingText = ref(""), subtitleFading = ref(false)
const ttsUnavailable = ref(false), degradeNotice = ref(""), showHint = ref(true), isSpeaking = ref(false)
const vfillRef = ref(null), pillarLRef = ref(null), pillarRRef = ref(null)
const glowLRef = ref(null), glowRRef = ref(null), eyeLRef = ref(null), eyeRRef = ref(null)
const canvasLRef = ref(null), canvasRRef = ref(null)

const isListening = computed(() => voice.state.value === VoiceState.LISTENING)
const isThinking = computed(() => voice.state.value === VoiceState.THINKING)

const exprLabel = computed(() => {
  const base = isListening.value ? "聆听中 · 随时可以说话"
    : isThinking.value ? "思考中 · 请稍候"
    : isSpeaking.value ? "回复中 · 正在说话"
    : "待命中 · 按住空格键说话"
  return contextCount.value > 0 ? `${base}  ·  已聊 ${contextCount.value} 轮` : base
})

const micBtnClass = computed(() => ({
  listening: isListening.value, thinking: isThinking.value,
  speaking: isSpeaking.value, error: voice.state.value === VoiceState.ERROR,
}))

watch(() => voice.state.value, s => { isSpeaking.value = s === VoiceState.SPEAKING })

function onPageClick(e) {
  if (e.target.closest(".voice-text-slide, .voice-mic-btn")) return
  unlockAudio(); showTextInput.value = !showTextInput.value
  if (showTextInput.value) nextTick(() => textInputEl.value?.focus())
}
function onWheel() {}
function onTextBlur() {}

function pushSubtitle(role, text, persist) {
  if (subtitleFading.value) subtitleFading.value = false
  // 清理 agent 气泡里的 markdown 格式（不再显示 ** # > 等字符）
  if (role === 'agent' && text) {
    text = text.replace(/^\[emotion:\w+\]\s*/,'').replace(/\*\*/g, '').replace(/[*_~`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()
  }
  activeSubtitle.value = { role, text }
  // 只持久化真正的对话消息，系统提示不存
  if (persist !== false && text && (role === 'agent' || role === 'user')) {
    try { localStorage.setItem('voice-last-subtitle', JSON.stringify({ role, text, ts: Date.now() })) } catch {}
  }
}

async function startVoice() {
  if (voice.state.value === VoiceState.LISTENING) return
  showHint.value = false; await voice.startListening()
  _up?.updateAudio({ volume: 0.3, speaking: true }); ambient.transition("listening")
}
async function stopVoice() {
  if (voice.state.value !== VoiceState.LISTENING) return
  var text = voice.stopListening()
  if (!text || text.length < 2) { _up?.updateAudio({ volume: 0, speaking: false }); ambient.transition("idle"); return }
  pushSubtitle("user", text)
  _up?.switchPage("voice"); _up?.updateAudio({ volume: 0, speaking: false, thinking: true }); ambient.transition("thinking")
  try { var result = await callAgentVoice(text); if (result?.text) pushSubtitle("agent", result.text) }
  catch (err) { console.error("[Voice] Agent call failed:", err) }
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
  var convId = voiceSessionId, fullText = "", emotion = "neutral", spokenLen = 0
  // 解析 Agent 回复中的 [emotion:xxx] 标签
  function parseEmotion(text) { var m = text.match(/^\[emotion:(\w+)\]/); if (m) { emotion = m[1]; return text.replace(m[0], '').trim(); } return text; }
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
    return (t||'').replace(/^\[emotion:\w+\]\s*\n?/,'').replace(/[，,]\s*/g, '，')      // 统一逗号
      .replace(/[。.]\s*/g, '。')                    // 统一句号
      .replace(/[？?]\s*/g, '？')                    // 统一问号 → 升调
      .replace(/[！!]\s*/g, '！')                    // 统一感叹号
      .replace(/[；;]\s*/g, '；')                    // 统一分号
      .replace(/([。？！])/g, '$1 ')                // 句末加空格给 TTS 断句
      .replace(/\s{2,}/g, ' ')                       // 合并多余空格
      .trim();
  }
  // system prompt 由服务端 assembleSystemPrompt("voice") 生成
  var messages = [
    ...voiceHistory.slice(-20), { role: "user", content: text }
  ]
  var _mCtx2=window.__musicCurrentTrack;if(_mCtx2&&_mCtx2.songId){try{var _pl2=JSON.parse(localStorage.getItem("music-playlist")||"[]");var _ci2=_pl2.findIndex(function(s){return String(s.songId)===String(_mCtx2.songId)});var _ctx2="[系统] 当前播放: "+_mCtx2.name+" - "+(_mCtx2.artist||"");if(_ci2>=0&&_ci2<_pl2.length-1){var _n2=_pl2.slice(_ci2+1,_ci2+4).map(function(s){return s.name+" - "+s.artist+" (songId="+s.songId+")"}).join("; ");if(_n2)_ctx2+="。接下来: "+_n2}if(_ci2>0){var _pv2=_pl2[_ci2-1];if(_pv2)_ctx2+="。上一首: "+_pv2.name+" - "+_pv2.artist+" (songId="+_pv2.songId+")"}messages.push({role:"user",content:_ctx2})}catch(e){}};var agentConfig = await window.electronAPI?.loadConfig()
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
      cleanup(); voice.speakViaCosyVoice(polishForTTS(fullText), emotion, 1.0)
      voiceHistory.push({ role: "user", content: text }); _saveVoiceHistory(); resolve({ text: fullText || "Okay.", emotion })
    }, 120000)
    function onChunk(data) {
      var d = data?.data || data; if (!d?.content) return
      fullText += d.content; streamingText.value = fullText.replace(/^\[emotion:\w+\]\s*/,'')
      // 不在此处 pushSubtitle，避免气泡比 TTS 早出现太多
    }
    function onDone(data) {
      clearTimeout(timer); cleanup()
      var d = data?.data || data; if (d?.content) fullText = d.content
      // 提取情感标签
      fullText = parseEmotion(fullText);
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
          fullText = fullText.replace(/\*\*|[*_~`#>\\\-\[\]()|{}]/g, '').replace(/  +/g, ' ').trim()
          var remain = fullText.slice(spokenLen).trim()
          if (remain.length > 0) voice.speakViaCosyVoice(polishForTTS(remain), emotion, 1.0)
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
      remain = remain.replace(/\*\*|[*_~`#>\\\-\[\]()|{}]/g, '').replace(/  +/g, ' ').trim()
      if (remain.length > 0) voice.speakViaCosyVoice(polishForTTS(remain), emotion, 1.0)
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
      if (d?.content) voice.speakViaCosyVoice(polishForTTS(d.content), emotion, 1.0)
    })
    var unsub1 = window.electronAPI?.onAgentChunk?.((data) => { if (_activeVoiceCall === convId && data?.content) onChunk(data) })
    var unsub2 = window.electronAPI?.onAgentDone?.((data) => { if (_activeVoiceCall === convId) onDone(data) })
    var unsub3 = window.electronAPI?.onAgentError?.((data) => { if (_activeVoiceCall === convId) onError(data) })
    window.electronAPI?.agentChat?.(agentConfig, messages, convId, "voice").catch(function(err) {
      clearTimeout(timer); cleanup()
      var errText = "Connection failed: " + err.message
      voice.speakViaCosyVoice(errText, "worried", 1.0); resolve({ text: errText, emotion: "worried" })
    })
  })
}

async function sendText() {
  var t = textInput.value.trim(); if (!t || isListening.value || isThinking.value) return
  voice.stopPlayback(); voice.stopRecognition(); voice.clearInterrupt(); window.electronAPI?.voiceInterrupt?.()
  textInput.value = ""; showTextInput.value = false; pushSubtitle("user", t)
  _up?.switchPage("voice"); _up?.updateAudio({ volume: 0, speaking: false, thinking: true }); ambient.transition("thinking")
  try { var result = await callAgentVoice(t); if (result?.text) pushSubtitle("agent", result.text) }
  catch (err) { console.error(err) }
  _up?.updateAudio({ volume: 0, speaking: false, thinking: false }); ambient.transition("idle")
}

function attemptRecovery() { ttsUnavailable.value = false; degradeNotice.value = "" }

/* ═══════════════════════════════════════════
   双瞳动画引擎
   ═══════════════════════════════════════════ */

const expr = ref("idle")

// 模块级引用，供外部驱动动画
var _exprTarget = null, _testMode = false, _curIdleExpr = "idle"

// ── 表情 key → CSS class 映射 ──
function pillarClass(key) {
  switch (key) {
    case "listen": return "listen-pillar"
    case "think":  return "think-pillar"
    case "squint": return "squint-pillar"
    case "happy":  return "happy-pillar"
    case "closed": return "closed-pillar"
    default:       return "open"
  }
}

// ── 动画引擎 v2：CSS class 驱动形态 + RAF 微动 ──
var vizAnimId = null, vizT = 0

function startVizAnim() {
  var lastTime = performance.now()

  var blinkRemain = 3200, blinkT = 0, blinkDuration = 150
  var idleRemain = 4000 + Math.random() * 4000
  var _lookAroundTimer = null

  // 清除两支柱子上所有表情/眨眼 class
  function clearPillarClasses() {
    var kl = ["open","listen-pillar","think-pillar","squint-pillar","happy-pillar","closed-pillar","blink-pillar"]
    ;[pillarLRef.value, pillarRRef.value].forEach(function(el) {
      if (el) for (var i = 0; i < kl.length; i++) el.classList.remove(kl[i])
    })
  }

  // 应用表情到柱子 (wink 单眼闭, lookAround canvas 旋转, 其余双柱同步)
  function applyPillarExpr(key) {
    clearPillarClasses()
    if (key === "wink") {
      if (pillarLRef.value && pillarRRef.value) {
        if (Math.random() < 0.5) { pillarLRef.value.classList.add("closed-pillar"); pillarRRef.value.classList.add("open") }
        else { pillarLRef.value.classList.add("open"); pillarRRef.value.classList.add("closed-pillar") }
      }
    } else if (key === "lookAround") {
      if (pillarLRef.value) pillarLRef.value.classList.add("open")
      if (pillarRRef.value) pillarRRef.value.classList.add("open")
      if (canvasLRef.value) canvasLRef.value.classList.add("look-around")
      if (canvasRRef.value) canvasRRef.value.classList.add("look-around")
      clearTimeout(_lookAroundTimer)
      _lookAroundTimer = setTimeout(function() {
        if (canvasLRef.value) canvasLRef.value.classList.remove("look-around")
        if (canvasRRef.value) canvasRRef.value.classList.remove("look-around")
      }, 950)
    } else {
      var cls = pillarClass(key)
      if (pillarLRef.value) pillarLRef.value.classList.add(cls)
      if (pillarRRef.value) pillarRRef.value.classList.add(cls)
    }
  }

  // 暴露给外部 (triggerTest / 语音状态覆盖用)
  _exprTarget = function(key) { expr.value = key; applyPillarExpr(key) }

  applyPillarExpr("idle")
  _curIdleExpr = "idle"

  function updateViz(ts) {
    vizAnimId = requestAnimationFrame(updateViz)
    var dt = Math.min(ts - lastTime, 50); lastTime = ts; vizT += dt

    // ── 自动眨眼 (class 闪合) ──
    blinkRemain -= dt
    if (blinkRemain <= 0 && blinkT <= 0) {
      blinkT = 1; blinkDuration = 140 + Math.random() * 40
      if (pillarLRef.value) pillarLRef.value.classList.add("blink-pillar")
      if (pillarRRef.value) pillarRRef.value.classList.add("blink-pillar")
    }
    if (blinkT > 0) {
      blinkT += dt
      if (blinkT >= blinkDuration) {
        blinkT = 0; blinkRemain = 2400 + Math.random() * 1000
        if (pillarLRef.value) pillarLRef.value.classList.remove("blink-pillar")
        if (pillarRRef.value) pillarRRef.value.classList.remove("blink-pillar")
      }
    }

    // ── 空闲轮换 (非聆听/思考/测试) ──
    if (!isListening.value && !isThinking.value && !_testMode) {
      idleRemain -= dt
      if (idleRemain <= 0) {
        var pool = ["lookAround","happy","closed","wink","squint","think","idle"]
        pool = pool.filter(function(e) { return e !== _curIdleExpr })
        _curIdleExpr = pool[Math.floor(Math.random() * pool.length)]
        expr.value = _curIdleExpr
        applyPillarExpr(_curIdleExpr)
        if (_curIdleExpr === "closed" || _curIdleExpr === "wink") idleRemain = 600 + Math.random() * 800
        else if (_curIdleExpr === "squint" || _curIdleExpr === "think") idleRemain = 1500 + Math.random() * 1500
        else if (_curIdleExpr === "lookAround") idleRemain = 2000 + Math.random() * 2000
        else if (_curIdleExpr === "happy") idleRemain = 2000 + Math.random() * 2000
        else idleRemain = 4000 + Math.random() * 4000
      }
    }

    // ── 语音状态覆盖 ──
    if (isListening.value && expr.value !== "listen") { _curIdleExpr = "listen"; applyPillarExpr("listen") }
    else if (isThinking.value && expr.value !== "think") { _curIdleExpr = "think"; applyPillarExpr("think") }
    else if (!isListening.value && !isThinking.value && (expr.value === "listen" || expr.value === "think")) {
      _curIdleExpr = "idle"; applyPillarExpr("idle"); idleRemain = 4000 + Math.random() * 4000
    }

    // ── 光晕呼吸 (CSS 动画已处理柱子呼吸 + 单元侧摆，RAF 只做光晕和扫描条) ──
    var glowBase = 0.25, glowAmp = 0.12
    if (expr.value === "listen" || expr.value === "happy") { glowBase = 0.45; glowAmp = 0.15 }
    else if (expr.value === "closed" || expr.value === "wink") { glowBase = 0.05; glowAmp = 0.02 }
    if (glowLRef.value) glowLRef.value.style.opacity = glowBase + Math.sin(vizT * 0.005) * glowAmp
    if (glowRRef.value) glowRRef.value.style.opacity = glowBase + Math.cos(vizT * 0.005) * glowAmp

    // ── 扫描条 ──
    if (vfillRef.value) {
      var scanPos = ((vizT * 0.025) % 200) - 100
      vfillRef.value.style.backgroundPosition = scanPos + "% 0"
      vfillRef.value.style.opacity = isSpeaking.value ? "0.5" : isListening.value ? "0.35" : "0.15"
    }
  }
  vizAnimId = requestAnimationFrame(updateViz)
}

function stopVizAnim() {
  if (vizAnimId) { cancelAnimationFrame(vizAnimId); vizAnimId = null }
  _exprTarget = null
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
    if (saved?.text && saved.role !== 'system') {
      activeSubtitle.value = { role: saved.role || 'agent', text: saved.text }
    }
  } catch {}
  voice.bindIPCEvents(); voice.startDndTimer()
  _up?.switchPage("voice"); _up?.updateAudio({ volume: 0, speaking: false }); ambient.start("idle"); ambient.setVolume(0.1)
  startVizAnim()
  voice.onStateChange(function(data) {
    switch (data.newState) {
      case VoiceState.THINKING:
        _up?.switchPage("voice"); _up?.updateAudio({ volume: 0, speaking: false, thinking: true }); ambient.transition("thinking"); break
      case VoiceState.SPEAKING:
        _up?.updateAudio({ volume: 0.6, speaking: true, thinking: false }); ambient.transition("idle"); break
    }
  })
  document.addEventListener("keydown", function(e) {
    if (e.target.closest("input, textarea")) return
    if (e.code === "Space" && e.target === document.body) { e.preventDefault(); startVoice() }
    if (e.code === "Escape") { voice.interruptAgent(); streamingText.value = "" }
    if (e.code === "Enter") { e.preventDefault(); showTextInput.value = true; nextTick(function() { textInputEl.value?.focus() }) }
  })
  document.addEventListener("keyup", function(e) { if (e.code === "Space") stopVoice() })

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
  stopVizAnim()
  // 切换页面时不打断 TTS，让语音继续播放
  if (_unsubReminder) { _unsubReminder(); _unsubReminder = null }
  _up?.switchPage("chat"); _up?.updateAudio({ volume: 0, speaking: false }); ambient.stop()
})
</script>

<style scoped>
.voice-page { position: relative; width: 100%; height: 100%; background: linear-gradient(180deg, #e4e8f8 0%, #dce0f4 40%, #e8e4f6 100%); overflow: hidden; }

.voice-viz {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -120%);
  display: flex; flex-direction: column; align-items: center;
  z-index: 5; pointer-events: none;
  background: transparent; border-radius: 20px; padding: 40px 48px 32px;
}
.voice-viz::before {
  content: ''; position: absolute; inset: 0; border-radius: 20px;
  background: radial-gradient(ellipse at 50% 35%, rgba(92,128,224,0.06) 0%, transparent 60%);
}
/* ── 双瞳 v2：柱状双眸 · 梭形横瞳 + 旋转张望 ── */
.viz-eyes { display: flex; gap: 88px; position: relative; z-index: 1; margin-bottom: 20px; }

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

.vvbar { width: 200px; height: 2px; margin: 0 auto 14px; position: relative; z-index: 1; overflow: hidden; border-radius: 1px; background: rgba(0,0,0,0.015); }
.vvfill {
  position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(92,128,224,0.08) 10%, rgba(92,128,224,0.2) 25%, rgba(124,104,224,0.3) 40%, rgba(0,0,0,0.2) 50%, rgba(124,104,224,0.3) 60%, rgba(92,128,224,0.2) 75%, rgba(92,128,224,0.08) 90%, transparent 100%);
  background-size: 200% 100%;
}
.vvstat { font-size: 10px; color: var(--text-muted); position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 6px; }
.vvd { width: 4px; height: 4px; border-radius: 50%; background: var(--accent); opacity: 0.35; animation: vdPulse 2.5s ease-in-out infinite; }
@keyframes vdPulse { 0%,100% { opacity: 0.15; } 50% { opacity: 0.45; } }

.voice-subtitle-area { position: absolute; bottom: 300px; left: 50%; transform: translateX(-50%); z-index: 10; pointer-events: none; width: 85%; max-width: 500px; max-height: 40%; overflow-y: auto; }
.voice-subtitle-bubble { background: rgba(236,238,252,0.85); border: 1px solid rgba(88,104,240,0.14); backdrop-filter: blur(16px); border-radius: 18px; padding: 12px 20px; text-align: left; color: var(--text-secondary); word-break: break-word; white-space: normal; box-shadow: 0 2px 12px rgba(88,104,240,0.08); }
.voice-subtitle-bubble.fadeOut { opacity: 0; transform: translateY(-8px); }
.subtitle-role-tag { display: block; font-size: 10px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px; letter-spacing: 1px; }
.subtitle-text { color: var(--text-primary); font-size: 14px; line-height: 1.55; word-break: break-word; white-space: normal; display: block; }
.streaming-cursor { color: rgba(168,139,250,0.6); animation: blink 0.6s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }

.voice-bottom-bar { position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; z-index: 10; }
.voice-reset-btn {
  width: 36px; height: 36px; border-radius: 50%;
  border: 1px solid rgba(0,0,0,0.06);
  background: rgba(255,255,255,0.5); backdrop-filter: blur(10px);
  color: var(--text-muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.3s;
}
.voice-reset-btn:hover {
  background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.15); color: #EF4444;
}
.voice-reset-btn:active { transform: scale(0.9); }

.voice-mic-btn { width: 50px; height: 50px; border-radius: 50%; border: 1.5px solid rgba(0,0,0,0.08); background: rgba(255,255,255,0.65); backdrop-filter: blur(12px); color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.3s; }
.voice-mic-btn:hover { background: var(--accent-soft); border-color: rgba(92,128,224,0.18); color: var(--accent); }
.voice-mic-btn.listening { background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.25); color: #EF4444; }
.voice-mic-btn.thinking { background: var(--accent-soft); border-color: rgba(92,128,224,0.2); color: var(--accent); animation: micPulse 1.5s ease-in-out infinite; }
@keyframes micPulse { 0%,100% { box-shadow: 0 0 4px rgba(92,128,224,0.08); } 50% { box-shadow: 0 0 12px rgba(92,128,224,0.15); } }
.voice-text-slide { display: flex; align-items: center; width: 260px; opacity: 0; pointer-events: none; transition: opacity 0.2s ease; }
.voice-text-slide.visible { opacity: 1; pointer-events: auto; }
.voice-text-input-slide { width: 100%; height: 38px; padding: 0 42px 0 14px; border: 1px solid var(--border); border-radius: 20px; font-size: 14px; background: rgba(255,255,255,0.7); color: var(--text-primary); outline: none; font-family: inherit; }
.voice-send-slide-btn { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 32px; height: 32px; border-radius: 50%; border: none; background: var(--accent-soft); color: var(--accent); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.voice-send-slide-btn:hover:not(:disabled) { background: rgba(92,128,224,0.16); }
.voice-error-banner { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 10px; background: rgba(255,59,48,0.06); border: 1px solid rgba(255,59,48,0.1); z-index: 30; }
.error-msg { font-size: 11px; color: var(--text-soft); }
.error-retry-btn { padding: 2px 10px; border-radius: 5px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-soft); cursor: pointer; font-size: 10px; }
.error-retry-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
</style>

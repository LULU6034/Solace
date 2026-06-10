<template>
  <div class="voice-page" @click="onPageClick" @wheel="onWheel">
    <div class="voice-viz">
      <div class="vlabel">语音交互界面</div>

      <div class="viz-eyes">
        <div class="eye-unit eye-l" :class="eyeLClass" ref="eyeLRef">
          <div class="eye-pillar" ref="pillarLRef"></div>
          <div class="eye-glow" ref="glowLRef"></div>
        </div>
        <div class="eye-unit eye-r" :class="eyeRClass" ref="eyeRRef">
          <div class="eye-pillar" ref="pillarRRef"></div>
          <div class="eye-glow" ref="glowRRef"></div>
        </div>
      </div>

      <div class="vvbar"><div class="vvfill" ref="vfillRef"></div></div>
      <div class="vvstat"><span class="vvd"></span>{{ exprLabel }}</div>
      <div class="expr-test-row">
        <button v-for="btn in testBtns" :key="btn.key"
          class="expr-test-btn" :class="{ active: testActive === btn.key }"
          @click.stop="triggerTest(btn.key)">{{ btn.label }}</button>
      </div>
    </div>

    <div class="voice-subtitle-area" v-if="activeSubtitle">
      <div class="voice-subtitle-bubble" :class="{ fadeOut: subtitleFading }">
        <span class="subtitle-role-tag">{{ activeSubtitle.role === "user" ? "You" : "Sonder" }}</span>
        <span class="subtitle-text">{{ activeSubtitle.text }}</span>
        <span v-if="streamingText" class="streaming-cursor">|</span>
      </div>
    </div>

    <div class="voice-bottom-bar">
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
import { useVoice, VoiceState } from "../lib/useVoice.js"
import { _up } from "../lib/unified-particles.js"
import { getAmbientSound } from "../lib/ambient-sound.js"
import { playInstantTone, unlockAudio } from "../lib/instant-response.js"

const voice = useVoice()
const ambient = getAmbientSound()
const props = defineProps({ isDark: Boolean, agentConfig: Object })

const textInput = ref(""), textInputEl = ref(null), showTextInput = ref(false)
const activeSubtitle = ref(null), streamingText = ref(""), subtitleFading = ref(false)
const ttsUnavailable = ref(false), degradeNotice = ref(""), showHint = ref(true), isSpeaking = ref(false)
const vfillRef = ref(null), pillarLRef = ref(null), pillarRRef = ref(null)
const glowLRef = ref(null), glowRRef = ref(null), eyeLRef = ref(null), eyeRRef = ref(null)

const isListening = computed(() => voice.state.value === VoiceState.LISTENING)
const isThinking = computed(() => voice.state.value === VoiceState.THINKING)

const exprLabel = computed(() => {
  if (isListening.value) return "聆听中 · 随时可以说话"
  if (isThinking.value) return "思考中 · 请稍候"
  if (isSpeaking.value) return "回复中 · 正在说话"
  return "待命中 · 按住空格键说话"
})

const micBtnClass = computed(() => ({
  listening: isListening.value, thinking: isThinking.value,
  speaking: isSpeaking.value, error: voice.state.value === VoiceState.ERROR,
}))

watch(() => voice.state.value, s => { isSpeaking.value = s === VoiceState.SPEAKING })

function onPageClick(e) {
  if (e.target.closest(".voice-text-slide, .voice-mic-btn, .expr-test-btn")) return
  unlockAudio(); showTextInput.value = !showTextInput.value
  if (showTextInput.value) nextTick(() => textInputEl.value?.focus())
}
function onWheel() {}
function onTextBlur() {}

function pushSubtitle(role, text) {
  if (subtitleFading.value) subtitleFading.value = false
  activeSubtitle.value = { role, text }
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

var voiceHistory = []
async function callAgentVoice(text) {
  var convId = "voice_" + Date.now(), fullText = "", emotion = "neutral", spokenLen = 0
  var messages = [
    { role: "system", content: "You are Sonder, a voice assistant. Reply briefly and naturally." },
    ...voiceHistory.slice(-10), { role: "user", content: text }
  ]
  var agentConfig = await window.electronAPI?.loadConfig()
  if (!agentConfig) {
    var saved = localStorage.getItem('llm-config')
    if (saved) { try { agentConfig = JSON.parse(saved) } catch {} }
  }
  if (!agentConfig) { pushSubtitle("agent", "请先在设置中配置 API Key"); return { text: "请先在设置中配置 API Key", emotion: "worried" } }
  agentConfig.reasoningEffort = 'none'
  playInstantTone("ack")
  return await new Promise(function(resolve) {
    var timer = setTimeout(function() {
      cleanup(); voice.speakViaCosyVoice(fullText, emotion, 1.0)
      voiceHistory.push({ role: "user", content: text }); resolve({ text: fullText || "Okay.", emotion })
    }, 30000)
    function onChunk(data) {
      var d = data?.data || data; if (!d?.content) return
      fullText += d.content; streamingText.value = fullText; pushSubtitle("agent", fullText)
    }
    function onDone(data) {
      clearTimeout(timer); cleanup()
      var d = data?.data || data; if (d?.content) fullText = d.content
      // 解析音乐播放指令
      var musicMatch = fullText.match(/NOW_PLAYING\s*(\{[\s\S]*?\})/)
      if (musicMatch) {
        try {
          var song = JSON.parse(musicMatch[1])
          fullText = fullText.replace(musicMatch[0], '').trim()
          // 清理 markdown 格式，避免 TTS 读特殊字符
          fullText = fullText.replace(/[*_~`#>\-\[\]()]/g, '').replace(/  +/g, ' ')
          var remain = fullText.slice(spokenLen).trim()
          if (remain.length > 0) voice.speakViaCosyVoice(remain, emotion, 1.0)
          // 使用共享音频播放
          if (!window.__musicAudio) window.__musicAudio = new Audio();
          var playPromise = window.electronAPI?.neteaseSongUrl({ songId: song.songId, level: 'higher' });
          if (!playPromise) {
            console.warn('[Voice] neteaseSongUrl API 不可用');
            voiceHistory.push({ role: "user", content: text }, { role: "assistant", content: fullText || "Okay." })
            if (voiceHistory.length > 20) voiceHistory.splice(0, 2)
            resolve({ text: fullText || "Okay.", emotion }); streamingText.value = ""
            return
          }
          playPromise.then(function(r) {
            var url = r?.ok ? (r.data?.url || null) : null
            if (!url) {
              return window.electronAPI?.neteaseSongUrl({ songId: song.songId, level: 'standard' })
            }
            return { ok: true, data: { url: url } }
          }).then(function(r2) {
            if (r2?.ok && r2.data?.url) {
              window.__musicAudio.src = r2.data.url
              window.__musicAudio.play().catch(function(e) { console.warn('[Voice] play() 失败:', e.message) })
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
          voiceHistory.push({ role: "user", content: text }, { role: "assistant", content: fullText || "Okay." })
          if (voiceHistory.length > 20) voiceHistory.splice(0, 2)
          resolve({ text: fullText || "Okay.", emotion }); streamingText.value = ""
          return
        } catch (e) { console.error('[Voice] NOW_PLAYING 解析失败:', e) }
      }
      var remain = fullText.slice(spokenLen).trim()
      // 清理 markdown 格式
      remain = remain.replace(/[*_~`#>\-\[\]()]/g, '').replace(/  +/g, ' ')
      if (remain.length > 0) voice.speakViaCosyVoice(remain, emotion, 1.0)
      voiceHistory.push({ role: "user", content: text }, { role: "assistant", content: fullText || "Okay." })
      if (voiceHistory.length > 20) voiceHistory.splice(0, 2)
      resolve({ text: fullText || "Okay.", emotion }); streamingText.value = ""
    }
    function onError() { clearTimeout(timer); cleanup(); resolve({ text: "Connection failed.", emotion: "worried" }) }
    var _activeVoiceCall = convId
    function cleanup() { unsub1?.(); unsub2?.(); unsub3?.(); _activeVoiceCall = null }
    var unsub1 = window.electronAPI?.onAgentChunk?.((data) => { if (_activeVoiceCall === convId && data?.content) onChunk(data) })
    var unsub2 = window.electronAPI?.onAgentDone?.((data) => { if (_activeVoiceCall === convId) onDone(data) })
    var unsub3 = window.electronAPI?.onAgentError?.((data) => { if (_activeVoiceCall === convId) onError(data) })
    window.electronAPI?.agentChat?.(agentConfig, messages, convId).catch(function(err) {
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
const eyeLClass = computed(() => "expr-" + expr.value)
const eyeRClass = computed(() => "expr-" + expr.value)

const testBtns = [
  { key: "idle", label: "待机" }, { key: "listen", label: "聆听" },
  { key: "think", label: "思考" }, { key: "lookLeft", label: "左看" },
  { key: "lookRight", label: "右看" }, { key: "happy", label: "开心" },
  { key: "closed", label: "闭眼" }, { key: "wink", label: "眨眼" },
  { key: "horizontal", label: "双眼横" }, { key: "horizontalL", label: "左眼横" },
  { key: "horizontalR", label: "右眼横" },
]
const testActive = ref("")
var testTimer = null

// 模块级引用，供 triggerTest 从外部驱动动画
var _exprTarget = null, _testMode = false, _curIdleExpr = "idle"

function triggerTest(key) {
  if (!_exprTarget) return
  testActive.value = key
  _testMode = true
  _curIdleExpr = key
  _exprTarget(key)
  clearTimeout(testTimer)
  testTimer = setTimeout(function() {
    testActive.value = ""
    _testMode = false
    _curIdleExpr = "idle"
    _exprTarget("idle")
  }, 2500)
}

// ── 动画引擎 ──
var vizAnimId = null, vizT = 0

function startVizAnim() {
  var lastTime = performance.now()

  // 参数
  var idleHeight = 80, blinkDuration = 160
  var lerpSpeed = 1 - Math.exp(-16 / 80)

  // 状态
  var curIdleExpr = "idle"
  var blinkT = 0, blinkRemain = 3000, blinkEye = "both", halfBlink = false
  var idleRemain = 4000 + Math.random() * 4000

  var target = { lh: idleHeight, rh: idleHeight, lGlow: 0.5, rGlow: 0.5, lSway: 0, rSway: 0, lRot: 0, rRot: 0 }
  var cur = { lh: idleHeight, rh: idleHeight, lGlow: 0.5, rGlow: 0.5, lSway: 0, rSway: 0, lRot: 0, rRot: 0 }

  function lerp(a, b, t) { return a + (b - a) * t }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
  function clip(v) { return Math.max(-22, Math.min(22, v)) }

  function setTarget(h, glowL, glowR) { target.lh = h; target.rh = h; target.lGlow = glowL; target.rGlow = glowR }

  function applyEye(exprKey) {
    target.lSway = 0; target.rSway = 0; target.lRot = 0; target.rRot = 0
    switch (exprKey) {
      case "listen":   setTarget(idleHeight + 16, 0.7, 0.7); break
      case "think":    setTarget(idleHeight * 0.35, 0.5, 0.55); break
      case "lookLeft": target.lSway = -18; target.rSway = -18; setTarget(idleHeight, 0.5, 0.5); break
      case "lookRight":target.lSway = 18; target.rSway = 18; setTarget(idleHeight, 0.5, 0.5); break
      case "happy":    setTarget(idleHeight + 14, 0.8, 0.8); break
      case "closed":   setTarget(1.5, 0.03, 0.03); break
      case "wink":
        if (Math.random() < 0.5) { target.lh = 1.5; target.rh = idleHeight; blinkEye = "left" }
        else { target.lh = idleHeight; target.rh = 1.5; blinkEye = "right" }
        target.lGlow = 0.03; target.rGlow = 0.03; break
      case "horizontal":   target.lRot = -90; target.rRot = 90; setTarget(idleHeight, 0.5, 0.5); break
      case "horizontalL":  target.lRot = -90; target.rRot = 0; setTarget(idleHeight, 0.5, 0.5); break
      case "horizontalR":  target.lRot = 0; target.rRot = 90; setTarget(idleHeight, 0.5, 0.5); break
      default: setTarget(idleHeight, 0.5, 0.5); break
    }
  }

  // 暴露给外部
  _exprTarget = function(key) { applyEye(key); expr.value = key }

  applyEye("idle"); cur.lh = idleHeight; cur.rh = idleHeight
  _curIdleExpr = "idle"

  function updateViz(ts) {
    vizAnimId = requestAnimationFrame(updateViz)
    var dt = Math.min(ts - lastTime, 50); lastTime = ts; vizT += dt

    // ── 自动眨眼 (2.4-3.4s, 40% 半眨眼) ──
    blinkRemain -= dt
    if (blinkRemain <= 0 && blinkT <= 0) {
      blinkT = 1; halfBlink = Math.random() < 0.4
      blinkEye = "both"
      blinkDuration = 140 + Math.random() * 40
    }
    var blinkProgress = 1
    if (blinkT > 0) {
      blinkT += dt
      var phase = blinkT / blinkDuration
      if (phase >= 1) { blinkT = 0; phase = 1; blinkRemain = 2400 + Math.random() * 1000 }
      if (phase < 0.35) { var t1 = phase / 0.35; blinkProgress = 1 - Math.pow(t1, 0.5) }
      else if (phase < 0.42) { blinkProgress = 0.02 }
      else { var t2 = (phase - 0.42) / 0.58; blinkProgress = Math.pow(t2, 2.0) }
      if (halfBlink) blinkProgress = 0.25 + blinkProgress * 0.75
      blinkProgress = clamp(blinkProgress, 0.01, 1)
    }

    // ── 空闲轮换 (仅非测试模式) ──
    if (expr.value !== "listen" && expr.value !== "think" && !_testMode) {
      idleRemain -= dt
      if (idleRemain <= 0) {
        var pool = ["lookLeft","lookRight","happy","closed","wink","horizontal","horizontalL","horizontalR","idle"]
        pool = pool.filter(function(e) { return e !== curIdleExpr })
        curIdleExpr = pool[Math.floor(Math.random() * pool.length)]
        expr.value = curIdleExpr; _curIdleExpr = curIdleExpr
        applyEye(curIdleExpr)
        if (curIdleExpr === "closed" || curIdleExpr === "wink") idleRemain = 600 + Math.random() * 800
        else if (curIdleExpr === "horizontal" || curIdleExpr === "horizontalL" || curIdleExpr === "horizontalR") idleRemain = 1500 + Math.random() * 1500
        else if (curIdleExpr === "happy") idleRemain = 2000 + Math.random() * 2000
        else idleRemain = 4000 + Math.random() * 4000
      }
    }

    // ── 语音状态覆盖 ──
    if (isListening.value && expr.value !== "listen") { expr.value = "listen"; applyEye("listen") }
    else if (isThinking.value && expr.value !== "think") { expr.value = "think"; applyEye("think") }
    else if (!isListening.value && !isThinking.value && (expr.value === "listen" || expr.value === "think")) {
      expr.value = "idle"; curIdleExpr = "idle"; applyEye("idle"); idleRemain = 4000 + Math.random() * 4000
    }

    // ── 平滑过渡 ──
    for (var k in target) { if (k in cur) cur[k] = lerp(cur[k], target[k], lerpSpeed) }

    // ── 动态摆动 (大幅) ──
    if (expr.value === "idle" || expr.value === "lookLeft" || expr.value === "lookRight") {
      target.lSway = Math.sin(vizT * 0.002) * 14 + Math.sin(vizT * 0.0035) * 6
      target.rSway = Math.sin(vizT * 0.002) * 14 + Math.sin(vizT * 0.0035) * 6
    }

    // ── 眨眼应用 ──
    var lsc = 1, rsc = 1
    if (blinkT > 0 && blinkProgress < 0.99) { lsc = blinkProgress; rsc = blinkProgress }

    // ── 微震 ──
    var jitter = Math.sin(vizT * 0.02) * 7 + Math.sin(vizT * 0.04) * 3 + Math.sin(vizT * 0.008) * 2
    var microL = Math.sin(vizT * 0.06) * 3
    var microR = Math.sin(vizT * 0.06) * 3

    // ── DOM ──
    var lh = clamp(cur.lh * lsc + jitter + microL, 1.5, 110)
    var rh = clamp(cur.rh * rsc + jitter + microR, 1.5, 110)
    var lx = clip(cur.lSway), rx = clip(cur.rSway)
    var lrot = Math.round(lerp(cur.lRot, target.lRot, lerpSpeed))
    var rrot = Math.round(lerp(cur.rRot, target.rRot, lerpSpeed))

    if (pillarLRef.value) {
      pillarLRef.value.style.height = lh + "px"
      pillarLRef.value.style.transform = "translateX(" + lx + "px)"
    }
    if (pillarRRef.value) {
      pillarRRef.value.style.height = rh + "px"
      pillarRRef.value.style.transform = "translateX(" + rx + "px)"
    }
    if (eyeLRef.value) eyeLRef.value.style.transform = "rotate(" + lrot + "deg)"
    if (eyeRRef.value) eyeRRef.value.style.transform = "rotate(" + rrot + "deg)"
    if (glowLRef.value) glowLRef.value.style.opacity = clamp(cur.lGlow + Math.sin(vizT * 0.005) * 0.2, 0, 1)
    if (glowRRef.value) glowRRef.value.style.opacity = clamp(cur.rGlow + Math.cos(vizT * 0.005) * 0.2, 0, 1)

    // 扫描条
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

onMounted(async function() {
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
})

onUnmounted(function() {
  stopVizAnim()
  _up?.switchPage("chat"); _up?.updateAudio({ volume: 0, speaking: false }); ambient.stop(); voice.destroy()
})
</script>

<style scoped>
.voice-page { position: relative; width: 100%; height: 100%; background: transparent; overflow: hidden; }

.voice-viz {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -60%);
  display: flex; flex-direction: column; align-items: center;
  z-index: 5; pointer-events: none;
  background: transparent; border-radius: 20px; padding: 40px 48px 32px;
}
.voice-viz::before {
  content: ''; position: absolute; inset: 0; border-radius: 20px;
  background: radial-gradient(ellipse at 50% 35%, rgba(109,124,255,0.015) 0%, transparent 50%);
}
.vlabel {
  font-size: 8px; letter-spacing: 4px; color: rgba(255,255,255,0.08);
  margin-bottom: 24px; position: relative; z-index: 1; text-transform: uppercase;
}

/* ── 双瞳 ── */
.viz-eyes { display: flex; gap: 64px; position: relative; z-index: 1; margin-bottom: 20px; }
.eye-unit {
  position: relative; width: 10px; height: 100px;
  display: flex; align-items: flex-end; justify-content: center;
  transform-origin: bottom center;
  transition: transform 0.5s ease;
}

.eye-pillar {
  width: 8px; border-radius: 4px; transition: height 0.12s ease-out;
}
.eye-l .eye-pillar {
  height: 80px;
  background: linear-gradient(to top, rgba(109,124,255,0.3), #6d7cff 50%, #a0b8ff);
  box-shadow: 0 0 14px rgba(109,124,255,0.5), 0 0 30px rgba(109,124,255,0.2), 0 0 50px rgba(109,124,255,0.06);
}
.eye-r .eye-pillar {
  height: 80px;
  background: linear-gradient(to top, rgba(154,124,245,0.3), #9a7cf5 50%, #c0a8ff);
  box-shadow: 0 0 14px rgba(154,124,245,0.5), 0 0 30px rgba(154,124,245,0.2), 0 0 50px rgba(154,124,245,0.06);
}

.eye-glow {
  position: absolute; z-index: 1; bottom: -8px;
  width: 28px; height: 96px; border-radius: 50%;
  filter: blur(14px); opacity: 0.2; pointer-events: none;
}
.eye-l .eye-glow { background: radial-gradient(ellipse at center, rgba(109,124,255,0.3) 0%, transparent 70%); }
.eye-r .eye-glow { background: radial-gradient(ellipse at center, rgba(154,124,245,0.3) 0%, transparent 70%); }

.expr-happy .eye-pillar { box-shadow: 0 0 20px rgba(109,124,255,0.6), 0 0 40px rgba(109,124,255,0.25) !important; }
.expr-happy .eye-glow { opacity: 0.5 !important; }
.expr-closed .eye-pillar { height: 2px !important; }
.expr-think .eye-pillar { height: 28px !important; }
.expr-listen .eye-pillar { height: 96px !important; }

/* 横眼 CSS backup (JS 驱动旋转时也生效) */
.expr-horizontal .eye-unit, .expr-horizontalL .eye-unit, .expr-horizontalR .eye-unit { transition: transform 0.5s ease; }

.vvbar { width: 200px; height: 2px; margin: 0 auto 14px; position: relative; z-index: 1; overflow: hidden; border-radius: 1px; background: rgba(255,255,255,0.01); }
.vvfill {
  position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(109,124,255,0.08) 10%, rgba(109,124,255,0.2) 25%, rgba(154,124,245,0.3) 40%, rgba(255,255,255,0.35) 50%, rgba(154,124,245,0.3) 60%, rgba(109,124,255,0.2) 75%, rgba(109,124,255,0.08) 90%, transparent 100%);
  background-size: 200% 100%;
}
.vvstat { font-size: 9px; color: var(--text-muted); position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 5px; }
.vvd { width: 3px; height: 3px; border-radius: 50%; background: var(--accent); animation: vdPulse 2.5s ease-in-out infinite; }
@keyframes vdPulse { 0%,100% { opacity: 0.15; } 50% { opacity: 0.5; } }

.expr-test-row { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; margin-top: 10px; position: relative; z-index: 10; max-width: 320px; }
.expr-test-btn { padding: 3px 7px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.02); color: rgba(255,255,255,0.25); font-size: 10px; cursor: pointer; font-family: inherit; transition: all 0.2s; pointer-events: auto; }
.expr-test-btn:hover { background: rgba(109,124,255,0.08); color: rgba(255,255,255,0.5); border-color: rgba(109,124,255,0.15); }
.expr-test-btn.active { background: rgba(109,124,255,0.12); color: #b0bdff; border-color: rgba(109,124,255,0.2); }

.voice-subtitle-area { position: absolute; top: 70%; left: 50%; transform: translateX(-50%); z-index: 10; pointer-events: none; max-width: 440px; }
.voice-subtitle-bubble { background: rgba(125,140,255,0.06); border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(24px); border-radius: 14px; padding: 12px 18px; text-align: center; color: #c8d2ff; }
.voice-subtitle-bubble.fadeOut { opacity: 0; transform: translateY(-8px); }
.subtitle-role-tag { display: block; font-size: 10px; color: rgba(255,255,255,0.25); text-transform: uppercase; margin-bottom: 4px; }
.subtitle-text { color: #e8eaf0; font-size: 14px; line-height: 1.55; }
.streaming-cursor { color: rgba(168,139,250,0.6); animation: blink 0.6s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }

.voice-bottom-bar { position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; z-index: 10; }
.voice-mic-btn { width: 56px; height: 56px; border-radius: 50%; border: 1.5px solid rgba(255,255,255,0.1); background: rgba(125,140,255,0.04); backdrop-filter: blur(20px); color: rgba(255,255,255,0.6); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.3s; }
.voice-mic-btn:hover { transform: scale(1.04); background: rgba(125,140,255,0.08); border-color: rgba(255,255,255,0.15); }
.voice-mic-btn.listening { background: rgba(239,68,68,0.15); border-color: rgba(239,68,68,0.3); color: #EF4444; }
.voice-mic-btn.thinking { background: rgba(125,140,255,0.15); border-color: rgba(125,140,255,0.25); color: #b0bdff; animation: micPulse 1.5s ease-in-out infinite; }
@keyframes micPulse { 0%,100% { box-shadow: 0 0 8px rgba(125,140,255,0.1); } 50% { box-shadow: 0 0 24px rgba(125,140,255,0.2); } }
.voice-text-slide { display: flex; align-items: center; width: 260px; opacity: 0; pointer-events: none; transition: opacity 0.2s ease; }
.voice-text-slide.visible { opacity: 1; pointer-events: auto; }
.voice-text-input-slide { width: 100%; height: 38px; padding: 0 42px 0 14px; border: 1px solid rgba(255,255,255,0.08); border-radius: 20px; font-size: 14px; background: rgba(125,140,255,0.04); backdrop-filter: blur(16px); color: #e0e4ec; outline: none; font-family: inherit; }
.voice-send-slide-btn { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 32px; height: 32px; border-radius: 50%; border: none; background: rgba(125,140,255,0.08); color: rgba(176,189,255,0.7); cursor: pointer; display: flex; align-items: center; justify-content: center; }
.voice-send-slide-btn:hover:not(:disabled) { background: rgba(125,140,255,0.14); color: #b0bdff; }
.voice-error-banner { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 10px; background: rgba(153,27,27,0.1); border: 1px solid rgba(153,27,27,0.15); backdrop-filter: blur(20px); z-index: 30; }
.error-msg { font-size: 11px; color: rgba(255,255,255,0.5); }
.error-retry-btn { padding: 2px 10px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.4); cursor: pointer; font-size: 10px; }
.error-retry-btn:hover { background: rgba(255,255,255,0.08); color: white; }
</style>

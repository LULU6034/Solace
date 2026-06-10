<template>
  <div class="mini-player" v-if="currentTrack" :class="{ playing: isPlaying }">
    <div class="mp-art">
      <img v-if="cover" :src="cover + '?param=80y80'" class="mp-art-img" />
      <div v-else class="mp-art-fallback">♪</div>
    </div>

    <div class="mp-info">
      <span class="mp-name">{{ currentTrack.name }}</span>
      <span class="mp-artist">{{ currentTrack.artist }}</span>
    </div>

    <div class="mp-progress">
      <input type="range" class="mp-slider" min="0" :max="duration || 1" :value="currentTime"
        @input="onSeek" :style="{ '--fill': (duration ? (currentTime/duration)*100 : 0) + '%' }" />
    </div>

    <div class="mp-ctrls">
      <button class="mp-btn" @click="togglePlay" :title="isPlaying ? '暂停' : '播放'">
        {{ isPlaying ? '⏸' : '▶' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const currentTrack = ref(null)
const cover = ref('')
const isPlaying = ref(false)
const currentTime = ref(0)
const duration = ref(0)

let tickTimer = null

// ── 统一音频引用（只读，不创建）──
function getAudio() {
  if (!window.__musicAudio) {
    window.__musicAudio = new Audio()
  }
  return window.__musicAudio
}

function onPlay() { isPlaying.value = true }
function onPause() { isPlaying.value = false }

function startTick() {
  stopTick()
  const a = getAudio()
  a.addEventListener('play', onPlay)
  a.addEventListener('pause', onPause)
  a.addEventListener('ended', onPause)
  tickTimer = setInterval(() => {
    if (a && !a.paused) {
      currentTime.value = a.currentTime
      duration.value = a.duration || 0
    }
  }, 250)
}

function stopTick() {
  clearInterval(tickTimer); tickTimer = null
  try {
    const a = getAudio()
    a.removeEventListener('play', onPlay)
    a.removeEventListener('pause', onPause)
    a.removeEventListener('ended', onPause)
  } catch {}
}

function togglePlay() {
  const a = getAudio()
  if (!a.src) return
  if (a.paused) a.play().catch(() => {})
  else a.pause()
}

function onSeek(e) {
  getAudio().currentTime = parseFloat(e.target.value)
}

function onNowPlaying(e) {
  const { name, artist, cover: c } = e.detail || {}
  if (!name) return
  currentTrack.value = { name, artist }
  cover.value = c || ''
  currentTime.value = 0
  duration.value = 0
}

onMounted(() => {
  window.addEventListener('music-nowplaying', onNowPlaying)
  // 恢复已有播放状态
  const a = getAudio()
  if (a && a.src) {
    isPlaying.value = !a.paused
    duration.value = a.duration || 0
    currentTime.value = a.currentTime || 0
  }
  startTick()
})

onUnmounted(() => {
  stopTick()
  window.removeEventListener('music-nowplaying', onNowPlaying)
})
</script>

<style scoped>
.mini-player {
  display: flex; align-items: center; gap: 12px;
  margin-left: auto; flex-shrink: 0;
  padding: 5px 14px 5px 6px; border-radius: 24px;
  background: rgba(20, 22, 32, 0.65);
  border: 1px solid rgba(255,255,255,0.06);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  transition: all 0.35s ease;
  max-width: 380px;
}
.mini-player.playing {
  border-color: rgba(109,124,255,0.2);
}

.mp-art {
  width: 32px; height: 32px; flex-shrink: 0;
  border-radius: 50%; overflow: hidden; position: relative;
  background: linear-gradient(145deg, #1b1e2f, #0f111c);
  box-shadow: 0 2px 8px rgba(0,0,0,0.3), inset 0 0 0 1px rgba(255,255,255,0.05);
}
.mini-player.playing .mp-art {
  animation: artBreathe 2.4s ease-in-out infinite;
}
@keyframes artBreathe {
  0%, 100% { box-shadow: 0 0 0 1px rgba(109,124,255,0.25), 0 0 12px rgba(109,124,255,0.1); }
  50%       { box-shadow: 0 0 0 1px rgba(109,124,255,0.5), 0 0 22px rgba(109,124,255,0.2); }
}
.mp-art-img {
  width: 100%; height: 100%; object-fit: cover; border-radius: 50%;
}
.mini-player.playing .mp-art-img {
  animation: artSpin 8s linear infinite;
}
@keyframes artSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.mp-art-fallback {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(circle at 30% 20%, rgba(109,124,255,0.25), rgba(20,22,44,0.9));
  font-size: 14px; color: rgba(255,255,255,0.5);
}
.mp-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; max-width: 140px; }
.mp-name { font-size: 12px; font-weight: 600; color: #eeeff5; letter-spacing: -0.2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-artist { font-size: 10px; color: rgba(148,152,168,0.55); font-weight: 450; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp-progress { width: 70px; flex-shrink: 0; }
.mp-slider {
  -webkit-appearance: none; width: 100%; height: 4px; border-radius: 8px; cursor: pointer;
  background: linear-gradient(to right, #6d7cff 0%, #6d7cff var(--fill, 0%), rgba(255,255,255,0.12) var(--fill, 0%), rgba(255,255,255,0.12) 100%);
  outline: none;
}
.mp-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #ffffff;
  box-shadow: 0 0 10px rgba(109,124,255,0.4), 0 1px 3px rgba(0,0,0,0.2);
  cursor: pointer; transition: transform 0.12s; margin-top: -4px;
}
.mp-slider::-webkit-slider-thumb:hover { transform: scale(1.28); background: #6d7cff; }
.mp-ctrls { display: flex; align-items: center; flex-shrink: 0; }
.mp-btn {
  width: 30px; height: 30px; border-radius: 50%; border: none;
  background: rgba(109,124,255,0.12); color: #c0c4d0;
  cursor: pointer; font-size: 11px; display: flex; align-items: center; justify-content: center;
  transition: all 0.2s cubic-bezier(0.2,0.9,0.4,1.1);
  box-shadow: 0 2px 6px rgba(0,0,0,0.15);
}
.mp-btn:hover { background: rgba(109,124,255,0.22); color: #fff; transform: scale(1.06); }
.mini-player.playing .mp-btn { background: rgba(109,124,255,0.22); box-shadow: 0 0 14px rgba(109,124,255,0.2); color: #fff; }
</style>

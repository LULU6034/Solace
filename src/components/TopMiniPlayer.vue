<template>
  <div class="mini-player" v-if="currentTrack" :class="{ playing: isPlaying, expanded: showVolume }">
    <!-- 封面 -->
    <div class="mp-art" @click="togglePlay">
      <img v-if="cover" :src="cover + '?param=80y80'" class="mp-art-img" />
      <div v-else class="mp-art-fallback">♪</div>
      <div class="mp-art-overlay">
        <span v-if="isPlaying">⏸</span>
        <span v-else>▶</span>
      </div>
    </div>

    <!-- 歌曲信息 -->
    <div class="mp-info" @click="togglePlay">
      <span class="mp-name" :class="{ scroll: nameOverflow }">
        <span ref="nameInner" class="mp-name-inner">{{ currentTrack.name }}</span>
      </span>
      <span class="mp-artist">{{ currentTrack.artist || '未知歌手' }}</span>
    </div>

    <!-- 进度条 -->
    <div class="mp-progress">
      <input type="range" class="mp-slider" min="0" :max="duration || 1" :value="currentTime"
        @input="onSeek" :style="{ '--fill': progressPct + '%' }" />
    </div>

    <!-- 播放控制 -->
    <div class="mp-ctrls">
      <button class="mp-btn skip" @click="prevTrack" title="上一首" :disabled="!hasPrev">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round">
          <polygon points="19,20 9,12 19,4" /><line x1="5" y1="19" x2="5" y2="5" />
        </svg>
      </button>

      <button class="mp-btn play" @click="togglePlay" :title="isPlaying ? '暂停' : '播放'">
        <svg v-if="isPlaying" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <rect x="5" y="4" width="5" height="16" rx="1" /><rect x="14" y="4" width="5" height="16" rx="1" />
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="6,3 20,12 6,21" />
        </svg>
      </button>

      <button class="mp-btn skip" @click="nextTrack" title="下一首" :disabled="!hasNext">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round">
          <polygon points="5,4 15,12 5,20" /><line x1="19" y1="5" x2="19" y2="19" />
        </svg>
      </button>
    </div>

    <!-- 音量 -->
    <div class="mp-volume">
      <button class="mp-vol-btn" @click="toggleMute" title="静音切换">
        <svg v-if="volume === 0 || muted" width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
          <line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
        </svg>
        <svg v-else-if="volume < 0.5" width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
          <path d="M15.54,8.46a5,5,0,0,1,0,7.07" />
        </svg>
        <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
          <path d="M19.07,4.93a10,10,0,0,1,0,14.14" /><path d="M15.54,8.46a5,5,0,0,1,0,7.07" />
        </svg>
      </button>
      <input type="range" class="mp-vol-slider" min="0" max="100" :value="volDisplay"
        @input="onVolume" :style="{ '--vol-fill': volDisplay + '%' }" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'

// ── 状态 ──
const currentTrack = ref(null)
const cover = ref('')
const isPlaying = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(1)
const muted = ref(false)
const nameInner = ref(null)
const nameOverflow = ref(false)

let tickTimer = null

// ── 队列 ──
const queue = ref([])       // [{ songId, name, artist, cover }]
const queueIndex = ref(-1)
const hasPrev = computed(() => queueIndex.value > 0)
const hasNext = computed(() => queueIndex.value < queue.value.length - 1)

// ── 计算属性 ──
const progressPct = computed(() => duration.value ? (currentTime.value / duration.value) * 100 : 0)
const volDisplay = computed(() => muted.value ? 0 : Math.round(volume.value * 100))

// ── 音频引用 ──
function getAudio() {
  if (!window.__musicAudio) {
    window.__musicAudio = new Audio()
    window.__musicAudio.volume = volume.value
  }
  return window.__musicAudio
}

function onPlay() {
  isPlaying.value = true
  if (currentTrack.value?.songId) {
    window.__musicCurrentTrack = { songId: String(currentTrack.value.songId), name: currentTrack.value.name, artist: currentTrack.value.artist || '', cover: cover.value || '' }
  }
}
function onPause() { isPlaying.value = false; window.__musicCurrentTrack = null }

async function playNextFromPlaylist() {
  try {
    const pl = JSON.parse(localStorage.getItem('music-playlist') || '[]');
    if (!pl.length) return false;
    const curId = currentTrack.value?.songId;
    let idx = curId ? pl.findIndex(s => s.songId === curId) : -1;
    // 找到当前歌 → 播下一首；找不到 → 从第一首开始；已到末尾 → 循环回第一首
    if (idx >= 0 && idx < pl.length - 1) {
      const next = pl[idx + 1];
      return await playSong(next.songId, next.name, next.artist, next.cover);
    } else if (idx === pl.length - 1 && pl.length > 1) {
      // 最后一首 → 循环回第一首
      return await playSong(pl[0].songId, pl[0].name, pl[0].artist, pl[0].cover);
    } else if (idx < 0 && pl.length > 0) {
      return await playSong(pl[0].songId, pl[0].name, pl[0].artist, pl[0].cover);
    }
  } catch {}
  return false;
}

function onEnded() {
  isPlaying.value = false
  // 自动下一首：先队列，再歌单
  if (hasNext.value) { nextTrack(); return }
  playNextFromPlaylist();
}

function onAudioError() {
  console.warn('[MiniPlayer] 音频加载失败，尝试下一首')
  isPlaying.value = false
  if (hasNext.value) { nextTrack(); return }
  playNextFromPlaylist();
}

// ── 定时器 ──
function startTick() {
  stopTick()
  const a = getAudio()
  a.addEventListener('play', onPlay)
  a.addEventListener('pause', onPause)
  a.addEventListener('ended', onEnded)
  a.addEventListener('error', onAudioError)
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
    a.removeEventListener('ended', onEnded)
    a.removeEventListener('error', onAudioError)
  } catch {}
}

// ── 播放控制 ──
function togglePlay() {
  const a = getAudio()
  if (!a.src) return
  if (a.paused) a.play().catch(() => {})
  else a.pause()
}

function onSeek(e) {
  getAudio().currentTime = parseFloat(e.target.value)
}

async function playSong(songId, name, artist, cov) {
  try {
    let r = await window.electronAPI?.neteaseSongUrl({ songId, level: 'higher' })
    if (!r?.ok || !r.data?.url) {
      r = await window.electronAPI?.neteaseSongUrl({ songId, level: 'standard' })
    }
    if (!r?.ok || !r.data?.url) {
      console.warn('[MiniPlayer] 无播放源:', name)
      return false
    }
    const a = getAudio()
    a.src = r.data.url
    a.play().catch(() => {})
    window.__musicCurrentTrack = { songId: String(songId), name, artist, cover: cov || '' };
    window.dispatchEvent(new CustomEvent('music-nowplaying', {
      detail: { songId, name, artist, cover: cov, reason: '队列播放' }
    }))
    return true
  } catch { return false }
}

async function prevTrack() {
  if (!hasPrev.value) return
  const idx = queueIndex.value - 1
  const song = queue.value[idx]
  if (song) {
    queueIndex.value = idx
    await playSong(song.songId, song.name, song.artist, song.cover)
  }
}

async function nextTrack() {
  if (!hasNext.value) return
  const idx = queueIndex.value + 1
  const song = queue.value[idx]
  if (song) {
    queueIndex.value = idx
    await playSong(song.songId, song.name, song.artist, song.cover)
  }
}

// ── 音量控制 ──
function toggleMute() {
  const a = getAudio()
  if (muted.value) {
    muted.value = false
    a.volume = volume.value
  } else {
    muted.value = true
    volume.value = a.volume || 1
    a.volume = 0
  }
}

function onVolume(e) {
  const v = parseInt(e.target.value) / 100
  volume.value = v
  muted.value = false
  getAudio().volume = v
}

// ── 事件处理 ──
function onNowPlaying(e) {
  const { songId, name, artist, cover: c } = e.detail || {}
  if (!songId || !name) return

  currentTrack.value = { songId, name, artist: artist || '未知歌手' }
  cover.value = c || ''
  currentTime.value = 0
  duration.value = 0
  window.__musicCurrentTrack = { songId: String(songId), name, artist: artist || '', cover: c || '' }

  // 加入队列（去重）
  const existingIdx = queue.value.findIndex(q => q.songId === songId)
  if (existingIdx >= 0) {
    queueIndex.value = existingIdx
  } else {
    queue.value.push({ songId, name, artist: artist || '', cover: c || '' })
    queueIndex.value = queue.value.length - 1
  }

  nextTick(() => checkNameOverflow())
}

// 歌单追加事件（不立即播放）
function onEnqueue(e) {
  const { songId, name, artist, cover: c } = e.detail || {}
  if (!songId || !name) return
  const exists = queue.value.find(q => q.songId === songId)
  if (!exists) queue.value.push({ songId, name, artist: artist || '', cover: c || '' })
}

// ── 长歌名滚动检测 ──
function checkNameOverflow() {
  const el = nameInner.value
  if (!el) return
  nameOverflow.value = el.scrollWidth > el.parentElement.clientWidth
}

// ── 生命周期 ──
onMounted(() => {
  window.addEventListener('music-nowplaying', onNowPlaying)
  window.addEventListener('music-enqueue', onEnqueue)
  const a = getAudio()
  volume.value = a.volume || 1
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
  window.removeEventListener('music-enqueue', onEnqueue)
})
</script>

<style scoped>
/* ═══ 容器 ═══ */
.mini-player {
  display: flex; align-items: center; gap: 0;
  margin-left: auto; flex-shrink: 0;
  height: 36px; padding: 0 6px 0 4px; border-radius: 20px;
  background: rgba(20, 22, 32, 0.7);
  border: 1px solid rgba(255,255,255,0.05);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
}
.mini-player.playing {
  border-color: rgba(109,124,255,0.2);
  box-shadow: 0 0 16px rgba(109,124,255,0.06);
}

/* ═══ 封面 ═══ */
.mp-art {
  width: 28px; height: 28px; flex-shrink: 0; border-radius: 50%;
  overflow: hidden; position: relative; cursor: pointer;
  background: linear-gradient(145deg, #1b1e2f, #0f111c);
  box-shadow: 0 1px 4px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.04);
}
.mini-player.playing .mp-art {
  animation: artBreathe 2.6s ease-in-out infinite;
}
@keyframes artBreathe {
  0%,100%{box-shadow:0 0 0 1px rgba(109,124,255,0.18),0 0 10px rgba(109,124,255,0.06)}
  50%{box-shadow:0 0 0 1px rgba(109,124,255,0.4),0 0 18px rgba(109,124,255,0.14)}
}
.mp-art-img {
  width: 100%; height: 100%; object-fit: cover; border-radius: 50%;
}
.mini-player.playing .mp-art-img {
  animation: artSpin 10s linear infinite;
}
@keyframes artSpin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
.mp-art-fallback {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(circle at 30% 20%, rgba(109,124,255,0.25), rgba(20,22,44,0.9));
  font-size: 12px; color: rgba(255,255,255,0.4);
}
.mp-art-overlay {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.4); opacity: 0; transition: opacity 0.2s;
  border-radius: 50%; font-size: 10px; color: #fff;
}
.mp-art:hover .mp-art-overlay { opacity: 1; }

/* ═══ 信息 ═══ */
.mp-info {
  display: flex; flex-direction: column; justify-content: center;
  min-width: 0; max-width: 120px; padding: 0 10px; cursor: pointer;
  line-height: 1.2;
}
.mp-name {
  font-size: 11px; font-weight: 600; color: #eeeff5; letter-spacing: -0.1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mp-name.scroll .mp-name-inner {
  display: inline-block; animation: nameScroll 8s linear infinite;
}
@keyframes nameScroll {
  0%{transform:translateX(0)} 30%{transform:translateX(0)}
  70%{transform:translateX(calc(-100% + 120px))} 100%{transform:translateX(calc(-100% + 120px))}
}
.mp-artist {
  font-size: 9px; color: rgba(148,152,168,0.5); font-weight: 450;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ═══ 进度条 ═══ */
.mp-progress { width: 56px; flex-shrink: 0; }
.mp-slider {
  -webkit-appearance: none; width: 100%; height: 3px; border-radius: 4px; cursor: pointer;
  background: linear-gradient(to right, #6d7cff 0%, #6d7cff var(--fill, 0%), rgba(255,255,255,0.08) var(--fill), rgba(255,255,255,0.08) 100%);
  outline: none; margin: 0;
}
.mp-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%; background: #fff;
  box-shadow: 0 0 8px rgba(109,124,255,0.4); cursor: pointer; transition: transform 0.12s;
}
.mp-slider::-webkit-slider-thumb:hover { transform: scale(1.25); background: #6d7cff; }

/* ═══ 控制按钮 ═══ */
.mp-ctrls { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.mp-btn {
  width: 26px; height: 26px; border-radius: 50%; border: none;
  background: transparent; color: rgba(192,196,208,0.6);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: all 0.2s cubic-bezier(0.2,0.9,0.4,1.1);
}
.mp-btn:hover { background: rgba(109,124,255,0.1); color: #c0c4d0; }
.mp-btn:active { transform: scale(0.92); }
.mp-btn:disabled { opacity: 0.25; cursor: default; pointer-events: none; }
.mp-btn.play {
  width: 30px; height: 30px; background: rgba(109,124,255,0.15); color: #c0c4d0;
  box-shadow: 0 2px 6px rgba(0,0,0,0.15);
}
.mp-btn.play:hover { background: rgba(109,124,255,0.25); color: #fff; transform: scale(1.05); }
.mini-player.playing .mp-btn.play {
  background: rgba(109,124,255,0.22); color: #fff;
  box-shadow: 0 0 12px rgba(109,124,255,0.15);
}

/* ═══ 音量 ═══ */
.mp-volume {
  display: flex; align-items: center; gap: 4px;
  padding: 0 6px; flex-shrink: 0;
}
.mp-vol-btn {
  width: 22px; height: 22px; border-radius: 50%; border: none;
  background: transparent; color: rgba(192,196,208,0.45);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: all 0.2s; flex-shrink: 0;
}
.mp-vol-btn:hover { color: #c0c4d0; background: rgba(109,124,255,0.08); }
.mp-vol-slider {
  -webkit-appearance: none; width: 52px; height: 3px; border-radius: 4px; cursor: pointer;
  background: linear-gradient(to right, rgba(192,196,208,0.65) 0%, rgba(192,196,208,0.65) var(--vol-fill, 80%), rgba(255,255,255,0.06) var(--vol-fill), rgba(255,255,255,0.06) 100%);
  outline: none;
}
.mp-vol-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%; background: #c0c4d0;
  box-shadow: 0 0 6px rgba(0,0,0,0.2); cursor: pointer; transition: transform 0.12s;
}
.mp-vol-slider::-webkit-slider-thumb:hover { transform: scale(1.25); background: #fff; }
</style>

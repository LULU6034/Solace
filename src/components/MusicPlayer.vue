<template>
  <div class="music-player">
    <!-- 头部 -->
    <div class="player-header">
      <span class="player-icon">&#9835;</span>
      <span class="player-title">音乐</span>
      <span class="player-badge" v-if="isPlaying">播放中</span>
      <button class="search-toggle" @click="showSearch = !showSearch" title="搜索歌曲">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
    </div>

    <!-- 登录状态条 -->
    <div class="login-bar" v-if="!isLoggedIn">
      <button class="login-btn" @click="showQr = true" :disabled="qrLoading">
        {{ qrLoading ? '加载中...' : '登录网易云' }}
      </button>
    </div>
    <div class="login-bar logged-in" v-else>
      <img v-if="userInfo.avatarUrl" :src="userInfo.avatarUrl + '?param=30y30'" class="user-avatar" />
      <span class="user-name">{{ userInfo.nickname }}</span>
      <button class="logout-btn" @click="doLogout" title="退出">✕</button>
    </div>

    <!-- 二维码弹窗 -->
    <div v-if="showQr" class="qr-overlay" @click.self="closeQr">
      <div class="qr-box">
        <div class="qr-header">
          <span>扫码登录</span>
          <button class="qr-close" @click="closeQr">✕</button>
        </div>
        <img v-if="qrImg" :src="qrImg" class="qr-img" />
        <div v-else class="qr-loading">加载二维码...</div>
        <div class="qr-hint">{{ qrHint }}</div>
        <button v-if="qrExpired" class="qr-refresh" @click="createQr">刷新二维码</button>
      </div>
    </div>

    <!-- 搜索栏 -->
    <div v-if="showSearch" class="search-box">
      <input v-model="searchKw" class="search-input" placeholder="搜索歌曲..."
        @keydown.enter="doSearch" @keydown.escape="showSearch = false" ref="searchInput" />
      <button class="search-clear" v-if="searchKw" @click="searchKw = ''; searchResults = []">✕</button>
      <button class="search-go" @click="doSearch" :disabled="!searchKw.trim() || searching">
        {{ searching ? '…' : '搜' }}
      </button>
    </div>

    <!-- 搜索结果 -->
    <div v-if="searchResults.length" class="search-results">
      <div v-for="(s, i) in searchResults.slice(0, 6)" :key="s.id"
        class="search-item" :class="{ playing: currentId === s.id && isPlaying }"
        @click="playSearchResult(i)">
        <img v-if="s.cover" :src="s.cover + '?param=40y40'" class="si-cover" />
        <div v-else class="si-cover si-cover-empty">&#9835;</div>
        <div class="si-info">
          <span class="si-name">{{ s.name }}</span>
          <span class="si-artist">{{ s.artist }}</span>
        </div>
        <span class="si-dur">{{ fmtDur(s.duration) }}</span>
      </div>
    </div>

    <!-- 专辑封面 -->
    <div class="art-box">
      <img v-if="currentCover" :src="currentCover + '?param=160y160'" class="art-img" />
      <div v-else class="art-inner">
        <svg viewBox="0 0 80 80" class="art-svg">
          <circle cx="40" cy="40" r="30" fill="none" stroke="rgba(109,124,255,0.1)" stroke-width="1"/>
          <circle cx="40" cy="40" r="20" fill="none" stroke="rgba(154,124,245,0.08)" stroke-width="0.5"/>
          <path d="M40 15 L40 40 L58 50" fill="none" stroke="rgba(109,124,255,0.15)" stroke-width="2" stroke-linecap="round"/>
          <circle cx="40" cy="40" r="4" fill="rgba(109,124,255,0.1)"/>
        </svg>
        <div class="art-eq" v-if="isPlaying">
          <span v-for="i in 6" :key="i" :style="{ animationDelay: [0,0.2,0.4,0.3,0.5,0.1][i-1] + 's' }"></span>
        </div>
      </div>
    </div>

    <!-- 歌曲信息 -->
    <div class="track-info">
      <span class="track-name">{{ currentTrack?.name || '未选择' }}</span>
      <span class="track-artist">{{ currentTrack?.artist || '—' }}</span>
    </div>

    <!-- 进度条 -->
    <div class="player-progress">
      <input type="range" class="progress-bar" min="0" :max="duration || 1" :value="currentTime"
        @input="onSeek($event)" :disabled="!duration" />
      <div class="player-time">
        <span>{{ fmtDur(currentTime) }}</span>
        <span>{{ fmtDur(duration) }}</span>
      </div>
    </div>

    <!-- 控制 -->
    <div class="player-controls">
      <button class="ctrl-btn" @click="prevTrack" title="上一首">&#x23EE;</button>
      <button class="ctrl-btn play-btn" @click="togglePlay" :title="isPlaying ? '暂停' : '播放'">
        <span v-if="!isPlaying">&#x25B6;</span>
        <span v-else>&#x23F8;</span>
      </button>
      <button class="ctrl-btn" @click="nextTrack" title="下一首">&#x23ED;</button>
    </div>

    <!-- 歌单区域 -->
    <div v-if="!searchResults.length" class="playlist-section">
      <!-- 登录后：我的歌单 + 每日推荐 -->
      <template v-if="isLoggedIn">
        <div class="section-header">我的歌单</div>
        <div v-for="pl in myPlaylists.slice(0, 3)" :key="pl.id"
          class="playlist-item" @click="loadPlaylist(pl)">
          <img v-if="pl.cover" :src="pl.cover + '?param=40y40'" class="pl-cover" />
          <div class="pl-info">
            <span class="pl-name">{{ pl.name }}</span>
            <span class="pl-meta">{{ pl.trackCount }} 首{{ pl.isOwner ? ' · 我创建' : '' }}</span>
          </div>
        </div>
        <div class="playlist-item" @click="loadLikedSongs" v-if="likedCount > 0">
          <div class="pl-cover pl-cover-liked">♥</div>
          <div class="pl-info">
            <span class="pl-name">我喜欢的音乐</span>
            <span class="pl-meta">{{ likedCount }} 首</span>
          </div>
        </div>
        <div class="playlist-item" @click="loadDailySongs">
          <div class="pl-cover pl-cover-daily">📅</div>
          <div class="pl-info">
            <span class="pl-name">每日推荐</span>
            <span class="pl-meta">根据你的口味生成</span>
          </div>
        </div>
      </template>

      <!-- 推荐歌单（无需登录） -->
      <div class="section-header">推荐歌单</div>
      <div v-for="pl in playlists.slice(0, isLoggedIn ? 2 : 4)" :key="pl.id"
        class="playlist-item" @click="loadPlaylist(pl)">
        <img v-if="pl.cover" :src="pl.cover + '?param=40y40'" class="pl-cover" />
        <div class="pl-info">
          <span class="pl-name">{{ pl.name }}</span>
          <span class="pl-meta">{{ pl.trackCount }} 首</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, shallowRef, onMounted, nextTick, watch, onUnmounted } from 'vue'

// ── 默认歌单 ──
const FALLBACK = [
  { id: '__0', name: 'Midnight Dreams', artist: 'Luna Wave', cover: '', duration: 180 },
  { id: '__1', name: 'Electric Pulse', artist: 'Neon Drift', cover: '', duration: 210 },
  { id: '__2', name: 'Starlight', artist: 'Cosmic Tide', cover: '', duration: 165 },
]

// ── 登录 ──
const isLoggedIn = ref(false)
const userInfo = ref({})
const showQr = ref(false)
const qrImg = ref('')
const qrHint = ref('')
const qrLoading = ref(false)
const qrExpired = ref(false)
let qrKey = ''
let qrTimer = null

// ── 搜索 ──
const showSearch = ref(false)
const searchKw = ref('')
const searching = ref(false)
const searchResults = ref([])
const searchInput = ref(null)

// ── 播放 ──
const playlist = shallowRef([...FALLBACK])
const queueIndex = ref(-1)
const currentId = ref(null)
const currentCover = ref('')
const isPlaying = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const currentTrack = ref(null)

// ── 歌单 ──
const playlists = ref([])
const myPlaylists = ref([])
const likedCount = ref(0)

let audioEl = null

function fmtDur(t) {
  if (!t || isNaN(t)) return '0:00'
  const m = Math.floor(t / 60), s = Math.floor(t % 60)
  return m + ':' + (s < 10 ? '0' : '') + s
}

// ── 音频（共用全局 __musicAudio，TTS 说话时能统一闪避）──
function initAudio() {
  if (!window.__musicAudio) window.__musicAudio = new Audio()
  if (audioEl && audioEl === window.__musicAudio) return
  audioEl = window.__musicAudio
  // 防止重复绑定事件
  if (audioEl._musicEventsBound) return
  audioEl._musicEventsBound = true
  audioEl.addEventListener('timeupdate', () => { currentTime.value = audioEl.currentTime })
  audioEl.addEventListener('loadedmetadata', () => { duration.value = audioEl.duration })
  audioEl.addEventListener('ended', () => { nextTrack() })
  audioEl.addEventListener('play', () => { isPlaying.value = true })
  audioEl.addEventListener('pause', () => { isPlaying.value = false })
  audioEl.addEventListener('error', () => {
    isPlaying.value = false
    if (queueIndex.value < playlist.value.length - 1) nextTrack()
  })
}

async function getPlayUrl(songId) {
  try {
    const r = await window.electronAPI?.neteaseSongUrl({ songId, level: 'higher' })
    if (r?.ok && r.data?.url) return r.data.url
  } catch {}
  return null
}

async function playTrack(index) {
  initAudio()
  const list = playlist.value
  if (index < 0 || index >= list.length) return
  queueIndex.value = index
  const song = list[index]
  currentTrack.value = song
  currentId.value = song.id
  currentCover.value = song.cover || ''

  if (song.id && !song.id.startsWith('__')) {
    const url = await getPlayUrl(song.id)
    if (url) { audioEl.src = url; audioEl.load(); audioEl.play().catch(() => {}); return }
    nextTrack()
    return
  }
  if (song.url) { audioEl.src = song.url; audioEl.load(); audioEl.play().catch(() => { isPlaying.value = false }) }
}

function togglePlay() {
  initAudio()
  if (!audioEl.src || queueIndex.value < 0) { playTrack(0); return }
  if (isPlaying.value) { audioEl.pause() }
  else { audioEl.play().catch(() => { isPlaying.value = false }) }
}
function nextTrack() { const len = playlist.value.length; if (len) playTrack((queueIndex.value + 1) % len) }
function prevTrack() { const len = playlist.value.length; if (len) playTrack((queueIndex.value - 1 + len) % len) }
function onSeek(e) { if (audioEl) { audioEl.currentTime = parseFloat(e.target.value); currentTime.value = audioEl.currentTime } }

// ── 搜索 ──
async function doSearch() {
  const kw = searchKw.value.trim()
  if (!kw || searching.value) return
  searching.value = true; searchResults.value = []
  try {
    const r = await window.electronAPI?.neteaseSearch({ keywords: kw, limit: 12 })
    if (r?.ok) searchResults.value = r.data.songs
  } catch (err) { console.error('[Music] 搜索失败:', err) }
  searching.value = false
}
function playSearchResult(index) {
  const song = searchResults.value[index]; if (!song) return
  playlist.value = [...searchResults.value]
  const idx = playlist.value.findIndex(s => s.id === song.id)
  playTrack(idx >= 0 ? idx : 0); showSearch.value = false
}

// ── 歌单 ──
async function loadPlaylist(pl) {
  try {
    const r = await window.electronAPI?.neteasePlaylistDetail({ playlistId: pl.id })
    if (r?.ok && r.data.tracks?.length) { playlist.value = r.data.tracks; searchResults.value = []; playTrack(0) }
  } catch (err) { console.error('[Music] 加载歌单失败:', err) }
}
async function loadLikedSongs() {
  try {
    const r = await window.electronAPI?.neteaseLikedSongs({})
    if (r?.ok && r.data.tracks?.length) { playlist.value = r.data.tracks; searchResults.value = []; playTrack(0) }
  } catch (err) { console.error('[Music] 加载喜欢失败:', err) }
}
async function loadDailySongs() {
  try {
    const r = await window.electronAPI?.neteaseDailySongs()
    if (r?.ok && r.data?.length) { playlist.value = r.data; searchResults.value = []; playTrack(0) }
  } catch (err) { console.error('[Music] 每日推荐失败:', err) }
}

// ── 登录 ──
async function createQr() {
  qrLoading.value = true; qrExpired.value = false
  try {
    const r = await window.electronAPI?.neteaseQrCreate()
    if (r?.ok && r.data.qrImg) {
      qrImg.value = r.data.qrImg; qrKey = r.data.key; qrHint.value = '请用网易云音乐 App 扫码'
      startQrPoll()
    } else { qrHint.value = '获取二维码失败' }
  } catch (err) { qrHint.value = '网络错误: ' + err.message }
  qrLoading.value = false
}
function startQrPoll() {
  clearInterval(qrTimer)
  qrTimer = setInterval(async () => {
    if (!qrKey) return
    const r = await window.electronAPI?.neteaseQrCheck({ key: qrKey })
    if (!r?.ok) return
    qrHint.value = r.data.message
    if (r.data.code === 803) { closeQr(); await checkLogin(); return }
    if (r.data.code === 800) { qrExpired.value = true; clearInterval(qrTimer); qrHint.value = '二维码已过期，请刷新' }
  }, 2000)
}
function closeQr() {
  showQr.value = false; clearInterval(qrTimer); qrKey = ''
  qrImg.value = ''; qrHint.value = ''; qrExpired.value = false
}
async function checkLogin() {
  const r = await window.electronAPI?.neteaseLoginStatus()
  if (r?.ok && r.data.loggedIn) { isLoggedIn.value = true; userInfo.value = r.data.user; loadUserData() }
}
async function doLogout() {
  await window.electronAPI?.neteaseLogout()
  isLoggedIn.value = false; userInfo.value = {}; myPlaylists.value = []; likedCount.value = 0
}
async function loadUserData() {
  try {
    const [pl, liked] = await Promise.allSettled([
      window.electronAPI?.neteaseUserPlaylists({}),
      window.electronAPI?.neteaseLikedSongs({}),
    ])
    if (pl.status === 'fulfilled' && pl.value?.ok) myPlaylists.value = pl.value.data
    if (liked.status === 'fulfilled' && liked.value?.ok) likedCount.value = liked.value.data.trackCount || 0
  } catch {}
}

// ── 初始 ──
onMounted(async () => {
  await checkLogin()
  try {
    const r = await window.electronAPI?.neteaseRecommendPlaylists()
    if (r?.ok) playlists.value = r.data
  } catch {}
})
watch(showSearch, (v) => { if (v) nextTick(() => searchInput.value?.focus()) })
watch(showQr, (v) => { if (v) createQr() })
onUnmounted(() => { clearInterval(qrTimer) })
</script>

<style scoped>
.music-player {
  margin: 4px 4px 0; padding: 12px 10px;
  border-radius: 14px; background: rgba(255,255,255,0.008);
  border: 1px solid rgba(255,255,255,0.02);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  max-height: 520px; overflow-y: auto;
}
.player-header { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; }
.player-icon { font-size: 10px; color: var(--text-muted); }
.player-title { font-size: 9px; font-weight: 600; color: var(--text-secondary); letter-spacing: 1px; }
.player-badge {
  margin-left: auto; font-size: 7px; padding: 1px 5px;
  border-radius: 5px; background: rgba(109,124,255,0.06); color: rgba(109,124,255,0.4);
  animation: badgePulse 2s ease-in-out infinite;
}
@keyframes badgePulse { 0%,100%{opacity:0.4} 50%{opacity:1} }

/* 登录 */
.login-bar { display: flex; align-items: center; justify-content: center; margin-bottom: 6px; }
.login-btn {
  padding: 4px 14px; border-radius: 12px; border: 1px solid rgba(255,0,0,0.15);
  background: rgba(255,0,0,0.06); color: rgba(255,100,100,0.7); cursor: pointer;
  font-size: 10px; font-family: inherit; transition: all 0.2s;
}
.login-btn:hover { background: rgba(255,0,0,0.12); color: rgba(255,120,120,0.9); }
.login-bar.logged-in { gap: 6px; }
.user-avatar { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; }
.user-name { font-size: 10px; color: var(--text-secondary); flex: 1; }
.logout-btn {
  width: 16px; height: 16px; border-radius: 50%; border: none; background: rgba(255,255,255,0.05);
  color: var(--text-muted); cursor: pointer; font-size: 8px; display: flex; align-items: center; justify-content: center;
}

/* QR */
.qr-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
.qr-box { background: var(--bg); border: 1px solid var(--border); border-radius: 14px; padding: 24px; text-align: center; min-width: 220px; }
.qr-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-size: 13px; color: var(--text-primary); }
.qr-close { border: none; background: none; color: var(--text-muted); cursor: pointer; font-size: 14px; }
.qr-img { width: 180px; height: 180px; border-radius: 8px; }
.qr-loading { width: 180px; height: 180px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 12px; }
.qr-hint { margin-top: 10px; font-size: 11px; color: var(--text-muted); }
.qr-refresh { margin-top: 8px; padding: 4px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-secondary); cursor: pointer; font-size: 11px; }

/* 搜索 */
.search-toggle {
  width: 20px; height: 20px; border: none; background: none;
  color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center;
  border-radius: 4px; transition: all 0.2s; flex-shrink: 0;
}
.search-toggle:hover { color: var(--text-primary); background: rgba(255,255,255,0.04); }
.search-box { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; position: relative; }
.search-input {
  flex: 1; padding: 5px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.02); color: var(--text-primary); font-size: 11px;
  font-family: inherit; outline: none;
}
.search-input:focus { border-color: rgba(109,124,255,0.2); }
.search-clear { position: absolute; right: 28px; border: none; background: none; color: var(--text-muted); cursor: pointer; font-size: 10px; padding: 2px 4px; }
.search-go {
  padding: 4px 8px; border-radius: 5px; border: 1px solid rgba(109,124,255,0.15);
  background: rgba(109,124,255,0.06); color: rgba(176,189,255,0.7);
  cursor: pointer; font-size: 10px; font-family: inherit;
}
.search-go:hover:not(:disabled) { background: rgba(109,124,255,0.12); }
.search-go:disabled { opacity: 0.3; cursor: default; }
.search-results { margin-bottom: 8px; max-height: 160px; overflow-y: auto; }
.search-item { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 6px; cursor: pointer; transition: background 0.15s; }
.search-item:hover { background: rgba(255,255,255,0.03); }
.search-item.playing { background: rgba(109,124,255,0.08); }
.si-cover { width: 28px; height: 28px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
.si-cover-empty { display: flex; align-items: center; justify-content: center; background: rgba(109,124,255,0.06); color: var(--text-muted); font-size: 10px; }
.si-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.si-name { font-size: 10px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.si-artist { font-size: 9px; color: var(--text-muted); }
.si-dur { font-size: 9px; color: var(--text-muted); flex-shrink: 0; }

/* 封面 */
.art-box {
  width: 80px; height: 80px; margin: 0 auto 8px;
  border-radius: 12px; background: linear-gradient(135deg, rgba(109,124,255,0.04), rgba(154,124,245,0.04));
  border: 1px solid rgba(255,255,255,0.03);
  display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden;
}
.art-img { width: 100%; height: 100%; object-fit: cover; border-radius: 12px; }
.art-inner { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; }
.art-svg { width: 55%; height: 55%; }
.art-eq { display: flex; gap: 2px; align-items: flex-end; height: 12px; }
.art-eq span { width: 2px; border-radius: 1px; background: linear-gradient(to top, #6d7cff, #9a7cf5); animation: eqBounce 1.2s ease-in-out infinite; }
.art-eq span:nth-child(1) { height: 5px; } .art-eq span:nth-child(2) { height: 8px; } .art-eq span:nth-child(3) { height: 11px; }
.art-eq span:nth-child(4) { height: 9px; } .art-eq span:nth-child(5) { height: 6px; } .art-eq span:nth-child(6) { height: 4px; }
@keyframes eqBounce { 0%,100% { transform: scaleY(1); opacity: 0.5; } 50% { transform: scaleY(1.5); opacity: 1; } }

.track-info { display: flex; flex-direction: column; align-items: center; gap: 1px; margin-bottom: 8px; }
.track-name { font-size: 11px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
.track-artist { font-size: 9px; color: var(--text-muted); max-width: 130px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.player-progress { margin-bottom: 6px; }
.progress-bar { -webkit-appearance: none; width: 100%; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.04); outline: none; cursor: pointer; }
.progress-bar::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: linear-gradient(135deg, #6d7cff, #9a7cf5); cursor: pointer; border: 2px solid rgba(255,255,255,0.08); box-shadow: 0 0 10px rgba(109,124,255,0.15); transition: transform 0.2s; }
.progress-bar::-webkit-slider-thumb:hover { transform: scale(1.2); }
.progress-bar:disabled { opacity: 0.3; }
.player-time { display: flex; justify-content: space-between; margin-top: 2px; }
.player-time span { font-size: 8px; color: var(--text-muted); font-family: var(--font-mono, 'JetBrains Mono', monospace); }

.player-controls { display: flex; justify-content: center; align-items: center; gap: 8px; }
.ctrl-btn { width: 28px; height: 28px; border-radius: 50%; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; transition: all 0.35s; display: flex; align-items: center; justify-content: center; font-size: 10px; }
.ctrl-btn:hover { background: rgba(109,124,255,0.06); color: var(--accent-glow); transform: scale(1.1); }
.ctrl-btn:active { transform: scale(0.92); }
.play-btn { width: 32px; height: 32px; background: rgba(109,124,255,0.06); }
.play-btn:hover { background: rgba(109,124,255,0.1); box-shadow: 0 0 20px rgba(109,124,255,0.06); }

/* 歌单 */
.playlist-section { margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.03); padding-top: 8px; }
.section-header { font-size: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); margin: 4px 0; }
.playlist-item { display: flex; align-items: center; gap: 6px; padding: 4px 4px; border-radius: 6px; cursor: pointer; transition: background 0.15s; }
.playlist-item:hover { background: rgba(255,255,255,0.03); }
.pl-cover { width: 28px; height: 28px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
.pl-cover-liked { display: flex; align-items: center; justify-content: center; background: rgba(255,80,80,0.1); color: rgba(255,100,100,0.6); font-size: 12px; }
.pl-cover-daily { display: flex; align-items: center; justify-content: center; background: rgba(109,124,255,0.08); font-size: 12px; }
.pl-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pl-name { font-size: 10px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-meta { font-size: 8px; color: var(--text-muted); }
</style>

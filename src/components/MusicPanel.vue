<template>
  <div class="music-panel">
    <!-- 检查中 -->
    <div v-if="loginChecking" class="login-checking">检查登录状态...</div>

    <!-- 未登录 -->
    <template v-else-if="!isLoggedIn">
      <div class="login-hero">
        <div class="login-hero-icon">♪</div>
        <div class="login-hero-text">登录网易云音乐</div>
        <div class="login-hero-desc">同步你的歌单、喜欢和每日推荐</div>
        <button class="login-hero-btn" @click="showQr = true" :disabled="qrLoading">
          {{ qrLoading ? '加载中...' : '扫码登录' }}
        </button>
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

      <div class="section-divider">
        <span>或直接搜索</span>
      </div>
    </template>

    <!-- 已登录：用户信息 -->
    <div v-else class="user-info-card">
      <img v-if="userInfo.avatarUrl" :src="userInfo.avatarUrl + '?param=60y60'" class="user-info-avatar" />
      <div class="user-info-text">
        <div class="user-info-name">{{ userInfo.nickname }}</div>
        <div class="user-info-stats">
          <span>{{ myPlaylists.length }} 个歌单</span>
          <span>·</span>
          <span>{{ likedCount }} 首喜欢</span>
        </div>
      </div>
      <button class="user-info-logout" @click="doLogout">退出</button>
    </div>

    <!-- 搜索（登录/未登录都可用） -->
    <div class="search-section">
      <div class="search-row">
        <input v-model="searchKw" class="search-input" placeholder="搜索歌曲、专辑、歌手..."
          @keydown.enter="doSearch" ref="searchInput" />
        <button class="search-btn" @click="doSearch" :disabled="!searchKw.trim() || searching">
          {{ searching ? '...' : '搜索' }}
        </button>
      </div>

      <!-- 搜索结果 -->
      <div v-if="searchResults.length" class="search-results">
        <div class="results-header">
          找到 {{ searchTotal }} 首歌曲
          <button class="results-playall" @click="playAll">全部播放</button>
        </div>
        <div v-for="(s, i) in searchResults" :key="s.id"
          class="result-item" @dblclick="playIndex(i)">
          <span class="result-idx">{{ i + 1 }}</span>
          <img v-if="s.cover" :src="s.cover + '?param=40y40'" class="result-cover" />
          <div v-else class="result-cover result-cover-empty">♪</div>
          <div class="result-info">
            <span class="result-name">{{ s.name }}</span>
            <span class="result-artist">{{ s.artist }} · {{ s.album }}</span>
          </div>
          <span class="result-dur">{{ fmtDur(s.duration) }}</span>
          <button class="result-play" @click="playIndex(i)" title="播放">▶</button>
        </div>
      </div>

      <!-- 搜索为空 -->
      <div v-else-if="searched" class="search-empty">
        未找到相关歌曲
      </div>
    </div>

    <!-- 已登录：我的内容 -->
    <template v-if="isLoggedIn">
      <div class="section-title">我的歌单</div>
      <div class="playlist-grid">
        <div v-for="pl in myPlaylists" :key="pl.id"
          class="playlist-card" @click="loadPlaylist(pl)">
          <img v-if="pl.cover" :src="pl.cover + '?param=80y80'" class="pl-card-cover" />
          <div v-else class="pl-card-cover pl-card-cover-empty">♪</div>
          <span class="pl-card-name">{{ pl.name }}</span>
          <span class="pl-card-count">{{ pl.trackCount }} 首</span>
        </div>
      </div>

      <div class="section-title">快捷入口</div>
      <div class="quick-actions">
        <button class="quick-btn" @click="loadLikedSongs">
          <span class="quick-icon">♥</span>
          <span class="quick-label">我喜欢的音乐</span>
          <span class="quick-count">{{ likedCount }} 首</span>
        </button>
        <button class="quick-btn" @click="loadDailySongs">
          <span class="quick-icon">📅</span>
          <span class="quick-label">每日推荐</span>
        </button>
        <button class="quick-btn" @click="loadPersonalFm">
          <span class="quick-icon">📻</span>
          <span class="quick-label">私人 FM</span>
        </button>
        <button class="quick-btn" @click="loadIntelligenceList" :disabled="!currentTrack?.id">
          <span class="quick-icon">💓</span>
          <span class="quick-label">心动模式</span>
          <span class="quick-count">{{ currentTrack ? '基于「' + currentTrack.name + '」' : '请先播放一首歌' }}</span>
        </button>
      </div>
    </template>

    <!-- 当前播放 -->
    <div v-if="currentTrack" class="now-playing-bar">
      <img v-if="currentCover" :src="currentCover + '?param=40y40'" class="np-cover" />
      <div class="np-info">
        <span class="np-name">{{ currentTrack.name }}</span>
        <span class="np-artist">{{ currentTrack.artist }}</span>
      </div>
      <button class="np-ctrl" @click="togglePlay" :title="isPlaying ? '暂停' : '播放'">
        {{ isPlaying ? '⏸' : '▶' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'

// ── 登录 ──
const isLoggedIn = ref(false)
const loginChecking = ref(true)
const userInfo = ref({})
const showQr = ref(false)
const qrImg = ref('')
const qrHint = ref('')
const qrLoading = ref(false)
const qrExpired = ref(false)
let qrKey = '', qrTimer = null

// ── 搜索 ──
const searchKw = ref('')
const searching = ref(false)
const searched = ref(false)
const searchResults = ref([])
const searchTotal = ref(0)
const searchInput = ref(null)

// ── 我的数据 ──
const myPlaylists = ref([])
const likedCount = ref(0)

// ── 播放 ──
const currentTrack = ref(null)
const currentCover = ref('')
const isPlaying = ref(false)
let audioEl = null
let playerPlaylist = []
let playerIndex = 0

function fmtDur(t) {
  if (!t || isNaN(t)) return '0:00'
  return Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0')
}

// ── 音乐反馈收集 ──
let _playStartTime = 0
function recordFeedback(action, weight) {
  const song = playerPlaylist[playerIndex]
  if (!song || song.id.startsWith('__')) return
  const feedback = {
    type: 'music_feedback',
    songId: song.id,
    songName: song.name,
    artist: song.artist,
    genres: song.genres || '',
    action,
    actionWeight: weight,
    timestamp: Date.now(),
  }
  // 存入待发送队列
  try {
    const queue = JSON.parse(localStorage.getItem('music-feedback-queue') || '[]')
    queue.push(feedback)
    if (queue.length > 50) queue.shift()
    localStorage.setItem('music-feedback-queue', JSON.stringify(queue))
  } catch {}
}

// ── 使用全局共享音频 ──
function initAudio() {
  if (audioEl) return
  if (window.__musicAudio) {
    audioEl = window.__musicAudio
  } else {
    audioEl = new Audio()
    window.__musicAudio = audioEl
  }
  audioEl.addEventListener('play', () => {
    isPlaying.value = true
    _playStartTime = Date.now()
  })
  audioEl.addEventListener('pause', () => {
    isPlaying.value = false
  })
  audioEl.addEventListener('ended', () => {
    const elapsed = (Date.now() - _playStartTime) / 1000
    const dur = audioEl.duration || 1
    if (elapsed / dur >= 0.9) recordFeedback('complete', 2)
    playIndex(playerIndex + 1)
  })
  audioEl.addEventListener('error', () => { playIndex(playerIndex + 1) })

  window.addEventListener('music-skip', () => {
    const elapsed = (Date.now() - _playStartTime) / 1000
    const dur = audioEl?.duration || 1
    if (elapsed / dur < 0.3) recordFeedback('skip_early', -2)
    else if (elapsed / dur > 0.7) recordFeedback('skip_late', -0.5)
    else recordFeedback('skip', -1)
  })
  window.addEventListener('music-repeat', () => {
    recordFeedback('repeat', 5)
  })
}

async function playIndex(index) {
  initAudio()
  if (index < 0 || index >= playerPlaylist.length) {
    isPlaying.value = false
    return
  }
  playerIndex = index
  const song = playerPlaylist[index]
  currentTrack.value = song
  currentCover.value = song.cover || ''
  // 通知顶部迷你播放器
  window.dispatchEvent(new CustomEvent('music-nowplaying', {
    detail: { songId: song.id, name: song.name, artist: song.artist, cover: song.cover, reason: '' }
  }))

  try {
    const r = await window.electronAPI?.neteaseSongUrl({ songId: song.id, level: 'higher' })
    const url = r?.ok ? r.data?.url : null
    if (!url) {
      const retry = await window.electronAPI?.neteaseSongUrl({ songId: song.id, level: 'standard' })
      const url2 = retry?.ok ? retry.data?.url : null
      if (!url2) { playIndex(index + 1); return }
      audioEl.src = url2
    } else {
      audioEl.src = url
    }
    audioEl.load()
    audioEl.play().catch(() => { playIndex(index + 1) })
  } catch { playIndex(index + 1) }
}

function togglePlay() {
  if (!audioEl?.src) { playIndex(0); return }
  if (isPlaying.value) audioEl.pause()
  else audioEl.play().catch(() => {})
}

function playAll() {
  if (!searchResults.value.length) return
  playerPlaylist = [...searchResults.value]
  playIndex(0)
}

// ── 搜索 ──
async function doSearch() {
  const kw = searchKw.value.trim()
  if (!kw || searching.value) return
  searching.value = true; searched.value = false; searchResults.value = []
  try {
    const r = await window.electronAPI?.neteaseSearch({ keywords: kw, limit: 30 })
    if (r?.ok) {
      searchResults.value = r.data.songs
      searchTotal.value = r.data.total
      playerPlaylist = r.data.songs
    }
  } catch {}
  searching.value = false; searched.value = true
}

// ── 歌单 ──
async function loadPlaylist(pl) {
  try {
    const r = await window.electronAPI?.neteasePlaylistDetail({ playlistId: pl.id })
    if (r?.ok && r.data.tracks?.length) {
      searchResults.value = r.data.tracks
      searchTotal.value = r.data.trackCount
      playerPlaylist = r.data.tracks
      searched.value = true
    }
  } catch {}
}

async function loadLikedSongs() {
  try {
    const r = await window.electronAPI?.neteaseLikedSongs({})
    if (r?.ok && r.data.tracks?.length) {
      searchResults.value = r.data.tracks
      searchTotal.value = r.data.trackCount
      playerPlaylist = r.data.tracks
      searched.value = true
    }
  } catch {}
}

async function loadDailySongs() {
  try {
    const r = await window.electronAPI?.neteaseDailySongs()
    if (r?.ok && r.data?.length) {
      searchResults.value = r.data
      searchTotal.value = r.data.length
      playerPlaylist = r.data
      searched.value = true
    }
  } catch {}
}

async function loadPersonalFm() {
  try {
    const r = await window.electronAPI?.neteasePersonalFm()
    if (r?.ok && r.data?.length) {
      searchResults.value = r.data
      searchTotal.value = r.data.length
      playerPlaylist = r.data
      searched.value = true
    }
  } catch {}
}

async function loadIntelligenceList() {
  if (!currentTrack.value?.id) return
  try {
    const r = await window.electronAPI?.neteaseIntelligenceList({
      songId: currentTrack.value.id,
      count: 30,
    })
    if (r?.ok && r.data?.length) {
      searchResults.value = r.data
      searchTotal.value = r.data.length
      playerPlaylist = r.data
      searched.value = true
      playIndex(0)
    }
  } catch {}
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
  } catch (err) { qrHint.value = '网络错误' }
  qrLoading.value = false
}

function startQrPoll() {
  clearInterval(qrTimer)
  qrTimer = setInterval(async () => {
    if (!qrKey) return
    const r = await window.electronAPI?.neteaseQrCheck({ key: qrKey })
    if (!r?.ok) return
    qrHint.value = r.data.message
    if (r.data.code === 803) { closeQr(); await checkLogin() }
    if (r.data.code === 800) { qrExpired.value = true; clearInterval(qrTimer); qrHint.value = '二维码已过期，请刷新' }
  }, 2000)
}

function closeQr() {
  showQr.value = false; clearInterval(qrTimer); qrKey = ''
  qrImg.value = ''; qrHint.value = ''; qrExpired.value = false
}

async function checkLogin() {
  loginChecking.value = true
  const r = await window.electronAPI?.neteaseLoginStatus()
  if (r?.ok && r.data.loggedIn) {
    isLoggedIn.value = true
    userInfo.value = r.data.user
    loadUserData()
  }
  loginChecking.value = false
}

async function doLogout() {
  loginChecking.value = true
  await window.electronAPI?.neteaseLogout()
  isLoggedIn.value = false; userInfo.value = {}; myPlaylists.value = []; likedCount.value = 0
  loginChecking.value = false
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

watch(showQr, (v) => { if (v) createQr() })

onMounted(() => { checkLogin() })
onUnmounted(() => { clearInterval(qrTimer) })
</script>

<style scoped>
.music-panel { display: flex; flex-direction: column; gap: 14px; max-width: 100%; }

.login-checking { text-align: center; padding: 40px 0; font-size: 12px; color: var(--text-muted); }

/* 登录引导 */
.login-hero { text-align: center; padding: 20px 0; }
.login-hero-icon { font-size: 36px; color: var(--text-muted); margin-bottom: 8px; }
.login-hero-text { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.login-hero-desc { font-size: 11px; color: var(--text-muted); margin: 4px 0 12px; }
.login-hero-btn {
  padding: 8px 24px; border-radius: 8px; border: none;
  background: linear-gradient(135deg, #EC4141, #D32F2F);
  color: #fff; cursor: pointer; font-size: 13px; font-family: inherit;
  transition: all 0.2s;
}
.login-hero-btn:hover { transform: translateY(-1px); filter: brightness(1.1); }
.login-hero-btn:disabled { opacity: 0.5; transform: none; }

.section-divider {
  display: flex; align-items: center; gap: 12px; margin: 8px 0;
}
.section-divider::before, .section-divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.section-divider span { font-size: 11px; color: var(--text-muted); }

/* 用户卡片 */
.user-info-card { display: flex; align-items: center; gap: 10px; padding: 12px; background: var(--bg-sidebar); border-radius: 10px; border: 1px solid var(--border); }
.user-info-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
.user-info-text { flex: 1; }
.user-info-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.user-info-stats { font-size: 10px; color: var(--text-muted); display: flex; gap: 4px; margin-top: 2px; }
.user-info-logout {
  padding: 3px 10px; border-radius: 5px; border: 1px solid var(--border);
  background: none; color: var(--text-muted); cursor: pointer; font-size: 10px; font-family: inherit;
}
.user-info-logout:hover { border-color: #EC4141; color: #EC4141; }

/* 搜索 */
.search-section { display: flex; flex-direction: column; gap: 8px; }
.search-row { display: flex; gap: 6px; }
.search-input {
  flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-primary); font-size: 13px; font-family: inherit; outline: none;
}
.search-input:focus { border-color: var(--accent); }
.search-btn {
  padding: 8px 16px; border-radius: 8px; border: 1px solid var(--accent);
  background: var(--accent); color: #fff; cursor: pointer; font-size: 13px; font-family: inherit;
}
.search-btn:hover { filter: brightness(1.1); }
.search-btn:disabled { opacity: 0.4; cursor: default; filter: none; }

.search-results { display: flex; flex-direction: column; max-height: 300px; overflow-y: auto; }
.results-header { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-bottom: 4px; padding: 0 4px; }
.results-playall { padding: 2px 8px; border-radius: 5px; border: 1px solid var(--border); background: none; color: var(--text-secondary); cursor: pointer; font-size: 10px; font-family: inherit; }
.results-playall:hover { border-color: var(--accent); color: var(--accent); }
.result-item {
  display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-radius: 6px; cursor: pointer; transition: background 0.1s;
}
.result-item:hover { background: rgba(255,255,255,0.03); }
.result-idx { width: 20px; text-align: center; font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
.result-cover { width: 30px; height: 30px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
.result-cover-empty { display: flex; align-items: center; justify-content: center; background: rgba(109,124,255,0.06); color: var(--text-muted); font-size: 12px; }
.result-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.result-name { font-size: 12px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.result-artist { font-size: 10px; color: var(--text-muted); }
.result-dur { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.result-play {
  width: 24px; height: 24px; border-radius: 50%; border: none; background: rgba(109,124,255,0.06);
  color: var(--text-secondary); cursor: pointer; font-size: 8px; display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.result-play:hover { background: rgba(109,124,255,0.12); color: var(--accent); }
.search-empty { text-align: center; font-size: 12px; color: var(--text-muted); padding: 20px 0; }

/* 歌单网格 */
.section-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.playlist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.playlist-card {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 8px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-card); cursor: pointer; transition: all 0.15s;
}
.playlist-card:hover { border-color: var(--border-strong); background: var(--bg-sidebar-hover); }
.pl-card-cover { width: 60px; height: 60px; border-radius: 6px; object-fit: cover; }
.pl-card-cover-empty { display: flex; align-items: center; justify-content: center; background: rgba(109,124,255,0.06); color: var(--text-muted); font-size: 18px; }
.pl-card-name { font-size: 10px; color: var(--text-primary); text-align: center; max-width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-card-count { font-size: 9px; color: var(--text-muted); }

/* 快捷入口 */
.quick-actions { display: flex; flex-direction: column; gap: 6px; }
.quick-btn {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-radius: 8px; border: 1px solid var(--border); background: var(--bg-card);
  cursor: pointer; transition: all 0.15s; text-align: left; font-family: inherit;
}
.quick-btn:hover { border-color: var(--border-strong); background: var(--bg-sidebar-hover); }
.quick-icon { font-size: 16px; flex-shrink: 0; width: 24px; text-align: center; }
.quick-label { font-size: 12px; color: var(--text-primary); flex: 1; }
.quick-count { font-size: 10px; color: var(--text-muted); }

/* 当前播放 */
.now-playing-bar {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-radius: 8px; background: var(--bg-sidebar); border: 1px solid var(--border);
  margin-top: auto;
}
.np-cover { width: 28px; height: 28px; border-radius: 4px; object-fit: cover; }
.np-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.np-name { font-size: 11px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.np-artist { font-size: 9px; color: var(--text-muted); }
.np-ctrl {
  width: 28px; height: 28px; border-radius: 50%; border: none; background: rgba(109,124,255,0.08);
  color: var(--accent); cursor: pointer; font-size: 10px; display: flex; align-items: center; justify-content: center;
}

/* QR 弹窗 */
.qr-overlay { position: fixed; inset: 0; z-index: 1100; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
.qr-box { background: var(--bg); border: 1px solid var(--border); border-radius: 14px; padding: 24px; text-align: center; min-width: 220px; }
.qr-header { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 13px; color: var(--text-primary); }
.qr-close { border: none; background: none; color: var(--text-muted); cursor: pointer; font-size: 14px; }
.qr-img { width: 180px; height: 180px; border-radius: 8px; }
.qr-loading { width: 180px; height: 180px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 12px; }
.qr-hint { margin-top: 10px; font-size: 11px; color: var(--text-muted); }
.qr-refresh { margin-top: 8px; padding: 4px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-secondary); cursor: pointer; font-size: 11px; }
</style>

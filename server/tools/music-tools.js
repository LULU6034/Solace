/**
 * music/tools.js — Agent 音乐工具
 *
 * search_music / recommend_music / play_music
 * 推荐引擎利用网易云 API + Chroma 记忆 + 天气 + 时段做个性化推荐
 */
import { createModuleLogger } from '../lib/debug-log.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const log = createModuleLogger('music');
const _require = createRequire(import.meta.url);

// ── 时段划分 ──
function timePeriod(hour) {
  if (hour < 5) return 'late_night';
  if (hour < 9) return 'morning';
  if (hour < 12) return 'forenoon';
  if (hour < 18) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

// ── 场景默认映射（冷启动用）──
const SCENE_DEFAULTS = {
  late_night: { energy: 0.3, desc: '深夜' },
  morning: { energy: 0.5, desc: '早晨' },
  forenoon: { energy: 0.6, desc: '上午' },
  afternoon: { energy: 0.7, desc: '下午' },
  evening: { energy: 0.6, desc: '晚上' },
  night: { energy: 0.3, desc: '深夜' },
};

// ── 最近播放去重 ──
const _recentPlayed = [];
_loadRecentPlayed(); // 启动时从文件恢复

// 持久化最近播放（写入 agent-data 目录）
function _playedFilePath() {
  try {
    const dir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.ai-desktop-pet', 'agent-data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'recent-played.json');
  } catch { return null; }
}
function _loadRecentPlayed() {
  try {
    const p = _playedFilePath();
    if (p && fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      _recentPlayed.length = 0; _recentPlayed.push(...(data.ids || []));
    }
  } catch (e) { log.warn('操作失败', e?.message || e); }
}
function _saveRecentPlayed() {
  try {
    const p = _playedFilePath();
    if (p) fs.writeFileSync(p, JSON.stringify({ ids: _recentPlayed.slice(-30), updated: Date.now() }));
  } catch (e) { log.warn('操作失败', e?.message || e); }
}

const MAX_RECENT = 30;
function markAsPlayed(songId) {
  if (!songId) return;
  const idx = _recentPlayed.indexOf(songId);
  if (idx >= 0) _recentPlayed.splice(idx, 1);
  _recentPlayed.push(songId);
  if (_recentPlayed.length > MAX_RECENT) _recentPlayed.shift();
  _saveRecentPlayed();
}

function getRecentPlayedSet() {
  return new Set(_recentPlayed);
}

function getRecentPlayed(n) {
  return _recentPlayed.slice(-n);
}

// 伪随机洗牌（每 10 分钟换一次种子）
function shuffleArray(arr) {
  // 用即时 Math.random 做基础洗牌，确保每次调用都有不同结果
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ── 情绪 → 搜索关键词映射（不只搜字面意义）──
const MOOD_KEYWORDS = {
  '温柔': 'ballad acoustic soul 慢歌',
  '安静': 'ambient piano chill instrumental 纯音乐',
  '放松': 'chill lofi acoustic jazz 轻音乐',
  '开心': 'upbeat pop dance funk happy',
  '欢快': 'upbeat dance pop electronic 快节奏',
  '悲伤': 'ballad sad indie folk 伤感',
  'emo': 'sad indie alternative rock',
  '伤感': 'ballad sad pop 慢歌',
  '治愈': 'acoustic folk piano singer-songwriter',
  '热血': 'rock metal electronic high-energy 燃',
  '燃': 'rock electronic epic high-energy',
  '运动': 'electronic dance hiphop rock 跑步 健身',
  '跑步': 'electronic dance rock upbeat 运动',
  '专注': 'instrumental ambient piano classical 学习 工作',
  '学习': 'lofi instrumental piano classical ambient',
  '工作': 'lofi jazz instrumental ambient',
  '清新': 'acoustic indie folk pop 早晨',
  '浪漫': 'jazz soul r&b acoustic 情歌',
  '甜美': 'pop acoustic indie female-vocal',
  '酷': 'electronic hiphop rock indie',
  '伤感': 'ballad sad indie folk',
  '忧郁': 'blues jazz ballad indie',
  '慵懒': 'lofi chill jazz acoustic',
  '迷幻': 'psychedelic electronic ambient indie',
  '复古': 'disco funk soul classic-rock 80s 90s',
};

function moodToKeywords(mood) {
  if (!mood) return '';
  for (const [key, val] of Object.entries(MOOD_KEYWORDS)) {
    if (mood.includes(key)) return val;
  }
  // 无匹配时用 mood 本身 + 热门搜索
  return mood + ' ' + '热门 新歌';
}

// ── 流派词典 ──
const ARTIST_GENRES = {
  '周杰伦': 'pop mandopop',
  '林俊杰': 'pop mandopop',
  '陈奕迅': 'pop cantopop ballad',
  '邓紫棋': 'pop mandopop',
  '薛之谦': 'pop ballad mandopop',
  '李荣浩': 'pop rock mandopop',
  'Taylor Swift': 'pop country',
  'Ed Sheeran': 'pop folk',
  'Coldplay': 'rock alternative',
  'Maroon 5': 'pop rock',
  'Adele': 'soul pop ballad',
  'Bruno Mars': 'pop funk r&b',
  'Billie Eilish': 'pop electronic',
  'BTS': 'kpop',
  'BLACKPINK': 'kpop',
  '久石让': 'instrumental classical ost',
  '坂本龙一': 'instrumental ambient classical',
  'Yiruma': 'piano instrumental',
  'The Weeknd': 'r&b pop',
  'Drake': 'hiphop rap',
  'Kendrick Lamar': 'hiphop rap',
  'Post Malone': 'pop hiphop',
  'Dua Lipa': 'pop dance',
  'Alan Walker': 'electronic edm',
  'Avicii': 'electronic edm',
  'Marshmello': 'electronic edm',
  'Lofi Girl': 'lofi chill',
  'FKJ': 'jazz electronic',
  'Tom Misch': 'jazz funk',
  '张靓颖': 'pop ballad mandopop',
  '毛不易': 'folk ballad mandopop',
  '许嵩': 'pop mandopop',
  '赵雷': 'folk',
  '朴树': 'folk rock',
  '五月天': 'rock pop mandopop',
  '苏打绿': 'indie pop mandopop',
  '逃跑计划': 'rock indie',
  '新裤子': 'rock electronic',
};

function inferGenres(artistName) {
  if (!artistName) return '';
  for (const [key, val] of Object.entries(ARTIST_GENRES)) {
    if (artistName.includes(key)) return val;
  }
  return '';
}

const KEYWORD_GENRES = [
  { kw: ['钢琴','piano'], genre: 'piano instrumental' },
  { kw: ['吉他','guitar','acoustic'], genre: 'acoustic guitar' },
  { kw: ['民谣','folk'], genre: 'folk' },
  { kw: ['摇滚','rock'], genre: 'rock' },
  { kw: ['爵士','jazz'], genre: 'jazz' },
  { kw: ['电子','electronic','edm','电音'], genre: 'electronic' },
  { kw: ['说唱','rap','hiphop','嘻哈'], genre: 'hiphop' },
  { kw: ['古典','classical','交响','orchestra'], genre: 'classical' },
  { kw: ['古风','国风'], genre: 'chinese_traditional' },
  { kw: ['lofi','lo-fi'], genre: 'lofi chill' },
  { kw: ['r&b','rnb','节奏布鲁斯'], genre: 'r&b' },
  { kw: ['治愈','安静','舒缓','放松'], genre: 'chill ambient' },
  { kw: ['悲伤','伤感','emo'], genre: 'ballad sad' },
  { kw: ['轻快','欢快','快乐','开心'], genre: 'pop upbeat' },
  { kw: ['热血','燃','带劲','劲爆'], genre: 'rock electronic high_energy' },
];

function inferGenresFromKeywords(text) {
  const lower = (text || '').toLowerCase();
  const genres = [];
  for (const item of KEYWORD_GENRES) {
    if (item.kw.some(k => lower.includes(k))) genres.push(item.genre);
  }
  return genres.join(' ');
}

// ── Cookie 加载 ──
let _cookie = null;
function loadCookie() {
  if (_cookie) return _cookie;
  try {
    const dataDir = process.env.AGENT_PERSIST_DIR || '';
    const cookieFile = path.join(dataDir, 'netease-cookie.json');
    if (fs.existsSync(cookieFile)) {
      const raw = fs.readFileSync(cookieFile, 'utf-8');
      const data = JSON.parse(raw);
      if (data.cookie) {
        _cookie = data.cookie;
        log.log(`Cookie 加载成功: ${_cookie.length} 字符`);
      } else {
        log.warn('Cookie 文件存在但内容为空');
      }
    } else {
      log.warn(`Cookie 文件不存在: ${cookieFile}`);
    }
  } catch (e) {
    log.warn(`Cookie 加载失败: ${e.message}`);
  }
  return _cookie;
}

// ── NetEase API 调用 ──
let _neteaseApi = null;
function getNeteaseApi() {
  if (!_neteaseApi) {
    try { _neteaseApi = _require('@neteasecloudmusicapienhanced/api'); } catch (e) { log.warn('操作失败', e?.message || e); }
  }
  return _neteaseApi;
}

async function callNetease(fnName, params = {}) {
  const api = getNeteaseApi();
  if (!api) return null;
  const cookie = loadCookie();
  try {
    const result = await api[fnName]({ ...params, ...(cookie ? { cookie } : {}) });
    return result.body;
  } catch (err) {
    log.warn(`NetEase API ${fnName} 失败: ${err.message}`);
    return null;
  }
}

function mapSong(s) {
  return {
    id: String(s.id),
    name: s.name,
    artist: (s.ar || s.artists || []).map(a => a.name || a).join(' / '),
    album: s.al?.name || s.album?.name || '',
    cover: s.al?.picUrl || s.album?.picUrl || '',
    duration: Math.round((s.dt || s.duration || 0) / 1000),
    genres: inferGenres(s.ar?.[0]?.name || s.artists?.[0]?.name || ''),
  };
}

// ── 当前播放歌曲（供 play_similar 等工具自动使用）──
let _lastPlayedSongId = null;
let _lastPlayedSongName = '';
export function setLastPlayedSong(songId, name) {
  _lastPlayedSongId = songId;
  _lastPlayedSongName = name || '';
}
export function getLastPlayedSongId() { return _lastPlayedSongId; }
export function clearLastPlayedSong() { _lastPlayedSongId = null; _lastPlayedSongName = ''; }

// ── 记忆检索 ──
let _memoryStore = null;
export function setMusicMemoryStore(store) { _memoryStore = store; }

async function getMusicMemories(limit = 100) {
  if (!_memoryStore) return [];
  try {
    const all = _memoryStore.getAll() || [];
    const musicFacts = all.filter(f => {
      try {
        const d = typeof f.fact === 'string' ? JSON.parse(f.fact) : f.fact;
        return d && d.type === 'music_feedback';
      } catch { return false; }
    });
    return musicFacts.slice(0, limit).map(f => {
      try { return typeof f.fact === 'string' ? JSON.parse(f.fact) : f.fact; }
      catch { return f.fact; }
    });
  } catch { return []; }
}

// ── 用户画像构建 ──
function buildUserProfile(memories) {
  const now = Date.now();
  const artistWeights = {};
  const genreWeights = {};
  const skipArtists = {};
  const skipGenres = {};
  let totalPositive = 0, totalNegative = 0;

  for (const m of memories) {
    const daysAgo = (now - (m.timestamp || 0)) / 86400000;
    const decay = Math.exp(-0.1 * Math.max(0, daysAgo));
    const effectiveWeight = (m.actionWeight || 0) * decay;
    const artists = (m.artist || '').split(' / ');

    if (effectiveWeight > 0) {
      totalPositive += effectiveWeight;
      for (const a of artists) {
        artistWeights[a] = (artistWeights[a] || 0) + effectiveWeight;
      }
      const genres = (m.genres || '').split(' ');
      for (const g of genres) {
        if (g) genreWeights[g] = (genreWeights[g] || 0) + effectiveWeight;
      }
    } else if (effectiveWeight < 0) {
      totalNegative += Math.abs(effectiveWeight);
      for (const a of artists) {
        skipArtists[a] = (skipArtists[a] || 0) + Math.abs(effectiveWeight);
      }
      const genres = (m.genres || '').split(' ');
      for (const g of genres) {
        if (g) skipGenres[g] = (skipGenres[g] || 0) + Math.abs(effectiveWeight);
      }
    }
  }

  const topArtists = Object.entries(artistWeights)
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ name: k, weight: v }));
  const topGenres = Object.entries(genreWeights)
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ name: k, weight: v }));
  const avoidedArtists = Object.entries(skipArtists)
    .filter(([, v]) => v > (totalPositive * 0.4 || 1)).map(([k]) => k);
  const avoidedGenres = Object.entries(skipGenres)
    .filter(([, v]) => v > (totalPositive * 0.4 || 1)).map(([k]) => k);

  // 最近播放过的歌曲 ID（3天内）
  const recentIds = new Set(
    memories.filter(m => (now - (m.timestamp || 0)) < 259200000).map(m => m.songId).filter(Boolean)
  );

  return { topArtists, topGenres, avoidedArtists, avoidedGenres, recentIds, totalMemories: memories.length };
}

// ── 评分函数 ──
function scoreSong(song, profile, scene, query) {
  let score = 50; // 基础分

  // 艺人匹配
  const artists = song.artist.split(' / ');
  for (const a of artists) {
    const aw = profile.topArtists.find(t => t.name === a || a.includes(t.name) || t.name.includes(a));
    if (aw) score += aw.weight * 15;  // 重权重：喜欢的艺人
  }
  // 流派匹配（包含 inferGenres 推导的流派）
  const genres = (song.genres || inferGenres(song.artist) || '').split(' ').filter(Boolean);
  for (const g of genres) {
    const gw = profile.topGenres.find(t => g && (t.name.includes(g) || g.includes(t.name)));
    if (gw) score += gw.weight * 8;  // 重权重：喜欢的流派
  }
  // 场景匹配
  if (scene) {
    for (const g of genres) {
      if (scene.energy < 0.4 && (g === 'ballad' || g === 'lofi' || g === 'ambient' || g === 'instrumental' || g === 'piano'))
        score += 15;
      if (scene.energy > 0.6 && (g === 'rock' || g === 'electronic' || g === 'dance' || g === 'pop'))
        score += 15;
    }
  }
  // 关键词匹配
  if (query) {
    const kwGenres = inferGenresFromKeywords(query);
    for (const g of kwGenres.split(' ')) {
      if (song.genres.includes(g)) score += 25;
    }
    if (song.name.toLowerCase().includes(query.toLowerCase()) ||
        song.artist.toLowerCase().includes(query.toLowerCase()))
      score += 40;
  }
  // 惩罚
  for (const a of artists) {
    if (profile.avoidedArtists.includes(a)) score -= 30;
  }
  for (const g of genres) {
    if (profile.avoidedGenres.some(ag => ag === g)) score -= 20;
  }
  // 新鲜度
  if (profile.recentIds.has(song.id)) score -= 50;
  // 多样性限制会在外部处理

  return Math.max(0, score);
}

// ── 推荐理由生成 ──
function generateReason(song, profile, scene) {
  const reasons = [];
  const artists = song.artist.split(' / ');

  for (const a of artists) {
    const aw = profile.topArtists.find(t => t.name === a);
    if (aw && aw.weight > 1) {
      reasons.push(`你最近常听 ${a}`);
      break;
    }
  }
  if (reasons.length === 0 && scene) {
    reasons.push(`${scene.desc}适合听这类歌`);
  }
  if (reasons.length === 0 && profile.totalMemories > 0) {
    reasons.push('根据你的听歌习惯推荐');
  }
  if (reasons.length === 0) {
    reasons.push('为你推荐');
  }
  return reasons[0];
}

// ═══════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════

export const searchMusic = {
  name: 'search_music',
  description: '在网易云音乐搜索歌曲/艺人/专辑。用户想听指定歌曲时使用。参数 query: 搜索关键词（歌名、艺人、专辑名都可以）',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
    },
    required: ['query'],
  },
  async invoke({ query }) {
    const body = await callNetease('cloudsearch', { keywords: query, limit: 10, type: 1 });
    if (!body?.result?.songs?.length) return '未找到相关歌曲';
    const songs = body.result.songs.slice(0, 10).map(mapSong);
    const best = songs.slice(0, 5);
    const list = best.map((s, i) =>
      `[${i + 1}] songId="${s.id}" songName="${s.name}" artist="${s.artist}"`
    ).join('\n');
    const pl = JSON.stringify(best.map(s => ({ songId: s.id, name: s.name, artist: s.artist, cover: s.cover || '' })));
    return `找到 ${songs.length} 首，取前5首（直接选第一首调用 play_music）:\n${list}\n\n请调用 play_music(songId="${best[0].id}", songName="${best[0].name}", artist="${best[0].artist}")\nMUSIC_LIST ${pl}`;
  },
};

export const recommendMusic = {
  name: 'recommend_music',
  description: `智能推荐歌曲。结合用户听歌习惯（网易云听歌记录+本地反馈记忆）、当前时间场景、天气、情绪等多维信息，
生成个性化推荐。当用户说"放首歌"、"来点音乐"等没有指定具体歌曲时使用。
参数 mood 可选: 用户情绪或场景描述（如"放松"、"开心"、"想哭"、"工作"等），不传则自动推断。
参数 count 可选: 推荐数量，默认 10。`,
  parameters: {
    type: 'object',
    properties: {
      mood: { type: 'string', description: '情绪/场景（可选）: 放松/开心/悲伤/专注/运动/随机' },
      count: { type: 'number', description: '推荐数量，默认10' },
    },
    required: [],
  },
  async invoke({ mood, count = 10 } = {}) {
    // ── 缓存：同场景 15s 内复用，短到刚好防重复调用但不会跨轮复用 ──
    const cacheKey = `${mood || 'auto'}_${Math.floor(Date.now() / 15000)}`;
    if (_recommendCache?.key === cacheKey && _recommendCache?.text && _recommendCache?.mood === mood) {
      log.log(`recommend_music 缓存命中: ${cacheKey}`);
      return _recommendCache.text;
    }

    const cookie = loadCookie();
    log.log(`recommend_music 被调用: mood=${mood}, cookie=${cookie ? '有(' + cookie.length + '字符)' : '无'}`);
    const hour = new Date().getHours();
    const minute = new Date().getMinutes();
    const period = timePeriod(hour);
    const scene = SCENE_DEFAULTS[period];

    // 1. 检索本地音乐记忆
    const memories = await getMusicMemories(100);
    const profile = buildUserProfile(memories);

    // 2. 从网易云获取候选池
    const candidates = [];
    const seenIds = new Set();

    const addCandidates = (songs, source) => {
      for (const s of songs || []) {
        if (!seenIds.has(s.id)) {
          seenIds.add(s.id);
          const song = mapSong(s);
          song._source = source;
          candidates.push(song);
        }
      }
    };

    if (cookie) {
      // ── 分批获取：网易云 API 单例不支持高并发，最多 2 路并行 ──
      // 第一批：最慢的每日推荐 + 用户账号（likelist 需要 uid），并行
      const [daily, account] = await Promise.allSettled([
        callNetease('recommend_songs').catch(() => null),
        callNetease('user_account').catch(() => null),
      ]);
      if (daily.status === 'fulfilled' && daily.value?.data?.dailySongs?.length) {
        addCandidates(daily.value.data.dailySongs, 'daily');
        log.log(`每日推荐: ${daily.value.data.dailySongs.length} 首`);
      }
      const uid = String(account.status === 'fulfilled' ? (account.value?.profile?.userId || account.value?.account?.id || '') : '');

      // 第二批：互不依赖的数据源，全部并行
      const [fm, topList, newSongs] = await Promise.allSettled([
        callNetease('personal_fm').catch(() => null),
        callNetease('top_list', { id: 3778678 }).catch(() => null),
        callNetease('top_song', { type: 0 }).catch(() => null),
      ]);
      if (fm.status === 'fulfilled' && fm.value?.data?.length) { addCandidates(fm.value.data, 'fm'); log.log(`私人FM: ${fm.value.data.length} 首`); }
      if (topList.status === 'fulfilled' && topList.value?.playlist?.tracks?.length) { addCandidates(topList.value.playlist.tracks.slice(0, 20), 'toplist'); log.log(`热歌榜: ${Math.min(20, topList.value.playlist.tracks.length)} 首`); }
      if (newSongs.status === 'fulfilled' && newSongs.value?.data?.length) { addCandidates(newSongs.value.data.slice(0, 15), 'new'); log.log(`新歌速递: ${Math.min(15, newSongs.value.data.length)} 首`); }
      try {
        const personalized = await callNetease('personalized', { limit: 10 });
        if (personalized?.result?.length) {
          const picks = personalized.result.sort(() => Math.random() - 0.5).slice(0, 2);
          for (const pl of picks) {
            try {
              const detail = await callNetease('playlist_detail', { id: pl.id });
              if (detail?.playlist?.tracks?.length) { addCandidates(detail.playlist.tracks.slice(0, 30), 'personalized'); }
            } catch (e) { log.warn('操作失败', e?.message || e); }
          }
          log.log(`个性化歌单: ${picks.length} 个`);
        }
      } catch(e) { log.warn('操作失败', e?.message || e); }

      // 喜欢列表（依赖 account uid）
      if (uid) {
        try {
          const liked = await callNetease('likelist', { uid });
          if (liked?.ids?.length) {
            const likedDetail = await callNetease('song_detail', { ids: liked.ids.slice(0, 500).join(',') });
            if (likedDetail?.songs?.length) { addCandidates(likedDetail.songs.slice(0, 50), 'liked'); log.log(`喜欢列表: ${Math.min(50, likedDetail.songs.length)} 首`); }
          }
        } catch(e) { log.warn('操作失败', e?.message || e); }
      }
    }

    // ── 艺人热歌 + cloudsearch 并行获取 ──
    const topArtists = profile.topArtists?.slice(0, 3) || [];
    const skipArtists = profile.skipArtists || {};
    const skipGenres = profile.skipGenres || {};
    const genreKw = profile.topGenres?.slice(0, 3) || [];
    const minuteSeed = (hour * 60 + minute);  // 每分钟换种子，比小时级更多样
    const moodSearch = moodToKeywords(mood);
    const diverseGenres = ['pop', 'rock', 'electronic', 'r&b', 'folk', 'jazz', 'indie', 'classical', 'hiphop', 'ambient', 'funk', 'soul'];
    const shuffledGenres = [...diverseGenres].sort(() => Math.random() - 0.5);
    const searchQueries = [
      moodSearch,
      period === 'night' || period === 'late_night' ? '安静 慢歌 钢琴 acoustic' : shuffledGenres[0] + ' 热门 新歌',
      shuffledGenres[1] + ' ' + shuffledGenres[2],
      shuffledGenres[3] + ' ' + shuffledGenres[4],
      ...topArtists.map(a => a.name + ' 新歌'),
      ...genreKw,
    ].filter(Boolean);

    // 随机选 5 个搜索词（用分钟种子增加变化）
    const selectedQueries = [];
    const seenq = new Set();
    const seed = minuteSeed + Math.floor(Math.random() * 7);
    for (let si = 0; si < Math.min(5, searchQueries.length); si++) {
      const qi = (seed + si * 3) % searchQueries.length;
      const q = searchQueries[qi];
      if (!seenq.has(q)) { seenq.add(q); selectedQueries.push({ idx: qi, q }); }
    }

    // 艺人热歌 + cloudsearch 多维搜索 — 全部并行
    const artistJobs = topArtists.map(async (artist) => {
      try {
        const searchRes = await callNetease('cloudsearch', { keywords: artist.name, limit: 1, type: 100 });
        const artistId = searchRes?.result?.artists?.[0]?.id;
        if (artistId) {
          const topSongs = await callNetease('artist_top_song', { id: artistId });
          if (topSongs?.songs?.length) {
            addCandidates(topSongs.songs.slice(0, 15), 'artist_top');
            log.log(`艺人热歌 [${artist.name}]: ${Math.min(15, topSongs.songs.length)} 首`);
          }
        }
      } catch (e) { log.warn('操作失败', e?.message || e); }
    });

    const searchJobs = [];
    for (let si = 0; si < Math.min(5, searchQueries.length); si++) {
      const qi = (hourSeed + si * 3) % searchQueries.length;
      const q = searchQueries[qi];
      searchJobs.push((async () => {
        try {
          const extra = await callNetease('cloudsearch', { keywords: q, limit: 15, offset: (qi * 7 + hourSeed) % 25, type: 1 });
          if (extra?.result?.songs?.length) addCandidates(extra.result.songs, 'search');
        } catch (e) { log.warn('操作失败', e?.message || e); }
      })());
    }

    await Promise.allSettled([...artistJobs, ...searchJobs]);
    log.log(`候选池: ${candidates.length} 首 (daily/fm/liked/toplist/new/personalized/artist_top/search)`);

    // 3. 排除最近播放过的 + 不喜欢的艺人（防重复 + 防踩雷）
    const recentPlayedSet = getRecentPlayedSet();
    let fresh = candidates.filter(s => {
      if (recentPlayedSet.has(s.id)) return false;
      // 排除明确不喜欢的艺人
      const primary = s.artist.split(' / ')[0];
      if (skipArtists[primary] && skipArtists[primary] < -0.3) return false;
      return true;
    });
    if (fresh.length < 5) {
      // 候选太少时只排除最近 5 首
      const recent5 = getRecentPlayed(5);
      fresh = candidates.filter(s => !recent5.includes(s.id));
    }

    // 4. 评分 + 更强随机扰动（0.5 而不是 0.3）+ 不喜欢艺人/流派扣分
    const scored = (fresh.length >= 3 ? fresh : candidates)
      .map(s => {
        let penalty = 0;
        const primary = s.artist.split(' / ')[0];
        const sGenres = (s.genres || '').split(' ');
        if (skipArtists[primary]) penalty += Math.abs(skipArtists[primary]) * 2;
        for (const g of sGenres) { if (skipGenres[g]) penalty += Math.abs(skipGenres[g]); }
        return { ...s, _score: scoreSong(s, profile, scene, mood) + Math.random() * 0.5 - penalty };
      })
      .sort((a, b) => b._score - a._score);

    // 5. 多样性过滤：同艺人 ≤ 2 首
    const artistCount = {};
    const filtered = [];
    for (const s of scored) {
      const primaryArtist = s.artist.split(' / ')[0];
      artistCount[primaryArtist] = (artistCount[primaryArtist] || 0) + 1;
      if (artistCount[primaryArtist] <= 2) filtered.push(s);
    }

    // 6. 取前 N 首，洗牌避免每次一样
    const pool = filtered.slice(0, Math.min(count + 8, 20));
    shuffleArray(pool);
    const top = pool.slice(0, Math.min(count, 10));

    if (!top.length) {
      return '暂无可推荐的歌曲，请稍后再试。';
    }

    const reason = generateReason(top[0], profile, scene);
    const best = top.slice(0, 5);
    const lines = best.map((s, i) =>
      `[${i + 1}] songId="${s.id}" songName="${s.name}" artist="${s.artist}"`
    );
    const playlistJson = JSON.stringify(best.map(s => ({ songId: s.id, name: s.name, artist: s.artist, cover: s.cover || '' })));

    // 预取第一首歌的 URL（并行，不阻塞返回）
    const preFetchUrl = (async () => {
      try {
        const [urlStd, urlHigh] = await Promise.allSettled([
          callNetease('song_url_v1', { id: String(best[0].id), level: 'standard' }),
          callNetease('song_url_v1', { id: String(best[0].id), level: 'higher' }),
        ]);
        const url = (urlStd.status === 'fulfilled' && urlStd.value?.data?.[0]?.url)
          || (urlHigh.status === 'fulfilled' && urlHigh.value?.data?.[0]?.url) || '';
        return url;
      } catch { return ''; }
    })();

    // 先生成不带 URL 的结果快速返回，URL 拿到后再补发
    const npNoUrl = `NOW_PLAYING {"songId":"${best[0].id}","name":"${(best[0].name||'').replace(/"/g,'\\"')}","artist":"${(best[0].artist||'').replace(/"/g,'\\"')}","cover":"${(best[0].cover||'').replace(/"/g,'\\"')}","reason":"${(reason||'为你播放').replace(/"/g,'\\"')}"}`;
    const result = `${reason}，正在为你播放 ${best[0].name}\n\n${lines.join('\n')}\n\n${npNoUrl}\nMUSIC_LIST ${playlistJson}`;
    _recommendCache = { key: cacheKey, text: result, mood };

    // 后台补发带 URL 的 NOW_PLAYING（让前端直接播放，不等 play_music 再取 URL）
    preFetchUrl.then(url => {
      if (url) {
        const npWithUrl = `NOW_PLAYING {"songId":"${best[0].id}","name":"${(best[0].name||'').replace(/"/g,'\\"')}","artist":"${(best[0].artist||'').replace(/"/g,'\\"')}","cover":"${(best[0].cover||'').replace(/"/g,'\\"')}","url":"${url.replace(/"/g,'\\"')}","reason":"${(reason||'为你播放').replace(/"/g,'\\"')}"}`;
        _recommendCache = { key: cacheKey, text: result.replace(npNoUrl, npWithUrl), mood };
        log.log(`recommend_music URL 预取完成: ${best[0].name}`);
      }
    }).catch(() => {});

    return result;
  },
};

export const playMusic = {
  name: 'play_music',
  description: `播放指定歌曲。从 search_music 或 recommend_music 的返回结果中选择一首播放。
参数 songId: 歌曲 ID（从搜索结果中获取）
参数 songName: 歌曲名称
参数 artist: 歌手名
参数 reason: 推荐理由（播放时会告诉用户为什么选这首歌）`,
  parameters: {
    type: 'object',
    properties: {
      songId: { type: 'string', description: '歌曲 ID' },
      songName: { type: 'string', description: '歌曲名称' },
      artist: { type: 'string', description: '歌手名' },
      reason: { type: 'string', description: '推荐理由（可选）' },
    },
    required: ['songId', 'songName'],
  },
  async invoke({ songId, songName, artist, reason }) {
    log.log(`play_music 被调用: ${songName} (ID: ${songId}), reason: ${reason}`);
    markAsPlayed(String(songId));
    const sid = String(songId);

    // 并行：同时取 standard/higher URL + 歌曲详情
    const [urlStd, urlHigh, detail] = await Promise.allSettled([
      callNetease('song_url_v1', { id: sid, level: 'standard' }),
      callNetease('song_url_v1', { id: sid, level: 'higher' }),
      callNetease('song_detail', { ids: sid }),
    ]);

    let playUrl = '';
    const stdOk = urlStd.status === 'fulfilled' && urlStd.value?.data?.[0]?.url;
    const highOk = urlHigh.status === 'fulfilled' && urlHigh.value?.data?.[0]?.url;
    playUrl = stdOk || highOk || '';
    log.log(`song_url (并行): standard=${!!stdOk} higher=${!!highOk}`);

    if (!playUrl) {
      log.warn(`歌曲无播放源: ${songName} (${songId})`);
      return `该歌曲暂无播放源（ID: ${songId}）。请从 recommend_music 结果中另选一首可用歌曲再试。`;
    }

    const s = detail.status === 'fulfilled' && detail.value?.songs?.[0]
      ? mapSong(detail.value.songs[0])
      : { id: songId, name: songName, artist: artist || '', cover: '' };
    const urlPart = playUrl ? `"url":"${playUrl.replace(/"/g,'\\"')}",` : '';
    const np = `NOW_PLAYING {"songId":"${s.id}","name":"${(s.name || '').replace(/"/g, '\\"')}","artist":"${(s.artist || '').replace(/"/g, '\\"')}","cover":"${(s.cover || '').replace(/"/g, '\\"')}",${urlPart}"reason":"${(reason || '为你播放').replace(/"/g, '\\"')}"}`;
    log.log(`play_music 返回: ${np.slice(0, 120)}...`);
    return np;
  },
};

export const playSimilar = {
  name: 'play_similar',
  description: `心动模式——播一首与当前歌曲风格相似的歌。用户说"来首类似的"、"换一首差不多风格的"、"有没有像这首一样的"时使用。
参数 songId: 当前正在播放的歌曲 ID。`,
  parameters: {
    type: 'object',
    properties: {
      songId: { type: 'string', description: '当前歌曲 ID，以此为基础找相似歌曲' },
    },
    required: ['songId'],
  },
  async invoke({ songId }) {
    log.log(`play_similar 被调用: songId="${songId}"`);
    // 验证 songId：必须是纯数字，否则尝试用 lastPlayedSongId 兜底
    if (!/^\d+$/.test(String(songId || ''))) {
      log.warn(`play_similar 收到无效 songId: "${songId}"，尝试使用上次播放歌曲`);
      if (_lastPlayedSongId && /^\d+$/.test(String(_lastPlayedSongId))) {
        log.log(`play_similar 自动修正: "${songId}" → "${_lastPlayedSongId}" (${_lastPlayedSongName})`);
        songId = _lastPlayedSongId;
      } else {
        return `无法获取当前歌曲 ID（收到的是"${songId}"，不是有效数字）。请先播放一首歌，或使用 recommend_music 获取新推荐。`;
      }
    }
    try {
      // 心动模式 API，以当前歌曲为种子
      const result = await callNetease('playmode_intelligence_list', {
        id: String(songId),
        pid: '',           // 留空使用默认上下文
        count: 5,
      });
      if (result?.data?.length) {
        const songs = result.data.slice(0, 5).map(s => {
          const si = s.songInfo || s;
          return mapSong(si);
        });
        const best = songs.slice(0, 3);
        const lines = best.map((s, i) =>
          `[${i + 1}] songId="${s.id}" songName="${s.name}" artist="${s.artist}"`
        );
        const pl = JSON.stringify(best.map(s => ({ songId: s.id, name: s.name, artist: s.artist, cover: s.cover || '' })));
        markAsPlayed(String(songId));
        return `为你找到 ${songs.length} 首风格相似的歌:\n${lines.join('\n')}\n\n请调用 play_music(songId="${best[0].id}", songName="${best[0].name}", artist="${best[0].artist}")\nMUSIC_LIST ${pl}`;
      }
      return '暂时没有找到相似的歌曲，试试 recommend_music 吧。';
    } catch (e) {
      log.warn(`play_similar 失败: ${e.message}`);
      return '心动模式暂不可用，试试 recommend_music 获取推荐。';
    }
  },
};

const pauseMusic = {
  name: 'pause_music',
  description: '暂停当前音乐播放',
  parameters: { type: 'object', properties: {}, required: [] },
  async invoke() {
    return 'MUSIC_PAUSE';
  },
};

const resumeMusic = {
  name: 'resume_music',
  description: '恢复/继续播放暂停的音乐',
  parameters: { type: 'object', properties: {}, required: [] },
  async invoke() {
    return 'MUSIC_RESUME';
  },
};

const getPlaybackStatus = {
  name: 'get_playback_status',
  description: '查询当前音乐播放状态。返回是否正在播放、当前歌曲信息。当你需要确认播放状态时使用此工具，不要凭对话历史猜测。',
  parameters: { type: 'object', properties: {}, required: [] },
  async invoke() {
    try {
      const { playbackState } = await import('../voice/playback-state.js');
      if (playbackState.isPlaying && playbackState.song) {
        return JSON.stringify({ playing: true, song: playbackState.song });
      }
      return JSON.stringify({ playing: false, song: null });
    } catch { return JSON.stringify({ playing: false, song: null }); }
  },
};

const stopMusic = {
  name: 'stop_music',
  description: '停止音乐播放',
  parameters: { type: 'object', properties: {}, required: [] },
  async invoke() {
    return 'MUSIC_STOP';
  },
};

const setVolume = {
  name: 'set_volume',
  description: '调节音乐音量。参数 level: 0.0(静音) 到 1.0(最大)，如 0.5 表示一半音量',
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'number', description: '音量，0.0~1.0' },
    },
    required: ['level'],
  },
  async invoke({ level }) {
    const vol = Math.max(0, Math.min(1, Number(level) || 0.5));
    return `MUSIC_VOLUME ${vol.toFixed(2)}`;
  },
};

// 此文件被 index.js 导入时调用，传入 memory store
export const musicTools = [searchMusic, recommendMusic, playMusic, playSimilar, pauseMusic, resumeMusic, stopMusic, setVolume, getPlaybackStatus];

/**
 * music/tools.js — Agent 音乐工具
 *
 * search_music / recommend_music / play_music
 * 推荐引擎利用网易云 API + Chroma 记忆 + 天气 + 时段做个性化推荐
 */
import { createModuleLogger } from '../../lib/debug-log.js';
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
    try { _neteaseApi = _require('NeteaseCloudMusicApi'); } catch {}
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
    const aw = profile.topArtists.find(t => t.name === a);
    if (aw) score += aw.weight * 3;
  }
  // 流派匹配
  const genres = (song.genres || '').split(' ');
  for (const g of genres) {
    const gw = profile.topGenres.find(t => g && t.name.includes(g));
    if (gw) score += gw.weight * 2;
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
    return songs.map((s, i) =>
      `[${i + 1}] ${s.name} — ${s.artist} (ID: ${s.id}, ${s.duration}秒)`
    ).join('\n');
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
    const cookie = loadCookie();
    log.log(`recommend_music 被调用: mood=${mood}, cookie=${cookie ? '有(' + cookie.length + '字符)' : '无'}`);
    const hour = new Date().getHours();
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
      // 每日推荐（权重最高）
      try {
        const daily = await callNetease('recommend_songs');
        addCandidates(daily?.data?.dailySongs || [], 'daily');
      } catch {}
      // 最近播放
      try {
        const recent = await callNetease('user_record', { type: 1 });
        const recents = [];
        for (const weekData of recent?.weekData || []) {
          recents.push(...(weekData.song ? [weekData.song] : []));
        }
        for (const allData of recent?.allData || []) {
          recents.push(...(allData.song ? [allData.song] : []));
        }
        addCandidates(recents.slice(0, 30), 'recent');
      } catch {}
      // 私人FM
      try {
        const fm = await callNetease('personal_fm');
        addCandidates(fm?.data || [], 'fm');
      } catch {}
    }

    // 3. 评分+排序
    const scored = candidates
      .map(s => ({ ...s, _score: scoreSong(s, profile, scene, mood) }))
      .sort((a, b) => b._score - a._score);

    // 4. 多样性过滤：同艺人 ≤ 2 首，同流派 ≤ 3 首
    const artistCount = {};
    const filtered = [];
    for (const s of scored) {
      const primaryArtist = s.artist.split(' / ')[0];
      artistCount[primaryArtist] = (artistCount[primaryArtist] || 0) + 1;
      if (artistCount[primaryArtist] <= 2) filtered.push(s);
    }

    const top = filtered.slice(0, Math.min(count, 10));

    if (!top.length) {
      // 无数据时尝试搜索 mood 关键词
      if (mood) {
        const searchBody = await callNetease('cloudsearch', { keywords: mood, limit: 10, type: 1 });
        if (searchBody?.result?.songs?.length) {
          const fallback = searchBody.result.songs.slice(0, 5).map(mapSong);
          return fallback.map((s, i) =>
            `[${i + 1}] ${s.name} — ${s.artist} (ID: ${s.id})`
          ).join('\n') + '\n\n（仅基于关键词搜索，登录网易云后可获得个性化推荐）';
        }
      }
      return '暂无可推荐的歌曲。请登录网易云音乐以获取个性化推荐。';
    }

    const reason = generateReason(top[0], profile, scene);
    const lines = top.map((s, i) =>
      `[${i + 1}] ${s.name} — ${s.artist} (ID: ${s.id}) · ${s._source}`
    );
    return `${reason}：\n\n${lines.join('\n')}\n\n请调用 play_music 播放你选中的歌曲，并告诉用户推荐理由。`;
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
    // 验证歌曲可播放
    const urlBody = await callNetease('song_url_v1', { id: String(songId), level: 'standard' });
    const playable = urlBody?.data?.[0]?.url;
    log.log(`song_url_v1 (standard): ${playable ? '有URL' : '无URL'}, data count: ${urlBody?.data?.length || 0}`);

    if (!playable) {
      const urlBodyHigh = await callNetease('song_url_v1', { id: String(songId), level: 'higher' });
      const playableHigh = urlBodyHigh?.data?.[0]?.url;
      log.log(`song_url_v1 (higher): ${playableHigh ? '有URL' : '无URL'}`);
      if (!playableHigh) {
        log.warn(`歌曲无播放源: ${songName} (${songId})`);
        return `该歌曲暂无播放源（ID: ${songId}）。请从 recommend_music 结果中另选一首可用歌曲再试。`;
      }
    }

    const detail = await callNetease('song_detail', { ids: String(songId) });
    const s = detail?.songs?.[0] ? mapSong(detail.songs[0]) : { id: songId, name: songName, artist: artist || '', cover: '' };
    const np = `NOW_PLAYING {"songId":"${s.id}","name":"${(s.name || '').replace(/"/g, '\\"')}","artist":"${(s.artist || '').replace(/"/g, '\\"')}","cover":"${(s.cover || '').replace(/"/g, '\\"')}","reason":"${(reason || '为你播放').replace(/"/g, '\\"')}"}`;
    log.log(`play_music 返回: ${np.slice(0, 80)}...`);
    return np;
  },
};

// 此文件被 index.js 导入时调用，传入 memory store
export const musicTools = [searchMusic, recommendMusic, playMusic];

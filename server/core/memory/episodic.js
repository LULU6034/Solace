/**
 * episodic.js — 情景记忆存储（修复版）
 *
 * 存储带有时空和情感上下文的对话事件。
 * 文件: ~/.ai-desktop-pet/memory/episodes/YYYY-MM-DD.json (每天一个文件)
 *
 * 每条 episode:
 *   { id, timestamp, sessionId, context: {timeOfDay, dayOfWeek, activeFiles[], screenActivity},
 *     emotionalState: {userMood, agentTone, intensity}, content: {topic, userIntent, agentApproach,
 *     outcome, decisions[], keyQuote}, tags: [], importance: 1-10 }
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = path.join(os.homedir(), '.ai-desktop-pet', 'memory', 'episodes');

// ── Helpers ──

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fp = (k) => path.join(BASE, `${k}.json`);

const read = (k) => {
  try { const r = fs.readFileSync(fp(k), 'utf-8').trim(); return r ? JSON.parse(r) : []; }
  catch { return []; }
};

// 原子写入: 先写临时文件，再 rename（防止写入中断导致文件损坏）
const write = (k, arr) => {
  fs.mkdirSync(BASE, { recursive: true });
  const dest = fp(k);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, dest);
};

const dayKeys = (start, end) => {
  const keys = [], cur = new Date(start), last = new Date(end);
  while (cur <= last) { keys.push(dayKey(cur)); cur.setDate(cur.getDate() + 1); }
  return keys;
};

// ── 简单写锁 (串行化并发 addEpisode) ──
let _writeLock = false;
let _lockQueue = [];

function _acquireLock() {
  if (!_writeLock) { _writeLock = true; return; }
  return new Promise(resolve => {
    _lockQueue.push(resolve);
  });
}

function _releaseLock() {
  if (_lockQueue.length > 0) {
    const next = _lockQueue.shift();
    next();
  } else {
    _writeLock = false;
  }
}

// ── Public API ──

/** Maximum entries per day file (oldest evicted when exceeded) */
const MAX_PER_DAY = 100;

// ── 倒排索引维护 ──
const INDEX_PATH = path.join(os.homedir(), '.ai-desktop-pet', 'memory', 'episode_index.json');

function _tokenizeEp(text) {
  const t = (text || '').toLowerCase().replace(/[^一-龥a-zA-Z0-9]/g, ' ');
  const words = t.split(/\s+/).filter(w => w.length > 0);
  const tokens = [];
  for (const w of words) {
    if (/^[a-zA-Z0-9]+$/.test(w)) { tokens.push(w); continue; }
    for (let i = 0; i < w.length; i++) {
      tokens.push(w[i]);
      if (i + 1 < w.length) tokens.push(w[i] + w[i + 1]);
    }
  }
  return [...new Set(tokens)];
}

function _updateIndex(fileKey, epIndex, ep) {
  // 提取关键词
  const text = (ep.content?.keyQuote || '') + ' ' + (ep.content?.topic || '') + ' ' + (ep.content?.userIntent || '') + ' ' + (ep.tags || []).join(' ');
  const tokens = _tokenizeEp(text);
  const epId = ep.id || `${fileKey}#${epIndex}`; // episode 唯一标识
  for (const tok of tokens) {
    if (tok.length < 2) continue;
    if (!_index[tok]) _index[tok] = [];
    // 用 epId 去重（而非不可靠的 line 字段）
    if (!_index[tok].some(e => e.epId === epId)) {
      _index[tok].push({ file: fileKey + '.json', idx: epIndex, epId, score: 3 });
    }
  }
}

let _index = null;
let _indexLoaded = false;

function _loadIndex() {
  if (_indexLoaded && _index) return;
  try {
    if (fs.existsSync(INDEX_PATH)) {
      _index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    } else {
      _index = {};
    }
  } catch { _index = {}; }
  _indexLoaded = true;
}

function _saveIndex() {
  try {
    fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
    const tmp = INDEX_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_index));
    fs.renameSync(tmp, INDEX_PATH); // 原子写入
  } catch {}
}

// 重建索引（索引损坏或丢失时）
export function rebuildIndex() {
  try {
    _index = {};
    const files = fs.existsSync(BASE) ? fs.readdirSync(BASE).filter(f => f.endsWith('.json')) : [];
    for (const file of files) {
      const key = file.replace('.json', '');
      const eps = read(key);
      eps.forEach((ep, i) => _updateIndex(key, i, ep));
    }
    _indexLoaded = true;
    _saveIndex();
    return true;
  } catch { return false; }
}

/** 追加一条情景事件，自动维护倒排索引 */
export async function addEpisode(ep) {
  await _acquireLock();
  try {
    const k = dayKey(), all = read(k);
    const epIndex = all.length; // 在本日文件中的位置
    all.push(ep);
    if (all.length > MAX_PER_DAY) all.splice(0, all.length - MAX_PER_DAY);
    write(k, all);

    // 增量更新索引（不重写整个文件）
    try {
      _loadIndex();
      _updateIndex(k, epIndex, ep);
      _saveIndex();
    } catch {}
  } finally {
    _releaseLock();
  }
}

/** 搜索情景事件（优先倒排索引，降级遍历文件） */
export function searchEpisodes({ query, timerange, mood, topic, minImportance } = {}) {
  // 尝试用索引搜索
  if (query && _indexLoaded && Object.keys(_index).length > 0) {
    const idxResults = _searchByIndex(query);
    if (idxResults.length >= 3) return idxResults;
  }
  // fallback: 文件遍历
  return _searchByFiles({ query, timerange, mood, topic, minImportance });
}

function _searchByIndex(query) {
  _loadIndex();
  const qTokens = _tokenizeEp(query);
  if (!qTokens.length) return [];

  // 倒排索引查询
  const epScores = new Map(); // epId → score
  for (const tok of qTokens) {
    const posting = _index[tok];
    if (!posting) continue;
    for (const entry of posting) {
      const id = `${entry.file}#${entry.idx}`;
      epScores.set(id, (epScores.get(id) || 0) + entry.score);
    }
  }

  // 收集命中的 episode
  const results = [];
  for (const [id, score] of epScores) {
    if (score < 3) continue;
    const fileKey = id.split('#')[0].replace('.json', '');
    const epIdx = parseInt(id.split('#')[1]);
    try {
      const eps = read(fileKey);
      if (epIdx < eps.length) {
        const ep = eps[epIdx];
        const daysAgo = (Date.now() - (ep.timestamp || Date.now())) / 86400000;
        results.push({ ...ep, _score: score * Math.pow(0.95, Math.max(0, daysAgo)) });
      }
    } catch {}
  }
  return results.sort((a, b) => b._score - a._score).slice(0, 20);
}

function _searchByFiles({ query, timerange, mood, topic, minImportance } = {}) {
  let all = [];

  if (timerange?.start && timerange?.end) {
    const keys = dayKeys(dayKey(new Date(timerange.start)), dayKey(new Date(timerange.end)));
    for (const k of keys) {
      all = all.concat(read(k));
      if (all.length > 200) break;
    }
  } else if (timerange) {
    const files = fs.existsSync(BASE) ? fs.readdirSync(BASE).filter(f => f.endsWith('.json')) : [];
    for (const f of files) {
      all = all.concat(read(f.replace('.json', '')));
      if (all.length > 200) break;
    }
    if (timerange.start) {
      const startTs = new Date(timerange.start).getTime();
      all = all.filter(ep => ep.timestamp >= startTs);
    }
    if (timerange.end) {
      const endTs = new Date(timerange.end).getTime();
      all = all.filter(ep => ep.timestamp <= endTs); // Fixed: was shadowed variable
    }
  } else {
    all = read(dayKey());
  }

  if (minImportance) all = all.filter(ep => (ep.importance || 0) >= minImportance);
  if (query)         {
    const q = query.toLowerCase();
    all = all.filter(ep =>
      (ep.content?.topic || '').toLowerCase().includes(q) ||
      (ep.content?.userIntent || '').toLowerCase().includes(q) ||
      (ep.content?.keyQuote || '').toLowerCase().includes(q) ||
      (ep.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }
  if (mood)          { const m = mood.toLowerCase(); all = all.filter(ep => (ep.emotionalState?.userMood || '').toLowerCase().includes(m)); }
  if (topic)         { const t = topic.toLowerCase(); all = all.filter(ep => (ep.content?.topic || '').toLowerCase().includes(t)); }

  const now = Date.now();
  const EMOTIONS = ['happy','sad','angry','worried','excited','neutral','joy','fear','surprise'];
  return all.map(ep => {
    let score = (ep.importance || 3) / 10;
    const daysAgo = (now - (ep.timestamp || now)) / 86400000;
    score *= Math.pow(0.95, daysAgo);
    if (query && ep.emotionalState?.userMood &&
        EMOTIONS.some(emo => query.toLowerCase().includes(emo) && ep.emotionalState.userMood.toLowerCase().includes(emo))) {
      score *= 1.5;
    }
    if (query && ep.tags?.some(t => query.toLowerCase().includes(t.toLowerCase()))) {
      score *= 1.3;
    }
    return { ...ep, _score: score };
  }).sort((a, b) => b._score - a._score);
}

/** 获取今天所有情景 */
export function getTodayEpisodes() { return read(dayKey()); }

/** 获取情绪变化曲线 → [{timestamp, emotion, intensity}] */
export function getEmotionCurve(days = 7) {
  const end = new Date(), start = new Date(); start.setDate(start.getDate() - days);
  const result = [];
  for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
    for (const ep of read(dayKey(cur))) {
      if (ep.emotionalState) result.push({ timestamp: ep.timestamp, emotion: ep.emotionalState.userMood || 'neutral', intensity: ep.emotionalState.intensity || 0 });
    }
  }
  return result.sort((a, b) => a.timestamp - b.timestamp);
}

/** 获取最近的高重要性事件 */
export function getRecentImportant(minImportance = 5, limit = 10) {
  const end = dayKey(), start = new Date(); start.setDate(start.getDate() - 30);
  let all = [];
  for (const k of dayKeys(dayKey(start), end)) all = all.concat(read(k));
  return all.filter(ep => (ep.importance || 0) >= minImportance).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

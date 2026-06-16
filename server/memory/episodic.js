/**
 * episodic.js — 情景记忆存储（修复版）
 *
 * 存储带有时空和情感上下文的对话事件。
 * 文件: ~/.ai-desktop-pet/memory/episodes/YYYY-MM-DD.json (每天一个文件)
 *
 * 每条 episode:
 *   { id, timestamp, sessionId, interactionType, context: {timeOfDay, dayOfWeek, activeFiles[], screenActivity},
 *     emotionalState: {userMood, agentTone, intensity}, content: {topic, userIntent, agentApproach,
 *     outcome, decisions[], keyQuote}, tags: [], importance: 1-10 }
 *
 * interactionType 取值:
 *   user_shared_story / user_asked_advice / agent_helped / emotional_moment / casual_chat
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('episodic-store');

const BASE = path.join(os.homedir(), '.ai-desktop-pet', 'memory', 'episodes');

// ── Helpers ──

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fp = (k) => path.join(BASE, `${k}.json`);

const read = (k) => {
  try { const r = fs.readFileSync(fp(k), 'utf-8').trim(); return r ? JSON.parse(r) : []; }
  catch (e) { log.warn('操作失败', e?.message || e); return []; }
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

// 停用词表
const STOP_WORDS = new Set([
  '的','了','是','在','我','你','他','她','它','们','这','那',
  '吗','呢','吧','啊','哦','和','与','或','也','就','都','很',
  '不','要','会','能','可以','把','被','让','给','对','从','到',
  '上','下','里','外','中','前','后','左','右','大','小','多',
  '少','一个','这个','那个','什么','怎么','为什么',
]);

function _tokenizeEp(text) {
  // 按中文标点、空格、换行分词
  const t = (text || '').toLowerCase().replace(/[。，！？；：、""''（）【】《》…—\s\n]+/g, ' ');
  const words = t.split(/\s+/).filter(w => w.length > 0);
  const tokens = new Set();
  for (const w of words) {
    // 英文/数字: 整体保留，过滤停用词
    if (/^[a-zA-Z0-9]+$/.test(w)) {
      if (!STOP_WORDS.has(w)) tokens.add(w);
      continue;
    }
    // 中文: 单字 + bigram，单字过滤停用词
    for (let i = 0; i < w.length; i++) {
      if (!STOP_WORDS.has(w[i])) tokens.add(w[i]);
      if (i + 1 < w.length) tokens.add(w[i] + w[i + 1]);
    }
  }
  return [...tokens];
}

function _updateIndex(episode, lineNumber, filePath) {
  // Tokenize episode content (keyQuote + topic + userIntent + interactionType)
  // interactionType 中的下划线替换为空格，以便英文分词
  const itText = (episode.interactionType || '').replace(/_/g, ' ');
  const text = (episode.content?.keyQuote || '') + ' ' +
               (episode.content?.topic || '') + ' ' +
               (episode.content?.userIntent || '') + ' ' +
               itText + ' ' +
               (episode.tags || []).join(' ');
  const tokens = _tokenizeEp(text);
  const epId = episode.id || `${filePath}#${lineNumber}`;
  const score = episode.importance || 5;
  for (const tok of tokens) {
    if (tok.length < 2) continue;
    if (!_index[tok]) _index[tok] = [];
    // 去重: 同一 episode 不重复索引
    if (!_index[tok].some(e => e.epId === epId)) {
      _index[tok].push({ file: filePath, line: lineNumber, epId, score });
    }
    // 按 score 降序排列，保留 top 50
    if (_index[tok].length > 50) {
      _index[tok].sort((a, b) => b.score - a.score);
      _index[tok] = _index[tok].slice(0, 50);
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
  } catch (e) { log.warn('操作失败', e?.message || e); _index = {}; }
  _indexLoaded = true;
}

let _saveIndexTimer = null;
const SAVE_INDEX_DEBOUNCE_MS = 1000;

function _saveIndex() {
  if (_saveIndexTimer) return; // 已有定时器等待
  _saveIndexTimer = setTimeout(() => {
    _saveIndexTimer = null;
    _flushIndex();
  }, SAVE_INDEX_DEBOUNCE_MS);
}

/** 立即写入索引（不防抖，供 rebuildIndex 使用） */
function _flushIndex() {
  try {
    fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
    const tmp = INDEX_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_index));
    fs.renameSync(tmp, INDEX_PATH); // 原子写入
  } catch (e) { log.warn('操作失败', e?.message || e); }
}

// 重建索引（索引损坏或丢失时）
export function rebuildIndex(persistDir) {
  try {
    // 取消待处理的防抖写入，防止覆盖新索引
    if (_saveIndexTimer) { clearTimeout(_saveIndexTimer); _saveIndexTimer = null; }
    const baseDir = persistDir || BASE;
    _index = {};
    const files = fs.existsSync(baseDir) ? fs.readdirSync(baseDir).filter(f => f.endsWith('.json')) : [];
    for (const file of files) {
      try {
        const filePath = path.join(baseDir, file);
        const raw = fs.readFileSync(filePath, 'utf-8').trim();
        const eps = raw ? JSON.parse(raw) : [];
        eps.forEach((ep, i) => _updateIndex(ep, i, file));
      } catch (e) { log.warn('操作失败', e?.message || e); }
    }
    _indexLoaded = true;
    _flushIndex(); // 立即写入，不防抖
    return true;
  } catch (e) { log.warn('操作失败', e?.message || e); return false; }
}

/**
 * 通过倒排索引搜索情景记忆
 * @param {string} query - 搜索查询
 * @param {string} persistDir - 情景文件目录
 * @param {number} maxResults - 最大返回数量
 * @returns {Array} 匹配的情景条目，按 score 降序
 */
export function searchEpisodesByIndex(query, persistDir, maxResults = 5) {
  try {
    _loadIndex();
    if (!_index || Object.keys(_index).length === 0) return [];

    const qTokens = _tokenizeEp(query);
    if (!qTokens.length) return [];

    // 倒排索引查询: keyword → [{file, line, score}]
    const epScores = new Map(); // key: "file#line" → cumulative score
    for (const tok of qTokens) {
      const posting = _index[tok];
      if (!posting) continue;
      for (const entry of posting) {
        const key = `${entry.file}#${entry.line}`;
        epScores.set(key, (epScores.get(key) || 0) + (entry.score || 3));
      }
    }

    // 读取命中行
    const baseDir = persistDir || BASE;
    const results = [];
    for (const [key, score] of epScores) {
      const [fileName, lineStr] = key.split('#');
      const lineNum = parseInt(lineStr);
      if (isNaN(lineNum)) continue;
      try {
        const filePath = path.join(baseDir, fileName);
        if (!fs.existsSync(filePath)) continue;
        const eps = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (Array.isArray(eps) && lineNum < eps.length) {
          const daysAgo = (Date.now() - (eps[lineNum].timestamp || Date.now())) / 86400000;
          results.push({
            ...eps[lineNum],
            _score: score * Math.pow(0.95, Math.max(0, daysAgo)),
          });
        }
      } catch { /* 跳过损坏文件 */ }
    }

    return results.sort((a, b) => b._score - a._score).slice(0, maxResults);
  } catch (e) {
    log.warn('操作失败', e?.message || e);
    return [];
  }
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
      _updateIndex(ep, epIndex, k + '.json');
      _saveIndex();
    } catch (e) { log.warn('操作失败', e?.message || e); }
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
      const id = `${entry.file}#${entry.line}`;
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
      if (eps && epIdx < eps.length) {
        const ep = eps[epIdx];
        const daysAgo = (Date.now() - (ep.timestamp || Date.now())) / 86400000;
        results.push({ ...ep, _score: score * Math.pow(0.95, Math.max(0, daysAgo)) });
      }
    } catch (e) { log.warn('操作失败', e?.message || e); }
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

// ── 交互类型中文名映射 ──
const INTERACTION_TYPE_NAMES = {
  user_shared_story: '分享故事',
  user_asked_advice: '寻求建议',
  agent_helped: 'AI帮助',
  emotional_moment: '情感时刻',
  casual_chat: '日常聊天',
};

/**
 * 生成月度时间线摘要
 * @param {string} persistDir - 情景文件目录（可选，默认 BASE）
 * @param {string} month - 月份，格式 "YYYY-MM"（如 "2026-06"）
 * @returns {string} 人类可读的月度摘要
 */
export function generateTimeline(persistDir, month) {
  try {
    const baseDir = persistDir || BASE;
    if (!fs.existsSync(baseDir)) return '暂无该月的记忆数据';

    // 筛选当月所有日期文件
    const files = fs.readdirSync(baseDir)
      .filter(f => f.endsWith('.json') && f.startsWith(month))
      .sort();
    if (!files.length) return `${month} 暂无记忆数据`;

    // 加载当月所有情景
    let allEpisodes = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(baseDir, file), 'utf-8').trim();
        const eps = raw ? JSON.parse(raw) : [];
        allEpisodes = allEpisodes.concat(Array.isArray(eps) ? eps : [eps]);
      } catch (e) { log.warn('读取情景文件失败', e?.message || e); }
    }
    if (!allEpisodes.length) return `${month} 暂无记忆数据`;

    // 按交互类型统计
    const typeCount = {};
    for (const ep of allEpisodes) {
      const t = ep.interactionType || 'casual_chat';
      typeCount[t] = (typeCount[t] || 0) + 1;
    }

    // 深夜互动 (22:00 - 06:00)
    const lateNight = allEpisodes.filter(ep => {
      const hour = new Date(ep.timestamp).getHours();
      return hour >= 22 || hour < 6;
    }).length;

    // 技术类标签匹配
    const techTags = new Set(['技术', '编程', '代码', 'python', 'js', 'java', 'bug', 'debug', '面试']);
    const techQuestions = allEpisodes.filter(ep => {
      const tags = ep.tags || [];
      const topic = (ep.content?.topic || '').toLowerCase();
      const quote = (ep.content?.keyQuote || '').toLowerCase();
      return tags.some(t => techTags.has(t)) ||
             [...techTags].some(t => topic.includes(t) || quote.includes(t));
    }).length;

    // 音乐类标签匹配
    const musicTags = new Set(['音乐', '歌曲', '推荐', '歌单']);
    const musicRecs = allEpisodes.filter(ep => {
      const tags = ep.tags || [];
      return tags.some(t => musicTags.has(t));
    }).length;

    // 关键记忆（重要性最高的事件，去重 keyQuote）
    const seen = new Set();
    const keyMoments = allEpisodes
      .filter(ep => {
        const q = (ep.content?.keyQuote || '').slice(0, 30);
        if (!q || seen.has(q)) return false;
        seen.add(q);
        return true;
      })
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))
      .slice(0, 3);

    // 组装摘要
    const total = allEpisodes.length;
    const typeSummary = Object.entries(typeCount)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${INTERACTION_TYPE_NAMES[t] || t}${c}次`)
      .join('、');

    let summary = `这个月你跟我聊了${total}次`;
    if (typeSummary) summary += `，其中${typeSummary}`;
    if (lateNight > 0) summary += `，${lateNight}次在深夜`;
    if (techQuestions > 0) summary += `，问了${techQuestions}个技术问题`;
    if (musicRecs > 0) summary += `，推荐了${musicRecs}首歌给我`;
    summary += '。';

    // 附加关键记忆
    if (keyMoments.length > 0) {
      summary += '\n\n关键记忆：';
      for (const ep of keyMoments) {
        const d = new Date(ep.timestamp);
        const dateStr = `${d.getMonth() + 1}月${d.getDate()}日`;
        const quote = (ep.content?.keyQuote || '').slice(0, 60);
        const typeName = INTERACTION_TYPE_NAMES[ep.interactionType] || '';
        const typeLabel = typeName ? `[${typeName}] ` : '';
        const stars = ep.importance ? '★'.repeat(Math.min(5, Math.ceil((ep.importance || 1) / 2))) : '';
        summary += `\n  · ${dateStr} ${stars} ${typeLabel}${quote}`;
      }
    }

    return summary;
  } catch (e) {
    log.warn('生成时间线失败', e?.message || e);
    return `生成 ${month} 时间线时出错: ${e?.message || e}`;
  }
}

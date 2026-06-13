/**
 * medium-term.js — 中期记忆 (Recent Summaries)
 *
 * 近 7 天对话的自动摘要，滑动窗口。
 * 存储: ~/.ai-desktop-pet/memory/summaries/YYYY-MM-DD.json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('mem:medium');
const BASE_DIR = path.join(os.homedir(), '.ai-desktop-pet', 'memory', 'summaries');
const MAX_DAYS = 7;

let _llm = null;

// ---- helpers ----

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function filePath(dk) { return path.join(BASE_DIR, `${dk}.json`); }

function readSummary(dk) {
  try { return fs.existsSync(filePath(dk)) ? JSON.parse(fs.readFileSync(filePath(dk), 'utf-8')) : null; }
  catch (e) { log.warn(`读取摘要失败 (${dk}): ${e.message}`); return null; }
}

function writeSummary(dk, s) {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  fs.writeFileSync(filePath(dk), JSON.stringify(s, null, 2), 'utf-8');
}

function cleanupOld() {
  if (!fs.existsSync(BASE_DIR)) return;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - MAX_DAYS);
  const limit = cutoff.toISOString().slice(0, 10);
  for (const f of fs.readdirSync(BASE_DIR)) {
    if (!f.endsWith('.json')) continue;
    const dk = f.replace('.json', '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(dk) && dk < limit) {
      try { fs.unlinkSync(path.join(BASE_DIR, f)); } catch { /* ignore */ }
    }
  }
}

function extractSessionIds(turns) {
  const ids = new Set();
  for (const t of turns) if (t.sessionId) ids.add(t.sessionId);
  return [...ids];
}

function buildPrompt(turns) {
  const lines = turns.map((t, i) => `[${i + 1}] ${t.role || '?'}: ${t.content || ''}`);
  return [
    'Summarize this conversation as JSON (no markdown fences). Keys:',
    '  "summary": a 2-4 sentence paragraph.',
    '  "topics": array of 1-5 topic strings.',
    '  "keyDecisions": array of 1-5 key decisions reached.',
    '',
    lines.join('\n'),
  ].join('\n');
}

function parseResponse(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch { /* fall through */ }
  return { summary: text.slice(0, 500), topics: [], keyDecisions: [] };
}

// ---- public API ----

/** 注入 LLM 调用函数 (async fn，接收 prompt 字符串，返回响应文本)。generateSummary 前必须调用。 */
export function setLlm(fn) { _llm = fn; }

/**
 * 调用 LLM 为指定日期生成每日摘要并持久化。
 * @param {string|Date} date - 日期 (YYYY-MM-DD 或 Date)
 * @param {Array} turns - 对话轮次 [{role, content, sessionId?}]
 * @returns {Promise<object>} 已保存的摘要对象
 */
export async function generateSummary(date, turns) {
  if (!_llm) throw new Error('setLlm() must be called before generateSummary()');
  if (!turns || turns.length === 0) throw new Error('turns must be a non-empty array');

  const dk = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  const llmPromise = _llm(buildPrompt(turns));
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('LLM summary timeout (60s)')), 60_000)
  );
  const parsed = parseResponse(await Promise.race([llmPromise, timeoutPromise]));

  const doc = {
    date: dk,
    summary: parsed.summary || '',
    topics: parsed.topics || [],
    keyDecisions: parsed.keyDecisions || [],
    turnCount: turns.length,
    sessionIds: extractSessionIds(turns),
  };

  writeSummary(dk, doc);
  return doc;
}

/** 返回最近 N 天的摘要（默认 7，上限 MAX_DAYS）。 */
export function getRecent(days = 7) {
  cleanupOld();
  const out = [];
  const now = new Date();
  for (let i = 0; i < Math.min(days, MAX_DAYS); i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const s = readSummary(key); if (s) out.push(s);
  }
  return out;
}

/** 简单关键词匹配搜索（大小写不敏感），匹配 topics 和 summary 文本。 */
export function searchByTopic(query) {
  if (!fs.existsSync(BASE_DIR)) return [];
  const q = query.toLowerCase();
  const now = new Date();
  const out = [];
  for (const f of fs.readdirSync(BASE_DIR).filter(x => x.endsWith('.json'))) {
    const s = JSON.parse(fs.readFileSync(path.join(BASE_DIR, f), 'utf-8'));
    const dateMatch = s.date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    let score = 0;
    if ((s.topics || []).some(t => t.toLowerCase().includes(q))) score += 0.6;
    if ((s.summary || '').toLowerCase().includes(q)) score += 0.4;
    if (score > 0) {
      // 时间衰减
      if (dateMatch) {
        const d = new Date(dateMatch[1], dateMatch[2] - 1, dateMatch[3]);
        const daysAgo = (now - d) / 86400000;
        score *= Math.pow(0.9, daysAgo);
      }
      out.push({ ...s, _score: score });
    }
  }
  return out.sort((a, b) => b._score - a._score);
}

/**
 * 增量合并：将 partial 数据合并到指定日期的已有摘要中。
 * - topics 去重合并
 * - keyDecisions 新项前置追加
 * - summary 文本拼接
 * - turnCount 累加
 * - sessionIds 去重合并
 * @param {string|Date} date
 * @param {object} partial - { summary?, topics?, keyDecisions?, turnCount?, sessionIds? }
 * @returns {object} 合并后（已持久化）的摘要
 */
export function mergeSummary(date, partial) {
  const dk = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  const existing = readSummary(dk) || {
    date: dk, summary: '', topics: [], keyDecisions: [], turnCount: 0, sessionIds: [],
  };

  if (partial.summary) {
    existing.summary = existing.summary ? `${existing.summary}\n${partial.summary}` : partial.summary;
  }
  if (partial.topics && partial.topics.length) {
    existing.topics = [...new Set((existing.topics || []).concat(partial.topics))];
  }
  if (partial.keyDecisions && partial.keyDecisions.length) {
    existing.keyDecisions = [...partial.keyDecisions, ...(existing.keyDecisions || [])];
  }
  if (partial.turnCount != null) {
    existing.turnCount = (existing.turnCount || 0) + partial.turnCount;
  }
  if (partial.sessionIds && partial.sessionIds.length) {
    existing.sessionIds = [...new Set((existing.sessionIds || []).concat(partial.sessionIds))];
  }

  writeSummary(dk, existing);
  return existing;
}

// ---- load-time auto-cleanup ----
cleanupOld();

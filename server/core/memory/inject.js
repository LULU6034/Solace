/**
 * inject.js — 精化记忆注入
 *
 * 优先级: 长期事实 > 情景事件 > 中期摘要 > 短期对话
 * 预算: 6000 tokens 上限，按比例分配
 * 冲突: 长期事实标记"不可变"，短期覆盖临时信息
 */

import { createModuleLogger } from '../../lib/debug-log.js';
const log = createModuleLogger('mem:inject');

const TARGET_BUDGET = 6000; // 目标
const SAFETY_MARGIN = 0.85; // 15% 余量防中文 token 误差
const TOTAL_BUDGET = Math.floor(TARGET_BUDGET * SAFETY_MARGIN); // 实际 5100
const BUDGET = {
  facts: 0.20,
  episodes: 0.20,
  summaries: 0.15,
  shortTerm: 0.45,
};

function estTokens(text) { return Math.ceil((text || '').length / 4); }

export async function injectMemoryContext(messages, memoryManager, userText = '') {
  if (!memoryManager) return messages;

  try {
    const ctx = await memoryManager.getContext(userText);
    const block = buildEnhancedBlock(ctx, userText);
    if (!block) return messages;

    const updated = [...messages];
    const sysIdx = updated.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) {
      updated[sysIdx] = {
        ...updated[sysIdx],
        content: updated[sysIdx].content + '\n\n' + block,
      };
    } else {
      updated.unshift({ role: 'system', content: block });
    }

    log.log(`记忆注入: ${estTokens(block)} tokens`);
    return updated;
  } catch (err) {
    log.warn(`注入失败: ${err.message}`);
    return messages;
  }
}

function buildEnhancedBlock(ctx, query) {
  const parts = [];
  let used = 0;
  const limits = {
    facts: Math.floor(TOTAL_BUDGET * BUDGET.facts),
    episodes: Math.floor(TOTAL_BUDGET * BUDGET.episodes),
    summaries: Math.floor(TOTAL_BUDGET * BUDGET.summaries),
    shortTerm: Math.floor(TOTAL_BUDGET * BUDGET.shortTerm),
  };

  // ── 1. 长期事实 (最重要，稳定) ──
  if (ctx.facts?.length > 0) {
    const lines = [];
    const seen = new Set();
    for (const f of ctx.facts.slice(0, 8)) {
      const text = typeof f === 'string' ? f : (f.fact || f.content || '');
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const confidence = f.confidence ?? 0.5;
      const icon = confidence > 0.8 ? '🔒' : '📌';
      const line = `- ${icon} ${text}${confidence > 0.8 ? ' (高可信)' : ''}`;
      if (used + estTokens(line) > limits.facts) break;
      lines.push(line);
      used += estTokens(line);
    }
    if (lines.length > 0) {
      parts.push('## 已知信息\n' + lines.join('\n'));
    }
  }

  // ── 2. 情景事件 (与当前问题最相关) ──
  if (ctx.episodes?.length > 0) {
    const lines = [];
    for (const ep of ctx.episodes.slice(0, 4)) {
      const quote = ep.content?.keyQuote || '';
      const emotion = ep.emotionalState?.userMood || '';
      const date = ep.timestamp ? new Date(ep.timestamp).toLocaleDateString('zh-CN') : '';
      if (!quote) continue;
      const emotionTag = emotion ? ` [情绪:${emotion}]` : '';
      const line = `- ${date}：${quote.slice(0, 80)}${emotionTag}`;
      if (used + estTokens(line) > limits.facts + limits.episodes) break;
      lines.push(line);
      used += estTokens(line);
    }
    if (lines.length > 0) {
      parts.push('## 相关经历\n' + lines.join('\n'));
    }
  }

  // ── 3. 中期摘要 (话题趋势) ──
  if (ctx.summaries?.length > 0) {
    const s = ctx.summaries[0];
    const text = typeof s === 'string' ? s : (s.summary || '');
    if (text && used + estTokens(text) < limits.facts + limits.episodes + limits.summaries) {
      parts.push('## 近期动态\n- ' + text.slice(0, 200));
      used += estTokens(text);
    }
  }

  // ── 4. 短期对话 (最近几轮，保持连贯) ──
  if (ctx.shortTerm?.length > 0) {
    const budget = limits.shortTerm;
    const recent = [];
    let stUsed = 0;
    for (const t of [...ctx.shortTerm].reverse().slice(0, 15)) {
      const content = (t.content || '').slice(0, 100);
      const role = t.role === 'user' ? '用户' : '助手';
      const line = `${role}: ${content}`;
      if (stUsed + estTokens(line) > budget - 100) break;
      recent.unshift(line);
      stUsed += estTokens(line);
    }
    if (recent.length > 0) {
      parts.push('## 最近对话\n' + recent.join('\n'));
    }
  }

  if (parts.length === 0) return null;
  parts.unshift('> 以下是与对话相关的记忆。高可信标记 🔒 的信息优先使用。');
  return parts.join('\n\n');
}

/** 从对话中提取表面事实（规则匹配，不需要 LLM） */
export function extractSurfaceFacts(turns) {
  const facts = [];
  const patterns = [
    { regex: /我叫?是?\s*([一-龥]{2,4})/g, template: '用户名叫 $1' },
    { regex: /我是(\w+)的([一-龥]+)/g, template: '用户身份: $1的$2' },
    { regex: /我喜欢([一-龥]{2,10})/g, template: '用户喜欢$1' },
    { regex: /我在([一-龥]{2,6})生活|我住在([一-龥]{2,6})/g, template: '用户在$1$2生活' },
    { regex: /我(是做|是搞|是写)([一-龥]{2,10})/g, template: '用户的工作与$2相关' },
    { regex: /我养了?(\S+)/g, template: '用户养了$1' },
    { regex: /我对(\S+)过敏/g, template: '用户对$1过敏' },
  ];
  for (const turn of turns) {
    if (turn.role !== 'user' || !turn.content) continue;
    for (const p of patterns) {
      const matches = [...turn.content.matchAll(p.regex)];
      for (const m of matches) {
        facts.push({ fact: p.template.replace(/\$(\d+)/g, (_, n) => m[n] || ''), confidence: 0.7 });
      }
    }
  }
  return [...new Map(facts.map(f => [f.fact, f])).values()];
}

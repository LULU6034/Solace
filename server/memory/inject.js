/**
 * inject.js — 分层智能记忆注入 (Stage 3)
 *
 * 四层注入架构:
 *   1. 画像摘要 (~200 chars) — 用户画像自然语言摘要，始终注入
 *   2. 话题相关 (~400 chars) — 语义搜索与当前查询相关的事实 top-5
 *   3. 情感上下文 (~100 chars) — 最近 5 轮情绪轨迹
 *   4. 最近对话 (~400 chars) — 短期记忆，最近几轮对话
 *
 * 总预算: ~5100 tokens (与原来一致)
 * 冲突: 长期事实标记"不可变"，短期覆盖临时信息
 */

import { createModuleLogger } from '../lib/debug-log.js';
import { extractSurfaceFacts } from './extractor.js';
const log = createModuleLogger('mem:inject');

const TARGET_BUDGET = 6000; // 目标
const SAFETY_MARGIN = 0.85; // 15% 余量防中文 token 误差
const TOTAL_BUDGET = Math.floor(TARGET_BUDGET * SAFETY_MARGIN); // 实际 5100

// ── 四层预算分配 ──
const BUDGET = {
  profile: 0.12,    // 画像摘要
  topic: 0.22,      // 话题相关
  emotion: 0.08,    // 情感上下文
  shortTerm: 0.58,  // 最近对话
};

// ── 话题分类正则 ──
const TOPIC_PATTERNS = [
  { name: 'work', regex: /工作|上班|项目|公司|面试|简历|代码|编程|bug/, weight: 1.3 },
  { name: 'life', regex: /吃饭|睡觉|天气|健康|运动|旅游|购物|逛街/, weight: 1.2 },
  { name: 'emotion', regex: /开心|难过|焦虑|生气|害怕|担心|想哭|压力/, weight: 1.4 },
  { name: 'tech', regex: /代码|编程|Python|JS|API|服务器|部署|bug/, weight: 1.3 },
  { name: 'entertainment', regex: /歌|音乐|电影|游戏|剧|小说|动漫/, weight: 1.2 },
];

// ── 维度标签映射 ──
const DIMENSION_KEYWORDS = {
  identity: ['名字', '姓名', '网名', '年龄', '性别', '所在地', '职业', '身份', '语言', 'location', 'name', 'occupation', 'language'],
  preference: ['喜欢', '爱好', '兴趣', '偏好', '讨厌', '不喜欢', '过敏', '口味', '风格', 'interest', 'preference'],
  state: ['心情', '情绪', '状态', '最近', '当前', '正在', '项目', '计划', 'mood', 'currentProject', 'state'],
};

// ── LLM 配置 ──
let _llmConfig = null;

/** 设置 LLM 配置（供 buildProfileSummary 使用） */
export function setLLMConfig(config) {
  _llmConfig = config;
}

// ── 画像摘要缓存 ──
let _profileCache = {
  text: '',
  factCount: -1,
  factHash: '',
};

function estTokens(text) { return Math.ceil((text || '').length / 4); }

// ── 话题分类 ──

/**
 * 根据用户输入匹配话题类别
 * @param {string} query - 用户输入
 * @returns {{ topics: string[], weights: Record<string, number> }}
 */
function classifyTopic(query) {
  if (!query || !query.trim()) return { topics: [], weights: {} };
  const topics = [];
  const weights = {};
  for (const p of TOPIC_PATTERNS) {
    if (p.regex.test(query)) {
      topics.push(p.name);
      weights[p.name] = p.weight;
    }
  }
  return { topics, weights };
}

/**
 * 判断事实属于哪个维度
 * @param {object} fact - 事实对象 { fact, tags, ... }
 * @returns {string} 'identity' | 'preference' | 'state' | 'unknown'
 */
function classifyDimension(fact) {
  const text = (fact.fact || '').toLowerCase();
  const tags = (fact.tags || []).map(t => String(t).toLowerCase());

  let idScore = 0, prefScore = 0, stateScore = 0;

  for (const kw of DIMENSION_KEYWORDS.identity) {
    if (text.includes(kw)) idScore++;
    if (tags.some(t => t.includes(kw))) idScore++;
  }
  for (const kw of DIMENSION_KEYWORDS.preference) {
    if (text.includes(kw)) prefScore++;
    if (tags.some(t => t.includes(kw))) prefScore++;
  }
  for (const kw of DIMENSION_KEYWORDS.state) {
    if (text.includes(kw)) stateScore++;
    if (tags.some(t => t.includes(kw))) stateScore++;
  }

  if (idScore > prefScore && idScore > stateScore) return 'identity';
  if (prefScore > idScore && prefScore > stateScore) return 'preference';
  if (stateScore > idScore && stateScore > prefScore) return 'state';

  // 默认分类: 根据关键词推断
  if (/名字|姓|叫|是.*工程师|是.*学生|住在|在.*工作/.test(text)) return 'identity';
  if (/喜欢|爱好|讨厌|过敏|偏好|口味/.test(text)) return 'preference';
  if (/最近|当前|正在|刚|上周|昨天|今天|明天|心情|状态/.test(text)) return 'state';

  return 'preference';
}

// ── 画像摘要 ──

/**
 * 生成用户画像自然语言摘要
 * 从事实库中获取高置信度(>0.7)事实，按维度分组后调用 LLM 生成摘要
 * 带缓存: 事实数量不变时不重新生成
 *
 * @param {object} memoryManager - MemoryManager 实例
 * @param {string} userNickname - 用户昵称
 * @returns {Promise<string>} 中文画像摘要（~200字），失败或无数据时返回空字符串
 */
async function buildProfileSummary(memoryManager, userNickname) {
  if (!memoryManager || !memoryManager.factStore) return '';

  try {
    // 获取高置信度事实
    const factStore = memoryManager.factStore;
    const allFacts = factStore.getByConfidence?.(0.7) || [];

    if (allFacts.length === 0) return '';

    // 计算事实哈希用于缓存失效
    const factIds = allFacts.map(f => f.id || f.fact || '').sort().join('|');
    const factHash = `${allFacts.length}:${factIds.slice(0, 500)}`;

    // 缓存命中
    if (_profileCache.factHash === factHash && _profileCache.text) {
      return _profileCache.text;
    }

    // 按维度分组
    const groups = { identity: [], preference: [], state: [] };
    for (const f of allFacts) {
      const dim = classifyDimension(f);
      groups[dim].push(f.fact || f);
    }

    // 构建 LLM prompt
    const identityLines = groups.identity.slice(0, 8).map(f => `  - ${f}`);
    const preferenceLines = groups.preference.slice(0, 10).map(f => `  - ${f}`);
    const stateLines = groups.state.slice(0, 5).map(f => `  - ${f}`);

    const nicknamePart = userNickname ? `网名: ${userNickname}\n` : '';

    const prompt = `根据以下用户信息，生成一段约200字的自然中文用户画像摘要。用"你正在和一位"开头，语气自然亲切，像在向AI助手介绍这位用户。禁止编造信息，只基于提供的事实。

${nicknamePart}身份信息:
${identityLines.join('\n') || '  (无)'}

偏好信息:
${preferenceLines.join('\n') || '  (无)'}

状态信息:
${stateLines.join('\n') || '  (无)'}

请直接输出摘要文本，不要加任何前缀或说明。`;

    // 调用 LLM
    let summary = '';
    if (_llmConfig && (_llmConfig.apiKey || _llmConfig.provider)) {
      try {
        const { createLLM } = await import('../core/llm-client.js');
        const llm = createLLM({
          provider: _llmConfig.provider || 'deepseek',
          model: _llmConfig.model || 'deepseek-chat',
          apiKey: _llmConfig.apiKey,
          baseUrl: _llmConfig.baseUrl || '',
          temperature: 0.1,
          maxTokens: 256,
          reasoningEffort: 'none',
        });
        const result = await llm.invoke([
          { role: 'user', content: prompt },
        ]);
        summary = (result.content || '').trim();

        // 截断到 ~200 字
        if (summary.length > 260) {
          summary = summary.slice(0, 260).replace(/[^。！？.!?]*$/, '') + '。';
        }

        log.log(`画像摘要已生成: ${summary.length} 字`);
      } catch (llmErr) {
        log.warn(`画像摘要 LLM 调用失败: ${llmErr.message}`);
      }
    } else {
      // 无 LLM 配置，生成基于模板的简单摘要
      const parts = [];
      if (userNickname) parts.push(`网名叫"${userNickname}"`);
      for (const f of groups.identity.slice(0, 4)) parts.push(f);
      for (const f of groups.preference.slice(0, 5)) parts.push(f);
      for (const f of groups.state.slice(0, 3)) parts.push(f);
      if (parts.length > 0) {
        summary = `你正在和一位${parts.join('，')}的用户对话。`;
        if (summary.length > 260) summary = summary.slice(0, 260).replace(/[^。！？.!?]*$/, '') + '。';
      }
    }

    // 更新缓存
    _profileCache = { text: summary, factCount: allFacts.length, factHash };

    return summary;
  } catch (err) {
    log.warn(`画像摘要生成失败: ${err.message}`);
    return '';
  }
}

// ── 情感轨迹 ──

/**
 * 从短期记忆中提取最近 N 轮的情绪轨迹
 * @param {Array} shortTerm - 短期记忆 turns
 * @param {number} n - 取最近 N 轮
 * @returns {string} 情感描述文本
 */
function buildEmotionTrajectory(shortTerm, n = 5) {
  if (!shortTerm || shortTerm.length === 0) return '';

  const recent = shortTerm.slice(-n);
  const emotions = [];

  for (const turn of recent) {
    if (turn.emotion && turn.emotion !== 'neutral') {
      const role = turn.role === 'user' ? '用户' : '宠物';
      const emotionCN = {
        happy: '开心', sad: '难过', angry: '生气', worried: '担忧',
        excited: '兴奋', anxious: '焦虑', frustrated: '沮丧', calm: '平静',
        joy: '喜悦', fear: '害怕', surprise: '惊讶', neutral: '平静',
      };
      const label = emotionCN[turn.emotion] || turn.emotion;
      emotions.push(`${role}${label}`);
    }
  }

  if (emotions.length === 0) return '';

  // 判断情绪趋势
  const uniqueEmotions = [...new Set(emotions)];
  let trajectory = '';
  if (uniqueEmotions.length === 1) {
    trajectory = `用户情绪持续${uniqueEmotions[0]}`;
  } else if (emotions.length >= 2) {
    trajectory = `用户情绪变化: ${emotions.join(' → ')}`;
  }

  return trajectory ? `[情感轨迹] ${trajectory}` : '';
}

// ── 分层注入构建 ──

/**
 * 构建四层记忆注入块
 * @param {object} ctx - memoryManager.getContext() 的返回结果
 * @param {string} query - 用户当前输入
 * @param {object} options - { profileSummary?, topicWeights? }
 * @returns {string|null} 注入文本块，无内容时返回 null
 */
function buildEnhancedBlock(ctx, query, options = {}) {
  const { profileSummary = '', topicWeights = {} } = options;
  const parts = [];
  let used = 0;

  const limits = {
    profile: Math.floor(TOTAL_BUDGET * BUDGET.profile),
    topic: Math.floor(TOTAL_BUDGET * BUDGET.topic),
    emotion: Math.floor(TOTAL_BUDGET * BUDGET.emotion),
    shortTerm: Math.floor(TOTAL_BUDGET * BUDGET.shortTerm),
  };

  // ── 第1层: 画像摘要 (始终注入) ──
  if (profileSummary) {
    const text = profileSummary;
    if (used + estTokens(text) <= limits.profile + 50) {
      parts.push('## 用户画像\n' + text);
      used += estTokens(text);
    }
  }

  // ── 第2层: 话题相关事实 (语义搜索 top-5) ──
  if (ctx.facts?.length > 0) {
    const lines = [];
    const seen = new Set();

    // 有话题权重时，对匹配的事实加权排序
    let factsToShow = [...ctx.facts];
    if (Object.keys(topicWeights).length > 0 && query) {
      factsToShow = factsToShow.map(f => {
        const factText = (f.fact || '').toLowerCase();
        const tags = (f.tags || []).map(t => String(t).toLowerCase());
        let boost = 1.0;
        // 检查事实文本或标签是否匹配话题关键词
        for (const [topic, weight] of Object.entries(topicWeights)) {
          const kwList = TOPIC_PATTERNS.find(p => p.name === topic);
          if (kwList) {
            // 提取 regex 中的关键词
            const reStr = kwList.regex.source;
            const keywords = reStr.split('|');
            for (const kw of keywords) {
              if (factText.includes(kw) || tags.some(t => t.includes(kw))) {
                boost = Math.max(boost, weight);
              }
            }
          }
        }
        return { ...f, _boost: boost };
      });
      factsToShow.sort((a, b) => (b._boost || 1) * (b.confidence || 0.5) - (a._boost || 1) * (a.confidence || 0.5));
    } else {
      // 按置信度排序
      factsToShow.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    }

    for (const f of factsToShow.slice(0, 8)) {
      const text = typeof f === 'string' ? f : (f.fact || f.content || '');
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const confidence = f.confidence ?? 0.5;
      const icon = confidence > 0.8 ? '🔒' : '📌';
      const boosted = f._boost && f._boost > 1 ? ' [相关]' : '';
      const line = `- ${icon} ${text}${boosted}${confidence > 0.8 ? ' (高可信)' : ''}`;
      if (used + estTokens(line) > limits.profile + limits.topic) break;
      lines.push(line);
      used += estTokens(line);
    }
    if (lines.length > 0) {
      parts.push('## 已知信息\n' + lines.join('\n'));
    }
  }

  // ── 第3层: 情感上下文 (最近情绪轨迹) ──
  if (ctx.shortTerm?.length > 0) {
    const emotionText = buildEmotionTrajectory(ctx.shortTerm, 5);
    if (emotionText && used + estTokens(emotionText) <= limits.profile + limits.topic + limits.emotion) {
      parts.push('## 情感状态\n' + emotionText);
      used += estTokens(emotionText);
    }
  }

  // ── 补充: 情景事件 (与当前话题相关) ──
  // 放在情感上下文之后、最近对话之前
  if (ctx.episodes?.length > 0) {
    const lines = [];
    let epUsed = used;
    for (const ep of ctx.episodes.slice(0, 3)) {
      const quote = ep.content?.keyQuote || '';
      const emotion = ep.emotionalState?.userMood || '';
      const date = ep.timestamp ? new Date(ep.timestamp).toLocaleDateString('zh-CN') : '';
      if (!quote) continue;
      const emotionTag = emotion ? ` [情绪:${emotion}]` : '';
      const line = `- ${date}：${quote.slice(0, 80)}${emotionTag}`;
      if (epUsed + estTokens(line) > limits.profile + limits.topic + limits.emotion) break;
      lines.push(line);
      epUsed += estTokens(line);
    }
    if (lines.length > 0) {
      parts.push('## 相关经历\n' + lines.join('\n'));
      used = epUsed;
    }
  }

  // ── 第4层: 最近对话 ──
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

// ── 主入口 ──

/**
 * 注入记忆上下文到消息列表
 * @param {Array} messages - 对话消息列表
 * @param {object} memoryManager - MemoryManager 实例
 * @param {string} userText - 用户当前输入
 * @param {string} userNickname - 用户昵称（可选）
 * @returns {Promise<Array>} 已注入的消息列表
 */
export async function injectMemoryContext(messages, memoryManager, userText = '', userNickname = '') {
  if (!memoryManager) return messages;

  try {
    const ctx = await memoryManager.getContext(userText);

    // 话题分类
    const { topics, weights: topicWeights } = classifyTopic(userText);

    // 生成画像摘要（异步，不阻塞）
    const profileSummary = await buildProfileSummary(memoryManager, userNickname);

    if (topics.length > 0) {
      log.log(`话题分类: ${topics.join(', ')}`);
    }

    const block = buildEnhancedBlock(ctx, userText, {
      profileSummary,
      topicWeights,
    });

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

    log.log(`记忆注入: ${estTokens(block)} tokens (话题:${topics.join(',') || '无'})`);
    return updated;
  } catch (err) {
    log.warn(`注入失败: ${err.message}`);
    return messages;
  }
}

// extractSurfaceFacts 已移至 extractor.js，此处通过 import 复用

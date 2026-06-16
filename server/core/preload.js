/**
 * preload.js — 对话预加载器 (Stage 3)
 *
 * 新对话开场时，并行运行 3 个轻量级回忆查询：
 *   1. 时间相关: 召回与当前日期/星期相关的记忆
 *   2. 场景相关: 根据当前时段加载上下文
 *   3. 高频话题: 用户画像中 top-3 高频标签
 *
 * 设计原则:
 *   - 非阻塞: 后台运行，不延迟对话启动
 *   - 低权重: 预加载上下文追加在系统提示词末尾，带 [背景感知] 前缀
 *   - 优雅降级: 任何错误返回空字符串
 */

import { createModuleLogger } from '../lib/debug-log.js';
const log = createModuleLogger('preload');

// ── 时段场景映射 ──
const TIME_SCENES = [
  { start: 5, end: 8, scene: '清晨，新的一天刚开始' },
  { start: 8, end: 12, scene: '上午，工作/学习的黄金时间' },
  { start: 12, end: 14, scene: '午间，休息充电的时段' },
  { start: 14, end: 18, scene: '下午，工作/学习间隙' },
  { start: 18, end: 21, scene: '傍晚，放松时间' },
  { start: 21, end: 24, scene: '夜晚，属于自己的安静时光' },
  { start: 0, end: 5, scene: '深夜，夜深人静的时刻' },
];

// ── 星期中文映射 ──
const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 获取当前时段对应的场景描述
 * @returns {string} 场景文本
 */
function getTimeScene() {
  const hour = new Date().getHours();
  for (const ts of TIME_SCENES) {
    if (hour >= ts.start && hour < ts.end) {
      return ts.scene;
    }
  }
  return '日常时段';
}

/**
 * 获取当前星期中文名
 * @returns {string}
 */
function getDayName() {
  return DAY_NAMES[new Date().getDay()];
}

/**
 * 新对话开场时调用，返回 Agent 的"背景感知"上下文
 *
 * @param {object} memoryManager - MemoryManager 实例
 * @param {object} userProfile - UserProfile 实例
 * @returns {Promise<string>} 背景上下文文本（~150 chars），追加在系统提示词末尾
 */
export async function preloadContext(memoryManager, userProfile) {
  if (!memoryManager) return '';

  try {
    // ── 并行运行 3 个轻量查询 ──
    const results = await Promise.allSettled([
      _recallTimeContext(memoryManager),
      _recallSceneContext(memoryManager),
      _recallHighFreqTopics(userProfile),
    ]);

    const timeCtx = results[0].status === 'fulfilled' ? results[0].value : '';
    const sceneCtx = results[1].status === 'fulfilled' ? results[1].value : '';
    const topicCtx = results[2].status === 'fulfilled' ? results[2].value : '';

    // 拼接上下文
    const parts = [timeCtx, sceneCtx, topicCtx].filter(Boolean);
    if (parts.length === 0) return '';

    const context = parts.join('；');
    const final = `[背景感知] ${context}`;

    // 截断到 ~150 chars
    if (final.length > 200) {
      const truncated = final.slice(0, 200).replace(/[^。！？.!?；;]*$/, '');
      return truncated ? truncated + '。' : final.slice(0, 180);
    }

    log.log(`预加载上下文: ${final.length} 字`);
    return final;
  } catch (err) {
    // 优雅降级
    log.warn(`预加载失败: ${err.message}`);
    return '';
  }
}

/**
 * 查询1: 时间相关记忆
 * 搜索与当前日期、星期相关的往事
 *
 * @param {object} memoryManager
 * @returns {Promise<string>}
 */
async function _recallTimeContext(memoryManager) {
  try {
    const dayName = getDayName();
    const now = new Date();

    // 搜索事实库中与今天星期几相关的记忆
    if (memoryManager.factStore) {
      const dayFacts = memoryManager.factStore.search?.(dayName, 5) || [];
      const relevantFacts = dayFacts.filter(f => (f.confidence || 0) >= 0.4);
      if (relevantFacts.length > 0) {
        return `用户曾在${dayName}提到${relevantFacts.map(f => f.fact || f).slice(0, 2).join('、')}`;
      }
    }
    return '';

    if (episodes.length === 0) {
      // 尝试搜索事实库中与当前月份/季节相关的记忆
      const month = now.getMonth() + 1;
      const monthStr = `${month}月`;
      try {
        const facts = memoryManager.factStore?.search?.(monthStr, 3) || [];
        const highConf = facts.filter(f => (f.confidence || 0) >= 0.5);
        if (highConf.length > 0) {
          return `用户曾提到${highConf.map(f => f.fact || f).slice(0, 2).join('、')}`;
        }
      } catch {
        // 静默降级
      }
      return '';
    }

    const topEp = episodes[0];
    const quote = topEp?.content?.keyQuote || topEp?.text || '';
    if (quote) {
      return `上周${dayName}用户提到过"${quote.slice(0, 40)}"`;
    }

    return '';
  } catch (err) {
    log.warn(`时间上下文查询失败: ${err.message}`);
    return '';
  }
}

/**
 * 查询2: 场景相关上下文
 * 根据当前时段判断用户的可能状态
 *
 * @param {object} memoryManager
 * @returns {Promise<string>}
 */
async function _recallSceneContext(memoryManager) {
  try {
    const scene = getTimeScene();
    const hour = new Date().getHours();

    // 根据时段搜索相关事实（如晚上→音乐、放松相关记忆）
    let timeKeyword = '';
    if (hour >= 5 && hour < 12) timeKeyword = '早晨';
    else if (hour >= 12 && hour < 18) timeKeyword = '下午';
    else if (hour >= 18 && hour < 22) timeKeyword = '晚上';
    else timeKeyword = '深夜';

    // 搜索事实库中与时段相关的用户偏好
    try {
      const facts = memoryManager.factStore?.search?.(timeKeyword, 5) || [];

      // 过滤相关事实（偏好类、习惯类）
      const relevant = facts.filter(f => {
        const text = (f.fact || '').toLowerCase();
        return (/习惯|喜欢|通常|经常|一般|每次|总是|偏好/.test(text)) &&
               (f.confidence || 0) >= 0.4;
      });

      if (relevant.length > 0) {
        const f = relevant[0];
        return `现在是${scene}，${f.fact || f}`;
      }
    } catch {
      // 静默降级
    }

    // 无匹配事实时仅返回时段场景
    return `现在是${scene}`;
  } catch (err) {
    log.warn(`场景上下文查询失败: ${err.message}`);
    return '';
  }
}

/**
 * 查询3: 高频话题
 * 从用户画像中提取 top-3 高频标签/兴趣
 *
 * @param {object} userProfile - UserProfile 实例
 * @returns {Promise<string>}
 */
async function _recallHighFreqTopics(userProfile) {
  try {
    if (!userProfile) return '';

    // 获取用户高置信度属性
    const attrs = userProfile.getHighConfidence?.(0.3) || {};

    // 提取兴趣和当前项目
    const interests = [];
    if (attrs.interest?.value) {
      interests.push(attrs.interest.value);
    }
    if (attrs.occupation?.value) {
      interests.push(attrs.occupation.value);
    }
    if (attrs.currentProject?.value) {
      interests.push(attrs.currentProject.value);
    }

    // 从标签维度获取话题
    const topicKeys = ['interest', 'occupation', 'currentProject', 'personality_openness'];
    const topics = [];
    for (const key of topicKeys) {
      if (attrs[key]?.value && attrs[key].confidence >= 0.3) {
        const label = {
          interest: '兴趣', occupation: '职业', currentProject: '正在做',
          personality_openness: '探索倾向',
        }[key] || key;
        const val = attrs[key].value;
        if (!topics.some(t => t.includes(val))) {
          topics.push(`${label}: ${val}`);
        }
      }
    }

    if (topics.length === 0) return '';
    const topTopics = topics.slice(0, 3);
    return `用户近期关注: ${topTopics.join('、')}`;
  } catch (err) {
    log.warn(`高频话题查询失败: ${err.message}`);
    return '';
  }
}

/**
 * extractor.js — 多维记忆提取器
 *
 * 替代 agent.js 中的内联提取 prompt，一次 LLM 调用提取三个维度：
 *   1. identity+preference（稳定属性）：姓名、职业、位置、喜好、习惯
 *   2. state（时效性状态）：当前情绪、进行中项目、近期事件、短期目标
 *   3. interaction_type（交互分类）：用于 episodic 记忆存储
 *
 * 同时保留 inject.js 中的表面事实规则匹配（无需 LLM）。
 */
import { createLLM } from '../core/llm-client.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('mem:extractor');

// ── 多维提取 prompt ──
const EXTRACTION_PROMPT = `你是一个记忆提取助手。分析以下对话，从三个维度提取关于用户的信息。

## 维度说明

### 1. 身份与偏好（identity / preference）
用户的稳定属性，跨时间保持不变或变化极慢：
- 姓名、称呼、年龄、性别
- 职业、工作领域、职位
- 居住城市、家乡
- 兴趣爱好、喜欢的事物、讨厌的事物
- 生活习惯、饮食偏好、过敏信息
- 技能、擅长领域
重要性范围: 0.7-0.9

### 2. 状态与情境（state）
用户当前的、时效性的信息，可能随时间变化：
- 当前情绪、心情
- 正在进行的项目、任务
- 近期发生的事件（搬家、旅行、考试等）
- 短期目标、计划
- 近期关注的话题
重要性范围: 0.4-0.6

### 3. 交互类型（interactionType）
从以下类型中选择最匹配的一个：
- user_shared_story: 用户分享了个人经历或故事
- user_asked_advice: 用户寻求建议或帮助
- agent_helped: AI 提供了实质性帮助（解决问题、完成任务）
- emotional_moment: 对话有明显的情绪表达（开心、难过、焦虑等）
- casual_chat: 日常闲聊，没有明显的以上特征

## 输出格式

严格输出 JSON，不要包含任何其他文字：

{
  "facts": [
    {"text": "用户叫张三", "importance": 0.9, "dimension": "identity"},
    {"text": "用户喜欢喝咖啡", "importance": 0.7, "dimension": "preference"},
    {"text": "用户最近在学日语", "importance": 0.5, "dimension": "state"}
  ],
  "interactionType": "casual_chat"
}

## 规则

- 只提取明确提到的信息，不要推测
- 每条 fact 的 text 使用「用户...」开头，简洁明确
- 如果确实没有值得记住的信息，返回 {"facts": [], "interactionType": "casual_chat"}
- 每条 fact 必须有 dimension 字段，值为 "identity"、"preference" 或 "state"
- interactionType 必须从上述 5 个类型中选择`;

// ── 从 LLM 响应中解析 JSON ──
function parseJSONResponse(rawText) {
  if (!rawText || rawText === '无') return null;

  // 尝试直接解析
  try {
    return JSON.parse(rawText);
  } catch {
    // 继续尝试
  }

  // 尝试提取 markdown 代码块中的 JSON
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // 继续尝试
    }
  }

  // 尝试找到第一个 { 到最后一个 } 之间的内容
  const firstBrace = rawText.indexOf('{');
  const lastBrace = rawText.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(rawText.slice(firstBrace, lastBrace + 1));
    } catch {
      // 继续尝试
    }
  }

  // 尝试修复常见的 JSON 问题：未闭合的引号、尾部逗号等
  let cleaned = rawText
    .replace(/```(?:json)?\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();
  const startIdx = cleaned.indexOf('{');
  const endIdx = cleaned.lastIndexOf('}');
  if (startIdx >= 0 && endIdx > startIdx) {
    cleaned = cleaned.slice(startIdx, endIdx + 1);
    // 移除尾部逗号
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(cleaned);
    } catch {
      // 放弃
    }
  }

  log.warn('无法解析 LLM 响应为 JSON:', rawText.slice(0, 200));
  return null;
}

/**
 * 多维记忆提取
 *
 * @param {Array} messages - 对话消息 [{role, content}, ...]
 * @param {Object} llmConfig - LLM 配置对象，包含 provider/apiKey/model 等
 * @returns {Promise<{facts: Array<{text:string, importance:number, dimension:string}>, interactionType: string}>}
 */
export async function extractMemories(messages, llmConfig, existingFacts = []) {
  log.log(`[extractor] extractMemories 入口, messages=${messages?.length || 0}条, existingFacts=${existingFacts.length}条, provider=${llmConfig?.provider}, model=${llmConfig?.model}`);
  if (!messages || messages.length < 2) {
    log.log('[extractor] 跳过: messages不足2条');
    return { facts: [], interactionType: 'casual_chat' };
  }

  // 取最近 10 轮对话，每轮截断到 500 字符
  const conversationText = messages.slice(-10)
    .map(m => `${m.role}: ${(m.content || '').slice(0, 500)}`)
    .join('\n');

  // 注入已有事实上下文，避免重复提取
  let knownFactsBlock = '';
  if (existingFacts.length > 0) {
    const factsList = existingFacts.slice(0, 30).map(f => `- ${f.fact || f}`).join('\n');
    knownFactsBlock = `\n## 已知事实（以下事实已经存在，不要重复提取，除非新信息与之冲突需要更新）\n\n${factsList}\n`;
  }

  const prompt = `${EXTRACTION_PROMPT}\n${knownFactsBlock}\n## 对话内容\n\n${conversationText}\n\n## 提取结果\n`;

  let llm;
  try {
    llm = createLLM({
      ...llmConfig,
      temperature: llmConfig.temperature ?? 0.1,
      maxTokens: llmConfig.maxTokens ?? 512,
      thinkingType: 'disabled',
    });
    log.log(`[extractor] LLM创建成功`);
  } catch (err) {
    log.error(`[extractor] 创建LLM失败: ${err.message}`, err.stack);
    return { facts: [], interactionType: 'casual_chat' };
  }

  try {
    log.log(`[extractor] 发送提取请求, provider=${llmConfig.provider} model=${llmConfig.model} msgs=${messages.length} promptLen=${prompt.length}`);
    const { content } = await llm.invoke([{ role: 'user', content: prompt }]);
    const text = content?.trim() || '';
    log.log(`[extractor] LLM响应(${text.length}字符): "${text.slice(0, 200)}"`);

    if (!text || text === '无') {
      log.log('[extractor] 空响应(文本为空或"无")，返回空facts');
      return { facts: [], interactionType: 'casual_chat' };
    }

    const parsed = parseJSONResponse(text);
    if (!parsed) {
      log.warn(`[extractor] JSON解析失败, 原文本前200字符: "${text.slice(0, 200)}"`);
      return { facts: [], interactionType: 'casual_chat' };
    }

    // 验证并规范化 facts
    const facts = (parsed.facts || [])
      .filter(f => f.text && f.text.length >= 2)
      .map(f => ({
        text: f.text.trim(),
        importance: Math.max(0, Math.min(1, Number(f.importance) || 0.5)),
        dimension: ['identity', 'preference', 'state'].includes(f.dimension)
          ? f.dimension
          : 'state',
      }));

    const interactionType = [
      'user_shared_story', 'user_asked_advice', 'agent_helped',
      'emotional_moment', 'casual_chat',
    ].includes(parsed.interactionType)
      ? parsed.interactionType
      : 'casual_chat';

    log.log(`[extractor] 提取完成: ${facts.length}条事实, 交互类型=${interactionType}`);
    if (facts.length > 0) {
      facts.forEach((f, i) => log.log(`[extractor]   fact #${i+1}: "${f.text}" importance=${f.importance} dim=${f.dimension}`));
    }
    return { facts, interactionType };
  } catch (err) {
    log.error(`[extractor] extractMemories 异常: ${err.message}`, err.stack);
    return { facts: [], interactionType: 'casual_chat' };
  }
}

// ── 表面事实提取（规则匹配，无需 LLM） ──
// 从 server/memory/inject.js 迁移

/**
 * 从对话中提取表面事实（基于正则规则匹配，不调用 LLM）
 *
 * @param {Array} turns - 对话轮次 [{role, content}, ...]
 * @returns {Array<{fact: string, confidence: number}>}
 */
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

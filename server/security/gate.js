/**
 * gate.js — 安全预检网关
 *
 * 两级过滤 + 分级响应（对应 Python security_gate.py）:
 * - 规则层: 关键词/正则，毫秒级
 * - 语义层: 轻量 LLM 调用，上下文感知
 * - 输出: { level: "red"|"yellow"|"green", reason, evidence }
 */
import { createLLM } from '../core/llm-client.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('security-gate');

// ── Rule layer: dangerous patterns ──
const RED_PATTERNS = [
  [/(删除|清空|销毁|drop|truncate|rm\s+-rf|format)\s*(所有|全部|整个|all)/i, 'mass_delete'],
  [/(全|全部|所有|都)\s*(删|清|移除|去掉)/i, 'mass_delete'],
  [/DROP\s+(TABLE|DATABASE)/i, 'sql_drop'],
  [/(导出|下载|发送|upload)\s*(所有|全部|全).*(客户|用户|密码|token|密钥|secret)/i, 'data_leak'],
  [/(chmod\s+777|chown\s+-R)/i, 'perm_escalation'],
  [/(关闭|停止|停掉|kill)\s*(所有|全部|服务|进程)/i, 'mass_shutdown'],
  [/(查看|读取|偷看).*(密码|工资|薪资|银行|病历)/i, 'privacy_violation'],
];

const YELLOW_PATTERNS = [
  [/(删除|移除|清理|删掉)\s*.+\.(py|js|ts|vue|cjs|json|yaml|yml|env)/i, 'file_delete'],
  [/(关闭|停止|重启)\s*.+(服务|进程|docker|容器)/i, 'service_control'],
  [/(强制|force)\s*(推送|push|合并|merge|覆盖)/i, 'force_operation'],
  [/(批量|重复|循环).*(执行|运行|调用)/i, 'batch_operation'],
];

function ruleCheck(userInput) {
  for (const [pattern, flag] of RED_PATTERNS) {
    const m = String(userInput || '').match(pattern);
    if (m) return { level: 'red', flag, evidence: `规则匹配: ${m[0]}`, source: 'rule' };
  }
  for (const [pattern, flag] of YELLOW_PATTERNS) {
    const m = String(userInput || '').match(pattern);
    if (m) return { level: 'yellow', flag, evidence: `规则匹配: ${m[0]}`, source: 'rule' };
  }
  return null;
}

async function semanticCheck(userInput, history, userRole, ruleResult, createLLMFn) {
  if (!createLLMFn) {
    return { level: ruleResult?.level || 'green', source: 'rule_fallback' };
  }

  const historySummary = history.slice(-6)
    .map(m => `[${m.role}]: ${(m.content || '').slice(0, 200)}`)
    .join('\n');

  const ruleContext = ruleResult
    ? `\n规则层已标记: [${ruleResult.level}] ${ruleResult.evidence}`
    : '';

  const prompt = `你是安全审查专家。分析以下用户请求的风险等级。

用户角色: ${userRole}
${ruleContext}
最近对话摘要: ${historySummary || '无'}

用户输入: "${userInput}"

分析要点:
1. 用户是否真的意图执行高危操作，还是只是在询问/讨论？
2. 操作对象是否合理？
3. 结合用户角色，该操作是否在其权限范围内？

输出 JSON:
{
  "level": "red" | "yellow" | "green",
  "reason": "简短理由",
  "override_rule": true | false,
  "evidence": "语义判断依据"
}

只输出 JSON，不要其他内容。`;

  try {
    const llm = createLLMFn({ temperature: 0.1, maxTokens: 256 });
    const { content } = await llm.invoke([{ role: 'user', content: prompt }]);
    const jsonMatch = (content || '').match(/\{[^{}]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      result.source = 'semantic';
      return result;
    }
  } catch (err) {
    log.warn(`语义检查失败: ${err.message}`);
  }

  return {
    level: ruleResult?.level || 'green',
    source: 'semantic_fallback',
    reason: '语义模型不可用，按规则层判断',
  };
}

function finalizeLevel(ruleResult, semanticResult) {
  if (semanticResult.override_rule && ruleResult) {
    if (semanticResult.level !== ruleResult.level) {
      return {
        level: semanticResult.level,
        reason: semanticResult.reason || '',
        evidence: [ruleResult.evidence, semanticResult.evidence || ''],
        overridden: true,
      };
    }
  }

  const ruleLevel = ruleResult?.level || 'green';
  const semLevel = semanticResult.level || 'green';
  const final = (ruleLevel === 'red' || semLevel === 'red') ? 'red'
    : (ruleLevel === 'yellow' || semLevel === 'yellow') ? 'yellow'
    : 'green';

  return {
    level: final,
    reason: semanticResult.reason || ruleResult?.evidence || '安全通过',
    evidence: [
      ruleResult?.evidence || '规则层未匹配',
      semanticResult.evidence || '语义层未覆盖',
    ],
    overridden: false,
  };
}

export async function securityGate(userInput, history = [], userRole = 'unknown', createLLMFn = null) {
  const ruleResult = ruleCheck(userInput);
  if (!ruleResult) {
    return { level: 'green', reason: '安全通过', evidence: ['规则层未匹配'], overridden: false };
  }
  const semanticResult = await semanticCheck(userInput, history, userRole, ruleResult, createLLMFn);
  return finalizeLevel(ruleResult, semanticResult);
}

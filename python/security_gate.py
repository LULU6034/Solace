"""
安全预检网关 — 两级过滤 + 分级响应
- 规则层: 关键词/正则, 毫秒级
- 语义层: 轻量 LLM 调用, 上下文感知
- 输出: {level: "red"|"yellow"|"green", reason, evidence}
"""

import re
import json

# ── 规则层: 高危模式库 ──

RED_PATTERNS = [
    # 数据删除/破坏
    (re.compile(r'(删除|清空|销毁|drop|truncate|rm\s+-rf|format)\s*(所有|全部|整个|all)'), 'mass_delete'),
    (re.compile(r'(删|去除|移除)(掉|除|光)\s*(所有|全部|全)'), 'mass_delete'),
    (re.compile(r'(全|全部|所有|都)\s*(删|清|移除|去掉)(掉|除|光)?'), 'mass_delete'),
    (re.compile(r'DROP\s+(TABLE|DATABASE)', re.IGNORECASE), 'sql_drop'),
    # 敏感数据泄露
    (re.compile(r'(导出|下载|发送|发邮件|email|upload)\s*(所有|全部|全).*(客户|用户|密码|token|密钥|secret)'), 'data_leak'),
    (re.compile(r'(发送|群发|广播).*(给|到|至)\s*(所有|全部|全)'), 'mass_send'),
    # 权限/系统破坏
    (re.compile(r'(chmod\s+777|chown\s+-R)', re.IGNORECASE), 'perm_escalation'),
    (re.compile(r'(关闭|停止|停掉|kill)\s*(所有|全部|服务|进程)'), 'mass_shutdown'),
    # 隐私侵犯
    (re.compile(r'(查看|读取|访问|偷看|窃取).*(密码|工资|薪资|银行|病历)'), 'privacy_violation'),
]

YELLOW_PATTERNS = [
    # 不可逆但可能合理的操作
    (re.compile(r'(删除|移除|清理|删掉)\s*.+\.(py|js|ts|vue|cjs|json|yaml|yml|env)'), 'file_delete'),
    (re.compile(r'(关闭|停止|重启)\s*.+(服务|进程|docker|容器)'), 'service_control'),
    (re.compile(r'(强制|force)\s*(推送|push|合并|merge|覆盖)'), 'force_operation'),
    (re.compile(r'(批量|重复|循环).*(执行|运行|调用)'), 'batch_operation'),
    # 可能的高风险
    (re.compile(r'(rm|del|remove)\s+(-r|-rf|/s)\s+\S+'), 'file_remove'),
    (re.compile(r'curl.*\|\s*(bash|sh|zsh)', re.IGNORECASE), 'pipe_exec'),
]

# ── 角色风险等级 ──
ROLE_RISK_MULTIPLIER = {
    'admin': 0.5,
    'user': 1.0,
    'viewer': 2.0,
    'unknown': 1.5,
}


def rule_check(user_input: str) -> dict | None:
    """规则层快速筛查, 返回匹配到的最高风险级别"""
    for pattern, flag in RED_PATTERNS:
        m = pattern.search(user_input)
        if m:
            return {
                'level': 'red',
                'flag': flag,
                'evidence': f'规则匹配: {m.group()}',
                'source': 'rule',
            }
    for pattern, flag in YELLOW_PATTERNS:
        m = pattern.search(user_input)
        if m:
            return {
                'level': 'yellow',
                'flag': flag,
                'evidence': f'规则匹配: {m.group()}',
                'source': 'rule',
            }
    return None


def build_semantic_prompt(user_input: str, history_summary: str, user_role: str, rule_result: dict | None) -> str:
    """构建语义安全检查的 prompt"""
    rule_context = ''
    if rule_result:
        rule_context = f'\n规则层已标记: [{rule_result["level"]}] {rule_result["evidence"]}'

    return f"""你是安全审查专家。分析以下用户请求的风险等级。

用户角色: {user_role}
{rule_context}
最近对话摘要: {history_summary or '无'}

用户输入: "{user_input}"

分析要点:
1. 用户是否真的意图执行高危操作,还是只是在询问/讨论?
2. 操作对象是否合理 (如删除自己创建的文件 vs 删除系统文件)?
3. 结合用户角色,该操作是否在其权限范围内?

输出 JSON:
{{
  "level": "red" | "yellow" | "green",
  "reason": "简短理由",
  "override_rule": true | false,  // 是否用语义判断覆盖规则层结论
  "evidence": "语义判断依据"
}}

只输出 JSON,不要其他内容。"""


async def semantic_check(
    user_input: str,
    history: list[dict],
    user_role: str,
    rule_result: dict | None,
    create_llm,
) -> dict:
    """语义层安全检查 — 用轻量模型做上下文感知判断"""
    if not create_llm:
        return {'level': rule_result['level'] if rule_result else 'green', 'source': 'rule_fallback'}

    # 构建对话历史摘要 (最近3轮)
    history_texts = []
    for msg in history[-6:]:
        role = msg.get('role', 'user')
        content = msg.get('content', '')[:200]
        history_texts.append(f"[{role}]: {content}")
    history_summary = '\n'.join(history_texts) if history_texts else ''

    prompt = build_semantic_prompt(user_input, history_summary, user_role, rule_result)

    try:
        llm = create_llm(temperature=0.1, max_tokens=256)
        from langchain_core.messages import HumanMessage
        response = llm.invoke([HumanMessage(content=prompt)])
        text = response.content if hasattr(response, 'content') else str(response)
        # 提取 JSON
        json_match = re.search(r'\{[^{}]*\}', text.replace('\n', ' '))
        if json_match:
            result = json.loads(json_match.group())
            result['source'] = 'semantic'
            return result
    except Exception:
        pass

    # 降级: 以规则层结论为准
    return {
        'level': rule_result['level'] if rule_result else 'green',
        'source': 'semantic_fallback',
        'reason': '语义模型不可用,按规则层判断',
    }


def finalize_level(rule_result: dict | None, semantic_result: dict) -> dict:
    """综合规则层和语义层,输出最终分级"""
    level_order = {'red': 3, 'yellow': 2, 'green': 1}

    # 语义层声明覆盖规则层
    if semantic_result.get('override_rule') and rule_result:
        if semantic_result.get('level') != rule_result['level']:
            return {
                'level': semantic_result['level'],
                'reason': semantic_result.get('reason', ''),
                'evidence': [rule_result['evidence'], semantic_result.get('evidence', '')],
                'overridden': True,
            }

    # 取两者中较高风险级别
    rule_level = rule_result['level'] if rule_result else 'green'
    sem_level = semantic_result.get('level', 'green')
    final = 'red' if rule_level == 'red' or sem_level == 'red' else (
        'yellow' if rule_level == 'yellow' or sem_level == 'yellow' else 'green'
    )

    return {
        'level': final,
        'reason': semantic_result.get('reason', rule_result.get('evidence', '') if rule_result else '安全通过'),
        'evidence': [
            rule_result['evidence'] if rule_result else '规则层未匹配',
            semantic_result.get('evidence', '语义层未覆盖'),
        ],
        'overridden': False,
    }


# ── 对外接口 ──

async def security_gate(user_input: str, history: list[dict], user_role: str = 'unknown', create_llm=None) -> dict:
    """安全预检入口: 规则快筛 → 语义确认 → 分级输出"""
    rule_result = rule_check(user_input)

    # 规则层未匹配,直接放行
    if not rule_result:
        return {'level': 'green', 'reason': '安全通过', 'evidence': ['规则层未匹配'], 'overridden': False}

    # 规则层命中,语义层复核
    semantic_result = await semantic_check(user_input, history, user_role, rule_result, create_llm)
    return finalize_level(rule_result, semantic_result)

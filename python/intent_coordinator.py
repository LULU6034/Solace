"""
意图协调器 — 多专家并行意图识别 + 分阶段执行
- 意图拆解: coordinator LLM 输出结构化 intent_list
- 依赖声明: 每个 intent 声明 requires 字段
- 证据链仲裁: 规则/语义冲突时对比 evidence
- 降级兜底: expert 超时或失败时用剩余结果

架构:
  security_gate → intent_coordinator → expert_parallel → aggregate
"""

import asyncio
import json
import time
import re
from typing import Callable

COORDINATOR_SYSTEM_PROMPT = """你是意图识别总指挥官。分析用户输入,拆解为多个独立意图,输出结构化执行计划。

## 你的任务
1. 拆解用户输入中的所有独立意图
2. 为每个意图指定最合适的专家类型
3. 标注意图之间的依赖关系
4. 给出每个意图的置信度

## 专家类型
- vision: 图片分析、图像理解(当用户发送图片时优先使用)
- data_analyst: 数据分析、查询、统计
- code_assistant: 编程、代码操作
- file_operator: 文件读写、删除、重命名
- communicator: 发送邮件、消息、通知
- web_searcher: 搜索网络信息
- general: 通用问答、闲聊

## 依赖声明规则
- 独立的意图 deps 为空数组 []
- 需要前序意图结果才能执行的意图,在 deps 中标注依赖的 intent_id
- 例: "查数据然后发邮件" → intent1 查数据 deps=[], intent2 发邮件 deps=["1"]

## 仲裁原则
当多个意图有冲突时:
1. 安全 > 一切
2. 上下文可覆盖语义误判
3. 规则优先级高于语义

## 输出格式 (严格 JSON,无其他内容)
{
  "intent_list": [
    {
      "intent_id": "1",
      "intent": "简短意图描述",
      "deps": [],
      "expert": "data_analyst",
      "confidence": 0.95,
      "urgency": "normal"
    }
  ],
  "summary": "一句话总结用户需求",
  "degradation_policy": "超时策略说明"
}

只输出 JSON,不要其他内容。"""


EXPERT_SYSTEM_PROMPTS = {
    'data_analyst': """你是数据分析专家。分析用户的数据查询需求,输出结构化分析计划。
输出 JSON: {"plan": "分析步骤", "confidence": 0.9, "evidence": "判断依据"}""",

    'code_assistant': """你是编程专家。判断用户需要什么代码操作。
输出 JSON: {"plan": "操作步骤", "confidence": 0.9, "evidence": "判断依据"}""",

    'file_operator': """你是文件操作专家。判断用户需要对文件做什么操作。
特别注意: 删除、覆盖等不可逆操作必须标注风险等级。
输出 JSON: {"plan": "操作步骤", "risk": "low|medium|high", "confidence": 0.9, "evidence": "判断依据"}""",

    'communicator': """你是通讯专家。判断用户需要发送什么消息。
输出 JSON: {"plan": "通讯计划", "recipients": "收件人描述", "confidence": 0.9, "evidence": "判断依据"}""",

    'web_searcher': """你是信息检索专家。判断用户需要搜索什么信息。
输出 JSON: {"plan": "搜索计划", "queries": ["关键词列表"], "confidence": 0.9, "evidence": "判断依据"}""",

    'vision': """你是视觉分析专家。当用户发送图片需要分析时,你来处理。
输出 JSON: {"plan": "详细描述图片内容,包括场景、物体、人物、文字、颜色、氛围", "confidence": 0.9, "evidence": "判断依据"}""",

    'general': """你是通用助手。处理日常问题。
输出 JSON: {"plan": "回答计划", "confidence": 0.9, "evidence": "判断依据"}""",
}


def parse_coordinator_output(text: str) -> dict | None:
    """从 LLM 输出中提取 JSON"""
    # 尝试直接解析
    text = text.strip()
    if text.startswith('```'):
        # 去掉 markdown 代码块
        lines = text.split('\n')
        text = '\n'.join(lines[1:-1] if lines[-1].strip() == '```' else lines[1:])
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # 尝试正则提取
    json_match = re.search(r'\{[\s\S]*"intent_list"[\s\S]*\}', text)
    if json_match:
        try:
            return json.loads(json_match.group())
        except json.JSONDecodeError:
            pass
    return None


def resolve_execution_order(intent_list: list[dict]) -> list[list[dict]]:
    """解析依赖,返回分阶段执行计划: [[phase1_intents], [phase2_intents], ...]"""
    remaining = {i['intent_id']: i for i in intent_list}
    completed = set()
    phases = []

    while remaining:
        phase = []
        for iid, intent in list(remaining.items()):
            deps_met = all(d in completed for d in intent.get('deps', []))
            if deps_met:
                phase.append(intent)
                del remaining[iid]
        if not phase:
            # 存在循环依赖或无效 deps,剩余全部放入最后一阶段
            phase = list(remaining.values())
            remaining.clear()
        phases.append(phase)
        for intent in phase:
            completed.add(intent['intent_id'])

    return phases


async def run_expert_with_timeout(
    expert_type: str,
    intent: dict,
    user_input: str,
    create_llm,
    timeout: float = 15.0,
) -> dict:
    """运行单个 expert,带超时保护"""
    prompt = EXPERT_SYSTEM_PROMPTS.get(expert_type, EXPERT_SYSTEM_PROMPTS['general'])
    full_prompt = f"{prompt}\n\n用户需求: {user_input}\n意图: {intent['intent']}"

    try:
        from langchain_core.messages import HumanMessage, SystemMessage

        llm = create_llm(temperature=0.3, max_tokens=512)
        messages = [SystemMessage(content=full_prompt), HumanMessage(content=user_input)]

        result = await asyncio.wait_for(
            asyncio.to_thread(llm.invoke, messages),
            timeout=timeout,
        )

        text = result.content if hasattr(result, 'content') else str(result)
        try:
            parsed = json.loads(text.strip())
        except json.JSONDecodeError:
            parsed = {'plan': text.strip(), 'confidence': 0.5, 'evidence': '非结构化输出'}

        return {
            'expert_type': expert_type,
            'intent_id': intent['intent_id'],
            'result': parsed,
            'status': 'success',
            'elapsed': 0,  # 由调用者填充
        }

    except asyncio.TimeoutError:
        return {
            'expert_type': expert_type,
            'intent_id': intent['intent_id'],
            'result': {'plan': '超时,跳过此专家', 'confidence': 0},
            'status': 'timeout',
            'elapsed': timeout,
        }
    except Exception as e:
        return {
            'expert_type': expert_type,
            'intent_id': intent['intent_id'],
            'result': {'plan': f'执行错误: {str(e)}', 'confidence': 0},
            'status': 'error',
            'elapsed': 0,
        }


async def run_intent_coordinator(
    user_input: str,
    create_llm,
    expert_timeout: float = 15.0,
    send_event=None,
) -> dict:
    """意图协调器主入口

    Returns:
        {
            "intent_list": [...],
            "summary": "...",
            "expert_results": [...],
            "degradations": [...],
            "execution_plan": [...]
        }
    """
    if send_event is None:
        send_event = lambda t, d: None  # noqa: E731

    # Phase 0: 意图拆解
    await send_event('coordinator_info', {'content': '正在分析用户意图...'})

    from langchain_core.messages import HumanMessage, SystemMessage

    llm = create_llm(temperature=0.2, max_tokens=1024)
    coord_response = llm.invoke([
        SystemMessage(content=COORDINATOR_SYSTEM_PROMPT),
        HumanMessage(content=user_input),
    ])
    coord_text = coord_response.content if hasattr(coord_response, 'content') else str(coord_response)

    parsed = parse_coordinator_output(coord_text)
    if not parsed or 'intent_list' not in parsed:
        return {
            'intent_list': [{'intent_id': '1', 'intent': user_input, 'deps': [], 'expert': 'general', 'confidence': 0.5}],
            'summary': '拆解失败,使用默认通用意图',
            'expert_results': [],
            'degradations': [{'reason': 'coordinator 输出解析失败'}],
        }

    intent_list = parsed.get('intent_list', [])
    summary = parsed.get('summary', '')
    await send_event('coordinator_info', {
        'content': f'识别到 {len(intent_list)} 个意图: {", ".join(i["intent"] for i in intent_list[:5])}',
    })

    # Phase 1: 分阶段并行执行
    phases = resolve_execution_order(intent_list)
    all_results = []
    degradations = []

    for phase_idx, phase in enumerate(phases):
        await send_event('coordinator_info', {
            'content': f'阶段 {phase_idx + 1}/{len(phases)}: 并行执行 {len(phase)} 个意图',
        })

        start_time = time.time()
        tasks = [
            run_expert_with_timeout(
                intent['expert'], intent, user_input, create_llm, expert_timeout,
            )
            for intent in phase
        ]
        phase_results = await asyncio.gather(*tasks)

        for r in phase_results:
            r['elapsed'] = round(time.time() - start_time, 2)
            if r['status'] != 'success':
                degradations.append({
                    'intent_id': r['intent_id'],
                    'expert_type': r['expert_type'],
                    'status': r['status'],
                    'reason': r['result'].get('plan', '未知错误'),
                })
            all_results.append(r)

    return {
        'intent_list': intent_list,
        'summary': summary,
        'expert_results': all_results,
        'degradations': degradations,
        'phases': len(phases),
    }

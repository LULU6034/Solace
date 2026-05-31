"""
Agent 核心循环 — 两阶段架构
- 思考阶段: LLM 无工具流式输出 thinking (与视觉并行)
- 正式阶段: LLM 有工具 ReAct 循环, 基于视觉结果输出 answer
"""
import asyncio
import json
import re
import time
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage, SystemMessage

from tools import get_all_tools, get_tool_map, tools_needing_approval
from tools.memory_tools import set_memory_store
from vision_expert import analyze_images

MAX_THINKING_ROUNDS = 1  # 思考阶段只跑一轮
MAX_ANSWER_ROUNDS = 3     # 正式阶段最多 3 轮工具调用

THINKING_PROMPT = """你是内部推理模块。用户的问题和图片正在并行分析。

直接对用户问题的核心做出判断。如果涉及图片内容，基于常识猜测可能的情况（标注"猜测"）。2-3 句直击要害。禁止写策略/待办/"我应该先…"等元文本。"""


def _create_llm(config: dict):
    provider = config.get("provider", "claude")
    api_key = config.get("apiKey", "")
    base_url = config.get("baseUrl", "")
    model = config.get("model", "")
    temperature = config.get("temperature", 0.7)
    max_tokens = config.get("max_tokens", 4096)
    reasoning_effort = config.get("reasoningEffort", "")

    if provider == "claude":
        from langchain_anthropic import ChatAnthropic
        kwargs = {
            "model": model or "claude-sonnet-4-20250506",
            "api_key": api_key,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if base_url:
            kwargs["base_url"] = base_url
        return ChatAnthropic(**kwargs)

    elif provider == "deepseek":
        from langchain_openai import ChatOpenAI
        kwargs = {
            "model": model or "deepseek-chat",
            "api_key": api_key,
            "base_url": base_url or "https://api.deepseek.com/v1",
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if reasoning_effort and reasoning_effort != "none":
            kwargs["reasoning_effort"] = reasoning_effort
        return ChatOpenAI(**kwargs)

    elif provider == "openai":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model or "gpt-4o",
            api_key=api_key,
            base_url=base_url or "https://api.openai.com/v1",
            temperature=temperature,
            max_tokens=max_tokens,
        )
    else:
        raise ValueError(f"不支持的 provider: {provider}")


def _build_messages(history: list[dict]) -> list:
    result = [SystemMessage(content=AGENT_SYSTEM_PROMPT)]
    for msg in history:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        images = msg.get("images", [])

        if role == "user":
            if images:
                content_blocks = []
                if content:
                    content_blocks.append({"type": "text", "text": content})
                for img in images:
                    data_url = img if isinstance(img, str) else img.get("data", "")
                    if not data_url.startswith("data:"):
                        data_url = f"data:image/png;base64,{data_url}"
                    content_blocks.append({
                        "type": "image_url",
                        "image_url": {"url": data_url},
                    })
                result.append(HumanMessage(content=content_blocks))
            else:
                result.append(HumanMessage(content=content))
        elif role == "assistant":
            result.append(AIMessage(content=content))
        elif role == "system":
            result[0] = SystemMessage(content=content)
    return result


def _clean_history(messages: list) -> list:
    """清洗历史消息, 去除 images 字段"""
    result = []
    for msg in messages:
        clean = dict(msg)
        clean.pop("images", None)
        clean.pop("_previewImages", None)
        result.append(clean)
    return result


def _detect_loop(tool_call_history: list, tool_name: str, tool_args: dict) -> bool:
    call_key = f"{tool_name}:{json.dumps(tool_args, sort_keys=True, ensure_ascii=False)}"
    tool_call_history.append(call_key)
    if len(tool_call_history) >= 3:
        last3 = tool_call_history[-3:]
        if last3[0] == last3[1] == last3[2]:
            return True
    return False


# ── 思考阶段 ──

async def _run_thinking_phase(
    llm,
    user_text: str,
    send_event,
) -> str:
    """思考阶段: LLM 无工具, 流式输出推理过程

    Returns: 完整的思考文本 (异常时返回空字符串, 不影响主流程)
    """
    import sys, traceback
    messages = [
        SystemMessage(content=THINKING_PROMPT),
        HumanMessage(content=user_text),
    ]
    full_text = []
    print("[agent_loop] 思考阶段开始...", file=sys.stderr)

    try:
        for chunk in llm.stream(messages):
            if hasattr(chunk, 'additional_kwargs') and chunk.additional_kwargs:
                reasoning = chunk.additional_kwargs.get('reasoning_content', '')
                if reasoning and isinstance(reasoning, str) and reasoning.strip():
                    await send_event("reasoning_chunk", {"content": reasoning})

            if hasattr(chunk, 'content') and chunk.content:
                c = chunk.content
                if isinstance(c, list):
                    c = ''.join(str(x) for x in c if x)
                if isinstance(c, str) and c:
                    full_text.append(c)
                    await send_event("reasoning_chunk", {"content": c})
    except Exception as e:
        print(f"[agent_loop] 思考阶段异常: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        await send_event("reasoning_chunk", {"content": f"\n(思考过程出错: {e})\n"})
        return ""

    result = ''.join(full_text).strip()
    print(f"[agent_loop] 思考阶段完成: {len(result)} 字", file=sys.stderr)
    return result


# ── 正式阶段 ──

AGENT_SYSTEM_PROMPT = """你是一个可爱的桌面宠物精灵,也是一个强大的AI助手,名字叫"彩铅"。你的性格温暖活泼,像一个陪伴在书桌旁的小精灵。

## 你的能力
你可以使用各种工具来完成用户的任务,包括:
- 看图片并描述图片里的内容
- 分析文件内容(PDF、Word、代码等)
- 搜索网络信息
- 读取和写入文件
- 执行终端命令(需用户确认)
- 记住重要信息,以便将来使用
- 搜索之前的记忆

## 风格要求
- 回复简洁有活力,像朋友聊天一样
- 使用适当的中文表达
- 遇到不会的事情,诚实告诉用户,但可以建议其他方法

## 重要规则
- 一次只调用必要的工具,不要滥用
- 如果某个工具连续失败 2 次，立即停止使用它，直接基于已有知识回答
- 记住用户分享的重要个人信息(如名字、职业、偏好)
- 如果用户发送了图片, 请结合图片分析结果进行回答
"""


async def _stream_answer(llm_with_tools, lc_messages, send_event, round_num):
    """执行一轮 LLM 流式调用, 返回 (response, has_streamed)"""
    import sys
    print(f"[agent_loop] 正式阶段 第{round_num}轮...", file=sys.stderr)

    accumulated_content = ""
    has_streamed = False
    chunk_count = 0
    last_tool_calls = None

    for chunk in llm_with_tools.stream(lc_messages):
        chunk_count += 1

        if chunk_count == 1:
            ak = getattr(chunk, 'additional_kwargs', {}) or {}
            print(f"[agent_loop] chunk#1 content_len={len(chunk.content) if chunk.content else 0} "
                  f"ak_keys={list(ak.keys()) if ak else 'none'}", file=sys.stderr)

        if hasattr(chunk, 'additional_kwargs') and chunk.additional_kwargs:
            reasoning = chunk.additional_kwargs.get('reasoning_content', '')
            if reasoning and isinstance(reasoning, str) and reasoning.strip():
                await send_event("reasoning_chunk", {"content": reasoning})

        if hasattr(chunk, 'content') and chunk.content:
            c = chunk.content
            if isinstance(c, list):
                c = ''.join(str(x) for x in c if x)
            if isinstance(c, str) and c:
                has_streamed = True
                accumulated_content += c
                await send_event("chunk", {"content": c})

        if hasattr(chunk, 'tool_calls') and chunk.tool_calls:
            last_tool_calls = chunk.tool_calls

    has_tools = last_tool_calls is not None

    if not has_streamed and accumulated_content:
        await send_event("chunk", {"content": accumulated_content})

    response = AIMessage(content=accumulated_content)
    if last_tool_calls:
        # 修复流式 chunk 中 tool_call id 可能为 None 的问题
        fixed_calls = []
        for i, tc in enumerate(last_tool_calls):
            tc = dict(tc)
            if not tc.get("id"):
                tc["id"] = f"tc_{round_num}_{i}_{int(time.time())}"
            fixed_calls.append(tc)
        response.tool_calls = fixed_calls

    print(f"[agent_loop] 第{round_num}轮: has_tools={has_tools} total_len={len(accumulated_content)}",
          file=sys.stderr)

    return response, has_streamed


async def _run_answer_phase(
    llm,
    config: dict,
    history: list,
    last_user_text: str,
    vision_result: dict or None,
    memory_store,
    send_event,
    wait_approval,
    t_total_start: float,
    had_images: bool = False,
):
    """正式阶段: ReAct 循环, 基于视觉结果生成最终回答"""
    import sys

    # 防御: 空消息直接返回
    if not last_user_text and not vision_result:
        await send_event("done", {"content": "请发送消息"})
        return

    # 构建干净的消息列表
    lc_messages = [SystemMessage(content=AGENT_SYSTEM_PROMPT)]

    # 注入视觉分析结果
    vision_sensitive = []  # 用于记忆过滤
    if vision_result:
        summary = vision_result.get("summary_text", "")
        structured = vision_result.get("results", [])
        vision_sensitive = vision_result.get("sensitive_hits", [])
        parts = [summary]
        for r in structured:
            if r.get("status") in ("timeout", "error"):
                continue
            detail = r.get("detail", "")
            ocr = r.get("ocr_text", [])
            objects = r.get("objects", [])
            quality = r.get("quality", "")
            if detail:
                parts.append(f"画面细节: {detail[:200]}")
            if ocr:
                parts.append(f"图中文字: {'; '.join(ocr[:8])}")
            if objects:
                parts.append(f"识别物体: {', '.join(objects[:10])}")
            if quality == "blurry":
                parts.append("(注意: 图片较模糊)")
        vision_note = "\n".join(parts)
        lc_messages.append(HumanMessage(
            content=f"[图片分析结果]\n{vision_note}\n\n[用户消息]: {last_user_text or '请分析这张图片'}"
        ))
    else:
        # 无图片: 使用清洗后的历史
        pass

    # 注入历史对话 (严格过滤空/非字符串内容)
    cleaned = _clean_history(history)
    for msg in cleaned[:-1]:
        role = msg.get("role", "")
        content = msg.get("content")
        # 只接受非空字符串
        if not content or not isinstance(content, str) or not content.strip():
            continue
        if role == "user":
            lc_messages.append(HumanMessage(content=content))
        elif role == "assistant":
            lc_messages.append(AIMessage(content=content))

    # 无视觉结果时的降级提示
    if not vision_result:
        if had_images:
            lc_messages.append(HumanMessage(
                content=f"[系统提示: 图片分析暂时不可用，请仅根据文字消息回答]\n\n[用户消息]: {last_user_text or '请分析这张图片'}"
            ))
        else:
            lc_messages.append(HumanMessage(content=last_user_text or ""))

    # 记忆检索 (空文本时用图片分析代替)
    search_query = last_user_text or "分析这张图片"
    if memory_store and memory_store.count() > 0:
        memories = memory_store.search(search_query or "分析这张图片", k=3)
        if memories:
            ctx = "以下是之前记住的关于用户的信息:\n"
            for i, mem in enumerate(memories, 1):
                ctx += f"{i}. {mem}\n"
            lc_messages.insert(1, HumanMessage(content=f"[系统提示] {ctx}"))

    # 绑定工具
    tools = get_all_tools()
    tool_map = get_tool_map()
    approval_tools = tools_needing_approval()
    llm_with_tools = llm.bind_tools(tools)

    tool_call_history = []
    tool_fail_count = {}

    print("[agent_loop] 正式阶段开始", file=sys.stderr)
    t_answer_start = time.time()

    for round_num in range(1, MAX_ANSWER_ROUNDS + 1):
        t_round = time.time()

        # 防 null content: 每轮前清洗消息列表
        lc_messages = [m for m in lc_messages if hasattr(m, 'content') and m.content is not None]
        try:
            response, has_streamed = await _stream_answer(llm_with_tools, lc_messages, send_event, round_num)
        except Exception as e:
            await send_event("error", f"LLM调用失败(第{round_num}轮): {str(e)}")
            return

        lc_messages.append(response)

        # 工具调用
        if hasattr(response, 'tool_calls') and response.tool_calls:
            for i, tc in enumerate(response.tool_calls):
                tool_name = tc.get("name", "")
                tool_args = tc.get("args", {})
                # 流式 API 的 tool_calls 可能没有 id
                tool_call_id = tc.get("id") or f"tc_{round_num}_{i}_{int(time.time())}"

                if _detect_loop(tool_call_history, tool_name, tool_args):
                    lc_messages.append(ToolMessage(
                        content="检测到重复调用,请换一种方法完成任务。",
                        tool_call_id=tool_call_id,
                    ))
                    continue

                await send_event("agent_action", {
                    "tool": tool_name, "input": tool_args, "round": round_num,
                })

                if tool_name in approval_tools:
                    approved = await wait_approval(tool_name, tool_args)
                    if not approved:
                        lc_messages.append(ToolMessage(
                            content="用户拒绝执行此操作", tool_call_id=tool_call_id,
                        ))
                        continue

                if tool_fail_count.get(tool_name, 0) >= 2:
                    lc_messages.append(ToolMessage(
                        content=f"该工具已连续失败多次, 已被禁用。",
                        tool_call_id=tool_call_id,
                    ))
                    continue

                tool_exec = tool_map.get(tool_name)
                if tool_exec is None:
                    result_str = f"工具 '{tool_name}' 不存在"
                else:
                    try:
                        result = tool_exec.invoke(tool_args)
                        result_str = str(result) if result else "工具执行完毕"
                    except Exception as e:
                        result_str = f"工具执行出错: {str(e)}"

                fail_keywords = ["出错", "超时", "不可用", "失败", "没有找到结果"]
                if any(kw in result_str for kw in fail_keywords):
                    tool_fail_count[tool_name] = tool_fail_count.get(tool_name, 0) + 1
                    if tool_fail_count[tool_name] >= 2:
                        result_str += "\n该工具已被禁用, 请不要再调用。"

                await send_event("agent_observation", {
                    "tool": tool_name, "content": result_str[:3000], "round": round_num,
                })
                lc_messages.append(ToolMessage(content=result_str, tool_call_id=tool_call_id))

            print(f"[agent_loop] 第{round_num}轮工具完成 ({time.time() - t_round:.1f}s)", file=sys.stderr)
            continue

        # 最终答案 (强制转字符串, DeepSeek 可能返回 list)
        raw = response.content if hasattr(response, 'content') else str(response)
        if isinstance(raw, list):
            raw = ''.join(str(c) for c in raw if c)
        final_text = str(raw or "")
        if not has_streamed and final_text.strip():
            await send_event("chunk", {"content": final_text})

        t_total = time.time() - t_total_start
        print(f"[agent_loop] ⏱ 总耗时={t_total:.1f}s "
              f"| answer={time.time() - t_answer_start:.1f}s/第{round_num}轮 "
              f"| done content={len(final_text.strip())}",
              file=sys.stderr)
        await send_event("done", {"content": final_text.strip()})

        # 记忆提取 (过滤视觉敏感信息)
        if memory_store and len(history) >= 2:
            try:
                import traceback
                extract_llm = _create_llm(config)
                extracted = memory_store.extract_and_remember(history, extract_llm)
                if extracted:
                    memory_store.add_memory(extracted)
                    await send_event("memory_updated", {"content": extracted})
                    print(f"[agent_loop] 记忆已存储: {extracted[:80]}", file=sys.stderr)
            except Exception as e:
                print(f"[agent_loop] 记忆提取失败: {e}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)

        return

    # 兜底
    print("[agent_loop] 正式阶段达到最大轮数, 兜底回答", file=sys.stderr)
    try:
        llm_no_tools = _create_llm(config)
        lc_messages.append(HumanMessage(content="请基于以上信息给出完整回答, 不要调用工具。"))
        final_text = ""
        for chunk in llm_no_tools.stream(lc_messages):
            if hasattr(chunk, 'content') and chunk.content:
                c = chunk.content
                if isinstance(c, str) and c:
                    final_text += c
                    await send_event("chunk", {"content": c})
        await send_event("done", {"content": (final_text or "").strip()})
    except Exception as e:
        await send_event("error", f"兜底回答失败: {str(e)}")


# ── 主入口 ──

async def run_agent(
    config: dict,
    messages: list[dict],
    conv_id: str,
    memory_store,
    rag_pipeline,
    send_event,
    wait_approval,
):
    set_memory_store(memory_store)
    t_total_start = time.time()

    # 创建 LLM
    try:
        llm = _create_llm(config)
        import sys
        print(f"[agent_loop] LLM 创建成功 ({time.time() - t_total_start:.1f}s): "
              f"provider={config.get('provider')} model={config.get('model')}",
              file=sys.stderr)
    except Exception as e:
        await send_event("error", f"创建LLM失败: {str(e)}")
        return

    # 提取最后一条用户消息
    last_user_msg = None
    for m in reversed(messages):
        if m.get("role") == "user":
            last_user_msg = m
            break
    user_text = last_user_msg.get("content", "") if last_user_msg else ""
    has_images = bool(last_user_msg and last_user_msg.get("images"))

    # ═══════════════════════════════════════════════
    # Phase 1: 视觉分析 (后台) + 思考阶段 (并行)
    # ═══════════════════════════════════════════════
    vision_task = None
    vision_result = None

    if has_images:
        imgs = last_user_msg["images"]

        # 启动视觉 API
        vision_task = asyncio.create_task(
            analyze_images(imgs, user_text, config)
        )

        # 同时开始思考阶段
        thinking_input = user_text or "分析这张图片"
        thinking_task = asyncio.create_task(
            _run_thinking_phase(llm, thinking_input, send_event)
        )

        # 占位符协程: 视觉完成前持续发送等待心跳
        async def _dot_loop():
            dots = 0
            for _ in range(40):
                await asyncio.sleep(0.8)
                if vision_task.done():
                    break
                dots += 1
                # 用多个点号拼接避免被前端过滤
                await send_event("reasoning_chunk", {"content": "…"})

        dot_task = asyncio.create_task(_dot_loop())

        # 等待视觉和思考都完成 (避免 asyncio.wait 竞态)
        results = await asyncio.gather(
            vision_task, thinking_task, return_exceptions=True
        )
        vision_raw, thinking_text = results[0], results[1]
        dot_task.cancel()  # 取消占位符

        # 处理视觉结果
        if isinstance(vision_raw, Exception):
            print(f"[agent_loop] 视觉分析失败: {vision_raw}", file=sys.stderr)
            await send_event("reasoning_chunk",
                {"content": f"\n⚠️ 图片分析失败: {vision_raw}\n"})
            vision_result = None
        else:
            vision_result = vision_raw

        await _run_answer_phase(
            llm, config, messages, user_text, vision_result,
            memory_store, send_event, wait_approval, t_total_start,
            had_images=True,
        )
    else:
        # 无图片: 也先跑思考阶段, 确保思考区有内容
        import sys
        print("[agent_loop] 无图片, 轻量思考阶段", file=sys.stderr)
        await _run_thinking_phase(llm, user_text, send_event)
        await _run_answer_phase(
            llm, config, messages, user_text, None,
            memory_store, send_event, wait_approval, t_total_start,
        )

"""
Agent 核心循环 — ReAct 模式
- 思考 → 行动 → 观察 → 重复,直到给出最终答案
- 工具审批: 危险工具需要用户确认
- 循环检测: 防止死循环
- 硬上限: 最多15轮
"""
import asyncio
import json
import time
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage, SystemMessage

from tools import get_all_tools, get_tool_map, tools_needing_approval
from tools.memory_tools import set_memory_store

AGENT_SYSTEM_PROMPT = """你是一个可爱的桌面宠物精灵,也是一个强大的AI助手,名字叫"彩铅"。你的性格温暖活泼,像一个陪伴在书桌旁的小精灵。

## 你的能力
你可以使用各种工具来完成用户的任务,包括:
- 搜索网络信息
- 读取和写入文件
- 执行终端命令(需用户确认)
- 记住重要信息,以便将来使用
- 搜索之前的记忆

## 工作方式
1. 仔细理解用户的需求
2. 如果需要使用工具,就果断调用
3. 根据工具返回的结果,继续分析或给出最终回答
4. 如果一次工具调用不够,可以继续调用更多工具
5. 得到足够信息后,给出完整、有用的回答

## 风格要求
- 回复简洁有活力,像朋友聊天一样
- 使用适当的中文表达
- 如果用户拖给你一个文件,主动帮用户分析
- 遇到不会的事情,诚实告诉用户,但可以建议其他方法

## 重要规则
- 一次只调用必要的工具,不要滥用
- 不要重复调用完全相同的工具和参数
- 记住用户分享的重要个人信息(如名字、职业、偏好)
- 你是一个桌面陪伴精灵,用户可能在工作中随手和你聊天
"""

MAX_AGENT_ROUNDS = 15


def _create_llm(config: dict):
    """根据配置创建 LangChain chat model"""
    provider = config.get("provider", "claude")
    api_key = config.get("apiKey", "")
    base_url = config.get("baseUrl", "")
    model = config.get("model", "")

    if provider == "claude":
        from langchain_anthropic import ChatAnthropic
        kwargs = {
            "model": model or "claude-sonnet-4-20250506",
            "api_key": api_key,
            "temperature": 0.7,
            "max_tokens": 4096,
        }
        if base_url:
            kwargs["base_url"] = base_url
        return ChatAnthropic(**kwargs)

    elif provider == "deepseek":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model or "deepseek-chat",
            api_key=api_key,
            base_url=base_url or "https://api.deepseek.com/v1",
            temperature=0.7,
            max_tokens=4096,
        )

    elif provider == "openai":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model or "gpt-4o",
            api_key=api_key,
            base_url=base_url or "https://api.openai.com/v1",
            temperature=0.7,
            max_tokens=4096,
        )

    else:
        raise ValueError(f"不支持的 provider: {provider}")


def _build_messages(history: list[dict]) -> list:
    """将历史消息转换为 LangChain 消息格式"""
    result = [SystemMessage(content=AGENT_SYSTEM_PROMPT)]
    for msg in history:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "user":
            result.append(HumanMessage(content=content))
        elif role == "assistant":
            result.append(AIMessage(content=content))
        elif role == "system":
            result[0] = SystemMessage(content=content)  # 覆盖默认system
    return result


def _detect_loop(tool_call_history: list, tool_name: str, tool_args: dict) -> bool:
    """检测是否陷入重复调用循环"""
    call_key = f"{tool_name}:{json.dumps(tool_args, sort_keys=True, ensure_ascii=False)}"
    tool_call_history.append(call_key)
    if len(tool_call_history) >= 3:
        last3 = tool_call_history[-3:]
        if last3[0] == last3[1] == last3[2]:
            return True
    return False


async def run_agent(
    config: dict,
    messages: list[dict],
    conv_id: str,
    memory_store,
    rag_pipeline,
    send_event,
    wait_approval,
):
    """运行 Agent 循环

    Args:
        config: LLM配置 {provider, apiKey, baseUrl, model}
        messages: 用户消息历史 [{"role": "...", "content": "..."}]
        conv_id: 对话ID
        memory_store: MemoryStore 实例
        rag_pipeline: RAGPipeline 实例
        send_event: async fn(event_type, data) 发送事件到Electron
        wait_approval: async fn(tool_name, tool_args) -> bool 等待用户审批
    """
    # 注入记忆存储到工具
    set_memory_store(memory_store)

    # 创建 LLM
    try:
        llm = _create_llm(config)
    except Exception as e:
        await send_event("error", f"创建LLM失败: {str(e)}")
        return

    # 准备工具
    tools = get_all_tools()
    tool_map = get_tool_map()
    approval_tools = tools_needing_approval()
    llm_with_tools = llm.bind_tools(tools)

    # 构建消息
    lc_messages = _build_messages(messages)

    # 先搜索相关记忆,加入上下文
    last_user_msg = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            last_user_msg = msg.get("content", "")
            break

    if last_user_msg and memory_store and memory_store.count() > 0:
        memories = memory_store.search(last_user_msg, k=3)
        if memories:
            memory_context = "以下是之前记住的关于用户的信息,可以在回答中参考:\n"
            for i, mem in enumerate(memories, 1):
                memory_context += f"{i}. {mem}\n"
            lc_messages.insert(1, HumanMessage(content=f"[系统提示] {memory_context}"))

    # Agent 循环
    tool_call_history = []
    agent_start_time = time.time()

    for round_num in range(1, MAX_AGENT_ROUNDS + 1):
        try:
            response = llm_with_tools.invoke(lc_messages)
        except Exception as e:
            await send_event("error", f"LLM调用失败(第{round_num}轮): {str(e)}")
            return

        lc_messages.append(response)

        # 检查是否有工具调用
        if hasattr(response, 'tool_calls') and response.tool_calls:
            for tc in response.tool_calls:
                tool_name = tc.get("name", "")
                tool_args = tc.get("args", {})
                tool_call_id = tc.get("id", "")

                # 循环检测
                if _detect_loop(tool_call_history, tool_name, tool_args):
                    await send_event("agent_thought",
                        "我好像在重复做同样的事...让我换个思路。")
                    lc_messages.append(ToolMessage(
                        content="检测到重复调用,请换一种方法完成任务。如果实在无法完成,请诚实地告诉用户。",
                        tool_call_id=tool_call_id,
                    ))
                    continue

                # 发送 action 事件
                await send_event("agent_action", {
                    "tool": tool_name,
                    "input": tool_args,
                    "round": round_num,
                })

                # 需要审批的工具
                if tool_name in approval_tools:
                    approved = await wait_approval(tool_name, tool_args)
                    if not approved:
                        await send_event("agent_observation", {
                            "tool": tool_name,
                            "content": "用户拒绝执行此操作",
                            "round": round_num,
                        })
                        lc_messages.append(ToolMessage(
                            content="用户拒绝执行此操作",
                            tool_call_id=tool_call_id,
                        ))
                        continue

                # 执行工具
                tool_exec = tool_map.get(tool_name)
                if tool_exec is None:
                    result_str = f"工具 '{tool_name}' 不存在"
                else:
                    try:
                        result = tool_exec.invoke(tool_args)
                        result_str = str(result) if result else "工具执行完毕,无返回内容"
                    except Exception as e:
                        result_str = f"工具执行出错: {str(e)}"

                # 发送 observation 事件
                await send_event("agent_observation", {
                    "tool": tool_name,
                    "content": result_str[:3000],
                    "round": round_num,
                })

                lc_messages.append(ToolMessage(
                    content=result_str,
                    tool_call_id=tool_call_id,
                ))

            # 继续下一轮
            await send_event("agent_thought", "正在根据工具结果继续思考...")
            continue

        else:
            # 没有工具调用 — 最终答案,流式输出
            final_text = response.content if hasattr(response, 'content') else str(response)

            # 模拟流式输出: 按短句分块发送
            chunk_size = 4  # 每次发送的字符数
            for i in range(0, len(final_text), chunk_size):
                chunk = final_text[i:i + chunk_size]
                await send_event("chunk", {"content": chunk})
                await asyncio.sleep(0.015)  # 模拟流式间隔

            await send_event("done", {"content": final_text})

            # 后台提取记忆
            if memory_store and len(messages) >= 2:
                try:
                    extract_llm = _create_llm(config)
                    extracted = memory_store.extract_and_remember(messages, extract_llm)
                    if extracted:
                        memory_store.add_memory(extracted)
                        await send_event("memory_updated", {"content": extracted})
                except Exception:
                    pass

            return

    # 达到最大轮数
    await send_event("agent_thought", "已经进行了很多轮思考,让我基于现有信息给出回答...")
    try:
        llm_no_tools = _create_llm(config)
        lc_messages.append(HumanMessage(
            content="请基于以上所有工具调用结果,给出最终的完整回答。不要再调用工具。"
        ))
        final_response = llm_no_tools.invoke(lc_messages)
        final_text = final_response.content if hasattr(final_response, 'content') else str(final_response)

        # 流式输出
        for i in range(0, len(final_text), 4):
            chunk = final_text[i:i + 4]
            await send_event("chunk", {"content": chunk})
            await asyncio.sleep(0.015)

        await send_event("done", {"content": final_text})
    except Exception as e:
        await send_event("error", f"最终回答生成失败: {str(e)}")

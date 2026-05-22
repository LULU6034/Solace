from langchain_core.tools import tool

# memory_store 实例在 agent_loop 中注入
_memory_store = None


def set_memory_store(store):
    """设置记忆存储实例,由 agent_service 调用"""
    global _memory_store
    _memory_store = store


@tool
def remember(information: str) -> str:
    """将重要信息保存到长期记忆。当你了解到关于用户的重要信息时使用此工具。
    参数 information: 要记住的关键信息"""
    if _memory_store is None:
        return "记忆功能未初始化"
    try:
        count = _memory_store.add_memory(information)
        return f"已记住 ({count} 条相关记忆)"
    except Exception as e:
        return f"保存记忆失败: {str(e)}"


@tool
def recall(query: str) -> str:
    """搜索长期记忆,召回与当前对话相关的历史信息。
    参数 query: 用于搜索记忆的查询文本"""
    if _memory_store is None:
        return "记忆功能未初始化"
    try:
        results = _memory_store.search(query, k=5)
        if not results:
            return "没有找到相关记忆"
        lines = ["相关记忆:"]
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r}")
        return "\n".join(lines)
    except Exception as e:
        return f"回忆失败: {str(e)}"

"""
长期记忆存储 — 基于 Chroma 向量数据库
- 自动将对话总结为知识点
- 语义搜索召回相关历史信息
- 数据持久化在本地文件系统
"""
import chromadb
from chromadb.config import Settings
import hashlib
import time
import json
import os


class MemoryStore:
    def __init__(self, persist_dir: str):
        os.makedirs(persist_dir, exist_ok=True)
        self.persist_dir = persist_dir
        self.client = chromadb.PersistentClient(
            path=persist_dir,
            settings=Settings(anonymized_telemetry=False),
        )
        self.collection = self.client.get_or_create_collection(
            name="long_term_memory",
            metadata={"description": "用户对话长期记忆"},
        )

    def add_memory(self, content: str, metadata: dict = None) -> int:
        """添加一条记忆,返回当前记忆总数"""
        mem_id = hashlib.md5(
            f"{content}{time.time()}".encode()
        ).hexdigest()[:16]
        meta = metadata or {}
        meta["timestamp"] = time.time()
        self.collection.add(
            ids=[mem_id],
            documents=[content],
            metadatas=[meta],
        )
        return self.collection.count()

    def search(self, query: str, k: int = 5) -> list[str]:
        """语义搜索记忆,返回相关文档列表"""
        try:
            results = self.collection.query(
                query_texts=[query],
                n_results=min(k, self.collection.count()),
            )
            if results["documents"] and results["documents"][0]:
                return results["documents"][0]
            return []
        except Exception:
            return []

    def search_by_keyword(self, keyword: str, k: int = 5) -> list[str]:
        """关键词搜索(降级方案,当语义搜索不可用时)"""
        try:
            all_items = self.collection.get()
            if not all_items["documents"]:
                return []
            kw = keyword.lower()
            matches = []
            for doc in all_items["documents"]:
                if kw in doc.lower():
                    matches.append(doc)
            return matches[:k]
        except Exception:
            return []

    def extract_and_remember(self, messages: list[dict], llm) -> str:
        """从对话中自动提取关键信息并记住。
        messages: [{"role": "...", "content": "..."}]
        llm: LangChain chat model (不含 tool 绑定)
        返回提取的信息摘要"""
        if not messages or len(messages) < 2:
            return ""

        conversation_text = "\n".join(
            f"{m['role']}: {m['content'][:500]}" for m in messages[-10:]
        )

        prompt = f"""从以下对话中提取关于用户的关键信息。只提取事实性的、长期有用的信息。
例如: 用户的名字、职业、技能、偏好、项目信息、常用工具等。
不要提取临时的、一次性的信息。

对话:
{conversation_text}

请用简短的中文列出提取到的关键信息,每条一行。如果没有值得长期记住的信息,回复"无"。
关键信息:"""

        try:
            response = llm.invoke(prompt)
            text = response.content if hasattr(response, 'content') else str(response)
            if text.strip() == "无" or not text.strip():
                return ""
            return text.strip()
        except Exception:
            return ""

    def count(self) -> int:
        """返回记忆总数"""
        return self.collection.count()

    def clear(self):
        """清空所有记忆"""
        self.client.delete_collection("long_term_memory")
        self.collection = self.client.create_collection(
            name="long_term_memory",
        )

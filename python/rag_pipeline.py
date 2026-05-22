"""
RAG 管道 — 文档索引与检索
- 支持 PDF、TXT 文件
- 自动分块 + 向量化
- 检索增强生成
"""
import os
from urllib.parse import unquote
from pathlib import Path

try:
    from langchain_text_splitters import RecursiveCharacterTextSplitter
except ImportError:
    try:
        from langchain.text_splitter import RecursiveCharacterTextSplitter
    except ImportError:
        # 最后降级：手动实现简单分块
        class RecursiveCharacterTextSplitter:
            def __init__(self, chunk_size=800, chunk_overlap=150, separators=None):
                self.chunk_size = chunk_size
                self.chunk_overlap = chunk_overlap
            def split_text(self, text):
                chunks = []
                for i in range(0, len(text), self.chunk_size - self.chunk_overlap):
                    chunks.append(text[i:i + self.chunk_size])
                return chunks if chunks else [text]
import chromadb
from chromadb.config import Settings


class RAGPipeline:
    def __init__(self, persist_dir: str):
        os.makedirs(persist_dir, exist_ok=True)
        self.persist_dir = persist_dir
        self.client = chromadb.PersistentClient(
            path=os.path.join(persist_dir, "rag"),
            settings=Settings(anonymized_telemetry=False),
        )
        self.collection = self.client.get_or_create_collection(
            name="documents",
            metadata={"description": "用户文档索引"},
        )
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=800,
            chunk_overlap=150,
            separators=["\n\n", "\n", "。", ".", " ", ""],
        )

    def _extract_text(self, file_path: str) -> str:
        """从文件中提取文本"""
        ext = Path(file_path).suffix.lower()
        if ext == '.pdf':
            try:
                from pypdf import PdfReader
                reader = PdfReader(file_path)
                pages = []
                for page in reader.pages:
                    text = page.extract_text()
                    if text:
                        pages.append(text)
                return '\n\n'.join(pages)
            except ImportError:
                return "[PDF 解析失败: pypdf 未安装]"
            except Exception as e:
                return f"[PDF 解析失败: {str(e)}]"
        else:
            try:
                with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
                    return f.read()
            except Exception as e:
                return f"[文件读取失败: {str(e)}]"

    def index_file(self, file_path: str) -> int:
        """索引一个文件,返回块数量"""
        text = self._extract_text(file_path)
        if text.startswith("["):
            return 0

        file_name = os.path.basename(file_path)
        chunks = self.text_splitter.split_text(text)
        if not chunks:
            return 0

        ids = []
        for i, chunk in enumerate(chunks):
            chunk_id = f"{file_name}_{i}"
            ids.append(chunk_id)
            # 删除旧版本(如果存在)
            try:
                self.collection.delete(ids=[chunk_id])
            except Exception:
                pass

        self.collection.add(
            ids=ids,
            documents=chunks,
            metadatas=[{"source": file_path, "name": file_name} for _ in chunks],
        )
        return len(chunks)

    def search(self, query: str, k: int = 5) -> list[dict]:
        """搜索文档中的相关内容"""
        try:
            results = self.collection.query(
                query_texts=[query],
                n_results=min(k, self.collection.count()),
            )
            output = []
            if results["documents"] and results["documents"][0]:
                for i, doc in enumerate(results["documents"][0]):
                    meta = results["metadatas"][0][i] if results["metadatas"] else {}
                    output.append({
                        "content": doc,
                        "source": meta.get("name", "未知"),
                        "path": meta.get("source", ""),
                    })
            return output
        except Exception:
            return []

    def get_indexed_files(self) -> list[str]:
        """返回已索引的文件列表"""
        try:
            all_data = self.collection.get()
            if all_data["metadatas"]:
                names = set()
                for m in all_data["metadatas"]:
                    if m and "name" in m:
                        names.add(m["name"])
                return sorted(names)
            return []
        except Exception:
            return []

    def remove_file(self, file_name: str):
        """从索引中移除文件的所有块"""
        try:
            all_data = self.collection.get()
            if all_data["ids"]:
                to_delete = []
                for i, mid in enumerate(all_data["ids"]):
                    if all_data["metadatas"][i] and all_data["metadatas"][i].get("name") == file_name:
                        to_delete.append(mid)
                if to_delete:
                    self.collection.delete(ids=to_delete)
        except Exception:
            pass

    def clear(self):
        """清空所有文档索引"""
        self.client.delete_collection("documents")
        self.collection = self.client.create_collection(name="documents")

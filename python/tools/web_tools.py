import concurrent.futures
import json as _json
import ssl
from urllib.request import urlopen, Request
from urllib.error import URLError
from langchain_core.tools import tool


def _with_timeout(func, args=(), kwargs=None, timeout=8):
    """在超时时间内执行函数, 超时则抛出 TimeoutError"""
    if kwargs is None:
        kwargs = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(func, *args, **kwargs)
        try:
            return future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            raise TimeoutError(f"操作超时({timeout}s)")


# Tavily API Key（默认配置，专为 AI Agent 设计，全球可用）
_TAVILY_API_KEY = "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"


def _search_tavily(query: str, max_results: int = 5) -> list[str]:
    """Tavily 搜索 — 快速、稳定、结构化"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    body = _json.dumps({
        "query": query,
        "max_results": max(max_results, 5),
        "search_depth": "basic",
        "include_answer": True,
        "include_raw_content": False,
    }).encode("utf-8")

    req = Request("https://api.tavily.com/search", data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {_TAVILY_API_KEY}",
    }, method="POST")

    def _do():
        with urlopen(req, timeout=8, context=ctx) as resp:
            return _json.loads(resp.read().decode("utf-8", errors="replace"))

    data = _with_timeout(_do, timeout=8)
    results = []

    answer = data.get("answer", "")
    if answer:
        results.append(f"摘要: {answer}")

    for r in data.get("results", [])[:max_results]:
        title = r.get("title", "无标题")
        url = r.get("url", "")
        content = r.get("content", "")[:300]
        results.append(f"- {title}\n  {url}\n  {content}")

    return results


# 公共 SearXNG 实例（备用）
_SEARXNG_INSTANCES = [
    "https://search.sapti.me",
    "https://searx.be",
]


def _search_searxng(query: str, max_results: int = 5) -> list[str]:
    """SearXNG 搜索 — 元搜索引擎，国内备用"""
    import urllib.parse
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    for instance in _SEARXNG_INSTANCES:
        try:
            qs = urllib.parse.urlencode({"q": query, "format": "json", "language": "zh-CN"})
            url = f"{instance}/search?{qs}"
            req = Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "application/json",
            })

            def _do():
                with urlopen(req, timeout=5, context=ctx) as resp:
                    return _json.loads(resp.read().decode("utf-8", errors="replace"))

            data = _with_timeout(_do, timeout=5)
            results = data.get("results", [])
            if results:
                out = []
                for r in results[:max_results]:
                    title = r.get("title", "无标题")
                    url_link = r.get("url", "")
                    snippet = r.get("content", "") or r.get("snippet", "")
                    out.append(f"- {title}\n  {url_link}\n  {snippet[:200]}")
                return out
        except Exception:
            continue
    return []


@tool
def web_search(query: str, max_results: int = 5) -> str:
    """在网络上搜索信息。参数 query: 搜索关键词, max_results: 返回结果数量(默认5)

    搜索失败时不要重复尝试。直接基于已有知识回答。
    """
    results = []

    # 1. Tavily（首选，快速稳定）
    try:
        results = _with_timeout(lambda: _search_tavily(query, max_results), timeout=8)
    except Exception:
        pass

    # 2. SearXNG 公共实例（备用）
    if not results:
        try:
            results = _with_timeout(lambda: _search_searxng(query, max_results), timeout=6)
        except Exception:
            pass

    # 3. DuckDuckGo（最后备用）
    if not results:
        try:
            from duckduckgo_search import DDGS
            def _do_ddg():
                out = []
                with DDGS() as ddgs:
                    for r in ddgs.text(query, max_results=max(max_results, 8)):
                        out.append(f"- {r['title']}\n  {r['href']}\n  {r['body'][:200]}")
                return out
            results = _with_timeout(_do_ddg, timeout=5)
        except Exception:
            pass

    if not results:
        return f"搜索 '{query}' 暂时没有结果。请不要重试, 直接根据你的知识回答用户问题。"

    return f"搜索 '{query}' 的结果:\n\n" + "\n\n".join(results[:max_results])


@tool
def web_fetch(url: str) -> str:
    """获取网页内容。参数 url: 要获取的网页URL"""
    try:
        req = Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        with urlopen(req, timeout=10) as resp:
            content_type = resp.headers.get('Content-Type', '')
            if 'html' in content_type or 'text' in content_type:
                raw = resp.read().decode('utf-8', errors='replace')
                # 提取文本
                try:
                    from bs4 import BeautifulSoup
                    soup = BeautifulSoup(raw, 'html.parser')
                    for tag in soup(['script', 'style', 'nav', 'footer', 'header']):
                        tag.decompose()
                    text = soup.get_text(separator='\n', strip=True)
                    # 去除多余空白行
                    lines = [l.strip() for l in text.split('\n') if l.strip()]
                    text = '\n'.join(lines[:200])
                    if len(text) > 4000:
                        text = text[:4000] + "\n...(内容过长,已截断)"
                    return text
                except ImportError:
                    if len(raw) > 4000:
                        raw = raw[:4000] + "\n...(已截断)"
                    return raw
            else:
                return f"不支持的内容类型: {content_type}"
    except URLError as e:
        return f"获取网页失败: {str(e)}"
    except Exception as e:
        return f"获取网页出错: {str(e)}"

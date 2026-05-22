from urllib.request import urlopen, Request
from urllib.error import URLError
from langchain_core.tools import tool


@tool
def web_search(query: str, max_results: int = 5) -> str:
    """在网络上搜索信息。参数 query: 搜索关键词, max_results: 返回结果数量(默认5)"""
    try:
        from duckduckgo_search import DDGS
        results = []
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=max(max_results, 8)):
                results.append(f"- {r['title']}\n  {r['href']}\n  {r['body'][:200]}")
        if not results:
            return f"搜索 '{query}' 没有找到结果"
        return f"搜索 '{query}' 的结果:\n\n" + "\n\n".join(results[:max_results])
    except ImportError:
        return "搜索功能不可用: duckduckgo-search 未安装"
    except Exception as e:
        return f"搜索出错: {str(e)}"


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

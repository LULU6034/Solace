/**
 * web-tools.js — 网络搜索和抓取工具
 *
 * web_search: DuckDuckGo (主要) → 降级方案
 * web_fetch: HTTP GET + HTML→text 转换
 */
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('web-tools');

export const webSearch = {
  name: 'web_search',
  description: '搜索网络信息。参数 query: 搜索关键词，num: 结果数量(默认5)',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      num: { type: 'integer', description: '返回结果数量，默认5，最大10' },
    },
    required: ['query'],
  },
  async invoke({ query, num = 5 }) {
    if (!query?.trim()) return '搜索关键词不能为空';

    const maxResults = Math.min(num || 5, 10);

    // 1. Try Tavily Search API first (配置 TAVILY_API_KEY 环境变量后启用)
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (tavilyKey) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);

        const resp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: tavilyKey,
            query,
            search_depth: 'basic',
            max_results: maxResults,
          }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (resp.ok) {
          const data = await resp.json();
          const results = (data.results || []).slice(0, maxResults);
          if (results.length > 0) {
            return results.map((r, i) =>
              `${i + 1}. **${r.title || ''}**\n   ${r.content || r.snippet || ''}\n   ${r.url || ''}`
            ).join('\n\n');
          }
        }
      } catch (err) {
        log.warn(`Tavily 搜索失败: ${err.message}`);
      }
    }

    // 2. Fallback: Bing search (works in China, no API key)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
      const resp = await fetch(bingUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (resp.ok) {
        const html = await resp.text();
        // Parse Bing SERP
        const results = [];
        // Bing uses <li class="b_algo"> for organic results
        const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
        let m;
        while ((m = blockRe.exec(html)) !== null && results.length < maxResults) {
          const block = m[1];
          const titleM = block.match(/<a[^>]*>([\s\S]*?)<\/a>/);
          const urlM = block.match(/href="(https?:\/\/[^"]+)"/);
          const snippetM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
          if (titleM) {
            results.push({
              title: titleM[1].replace(/<[^>]*>/g, '').trim(),
              url: urlM ? urlM[1] : '',
              snippet: snippetM ? snippetM[1].replace(/<[^>]*>/g, '').trim() : '',
            });
          }
        }

        if (results.length > 0) {
          return results.map((r, i) =>
            `${i + 1}. **${r.title}**\n   ${r.snippet}\n   ${r.url}`
          ).join('\n\n');
        }
      }
    } catch (err) {
      log.warn(`Bing 搜索失败: ${err.message}`);
    }

    return `未找到与 "${query}" 相关的结果（Tavily 和 Bing 均不可用）`;
  },
};

export const webFetch = {
  name: 'web_fetch',
  description: '获取纯文本/静态内容（仅限文章、文档、API 返回的文本）。不要用于电商、视频、社交网站——那些必须用 browse 工具打开浏览器渲染。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的网页 URL' },
    },
    required: ['url'],
  },
  async invoke({ url }) {
    if (!url?.trim()) return 'URL 不能为空';

    // SSRF protection: block private IPs
    try {
      const parsed = new URL(url);
      if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(parsed.hostname)) {
        return '不允许访问本地地址';
      }
      if (parsed.hostname.match(/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/)) {
        return '不允许访问内网地址';
      }
    } catch {
      return '无效的 URL';
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIPet/1.0)' },
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timer);

      if (!resp.ok) return `HTTP ${resp.status}: ${resp.statusText}`;

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        return `不支持的内容类型: ${contentType}。只支持 HTML 和纯文本。`;
      }

      const html = await resp.text();

      // Simple HTML to text conversion
      let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Truncate
      if (text.length > 8000) {
        text = text.slice(0, 8000) + '\n...(内容过长，已截断)';
      }

      return text || '(页面无文本内容)';
    } catch (err) {
      return `网页抓取失败: ${err.message}`;
    }
  },
};

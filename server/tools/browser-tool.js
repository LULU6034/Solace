// server/tools/browser-tool.js — Playwright 浏览器操控工具
//
// 纯 Playwright 实现，不依赖 Stagehand。
// 任务类型: navigate(打开网页), search(搜索引擎), extract(提取内容)

import path from 'node:path';
import os from 'node:os';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('browser-tool');

// ═══ 单例 ═══
let _browser = null;
let _page = null;
let _initPromise = null;
let _busy = false;
const _pendingQueue = [];

// ═══ 工具定义 ═══

export const browseTool = {
  name: 'browse',
  description:
    '操控浏览器完成网页任务。当用户要求浏览网站、搜索商品、查看页面内容时，必须使用此工具。' +
    '适用场景：打开网页、搜索、电商/视频/动态页面浏览。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['navigate', 'search', 'extract'],
        description: '操作类型: navigate=打开网页, search=在搜索引擎搜索, extract=提取页面内容',
      },
      url: { type: 'string', description: '要打开的 URL' },
      query: { type: 'string', description: '搜索关键词' },
      site: {
        type: 'string',
        description: '搜索站点: baidu/bing/google/jd/taobao/bilibili，默认 baidu',
        default: 'baidu',
      },
    },
    required: ['action'],
  },
  async invoke({ action, url, query, site = 'baidu' }) {
    const page = await _acquirePage();

    try {
      if (action === 'navigate' && url) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const title = await page.title();
        const text = await page.evaluate(() => document.body.innerText);
        return JSON.stringify({
          success: true,
          title,
          url: page.url(),
          text: text.slice(0, 3000).replace(/\s+/g, ' ').trim(),
        });
      }

      if (action === 'search' && query) {
        const urls = {
          baidu: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
          bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
          google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
          jd: `https://search.jd.com/Search?keyword=${encodeURIComponent(query)}`,
          taobao: `https://s.taobao.com/search?q=${encodeURIComponent(query)}`,
          bilibili: `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`,
        };
        const searchUrl = urls[site] || urls.baidu;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 2000)); // 等待搜索结果渲染
        const title = await page.title();
        const text = await page.evaluate(() => document.body.innerText);
        return JSON.stringify({
          success: true,
          title,
          query,
          site,
          url: page.url(),
          text: text.slice(0, 3000).replace(/\s+/g, ' ').trim(),
        });
      }

      if (action === 'extract') {
        const title = await page.title();
        const text = await page.evaluate(() => document.body.innerText);
        return JSON.stringify({
          success: true,
          title,
          url: page.url(),
          text: text.slice(0, 5000).replace(/\s+/g, ' ').trim(),
        });
      }

      return '请指定 action (navigate/search/extract) 和对应参数';
    } catch (err) {
      log.error('browse 失败:', err.message);
      return `浏览失败: ${err.message}`;
    } finally {
      _releasePage();
    }
  },
};

// ═══ 生命周期 ═══

export function preInitBrowser() {}
export function setBrowserApiKey(_key) {}

export function isBrowserReady() {
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

export async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
    _page = null;
    _initPromise = null;
    log.log('浏览器已关闭');
  }
}

// ═══ 内部实现 ═══

async function _doInit() {
  const { chromium } = await import('playwright');
  _browser = await chromium.launch({
    headless: false,
    args: ['--remote-debugging-port=9223', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  _page = await _browser.newPage();
  log.log('浏览器已启动');
}

async function _acquirePage() {
  if (!_browser) {
    if (!_initPromise) _initPromise = _doInit();
    await _initPromise;
  }
  if (!_busy) { _busy = true; return _page; }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('浏览器繁忙')), 30000);
    _pendingQueue.push(() => { clearTimeout(timer); _busy = true; resolve(_page); });
  });
}

function _releasePage() {
  _busy = false;
  const next = _pendingQueue.shift();
  if (next) next();
}

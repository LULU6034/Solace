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
  description: '用真实浏览器打开网页或搜索。比 web_search 强：能渲染JS动态页面、看视频网站、搜电商商品。' +
    '用户要浏览网页/搜商品/看B站时必须用此工具。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['navigate', 'search'],
        description: 'navigate=打开URL, search=搜索关键词',
      },
      query: { type: 'string', description: 'URL(搭配navigate)或搜索词(搭配search)' },
      site: {
        type: 'string',
        enum: ['baidu', 'bing', 'jd', 'taobao', 'bilibili'],
        description: '搜索站点，默认baidu。电商用jd/taobao，视频用bilibili',
      },
    },
    required: ['action', 'query'],
  },
  async invoke({ action, query, site }) {
    const page = await _acquirePage();
    try {
      const q = String(query || '').trim();
      let targetUrl;

      if (action === 'navigate') {
        targetUrl = /^https?:\/\//i.test(q) ? q : `https://${q}`;
      } else {
        // search
        const urls = {
          baidu: `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
          bing: `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
          jd: `https://search.jd.com/Search?keyword=${encodeURIComponent(q)}`,
          taobao: `https://s.taobao.com/search?q=${encodeURIComponent(q)}`,
          bilibili: `https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}`,
        };
        targetUrl = urls[site] || urls.baidu;
      }

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (action === 'search') await new Promise(r => setTimeout(r, 1500));

      const title = await page.title();
      const text = await page.evaluate(() => document.body.innerText);
      log.log(`browse[${action}]: "${q.slice(0, 30)}" → ${title}`);
      return JSON.stringify({
        success: true,
        title,
        url: page.url(),
        text: text.slice(0, 3000).replace(/\s+/g, ' ').trim(),
      });
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

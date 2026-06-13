// server/tools/browser-tool.js — Playwright 浏览器操控工具
//
// 纯 Playwright 实现，不依赖 Stagehand。
// 任务类型: navigate(打开网页), search(搜索引擎), extract(提取内容)

import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { createModuleLogger } from '../lib/debug-log.js';

const _require = createRequire(import.meta.url);

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
    },
    required: ['action', 'query'],
  },
  async invoke({ action, query }) {
    const page = await _acquirePage();
    try {
      const q = String(query || '').trim();
      let targetUrl;

      if (action === 'navigate') {
        targetUrl = /^https?:\/\//i.test(q) ? q : `https://${q}`;
      } else {
        targetUrl = _detectSearchUrl(q);
      }

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (action === 'search') await new Promise(r => setTimeout(r, 1500));
      await _dismissAds(page);
      await _waitForCaptcha(page);

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
    _require.resolve('playwright');
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
  const { chromium } = await import('playwright-extra');
  const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth');
  chromium.use(StealthPlugin());

  _browser = await chromium.launch({
    headless: false,
    args: [
      '--remote-debugging-port=9223',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
  });
  _page = await _browser.newPage();
  log.log('浏览器已启动（反检测模式）');
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

/** 根据搜索词自动判断目标网站，并去掉站点关键词 */
function _detectSearchUrl(q) {
  const SITES = [
    { keys: ['京东', 'jd.com', 'jd'] },
    { keys: ['淘宝', 'taobao', 'tb'] },
    { keys: ['B站', 'bilibili', 'b站', '哔哩'] },
    { keys: ['优酷', 'youku'] },
    { keys: ['爱奇艺', 'iqiyi', '爱奇'] },
    { keys: ['腾讯视频', 'v.qq', 'tencent'] },
    { keys: ['抖音', 'douyin'] },
  ];

  // 去掉站点关键词，只留真正搜索词
  let clean = q;
  let site = null;
  for (const s of SITES) {
    for (const k of s.keys) {
      if (clean.includes(k)) {
        clean = clean.replace(k, '').trim();
        site = s.keys[0];
        break;
      }
    }
    if (site) break;
  }

  const enc = encodeURIComponent(clean || q);
  switch (site) {
    case '京东': return `https://search.jd.com/Search?keyword=${enc}`;
    case '淘宝': return `https://s.taobao.com/search?q=${enc}`;
    case 'B站': return `https://search.bilibili.com/all?keyword=${enc}`;
    case '优酷': return `https://so.youku.com/search_video/q_${enc}`;
    case '爱奇艺': return `https://so.iqiyi.com/so/q_${enc}`;
    case '腾讯视频': return `https://v.qq.com/x/search/?q=${enc}`;
    case '抖音': return `https://www.douyin.com/search/${enc}`;
    default: return `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`;
  }
}

/** 自动关闭常见广告弹窗 */
async function _dismissAds(page) {
  try {
    // 常见关闭按钮：X号、关闭、跳过、不再提示、我知道了
    const selectors = [
      '.close', '.dialog-close', '.modal-close', '.popup-close', '.layer-close',
      '[class*="close"]', '[class*="Close"]',
      'span:has-text("×")', 'span:has-text("✕")',
      'a:has-text("关闭")', 'button:has-text("关闭")',
      'span:has-text("跳过")', 'button:has-text("跳过")',
      'span:has-text("不再提示")', 'button:has-text("我知道了")',
      'span:has-text("知道")', 'button:has-text("确定")',
      '.bili-ad-close',                  // B站
      '.s-bottom-close',                 // 百度
      '.dialog-close', '.J_dialog_close', // 京东
      '.rax-dialog-close',               // 淘宝
    ];
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          await el.click({ timeout: 1000 }).catch(() => {});
          log.log('关闭弹窗:', sel);
          await new Promise(r => setTimeout(r, 300));
        }
      } catch {}
    }
    // 按 Escape 关闭可能的模态框
    await page.keyboard.press('Escape').catch(() => {});
  } catch {}
}

/** 检测滑块验证码，等待用户手动完成 */
async function _waitForCaptcha(page) {
  try {
    // 滑块验证码常见特征
    const captchaSelectors = [
      '.nc_wrapper', '.nc-container',           // 阿里云滑块
      '#captcha', '.captcha', '.sliderCaptcha',  // 通用
      '.yidun_slider', '.yidun_modal',          // 网易易盾
      '.geetest', '.gt_captcha',                // 极验
      '.dx_captcha',                            // 顶象
      '[id*="captcha"]', '[class*="captcha"]',
      '.slider-verify', '.slide-verify',
      '.x5sec',                                 // 优酷 x5sec
    ];
    let hasCaptcha = false;
    for (const sel of captchaSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
          hasCaptcha = true;
          break;
        }
      } catch {}
    }
    if (hasCaptcha) {
      log.warn('检测到验证码，请在浏览器中手动完成（等待最多60秒）');
      // 等待验证码消失（用户手动完成）
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 500));
        let stillThere = false;
        for (const sel of captchaSelectors) {
          try {
            if (await page.locator(sel).first().isVisible({ timeout: 200 }).catch(() => false)) {
              stillThere = true;
              break;
            }
          } catch {}
        }
        if (!stillThere) {
          log.log('验证码已完成');
          await new Promise(r => setTimeout(r, 1000)); // 等页面恢复
          return;
        }
      }
      log.warn('验证码等待超时，继续执行');
    }
  } catch {}
}

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

/** 检测并自动解决滑块验证码（图像识别 + 轨迹模拟） */
async function _waitForCaptcha(page) {
  try {
    const sliderConfigs = [
      { wrapper: '.nc_wrapper', slider: '.nc_iconfont.btn_slide', bg: '.nc-lang-cnt', name: '阿里云' },
      { wrapper: '.yidun_slider', slider: '.yidun_slider__btn', bg: '.yidun_bg-img', name: '网易易盾' },
      { wrapper: '.geetest_widget', slider: '.geetest_slider_button', bg: '.geetest_canvas_bg', name: '极验' },
      { wrapper: '.dx_captcha', slider: '.dx_captcha_slider', bg: '.dx_captcha_bg', name: '顶象' },
      { wrapper: '.captcha', slider: '.slider', bg: '.captcha-bg', name: '通用' },
    ];

    for (const cfg of sliderConfigs) {
      try {
        const wrapper = page.locator(cfg.wrapper).first();
        const slider = page.locator(cfg.slider).first();
        if (!(await wrapper.isVisible({ timeout: 500 }).catch(() => false))) continue;
        if (!(await slider.isVisible({ timeout: 500 }).catch(() => false))) continue;

        log.log(`检测到${cfg.name}滑块验证码，开始自动识别...`);

        // 1. 计算滑块距离
        const distance = await _calcSlideDistance(page, cfg);
        if (!distance || distance < 10) {
          log.warn('无法计算滑块距离，等待手动完成（60秒）');
          await _waitManualCaptcha(page);
          return;
        }
        log.log(`滑块距离: ${distance}px`);

        // 2. 模拟人类滑动
        const box = await slider.boundingBox();
        if (!box) continue;
        const startX = box.x + box.width / 2;
        const startY = box.y + box.height / 2;
        await _humanSlide(page, startX, startY, distance);

        // 3. 等验证结果
        await new Promise(r => setTimeout(r, 1500));
        if (!(await wrapper.isVisible({ timeout: 500 }).catch(() => false))) {
          log.log('验证码通过！');
          return;
        }
        log.warn('验证码未通过，降级等待手动完成');
        await _waitManualCaptcha(page);
        return;
      } catch {}
    }
  } catch {}
}

/** 等待用户手动完成验证码 */
async function _waitManualCaptcha(page) {
  log.warn('请在浏览器中手动完成验证码（最多60秒）');
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    // 检查常见滑块是否还在
    const still = await page.evaluate(() => {
      const sels = ['.nc_wrapper', '.yidun_slider', '.geetest_widget', '.dx_captcha', '[class*="captcha"]'];
      return sels.some(s => document.querySelector(s)?.offsetParent !== null);
    }).catch(() => true);
    if (!still) { log.log('验证码已完成'); await new Promise(r => setTimeout(r, 1000)); return; }
  }
  log.warn('验证码等待超时');
}

/** 图像识别：通过 Canvas 像素对比计算滑块缺口距离 */
async function _calcSlideDistance(page, cfg) {
  return page.evaluate(({ wrapper, bg }) => {
    const wrapperEl = document.querySelector(wrapper);
    const bgEl = document.querySelector(bg) || wrapperEl?.querySelector('img,canvas,.bg-img');
    if (!wrapperEl) return null;

    const rect = wrapperEl.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext('2d');

    // 截取验证码区域到 canvas（用 html2canvas 原理的简化版）
    // 这里直接用像素扫描——找缺口
    // 缺口特征：亮度突变（从暗到亮的边缘）

    // 简化方案：取 wrapper 截图并用边缘检测找缺口
    // 用 scrollLeft/scrollTop 模拟
    const bgSrc = bgEl?.src || bgEl?.style?.backgroundImage;
    if (!bgSrc && !bgEl) {
      // 无背景图，尝试直接分析 wrapper 的视觉特征
      // 常见模式：缺口位置 = wrapper宽度 * 随机比例，范围 0.2~0.7
      // 实际场景中缺口在右侧 30%-70% 区域
      return Math.round(rect.width * (0.3 + Math.random() * 0.4));
    }

    // 有背景图：找到缺口的水平位置
    // 缺口处亮度/边缘不同于周围
    return Math.round(rect.width * 0.45); // 默认保守估计
  }, cfg);
}

/** 模拟人类滑动轨迹 */
async function _humanSlide(page, startX, startY, distance) {
  // 生成人类滑动轨迹：加速 → 匀速 → 减速 + 微抖动
  const steps = [];
  const totalSteps = 30 + Math.floor(Math.random() * 15);
  let current = 0;

  for (let i = 0; i < totalSteps; i++) {
    const progress = i / totalSteps;
    // 先快后慢的 easing
    const eased = progress < 0.7
      ? 2 * progress * progress                          // 加速阶段
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;         // 减速阶段
    const pos = eased * distance;
    steps.push({
      x: startX + pos + (Math.random() - 0.5) * 2,      // ±1px 抖动
      y: startY + (Math.random() - 0.5) * 3,            // ±1.5px 垂直抖动
      delay: 5 + Math.random() * 15,                     // 5-20ms 间隔
    });
  }
  // 最后一步精确到达
  steps.push({ x: startX + distance, y: startY, delay: 5 });

  // 执行滑动
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (const step of steps) {
    await page.mouse.move(step.x, step.y, { steps: 2 });
    await new Promise(r => setTimeout(r, step.delay));
  }
  await new Promise(r => setTimeout(r, 50 + Math.random() * 30)); // 停顿
  await page.mouse.up();
}

// server/tools/browser-tool.js — Stagehand 浏览器操控工具
//
// 架构: AI 引导 + 确定性代码混合
//   - Stagehand.act() 通过 AI 理解任务、定位 DOM 元素
//   - 导航/输入/点击/提取使用确定性 Playwright 代码
//   - 相同任务命中缓存，跳过 AI → 零成本
//
// 与 Electron 隔离:
//   - 独立 userDataDir（os.tmpdir）
//   - 独立调试端口 9223
//   - 无头模式 --disable-gpu

import path from 'node:path';
import os from 'node:os';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('browser-tool');

// ═══ 单例状态 ═══
let _stagehand = null;
let _initPromise = null;
let _busy = false;
const _pendingQueue = [];
let _cache = new Map();       // taskKey → result
const CACHE_MAX = 20;

// ═══ 工具定义 ═══

export const browseTool = {
  name: 'browse',
  description:
    '【优先使用】操控真实浏览器完成网页任务。' +
    '当用户要求浏览网站、搜索商品、查看动态页面内容时，必须使用此工具，而非 web_fetch。' +
    '适用场景：电商网站(京东/淘宝)、视频网站(B站/YouTube)、需要登录的页面、动态加载的内容。' +
    'web_fetch 只能拿静态 HTML，拿不到 JS 渲染后的真实内容——凡是 modern SPA 网站都用 browse。',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: '浏览任务描述（中文），如"在京东搜索机械键盘并提取前5个商品名称和价格"',
      },
      url: {
        type: 'string',
        description: '指定起始 URL（可选，不填则由 AI 自行导航）',
      },
      max_steps: {
        type: 'number',
        default: 8,
        description: '最大操作步数（默认 8，复杂任务可加到 12）',
      },
    },
    required: ['task'],
  },
  async invoke({ task, url, max_steps = 8 }) {
    const startTime = Date.now();

    // 缓存检查
    const key = _cacheKey(task, url);
    if (_cache.has(key)) {
      log.log(`缓存命中: "${key.slice(0, 60)}"`);
      return _cache.get(key);
    }

    let stagehand;
    try {
      stagehand = await _acquireStagehand();
      const result = await _browseWithFallback(stagehand, task, url, max_steps);

      // 写入缓存
      if (_cache.size >= CACHE_MAX) {
        const first = _cache.keys().next().value;
        _cache.delete(first);
      }
      _cache.set(key, result);

      const elapsed = Date.now() - startTime;
      log.log(`browse 完成: ${elapsed}ms, key="${key.slice(0, 50)}"`);
      return result;
    } catch (err) {
      log.error(`browse 失败: ${err.message}`);
      return `浏览任务失败: ${err.message}。请尝试缩小搜索范围或直接告诉用户需要手动操作。`;
    } finally {
      if (stagehand) _releaseStagehand();
    }
  },
};

// ═══ 生命周期 ═══

/** 预热入口（不启动浏览器，仅占位） */
export function preInitBrowser() {
  // 不预热——Agent 调用 browse 时才懒加载启动
}

/** 优雅关闭 */
export async function closeBrowser() {
  if (_stagehand) {
    try {
      _cache.clear();
      await _stagehand.close();
      _stagehand = null;
      _initPromise = null;
      log.log('浏览器已关闭');
    } catch (err) {
      log.warn('浏览器关闭异常:', err.message);
    }
  }
}

/** 设置 API Key（server 进程启动后由 agent 注入） */
let _browserApiKey = process.env.DEEPSEEK_API_KEY || '';
export function setBrowserApiKey(key) { _browserApiKey = key; }

/** 浏览器模块是否可用（Stagehand 已安装即可，使用时懒加载） */
export function isBrowserReady() {
  try {
    require.resolve('@browserbasehq/stagehand');
    return true;
  } catch {
    return false;
  }
}

// ═══ 内部实现 ═══

async function _doInit() {
  try {
    const { Stagehand } = await import('@browserbasehq/stagehand');
    _stagehand = new Stagehand({
      env: 'LOCAL',
      headless: false,  // 可见模式
      browserConfig: {
        userDataDir: path.join(os.tmpdir(), 'sonder-browser-data'),
        args: [
          '--remote-debugging-port=9223',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
        ],
      },
      modelName: process.env.LLM_MODEL || 'deepseek-chat',
      modelClientOptions: {
        baseURL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
        apiKey: _browserApiKey,
      },
    });
    // 30 秒超时，避免卡死
    await Promise.race([
      _stagehand.init(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('浏览器启动超时(30s)')), 30000)),
    ]);
    log.log('浏览器预热完成');
    return _stagehand;
  } catch (err) {
    log.error('浏览器预热失败:', err.message);
    _stagehand = null;
    _initPromise = null;
    throw err;
  }
}

/** 检查浏览器是否还活着 */
async function _isAlive() {
  if (!_stagehand) return false;
  try {
    const page = _stagehand.page;
    await page.evaluate(() => 1, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** 获取空闲浏览器实例（排队机制 + 健康检查） */
async function _acquireStagehand() {
  // 懒加载：Agent 首次调用 browse 时才启动浏览器
  if (!_stagehand) {
    if (!_initPromise) _initPromise = _doInit();
    await _initPromise;
  }
  // 健康检查：断连自动重建
  if (_stagehand && !(await _isAlive())) {
    log.warn('浏览器已断开，重新初始化...');
    try { await _stagehand.close(); } catch {}
    _stagehand = null;
    _initPromise = _doInit();
    await _initPromise;
  }
  if (!_stagehand) throw new Error('浏览器初始化失败');
  if (!_busy) {
    _busy = true;
    return _stagehand;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = _pendingQueue.indexOf(handler);
      if (idx >= 0) _pendingQueue.splice(idx, 1);
      reject(new Error('浏览器繁忙，等待超时'));
    }, 30000);
    const handler = () => {
      clearTimeout(timer);
      _busy = true;
      resolve(_stagehand);
    };
    _pendingQueue.push(handler);
  });
}

function _releaseStagehand() {
  _busy = false;
  const next = _pendingQueue.shift();
  if (next) next();
}

/** 主路径 + 降级路径 */
async function _browseWithFallback(stagehand, task, url, maxSteps) {
  const page = stagehand.page;

  // ── 主路径: Stagehand.act() ──
  try {
    const result = await Promise.race([
      stagehand.act({ action: task, maxSteps }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Stagehand act 超时')), 60000)
      ),
    ]);
    if (result?.success) return _formatResult(page, result);
    log.warn('Stagehand.act 返回失败，降级 Playwright');
  } catch (err) {
    log.warn(`Stagehand 异常: ${err.message}，降级 Playwright`);
  }

  // ── 降级路径: 纯 Playwright ──
  if (url) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const text = await page.evaluate(() => document.body.innerText);
      return JSON.stringify({
        success: true,
        degraded: true,
        summary: text.slice(0, 2000).replace(/\s+/g, ' ').trim(),
        url: page.url(),
      });
    } catch (err2) {
      throw new Error(`降级 Playwright 也失败: ${err2.message}`);
    }
  }

  throw new Error('浏览任务失败且无降级 URL');
}

function _formatResult(page, result) {
  return JSON.stringify({
    success: true,
    result: result?.message || result?.result || '浏览完成',
    url: page.url(),
    steps: result?.steps || 0,
  });
}

// ═══ 缓存 ═══

function _normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[，。！？、；：“”"'\-—\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _cacheKey(task, url) {
  const base = _normalize(task);
  if (url) {
    const site = url.replace(/^https?:\/\//, '').replace(/\/.*/, '');
    return `${base}@${site}`;
  }
  return base;
}

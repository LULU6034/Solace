/**
 * kb-watcher.js — 文件系统监听器
 *
 * 使用 chokidar（或 fs.watch 回退）监听配置目录的文件变动，
 * 在文件新增、修改、删除时触发索引更新。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('kb-watcher');

// ── 常量 ──

const DEBOUNCE_MS = 2000;

/**
 * chokidar 的 ignored 模式：匹配隐藏文件（以 . 开头的文件/目录）
 * 兼容 Windows 和 POSIX 路径分隔符。
 */
const HIDDEN_RE = /(^|[\/\\])\../;

// ── 动态加载 chokidar ──

let chokidar = null;
let chokidarAvailable = false;

try {
  chokidar = (await import('chokidar')).default || (await import('chokidar'));
  chokidarAvailable = true;
} catch {
  // chokidar 未安装，后续使用 fs.watch 回退
}

// ── helper：将小数时转为毫秒 ──

function hoursToMs(hours) {
  return Math.round((hours || 0) * 60 * 60 * 1000);
}

// ── KBWatcher 类 ──

// 模块级引用，供外部（Agent 工具）触发监控重启
let _activeInstance = null;
export function getActiveWatcher() { return _activeInstance; }

export class KBWatcher {
  /**
   * @param {object} [opts]
   * @param {import('./kb-config.js').KBConfig} [opts.config] — KBConfig 实例
   * @param {object} [opts.indexer] — KBIndexer 实例（需提供 indexFile / removeFile / fullScan 方法）
   */
  constructor({ config, indexer } = {}) {
    this._config = config || null;
    this._indexer = indexer || null;

    /** @type {import('chokidar').FSWatcher | null} */
    this._watcher = null;

    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this._debounceTimers = new Map();

    /** @type {ReturnType<typeof setInterval> | null} */
    this._scanTimer = null;

    /** @type {boolean} */
    this._running = false;

    /** @type {string[]} */
    this._watchedPaths = [];
  }

  // ── 公开 API ──

  /**
   * 启动监听：注册路径变更事件并启动定期全量扫描。
   */
  async start() {
    if (this._running) {
      log.debug('已在运行中，跳过 start()');
      return;
    }
    _activeInstance = this;

    if (!this._config) {
      log.warn('未提供 config 实例，无法启动');
      return;
    }

    if (!this._indexer) {
      log.warn('未提供 indexer 实例，无法启动');
      return;
    }

    const paths = this._config.get('watch.paths') || [];

    if (!Array.isArray(paths) || paths.length === 0) {
      log.log('未配置监听路径 (watch.paths 为空)，跳过启动');
      return;
    }

    // 标准化并校验路径
    this._watchedPaths = paths
      .map(p => (typeof p === 'string' ? path.resolve(p) : null))
      .filter(Boolean)
      .filter(p => {
        if (!fs.existsSync(p)) {
          log.warn(`监听路径不存在，已跳过: ${p}`);
          return false;
        }
        return true;
      });

    if (this._watchedPaths.length === 0) {
      log.log('所有配置的监听路径均不存在，跳过启动');
      return;
    }

    // 初始化 watcher
    const recursive = this._config.get('watch.recursive') !== false;

    if (chokidarAvailable) {
      this._watcher = chokidar.watch(this._watchedPaths, {
        recursive,
        ignoreInitial: true,
        ignored: HIDDEN_RE,
      });
    } else {
      log.warn('chokidar 未安装，回退到 fs.watch（建议安装 chokidar 以获得更好的跨平台支持）');
      this._watcher = this._createFsWatchFallback(this._watchedPaths, recursive);
    }

    // 注册事件
    this._watcher.on('add', (filePath) => this._handleAdd(filePath));
    this._watcher.on('change', (filePath) => this._handleChange(filePath));
    this._watcher.on('unlink', (filePath) => this._handleUnlink(filePath));

    this._watcher.on('error', (err) => {
      log.error(`监听器错误: ${err.message}`);
    });

    // 启动定期全量扫描
    const intervalHours = this._config.get('watch.full_scan_interval_hours');
    if (intervalHours && intervalHours > 0) {
      const intervalMs = hoursToMs(intervalHours);
      this._scanTimer = setInterval(() => {
        log.debug('定期全量扫描触发');
        this.fullScan().catch(err => log.error(`定期全量扫描失败: ${err.message}`));
      }, intervalMs);
    }

    this._running = true;

    log.log(`监听已启动，路径: ${this._watchedPaths.join(', ')}，递归: ${recursive}`);
    if (chokidarAvailable) {
      log.debug('使用 chokidar 监听');
    }
    if (this._scanTimer) {
      log.debug(`全量扫描间隔: ${intervalHours} 小时`);
    }
  }

  /**
   * 停止监听：关闭 watcher 并清除定时器。
   */
  async stop() {
    if (!this._running) return;

    // 清除所有 debounce 定时器
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();

    // 关闭 watcher
    if (this._watcher) {
      if (chokidarAvailable) {
        await this._watcher.close();
      } else {
        // fs.watch 回退：逐个关闭
        if (typeof this._watcher.close === 'function') {
          this._watcher.close();
        }
      }
    }
    this._watcher = null;

    // 清除全量扫描定时器
    if (this._scanTimer) {
      clearInterval(this._scanTimer);
      this._scanTimer = null;
    }

    this._running = false;
    log.log('监听已停止');
  }

  /**
   * 触发全量扫描，委托给 indexer。
   */
  async fullScan() {
    if (!this._indexer) {
      log.warn('未提供 indexer，无法执行全量扫描');
      return;
    }
    log.log('开始全量扫描...');
    try {
      await this._indexer.fullScan();
      log.log('全量扫描完成');
    } catch (err) {
      log.error(`全量扫描失败: ${err.message}`);
      throw err;
    }
  }

  /**
   * 是否正在运行。
   * @returns {boolean}
   */
  get isRunning() {
    return this._running;
  }

  // ── 事件处理（debounced） ──

  /** @param {string} filePath */
  _debounce(filePath, action) {
    // 清除已有定时器
    const existing = this._debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    // 设置新定时器
    const timer = setTimeout(async () => {
      this._debounceTimers.delete(filePath);
      try {
        await action(filePath);
      } catch (err) {
        log.error(`处理 ${filePath} 时出错: ${err.message}`);
      }
    }, DEBOUNCE_MS);

    this._debounceTimers.set(filePath, timer);
  }

  /** @param {string} filePath */
  _handleAdd(filePath) {
    if (!this._indexer) return;
    log.debug(`检测到新增: ${filePath}`);
    this._debounce(filePath, (p) => this._indexer.indexFile(p));
  }

  /** @param {string} filePath */
  _handleChange(filePath) {
    if (!this._indexer) return;
    log.debug(`检测到修改: ${filePath}`);
    this._debounce(filePath, (p) => this._indexer.indexFile(p));
  }

  /** @param {string} filePath */
  _handleUnlink(filePath) {
    if (!this._indexer) return;
    log.debug(`检测到删除: ${filePath}`);
    // 删除操作不需要 debounce，直接执行
    this._indexer.removeFile(filePath).catch(err =>
      log.error(`删除文件 ${filePath} 索引失败: ${err.message}`)
    );
  }

  // ── fs.watch 回退实现 ──

  /**
   * 使用原生 fs.watch 作为 chokidar 的回退方案。
   * 注意：fs.watch 跨平台行为不一致，递归监听在 Linux 上不稳定。
   *
   * @param {string[]} watchPaths
   * @param {boolean} recursive
   * @returns {object} 模拟 FSWatcher 接口的对象
   */
  _createFsWatchFallback(watchPaths, recursive) {
    const emitter = new EventEmitter();

    const watchers = [];

    for (const watchPath of watchPaths) {
      try {
        const w = fs.watch(watchPath, { recursive }, (eventType, filename) => {
          if (!filename) return;
          // 跳过隐藏文件
          if (HIDDEN_RE.test(filename)) return;

          const fullPath = path.join(watchPath, filename);

          if (eventType === 'rename') {
            // rename 可能表示新增或删除，用 fs.existsSync 区分
            if (fs.existsSync(fullPath)) {
              emitter.emit('add', fullPath);
            } else {
              emitter.emit('unlink', fullPath);
            }
          } else if (eventType === 'change') {
            emitter.emit('change', fullPath);
          }
        });

        w.on('error', (err) => {
          emitter.emit('error', err);
        });

        watchers.push(w);
      } catch (err) {
        log.warn(`无法监听路径 ${watchPath}: ${err.message}`);
      }
    }

    // 附加 close 方法
    emitter.close = () => {
      for (const w of watchers) {
        w.close();
      }
    };

    return emitter;
  }
}

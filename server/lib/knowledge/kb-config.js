/**
 * kb-config.js — 知识库配置加载器
 *
 * 从 ~/.ai-desktop-pet/knowledge-base/config.yaml 加载配置，
 * 若文件不存在则使用内置默认值创建。支持 dot-path 取值。
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('kb-config');

// ── 默认配置 ──
const DEFAULTS = {
  data_root: '~/.ai-desktop-pet/knowledge-base',
  watch: {
    paths: [],
    recursive: true,
    extensions: ['.md', '.txt', '.pdf', '.html'],
    full_scan_interval_hours: 24,
    max_file_size_mb: 50,
    ignore_hidden: true
  },
  retrieval: {
    fusion_method: 'rrf',
    rrf_k: 60,
    top_k: 10,
    rerank: false,
    cache_ttl_seconds: 3600
  },
  chunking: {
    max_tokens: 512,
    overlap_tokens: 64
  },
  vector: {
    threshold: 5000,
    upgrade_strategy: 'hnswlib'
  },
  extraction: {
    auto_from_docs: false,
    auto_from_conversation: true,
    min_confidence_for_storage: 0.5
  },
  growth: {
    reflection_min_conversations: 5,
    reflection_interval_minutes: 10,
    curiosity_max_gaps_per_turn: 1,
    max_pending_gaps: 20,
    auto_search: false
  }
};

// ── 工具 ──

/**
 * 展开路径中的 ~ 为用户主目录
 * @param {string} p — 可能包含 ~ 的路径
 * @returns {string}
 */
function expandTilde(p) {
  if (typeof p !== 'string' || !p.startsWith('~')) return p;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return p;
  return p.replace(/^~/, home);
}

/**
 * 获取配置文件路径
 */
function _configFilePath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = path.join(home, '.ai-desktop-pet', 'knowledge-base');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'config.yaml');
}

/**
 * 深层遍历对象，展开所有以 ~ 开头的字符串值
 * @param {any} obj
 * @returns {any}
 */
function expandAllTildes(obj) {
  if (typeof obj === 'string') return expandTilde(obj);
  if (Array.isArray(obj)) return obj.map(expandAllTildes);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const key of Object.keys(obj)) {
      result[key] = expandAllTildes(obj[key]);
    }
    return result;
  }
  return obj;
}

// ── 主类 ──

export class KBConfig {
  /**
   * 加载配置，不存在则用默认值初始化。
   */
  constructor() {
    this._config = null;
    this.load();
  }

  /**
   * 加载/重载配置。优先从文件读，文件不存在则写默认值并沿用。
   */
  load() {
    const filePath = _configFilePath();

    if (!fs.existsSync(filePath)) {
      log.log('配置文件不存在，使用默认值创建');
      this._config = { ...DEFAULTS };
      try {
        fs.writeFileSync(filePath, yaml.dump(DEFAULTS, { lineWidth: -1, noRefs: true }), 'utf-8');
        log.log(`默认配置已写入: ${filePath}`);
      } catch (err) {
        log.warn(`写入默认配置文件失败: ${err.message}`);
      }
      return;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const loaded = yaml.load(raw);

      if (!loaded || typeof loaded !== 'object') {
        log.warn('配置文件内容无效，回退到默认值');
        this._config = { ...DEFAULTS };
        return;
      }

      // 深度合并：以加载值覆盖默认值（缺失的键保留默认值）
      this._config = deepMerge({ ...DEFAULTS }, loaded);
      log.debug(`配置已加载: ${filePath}`);
    } catch (err) {
      log.warn(`加载配置文件失败: ${err.message}，回退到默认值`);
      this._config = { ...DEFAULTS };
    }
  }

  /**
   * 获取配置值。不传 key 返回全部配置（已展开 ~）。
   * 传 key 支持 dot-path 取值，如 'watch.paths'。
   *
   * @param {string} [key] — 可选的 dot-path 键
   * @returns {any}
   */
  get(key) {
    const expanded = expandAllTildes(this._config);

    if (key === undefined || key === null) {
      return expanded;
    }

    const parts = key.split('.');
    let current = expanded;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  }

  /**
   * 设置配置值（dot-path），写入内存。
   * @param {string} key — 如 'watch.paths'
   * @param {*} value
   */
  set(key, value) {
    const parts = key.split('.');
    let current = this._config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
    log.log(`配置已更新: ${key} = ${JSON.stringify(value)}`);
  }

  /**
   * 持久化当前内存配置到磁盘 YAML 文件。
   */
  save() {
    const filePath = _configFilePath();
    try {
      fs.writeFileSync(filePath, yaml.dump(this._config, { lineWidth: -1, noRefs: true }), 'utf-8');
      log.log('配置已持久化');
      return true;
    } catch (err) {
      log.warn(`配置保存失败: ${err.message}`);
      return false;
    }
  }
}

// ── 深度合并 ──

/**
 * 将 source 深度合并到 target（纯数据，不处理数组）。
 * 返回新对象，不修改 target。
 *
 * @param {object} target — 默认值对象
 * @param {object} source — 用户配置（覆盖项）
 * @returns {object}
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (key in result && isPlainObject(result[key]) && isPlainObject(source[key])) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * 判断是否为纯对象（非 null、非数组、非 Date）
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

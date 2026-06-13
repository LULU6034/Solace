/**
 * kb-cache.js — 语义查询缓存
 *
 * 基于 SQLite query_cache 表提供查询结果的去重缓存，
 * 支持 TTL 过期、命中计数和缓存清理。
 */
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('kb-cache');

export class KBCache {
  /**
   * @param {import('./kb-schema.js').KBSchema} schema — 已初始化的 KBSchema 实例
   */
  constructor(schema) {
    this._schema = schema;
  }

  // ── 工具方法 ──

  /**
   * 查询规范化：小写 → 压缩连续空白为单空格 → 去首尾空白
   * @param {string} query
   * @returns {string}
   */
  _normalize(query) {
    return query.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * 简单哈希（仅用于去重，非加密用途）
   * @param {string} str
   * @returns {string} 36 进制哈希字符串
   */
  _hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  // ── 公共接口 ──

  /**
   * 获取缓存结果。
   * 命中且未过期则更新统计并返回结果；过期则删除行并返回 null。
   *
   * @param {string} query — 原始查询文本
   * @returns {any|null} 缓存的结果（已 JSON.parse），未命中/已过期/损坏则返回 null
   */
  get(query) {
    const normalized = this._normalize(query);
    const hash = this._hash(normalized);
    const db = this._schema.db;

    const stmt = db.prepare(
      'SELECT result_json, last_hit_at, ttl_seconds FROM query_cache WHERE query_hash = ?'
    );
    stmt.bind([hash]);
    const row = stmt.getAsObject();
    stmt.free();

    if (!row || !row.result_json) return null;

    const nowSeconds = Math.floor(Date.now() / 1000);

    // 检查是否过期：last_hit_at + ttl_seconds <= nowSeconds 表示已过期
    if (nowSeconds > row.last_hit_at + row.ttl_seconds) {
      db.run('DELETE FROM query_cache WHERE query_hash = ?', [hash]);
      log.debug(`缓存过期已删除: "${normalized}"`);
      return null;
    }

    // 命中：更新命中计数和时间戳
    db.run(
      'UPDATE query_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE query_hash = ?',
      [nowSeconds, hash]
    );
    log.debug(`缓存命中: "${normalized}"`);

    try {
      return JSON.parse(row.result_json);
    } catch (e) {
      log.warn(`缓存 JSON 解析失败: ${e.message}`);
      db.run('DELETE FROM query_cache WHERE query_hash = ?', [hash]);
      return null;
    }
  }

  /**
   * 写入缓存。
   * 若同一规范化查询已存在则覆盖（INSERT OR REPLACE）。
   *
   * @param {string} query      — 原始查询文本
   * @param {any}    results    — 要缓存的结果（将被 JSON.stringify）
   * @param {number} ttlSeconds — 存活秒数，默认 3600（1 小时）
   */
  set(query, results, ttlSeconds = 3600) {
    const normalized = this._normalize(query);
    const hash = this._hash(normalized);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const db = this._schema.db;

    db.run(
      `INSERT OR REPLACE INTO query_cache
         (id, query_hash, query_text, result_json, hit_count, created_at, last_hit_at, ttl_seconds)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        `${hash}_${Date.now().toString(36)}`,  // id
        hash,                                   // query_hash
        query,                                  // query_text（原始文本）
        JSON.stringify(results),                // result_json
        nowSeconds,                             // created_at
        nowSeconds,                             // last_hit_at
        ttlSeconds,                             // ttl_seconds
      ]
    );
    log.debug(`缓存已写入: "${normalized}" (TTL: ${ttlSeconds}s)`);
  }

  /**
   * 使单条查询的缓存失效。
   * @param {string} query — 原始查询文本
   */
  invalidate(query) {
    const normalized = this._normalize(query);
    const hash = this._hash(normalized);

    this._schema.db.run('DELETE FROM query_cache WHERE query_hash = ?', [hash]);
    log.debug(`缓存已失效: "${normalized}"`);
  }

  /**
   * 清空全部缓存。
   */
  clear() {
    this._schema.db.run('DELETE FROM query_cache');
    log.log('全部缓存已清空');
  }

  /**
   * 清理所有已过期的缓存条目。
   */
  cleanup() {
    const nowSeconds = Math.floor(Date.now() / 1000);

    this._schema.db.run(
      'DELETE FROM query_cache WHERE last_hit_at + ttl_seconds < ?',
      [nowSeconds]
    );
    log.debug('过期缓存清理完成');
  }
}

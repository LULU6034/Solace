/**
 * fact-store.js — 元事实存储（SQLite FTS5 + 标签）
 *
 * 参考 OpenHanako 的 fact-store.js:
 *   - 每条记忆是一个"元事实"，附带标签和时间
 *   - FTS5 全文搜索 + 标签精确匹配
 *   - 不使用 embedding/向量/score/decay
 *
 * Schema:
 *   facts: id, fact, tags (JSON array), created_at, session_id
 *   facts_fts: FTS5 virtual table over facts.fact
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('fact-store');

const SCHEMA_VERSION = 1;

export class FactStore {
  constructor(persistDir) {
    this.persistDir = persistDir;
    fs.mkdirSync(persistDir, { recursive: true });
    this.dbPath = path.join(persistDir, 'facts.db');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._migrate();
  }

  _migrate() {
    const version = this.db.pragma('user_version', { simple: true });

    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS facts (
          id TEXT PRIMARY KEY,
          fact TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          session_id TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
          fact, content='facts', content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
          INSERT INTO facts_fts(rowid, fact) VALUES (new.rowid, new.fact);
        END;
        CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES('delete', old.rowid, old.fact);
        END;
        CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, fact) VALUES('delete', old.rowid, old.fact);
          INSERT INTO facts_fts(rowid, fact) VALUES (new.rowid, new.fact);
        END;
      `);
      this.db.pragma('user_version = 1');
    }
  }

  /**
   * Add a single fact
   * @param {{ fact: string, tags?: string[], time?: string, session_id?: string }} entry
   * @returns {number} new count
   */
  add(entry) {
    const id = _mkId(entry.fact);
    const tags = JSON.stringify(entry.tags || []);
    const createdAt = entry.time ? new Date(entry.time).getTime() : Date.now();

    // Upsert: if same fact text exists, update tags and time
    const existing = this.db.prepare('SELECT id FROM facts WHERE fact = ?').get(entry.fact);
    if (existing) {
      this.db.prepare('UPDATE facts SET tags = ?, created_at = ? WHERE id = ?')
        .run(tags, createdAt, existing.id);
    } else {
      this.db.prepare('INSERT INTO facts (id, fact, tags, created_at, session_id) VALUES (?, ?, ?, ?, ?)')
        .run(id, entry.fact, tags, createdAt, entry.session_id || null);
    }
    return this.count();
  }

  /**
   * Add batch of facts
   */
  addBatch(entries) {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO facts (id, fact, tags, created_at, session_id) VALUES (?, ?, ?, ?, ?)'
    );
    const tx = this.db.transaction(() => {
      for (const e of entries) {
        insert.run(
          _mkId(e.fact),
          e.fact,
          JSON.stringify(e.tags || []),
          e.time ? new Date(e.time).getTime() : Date.now(),
          e.session_id || null,
        );
      }
    });
    tx();
    return this.count();
  }

  /**
   * Search facts
   * - If query contains #tags, do tag exact match first
   * - Then do FTS5 full-text search
   * @param {string} query
   * @param {number} k
   * @returns {Array<{ fact: string, tags: string[], created_at: number }>}
   */
  search(query, k = 5) {
    const normalized = String(query || '').trim();
    if (!normalized || this.count() === 0) return [];

    // Extract #tags from query
    const tagRe = /#(\S+)/g;
    const tags = [];
    let m;
    while ((m = tagRe.exec(normalized)) !== null) {
      tags.push(m[1]);
    }
    const searchText = normalized.replace(tagRe, '').trim();

    let results = [];

    if (tags.length > 0) {
      // Tag match: find facts whose tags JSON contains all requested tags
      let tagSql = 'SELECT fact, tags, created_at FROM facts WHERE ';
      const tagConditions = tags.map(() => `tags LIKE ?`);
      tagSql += tagConditions.join(' AND ');
      tagSql += ' ORDER BY created_at DESC LIMIT ?';

      const tagParams = tags.map(t => `%"${t}"%`);
      tagParams.push(k);
      results = this.db.prepare(tagSql).all(...tagParams);
    }

    if (results.length < k && searchText) {
      // FTS5 full-text search to fill remaining
      try {
        const existingIds = new Set(results.map(r => r.fact));
        const ftsRows = this.db.prepare(
          'SELECT f.fact, f.tags, f.created_at FROM facts f ' +
          'JOIN facts_fts fts ON f.rowid = fts.rowid ' +
          'WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?'
        ).all(searchText.replace(/[^\w一-鿿]/g, ' ').split(/\s+/).filter(Boolean).join(' OR '), k);

        for (const row of ftsRows) {
          if (!existingIds.has(row.fact)) {
            results.push(row);
          }
        }
      } catch {
        // FTS5 query syntax error — fall back to LIKE
        const likeRows = this.db.prepare(
          'SELECT fact, tags, created_at FROM facts WHERE fact LIKE ? ORDER BY created_at DESC LIMIT ?'
        ).all(`%${searchText}%`, k - results.length);
        for (const row of likeRows) {
          if (!results.find(r => r.fact === row.fact)) {
            results.push(row);
          }
        }
      }
    }

    // If no results, return most recent
    if (results.length === 0 && (tags.length > 0 || searchText)) {
      results = this.db.prepare(
        'SELECT fact, tags, created_at FROM facts ORDER BY created_at DESC LIMIT ?'
      ).all(k);
    }

    return results.map(r => ({
      fact: r.fact,
      tags: _safeJsonParse(r.tags) || [],
      created_at: r.created_at,
    }));
  }

  /**
   * Get facts since a time
   */
  getSince(timestamp, limit = 100) {
    return this.db.prepare(
      'SELECT fact, tags, created_at FROM facts WHERE created_at > ? ORDER BY created_at DESC LIMIT ?'
    ).all(timestamp, limit).map(r => ({
      fact: r.fact,
      tags: _safeJsonParse(r.tags) || [],
      created_at: r.created_at,
    }));
  }

  count() {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM facts').get();
    return row?.c || 0;
  }

  clear() {
    this.db.prepare('DELETE FROM facts').run();
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

// ── Helpers ──
function _mkId(fact) {
  let hash = 0;
  for (let i = 0; i < fact.length; i++) {
    const ch = fact.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return `f_${Math.abs(hash).toString(36)}_${fact.length}`;
}

function _safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

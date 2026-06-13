/**
 * fact-store.js — 元事实存储（sql.js WASM，无需原生编译）
 *
 * SQLite via sql.js (纯 JS/WASM，零原生依赖)。
 * 替代 better-sqlite3，避免 node-gyp 编译问题。
 *
 * Schema: facts(id, fact, tags(JSON), created_at, session_id, user_id, confidence, half_life_days, deleted_at)
 * 搜索: LIKE + 标签匹配（sql.js 不支持 FTS5）
 * 回收站: deleted_at 非空 = 软删除，7天后物理清除
 * 多用户: user_id 隔离
 */
import path from 'node:path';
import fs from 'node:fs';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('fact-store');

let _SQL = null; // cached sql.js instance

async function _getSQL() {
  if (!_SQL) {
    const initSqlJs = (await import('sql.js')).default;
    _SQL = await initSqlJs();
  }
  return _SQL;
}

export class FactStore {
  constructor(persistDir, userId = 'default') {
    this.persistDir = persistDir;
    this.userId = userId;
    this.dbPath = path.join(persistDir, `facts_${userId}.db`);
    this.db = null;
    this._ready = false;
    // Init is async — call init() before use
  }

  async init() {
    if (this._ready) return;
    fs.mkdirSync(this.persistDir, { recursive: true });
    const SQL = await _getSQL();

    // 兼容旧版数据库: facts.db → facts_default.db
    const legacyPath = path.join(this.persistDir, 'facts.db');
    if (fs.existsSync(legacyPath) && legacyPath !== this.dbPath) {
      const legacyBuf = fs.readFileSync(legacyPath);
      const legacyDb = new SQL.Database(legacyBuf);
      let legacyCount = 0;
      try {
        legacyCount = legacyDb.exec('SELECT COUNT(*) as n FROM facts WHERE deleted_at IS NULL')[0]?.values?.[0]?.[0] || 0;
      } catch { /* 旧表可能没有 deleted_at 列 */ }
      if (legacyCount === 0) {
        try { legacyCount = legacyDb.exec('SELECT COUNT(*) as n FROM facts')[0]?.values?.[0]?.[0] || 0; } catch {}
      }

      // 检查新版数据库是否为空
      let newCount = 0;
      if (fs.existsSync(this.dbPath)) {
        const newDb = new SQL.Database(fs.readFileSync(this.dbPath));
        newCount = newDb.exec('SELECT COUNT(*) as n FROM facts WHERE deleted_at IS NULL')[0]?.values?.[0]?.[0] || 0;
        newDb.close();
      }

      if (legacyCount > 0 && newCount === 0) {
        // 旧库有数据，新库为空 → 迁移
        const exported = legacyDb.export();
        fs.writeFileSync(this.dbPath, Buffer.from(exported));
        fs.renameSync(legacyPath, legacyPath + '.migrated');
        log.log(`已迁移记忆: ${legacyCount} 条事实 (facts.db → facts_${this.userId}.db)`);
      }
      legacyDb.close();
    }

    if (fs.existsSync(this.dbPath)) {
      const buf = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buf);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run('PRAGMA journal_mode = MEMORY');
    this.db.run('PRAGMA synchronous = OFF');
    this._migrate();
    // 验证 schema 完整性
    try {
      const cols = this.db.exec('PRAGMA table_info(facts)');
      const names = cols[0]?.values?.map(r => r[1]) || [];
      if (!names.includes('deleted_at')) {
        log.warn(`Schema 缺少 deleted_at 列，强制重建。当前列: ${names.join(',')}`);
        this.db.run('DROP TABLE IF EXISTS facts');
        this._migrate();
      }
    } catch {}
    this._cleanRecycleBin();
    this._ready = true;
  }

  _migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        fact TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        session_id TEXT,
        user_id TEXT DEFAULT 'default',
        confidence REAL DEFAULT 0.5,
        half_life_days INTEGER DEFAULT 90,
        deleted_at INTEGER DEFAULT NULL
      )
    `);
    // 兼容旧表结构: 添加缺失列（逐列检测，避免重复添加报错）
    const existingCols = new Set();
    try {
      const cols = this.db.exec('PRAGMA table_info(facts)');
      if (cols[0]?.values) {
        for (const row of cols[0].values) existingCols.add(row[1]); // column name is index 1
      }
    } catch {}
    const addCol = (name, type) => {
      if (!existingCols.has(name)) {
        try { this.db.run(`ALTER TABLE facts ADD COLUMN ${name} ${type} DEFAULT NULL`); } catch {}
      }
    };
    addCol('user_id', 'TEXT');
    addCol('confidence', 'REAL');
    addCol('half_life_days', 'INTEGER');
    addCol('deleted_at', 'INTEGER');
    // Create index for fast LIKE search
    this.db.run('CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_facts_user ON facts(user_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_facts_deleted ON facts(deleted_at)');
  }

  /** Persist to disk */
  _save() {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
    } catch (e) {
      log.warn(`保存失败: ${e.message}`);
    }
  }

  addFact(text, tags = [], metadata = {}) {
    return this.add({ fact: text, tags, ...metadata });
  }

  add(entry) {
    if (!this._ready) throw new Error('FactStore not initialized — call init() first');
    const id = _mkId(entry.fact);
    const tags = JSON.stringify(entry.tags || []);
    const createdAt = entry.time ? new Date(entry.time).getTime() : Date.now();
    const confidence = entry.confidence ?? 0.5;
    const halfLifeDays = entry.half_life_days ?? (confidence > 0.8 ? 365 : confidence > 0.5 ? 90 : 30);
    const uid = entry.user_id || this.userId;

    const existing = this._queryOne(
      'SELECT id, deleted_at FROM facts WHERE fact = ? AND user_id = ? AND deleted_at IS NULL',
      [entry.fact, uid]
    );
    if (existing) {
      this.db.run(
        'UPDATE facts SET tags = ?, created_at = ?, confidence = ?, half_life_days = ? WHERE id = ?',
        [tags, createdAt, confidence, halfLifeDays, existing.id]
      );
    } else {
      this.db.run(
        'INSERT INTO facts (id, fact, tags, created_at, session_id, user_id, confidence, half_life_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, entry.fact, tags, createdAt, entry.session_id || null, uid, confidence, halfLifeDays]
      );
    }
    this._save();
    return this.count();
  }

  addBatch(entries) {
    if (!this._ready) throw new Error('FactStore not initialized');
    const uid = this.userId;
    for (const e of entries) {
      const id = _mkId(e.fact);
      const tags = JSON.stringify(e.tags || []);
      const createdAt = e.time ? new Date(e.time).getTime() : Date.now();
      const confidence = e.confidence ?? 0.5;
      const halfLifeDays = e.half_life_days ?? 90;
      this.db.run(
        'INSERT OR REPLACE INTO facts (id, fact, tags, created_at, session_id, user_id, confidence, half_life_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, e.fact, tags, createdAt, e.session_id || null, uid, confidence, halfLifeDays]
      );
    }
    this._save();
    return this.count();
  }

  search(query, k = 5) {
    if (!this._ready) return [];
    const normalized = String(query || '').trim();
    if (!normalized || this.count() === 0) return [];

    const uid = this.userId;
    const tagRe = /#(\S+)/g;
    const tags = [];
    let m;
    while ((m = tagRe.exec(normalized)) !== null) tags.push(m[1]);
    const searchText = normalized.replace(tagRe, '').trim();

    let results = [];
    const baseWhere = 'deleted_at IS NULL AND user_id = ?';

    if (tags.length > 0) {
      const conds = tags.map(() => `tags LIKE ?`).join(' AND ');
      const params = [uid, ...tags.map(t => `%"${t}"%`), k];
      results = this._queryAll(
        `SELECT fact, tags, created_at, confidence, half_life_days FROM facts WHERE ${baseWhere} AND (${conds}) ORDER BY created_at DESC LIMIT ?`,
        params
      );
    }

    if (results.length < k && searchText) {
      const existingIds = new Set(results.map(r => r.fact));
      const likeResults = this._queryAll(
        `SELECT fact, tags, created_at, confidence, half_life_days FROM facts WHERE ${baseWhere} AND fact LIKE ? ORDER BY created_at DESC LIMIT ?`,
        [uid, `%${searchText}%`, k - results.length]
      );
      for (const row of likeResults) {
        if (!existingIds.has(row.fact)) results.push(row);
      }
    }

    return results.map(r => ({
      fact: r.fact,
      tags: _safeJsonParse(r.tags) || [],
      created_at: r.created_at,
      confidence: r.confidence ?? 0.5,
      half_life_days: r.half_life_days ?? 90,
    }));
  }

  getAll() {
    if (!this._ready) return [];
    const uid = this.userId;
    return this._queryAll(
      'SELECT fact, tags, created_at, confidence, half_life_days FROM facts WHERE deleted_at IS NULL AND user_id = ? ORDER BY created_at DESC LIMIT 100',
      [uid]
    ).map(r => ({
      fact: r.fact,
      tags: _safeJsonParse(r.tags) || [],
      created_at: r.created_at,
      confidence: r.confidence ?? 0.5,
      half_life_days: r.half_life_days ?? 90,
    }));
  }

  // ── 回收站 (P2) ──
  /** 软删除 (移入回收站) */
  softDelete(factText) {
    if (!this._ready) return false;
    const uid = this.userId;
    const existing = this._queryOne(
      'SELECT id FROM facts WHERE fact = ? AND user_id = ? AND deleted_at IS NULL',
      [factText, uid]
    );
    if (!existing) return false;
    this.db.run('UPDATE facts SET deleted_at = ? WHERE id = ?', [Date.now(), existing.id]);
    this._save();
    log.log(`回收站: "${factText.slice(0, 40)}" (7天后清除)`);
    return true;
  }

  /** 从回收站恢复 */
  restoreFromBin(factText) {
    if (!this._ready) return false;
    const uid = this.userId;
    const existing = this._queryOne(
      'SELECT id FROM facts WHERE fact = ? AND user_id = ? AND deleted_at IS NOT NULL',
      [factText, uid]
    );
    if (!existing) return false;
    this.db.run('UPDATE facts SET deleted_at = NULL WHERE id = ?', [existing.id]);
    this._save();
    return true;
  }

  /** 列出回收站内容 */
  listRecycleBin() {
    if (!this._ready) return [];
    const uid = this.userId;
    return this._queryAll(
      'SELECT fact, tags, created_at, deleted_at, confidence FROM facts WHERE deleted_at IS NOT NULL AND user_id = ? ORDER BY deleted_at DESC LIMIT 50',
      [uid]
    ).map(r => ({
      fact: r.fact,
      tags: _safeJsonParse(r.tags) || [],
      created_at: r.created_at,
      deleted_at: r.deleted_at,
      days_left: Math.max(0, 7 - Math.floor((Date.now() - r.deleted_at) / 86400000)),
    }));
  }

  /** 清理超过 7 天的回收站条目 */
  _cleanRecycleBin() {
    if (!this._ready) return;
    const cutoff = Date.now() - 7 * 86400000;
    const result = this.db.run('DELETE FROM facts WHERE deleted_at IS NOT NULL AND deleted_at < ?', [cutoff]);
    if (result) this._save();
  }

  delete(id) {
    if (!this._ready) return;
    // 硬删除（跳过回收站，用于用户主动清空）
    this.db.run('DELETE FROM facts WHERE id = ?', [id]);
    this._save();
  }

  /** 衰减检查：删除半衰期已过的低置信度事实（移入回收站） */
  decayCheck() {
    if (!this._ready) return 0;
    const now = Date.now();
    const rows = this._queryAll(
      'SELECT id, fact, created_at, confidence, half_life_days FROM facts WHERE deleted_at IS NULL AND user_id = ?',
      [this.userId]
    );
    let decayed = 0;
    for (const row of rows) {
      const ageMs = now - row.created_at;
      const halfLifeMs = (row.half_life_days || 90) * 86400000;
      // 超过 2 个半衰期 + 低置信度 → 衰减
      if (ageMs > halfLifeMs * 2 && (row.confidence || 0.5) < 0.6) {
        this.db.run('UPDATE facts SET deleted_at = ? WHERE id = ?', [now, row.id]);
        decayed++;
      }
    }
    if (decayed > 0) { this._save(); log.log(`衰减: ${decayed} 条移入回收站`); }
    return decayed;
  }

  count() {
    if (!this._ready) return 0;
    const uid = this.userId;
    const r = this._queryOne('SELECT COUNT(*) as c FROM facts WHERE deleted_at IS NULL AND user_id = ?', [uid]);
    return r?.c || 0;
  }

  clear() {
    if (!this._ready) return;
    const uid = this.userId;
    this.db.run('DELETE FROM facts WHERE user_id = ?', [uid]);
    this._save();
  }

  close() {
    this.db?.close();
    this.db = null;
    this._ready = false;
  }

  // ── sql.js helpers ──

  _queryOne(sql, params = []) {
    try {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
      }
      stmt.free();
      return null;
    } catch (e) {
      log.warn(`SQL error: ${e.message}`);
      return null;
    }
  }

  _queryAll(sql, params = []) {
    try {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    } catch (e) {
      log.warn(`SQL error: ${e.message}`);
      return [];
    }
  }
}

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
  try { return JSON.parse(str); } catch { return null; }
}

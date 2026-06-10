/**
 * fact-store-enhanced.js — Enhanced FactStore (sql.js, 纯 JS)
 *
 * 在 FactStore 基础上添加置信度和衰减。
 * 简化版 — sql.js 不支持 FTS5，使用 LIKE 搜索。
 */
import { FactStore as _FactStore } from '../../lib/memory/fact-store.js';

export { _FactStore as FactStore };

export class FactStoreEnhanced extends _FactStore {
  constructor(persistDir) {
    super(persistDir);
  }

  async init() {
    await super.init();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS facts_meta (
        id TEXT PRIMARY KEY,
        confidence REAL NOT NULL DEFAULT 0.5,
        half_life_days INTEGER NOT NULL DEFAULT 30,
        source TEXT
      )
    `);
    this._save();
  }

  add(entry) {
    const result = super.add(entry);
    const id = _mkId(entry.fact);
    this.db.run(
      `INSERT OR REPLACE INTO facts_meta (id, confidence, half_life_days, source) VALUES (?, ?, ?, ?)`,
      [id, entry.confidence ?? 0.5, entry.half_life_days ?? (entry.confidence > 0.8 ? 365 : 90), entry.source ?? null]
    );
    this._save();
    return result;
  }

  /** 获取高重要性事实 (>= minConfidence) */
  getHighImportance(minConfidence = 0.7) {
    return this.getByConfidence(minConfidence);
  }

  /** 衰减所有事实置信度 */
  decayAll() {
    const all = this._queryAll(
      'SELECT m.id, m.confidence, m.half_life_days, f.created_at FROM facts_meta m JOIN facts f ON m.id = f.id'
    );
    let decayed = 0;
    for (const r of all) {
      const ageHours = ((Date.now() - (r.created_at || Date.now())) / 3600000);
      const halfLife = (r.half_life_days || 30) * 24;
      const newConf = parseFloat(((r.confidence || 0.5) * Math.pow(2, -ageHours / halfLife)).toFixed(4));
      if (newConf < 0.05) {
        this.db.run('DELETE FROM facts_meta WHERE id = ?', [r.id]);
        this.db.run('DELETE FROM facts WHERE id = ?', [r.id]);
        decayed++;
      } else if (Math.abs(newConf - (r.confidence || 0.5)) > 0.01) {
        this.db.run('UPDATE facts_meta SET confidence = ? WHERE id = ?', [newConf, r.id]);
        decayed++;
      }
    }
    if (decayed > 0) this._save();
    return decayed;
  }

  addBatch(entries) {
    const result = super.addBatch(entries);
    for (const e of entries) {
      this.db.run(
        `INSERT OR REPLACE INTO facts_meta (id, confidence, half_life_days, source) VALUES (?, ?, ?, ?)`,
        [_mkId(e.fact), e.confidence ?? 0.5, e.half_life_days ?? 30, e.source ?? null]
      );
    }
    this._save();
    return result;
  }

  updateConfidence(id, newConfidence) {
    this.db.run('UPDATE facts_meta SET confidence = ? WHERE id = ?',
      [Math.max(0, Math.min(1, newConfidence)), id]);
    this._save();
  }

  getByConfidence(minConfidence = 0.7) {
    return this._queryAll(
      `SELECT f.id, f.fact, f.tags, f.created_at, m.confidence, m.half_life_days, m.source
       FROM facts f JOIN facts_meta m ON f.id = m.id
       WHERE m.confidence >= ? ORDER BY m.confidence DESC`, [minConfidence]
    ).map(r => ({ ...r, tags: _safeJson(r.tags) || [] }));
  }

  decayCheck() {
    const now = Date.now();
    const all = this._queryAll(
      `SELECT f.id, f.fact, f.tags, f.created_at, m.confidence, m.half_life_days, m.source
       FROM facts f JOIN facts_meta m ON f.id = m.id WHERE m.confidence > 0`
    );
    const decayed = all.filter(r => (now - r.created_at) / 86400000 > r.half_life_days);
    for (const r of decayed) {
      this.db.run('UPDATE facts_meta SET confidence = ? WHERE id = ?',
        [Math.max(0, r.confidence * 0.5), r.id]);
    }
    if (decayed.length > 0) this._save();
    return decayed.map(r => ({ ...r, tags: _safeJson(r.tags) || [], action: 'confidence_halved' }));
  }
}

function _mkId(fact) {
  let hash = 0;
  for (let i = 0; i < fact.length; i++) { hash = ((hash << 5) - hash) + fact.charCodeAt(i); hash |= 0; }
  return `f_${Math.abs(hash).toString(36)}_${fact.length}`;
}

function _safeJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

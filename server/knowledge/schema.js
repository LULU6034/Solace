/**
 * kb-schema.js — SQLite 知识库 Schema 初始化器
 *
 * 使用 sql.js (纯 JS/WASM，零原生依赖) 管理知识库的 SQLite 存储。
 * 包含 8 张表和 9 个索引，覆盖文件索引、文档切片、实体、事实、
 * 关系边、知识缺口、反思日志和语义缓存。
 *
 * Schema 设计详见 docs/KNOWLEDGE-BASE-DESIGN.md
 */
import path from 'node:path';
import fs from 'node:fs';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('kb-schema');

// ── 数据库文件路径 ──
function _dbDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dir = path.join(home, '.ai-desktop-pet', 'knowledge-base');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DB_PATH = path.join(_dbDir(), 'kb.sqlite');

// ── ID 生成：简单时间戳 + 随机 hex ──
function _makeId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}_${rand}`;
}

// ── sql.js 实例缓存 ──
let _SQL = null;

async function _getSQL() {
  if (!_SQL) {
    const initSqlJs = (await import('sql.js')).default;
    _SQL = await initSqlJs();
  }
  return _SQL;
}

// ── Schema 定义 ──
const SCHEMA_SQL = `
  -- ═══════════════════════════════════════
  -- 文件索引
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    ext TEXT,
    hash TEXT,
    size_bytes INTEGER,
    last_modified INTEGER,
    last_indexed INTEGER,
    chunk_count INTEGER DEFAULT 0,
    access_count INTEGER DEFAULT 0,
    importance_score REAL DEFAULT 0.5,
    status TEXT DEFAULT 'active',
    metadata TEXT
  );

  -- ═══════════════════════════════════════
  -- 文档切片
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    file_id TEXT REFERENCES files(id),
    chunk_index INTEGER,
    content TEXT NOT NULL,
    token_count INTEGER,
    embedding_id TEXT,
    created_at INTEGER
  );

  -- ═══════════════════════════════════════
  -- 实体（归一化）
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT,
    aliases TEXT,
    description TEXT,
    first_seen_at INTEGER,
    doc_count INTEGER DEFAULT 0
  );

  -- ═══════════════════════════════════════
  -- 事实（知识三元组）
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    subject_id TEXT REFERENCES entities(id),
    predicate TEXT NOT NULL,
    object_id TEXT REFERENCES entities(id),
    object_value TEXT,
    confidence REAL DEFAULT 0.5,
    source_type TEXT,
    source_id TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    verified_by TEXT,
    status TEXT DEFAULT 'active',
    embedding_id TEXT
  );

  -- ═══════════════════════════════════════
  -- 关系边（图谱查询优化）
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    from_entity TEXT REFERENCES entities(id),
    to_entity TEXT REFERENCES entities(id),
    relation_type TEXT NOT NULL,
    fact_id TEXT REFERENCES facts(id),
    confidence REAL,
    weight REAL DEFAULT 1.0
  );

  -- ═══════════════════════════════════════
  -- 知识缺口（好奇心驱动）
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS gaps (
    id TEXT PRIMARY KEY,
    entity_name TEXT,
    missing_info TEXT,
    context TEXT,
    priority REAL DEFAULT 0.5,
    status TEXT DEFAULT 'open',
    created_at INTEGER,
    resolved_at INTEGER
  );

  -- ═══════════════════════════════════════
  -- 反思日志
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS reflections (
    id TEXT PRIMARY KEY,
    type TEXT,
    summary TEXT,
    detail TEXT,
    affected_facts TEXT,
    actions_taken TEXT,
    created_at INTEGER
  );

  -- ═══════════════════════════════════════
  -- 语义缓存
  -- ═══════════════════════════════════════
  CREATE TABLE IF NOT EXISTS query_cache (
    id TEXT PRIMARY KEY,
    query_hash TEXT UNIQUE,
    query_text TEXT,
    result_json TEXT,
    hit_count INTEGER DEFAULT 1,
    created_at INTEGER,
    last_hit_at INTEGER,
    ttl_seconds INTEGER DEFAULT 3600
  );
`;

const INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);',
  'CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject_id);',
  'CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object_id);',
  'CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);',
  'CREATE INDEX IF NOT EXISTS idx_facts_confidence ON facts(confidence);',
  'CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_entity);',
  'CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_entity);',
  'CREATE INDEX IF NOT EXISTS idx_gaps_status ON gaps(status);',
  'CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);',
  'CREATE INDEX IF NOT EXISTS idx_query_cache_hash ON query_cache(query_hash);',
];

// ── KBSchema 类 ──
export class KBSchema {
  constructor() {
    this._db = null;
    this._ready = false;
  }

  /**
   * 初始化：打开或创建数据库，建表建索引。
   * 幂等调用——多次调用不会重复初始化。
   */
  async init() {
    if (this._ready) return;

    log.log('初始化知识库 Schema...');

    const SQL = await _getSQL();

    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      this._db = new SQL.Database(buf);
      log.log(`已打开现有数据库: ${DB_PATH}`);
    } else {
      this._db = new SQL.Database();
      log.log(`已创建新数据库: ${DB_PATH}`);
    }

    // 性能优化 pragma
    this._db.run('PRAGMA journal_mode = MEMORY');
    this._db.run('PRAGMA synchronous = OFF');
    this._db.run('PRAGMA foreign_keys = ON');

    // 建表
    this._db.run(SCHEMA_SQL);
    log.log('表结构已就绪（8 张表）');

    // 建索引
    for (const idx of INDEX_SQL) {
      this._db.run(idx);
    }
    log.log(`索引已就绪（${INDEX_SQL.length} 个）`);

    this._save();
    this._ready = true;
    log.log('知识库 Schema 初始化完成');
  }

  /** 返回 sql.js Database 实例 */
  get db() {
    if (!this._ready) throw new Error('KBSchema 尚未初始化——请先调用 init()');
    return this._db;
  }

  /** 导出并写入磁盘 */
  save() {
    if (!this._db) return;
    try {
      const data = this._db.export();
      const buf = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buf);
    } catch (e) {
      log.warn(`保存数据库失败: ${e.message}`);
    }
  }

  /** 关闭数据库并保存 */
  async close() {
    if (!this._db) return;
    try {
      this._save();
      this._db.close();
      this._db = null;
      this._ready = false;
      log.log('数据库已关闭');
    } catch (e) {
      log.warn(`关闭数据库时出错: ${e.message}`);
    }
  }

  // ── 内部方法 ──
  _save() {
    this.save();
  }

  // ── 工具方法：生成 ID ──
  static makeId() {
    return _makeId();
  }
}

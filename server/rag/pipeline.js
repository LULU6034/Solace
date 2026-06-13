/**
 * pipeline.js — RAG 文档索引与检索 (sql.js, 纯 JS)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('rag');

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;

let _SQL = null;
async function _getSQL() {
  if (!_SQL) {
    const initSqlJs = (await import('sql.js')).default;
    _SQL = await initSqlJs();
  }
  return _SQL;
}

function splitText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  const separators = ['\n\n', '\n', '。', '.', ' ', ''];
  if (text.length <= chunkSize) return [text];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= chunkSize) { chunks.push(remaining); break; }
    let splitAt = chunkSize;
    for (const sep of separators) {
      const idx = remaining.lastIndexOf(sep, chunkSize);
      if (idx > chunkSize * 0.5) { splitAt = idx + sep.length; break; }
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(Math.max(0, splitAt - overlap));
  }
  return chunks.filter(c => c);
}

export class RAGPipeline {
  constructor(persistDir) {
    this.persistDir = persistDir;
    this.dbPath = path.join(persistDir, 'rag.db');
    this.db = null;
    this._ready = false;
    this._init();
  }

  async _init() {
    fs.mkdirSync(this.persistDir, { recursive: true });
    const SQL = await _getSQL();
    if (fs.existsSync(this.dbPath)) {
      this.db = new SQL.Database(fs.readFileSync(this.dbPath));
    } else {
      this.db = new SQL.Database();
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL,
        name TEXT NOT NULL, chunk_index INTEGER NOT NULL, created_at INTEGER NOT NULL
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_docs_name ON documents(name)');
    this._ready = true;
  }

  async ready() { while (!this._ready) await new Promise(r => setTimeout(r, 10)); return this; }

  _save() {
    try { fs.writeFileSync(this.dbPath, Buffer.from(this.db.export())); } catch {}
  }

  _extractText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
      try {
        const buf = fs.readFileSync(filePath);
        const text = buf.toString('latin1');
        return text.replace(/[^\x20-\x7E一-鿿　-〿＄-￯\n\r\t]/g, ' ').slice(0, 50_000);
      } catch (err) { return `[PDF 解析失败: ${err.message}]`; }
    }
    try { return fs.readFileSync(filePath, 'utf-8'); }
    catch (err) { return `[文件读取失败: ${err.message}]`; }
  }

  indexFile(filePath) {
    if (!this._ready) return 0;
    const text = this._extractText(filePath);
    if (text.startsWith('[')) return 0;
    const fileName = path.basename(filePath);
    const chunks = splitText(text);
    if (chunks.length === 0) return 0;

    this.db.run('DELETE FROM documents WHERE name = ?', [fileName]);
    const stmt = this.db.prepare(
      'INSERT INTO documents (id, content, source, name, chunk_index, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < chunks.length; i++) {
      stmt.bind([`${fileName}_${i}`, chunks[i], filePath, fileName, i, Date.now()]);
      stmt.step(); stmt.reset();
    }
    stmt.free();
    this._save();
    log.log(`索引完成: ${fileName} (${chunks.length} 块)`);
    return chunks.length;
  }

  search(query, k = 5) {
    if (!this._ready || !query?.trim() || this.count() === 0) return [];
    const q = `%${String(query).trim()}%`;
    try {
      const stmt = this.db.prepare(
        'SELECT content, source, name FROM documents WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?'
      );
      stmt.bind([q, k]);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows.map(r => ({ content: r.content, source: r.name, fileName: r.name }));
    } catch { return []; }
  }

  getIndexedFiles() {
    if (!this._ready) return [];
    try {
      const stmt = this.db.prepare('SELECT DISTINCT name, source, created_at FROM documents ORDER BY created_at DESC');
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    } catch { return []; }
  }

  removeFile(fileName) {
    if (!this._ready) return;
    this.db.run('DELETE FROM documents WHERE name = ?', [fileName]);
    this._save();
  }

  count() {
    if (!this._ready) return 0;
    try {
      const stmt = this.db.prepare('SELECT COUNT(*) as c FROM documents');
      stmt.step(); const r = stmt.getAsObject(); stmt.free();
      return r?.c || 0;
    } catch { return 0; }
  }
}

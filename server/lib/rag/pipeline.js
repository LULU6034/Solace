/**
 * pipeline.js — RAG 文档索引与检索
 *
 * 对应 Python rag_pipeline.py
 * - PDF/TXT 文件支持
 * - 文本分块
 * - SQLite FTS5 全文搜索
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('rag');

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;

function splitText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  const separators = ['\n\n', '\n', '。', '.', ' ', ''];
  if (text.length <= chunkSize) return [text];

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= chunkSize) {
      chunks.push(remaining);
      break;
    }
    // Find best split point
    let splitAt = chunkSize;
    for (const sep of separators) {
      const idx = remaining.lastIndexOf(sep, chunkSize);
      if (idx > chunkSize * 0.5) {
        splitAt = idx + sep.length;
        break;
      }
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(Math.max(0, splitAt - overlap));
  }
  return chunks.filter(c => c);
}

export class RAGPipeline {
  constructor(persistDir) {
    this.persistDir = persistDir;
    fs.mkdirSync(persistDir, { recursive: true });
    this.dbPath = path.join(persistDir, 'rag.db');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        content, content='documents', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
    `);
  }

  _extractText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
      try {
        // Simple PDF text extraction (note: needs pdf-parse or similar for full support)
        const buf = fs.readFileSync(filePath);
        // Try to extract text between stream/endstream blocks
        const text = buf.toString('latin1');
        // Very basic: strip binary and keep readable ASCII/UTF-8
        const readable = text.replace(/[^\x20-\x7E一-鿿　-〿＀-￯\n\r\t]/g, ' ');
        return readable.slice(0, 50_000); // Limit
      } catch (err) {
        return `[PDF 解析失败: ${err.message}]`;
      }
    }
    // TXT and other text files
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      return `[文件读取失败: ${err.message}]`;
    }
  }

  indexFile(filePath) {
    const text = this._extractText(filePath);
    if (text.startsWith('[')) return 0;

    const fileName = path.basename(filePath);
    const chunks = splitText(text);
    if (chunks.length === 0) return 0;

    // Delete old entries for this file
    this.db.prepare('DELETE FROM documents WHERE name = ?').run(fileName);

    const insert = this.db.prepare(
      'INSERT INTO documents (id, content, source, name, chunk_index, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const tx = this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        insert.run(`${fileName}_${i}`, chunks[i], filePath, fileName, i, Date.now());
      }
    });
    tx();

    log.log(`索引完成: ${fileName} (${chunks.length} 块)`);
    return chunks.length;
  }

  search(query, k = 5) {
    if (!query?.trim() || this.count() === 0) return [];

    try {
      const ftsQuery = String(query).replace(/[^\w一-鿿]/g, ' ').split(/\s+/).filter(Boolean).join(' OR ');
      const rows = this.db.prepare(
        'SELECT d.content, d.source, d.name FROM documents d ' +
        'JOIN documents_fts fts ON d.rowid = fts.rowid ' +
        'WHERE documents_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(ftsQuery, k);

      return rows.map(r => ({
        content: r.content,
        source: r.name,
        path: r.source,
      }));
    } catch {
      // FTS5 syntax error — fallback to LIKE
      const rows = this.db.prepare(
        'SELECT content, source, name FROM documents WHERE content LIKE ? LIMIT ?'
      ).all(`%${query}%`, k);
      return rows.map(r => ({
        content: r.content,
        source: r.name,
        path: r.source,
      }));
    }
  }

  getIndexedFiles() {
    const rows = this.db.prepare('SELECT DISTINCT name FROM documents').all();
    return rows.map(r => r.name);
  }

  removeFile(fileName) {
    this.db.prepare('DELETE FROM documents WHERE name = ?').run(fileName);
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) as c FROM documents').get()?.c || 0;
  }

  clear() {
    this.db.prepare('DELETE FROM documents').run();
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

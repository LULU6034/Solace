/**
 * kb-indexer.js — 知识库索引编排器
 *
 * 协调完整的索引流水线：解析 → 分块 → 嵌入 → 写入数据库 + 检索引擎。
 * 所有依赖通过构造函数注入，未提供时自动创建默认实例。
 *
 * 功能：
 *   - indexFile()        单文件全量管道
 *   - removeFile()       从数据库和检索引擎中移除
 *   - indexDirectory()   递归扫描并索引目录
 *   - fullScan()         扫描所有 monitor 路径，增量更新变更文件
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createModuleLogger } from '../lib/debug-log.js';
import { KBSchema } from './schema.js';
import { KBDocParser } from './parser.js';
import { KBChunker } from './chunker.js';
import { KBEmbedder } from './embedder.js';
import { HybridRetriever } from './retriever.js';
import { KBConfig } from './config.js';

const log = createModuleLogger('kb-indexer');

// ── KBIndexer 类 ──

export class KBIndexer {
  /**
   * 所有依赖均可选——未提供的项会自动创建默认实例。
   *
   * @param {object} [opts]
   * @param {KBSchema}        [opts.schema]    SQLite schema 管理器
   * @param {KBDocParser}     [opts.parser]    文档解析器
   * @param {KBChunker}       [opts.chunker]   文本分块器
   * @param {KBEmbedder}      [opts.embedder]  向量嵌入器
   * @param {HybridRetriever} [opts.retriever] 混合检索引擎
   * @param {KBConfig}        [opts.config]    配置加载器
   */
  constructor({ schema, parser, chunker, embedder, retriever, config } = {}) {
    this.schema = schema || new KBSchema();
    this.parser = parser || new KBDocParser();
    this.config = config || new KBConfig();
    this.embedder = embedder || new KBEmbedder();

    this.chunker =
      chunker ||
      new KBChunker({
        maxTokens: this.config.get('chunking.max_tokens') || 512,
        overlapTokens: this.config.get('chunking.overlap_tokens') || 64,
      });

    this.retriever =
      retriever ||
      new HybridRetriever({ embedder: this.embedder });

    this._ready = false;
  }

  // ── 初始化 ──

  /**
   * 初始化 schema（建表）并加载嵌入模型。幂等调用。
   */
  async init() {
    if (this._ready) return;
    await this.schema.init();
    await this.embedder.ensureLoaded();
    this._ready = true;
    log.log('KBIndexer 初始化完成');
  }

  // ── 单文件索引 ──

  /**
   * 完整流水线：解析 → 分块 → 嵌入 → 写入 DB → 加入检索引擎。
   *
   * 若文件已索引且 hash 未变（状态为 active），则跳过，返回 cached: true。
   * 若文件已索引但 hash 变化，则先移除旧分块再重新索引。
   *
   * @param {string} filePath — 文件绝对路径
   * @returns {Promise<{
   *   fileId: string|null, chunkCount: number, success: boolean,
   *   cached?: boolean, reason?: string
   * }>}
   */
  async indexFile(filePath) {
    if (!this._ready) await this.init();

    const absPath = path.resolve(filePath);

    // 1. 文件存在性检查
    if (!fs.existsSync(absPath)) {
      log.warn(`文件不存在，跳过索引: ${absPath}`);
      return { fileId: null, chunkCount: 0, success: false, reason: 'file_not_found' };
    }

    // 提取文件元信息
    const stat = fs.statSync(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const extensions = this.config.get('watch.extensions') || ['.md', '.txt', '.pdf', '.html'];
    if (!extensions.includes(ext)) {
      log.debug(`不支持的扩展名，跳过: ${ext}`);
      return { fileId: null, chunkCount: 0, success: false, reason: 'unsupported_extension' };
    }

    // 文件大小限制
    const maxSizeMB = this.config.get('watch.max_file_size_mb') || 50;
    if (stat.size > maxSizeMB * 1024 * 1024) {
      log.warn(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)} MB)，跳过: ${absPath}`);
      return { fileId: null, chunkCount: 0, success: false, reason: 'file_too_large' };
    }

    // 2. 计算 hash，检查是否已索引
    const hash = this._computeFileHash(absPath);
    const existing = this._getFileRecord(absPath);

    if (existing && existing.hash === hash && existing.status === 'active') {
      log.debug(`文件未变化，跳过索引: ${absPath}`);
      return {
        fileId: existing.id,
        chunkCount: existing.chunk_count || 0,
        success: true,
        cached: true,
      };
    }

    // 如果之前已索引但内容变化，先清理旧分块
    if (existing) {
      await this._removeChunksForFile(existing.id);
    }

    // 3. 解析文档
    let parseResult;
    try {
      parseResult = await this.parser.parse(absPath);
    } catch (err) {
      log.warn(`解析失败: ${absPath} — ${err.message}`);
      return { fileId: null, chunkCount: 0, success: false, reason: 'parse_error', error: err.message };
    }

    const { text, metadata } = parseResult;

    // 3b. PDF OCR 回退：若直接解析的文本为空或过短，自动触发 OCR
    let finalText = text;
    let ocrUsed = false;
    if (ext === '.pdf' && (!text || text.length < 100)) {
      log.log(
        `PDF 直接解析文本过短 (${text ? text.length : 0} 字符)，触发 OCR...`,
      );
      const ocrText = await this._ocrPdfPages(fs.readFileSync(absPath));
      if (ocrText && ocrText.length > 0) {
        // 将 OCR 文本追加到直接提取的文本后面
        finalText = text
          ? `${text}\n\n[OCR 补充]\n${ocrText}`
          : `[OCR 提取]\n${ocrText}`;
        ocrUsed = true;
        log.log(`OCR 补充了 ${ocrText.length} 字符`);
      } else {
        log.warn('OCR 未返回有效文本，使用原始解析结果');
      }
    }

    // 4. 分块
    const chunkMetas = this.chunker.chunkWithMeta(finalText, metadata);

    if (chunkMetas.length === 0) {
      log.debug(`文件无有效文本，创建空记录: ${absPath}`);

      // 即使无分块也记录文件
      const fileId = existing ? existing.id : KBSchema.makeId();
      const now = Date.now();
      const db = this.schema.db;
      this._upsertFileRecord({ existing, fileId, absPath, ext, hash, stat, now, chunkCount: 0, metadata, db });
      this.schema.save();

      return { fileId, chunkCount: 0, success: true };
    }

    // 5. 批量生成嵌入向量
    const texts = chunkMetas.map((c) => c.content);
    let embeddings;
    try {
      embeddings = await this.embedder.embedBatch(texts);
    } catch (err) {
      log.warn(`嵌入生成失败: ${absPath} — ${err.message}`);
      return { fileId: null, chunkCount: 0, success: false, reason: 'embed_error', error: err.message };
    }

    // 6. 写入/更新文件记录
    const fileId = existing ? existing.id : KBSchema.makeId();
    const now = Date.now();
    const db = this.schema.db;

    this._upsertFileRecord({
      existing,
      fileId,
      absPath,
      ext,
      hash,
      stat,
      now,
      chunkCount: chunkMetas.length,
      metadata,
      db,
    });

    // 7. 写入分块记录 + 加入检索引擎
    for (let i = 0; i < chunkMetas.length; i++) {
      const chunkMeta = chunkMetas[i];
      const chunkId = KBSchema.makeId();

      // SQLite 写入
      db.run(
        `INSERT INTO chunks (id, file_id, chunk_index, content, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [chunkId, fileId, chunkMeta.index, chunkMeta.content, chunkMeta.tokenCount, now],
      );

      // 加入 BM25 + 向量索引
      await this.retriever.indexChunk(chunkId, chunkMeta.content);
    }

    // 8. 持久化
    this.schema.save();

    const ocrNote = ocrUsed ? ` (含 OCR)` : '';
    log.log(`索引完成: ${path.basename(absPath)} → ${chunkMetas.length} 块${ocrNote}`);
    return { fileId, chunkCount: chunkMetas.length, success: true };
  }

  // ── 移除文件 ──

  /**
   * 从所有索引中移除文件：BM25、向量索引、SQLite chunks、文件记录标记为 deleted。
   *
   * @param {string} filePath — 文件绝对路径
   * @returns {Promise<{ success: boolean, reason?: string }>}
   */
  async removeFile(filePath) {
    if (!this._ready) await this.init();

    const absPath = path.resolve(filePath);
    const record = this._getFileRecord(absPath);

    if (!record) {
      log.warn(`文件未在索引中: ${absPath}`);
      return { success: false, reason: 'not_indexed' };
    }

    // 移除所有分块（检索引擎 + DB）
    await this._removeChunksForFile(record.id);

    // 标记文件记录为 deleted
    const db = this.schema.db;
    db.run(
      "UPDATE files SET status = 'deleted', chunk_count = 0, last_indexed = ? WHERE id = ?",
      [Date.now(), record.id],
    );

    this.schema.save();
    log.log(`已从索引移除: ${absPath}`);
    return { success: true };
  }

  // ── 目录索引 ──

  /**
   * 递归扫描目录，索引所有支持格式的文件。
   * 跳过隐藏文件（若 config.watch.ignore_hidden 为 true）、
   * 超过大小限制的文件和不支持的扩展名。
   *
   * @param {string} dirPath — 目录绝对路径
   * @returns {Promise<{
   *   success: boolean, directory: string, total: number,
   *   indexed: number, cached: number, failed: number,
   *   reason?: string, results: object[]
   * }>}
   */
  async indexDirectory(dirPath) {
    if (!this._ready) await this.init();

    const absPath = path.resolve(dirPath);

    if (!fs.existsSync(absPath)) {
      log.warn(`目录不存在: ${absPath}`);
      return { success: false, reason: 'directory_not_found' };
    }

    const dirStat = fs.statSync(absPath);
    if (!dirStat.isDirectory()) {
      log.warn(`路径不是目录: ${absPath}`);
      return { success: false, reason: 'not_a_directory' };
    }

    const extensions = this.config.get('watch.extensions') || ['.md', '.txt', '.pdf', '.html'];
    const ignoreHidden = this.config.get('watch.ignore_hidden') !== false;

    const files = this._findFiles(absPath, extensions, ignoreHidden);
    log.log(`目录扫描: ${absPath} → 发现 ${files.length} 个候选文件`);

    const results = [];
    for (const file of files) {
      try {
        const result = await this.indexFile(file);
        results.push({ file, ...result });
      } catch (err) {
        log.warn(`索引异常: ${file} — ${err.message}`);
        results.push({ file, success: false, error: err.message });
      }
    }

    const indexed = results.filter((r) => r.success && !r.cached).length;
    const cached = results.filter((r) => r.cached).length;
    const failed = results.filter((r) => !r.success).length;

    return {
      success: true,
      directory: absPath,
      total: files.length,
      indexed,
      cached,
      failed,
      results,
    };
  }

  // ── 全量扫描 ──

  /**
   * 对所有 config.watch.paths 执行 indexDirectory。
   * 内部 indexFile 通过 hash 比较自动跳过未变更文件，因此此方法本质上是增量更新。
   *
   * @returns {Promise<{
   *   success: boolean, directories: number,
   *   indexed: number, cached: number, failed: number,
   *   reason?: string, results: object[]
   * }>}
   */
  async fullScan() {
    if (!this._ready) await this.init();

    const watchPaths = this.config.get('watch.paths') || [];

    if (watchPaths.length === 0) {
      log.warn('未配置监视路径 (config.watch.paths)，跳过全扫描');
      return { success: false, reason: 'no_watch_paths' };
    }

    const allResults = [];
    let totalIndexed = 0;
    let totalCached = 0;
    let totalFailed = 0;

    for (const watchPath of watchPaths) {
      const dirPath = path.resolve(watchPath);

      if (!fs.existsSync(dirPath)) {
        log.warn(`监视路径不存在，跳过: ${dirPath}`);
        allResults.push({ directory: dirPath, success: false, reason: 'directory_not_found' });
        continue;
      }

      const result = await this.indexDirectory(dirPath);
      allResults.push(result);
      totalIndexed += result.indexed || 0;
      totalCached += result.cached || 0;
      totalFailed += result.failed || 0;
    }

    log.log(`全扫描完成: ${totalIndexed} 新增索引 / ${totalCached} 缓存命中 / ${totalFailed} 失败`);

    return {
      success: true,
      directories: watchPaths.length,
      indexed: totalIndexed,
      cached: totalCached,
      failed: totalFailed,
      results: allResults,
    };
  }

  // ── 内部方法 ──

  /**
   * 计算文件 hash（SHA-256，仅读取前 64 KB）。
   *
   * @param {string} filePath
   * @returns {string} 十六进制 hash 字符串
   */
  _computeFileHash(filePath) {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);

    const hash = crypto.createHash('sha256');
    hash.update(buf.subarray(0, bytesRead));
    return hash.digest('hex');
  }

  /**
   * 根据路径查询 files 表中的记录。
   *
   * @param {string} filePath — 文件绝对路径
   * @returns {object|null} — 行数据对象，未找到返回 null
   */
  _getFileRecord(filePath) {
    const db = this.schema.db;
    const stmt = db.prepare('SELECT * FROM files WHERE path = ?');
    stmt.bind([filePath]);
    let record = null;
    if (stmt.step()) {
      record = stmt.getAsObject();
    }
    stmt.free();
    return record;
  }

  /**
   * 插入或更新 files 表记录。
   *
   * @param {object} params
   * @param {object|null} params.existing  — 已存在的记录（null 表示新增）
   * @param {string}      params.fileId
   * @param {string}      params.absPath
   * @param {string}      params.ext
   * @param {string}      params.hash
   * @param {fs.Stats}    params.stat
   * @param {number}      params.now
   * @param {number}      params.chunkCount
   * @param {object}      params.metadata
   * @param {object}      params.db        — sql.js Database 实例
   */
  _upsertFileRecord({ existing, fileId, absPath, ext, hash, stat, now, chunkCount, metadata, db }) {
    const filename = path.basename(absPath);
    const metadataJson = JSON.stringify(metadata);

    if (existing) {
      db.run(
        `UPDATE files
         SET hash = ?, size_bytes = ?, last_modified = ?, last_indexed = ?,
             chunk_count = ?, status = 'active', metadata = ?
         WHERE id = ?`,
        [hash, stat.size, stat.mtimeMs, now, chunkCount, metadataJson, fileId],
      );
    } else {
      db.run(
        `INSERT INTO files (id, path, filename, ext, hash, size_bytes, last_modified,
                            last_indexed, chunk_count, status, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [fileId, absPath, filename, ext, hash, stat.size, stat.mtimeMs, now, chunkCount, metadataJson],
      );
    }
  }

  /**
   * 移除某文件的所有分块：检索引擎 + SQLite。
   *
   * @param {string} fileId — files 表中的 id
   */
  async _removeChunksForFile(fileId) {
    const db = this.schema.db;

    // 收集所有 chunk ID
    const stmt = db.prepare('SELECT id FROM chunks WHERE file_id = ?');
    stmt.bind([fileId]);
    const chunkIds = [];
    while (stmt.step()) {
      chunkIds.push(stmt.getAsObject().id);
    }
    stmt.free();

    // 从检索引擎移除
    for (const chunkId of chunkIds) {
      await this.retriever.removeChunk(chunkId);
    }

    // 删除 SQLite 中的分块记录
    if (chunkIds.length > 0) {
      db.run('DELETE FROM chunks WHERE file_id = ?', [fileId]);
      log.debug(`已清理文件 ${fileId} 的 ${chunkIds.length} 个分块`);
    }
  }

  /**
   * 递归扫描目录，按扩展名和隐藏文件规则筛选。
   *
   * @param {string}   dirPath      — 目录绝对路径
   * @param {string[]} extensions   — 支持的文件扩展名（含点号）
   * @param {boolean}  ignoreHidden — 是否跳过隐藏文件/目录
   * @returns {string[]} 匹配的文件的绝对路径
   */
  _findFiles(dirPath, extensions, ignoreHidden) {
    const results = [];
    const extSet = new Set(extensions.map((e) => e.toLowerCase()));

    try {
      const entries = fs.readdirSync(dirPath, { recursive: true });

      for (const entry of entries) {
        // 跳过隐藏路径（任一组件以 . 开头且 ignoreHidden 为 true）
        if (ignoreHidden && this._entryHasHiddenComponent(entry)) {
          continue;
        }

        const fullPath = path.join(dirPath, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) continue;

          const ext = path.extname(entry).toLowerCase();
          if (extSet.has(ext)) {
            results.push(fullPath);
          }
        } catch (_e) {
          // 无法 stat 的文件（权限、符号链接断裂等）静默跳过
        }
      }
    } catch (err) {
      log.warn(`读取目录失败: ${dirPath} — ${err.message}`);
    }

    return results;
  }

  /**
   * 判断递归 readdir 返回的相对路径是否包含隐藏组件。
   * 例如 '.git/objects/foo' 返回 true。
   *
   * @param {string} entryPath — readdirSync({ recursive: true }) 返回的相对路径
   * @returns {boolean}
   */
  _entryHasHiddenComponent(entryPath) {
    return entryPath.split(path.sep).some((part) => part.startsWith('.'));
  }

  // ── 便捷访问 ──

  /** @returns {boolean} 是否已调用 init() 并完成 */
  get ready() {
    return this._ready;
  }

  // ── OCR ──

  /**
   * 对 PDF Buffer 的指定页数进行 OCR 识别。
   *
   * 使用 pdfjs-dist 渲染页面为 PNG，再用 tesseract.js 进行中文+英文识别。
   * 动态 import，按需加载，不影响模块首次加载速度。
   *
   * @param {Buffer} pdfBuffer  - PDF 文件的 Buffer
   * @param {number} [maxPages=3] - 最大 OCR 页数
   * @returns {Promise<string|null>} OCR 识别的文本，失败返回 null
   */
  async _ocrPdfPages(pdfBuffer, maxPages = 3) {
    try {
      const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const uint8 = new Uint8Array(
        pdfBuffer.buffer,
        pdfBuffer.byteOffset,
        pdfBuffer.byteLength,
      );
      const doc = await pdfjsLib.getDocument({ data: uint8 }).promise;
      const pages = Math.min(doc.numPages, maxPages);
      const { createCanvas } = await import('canvas');

      const texts = [];

      for (let i = 1; i <= pages; i++) {
        const pdfPage = await doc.getPage(i);
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const ctx = canvas.getContext('2d');
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        const imgBuffer = canvas.toBuffer('image/png');

        log.debug(`OCR 第 ${i}/${pages} 页渲染完成，开始识别...`);
        const text = await this._ocrImage(imgBuffer);
        if (text) texts.push(`[第${i}页]\n${text}`);
      }

      await doc.destroy();
      log.log(`PDF OCR 完成: ${texts.length}/${pages} 页有文字`);
      return texts.length ? texts.join('\n\n') : null;
    } catch (err) {
      log.warn(`PDF OCR 失败: ${err.message}`);
      return null;
    }
  }

  /**
   * 对单张图片 Buffer 进行 OCR 识别。
   *
   * @param {Buffer} imgBuffer - PNG/JPEG 图片 Buffer
   * @returns {Promise<string|null>} 识别的文本，失败返回 null
   */
  async _ocrImage(imgBuffer) {
    try {
      const Tesseract = (await import('tesseract.js')).default;
      const { data } = await Tesseract.recognize(imgBuffer, 'chi_sim+eng', {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            log.debug(`OCR 进度: ${Math.round(m.progress * 100)}%`);
          }
        },
      });
      const text = (data?.text || '').replace(/\n{2,}/g, '\n').trim();
      return text || null;
    } catch (err) {
      log.warn(`图片 OCR 失败: ${err.message}`);
      return null;
    }
  }
}

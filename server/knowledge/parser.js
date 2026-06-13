/**
 * kb-parser.js — 多格式文档解析器
 *
 * 根据文件扩展名检测格式，将 .md/.txt/.html/.pdf 等文档解析为
 * { text, metadata } 结构。支持 YAML frontmatter 提取、HTML 标签剥离、
 * Markdown 转纯文本等操作。
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { marked } from 'marked';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('kb-parser');

// ── 支持的扩展名 ──
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const HTML_EXTS = new Set(['.html', '.htm']);
const TXT_EXTS = new Set(['.txt']);
const PDF_EXTS = new Set(['.pdf']);

// ── YAML frontmatter 正则：匹配开头的 --- ... --- ──
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

// ── HTML 标签剥离正则（移除 script/style，然后去标签） ──
const RE_SCRIPT = /<script[^>]*>[\s\S]*?<\/script>/gi;
const RE_STYLE = /<style[^>]*>[\s\S]*?<\/style>/gi;
const RE_TAG = /<[^>]+>/g;
const RE_HTML_ENTITY = /&[a-z]+;/g;
const RE_WHITESPACE = /\s+/g;

// ── KBDocParser 类 ──
export class KBDocParser {
  constructor() {
    this._ready = true;
  }

  /**
   * 根据文件路径检测格式，读取并解析文档
   * @param {string} filePath - 文档文件的绝对路径
   * @returns {Promise<{ text: string, metadata: object }>}
   */
  async parse(filePath) {
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const stat = fs.statSync(filePath);
    const sizeBytes = stat.size;

    const buffer = fs.readFileSync(filePath);
    const result = await this.parseBuffer(buffer, ext);

    // 补充文件级元数据
    result.metadata.filename = filename;
    result.metadata.size_bytes = sizeBytes;

    log.log(`解析完成: ${filename} (${(sizeBytes / 1024).toFixed(1)} KB)`);
    return result;
  }

  /**
   * 从 Buffer 解析文档（用于内存中的数据，无需读磁盘）
   * @param {Buffer} buffer - 文档内容
   * @param {string} ext - 扩展名（含点号，如 '.md'）
   * @returns {Promise<{ text: string, metadata: object }>}
   */
  async parseBuffer(buffer, ext) {
    const extLower = ext.toLowerCase();

    // PDF 是二进制格式，直接传 Buffer
    if (PDF_EXTS.has(extLower)) {
      return this._parsePdf(buffer);
    }

    const text = buffer.toString('utf-8');

    if (MARKDOWN_EXTS.has(extLower)) {
      return this._parseMarkdown(text);
    }
    if (HTML_EXTS.has(extLower)) {
      return this._parseHtml(text);
    }
    if (TXT_EXTS.has(extLower)) {
      return this._parseText(text);
    }

    // 未知格式：退回纯文本
    log.warn(`未知格式: ${extLower}，退回纯文本解析`);
    return this._parseText(text);
  }

  // ── Markdown 解析 ──
  _parseMarkdown(raw) {
    let metadata = {};
    let body = raw;

    // 提取 YAML frontmatter
    const fmMatch = body.match(FRONTMATTER_RE);
    if (fmMatch) {
      try {
        metadata = yaml.load(fmMatch[1]) || {};
        if (typeof metadata !== 'object') metadata = {};
        body = body.slice(fmMatch[0].length);
      } catch (e) {
        log.warn(`YAML frontmatter 解析失败: ${e.message}`);
      }
    }

    // Markdown → 纯文本（使用 marked 渲染为 HTML，再剥离标签）
    let plainText = '';
    try {
      const html = marked.parse(body, { async: false });
      plainText = this._stripHtml(html);
    } catch (e) {
      log.warn(`marked 解析失败，退回原文: ${e.message}`);
      plainText = body;
    }

    metadata.source_type = 'markdown';
    metadata._has_frontmatter = !!fmMatch;

    return { text: plainText, metadata };
  }

  // ── HTML 解析 ──
  _parseHtml(raw) {
    const metadata = {};
    metadata.source_type = 'html';

    // 提取 <title>
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      metadata.title = titleMatch[1].trim();
    }

    // 剥离标签，提取纯文本
    const plainText = this._stripHtml(raw);

    return { text: plainText, metadata };
  }

  // ── 纯文本解析 ──
  _parseText(raw) {
    const metadata = {};
    metadata.source_type = 'text';

    // 纯文本直接使用，去除首尾空白
    const text = raw.trim();

    return { text, metadata };
  }

  // ── PDF 解析 ──
  async _parsePdf(buffer) {
    const metadata = { source_type: 'pdf' };
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(buffer);
      if (data.text) {
        metadata.title = data.info?.Title || undefined;
        metadata.author = data.info?.Author || undefined;
        metadata.page_count = data.numpages;
        const text = data.text.replace(/\f/g, '\n').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        log.log(`PDF 解析成功: ${data.numpages} 页, ${text.length} 字符`);
        return { text, metadata };
      }
    } catch (err) {
      log.warn(`PDF 解析失败: ${err.message}`);
    }
    metadata._parse_failed = true;
    return { text: '', metadata };
  }

  // ── HTML 标签剥离工具 ──
  _stripHtml(html) {
    return html
      .replace(RE_SCRIPT, '')
      .replace(RE_STYLE, '')
      .replace(RE_TAG, ' ')
      .replace(RE_HTML_ENTITY, ' ')
      .replace(RE_WHITESPACE, ' ')
      .trim();
  }
}

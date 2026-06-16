/**
 * file-tools.js — 文件操作工具
 *
 * read_file, write_file, list_files, read_image
 */
import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('file-tools');

const MAX_READ_SIZE = 100_000; // 100KB max read (text files)
const MAX_PDF_SIZE = 5_000_000; // 5MB max read (PDF, processed page-by-page)
const MAX_WRITE_SIZE = 500_000; // 500KB max write
const DANGEROUS_EXTENSIONS = new Set(['.exe', '.dll', '.sys', '.com', '.bat', '.cmd', '.ps1', '.vbs']);

// 安全目录白名单：Agent 只能操作这些目录及其子目录
const SAFE_ROOTS = (() => {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cwd = process.cwd();
  return [
    cwd,  // 项目根目录
    path.join(home, '.ai-desktop-pet'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
  ].filter(p => p);
})();

function _safePath(filepath) {
  const resolved = path.resolve(filepath);
  // 安全检查：必须在白名单目录内
  const allowed = SAFE_ROOTS.some(root => resolved.startsWith(root + path.sep) || resolved === root);
  if (!allowed) {
    throw new Error(`安全限制: 无法访问 "${filepath}"。Agent 仅允许操作以下目录: ${SAFE_ROOTS.join(', ')}`);
  }
  // 禁止写入危险扩展名
  const ext = path.extname(resolved).toLowerCase();
  if (DANGEROUS_EXTENSIONS.has(ext)) {
    throw new Error(`安全限制: 禁止操作 ${ext} 文件类型`);
  }
  return resolved;
}

// ── OCR 辅助（Tesseract.js，自动下载中文语言包）──
async function _ocrImage(buffer, label = '') {
  try {
    const Tesseract = (await import('tesseract.js')).default;
    const { data } = await Tesseract.recognize(buffer, 'chi_sim+eng', {
      logger: (m) => { if (m.status === 'recognizing text') log.log(`OCR${label} ${Math.round(m.progress * 100)}%`); },
    });
    const text = (data?.text || '').replace(/\n{2,}/g, '\n').trim();
    log.log(`OCR${label} 完成, ${text.length} 字符`);
    return text || null;
  } catch (err) {
    console.error(`[OCR${label}] 失败:`, err.message);
    return null;
  }
}

async function _ocrPdfPages(pdfBuffer, maxPages = 3) {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // pdfjs-dist v4 需要 Uint8Array，不能用 Node Buffer
    const uint8 = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);
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
      log.log(`OCR 第${i}页渲染完成, 开始识别...`);
      const text = await _ocrImage(imgBuffer, `-p${i}`);
      if (text) texts.push(`[第${i}页]\n${text}`);
    }
    await doc.destroy();
    log.log(`OCR PDF 完成, ${texts.length}/${pages} 页有文字`);
    return texts.length ? texts.join('\n\n') : null;
  } catch (err) {
    console.error('[OCR] PDF OCR 失败:', err.message);
    return null;
  }
}

// 文本格式（不用 special handling，直接读 UTF-8）
const TEXT_EXTS = new Set(['.md','.txt','.html','.htm','.csv','.json','.xml','.yaml','.yml','.toml','.ini','.cfg','.env','.log']);
const CODE_EXTS = new Set(['.js','.ts','.jsx','.tsx','.vue','.py','.rs','.go','.java','.c','.cpp','.h','.hpp','.cs','.rb','.php','.swift','.kt','.scala','.lua','.sh','.bash','.zsh','.ps1','.bat','.sql','.r','.m','.mm','.css','.scss','.less','.graphql']);

export const readFile = {
  name: 'read_file',
  description: '读取文件内容。参数 file_path: 文件绝对路径。支持文本文件、代码文件、PDF。',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '要读取的文件绝对路径' },
    },
    required: ['file_path'],
  },
  async invoke({ file_path }) {
    try {
      const resolved = _safePath(file_path);
      if (!fs.existsSync(resolved)) return `文件不存在: ${file_path}`;
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) return `这是一个目录，不是文件: ${file_path}`;
      const ext = path.extname(resolved).toLowerCase();

      // PDF：用 pdf-parse 提取文字
      if (ext === '.pdf') {
        if (stat.size > MAX_PDF_SIZE) return `PDF 过大 (${(stat.size / 1024).toFixed(0)}KB)，超过 ${MAX_PDF_SIZE / 1024}KB 限制`;
        try {
              // 用 pdfjs-dist 提取文字（不需要 pdf-parse）
          const buf = fs.readFileSync(resolved);
          log.log(`read_file PDF 大小: ${(buf.length / 1024).toFixed(0)}KB`);
          const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
          const doc = await pdfjsLib.getDocument({ data: uint8 }).promise;
          const numPages = doc.numPages;

          // 逐页提取文字，同时检测目录/标题页
          let allText = '';
          let tocPages = [];
          let totalChars = 0;
          const MAX_CHARS = 8000;

          for (let i = 1; i <= numPages; i++) {
            const page = await doc.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(it => it.str).join(' ').trim();
            if (!pageText) continue;
            // 检测目录页
            if (pageText.includes('目录') || pageText.includes('目  录')) {
              tocPages.push(i);
            }
            // 达到上限后停止（但始终包含目录页）
            if (totalChars > MAX_CHARS && !tocPages.includes(i)) continue;
            allText += `[第${i}页] ${pageText}\n`;
            totalChars += pageText.length;
          }
          await doc.destroy();

          // 生成结构化摘要
          const tocInfo = tocPages.length ? `目录: 第${tocPages.join(',')}页` : '';
          const summary = `[PDF: ${numPages} 页${tocInfo ? ', ' + tocInfo : ''}，已提取约 ${totalChars} 字符]\n\n`;
          const text = allText.replace(/\s+/g, ' ').trim();
          log.log(`read_file pdfjs: ${numPages} 页, 文字: ${text.length} 字符`);
          if (text.length > 50) return summary + text;
          // 无文字层 → 自动 OCR
          log.log(`read_file 启动 OCR (前${Math.min(numPages, 3)}页)...`);
          const ocrText = await _ocrPdfPages(buf, numPages);
          if (ocrText) return `[PDF: ${numPages} 页, OCR 提取]\n\n${ocrText}`;
          return summary + '(无可提取的文字，OCR 也未识别到内容。可能是纯图片扫描件)';
        } catch (err) {
          console.error(`[read_file] PDF 处理异常:`, err.message);
          return `PDF 读取失败: ${err.message}`;

        }
      }

      // 图片：提示用 read_image
      if (['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico'].includes(ext)) {
        return `这是一个图片文件 (${ext})，请用 read_image 工具读取。`;
      }

      // 文本文件：UTF-8
      if (stat.size > MAX_READ_SIZE) return `文件过大 (${(stat.size / 1024).toFixed(0)}KB)，超过 ${MAX_READ_SIZE / 1024}KB 限制`;
      try {
        const content = fs.readFileSync(resolved, 'utf-8');
        return content;
      } catch {
        // UTF-8 解码失败，可能是二进制文件
        return `无法以文本格式读取此文件 (${ext})。如果是图片请用 read_image，如果是 PDF 应该已被自动处理。`;
      }
    } catch (err) {
      return `文件读取失败: ${err.message}`;
    }
  },
};

export const writeFile = {
  name: 'write_file',
  description: '写入文件内容。参数 file_path: 文件路径，content: 要写入的内容',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '要写入的文件绝对路径' },
      content: { type: 'string', description: '要写入的内容' },
    },
    required: ['file_path', 'content'],
  },
  async invoke({ file_path, content }) {
    try {
      if (!content) return '内容为空，拒绝写入';
      if (content.length > MAX_WRITE_SIZE) return `内容过大 (${content.length} 字符)，超过 ${MAX_WRITE_SIZE} 字符限制`;
      const resolved = _safePath(file_path);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const existed = fs.existsSync(resolved);
      fs.writeFileSync(resolved, content, 'utf-8');
      return existed
        ? `文件已覆盖写入: ${file_path} (${content.length} 字符)`
        : `文件已写入: ${file_path} (${content.length} 字符)`;
    } catch (err) {
      return `文件写入失败: ${err.message}`;
    }
  },
};

export const listFiles = {
  name: 'list_files',
  description: '列出目录下的文件。参数 dir_path: 目录路径',
  parameters: {
    type: 'object',
    properties: {
      dir_path: { type: 'string', description: '要列出的目录绝对路径' },
    },
    required: ['dir_path'],
  },
  async invoke({ dir_path }) {
    try {
      const resolved = _safePath(dir_path);
      if (!fs.existsSync(resolved)) return `目录不存在: ${dir_path}`;
      if (!fs.statSync(resolved).isDirectory()) return `这不是一个目录: ${dir_path}`;
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const lines = entries.slice(0, 100).map(e => {
        const type = e.isDirectory() ? 'DIR' : e.isFile() ? 'FILE' : 'OTHER';
        const size = e.isFile() ? ` (${(fs.statSync(path.join(resolved, e.name)).size / 1024).toFixed(1)}KB)` : '';
        return `[${type}] ${e.name}${size}`;
      });
      if (entries.length > 100) lines.push(`... 还有 ${entries.length - 100} 个条目`);
      return lines.join('\n');
    } catch (err) {
      return `列出目录失败: ${err.message}`;
    }
  },
};

export const readFilePage = {
  name: 'read_file_page',
  description: `分页查看 PDF 或大文件。扫描件 PDF 用 read_file 读不到文字时，用此工具逐页查看。
参数 file_path: 文件路径
参数 page: 页码（从1开始，默认1）。每页返回 800px 宽的图片 base64。`,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '文件路径' },
      page: { type: 'number', description: '页码，从1开始，默认1' },
    },
    required: ['file_path'],
  },
  async invoke({ file_path, page = 1 }) {
    try {
      const resolved = _safePath(file_path);
      if (!fs.existsSync(resolved)) return `文件不存在: ${file_path}`;
      const ext = path.extname(resolved).toLowerCase();
      if (ext !== '.pdf') return `此工具仅支持 PDF 文件，当前文件类型: ${ext}。文本文件请用 read_file，图片请用 read_image。`;

      const buf = fs.readFileSync(resolved);
      const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const doc = await pdfjsLib.getDocument({ data: uint8 }).promise;
      const totalPages = doc.numPages;
      const pageNum = Math.max(1, Math.min(page, totalPages));

      if (pageNum !== page) {
        return `页码范围错误。PDF 共 ${totalPages} 页，请求第 ${page} 页超出范围。`;
      }

      const pdfPage = await doc.getPage(pageNum);
      const viewport = pdfPage.getViewport({ scale: 1.0 });
      // 缩放到宽度 800px
      const scale = 800 / viewport.width;
      const scaledViewport = pdfPage.getViewport({ scale });

      // 用 node-canvas 渲染
      const { createCanvas } = await import('canvas');
      const canvas = createCanvas(scaledViewport.width, scaledViewport.height);
      const ctx = canvas.getContext('2d');

      await pdfPage.render({
        canvasContext: ctx,
        viewport: scaledViewport,
      }).promise;

      // 渲染为图片
      const imgBuffer = canvas.toBuffer('image/png');
      const b64 = canvas.toDataURL('image/jpeg', 0.75);

      // 同时运行 OCR
      let ocrText = '';
      try {
        ocrText = (await _ocrImage(imgBuffer)) || '';
      } catch (e) { log.warn('操作失败', e?.message || e); }

      await doc.destroy();
      const result = [`[PDF 第 ${pageNum}/${totalPages} 页]`];
      if (ocrText) result.push(`\nOCR 文字:\n${ocrText}`);
      result.push(`\n${b64}`);
      return result.join('\n');
    } catch (err) {
      return `PDF 页面读取失败: ${err.message}`;
    }
  },
};

export const readImage = {
  name: 'read_image',
  description: '读取图片文件，返回 base64 data URL。参数 file_path: 图片文件路径',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '要读取的图片文件绝对路径' },
    },
    required: ['file_path'],
  },
  async invoke({ file_path }) {
    try {
      const resolved = _safePath(file_path);
      if (!fs.existsSync(resolved)) return `文件不存在: ${file_path}`;
      const ext = path.extname(resolved).toLowerCase();
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
      const mime = mimeMap[ext] || 'application/octet-stream';
      const buf = fs.readFileSync(resolved);
      const b64 = buf.toString('base64');
      return `data:${mime};base64,${b64}`;
    } catch (err) {
      return `图片读取失败: ${err.message}`;
    }
  },
};

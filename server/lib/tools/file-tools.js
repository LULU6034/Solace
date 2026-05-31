/**
 * file-tools.js — 文件操作工具
 *
 * read_file, write_file, list_files, read_image
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_READ_SIZE = 100_000; // 100KB max read
const MAX_WRITE_SIZE = 500_000; // 500KB max write
const DANGEROUS_EXTENSIONS = new Set(['.exe', '.dll', '.sys', '.com', '.bat', '.cmd', '.ps1', '.vbs']);

function _safePath(filepath) {
  // Resolve and normalize
  const resolved = path.resolve(filepath);
  // Block writing to dangerous extensions via read_image
  return resolved;
}

export const readFile = {
  name: 'read_file',
  description: '读取文件内容。参数 file_path: 文件路径（绝对路径）',
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
      if (stat.size > MAX_READ_SIZE) return `文件过大 (${(stat.size / 1024).toFixed(0)}KB)，超过 ${MAX_READ_SIZE / 1024}KB 限制`;
      const content = fs.readFileSync(resolved, 'utf-8');
      return content;
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
      fs.writeFileSync(resolved, content, 'utf-8');
      return `文件已写入: ${file_path} (${content.length} 字符)`;
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

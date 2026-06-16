/**
 * file-ops-tools.js — 精确文件操作工具
 *
 *   edit_file  — 精确文本替换（一次替换一处）
 *   glob       — 文件名模式匹配
 *   grep       — 内容正则搜索
 *
 * 安全: 所有操作限制在项目目录内，排除 node_modules/.git
 */
import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('file-ops');

// ── 安全 ──
const BLOCKED_DIRS = ['node_modules', '.git', '.next', 'dist', '__pycache__'];
const MAX_FILE_SIZE = 5_000_000; // 5MB
const MAX_GLOB_RESULTS = 200;
const MAX_GLOB_DEPTH = 30; // 防止 ** 模式指数爆炸
const MAX_GREP_CHARS = 5000;

const SAFE_ROOTS = (() => {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return [process.cwd(), path.join(home, '.ai-desktop-pet'), path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')];
})();

function isSafePath(targetPath) {
  const parts = targetPath.split(path.sep);
  if (parts.some(p => BLOCKED_DIRS.includes(p))) return false;
  return SAFE_ROOTS.some(root => targetPath.startsWith(root + path.sep) || targetPath === root);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Glob 匹配（零依赖，手写）──
function matchGlobSegment(pattern, name) {
  // 转换 glob 到正则: ** → .*, * → [^/]*, ? → [^/], {a,b} → (a|b)
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** — 匹配任意层级
        if (pattern[i + 2] === '/') { re += '(.*/)?'; i += 3; continue; }
        if (i + 2 >= pattern.length) { re += '.*'; i += 2; continue; }
      }
      re += '[^/]*'; i++;
    } else if (c === '?') {
      re += '[^/]'; i++;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end > i) {
        const opts = pattern.slice(i + 1, end).split(',').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        re += `(${opts})`; i = end + 1;
      } else { re += '\\{'; i++; }
    } else if (c === '[') {
      const end = pattern.indexOf(']', i);
      if (end > i) {
        const inner = pattern.slice(i + 1, end);
        re += `[${inner.replace(/[.*+?^${}()|\\]/g, '\\$&')}]`;
        i = end + 1;
      } else { re += '\\['; i++; }
    } else if ('.()\\+^$|'.includes(c)) {
      re += '\\' + c; i++;
    } else {
      re += c; i++;
    }
  }
  // 以 / 结尾 → 匹配目录
  if (pattern.endsWith('/')) re += '.*';
  return new RegExp(`^${re}$`).test(name);
}

function globWalk(dir, segments, segIdx, results, baseDir, seen, depth) {
  if (results.length >= MAX_GLOB_RESULTS) return;
  if (depth > MAX_GLOB_DEPTH) return; // 防止深度爆炸
  if (!fs.existsSync(dir)) return;
  if (!isSafePath(dir)) return;

  // 防重复访问同一目录（** 可能导致重复路径）
  const visitKey = `${dir}@${segIdx}`;
  if (seen.has(visitKey)) return;
  seen.add(visitKey);

  const isLast = segIdx >= segments.length;
  const seg = isLast ? null : segments[segIdx];

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (BLOCKED_DIRS.includes(entry.name)) continue;

    if (entry.isDirectory()) {
      if (!seg) continue; // 没有更多 segment，不管目录
      if (seg === '**') {
        // ** 匹配 0 层（跳过 **，用下一段匹配当前目录内容）
        globWalk(path.join(dir, entry.name), segments, segIdx + 1, results, baseDir, seen, depth + 1);
        // ** 匹配 >=1 层（保持 **，深入子目录）
        globWalk(path.join(dir, entry.name), segments, segIdx, results, baseDir, seen, depth + 1);
      } else if (matchGlobSegment(seg, entry.name)) {
        // 目录名匹配当前 segment → 深入下一层
        globWalk(path.join(dir, entry.name), segments, segIdx + 1, results, baseDir, seen, depth + 1);
      }
    } else if (entry.isFile()) {
      if (!seg || seg === '**' || matchGlobSegment(seg, entry.name)) {
        if (isLast || seg === '**' || (segIdx === segments.length - 1)) {
          results.push(path.relative(baseDir, path.join(dir, entry.name)).replace(/\\/g, '/'));
        }
      }
    }
  }
}

function collectGlob(pattern, baseDir) {
  const raw = pattern.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
  const segments = raw === '' || raw === '**' ? ['**'] : raw.split('/');
  const results = [];
  const seen = new Set();

  globWalk(baseDir, segments, 0, results, baseDir, seen, 0);
  return results;
}

// ── 通用文件收集器（供 grep 等使用）──

function collectFiles(baseDir, globFilter) {
  const results = [];
  function walk(dir, depth) {
    if (depth > 40) return;
    if (!isSafePath(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (BLOCKED_DIRS.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) results.push(full);
    }
  }
  walk(baseDir, 0);
  // glob_filter 过滤
  if (globFilter) {
    const globSegs = globFilter.replace(/\\/g, '/').split('/').filter(Boolean);
    const lastName = globSegs[globSegs.length - 1] || '**';
    return results.filter(f => matchGlobSegment(lastName, path.basename(f)));
  }
  return results;
}

// ── 编辑: 查找行号 ──
function findLineNumbers(content, search) {
  const escaped = escapeRegex(search);
  const re = new RegExp(escaped, 'g');
  const lines = content.split('\n');
  const matches = [];
  let match;
  while ((match = re.exec(content)) !== null) {
    const pos = match.index;
    const before = content.slice(0, pos);
    const lineNum = before.split('\n').length;
    const lineContent = lines[lineNum - 1]?.trim().slice(0, 100) || '';
    matches.push(`  行 ${lineNum}: ${lineContent}`);
  }
  return matches.join('\n');
}

// ═══════════════════════════════════════
// edit_file
// ═══════════════════════════════════════

export const editFile = {
  name: 'edit_file',
  description: `精确替换文件中的文本。old_string 必须在文件中恰好出现一次。
如果出现多次或未找到，工具会报错并给出提示。
优势：只用传差异片段，不需要传整个文件内容。
安全：限制在项目目录内，排除 node_modules/.git 等。`,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '文件绝对路径' },
      old_string: { type: 'string', description: '要替换的原文（必须在文件中唯一）' },
      new_string: { type: 'string', description: '替换后的新文本' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async invoke({ file_path, old_string, new_string }) {
    if (!file_path?.trim()) return '缺少 file_path';
    if (!old_string) return '缺少 old_string';
    if (old_string.length < 10) return 'old_string 太短（需 ≥10 字符），请提供更长的上下文以确保唯一匹配';

    const resolved = path.resolve(file_path.trim());
    if (!isSafePath(resolved)) return `安全限制：禁止操作 ${BLOCKED_DIRS.join(', ')} 目录`;
    if (!fs.existsSync(resolved)) return `文件不存在: ${resolved}`;

    let content;
    try { content = fs.readFileSync(resolved, 'utf-8'); }
    catch { return `无法读取文件: ${resolved}`; }

    // 统计出现次数
    const escaped = escapeRegex(old_string);
    const matches = content.match(new RegExp(escaped, 'g'));
    const count = matches ? matches.length : 0;

    if (count === 0) return `未找到匹配文本。文件: ${resolved}`;
    if (count > 1) {
      const lines = findLineNumbers(content, old_string);
      return `匹配文本出现 ${count} 次，不是唯一的。请提供更长的上下文（包含前后几行）来精确定位。\n出现位置:\n${lines}`;
    }

    // 唯一匹配 → 替换
    const updated = content.replace(old_string, new_string);
    try { fs.writeFileSync(resolved, updated, 'utf-8'); }
    catch (e) { return `写入失败: ${e.message}`; }

    log.log(`edit_file: ${resolved} — 1 处替换`);
    return `已替换 ${resolved} 中的 1 处匹配。`;
  },
};

// ═══════════════════════════════════════
// glob
// ═══════════════════════════════════════

export const glob = {
  name: 'glob',
  description: `文件名模式匹配。支持 **（任意层级）、*（单层任意字符）、?（单字符）、{a,b}（多选一）。
自动排除 node_modules、.git、dist 等目录。
最多返回 ${MAX_GLOB_RESULTS} 条，按修改时间降序排列。`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob 模式，如 **/*.vue、src/**/*.{js,ts}、server/*.js' },
      directory: { type: 'string', description: '搜索根目录，默认当前工作目录' },
    },
    required: ['pattern'],
  },
  async invoke({ pattern, directory }) {
    if (!pattern?.trim()) return '缺少 pattern';
    const base = directory?.trim() ? path.resolve(directory.trim()) : process.cwd();
    if (!fs.existsSync(base)) return `目录不存在: ${base}`;

    const results = collectGlob(pattern.trim(), base);

    // 按修改时间降序
    const withStats = results.map(r => {
      const full = path.join(base, r);
      try { return { path: r, mtime: fs.statSync(full).mtimeMs }; }
      catch { return { path: r, mtime: 0 }; }
    });
    withStats.sort((a, b) => b.mtime - a.mtime);

    const out = withStats.slice(0, MAX_GLOB_RESULTS);
    if (!out.length) return `未找到匹配 "${pattern}" 的文件`;

    const lines = out.map(f => `  ${f.path}`);
    const suffix = results.length > MAX_GLOB_RESULTS ? `\n...（共 ${results.length} 条，显示前 ${MAX_GLOB_RESULTS} 条）` : '';
    return `找到 ${results.length} 个匹配:\n${lines.join('\n')}${suffix}`;
  },
};

// ═══════════════════════════════════════
// grep
// ═══════════════════════════════════════

export const grep = {
  name: 'grep',
  description: `正则表达式搜索文件内容。返回文件路径 + 行号 + 匹配行内容，按文件分组。
支持 glob_filter 过滤文件名（如 "*.vue" 或 "*.{js,ts}"）。
跳过 >5MB 的文件和二进制文件。
每文件最多返回 10 条匹配，总输出上限 5000 字符。`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式，如 "function\\s+\\w+"、import.*from' },
      path: { type: 'string', description: '搜索目录或文件路径，默认项目根目录' },
      glob_filter: { type: 'string', description: '文件名过滤，如 "*.vue" 或 "*.{js,cjs}"，可选' },
    },
    required: ['pattern'],
  },
  async invoke({ pattern, path: searchPath, glob_filter }) {
    if (!pattern?.trim()) return '缺少 pattern';

    let re;
    try { re = new RegExp(pattern.trim(), 'gi'); }
    catch { return `无效的正则表达式: ${pattern}`; }

    const base = searchPath?.trim() ? path.resolve(searchPath.trim()) : process.cwd();
    if (!fs.existsSync(base)) return `路径不存在: ${base}`;

    // 收集文件（使用公共收集器）
    let files;
    if (fs.statSync(base).isFile()) {
      files = [base];
    } else {
      files = collectFiles(base, glob_filter?.trim() || null);
    }

    if (!files.length) return '未找到匹配的文件';

    const results = [];
    let totalChars = 0;

    for (const f of files) {
      if (totalChars > MAX_GREP_CHARS) { results.push('...(输出过长，已截断)'); break; }

      let stat;
      try { stat = fs.statSync(f); } catch { continue; }
      if (stat.size > MAX_FILE_SIZE) continue;

      let content;
      try { content = fs.readFileSync(f, 'utf-8'); } catch { continue; }

      // 跳过二进制
      if (content.includes('\x00')) continue;

      const lines = content.split('\n');
      const fileMatches = [];
      for (let i = 0; i < lines.length && fileMatches.length < 10; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          const trimmed = lines[i].trim().slice(0, 120);
          fileMatches.push(`  ${i + 1}: ${trimmed}`);
        }
      }

      if (fileMatches.length) {
        const relPath = path.relative(base, f).replace(/\\/g, '/');
        results.push(`${relPath}:`);
        for (const m of fileMatches) {
          results.push(m);
          totalChars += m.length + 1;
        }
        results.push('');
      }
    }

    if (!results.length) return `未找到匹配 "${pattern}" 的内容`;
    const out = results.join('\n').slice(0, MAX_GREP_CHARS);
    return out || '未找到匹配';
  },
};

// ═══════════════════════════════════════
// count_lines — 统计文件行数
// ═══════════════════════════════════════

export const countLines = {
  name: 'count_lines',
  description: `统计文件的代码行数。接受一个或多个文件路径，返回每个文件的行数。
比 read_file 轻量——不返回文件内容，只返回行数统计。`,
  parameters: {
    type: 'object',
    properties: {
      file_paths: {
        type: 'array',
        items: { type: 'string' },
        description: '文件路径列表，如 ["server/core/agent.js", "server/core/sub-agent.js"]',
      },
    },
    required: ['file_paths'],
  },
  async invoke({ file_paths }) {
    if (!file_paths?.length) return '请提供文件路径列表';
    const lines = [];
    let total = 0;
    for (const fp of file_paths) {
      const resolved = path.resolve(fp);
      if (!isSafePath(resolved)) { lines.push(`${fp}: 无权访问`); continue; }
      if (!fs.existsSync(resolved)) { lines.push(`${fp}: 不存在`); continue; }
      try {
        const content = fs.readFileSync(resolved, 'utf-8');
        const count = content.split('\n').length;
        lines.push(`${fp}: ${count} 行`);
        total += count;
      } catch { lines.push(`${fp}: 读取失败`); }
    }
    if (file_paths.length > 1) lines.push(`\n合计: ${total} 行`);
    return lines.join('\n');
  },
};

// ═══════════════════════════════════════
// 导出
// ═══════════════════════════════════════

export const fileOpsTools = [editFile, glob, grep, countLines];

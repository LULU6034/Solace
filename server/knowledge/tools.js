/**
 * kb-tools.js — Agent 知识库工具
 *
 * search_knowledge / lookup_knowledge
 * 基于 HybridRetriever 的混合检索（BM25 + 向量语义），
 * 通过 KBSchema 数据库查找摘要内容和来源文件信息。
 */
import { createModuleLogger } from '../lib/debug-log.js';
import { getRetriever, getSchema } from './tools-shared.js';

const log = createModuleLogger('kb-tools');

// ── 辅助：从 chunkId 反查内容与来源文件 ──

/**
 * 根据 chunkId 查询 chunks + files 表，获取内容摘要和文件路径。
 * @param {string} chunkId
 * @returns {Promise<{ content: string, filePath: string, filename: string } | null>}
 */
async function _lookupChunk(chunkId) {
  try {
    const schema = await getSchema();
    const db = schema.db;
    const stmt = db.prepare(
      `SELECT c.content, f.path, f.filename
       FROM chunks c
       LEFT JOIN files f ON c.file_id = f.id
       WHERE c.id = ?`,
    );
    stmt.bind([chunkId]);
    if (stmt.step()) {
      const [content, filePath, filename] = stmt.get();
      stmt.free();
      return { content, filePath, filename };
    }
    stmt.free();
  } catch (e) {
    log.warn(`chunk 查询失败 (${chunkId.slice(0, 16)}...): ${e.message}`);
  }
  return null;
}

/**
 * 截断内容文本，清理多余空白。
 * @param {string} content
 * @param {number} [maxLen=150]
 * @returns {string}
 */
function _formatContent(content, maxLen = 150) {
  if (!content) return '(内容不可用)';
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '...';
}

/**
 * 从 lookup 结果中提取友好的文件信息。
 * @param {{ filename?: string, filePath?: string } | null} info
 * @returns {string}
 */
function _formatFileInfo(info) {
  if (!info) return '未知来源';
  if (info.filename) return info.filename;
  if (info.filePath) {
    const parts = info.filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || info.filePath;
  }
  return '未知来源';
}

// ═══════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════

export const searchKnowledge = {
  name: 'search_knowledge',
  description:
    '在本地知识库中搜索信息。当用户问"你知道吗""查一下""知识库里有没有"或需要从已索引的项目文档、笔记中查找特定信息时使用。参数 query: 搜索关键词或自然语言问题。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词或自然语言问题' },
    },
    required: ['query'],
  },
  async invoke({ query }) {
    const q = String(query || '').trim();
    if (!q) return '请提供搜索关键词。';

    log.log(`search_knowledge: "${q}"`);
    const retriever = getRetriever();
    const results = await retriever.search(q, { topK: 5 });

    if (!results || results.length === 0) {
      return `知识库中没有找到关于「${q}」的相关信息。`;
    }

    const lines = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const chunk = await _lookupChunk(r.chunkId);
      const content = _formatContent(chunk ? chunk.content : null);
      const fileInfo = _formatFileInfo(chunk);
      const scorePct = (r.score * 100).toFixed(1);
      lines.push(`[${i + 1}] ${content} (来源: ${fileInfo}, 相关度: ${scorePct}%)`);
    }

    return `在知识库中找到 ${results.length} 条相关信息:\n${lines.join('\n')}`;
  },
};

export const lookupKnowledge = {
  name: 'lookup_knowledge',
  description:
    '精确查找知识库中的实体或概念。当用户想了解某个具体概念、人物、项目、术语或 API 的详细信息时使用。与 search_knowledge 的区别在于本工具会启用重排序以获得更精准的结果。参数 entity: 要查找的实体名称。',
  parameters: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: '要查找的实体名称' },
    },
    required: ['entity'],
  },
  async invoke({ entity }) {
    const e = String(entity || '').trim();
    if (!e) return '请提供要查找的实体名称。';

    log.log(`lookup_knowledge: "${e}"`);
    const retriever = getRetriever();
    const results = await retriever.search(e, { topK: 3, rerank: true });

    if (!results || results.length === 0) {
      return `知识库中没有找到关于「${e}」的相关信息。`;
    }

    const lines = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const chunk = await _lookupChunk(r.chunkId);
      const content = _formatContent(chunk ? chunk.content : null);
      const fileInfo = _formatFileInfo(chunk);
      lines.push(`[${i + 1}] ${content} (来源: ${fileInfo})`);
    }

    return `关于「${e}」:\n${lines.join('\n')}`;
  },
};

export const updateKBConfig = {
  name: 'update_kb_config',
  description: `修改知识库配置。用户说"把XX文件夹加到知识库""监控这个目录""改一下知识库设置"时使用。
参数 key: 配置项路径（如 'watch.paths'、'retrieval.top_k'）
参数 value: 新值（如 ['/home/user/notes']、10）
常用 key:
  watch.paths — 监控的文件夹列表
  watch.extensions — 监控的文件后缀
  retrieval.top_k — 搜索结果数量`,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '配置项路径，如 watch.paths' },
      value: { description: '新值' },
    },
    required: ['key', 'value'],
  },
  async invoke({ key, value }) {
    const { KBConfig } = await import('./config.js');
    const cfg = new KBConfig();
    cfg.load();
    cfg.set(key, value);
    const ok = cfg.save();

    if (ok) {
      // 如果改了监控相关配置，重启 watcher
      if (key === 'watch.paths' || key.startsWith('watch.')) {
        const { getActiveWatcher } = await import('./watcher.js');
        const watcher = getActiveWatcher();
        if (watcher) {
          try { await watcher.stop(); await watcher.start(); } catch {}
        }
      }
      const valStr = Array.isArray(value) ? value.join(', ') : String(value);
      const restartNote = (key === 'watch.paths' || key.startsWith('watch.')) ? ' 文件夹监控已重启。' : '';
      return `知识库配置已更新: ${key} = ${valStr}。${restartNote}`;
    }
    return '配置保存失败，请检查文件权限。';
  },
};

export const indexFileToKB = {
  name: 'index_file_to_kb',
  description: `将文件内容提取并存入知识库。用户说"把这个文件加到知识库""提取这个PDF的内容""索引这个文档"时使用。
参数 file_path: 文件的绝对路径。支持 .md/.txt/.pdf/.html 格式。PDF 会自动提取文字层或 OCR。`,
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '要索引的文件绝对路径' },
    },
    required: ['file_path'],
  },
  async invoke({ file_path }) {
    try {
      // 懒加载 KBIndexer（避免循环依赖）
      const { KBIndexer } = await import('./indexer.js');
      const indexer = new KBIndexer();
      await indexer.init();
      const result = await indexer.indexFile(file_path);
      if (result.success) {
        // 同时保存到知识库检索索引
        try {
          for (const chunk of result.chunks || []) {
            await indexer.retriever.indexChunk(chunk.id, chunk.content);
          }
        } catch (e) {
          // 检索索引更新失败不影响整体结果
        }
        return `文件已成功索引到知识库: ${file_path}\n- 分块数: ${result.chunkCount}\n- 文件ID: ${result.fileId}\n\n现在可以用 search_knowledge 搜索这个文件的内容了。`;
      }
      return `索引失败: ${result.reason || '未知错误'}`;
    } catch (err) {
      return `文件索引失败: ${err.message}`;
    }
  },
};

export const saveKnowledge = {
  name: 'save_knowledge',
  description:
    '保存网页或笔记到长期知识库。用户说"把这段存起来""收藏一下""保存这个知识点"时使用。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '笔记标题' },
      content: { type: 'string', description: 'Markdown 格式的笔记内容' },
      source_type: {
        type: 'string',
        enum: ['note', 'webpage', 'clip'],
        default: 'note',
        description: '来源类型: note(笔记) / webpage(网页) / clip(摘录)',
      },
      url: { type: 'string', description: '来源 URL（可选）' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签列表（可选）',
      },
    },
    required: ['title', 'content'],
  },
  async invoke({ title, content, source_type = 'note', url, tags }) {
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');

    const homeDir = os.homedir();
    const collectionsDir = path.join(homeDir, '.ai-desktop-pet', 'knowledge-base', 'collections');

    // 确保 collections 目录存在
    try {
      fs.mkdirSync(collectionsDir, { recursive: true });
    } catch (e) {
      return `保存失败: 无法创建目录 ${collectionsDir} (${e.message})`;
    }

    // 标题截断 (最长 100 字符)
    let safeTitle = String(title || '').trim();
    if (!safeTitle) return '请提供笔记标题。';
    if (safeTitle.length > 100) {
      safeTitle = safeTitle.slice(0, 100);
    }

    // 清理文件名中的非法字符
    let sanitized = safeTitle
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/^\.+/, '');

    // 生成文件名: YYYY-MM-DD_title-sanitized.md
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const filename = `${dateStr}_${sanitized}.md`;
    const filePath = path.join(collectionsDir, filename);

    // 构建 YAML frontmatter
    const created_at = now.toISOString();
    const frontmatter = [
      '---',
      `title: "${safeTitle.replace(/"/g, '\\"')}"`,
      `source_type: "${source_type}"`,
    ];
    if (url) {
      frontmatter.push(`url: "${url}"`);
    }
    if (tags && Array.isArray(tags) && tags.length > 0) {
      const tagList = tags.map(t => `"${String(t).replace(/"/g, '\\"')}"`).join(', ');
      frontmatter.push(`tags: [${tagList}]`);
    }
    frontmatter.push(`created_at: "${created_at}"`);
    frontmatter.push('---');

    const fileContent = frontmatter.join('\n') + '\n\n' + (content || '');

    // 写入文件
    try {
      fs.writeFileSync(filePath, fileContent, 'utf-8');
    } catch (e) {
      return `保存失败: 无法写入文件 (${e.message})`;
    }

    // 尝试触发索引（失败不影响保存结果）
    let indexed = false;
    try {
      const { KBIndexer } = await import('./indexer.js');
      const indexer = new KBIndexer();
      await indexer.init();
      const result = await indexer.indexFile(filePath);
      if (result.success) {
        try {
          for (const chunk of result.chunks || []) {
            await indexer.retriever.indexChunk(chunk.id, chunk.content);
          }
          indexed = true;
        } catch {
          // 检索索引更新失败不影响整体
        }
      }
    } catch (e) {
      log.warn(`索引失败（文件已保存）: ${e.message}`);
    }

    const indexNote = indexed ? ' 已索引到知识库。' : ' 索引暂未完成（文件已保存，稍后会自动索引）。';
    return `知识已保存: ${filename}\n路径: ${filePath}\n类型: ${source_type}${indexNote}`;
  },
};

export const showKBStatus = {
  name: 'show_kb_status',
  description:
    '查看知识库当前状态：有多少文件、文档、实体和关系。当用户问"知识库里有什么""知识库状态""有哪些资料""存了多少东西"时使用。不需要参数。',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async invoke() {
    try {
      const schema = await getSchema();
      const db = schema.db;

      // 统计各类数据
      const queries = {
        files: 'SELECT COUNT(*) as n FROM files WHERE status = \'active\'',
        chunks: 'SELECT COUNT(*) as n FROM chunks',
        entities: 'SELECT COUNT(*) as n FROM entities',
        facts: 'SELECT COUNT(*) as n FROM facts WHERE status = \'active\'',
        edges: 'SELECT COUNT(*) as n FROM edges',
        gaps: 'SELECT COUNT(*) as n FROM gaps WHERE status = \'open\'',
        recent: 'SELECT filename, ext, chunk_count, datetime(last_indexed/1000, \'unixepoch\', \'localtime\') as idx_time FROM files WHERE status = \'active\' ORDER BY last_indexed DESC LIMIT 10',
      };

      const counts = {};
      for (const [key, sql] of Object.entries(queries)) {
        try {
          const rows = db.exec(sql);
          if (key === 'recent') {
            counts.recent = rows[0]?.values || [];
          } else if (rows[0]?.values?.[0]) {
            counts[key] = rows[0].values[0][0];
          } else {
            counts[key] = 0;
          }
        } catch { counts[key] = key === 'recent' ? [] : 0; }
      }

      // 读取配置中的监控路径
      let watchPaths = [];
      try {
        const { KBConfig } = await import('./config.js');
        const cfg = new KBConfig();
        cfg.load();
        watchPaths = cfg.get('watch.paths') || [];
      } catch {}

      const lines = [];
      lines.push(`📊 知识库状态`);
      lines.push(`- 已索引文件: ${counts.files} 个`);
      lines.push(`- 文档分块: ${counts.chunks} 个`);
      lines.push(`- 知识实体: ${counts.entities} 个`);
      lines.push(`- 知识事实: ${counts.facts} 条`);
      lines.push(`- 图谱关系: ${counts.edges} 条`);
      lines.push(`- 待解决的知识缺口: ${counts.gaps} 个`);

      if (counts.recent && counts.recent.length > 0) {
        lines.push(`\n最近索引的文件:`);
        for (const [filename, ext, chunkCount, idxTime] of counts.recent) {
          lines.push(`  - ${filename} (${chunkCount || 0} 块, ${idxTime || '未知时间'})`);
        }
      }

      if (watchPaths.length > 0) {
        lines.push(`\n📁 自动监控目录: ${watchPaths.join(', ')}`);
      } else {
        lines.push(`\n💡 提示: 当前没有配置自动监控目录。可以用 update_kb_config 添加监控路径，或让用户把文件/文件夹拖入知识库。也可以直接用 save_knowledge 手动保存笔记。`);
      }

      if (counts.files === 0) {
        lines.push(`\n知识库目前是空的。可以用以下方式添加内容:`);
        lines.push(`  1. save_knowledge — 手动保存网页/笔记`);
        lines.push(`  2. index_file_to_kb — 索引指定文件（PDF/Markdown/文本）`);
        lines.push(`  3. update_kb_config key="watch.paths" — 设置自动监控目录`);
      }

      return lines.join('\n');
    } catch (err) {
      return `获取知识库状态失败: ${err.message}`;
    }
  },
};

export const kbTools = [searchKnowledge, lookupKnowledge, showKBStatus, updateKBConfig, indexFileToKB, saveKnowledge];

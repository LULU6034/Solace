/**
 * memory-tools.js — 记忆工具
 *
 * remember: 记住信息
 * recall: 搜索记忆
 */
import { getMemoryStore } from './memory-store-ref.js';

export const remember = {
  name: 'remember',
  description: '记住重要信息。参数 content: 要记住的内容，tags: 标签列表（可选，如 ["#user_name", "#preference"]）',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '要记住的内容' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
    },
    required: ['content'],
  },
  async invoke({ content, tags = [] }) {
    if (!content?.trim()) return '记忆内容不能为空';
    const store = getMemoryStore();
    if (!store) return '记忆存储未初始化';
    try {
      if (store.addFact) {
        store.addFact(content.trim(), tags);
      } else if (store.add) {
        store.add(content.trim());
      }
      return `已记住: ${content.slice(0, 100)}`;
    } catch (err) {
      return `记忆存储失败: ${err.message}`;
    }
  },
};

export const recall = {
  name: 'recall',
  description: '搜索之前记住的信息。参数 query: 搜索关键词（支持 #tag 标签搜索），k: 返回数量(默认3)',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词，支持 #tag 标签过滤' },
      k: { type: 'integer', description: '返回结果数量，默认3' },
    },
    required: ['query'],
  },
  async invoke({ query, k = 3 }) {
    if (!query?.trim()) return '搜索关键词不能为空';
    const store = getMemoryStore();
    if (!store) return '记忆存储未初始化';

    try {
      const results = store.search(query, Math.min(k || 3, 10));
      if (!results || results.length === 0) {
        return `未找到关于 "${query}" 的记忆`;
      }
      return results.map((r, i) => {
        const fact = typeof r === 'string' ? r : (r.fact || r.content || '');
        const tags = r.tags?.length ? ` [${r.tags.join(', ')}]` : '';
        return `${i + 1}. ${fact}${tags}`;
      }).join('\n');
    } catch (err) {
      return `记忆搜索失败: ${err.message}`;
    }
  },
};

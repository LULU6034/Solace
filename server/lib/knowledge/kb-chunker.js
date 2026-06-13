/**
 * kb-chunker.js — 可配置重叠的文本分块器
 *
 * 将长文本按 token 预算切分为带重叠的片段，
 * 使用优先级分隔符策略在近似 token 边界处分割。
 * 每个分块（除最后一块外）与前后的分块共享 overlapTokens 个字符的重叠，
 * 确保上下文在跨块检索时不丢失。
 */

import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('kb-chunker');

// ── 分隔符优先级（从高到低） ──
// 优先在段落/句子边界分割，其次在子句/短语边界，最后退回到单词边界
const SEPARATORS = [
  '\n\n',
  '\n',
  '。',
  '！',
  '？',
  '. ',
  '! ',
  '? ',
  '；',
  ';',
  '，',
  ',',
  ' ',
];

// 最小分块字符数：低于此阈值时直接强制分割，避免产生无意义的微小分块
const MIN_CHUNK_CHARS = 20;

// ── KBChunker 类 ──

export class KBChunker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxTokens=512]    每个分块的最大 token 估算数
   * @param {number} [opts.overlapTokens=64] 分块间重叠的字符数
   */
  constructor({ maxTokens = 512, overlapTokens = 64 } = {}) {
    this.maxTokens = maxTokens;
    this.overlapTokens = overlapTokens;
    // 副本，避免外部意外修改静态数组
    this._separators = [...SEPARATORS];
  }

  // ── Token 估算 ──

  /**
   * 估算文本的 token 数量（简单启发式，无需分词器）。
   *
   * 混合中英文文本：
   *   - 中文字符约 1.5 字符 / token
   *   - 英文单词约 0.75 词 / token
   *   - 综合取折中值 1.8 字符 / token
   *
   * @param {string} text
   * @returns {number}
   */
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 1.8);
  }

  // ── 分块 ──

  /**
   * 将文本切分为多个片段。
   *
   * @param {string} text — 输入文本
   * @returns {string[]} 分块数组
   */
  chunk(text) {
    const results = this.chunkWithMeta(text);
    return results.map((r) => r.content);
  }

  /**
   * 将文本切分为带元数据的分块。
   *
   * @param {string} text           — 输入文本
   * @param {object} [metadata={}]  — 附加到每个分块的元数据（浅拷贝）
   * @returns {Array<{ content: string, index: number, tokenCount: number, metadata: object }>}
   */
  chunkWithMeta(text, metadata = {}) {
    if (!text || typeof text !== 'string') return [];

    const targetChars = Math.floor(this.maxTokens * 1.8);
    const chunks = [];
    let start = 0;
    let index = 0;

    while (start < text.length) {
      const idealEnd = Math.min(start + targetChars, text.length);

      // 剩余文本已不足一个完整分块：作为最后一块直接输出
      if (idealEnd >= text.length) {
        const chunk = text.slice(start).trim();
        if (chunk) {
          chunks.push({
            content: chunk,
            index,
            tokenCount: this.estimateTokens(chunk),
            metadata: { ...metadata },
          });
        }
        break;
      }

      // 在 [start, idealEnd] 范围内从后往前搜索优先级最高的分隔符
      let splitPos = this._findSplitPos(text, start, idealEnd);

      // 未找到合适分隔符或分割点过近：强制在 idealEnd 处切分
      if (splitPos === -1 || splitPos - start < MIN_CHUNK_CHARS) {
        splitPos = idealEnd;
      }

      // 提取当前分块
      const chunk = text.slice(start, splitPos).trim();
      if (chunk) {
        chunks.push({
          content: chunk,
          index,
          tokenCount: this.estimateTokens(chunk),
          metadata: { ...metadata },
        });
        index++;
      }

      // 计算下一个分块的起始位置（带回退：减重叠字符数）
      const nextStart = splitPos - this.overlapTokens;
      // 确保向前推进，不倒退、不卡死
      start = nextStart > start && nextStart < splitPos ? nextStart : splitPos;

      if (splitPos >= text.length) break;
    }

    log.debug(
      `分块完成: ${chunks.length} 块, 总 token 估算 ${this.estimateTokens(text)}`,
    );
    return chunks;
  }

  // ── 内部方法 ──

  /**
   * 在指定范围内按优先级搜索最佳分割点。
   *
   * 对每个优先级的分隔符，在搜索范围内查找最后一次出现的位置；
   * 返回第一个（优先级最高）找到的匹配位置（含分隔符）。
   *
   * @param {string} text
   * @param {number} start    — 搜索范围起点
   * @param {number} idealEnd — 搜索范围终点（不含）
   * @returns {number} 分割位置（分隔符末尾的索引），未找到返回 -1
   */
  _findSplitPos(text, start, idealEnd) {
    const searchText = text.slice(start, idealEnd);

    for (const sep of this._separators) {
      const lastIdx = searchText.lastIndexOf(sep);
      if (lastIdx !== -1) {
        // 跳过紧贴搜索范围开头的分隔符（可能由上一块的 overlap 引入），
        // 除非只剩最低优先级分隔符可用
        if (lastIdx === 0 && sep !== this._separators[this._separators.length - 1]) {
          continue;
        }
        return start + lastIdx + sep.length;
      }
    }

    return -1;
  }
}

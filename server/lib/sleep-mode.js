/**
 * sleep-mode.js — 空闲后台反思
 *
 * 触发条件:
 * - 用户超过 30 分钟无互动
 * - 每天最多 2 次
 * - 单次超时 60 秒
 *
 * 反思内容:
 * 1. 最近对话的主题摘要
 * 2. 新发现的事实
 * 3. 用户行为模式变化
 */

import { createModuleLogger } from './debug-log.js';
import { createLLM } from '../core/llm-client.js';

const log = createModuleLogger('mem:sleep');

const MAX_PER_DAY = 2;
const IDLE_TRIGGER_MS = 30 * 60 * 1000;  // 30min idle
const TIMEOUT_MS = 60_000;               // 60s max
const COOLDOWN_MS = 4 * 60 * 60 * 1000;  // 4h between sessions

export class SleepMode {
  constructor({ memoryManager, agentManager, llmConfig }) {
    this.memoryManager = memoryManager;
    this.agentManager = agentManager;
    this.llmConfig = llmConfig || { provider: 'deepseek', model: 'deepseek-chat' };
    this.lastRun = 0;
    this.todayCount = 0;
    this.lastActivity = Date.now();
    this.dayReset = this._getDayKey();
    this.running = false;
  }

  /** Notify user activity (reset idle timer) */
  notifyActivity() {
    this.lastActivity = Date.now();
  }

  /** Check if sleep mode should trigger */
  shouldRun() {
    if (this.running) return false;

    const now = Date.now();
    const dayKey = this._getDayKey();

    // Reset daily counter
    if (dayKey !== this.dayReset) {
      this.dayReset = dayKey;
      this.todayCount = 0;
    }

    if (this.todayCount >= MAX_PER_DAY) return false;
    if (now - this.lastRun < COOLDOWN_MS) return false;
    if (now - this.lastActivity < IDLE_TRIGGER_MS) return false;

    return true;
  }

  /** Run sleep mode reflection */
  async run() {
    // 衰减旧事实（每次空闲反思时执行）
    try {
      const fs = this.memoryManager && this.memoryManager.factStore;
      if (fs && typeof fs.decayAll === 'function') {
        const n = fs.decayAll();
        if (n > 0) log.log(`记忆衰减: ${n} 条更新`);
      }
    } catch (e) {}
    if (!this.shouldRun()) return null;
    this.running = true;
    this.todayCount++;
    const t0 = Date.now();

    log.log(`Sleep Mode #${this.todayCount} 开始...`);

    try {
      const result = await this._reflect();
      this.lastRun = Date.now();
      log.log(`Sleep Mode done in ${Date.now() - t0}ms`);
      return result;
    } catch (err) {
      log.warn(`Sleep Mode 失败: ${err.message}`);
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Reflection logic */
  async _reflect() {
    // Gather recent turns
    const turns = (this.memoryManager?.shortTerm?.getAll?.() || []).slice(-15); // cap at 15 turns
    if (turns.length < 3) {
      log.log('对话太少，跳过反思');
      return null;
    }

    const dialog = turns.map(t =>
      `${t.role === 'user' ? '👤' : '🤖'}: ${(t.content || '').slice(0, 200)}`
    ).join('\n');

    const prompt = `你正在反思近期与用户的对话。基于以下对话，做三件事：

1. 用一句话总结对话主题
2. 提取 1-3 个关于用户的新事实或偏好
3. 判断用户当前情绪趋势（improving / stable / declining）

对话:
${dialog}

返回 JSON: {"summary": "...", "newFacts": [...], "emotionTrend": "stable", "importance": 1-5}`;

    try {
      const llm = createLLM({
        ...this.llmConfig,
        temperature: 0.3,
        maxTokens: 300,
        reasoningEffort: 'none',
      });

      const timeout = setTimeout(() => {
        throw new Error('Sleep reflection timeout');
      }, TIMEOUT_MS);

      let fullContent = '';
      for await (const chunk of llm.stream([
        { role: 'user', content: prompt }
      ])) {
        if (chunk.content) fullContent += chunk.content;
      }
      clearTimeout(timeout);

      // Parse JSON
      const jsonMatch = fullContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { raw: fullContent };

      const result = JSON.parse(jsonMatch[0]);

      // Save new facts
      if (result.newFacts?.length && this.memoryManager?.factStore) {
        for (const f of result.newFacts) {
          this.memoryManager.factStore.add({ fact: f, tags: ['sleep-reflection'] });
        }
      }

      log.log(`反思结果: ${result.summary?.slice(0, 60) || '(no summary)'}`);
      return result;
    } catch (err) {
      log.warn(`反思 LLM 调用失败: ${err.message}`);
      return null;
    }
  }

  _getDayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
}

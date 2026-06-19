/**
 * prompt-loader.js — 提示词管理
 *
 * 从 server/prompts/ 目录加载 .txt 文件，支持热加载。
 *
 * 用法:
 *   import { loadPrompt } from '../lib/prompt-loader.js';
 *   const prompt = loadPrompt('default');  // → server/prompts/default.txt
 *
 * 环境变量 PROMPT_HOT_RELOAD=true 时每次读取文件（开发模式），
 * 否则启动时缓存（生产模式）。
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createModuleLogger } from './debug-log.js';

const log = createModuleLogger('prompt-loader');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', 'prompts');
const HOT_RELOAD = process.env.PROMPT_HOT_RELOAD === 'true';

const _cache = new Map();

/**
 * @param {'default'|'voice'} name
 * @returns {string}
 */
export function loadPrompt(name) {
  if (!HOT_RELOAD && _cache.has(name)) {
    return _cache.get(name);
  }

  const filePath = join(PROMPTS_DIR, `${name}.txt`);
  if (!existsSync(filePath)) {
    throw new Error(`提示词文件不存在: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) {
    throw new Error(`提示词文件为空: ${filePath}`);
  }

  if (!HOT_RELOAD) {
    _cache.set(name, content);
  }
  return content;
}

/** 清除缓存（热加载用） */
export function clearPromptCache() {
  _cache.clear();
}

/**
 * 拼装完整 system prompt: L1(app-guide) + L2(tools-guide) + L4(mode)
 * L3 人格档案由 agent.js 动态注入，不在此处理。
 *
 * @param {'chat'|'voice'|'group'} mode
 * @returns {string}
 */
export function assembleSystemPrompt(mode = 'chat') {
  const parts = [];

  // L1: 软件说明书（所有模式共享）
  try { parts.push(loadPrompt('app-guide')); } catch (e) { log.warn('操作失败', e?.message || e); }

  // L2: 工具说明书（所有模式共享）
  try { parts.push(loadPrompt('tools-guide')); } catch (e) { log.warn('操作失败', e?.message || e); }

  // L4: 模式行为规则
  const modeFile = mode === 'voice' ? 'voice' : mode === 'group' ? 'group' : 'default';
  try { parts.push(loadPrompt(modeFile)); } catch (e) { log.warn(`提示词加载失败: ${modeFile}.txt, 回退到 default → ${e.message}`); parts.push(loadPrompt('default')); }

  return parts.join('\n\n');
}

/** 列出 prompts 目录下所有 .txt 文件（调试用） */
export function listPromptFiles() {
  try {
    return readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.txt'));
  } catch (e) {
    log.warn('操作失败', e?.message || e);
    return [];
  }
}

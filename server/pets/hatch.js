/**
 * hatch.js — 像素宠物生成器 v2
 *
 * 用户输入文字描述，LLM 输出 20×16 像素网格数据，
 * 包含 4 帧动画（idle呼吸、眨眼、走路），以及角色信息。
 */

import { createLLM } from './llm-client.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('hatch');

const HATCH_PROMPT = `你是一个像素艺术家。用户会描述一个角色，你需要生成一个 20×16 的像素精灵。

## 画布规格
- 宽度 20 列（索引 0-19），高度 16 行（索引 0-15）
- 每个格子：hex 颜色码 或 "transparent"（透明）
- 角色主体占画面 60-80%，居中，底部留 2-3 行空白

## 颜色限制
- 最多使用 8 种颜色（不含透明）
- 必须有层次：主体色、暗部色（加深20-30%）、亮部色（提亮20-30%）、强调色、描边色（最深）
- 角色轮廓用最深的描边色画 1px 外轮廓
- 用低饱和度的柔和色调，不要荧光色

## 动画帧（4帧，必须全部提供）
1. idle0 — 标准站立帧（必须）
2. idle1 — 呼吸/眨眼帧（和 idle0 比只改 2-6 个像素：闭眼、身体微缩 1px）
3. walk1 — 走路帧1（左脚前迈：身体上移 1px，左脚像素右移 1px）
4. walk2 — 走路帧2（右脚前迈：身体下移 1px，右脚像素左移 1px）

所有帧尺寸相同（20×16），必须全部提供。

## 输出格式（严格 JSON）
{
  "name": "中文名（2-4字）",
  "icon": "单字符emoji",
  "color": "#主题色hex",
  "description": "一句话描述",
  "sprite": {
    "idle0": [["#xxx","transparent",...共20个], ...共16行],
    "idle1": [...],
    "walk1": [...],
    "walk2": [...]
  }
}

只输出 JSON，不要 markdown 包裹，不要注释。`;

/**
 * Generate a pixel pet from a text description
 */
export async function hatchPet(config, description) {
  // Increase maxTokens for 20×16×4 = 1280 cells
  const llm = createLLM({ ...config, temperature: 0.8, maxTokens: 4096, reasoningEffort: 'none' });

  let raw = '';
  for await (const chunk of llm.stream([
    { role: 'system', content: HATCH_PROMPT },
    { role: 'user', content: `生成一个像素精灵：${description}` },
  ])) {
    if (chunk.content) raw += chunk.content;
  }

  // Parse JSON from LLM output
  try {
    return JSON.parse(raw.trim());
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (e) { log.warn('操作失败', e?.message || e); }
    }
  }
  return null;
}

const GRID_W = 20;
const GRID_H = 16;

/**
 * Validate and normalize hatched pet data (20×16 grid)
 */
export function validateHatch(data) {
  if (!data?.name || !data?.sprite?.idle0) return null;

  // Validate all frames
  const requiredFrames = ['idle0', 'idle1', 'walk1', 'walk2'];
  for (const key of requiredFrames) {
    const frame = data.sprite[key];
    if (!frame) { data.sprite[key] = data.sprite.idle0; continue; }
    if (!Array.isArray(frame) || frame.length !== GRID_H) return null;
    for (const row of frame) {
      if (!Array.isArray(row) || row.length !== GRID_W) return null;
    }
  }

  return {
    id: `hatched_${Date.now()}`,
    type: 'sprite',
    name: data.name || '未命名',
    icon: data.icon || '✨',
    color: data.color || '#6366F1',
    description: data.description || '',
    gridW: GRID_W,
    gridH: GRID_H,
    sprite: {
      idle0: data.sprite.idle0,
      idle1: data.sprite.idle1 || data.sprite.idle0,
      walk1: data.sprite.walk1 || data.sprite.idle0,
      walk2: data.sprite.walk2 || data.sprite.idle0,
    },
    createdAt: Date.now(),
  };
}

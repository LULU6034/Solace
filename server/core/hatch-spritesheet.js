/**
 * hatch-spritesheet.js — Codex 风格 spritesheet 宠物生成器
 *
 * 调用百炼通义万相，生成 3×3 像素精灵图（9 帧动画），
 * 保存为 .webp/.png，附带 pet.json 元数据。
 *
 * Spritesheet 布局 (3 cols × 3 rows):
 *   [idle]  [walk1] [working]
 *   [blink] [walk2] [jumping]
 *   [wave]  [failed] [review]
 *
 * 每帧 192×208 像素，总图 576×624 像素。
 */

import fs from 'node:fs';
import path from 'node:path';
import { generateImages } from '../lib/image-gen.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('hatch-spritesheet');

const FRAME_W = 192;
const FRAME_H = 208;
const COLS = 3;
const ROWS = 3;
const TOTAL_W = FRAME_W * COLS; // 576
const TOTAL_H = FRAME_H * ROWS; // 624

const SPRITESHEET_PROMPT = `Create a pixel art character spritesheet for a desktop pet. Follow these EXACT specifications:

## Technical Requirements
- Total canvas: ${TOTAL_W}x${TOTAL_H} pixels
- Grid: 3 columns × 3 rows of equal-sized frames
- Each frame: ${FRAME_W}x${FRAME_H} pixels
- Grid lines visible but subtle (1px light gray)
- Character centered in each frame, occupying ~60% of frame height

## Art Style
- Chibi pixel art, cute and expressive
- Bold 2px outline around the character
- Limited color palette (6-8 colors max)
- Flat cel shading, no gradients
- Hard pixel edges, no anti-aliasing
- Transparent background outside the character
- 16-bit game sprite aesthetic

## Frame Layout (3×3 grid, left-to-right, top-to-bottom)
Row 1: [idle standing] [walk frame 1 (left foot forward)] [working (typing/thinking)]
Row 2: [idle blink (eyes closed)] [walk frame 2 (right foot forward)] [jumping (mid-air)]
Row 3: [waving hand] [failed (dizzy/swirling eyes)] [review (holding magnifying glass)]

## Animation Notes
- idle→blink: only eyes change, body identical
- walk1→walk2: mirror leg positions, slight body bounce
- working: character looking busy, typing or thinking pose
- jumping: arms up, legs tucked, motion lines optional
- waving: one arm raised, friendly expression
- failed: dizzy eyes (spirals), slightly tilted
- review: holding a magnifying glass or clipboard

## Character Description
`;
// (character description appended by caller)

/**
 * Generate a Codex-style spritesheet pet
 * @param {object} imgConfig - { apiKey, model? }
 * @param {object} petDef - { name, icon, color, description }
 * @param {string} outputDir - where to save spritesheet + metadata
 * @returns {object} pet metadata
 */
export async function hatchSpritesheet(imgConfig, petDef, outputDir) {
  const prompt = SPRITESHEET_PROMPT + petDef.description;

  log.log(`生成 spritesheet: ${petDef.name} — ${petDef.description.slice(0, 60)}`);

  const images = await generateImages(imgConfig, prompt, {
    width: TOTAL_W,
    height: TOTAL_H,
    n: 1,
  });

  const spritesheetPath = images[0];
  if (!spritesheetPath) throw new Error('图片生成失败');

  // Copy to output dir
  fs.mkdirSync(outputDir, { recursive: true });
  const ext = path.extname(spritesheetPath) || '.png';
  const destName = `spritesheet${ext}`;
  const destPath = path.join(outputDir, destName);
  fs.copyFileSync(spritesheetPath, destPath);

  // Clean up temp file
  try { fs.unlinkSync(spritesheetPath); } catch {}

  // Build metadata
  const pet = {
    id: petDef.fixedId || `hatched_${Date.now()}`,
    type: 'spritesheet',
    name: petDef.name,
    icon: petDef.icon,
    color: petDef.color,
    description: petDef.description,
    spritesheet: destName,
    frameW: FRAME_W,
    frameH: FRAME_H,
    cols: COLS,
    rows: ROWS,
    frames: {
      // Map frame name → { col, row } (0-indexed)
      idle:    { col: 0, row: 0 },
      walk1:   { col: 1, row: 0 },
      working: { col: 2, row: 0 },
      blink:   { col: 0, row: 1 },
      walk2:   { col: 1, row: 1 },
      jumping: { col: 2, row: 1 },
      wave:    { col: 0, row: 2 },
      failed:  { col: 1, row: 2 },
      review:  { col: 2, row: 2 },
    },
    createdAt: Date.now(),
  };

  // Save metadata
  fs.writeFileSync(path.join(outputDir, 'pet.json'), JSON.stringify(pet, null, 2));
  log.log(`Spritesheet 完成: ${petDef.name} → ${destPath}`);

  return pet;
}

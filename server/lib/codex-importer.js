/**
 * codex-importer.js — Codex Pet 导入器
 *
 * 从 URL 或本地 .zip 文件导入 Codex Pet 包：
 *   1. 下载 / 读取 .zip
 *   2. 解压，验证 pet.json + spritesheet.webp
 *   3. 转换为内部 pet 元数据格式
 *   4. 保存到 ~/.ai-desktop-pet/imported-pets/{id}/
 *
 * Codex pet.json 格式: { id, displayName, description, spritesheetPath }
 * Codex spritesheet: 8列×9行 (1536×1872), 每帧 192×208
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { createModuleLogger } from './debug-log.js';

const log = createModuleLogger('codex-importer');

const IMPORTED_DIR = path.join(os.homedir(), '.ai-desktop-pet', 'imported-pets');

// Codex spritesheet constants
const CODEC_COLS = 8;
const CODEC_ROWS = 9;
const CODEC_FRAME_W = 192;
const CODEC_FRAME_H = 208;

/**
 * Import a Codex pet from a URL (zip download)
 * @param {string} url - URL to .codex-pet.zip or .zip file
 * @returns {Promise<object>} imported pet metadata
 */
export async function importFromUrl(url) {
  log.log(`导入 Codex 宠物: ${url}`);

  const zipPath = await downloadZip(url);
  try {
    const pet = await importFromZip(zipPath);
    log.log(`导入完成: ${pet.name}`);
    return pet;
  } finally {
    try { fs.unlinkSync(zipPath); } catch (e) { log.warn('操作失败', e?.message || e); }
  }
}

/**
 * Import a Codex pet from a local .zip file
 * @param {string} zipPath - path to .zip file
 * @returns {Promise<object>} imported pet metadata
 */
export async function importFromZip(zipPath) {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`文件不存在: ${zipPath}`);
  }

  // Use a temp directory for extraction
  const extractDir = path.join(os.tmpdir(), `codex_extract_${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    // Extract zip
    await extractZip(zipPath, extractDir);

    // Find and validate pet files
    const petJsonPath = path.join(extractDir, 'pet.json');
    const spritesheetPath = path.join(extractDir, 'spritesheet.webp');

    if (!fs.existsSync(petJsonPath)) {
      throw new Error('缺少 pet.json — 不是有效的 Codex Pet 包');
    }
    if (!fs.existsSync(spritesheetPath)) {
      throw new Error('缺少 spritesheet.webp — 不是有效的 Codex Pet 包');
    }

    // Parse Codex pet.json
    const codexJson = JSON.parse(fs.readFileSync(petJsonPath, 'utf-8'));
    const validation = validateCodexJson(codexJson);
    if (validation !== true) {
      throw new Error(`pet.json 无效: ${validation}`);
    }

    // Convert to internal format
    const pet = convertToInternal(codexJson);

    // Save to imported pets directory
    saveImportedPet(pet, spritesheetPath);

    return pet;
  } finally {
    // Cleanup temp extraction
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) { log.warn('操作失败', e?.message || e); }
  }
}

/**
 * List all imported Codex pets
 * @returns {Array<object>}
 */
export function listImportedPets() {
  fs.mkdirSync(IMPORTED_DIR, { recursive: true });

  const pets = [];
  const dirs = fs.readdirSync(IMPORTED_DIR, { withFileTypes: true });
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(IMPORTED_DIR, entry.name, 'pet.json');
    if (fs.existsSync(metaPath)) {
      try {
        pets.push(JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
      } catch { /* skip corrupted */ }
    }
  }
  return pets;
}

/**
 * Delete an imported pet
 * @param {string} petId
 */
export function deleteImportedPet(petId) {
  if (typeof petId !== 'string' || petId.includes('..') || petId.includes('/')) {
    throw new Error('无效的宠物 ID');
  }
  const dir = path.join(IMPORTED_DIR, petId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    log.log(`已删除: ${petId}`);
  }
}

// ── Internal helpers ──

function validateCodexJson(json) {
  if (!json || typeof json !== 'object') return '不是有效的 JSON 对象';
  if (!json.id || typeof json.id !== 'string') return '缺少 id 字段';
  if (!json.displayName || typeof json.displayName !== 'string') return '缺少 displayName 字段';
  if (!json.spritesheetPath) return '缺少 spritesheetPath 字段';
  // Sanitize: prevent path traversal
  if (json.spritesheetPath.includes('..') || path.isAbsolute(json.spritesheetPath)) {
    return 'spritesheetPath 不合法';
  }
  return true;
}

function convertToInternal(codexJson) {
  const petId = sanitizeId(codexJson.id);
  const now = Date.now();

  return {
    id: petId,
    source: 'codex',
    codexId: codexJson.id,          // preserve original Codex ID
    type: 'spritesheet',
    name: codexJson.displayName,
    icon: detectIcon(codexJson),
    color: '#6366F1',               // default indigo, can be overridden
    description: codexJson.description || '',
    spritesheet: 'spritesheet.webp',
    frameW: CODEC_FRAME_W,
    frameH: CODEC_FRAME_H,
    cols: CODEC_COLS,
    rows: CODEC_ROWS,
    // Codex frame mapping (row index → state name)
    frames: {
      // 0: idle, 1: walk, 2: working, 3: waiting, 4: running,
      // 5: jumping, 6: wave, 7: failed, 8: review
      idle:    { row: 0, cols: CODEC_COLS },
      walk:    { row: 1, cols: CODEC_COLS },
      working: { row: 2, cols: CODEC_COLS },
      waiting: { row: 3, cols: CODEC_COLS },
      running: { row: 4, cols: CODEC_COLS },
      jumping: { row: 5, cols: CODEC_COLS },
      wave:    { row: 6, cols: CODEC_COLS },
      failed:  { row: 7, cols: CODEC_COLS },
      review:  { row: 8, cols: CODEC_COLS },
    },
    codexFormat: true,
    createdAt: now,
  };
}

function saveImportedPet(pet, spritesheetSrc) {
  const dir = path.join(IMPORTED_DIR, pet.id);
  fs.mkdirSync(dir, { recursive: true });

  // Save internal pet.json
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify(pet, null, 2));

  // Copy spritesheet
  fs.copyFileSync(spritesheetSrc, path.join(dir, 'spritesheet.webp'));

  log.log(`保存完成: ${pet.name} → ${dir}`);
}

function sanitizeId(raw) {
  const safe = raw.toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'codex-pet';
  // Prefix to avoid collision with internal pets
  return `codex_${safe}`;
}

function detectIcon(json) {
  const desc = (json.description || '').toLowerCase();
  const name = (json.displayName || '').toLowerCase();
  const combined = `${name} ${desc}`;

  if (/cat|kitty|kitten|neko|猫/.test(combined)) return '🐱';
  if (/dog|puppy|犬|狗/.test(combined)) return '🐕';
  if (/bird|tori|鸟|雀/.test(combined)) return '🐦';
  if (/rabbit|bunny|兔/.test(combined)) return '🐰';
  if (/bear|熊/.test(combined)) return '🐻';
  if (/fox|狐/.test(combined)) return '🦊';
  if (/robot|mecha|机/.test(combined)) return '🤖';
  if (/ghost|ghoul|鬼/.test(combined)) return '👻';
  if (/dragon|龙/.test(combined)) return '🐉';
  if (/fish|sakana|鱼/.test(combined)) return '🐟';
  if (/penguin|企鹅/.test(combined)) return '🐧';
  if (/frog|蛙/.test(combined)) return '🐸';
  if (/pig|豚|猪/.test(combined)) return '🐷';
  if (/monkey|猿|猴/.test(combined)) return '🐵';
  if (/elephant|象/.test(combined)) return '🐘';
  if (/owl|fukurou|猫头鹰/.test(combined)) return '🦉';

  return '✨';
}

// ── Download & extract ──

function downloadZip(url, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadZip(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`下载失败: HTTP ${res.statusCode}`));
      }
      const tmpPath = path.join(os.tmpdir(), `codex_dl_${Date.now()}.zip`);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(tmpPath, Buffer.concat(chunks));
        log.log(`下载完成: ${(Buffer.concat(chunks).length / 1024).toFixed(0)} KB`);
        resolve(tmpPath);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
    req.on('error', reject);
  });
}

async function extractZip(zipPath, destDir) {
  // Dynamic import for AdmZip
  try {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);
  } catch {
    // Fallback: try unzip via child_process
    const { execSync } = await import('node:child_process');
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, { timeout: 30_000 });
  }
}

// ── Direct import from codex-pet.org API ──

const CODEC_API = 'https://codex-pet.org/api/pets';

/**
 * Import a pet directly from codex-pet.org by slug
 * @param {string} slug - pet slug (e.g. "ikkun", "clawd")
 * @returns {Promise<object>} imported pet metadata
 */
export async function importFromSlug(slug) {
  log.log(`通过 API 导入: ${slug}`);

  // 1. Fetch API
  const data = await fetchJson(CODEC_API);
  if (!Array.isArray(data)) throw new Error('API 返回格式异常');

  // 2. Find pet
  const petData = data.find(p => p.slug === slug);
  if (!petData) throw new Error(`未找到宠物 "${slug}"`);

  return importSlugData(petData);
}

/**
 * Search the codex-pet.org API
 * @param {string} query - search term
 * @returns {Promise<Array>} matching pets (limited to 20)
 */
export async function searchCodexPets(query) {
  const data = await fetchJson(CODEC_API);
  if (!Array.isArray(data)) throw new Error('API 返回格式异常');

  const q = query.toLowerCase();
  const matches = data.filter(p =>
    p.slug.toLowerCase().includes(q) ||
    (p.name || '').toLowerCase().includes(q) ||
    (p.description || '').toLowerCase().includes(q)
  ).slice(0, 20);

  return matches.map(p => ({
    slug: p.slug,
    name: p.name,
    description: p.description,
    creator: p.creator,
    likes: p.likes || 0,
    downloads: p.downloads || 0,
    image_url: p.image_url,
  }));
}

/**
 * Import from API pet data directly
 */
importFromSlug._importFromData = async function importFromApiData(petData) {
  return importSlugData(petData);
};

async function importSlugData(petData) {
  // Check if already imported
  const existing = listImportedPets().find(p => p.slug === petData.slug);
  if (existing) {
    log.log(`宠物 "${petData.slug}" 已导入，跳过`);
    return existing;
  }

  // Download spritesheet
  const spritesheetUrl = petData.image_url;
  if (!spritesheetUrl) throw new Error('宠物缺少 spritesheet URL');

  log.log(`下载 spritesheet: ${spritesheetUrl}`);
  const tmpPath = await downloadImage(spritesheetUrl);

  try {
    // Build internal pet.json format from API data
    const codexJson = {
      id: petData.slug,
      displayName: petData.name,
      description: petData.description || '',
      spritesheetPath: 'spritesheet.webp',
      slug: petData.slug,
      creator: petData.creator,
      rarity: petData.rarity,
      tags: petData.tags,
    };
    const pet = convertToInternal(codexJson);

    saveImportedPet(pet, tmpPath);
    log.log(`API 导入完成: ${pet.name}`);
    return pet;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) { log.warn('操作失败', e?.message || e); }
  }
}

// ── HTTP helpers ──

function fetchJson(url, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', reject);
  });
}

function downloadImage(url, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`下载图片失败: HTTP ${res.statusCode}`));
      const tmpPath = path.join(os.tmpdir(), `codex_img_${Date.now()}.webp`);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(tmpPath, Buffer.concat(chunks));
        log.log(`图片下载完成: ${(Buffer.concat(chunks).length / 1024).toFixed(0)} KB`);
        resolve(tmpPath);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
    req.on('error', reject);
  });
}

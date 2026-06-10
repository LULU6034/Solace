/**
 * image-gen.js — 阿里百炼通义万相 图片生成客户端
 *
 * 端点: POST /api/v1/services/aigc/multimodal-generation/generation
 * 返回的 OSS URL 5-10 分钟后过期，必须立即下载到本地。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { createModuleLogger } from './debug-log.js';

const log = createModuleLogger('image-gen');

const BAILIAN_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

/**
 * Generate an image via 百炼通义万相
 * @param {{ apiKey: string, model?: string }} config
 * @param {string} prompt - detailed image description
 * @param {{ width?: number, height?: number, n?: number }} opts
 * @returns {Promise<string[]>} local file paths
 */
export async function generateImages(config, prompt, { width = 1024, height = 1024, n = 1 } = {}) {
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('未配置百炼图片 API Key');

  const body = JSON.stringify({
    model: config.model || 'wanx2.1-t2i-turbo',
    input: {
      messages: [
        { role: 'user', content: [{ text: prompt }] },
      ],
    },
    parameters: {
      n,
      size: `${width}*${height}`,
      watermark: false,
      prompt_extend: true,
    },
  });

  log.log(`生成图片: ${prompt.slice(0, 80)}... ${width}x${height}`);

  const response = await fetch(BAILIAN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`百炼 API 错误 ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  // Response format: { output: { choices: [{ message: { content: [{ image: "url" }] } }] } }
  const choices = data?.output?.choices;
  if (!choices?.length) {
    log.warn(`百炼返回异常: ${JSON.stringify(data).slice(0, 300)}`);
    throw new Error('百炼未返回图片');
  }

  const urls = [];
  for (const choice of choices) {
    const contents = choice?.message?.content || [];
    for (const item of contents) {
      if (item.image) urls.push(item.image);
    }
  }

  if (!urls.length) throw new Error('百炼返回无图片 URL');

  // Download images immediately (OSS URLs expire in 5-10 min) — parallel
  const results = await Promise.allSettled(urls.map(url => downloadImage(url)));
  const savedPaths = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!savedPaths.length) throw new Error('所有图片下载失败');

  log.log(`生成完成: ${savedPaths.length} 张`);
  return savedPaths;
}

/**
 * Download an image from URL to a temp file
 */
function downloadImage(url, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`下载图片失败: ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const rawExt = path.extname((url || '').split('?')[0]) || '.png';
        const ext = rawExt.startsWith('.') ? rawExt : '.png';
        const fpath = path.join(os.tmpdir(), `bailian_img_${Date.now()}${ext}`);
        fs.writeFileSync(fpath, Buffer.concat(chunks));
        resolve(fpath);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('下载图片超时')); });
    req.on('error', reject);
  });
}

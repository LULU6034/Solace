/**
 * expert.js — 视觉子 Agent
 *
 * 固定 Qwen-VL 视觉分析 (对应 Python vision_expert.py)
 * - 并行多图分析，缓存，图片预处理
 * - 安全扫描（敏感信息检测）
 */
import { createLLM } from '../core/llm-client.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('vision');

const VISION_MODEL = 'qwen-vl-plus';
const VISION_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const PARALLEL_MAX = 5;
const SINGLE_TIMEOUT = 15_000;

const VISION_PROMPT = `你是图像分析专家。用中文输出严格的 JSON 格式。

## 分析要求
- summary: 一句话概述这是什么图 (≤40字)
- detail: 展开描述场景、物体、人物、颜色、氛围 (≤200字)
- ocr_text: 图片中所有文字，逐条列出。没有文字则为空数组
- objects: 画面中识别到的物体列表。不确定的标注"疑似:xxx"
- sensitive: 是否检测到身份证号/银行卡号/密码/私钥/手机号/地址/车牌等敏感个人信息
- quality: 图片质量。可选值: clear / blurry / too_small

## 输出格式 (严格 JSON, 无其他内容)
{
  "summary": "...",
  "detail": "...",
  "ocr_text": ["...", "..."],
  "objects": ["...", "..."],
  "sensitive": false,
  "quality": "clear"
}

## 铁律
- 图片里没有的东西不编造
- 模糊不清用 quality:"blurry"
- JSON 外不要有任何解释文字`;

const SENSITIVE_PATTERNS = [
  [/\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]/, '身份证号'],
  [/\d{16,19}/, '银行卡号'],
  [/1[3-9]\d{9}/, '手机号'],
  [/(password|passwd|secret|token|key)\s*[:=]\s*\S+/i, '凭据'],
  [/(sk-[A-Za-z0-9]+)/, 'API Key'],
];

const _cache = new Map();

function _scanSensitive(text) {
  const hits = [];
  for (const [pattern, label] of SENSITIVE_PATTERNS) {
    for (const m of (text || '').matchAll(new RegExp(pattern.source, pattern.flags.includes('i') ? 'gi' : 'g'))) {
      const value = m[0];
      hits.push({ type: label, value: value.slice(0, 20) + (value.length > 20 ? '...' : '') });
    }
  }
  return hits;
}

function _parseVisionOutput(text) {
  const cleaned = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*"summary"[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (e) { log.warn('JSON解析失败', e?.message || e); }
    }
  }
  return {
    summary: (text || '').slice(0, 80),
    detail: text || '',
    ocr_text: [],
    objects: [],
    sensitive: false,
    quality: 'clear',
    _parse_failed: true,
  };
}

export async function analyzeImages(images, userText, config) {
  if (!images?.length) {
    return { summary_text: '', results: [], sensitive_hits: [], stats: {} };
  }

  // Cache check
  const cacheKey = images.map(i => String(i).slice(0, 50)).join('|');
  if (_cache.has(cacheKey)) {
    log.log('视觉缓存命中');
    return _cache.get(cacheKey);
  }

  const visionApiKey = config.visionApiKey || config.apiKey || '';
  if (!visionApiKey) {
    return { summary_text: '视觉分析未配置 API Key', results: [], sensitive_hits: [], stats: {} };
  }

  const llm = createLLM({
    provider: 'openai', // Qwen-VL is OpenAI-compatible
    apiKey: visionApiKey,
    baseUrl: config.visionBaseUrl || VISION_BASE_URL,
    model: config.visionModel || VISION_MODEL,
    temperature: config.visionTemperature ?? 0.3,
    maxTokens: config.visionMaxTokens || 1024,
  });

  const t0 = Date.now();
  const allResults = [];
  const allSensitiveHits = [];
  let totalTokens = 0;
  let timeouts = 0;
  let errors = 0;

  // Process images in parallel batches
  for (let batch = 0; batch < images.length; batch += PARALLEL_MAX) {
    const batchImgs = images.slice(batch, batch + PARALLEL_MAX);
    const promises = batchImgs.map(async (dataUrl, i) => {
      const idx = batch + i;
      try {
        const prompt = userText
          ? `用户问题: ${userText}\n\n分析第 ${idx + 1} 张图片。`
          : `分析第 ${idx + 1} 张图片。`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SINGLE_TIMEOUT);

        const { content, usage } = await llm.invoke([
          { role: 'system', content: VISION_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ], { signal: controller.signal });

        clearTimeout(timer);

        if (usage) totalTokens += usage.total_tokens || 0;

        const parsed = _parseVisionOutput(content);
        parsed._img_idx = idx;

        // Security scan
        const fullText = JSON.stringify(parsed);
        const hits = _scanSensitive(fullText);
        for (const h of hits) h.img_idx = idx;
        allSensitiveHits.push(...hits);

        return { idx, parsed, status: 'ok' };
      } catch (err) {
        if (err.name === 'AbortError') {
          timeouts++;
          return { idx, parsed: null, status: 'timeout' };
        }
        errors++;
        return { idx, parsed: null, status: 'error', error: err.message };
      }
    });

    const batchResults = await Promise.allSettled(promises);
    for (const r of batchResults) {
      if (r.status === 'fulfilled') allResults.push(r.value);
      else {
        errors++;
        allResults.push({ idx: -1, parsed: null, status: 'error', error: r.reason?.message });
      }
    }
  }

  // Sort by index
  allResults.sort((a, b) => a.idx - b.idx);

  // Build summary
  const parts = [];
  const structuredResults = [];

  for (const r of allResults) {
    if (r.status === 'timeout') {
      parts.push(`[第${r.idx + 1}张图片分析超时]`);
      structuredResults.push({ idx: r.idx, status: 'timeout' });
      continue;
    }
    if (r.status === 'error') {
      parts.push(`[第${r.idx + 1}张图片分析失败: ${r.error || ''}]`);
      structuredResults.push({ idx: r.idx, status: 'error', error: r.error });
      continue;
    }

    const p = r.parsed;
    structuredResults.push(p);

    const prefix = images.length > 1 ? `[图片${r.idx + 1}] ` : '';
    let part = `${prefix}${p.summary || ''}\n${p.detail || ''}`;
    if (p.ocr_text?.length) part += `\n文字: ${p.ocr_text.slice(0, 5).join('; ')}`;
    if (p.quality === 'blurry') part += '\n(注意: 此图片较模糊)';
    parts.push(part);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const header = `[图片分析 · ${elapsed}s${totalTokens ? ` · ${totalTokens} tokens` : ''}]`;
  const summaryText = `${header}\n\n${parts.join('\n\n---\n\n')}`;

  if (allSensitiveHits.length) {
    // Note: vision found sensitive info, summarized
  }

  const result = {
    summary_text: summaryText,
    results: structuredResults,
    sensitive_hits: allSensitiveHits,
    stats: { elapsed: parseFloat(elapsed), total_tokens: totalTokens, timeouts, errors },
  };

  // Cache
  _cache.set(cacheKey, result);
  if (_cache.size > 20) _cache.delete(_cache.keys().next().value);

  return result;
}

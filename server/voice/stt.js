/**
 * stt.js — DashScope Paraformer 语音识别
 *
 * POST /api/v1/services/audio/asr/transcription
 * 文档: https://help.aliyun.com/zh/model-studio/paraformer
 */
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('stt');
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';

/**
 * @param {Buffer} audioBuffer - WAV/WebM 音频数据
 * @param {string} apiKey - DashScope API Key
 * @returns {Promise<{text: string, success: boolean}>}
 */
export async function transcribeAudio(audioBuffer, apiKey) {
  if (!apiKey) throw new Error('缺少 DashScope API Key');

  // DashScope 要求采样率 16000 的单声道 PCM/WAV
  // MediaRecorder 产的 WebM 需要先转码，这里直接 POST raw data
  const form = new FormData();
  form.append('model', 'paraformer-realtime-v2');
  form.append('format', 'wav');        // MediaRecorder 默认格式
  form.append('sample_rate', '16000');
  form.append('disfluency_removal_enabled', 'true');  // 过滤语气词
  form.append('file', new Blob([audioBuffer]), 'audio.wav');

  const res = await fetch(DASHSCOPE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DashScope STT ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  log.log(`STT 完成: ${data.output?.text?.length || 0} 字`);

  return {
    success: true,
    text: data.output?.text || '',
  };
}

/**
 * Deepgram 实时语音识别 — 替代 DashScope / SenseVoice
 *
 * 一个 WebSocket 搞定: VAD + 流式识别 + 情绪检测
 * 免费 $200 额度，永久有效
 *
 * 协议: wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&...
 * 文档: https://developers.deepgram.com/docs/streaming
 */

import WebSocket from 'ws';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('deepgram');

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';

export function createDeepgramASR(opts = {}) {
  const apiKey = opts.apiKey || process.env.DEEPGRAM_API_KEY || '';
  if (!apiKey) throw new Error('Deepgram API Key 缺失');

  let ws = null;
  let isConnected = false;
  let fullText = '';
  let lastEmotion = 'neutral';

  function connect() {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        model: 'nova-3',             // nova-3 中文识别优于 nova-2（实测验证）
        language: 'zh-CN',
        interim_results: 'true',
        punctuate: 'true',
        smart_format: 'true',        // 数字/日期/货币格式化
        endpointing: '300',          // 短句优化：300ms 静音即断句
        utterance_end_ms: '1000',    // 最长 1s 静音后强制结束
        no_delay: 'true',            // 实时模式，减少内部缓冲延迟
        vad_events: 'true',          // 启用 VAD 事件，辅助语音边界检测
        sentiment: 'true',
      });

      ws = new WebSocket(`${DEEPGRAM_URL}?${params}`, {
        headers: { Authorization: `Token ${apiKey}` },
      });

      ws.on('open', () => {
        log.log('Deepgram 已连接');
        isConnected = true;
        resolve();
      });

      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'Results') {
            const channel = msg.channel;
            const alts = channel?.alternatives || [];
            // 取最高置信度候选项
            let alt = alts[0];
            for (const a of alts) {
              if ((a.confidence || 0) > (alt?.confidence || 0)) alt = a;
            }
            if (!alt?.transcript) return;

            const text = alt.transcript;
            const isFinal = msg.is_final;
            const speechFinal = msg.speech_final;

            if (isFinal && text) {
              fullText += text;
              log.log(`最终: "${text}" (${fullText.length}字)`);
              opts.onResult?.({ text: fullText, isFinal: true, speechFinal });
              fullText = '';  // 清空，下一句重新累积
            } else if (text && !isFinal) {
              opts.onResult?.({ text, isFinal: false });
            }

            if (isFinal && alt.sentiment) {
              lastEmotion = alt.sentiment.sentiment || 'neutral';
              log.log(`情绪: ${lastEmotion}`);
              opts.onEmotion?.({ tag: lastEmotion, confidence: alt.sentiment.sentiment_score });
            }
          }
        } catch (e) { /* ignore */ }
      });

      ws.on('error', err => {
        log.error(`错误: ${err.message}`);
        isConnected = false;
        opts.onError?.(err);
        reject(err);
      });

      ws.on('close', (code) => {
        log.log(`关闭: ${code}`);
        isConnected = false;
        opts.onClose?.();
      });
    });
  }

  function sendAudio(buf) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(buf);
  }

  function sendFinish() {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
  }

  function close() {
    try { ws?.close(1000); } catch {}
    ws = null; isConnected = false; fullText = '';
  }

  return {
    connect, sendAudio, sendFinish, close,
    isReady: () => isConnected,
    resetText: () => { const t = fullText; fullText = ''; return t; },
  };
}

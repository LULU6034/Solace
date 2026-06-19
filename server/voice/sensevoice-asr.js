/**
 * DashScope SDK 桥接 — 连本地 Python asr-bridge.py
 * Python 用官方 SDK 调 DashScope，Node.js 只负责收发
 */
import WebSocket from 'ws';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('asr-sdk');
const DEFAULT_URL = 'ws://127.0.0.1:8765';

export function createSenseVoiceASR(opts = {}) {
  const wsUrl = opts.url || DEFAULT_URL;
  let ws = null, connected = false, fullText = '', currentEmotion = 'neutral';

  function connect(apiKey) {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(wsUrl);
      ws.on('open', () => {
        log.log(`已连接, 发送 init`);
        ws.send(JSON.stringify({ type: 'init', api_key: apiKey || opts.apiKey }));
        // 等 Python 启动 SDK
        setTimeout(() => { connected = true; resolve(); }, 500);
      });
      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.text) {
            fullText = msg.text;
            currentEmotion = msg.emotion || 'neutral';
            log.log(`识别: "${fullText}"`);
            opts.onResult?.({ text: fullText, isFinal: true });
          }
        } catch {}
      });
      ws.on('error', err => { log.error(err.message); connected = false; opts.onError?.(err); reject(err); });
      ws.on('close', () => { connected = false; opts.onClose?.(); });
    });
  }

  function sendAudio(buf) { if (ws?.readyState === WebSocket.OPEN) ws.send(buf); }
  function sendFinish() {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'finish' }));
  }
  function close() { try { ws?.close(); } catch {} ws = null; connected = false; }

  return {
    connect: () => connect(),
    sendAudio, sendFinish, close,
    isReady: () => connected,
    resetText: () => { const t = fullText; fullText = ''; return t; },
  };
}

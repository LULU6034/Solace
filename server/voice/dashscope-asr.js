/**
 * DashScope Qwen ASR 实时语音识别 WebSocket 客户端
 *
 * 协议: Qwen3 ASR Realtime（与 Lumi OS 同款）
 *   wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime
 *
 * 与旧 Fun-ASR 协议区别：
 *   - JSON 消息 + base64 编码音频（非裸二进制 PCM）
 *   - 内置 server_vad，不需要客户端 VAD 断句
 *   - 新模型 qwen3-asr-flash-realtime，中文识别精度更高
 *
 * 文档: https://help.aliyun.com/zh/model-studio/qwen-asr-realtime
 */

import WebSocket from 'ws';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('qwen-asr');

const QWEN_ASR_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime';

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {function} opts.onResult - ({ text, isFinal })
 * @param {function} opts.onError  - (Error)
 * @param {function} opts.onClose  - ()
 */
export function createRealtimeASR(opts = {}) {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error('DashScope API Key 缺失');

  let ws = null;
  let isConnected = false;
  let fullText = '';
  let eventCounter = 0;

  function nextId() {
    return `evt_${++eventCounter}_${Date.now()}`;
  }

  function connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(QWEN_ASR_URL, {
        headers: {
          'Authorization': `bearer ${apiKey}`,
        },
      });

      const audioQueue = [];
      let sessionReady = false;

      ws.on('open', () => {
        log.log('已连接，发送 session.update');
        ws.send(JSON.stringify({
          event_id: nextId(),
          type: 'session.update',
          session: {
            input_audio_format: 'pcm',
            sample_rate: 16000,
            input_audio_transcription: { enabled: true, language: 'zh' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.0,
              silence_duration_ms: 800,
              prefix_padding_ms: 300,
            },
          },
        }));
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          switch (msg.type) {
            case 'session.created':
              sessionReady = true;
              isConnected = true;
              log.log('Session 就绪');
              for (const chunk of audioQueue) {
                ws.send(JSON.stringify({
                  event_id: nextId(),
                  type: 'input_audio_buffer.append',
                  audio: Buffer.from(chunk).toString('base64'),
                }));
              }
              audioQueue.length = 0;
              resolve();
              break;

            case 'input_audio_buffer.speech_started':
              log.log('语音开始');
              break;

            case 'input_audio_buffer.speech_stopped':
              log.log('语音结束');
              break;

            case 'conversation.item.input_audio_transcription.text': {
              // 中间结果
              const text = (msg.text || '') + (msg.stash || '');
              if (text) {
                opts.onResult?.({ text, isFinal: false });
              }
              break;
            }

            case 'conversation.item.input_audio_transcription.completed': {
              // 最终结果
              const transcript = msg.transcript || '';
              log.log(`最终: "${transcript}"`);
              if (transcript) {
                fullText = transcript;
                opts.onResult?.({ text: transcript, isFinal: true });
              }
              break;
            }

            case 'session.finished':
              log.log('Session 完成');
              isConnected = false;
              opts.onClose?.();
              break;

            case 'error':
              log.error('服务端错误:', msg.message || msg);
              opts.onError?.(new Error(msg.message || 'Qwen ASR 服务端错误'));
              break;

            case 'heartbeat':
              // 服务端心跳，回复 pong
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'pong', event_id: nextId() }));
              }
              break;
          }
        } catch {
          // 非 JSON 消息，忽略
        }
      });

      ws.on('error', (err) => {
        log.error('WebSocket 错误:', err.message);
        isConnected = false;
        opts.onError?.(err);
        reject(err);
      });

      ws.on('close', (code) => {
        log.log(`关闭: code=${code}`);
        isConnected = false;
        opts.onClose?.();
      });
    });
  }

  function sendAudio(buf) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // 转换为 base64 发送
    const b64 = Buffer.from(buf).toString('base64');
    ws.send(JSON.stringify({
      event_id: nextId(),
      type: 'input_audio_buffer.append',
      audio: b64,
    }));
  }

  function sendFinish() {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event_id: nextId(), type: 'session.finish' }));
    }
  }

  function close() {
    try {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event_id: nextId(), type: 'session.finish' }));
        setTimeout(() => { try { ws.close(); } catch {} }, 300);
      }
    } catch {}
    ws = null;
    isConnected = false;
    fullText = '';
  }

  return {
    connect,
    sendAudio,
    sendFinish,
    close,
    isReady: () => isConnected,
  };
}

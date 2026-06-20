/**
 * Voice IPC — 语音通道 (Electron Main Process)
 *
 * 连接:
 *   Renderer (Vue) ← IPC → Main (this) ← WebSocket → Node.js Server
 *
 * 职责:
 *   1. 语音会话控制 (start/stop/interrupt)
 *   2. TTS 合成 (阿里云百炼 CosyVoice API)
 *   3. 字幕/状态事件转发
 */

const { ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Python 进程管理（轻量，仅 Flask + dashscope SDK）──
let pythonProcess = null;
let pythonPort = 5001;
// 供 main.cjs 在退出时精准终止
function getPythonProcess() { return pythonProcess; }
let _configKey = '';

// ── IPC Handlers ──

function getApiKeyFromConfig() {
    try {
      const { app, safeStorage } = require('electron');
      const configPath = path.join(app.getPath('userData'), 'config.enc');
      console.log('[voice-ipc] configPath:', configPath, 'exists:', fs.existsSync(configPath));
      if (!fs.existsSync(configPath)) { console.log('[voice-ipc] config.enc 文件不存在'); return process.env.DASHSCOPE_API_KEY || ''; }
      if (!safeStorage.isEncryptionAvailable()) {
        console.log('[voice-ipc] safeStorage 不可用，尝试明文读取');
        const raw = fs.readFileSync(configPath, 'utf-8');
        // 先尝试 base64 解码
        try {
          const buf = Buffer.from(raw, 'base64');
          const cfg = JSON.parse(buf.toString('utf-8'));
          console.log('[voice-ipc] base64 解码成功, keys:', Object.keys(cfg).join(','));
          return cfg.dashscopeApiKey || '';
        } catch {}
        // 再尝试明文 JSON
        try {
          const cfg = JSON.parse(raw);
          console.log('[voice-ipc] 明文读取成功, keys:', Object.keys(cfg).join(','));
          return cfg.dashscopeApiKey || '';
        } catch {}
        return process.env.DASHSCOPE_API_KEY || '';
      }
      const raw = fs.readFileSync(configPath, 'utf-8');
      const decrypted = safeStorage.decryptString(Buffer.from(raw, 'base64'));
      const cfg = JSON.parse(decrypted);
      console.log('[voice-ipc] 解密成功, keys:', Object.keys(cfg).join(','));
      return cfg.dashscopeApiKey || '';
    } catch (e) {
      console.error('[voice-ipc] 读取 API key 失败:', e.message);
    }
    return process.env.DASHSCOPE_API_KEY || '';
  }

  async function startPythonServer() {
    if (pythonProcess) return;
    const apiKey = _configKey || getApiKeyFromConfig();
    if (!apiKey) { console.log('[voice-ipc] No API key, skipping TTS server'); return; }

    // Try conda first, then PATH
    const candidates = [
      path.join(require('os').homedir(), 'miniconda3', 'python.exe'),
      path.join(require('os').homedir(), 'anaconda3', 'python.exe'),
      'python', 'python3',
    ];
    const python = candidates.find(p => {
      try { const r = require('child_process').spawnSync(p, ['--version']); return r.status === 0; }
      catch { return false; }
    });
    if (!python) { console.log('[voice-ipc] Python not found'); return; }
    const script = path.join(__dirname, '../..', 'scripts', 'cosyvoice-server.py');
    if (!fs.existsSync(script)) { console.log('[voice-ipc] Server script not found:', script); return; }

    console.log('[voice-ipc] Starting TTS API server...');
    const { spawn } = require('child_process');
    pythonProcess = spawn(python, [script, '--port', String(pythonPort)], {
      cwd: path.dirname(script),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DASHSCOPE_API_KEY: apiKey, PYTHONUNBUFFERED: '1' },
    });
    pythonProcess.stdout.on('data', d => console.log('[tts-srv]', d.toString().trim()));
    pythonProcess.stderr.on('data', d => console.log('[tts-srv]', d.toString().trim()));
    pythonProcess.on('exit', c => { console.log('[voice-ipc] TTS server exited', c); pythonProcess = null; });

    // Wait for ready
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const res = await fetch(`http://127.0.0.1:${pythonPort}/health`);
        if (res.ok) { console.log('[voice-ipc] TTS API server ready'); return; }
      } catch {}
    }
    console.log('[voice-ipc] TTS server start timeout');
  }

  // ── MiniMax API Key 读取 ──
  function getMiniMaxApiKey() {
    try {
      const { app, safeStorage } = require('electron');
      const configPath = path.join(app.getPath('userData'), 'config.enc');
      if (!fs.existsSync(configPath)) return '';
      const raw = fs.readFileSync(configPath, 'utf-8');
      let cfg;
      if (safeStorage.isEncryptionAvailable()) {
        cfg = JSON.parse(safeStorage.decryptString(Buffer.from(raw, 'base64')));
      } else {
        try { cfg = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')); } catch { cfg = JSON.parse(raw); }
      }
      return cfg.minimaxApiKey || '';
    } catch { return ''; }
  }

  // ── Sonder → MiniMax 情绪映射 ──
  // 文档确认 speech-2.8-turbo 支持 emotion 参数
  // 配合 voice_modify 微调音色 + 语气词标签注入文本
  // 情绪只影响语速，不改音色/pitch/emotion 参数
  const EMOTION_PRESETS = {
    happy:       { speedMul: 1.10, pitch:  2, mmEmotion: 'happy' },
    sad:         { speedMul: 0.88, pitch: -2, mmEmotion: 'sad' },
    angry:       { speedMul: 1.15, pitch:  3, mmEmotion: 'angry' },
    worried:     { speedMul: 0.92, pitch: -1, mmEmotion: 'fearful' },
    encouraging: { speedMul: 1.05, pitch:  1, mmEmotion: 'fluent' },
    funny:       { speedMul: 1.08, pitch:  2, mmEmotion: 'happy' },
    sarcastic:   { speedMul: 1.05, pitch:  1, mmEmotion: 'fluent' },
    gentle:      { speedMul: 0.85, pitch:  0, mmEmotion: 'calm' },
    neutral:     { speedMul: 1.0,  pitch:  0, mmEmotion: 'calm' },
  };

  // ── MiniMax 音色 (v1 不支持 emotion/pitch/标签) ──
  const MINIMAX_VOICES = {
    default_female: 'Chinese (Mandarin)_Gentleman',  // 中文绅士男声
    default_male: 'male-qn-jingying',
    gentle_female: 'female-yousheng',
    young_male: 'male-qn-qingse',
    cloned: 'sonder_v2',                  // 克隆音色 v2
  };

  function registerVoiceIPC(configApiKey) {
    if (configApiKey) _configKey = configApiKey;
    // TTS 服务懒启动——首次 TTS 请求时才启动，避免阻塞 app 启动

    // ── TTS 合成 ──
    ipcMain.handle('voice-tts-synthesize', async (event, { text, emotion, voiceId, speed }) => {
      const wc = event.sender;
      console.log('[voice-ipc] TTS:', text?.slice(0, 30), '| len:', text?.length);

      // ═══ MiniMax 主路径 ═══
      const mmKey = getMiniMaxApiKey();
      if (mmKey) {
        try {
          const mmVoiceId = MINIMAX_VOICES[voiceId] || MINIMAX_VOICES.default_female;
          const preset = EMOTION_PRESETS[emotion] || EMOTION_PRESETS.neutral;
          const mmSpeed = Math.max(0.5, Math.min(2.0, (parseFloat(speed) || 1.0) * preset.speedMul));

          console.log('[voice-ipc] MiniMax TTS:', mmVoiceId, 'speed:', mmSpeed);

          const mmRes = await fetch('https://api.minimax.chat/v1/t2a_v2', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${mmKey}`,
            },
            body: JSON.stringify({
              model: 'speech-2.8-turbo',
              text,
              stream: false,
              voice_setting: {
                voice_id: mmVoiceId,
                speed: mmSpeed,
                vol: 1.0,
              },
              audio_setting: {
                sample_rate: 32000,
                format: 'mp3',
              },
              language_boost: 'auto',
            }),
            signal: AbortSignal.timeout(30_000),
          });

          const mmJson = await mmRes.json();
          if (mmJson.base_resp?.status_code !== 0) {
            throw new Error(mmJson.base_resp?.status_msg || 'MiniMax API error');
          }
          const audioRaw = mmJson.data?.audio || mmJson.audio;
          if (!audioRaw) throw new Error('MiniMax 返回空音频');

          // MiniMax 返回 hex 编码的 mp3，转为 base64 兼容现有管线
          const audioBuf = Buffer.from(audioRaw, 'hex');
          const audioB64 = audioBuf.toString('base64');
          console.log('[voice-ipc] MiniMax 音频:', audioBuf.length, 'bytes');

          // 包装为与 CosyVoice 兼容的 ndjson chunk 格式
          wc.send('cv-tts-chunk', { audio: audioB64 });
          return { engine: 'minimax' };
        } catch (err) {
          console.error('[voice-ipc] MiniMax 失败，降级到 CosyVoice:', err.message);
          // 降级到 CosyVoice
        }
      }

      // ═══ CosyVoice 降级路径 ──
      await startPythonServer();  // 懒启动
      try {
        const res = await fetch(`http://127.0.0.1:${pythonPort}/tts/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, emotion: emotion || 'neutral', voice_id: voiceId || 'default_female', speed: speed || 1.0 }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { error: err.error || `HTTP ${res.status}` };
        }
        // 流式读取 ndjson，逐块推送
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // 最后一次 decode 不用 stream 模式，确保 decoder 内部缓冲全部 flush
            if (value) buf += decoder.decode(value);
            // flush 残余缓冲区：最后一行可能没有 \n 结尾
            if (buf.trim()) {
              try { wc.send('cv-tts-chunk', JSON.parse(buf)) }
              catch { /* 最后一个 chunk 解析失败，丢弃（极少情况） */ }
            }
            break;
          }
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try { wc.send('cv-tts-chunk', JSON.parse(line)) }
            catch { buf = line + buf }
          }
        }
        return { engine: 'cosyvoice-api' };
      } catch (err) { return { error: err.message }; }
    });

  // ── 语音会话控制 ──
  ipcMain.handle('voice-session-start', async () => {
    const bridge = global.__agentBridge;
    if (!bridge) return { error: 'No agent bridge' };

    return await new Promise((resolve) => {
      const requestId = `vs_${Date.now()}`;
      bridge.ws.send(JSON.stringify({
        type: 'voice_session_start',
        request_id: requestId,
        agent_id: 'default',
      }));

      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.request_id === requestId && msg.type === 'voice_session_ready') {
            bridge.ws.removeListener('message', handler);
            resolve(msg.data);
          }
        } catch {}
      };
      bridge.ws.on('message', handler);
      setTimeout(() => {
        bridge.ws.removeListener('message', handler);
        resolve({ error: 'Session start timeout' });
      }, 10_000);
    });
  });

  ipcMain.handle('voice-session-stop', async () => {
    const bridge = global.__agentBridge;
    if (!bridge) return;
    bridge.ws.send(JSON.stringify({ type: 'voice_session_stop' }));
    return { ok: true };
  });

  // ── 打断 ──
  ipcMain.handle('voice-interrupt', async () => {
    const bridge = global.__agentBridge;
    if (!bridge) return;
    bridge.ws.send(JSON.stringify({ type: 'voice_interrupt' }));
    return { ok: true };
  });

  // ── 语音列表 ──
  ipcMain.handle('voice-get-voices', async () => {
    return { voices: [
      { id: 'default_female', name: '默认女声' },
      { id: 'default_male', name: '默认男声' },
    ]};
  });

  // ── 音色克隆 / 删除 (API 暂不支持) ──
  ipcMain.handle('voice-clone-voice', async () => ({ added: false, note: 'API 模式暂不支持克隆' }));
  ipcMain.handle('voice-delete-voice', async () => ({ deleted: false, note: 'API 模式暂不支持' }));

  console.log('[voice-ipc] Voice IPC handlers registered');
}

// ── Event forwarding: Server → Renderer ──

function setupVoiceEventForwarding(bridge) {
  if (!bridge) return;

  bridge.on('voice_chunk', (data) => {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) win.webContents.send('voice-chunk', data);
    }
  });

  bridge.on('voice_tts_done', (data) => {
    // TTS 完成 → 通知渲染端
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) win.webContents.send('tts-stop', {});
    }
  });

  bridge.on('voice_tts_chunk', (data) => {
    console.log('[voice-ipc] voice_tts_chunk event:', data?.data?.engine || data?.engine, 'audio len:', data?.data?.audio?.length || data?.audio?.length || '?');
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('voice-chunk', {
          audio: data?.data?.audio || data?.audio,
          sampleRate: data?.data?.sample_rate || data?.sampleRate || 24000,
          engine: data?.data?.engine || data?.engine || 'cosyvoice',
        });
      }
    }
  });

  bridge.on('voice_state', (data) => {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('voice-state', data);
      }
    }
  });

  bridge.on('voice_subtitle', (data) => {
    // Only to chat window
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('voice-subtitle', data);
      }
    }
  });
}

function setApiKeyAndRetry(key) {
  if (!key) return;
  _configKey = key;
  if (pythonProcess) return; // 已在运行，无需重启
  console.log('[voice-ipc] 收到 API key, 尝试启动 TTS...');
  startPythonServer();
}

module.exports = {
  registerVoiceIPC,
  setupVoiceEventForwarding,
  setApiKeyAndRetry,
  getPythonProcess,
};

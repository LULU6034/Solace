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
    const script = path.join(__dirname, '..', 'python', 'cosyvoice-server.py');
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

  function registerVoiceIPC(configApiKey) {
    if (configApiKey) _configKey = configApiKey;
    // 启动 Python TTS 服务
    startPythonServer();

    // ── TTS 合成 (调本地 Python 服务，Python 调 DashScope SDK) ──
    ipcMain.handle('voice-tts-synthesize', async (event, { text, emotion, voiceId, speed }) => {
      const wc = event.sender;
      console.log('[voice-ipc] TTS:', text?.slice(0, 30));
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
          if (done) break;
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
  console.log('[voice-ipc] 收到 API key, 尝试启动 TTS...');
  startPythonServer();
}

module.exports = {
  registerVoiceIPC,
  setupVoiceEventForwarding,
  setApiKeyAndRetry,
};

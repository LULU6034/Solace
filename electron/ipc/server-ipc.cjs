/**
 * server-ipc.cjs — Electron ↔ Node.js Agent Server 桥接
 *
 * 替代 python-bridge.cjs — 用 WebSocket 替代 stdin/stdout JSON-line。
 *
 * 架构:
 *   Electron main process spawns Node.js server child process
 *   → Server listens on 127.0.0.1:{port} (WebSocket)
 *   → Electron connects via WebSocket
 *   → IPC events forwarded between renderer and server
 */
const { spawn } = require('child_process');
const path = require('path');
const { app, ipcMain } = require('electron');
const WebSocket = require('ws');

const AGENT_PORT = 19876;
const MAX_RESTARTS = 3;

class ServerBridge {
  constructor() {
    this.process = null;
    this.ws = null;
    this.ready = false;
    this.port = AGENT_PORT;
    this.persistDir = '';
    this.restartCount = 0;
    this.eventHandlers = new Map(); // eventType → [callbacks]
    this._reconnectTimer = null;
    this._connecting = false;
    this._connectResolve = null; // Resolve _connect() promise on ready
    this._startPromise = null;   // Prevent concurrent starts
    this._deepseekApiKey = '';   // Stagehand browse 工具用
    this._stopping = false;      // 正在停止，禁止自动重启
  }

  setApiKey(key) { this._deepseekApiKey = key; }

  /**
   * Start the Node.js Agent Server as a child process
   */
  async start(apiKey) {
    if (this.ready) return true;
    // Prevent concurrent start calls
    if (this._startPromise) return this._startPromise;
    if (apiKey) this._deepseekApiKey = apiKey;

    this._startPromise = this._doStart();
    const result = await this._startPromise;
    this._startPromise = null;
    return result;
  }

  async _doStart() {
    if (this.ready) return true;

    const isDev = process.env.ELECTRON_IS_DEV === 'true' || !app.isPackaged;
    const projectRoot = isDev ? path.join(__dirname, '../..') : process.resourcesPath;

    this.persistDir = path.join(app.getPath('userData'), 'agent-data');
    require('fs').mkdirSync(this.persistDir, { recursive: true });

    // Kill any existing process on the port
    await this._killPortProcess();

    const serverScript = isDev
      ? path.join(projectRoot, 'server', 'bootstrap.js')
      : path.join(process.resourcesPath, 'server', 'bootstrap.js');

    console.log(`[server-ipc] 启动 Node.js Agent Server: ${serverScript}`);
    console.log(`[server-ipc] persist: ${this.persistDir}, port: ${this.port}`);

    this.process = spawn('node', [serverScript], {
      env: {
        ...process.env,
        AGENT_PERSIST_DIR: this.persistDir,
        AGENT_PORT: String(this.port),
        AGENT_LOG_MODULES: '*',
        AGENT_LOG_LEVEL: 'log',
        NODE_ENV: isDev ? 'development' : 'production',
        // HuggingFace 国内镜像（解决 bge-micro-v2 模型下载失败）
        HF_ENDPOINT: 'https://hf-mirror.com',
        DEEPSEEK_API_KEY: this._deepseekApiKey || '',
        LLM_BASE_URL: 'https://api.deepseek.com/v1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.stdout.on('data', (chunk) => {
      console.log(`[server] ${chunk.toString().trim()}`);
    });

    this.process.stderr.on('data', (chunk) => {
      // Server logs go to stderr
      const text = chunk.toString().trim();
      if (text) console.log(`[server] ${text}`);
    });

    this.process.on('error', (err) => {
      console.error(`[server-ipc] 进程错误: ${err.message}`);
      this.ready = false;
    });

    this.process.on('close', (code, signal) => {
      console.log(`[server-ipc] Server 进程退出 code=${code} signal=${signal}`);
      this.ready = false;
      this.process = null;
      this.ws = null;

      // Auto-restart in dev mode (skip if intentionally stopping)
      if (!this._stopping && code !== 0 && this.restartCount < MAX_RESTARTS) {
        this.restartCount++;
        console.log(`[server-ipc] 自动重启 (${this.restartCount}/${MAX_RESTARTS})...`);
        setTimeout(() => this.start(), 2000);
      }
    });

    // Connect via WebSocket
    return await this._connect();
  }

  async _connect() {
    return new Promise((resolve) => {
      this._connectResolve = resolve; // Store for _handleEvent to call on ready

      const tryConnect = (attempt = 1) => {
        if (attempt > 30) {
          console.error('[server-ipc] WebSocket 连接超时 (30次尝试)');
          resolve(false);
          return;
        }

        const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

        ws.on('open', () => {
          console.log('[server-ipc] WebSocket 已连接');
          this.ws = ws;
          this.restartCount = 0;
          this._connecting = false;

          ws.on('message', (raw) => {
            try {
              const event = JSON.parse(raw.toString());
              this._handleEvent(event);
            } catch (err) {
              console.error('[server-ipc] JSON 解析失败:', raw.toString().slice(0, 200));
            }
          });

          ws.on('close', (code) => {
            console.log(`[server-ipc] WebSocket 断开 code=${code}`);
            this.ready = false;
            if (this.process) {
              this._reconnect();
            }
          });

          ws.on('error', (err) => {
            console.error(`[server-ipc] WebSocket 错误: ${err.message}`);
          });

          // Wait for ready event
          const readyTimeout = setTimeout(() => {
            if (!this.ready) {
              console.error('[server-ipc] 等待 ready 超时');
              this.ready = true; // proceed anyway
              resolve(true);
            }
          }, 10000);
        });

        ws.on('error', () => {
          // Server not ready yet, retry
          ws.close();
          setTimeout(() => tryConnect(attempt + 1), 500);
        });
      };

      tryConnect();
    });
  }

  async _reconnect() {
    if (this._connecting) return;
    this._connecting = true;
    console.log('[server-ipc] 尝试重连...');
    await this._connect();
  }

  async _killPortProcess() {
    // Windows: netstat to find and kill process on port
    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        const out = execSync(`netstat -ano | findstr :${this.port}`, { encoding: 'utf-8', windowsHide: true });
        const match = out.match(/LISTENING\s+(\d+)/);
        if (match) {
          execSync(`taskkill /PID ${match[1]} /F`, { windowsHide: true });
          console.log(`[server-ipc] 已终止端口 ${this.port} 上的进程 ${match[1]}`);
          await new Promise(r => setTimeout(r, 500));
        }
      } catch {
        // Process not found — fine
      }
    } else {
      try {
        const { execSync } = require('child_process');
        execSync(`lsof -ti:${this.port} | xargs kill -9`, { encoding: 'utf-8' });
        await new Promise(r => setTimeout(r, 500));
      } catch {}
    }
  }

  _handleEvent(event) {
    const eventType = event.type;

    // Mark ready
    if (eventType === 'ready') {
      this.ready = true;
      console.log('[server-ipc] Agent Server 就绪');
      // Resolve _connect() promise immediately (no more 10s wait)
      if (this._connectResolve) {
        this._connectResolve(true);
        this._connectResolve = null;
      }
      return;
    }

    // Forward to registered handlers
    this._emitEvent(eventType, event);
  }

  _emitEvent(eventType, data) {
    const handlers = this.eventHandlers.get(eventType);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(data); } catch (e) { console.error('[server-ipc] handler error:', e); }
      }
    }
    const starHandlers = this.eventHandlers.get('*');
    if (starHandlers) {
      for (const handler of starHandlers) {
        try { handler(eventType, data); } catch (e) {}
      }
    }
  }

  /**
   * Send a message to the server via WebSocket
   */
  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Server WebSocket 未连接');
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Register an event listener
   * Returns unsubscribe function
   */
  on(eventType, handler) {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    this.eventHandlers.get(eventType).push(handler);
    return () => {
      const handlers = this.eventHandlers.get(eventType);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
    };
  }

  isReady() {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  stop() {
    this._stopping = true;  // 禁止自动重启
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    if (this.process) {
      try { this.process.kill('SIGKILL'); } catch {}
      this.process = null;
    }
    this.ready = false;
  }
}

module.exports = { ServerBridge };

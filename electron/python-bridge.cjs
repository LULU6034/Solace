/**
 * Python 子进程桥接器
 * 管理 Python Agent 进程的生命周期,实现 stdin/stdout JSON 行协议
 */
const { spawn } = require('child_process');
const path = require('path');
const { app } = require('electron');
const fs = require('fs');

class PythonBridge {
  constructor() {
    this.process = null;
    this.ready = false;
    this.persistDir = '';
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timer }
    this.eventHandlers = new Map();   // eventType -> [callbacks]
    this.requestCounter = 0;
    this.restartCount = 0;
    this.maxRestarts = 3;
    this._stdoutBuffer = '';
  }

  /**
   * 启动 Python 进程
   */
  start() {
    // 已经启动了 — 返回状态
    if (this.process) {
      if (this.ready) return Promise.resolve(true);
      // 进程存在但还没 ready, 等待
      return new Promise((resolve) => {
        const check = () => {
          if (this.ready) resolve(true);
          else if (!this.process) resolve(false);
          else setTimeout(check, 50);
        };
        check();
      });
    }

    this.persistDir = path.join(app.getPath('userData'), 'agent-data');
    fs.mkdirSync(this.persistDir, { recursive: true });

    const isDev = process.env.ELECTRON_IS_DEV === 'true' || !app.isPackaged;
    const projectRoot = isDev
      ? path.join(__dirname, '..')
      : path.join(process.resourcesPath, '..');

    let cmd, args;

    if (isDev) {
      cmd = 'python';
      args = [
        path.join(projectRoot, 'python', 'agent_service.py'),
      ];
    } else {
      // 生产模式: PyInstaller 打包的 exe
      cmd = path.join(process.resourcesPath, 'python', 'agent_service.exe');
      args = [];
    }

    console.log(`[python-bridge] 启动: ${cmd} ${args.join(' ')}`);

    this.process = spawn(cmd, args, {
      env: {
        ...process.env,
        AGENT_PERSIST_DIR: this.persistDir,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this._stdoutBuffer = '';

    // stdout: 解析 JSON 行事件
    this.process.stdout.on('data', (chunk) => {
      this._stdoutBuffer += chunk.toString('utf-8');
      const lines = this._stdoutBuffer.split('\n');
      // 最后一个可能是不完整的行
      this._stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line.trim());
          this._handleEvent(event);
        } catch (e) {
          console.error('[python-bridge] JSON 解析失败:', line.slice(0, 200));
        }
      }
    });

    // stderr: 记录日志
    this.process.stderr.on('data', (chunk) => {
      console.error('[python-bridge] stderr:', chunk.toString('utf-8').trim());
    });

    this.process.on('error', (err) => {
      console.error('[python-bridge] 进程错误:', err.message);
      this.ready = false;
    });

    this.process.on('close', (code, signal) => {
      console.log(`[python-bridge] 进程退出 code=${code} signal=${signal}`);
      this.ready = false;
      this.process = null;

      // 自动重启(开发模式下)
      if (code !== 0 && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        console.log(`[python-bridge] 尝试重启 (${this.restartCount}/${this.maxRestarts})`);
        setTimeout(() => this.start(), 1500);
      }
    });

    // 等待 ready 事件
    return new Promise((resolve) => {
      const check = () => {
        if (this.ready) resolve(true);
        else setTimeout(check, 50);
      };
      // 10秒超时
      setTimeout(() => {
        if (!this.ready) {
          console.error('[python-bridge] 启动超时(10s)');
          resolve(false);
        }
      }, 10000);
      check();
    });
  }

  /**
   * 处理来自 Python 的事件
   */
  _handleEvent(event) {
    const eventType = event.type;
    const requestId = event.request_id || '';

    // ready 事件: 标记服务就绪
    if (eventType === 'ready') {
      this.ready = true;
      this.restartCount = 0;
      console.log('[python-bridge] Python Agent 就绪, persist_dir:', event.data?.persist_dir);
      return;
    }

    // 处理 tool_approval_request: 存储 pending
    if (eventType === 'tool_approval_request') {
      const approvalId = event.data?.approval_id;
      if (approvalId) {
        const fut = this.pendingRequests.get(approvalId);
        if (fut) {
          // 转发给 agent-ipc 处理
          this._emitEvent(eventType, event.data);
          return;
        }
      }
    }

    // 常规事件: 检查是否有对应的 pending request
    if (requestId) {
      const pending = this.pendingRequests.get(requestId);
      if (pending && (eventType === 'done' || eventType === 'error')) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
        if (eventType === 'error') {
          pending.reject(new Error(event.data?.content || event.data || 'Agent 执行失败'));
        } else {
          pending.resolve(event.data);
        }
      }
    }

    // 触发事件处理器
    this._emitEvent(eventType, event);
  }

  _emitEvent(eventType, data) {
    const handlers = this.eventHandlers.get(eventType);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(data); } catch (e) { console.error('[python-bridge] handler error:', e); }
      }
    }
    // 也触发 '*' 通配符处理器
    const starHandlers = this.eventHandlers.get('*');
    if (starHandlers) {
      for (const handler of starHandlers) {
        try { handler(eventType, data); } catch (e) {}
      }
    }
  }

  /**
   * 发送消息到 Python
   */
  send(msg) {
    if (!this.process || !this.ready) {
      throw new Error('Python Agent 未就绪');
    }
    const line = JSON.stringify(msg);
    this.process.stdin.write(line + '\n');
  }

  /**
   * 发送请求并等待响应
   */
  sendRequest(type, data = {}, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
      this.requestCounter++;
      const requestId = `req-${this.requestCounter}-${Date.now()}`;
      const msg = { type, request_id: requestId, ...data };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`请求超时: ${type}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.send(msg);
    });
  }

  /**
   * 监听特定事件类型
   * 返回取消监听函数
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

  /**
   * 发送工具审批响应
   */
  approveTool(approvalId, approved) {
    this.send({
      type: 'tool_approval',
      approval_id: approvalId,
      approved: approved,
    });
  }

  /**
   * 检查是否就绪
   */
  isReady() {
    return this.ready && this.process !== null;
  }

  /**
   * 停止 Python 进程
   */
  stop() {
    if (this.process) {
      try {
        this.send({ type: 'quit' });
        setTimeout(() => {
          if (this.process) {
            this.process.kill();
            this.process = null;
          }
        }, 2000);
      } catch (e) {
        this.process.kill();
        this.process = null;
      }
    }
    this.ready = false;
  }
}

module.exports = { PythonBridge };

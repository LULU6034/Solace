const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.env.ELECTRON_IS_DEV === 'true' || !app.isPackaged;

// ── Windows 兼容性设置 ──
// GPU 必须开启：backdrop-filter 毛玻璃效果依赖硬件加速
app.commandLine.appendSwitch('disable-gpu-sandbox');
// 磁盘缓存定向到临时目录
app.commandLine.appendSwitch('disk-cache-dir', path.join(require('os').tmpdir(), 'ai-pet-cache'));
app.commandLine.appendSwitch('disk-cache-size', '5242880');
app.commandLine.appendSwitch('disable-http-cache');

let chatWindow = null;
let tray = null;
let pendingFile = null;

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.focus();
    return;
  }

  chatWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 680,
    minHeight: 420,
    frame: false,
    show: false,
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  if (isDev) {
    const port = process.env.VITE_PORT || '5173';
    chatWindow.loadURL(`http://localhost:${port}/`);
  } else {
    chatWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  chatWindow.once('ready-to-show', () => {
    chatWindow.maximize();
    chatWindow.show();
    chatWindow.webContents.send('window-maximized-change', { maximized: true });
    if (pendingFile) {
      chatWindow.webContents.send('file-fed', {
        path: pendingFile.path,
        name: pendingFile.name,
      })
      pendingFile = null
    }
  });

  chatWindow.on('maximize', () => {
    chatWindow.webContents.send('window-maximized-change', { maximized: true });
  });
  chatWindow.on('unmaximize', () => {
    chatWindow.webContents.send('window-maximized-change', { maximized: false });
  });

  chatWindow.webContents.on('crashed', () => {
    console.error('Chat window crashed, recreating...');
    chatWindow = null;
    createChatWindow();
  });

  chatWindow.on('closed', () => { chatWindow = null; });
}

function createTray() {
  const icon = nativeImage.createFromBuffer(Buffer.alloc(32*32*4));
  tray = new Tray(icon);
  tray.setToolTip('静屿');

  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: createChatWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// IPC
ipcMain.handle('close-chat', () => {
  if (chatWindow) chatWindow.close();
});
ipcMain.handle('move-window', (event, { dx, dy }) => {
  const BrowserWindow = require('electron').BrowserWindow;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);
  }
});

ipcMain.handle('feed-file', (_event, filePath) => {
  const name = path.basename(filePath);
  if (!chatWindow || chatWindow.isDestroyed()) {
    pendingFile = { path: filePath, name };
    createChatWindow();
  } else {
    chatWindow.webContents.send('file-fed', { path: filePath, name });
  }
});

ipcMain.handle('read-file-content', async (_event, filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    // 二进制格式：读为 base64，给 Agent 用 vision/PDF 工具查看
    const binaryExts = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
    if (binaryExts.has(ext)) {
      const buf = await fs.promises.readFile(filePath);
      const base64 = buf.toString('base64');
      return { success: true, content: '', binary: true, ext, base64, size: buf.length };
    }
    // 文本格式：UTF-8
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { success: true, content };
  } catch {
    return { success: false, content: '' };
  }
});

// LLM IPC（原生 Node.js 加载 SDK，避免浏览器端 CJS 打包问题）
require('./ipc/llm-ipc.cjs');

// Voice IPC（语音会话、TTS、CosyVoice 通信）
const { registerVoiceIPC, setupVoiceEventForwarding, setApiKeyAndRetry } = require('./ipc/voice-ipc.cjs');

// Netease Music IPC（网易云音乐 API）
const { registerNeteaseIPC } = require('./ipc/netease-ipc.cjs');
registerNeteaseIPC();

// Agent IPC（Node.js Agent Server 通信）
const { registerAgentIPC, stopAgent, getBridge } = require('./ipc/agent-ipc.cjs');
registerAgentIPC();

// 将 agent bridge 暴露给 voice-ipc 使用
const agentBridge = getBridge();
global.__agentBridge = agentBridge;
setupVoiceEventForwarding(agentBridge);

// ===== 配置持久化（safeStorage 加密，OS 级密钥链）=====
const { safeStorage } = require('electron');
const configPath = path.join(app.getPath('userData'), 'config.enc');

function loadConfigFile() {
  try {
    if (!fs.existsSync(configPath)) { console.log('[main] loadConfigFile: 文件不存在:', configPath); return null; }
    const raw = fs.readFileSync(configPath, 'utf-8');
    console.log('[main] loadConfigFile: 文件存在, 大小:', raw.length, 'bytes');
    const encrypted = Buffer.from(raw, 'base64');
    if (!safeStorage.isEncryptionAvailable()) { console.log('[main] loadConfigFile: safeStorage 不可用'); return null; }
    const decrypted = safeStorage.decryptString(encrypted);
    return JSON.parse(decrypted);
  } catch (e) { console.log('[main] loadConfigFile: 解密/解析失败:', e.message); return null; }
}

function saveConfigFile(config) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const encrypted = safeStorage.encryptString(JSON.stringify(config));
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, encrypted.toString('base64'), 'utf-8');
  } catch (_) { /* ignore */ }
}

ipcMain.handle('load-config', () => {
  const result = loadConfigFile();
  console.log('[main] load-config:', result ? 'OK (keys: ' + Object.keys(result).join(',') + ')' : 'NULL');
  return result;
});
ipcMain.handle('save-config', (_event, config) => {
  saveConfigFile(config);
  // 如果配置了语音 Key，通知 voice-ipc 启动 TTS 服务
  if (config.dashscopeApiKey) {
    try { setApiKeyAndRetry(config.dashscopeApiKey); } catch {}
  }
});

// 头像上传
ipcMain.handle('pick-avatar', async () => {
  const win = BrowserWindow.getFocusedWindow()
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const buf = fs.readFileSync(result.filePaths[0])
  const ext = path.extname(result.filePaths[0]).toLowerCase().replace('.', '') || 'png'
  const mime = ext === 'jpg' ? 'jpeg' : ext
  return `data:image/${mime};base64,${buf.toString('base64')}`
})

app.whenReady().then(() => {
  // 加载配置，初始化语音 TTS 服务
  const cfg = loadConfigFile();
  registerVoiceIPC(cfg?.dashscopeApiKey || '');
  // 将 DeepSeek API Key 传给 server 进程（Stagehand browse 工具需要）
  const bridge = getBridge();
  if (bridge) bridge.setApiKey(cfg?.deepseekApiKey || cfg?.apiKey || '');
  createChatWindow();
  createTray();
});

app.on('will-quit', () => {
  stopAgent();
  // 强杀 Python TTS 服务
  try { require('child_process').execSync('taskkill /f /im python.exe 2>nul', { timeout: 1000 }); } catch {}
});

app.on('window-all-closed', () => {});

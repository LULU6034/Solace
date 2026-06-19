const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { setupUpdater } = require('./updater.cjs');

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

  const iconPath = path.join(__dirname, '../public/icon.png');
  chatWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 680,
    minHeight: 420,
    frame: false,
    show: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Web Speech API 需要网络访问 Google 语音服务
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // ── 麦克风权限授权（Web Speech API 需要）──
  chatWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone' || permission === 'audioCapture') {
      callback(true);
    } else {
      callback(false);
    }
  });

  if (isDev) {
    const port = process.env.VITE_PORT || '5173';
    chatWindow.loadURL(`http://localhost:${port}/`);
  } else {
    chatWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 仅在打包后启用自动更新（开发环境跳过）
  if (!isDev) {
    setupUpdater(chatWindow);
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
  const iconPath = path.join(__dirname, '../public/tray-icon.png');
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createFromBuffer(Buffer.alloc(32*32*4));
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

// 路径安全：只允许访问用户目录下的常见位置
function isSafeFilePath(filePath) {
  const home = require('os').homedir();
  const safeRoots = [
    home,
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'AppData', 'Local', 'Temp'),
    path.join(home, '.ai-desktop-pet'),
    path.resolve(__dirname, '..'),
  ];
  const resolved = path.resolve(filePath);
  return safeRoots.some(root => resolved.startsWith(root + path.sep) || resolved === root);
}

ipcMain.handle('feed-file', (_event, filePath) => {
  if (!isSafeFilePath(filePath)) return;
  const name = path.basename(filePath);
  if (!chatWindow || chatWindow.isDestroyed()) {
    pendingFile = { path: filePath, name };
    createChatWindow();
  } else {
    chatWindow.webContents.send('file-fed', { path: filePath, name });
  }
});

ipcMain.handle('read-file-content', async (_event, filePath) => {
  if (!isSafeFilePath(filePath)) return { success: false, content: '', error: '无权访问此路径' };
  try {
    const ext = path.extname(filePath).toLowerCase();
    const binaryExts = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
    if (binaryExts.has(ext)) {
      const buf = await fs.promises.readFile(filePath);
      const base64 = buf.toString('base64');
      return { success: true, content: '', binary: true, ext, base64, size: buf.length };
    }
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
  // 白名单过滤：只保存已知的安全字段，防止前端注入恶意配置
  const ALLOWED_KEYS = ['provider', 'apiKey', 'visionApiKey', 'dashscopeApiKey', 'minimaxApiKey', 'model', 'baseUrl', 'deepseekApiKey', 'deepgramApiKey', 'hotwords'];
  const sanitized = {};
  for (const key of ALLOWED_KEYS) {
    if (config[key] !== undefined) sanitized[key] = config[key];
  }
  saveConfigFile(sanitized);
  if (sanitized.dashscopeApiKey) {
    try { setApiKeyAndRetry(sanitized.dashscopeApiKey); } catch {}
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

// 工作状态通知（任务栏/托盘图标动画等，目前 no-op）
ipcMain.handle('notify-working', () => {})

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
  globalShortcut.unregisterAll();
  // 停止音乐播放
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.executeJavaScript('try { window.__musicAudio?.pause(); window.__musicAudio = null; } catch(e) {}');
  }
  stopAgent();
  // 精准结束 Python TTS 进程（不误杀用户其他 Python 进程）
  try {
    const { getPythonProcess } = require('./ipc/voice-ipc.cjs');
    const proc = getPythonProcess();
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000);
    }
  } catch {}
});

app.on('window-all-closed', () => {
  // 窗口关闭时停止音乐（用户可能点了 X 但 app 还在托盘运行）
  stopAgent();
});

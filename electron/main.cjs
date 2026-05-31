const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.env.ELECTRON_IS_DEV === 'true' || !app.isPackaged;

// ── Windows GPU 缓存权限问题根治 ──
// Chromium 在 Windows 上常因磁盘缓存目录权限/锁定导致崩溃。
// 桌面宠物是 Canvas 2D 渲染，不需要 GPU 加速和磁盘缓存。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');
// 关键：把磁盘缓存定向到系统的临时目录（总是可写的）
app.commandLine.appendSwitch('disk-cache-dir', path.join(require('os').tmpdir(), 'ai-pet-cache'));
app.commandLine.appendSwitch('disk-cache-size', '5242880'); // 5MB 上限
app.commandLine.appendSwitch('disable-features', 'UseSkiaRenderer');
// 禁用 Electron 网络服务的磁盘缓存
app.commandLine.appendSwitch('disable-http-cache');

// 必须在 app.whenReady() 之前
app.disableHardwareAcceleration();

let petWindow = null;
let chatWindow = null;
let tray = null;
let pendingFile = null;

function createPetWindow() {
  petWindow = new BrowserWindow({
    width: 280,
    height: 210,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    x: 100,
    y: 0,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    const port = process.env.VITE_PORT || '5173';
    petWindow.loadURL(`http://localhost:${port}/pet.html`);
  } else {
    petWindow.loadFile(path.join(__dirname, '../dist/pet.html'));
  }

}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    animateShow(chatWindow);
    return;
  }

  let chatX = 400, chatY = 100
  if (petWindow) {
    const [px, py] = petWindow.getPosition()
    chatX = px + 300
    chatY = Math.max(0, py - 50)
  }

  chatWindow = new BrowserWindow({
    width: 100,
    height: 60,
    x: chatX + 230,
    y: chatY + 260,
    frame: false,
    transparent: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  if (isDev) {
    const port = process.env.VITE_PORT || '5173';
    chatWindow.loadURL(`http://localhost:${port}`);
  } else {
    chatWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  chatWindow.once('ready-to-show', () => {
    animateExpand(chatWindow, chatX, chatY, 650, 780);
    if (pendingFile) {
      chatWindow.webContents.send('file-fed', {
        path: pendingFile.path,
        name: pendingFile.name,
      })
      pendingFile = null
    }
  });

  chatWindow.webContents.on('crashed', () => {
    console.error('Chat window crashed, recreating...');
    chatWindow = null;
    createChatWindow();
  });

  chatWindow.on('closed', () => { chatWindow = null; });
}

// 窗口展开动画
function animateExpand(win, targetX, targetY, targetW, targetH) {
  const [sx, sy] = win.getPosition();
  const [sw, sh] = win.getSize();
  const steps = 12;
  let i = 0;

  win.show();

  function step() {
    i++;
    const t = i / steps;
    // easeOutCubic
    const ease = 1 - Math.pow(1 - t, 3);
    const cx = Math.round(sx + (targetX - sx) * ease);
    const cy = Math.round(sy + (targetY - sy) * ease);
    const cw = Math.round(sw + (targetW - sw) * ease);
    const ch = Math.round(sh + (targetH - sh) * ease);
    win.setBounds({ x: cx, y: cy, width: cw, height: ch });
    if (i < steps) setTimeout(step, 16);
  }
  step();
}

function animateShow(win) {
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  win.setBounds({ x: x + w/2, y: y + h/2, width: 100, height: 60 });
  win.show();
  animateExpand(win, x, y, w, h);
}

function createTray() {
  const icon = nativeImage.createFromBuffer(Buffer.alloc(32*32*4));
  tray = new Tray(icon);
  tray.setToolTip('AI 桌宠');

  const menu = Menu.buildFromTemplate([
    { label: '显示宠物', click: () => petWindow?.show() },
    { label: '隐藏宠物', click: () => petWindow?.hide() },
    { type: 'separator' },
    { label: '打开聊天', click: createChatWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.displayBalloon({ title: 'AI 桌宠', content: '桌面小精灵已启动' });
}

// IPC
ipcMain.handle('open-chat', () => {
  console.log('[main] open-chat 收到, chatWindow:', chatWindow ? 'exists' : 'null')
  createChatWindow()
});
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
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { success: true, content };
  } catch {
    return { success: false, content: '' };
  }
});

ipcMain.handle('notify-working', (_event, isWorking) => {
  console.log('[main] notify-working:', isWorking)
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('working-state', { isWorking });
  }
});

// LLM IPC（原生 Node.js 加载 SDK，避免浏览器端 CJS 打包问题）
require('./llm-ipc.cjs');

// Agent IPC（Python LangChain Agent 通信）
const { registerAgentIPC, stopAgent } = require('./agent-ipc.cjs');
registerAgentIPC();

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
ipcMain.handle('save-config', (_event, config) => { saveConfigFile(config); });

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

// 禁用 GPU 硬件加速：透明窗口 + backdrop-filter 在 Windows 上
// 容易导致 GPU 合成器崩溃，软件渲染对桌面宠物场景完全够用
app.whenReady().then(() => {
  createPetWindow();
  createTray();

  globalShortcut.register('Ctrl+Shift+P', () => {
    if (petWindow && !petWindow.isDestroyed()) {
      if (petWindow.isVisible()) petWindow.hide();
      else petWindow.show();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopAgent();
});

app.on('window-all-closed', () => {});

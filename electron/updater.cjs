// ── 自动更新模块 ──
const { autoUpdater } = require('electron-updater');
const { BrowserWindow, ipcMain } = require('electron');

// 每 6 小时自动检查一次（毫秒）
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
let _checkTimer = null;
let _mainWindow = null;

// 配置 autoUpdater
autoUpdater.autoDownload = false;  // 让用户选择是否更新
autoUpdater.allowPrerelease = false;
autoUpdater.logger = {
  info: (...args) => console.log('[更新]', ...args),
  warn: (...args) => console.warn('[更新]', ...args),
  error: (...args) => console.error('[更新]', ...args),
  debug: (...args) => console.log('[更新:debug]', ...args),
};

function send(channel, data) {
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send(channel, data);
  }
}

// ── 事件监听 ──

autoUpdater.on('checking-for-update', () => {
  send('update:status', { status: 'checking', message: '正在检查更新…' });
});

autoUpdater.on('update-available', (info) => {
  send('update:status', {
    status: 'available',
    version: info.version,
    message: `发现新版本 ${info.version}`,
    releaseDate: info.releaseDate,
    releaseNotes: info.releaseNotes,
  });
});

autoUpdater.on('update-not-available', (info) => {
  send('update:status', {
    status: 'up-to-date',
    version: info.version,
    message: '已是最新版本',
  });
});

autoUpdater.on('download-progress', (progress) => {
  send('update:status', {
    status: 'downloading',
    percent: Math.round(progress.percent),
    message: `下载中 ${Math.round(progress.percent)}%`,
  });
});

autoUpdater.on('update-downloaded', (info) => {
  send('update:status', {
    status: 'downloaded',
    version: info.version,
    message: `新版本 ${info.version} 已下载，重启后生效`,
  });
});

autoUpdater.on('error', (err) => {
  send('update:status', {
    status: 'error',
    message: err?.message || '检查更新失败',
  });
});

// ── 始终注册的基础 IPC（开发 & 生产都需要）──
ipcMain.handle('update:get-version', async () => {
  const pkg = require('../package.json');
  return { version: pkg.version, name: pkg.build?.productName || pkg.name };
});

// ── 更新相关 IPC（仅生产模式）──

function setupUpdater(mainWindow) {
  _mainWindow = mainWindow;

  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { success: true, version: result?.updateInfo?.version };
    } catch (err) {
      return { success: false, error: err?.message || '检查失败' };
    }
  });

  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      return { success: false, error: err?.message || '下载失败' };
    }
  });

  ipcMain.handle('update:install', async () => {
    try {
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (err) {
      return { success: false, error: err?.message || '安装失败' };
    }
  });

  // 启动时自动检查一次（延迟 5 秒等窗口就绪）
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);

  // 定时检查
  startAutoCheck();
}

function startAutoCheck() {
  stopAutoCheck();
  _checkTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, CHECK_INTERVAL);
}

function stopAutoCheck() {
  if (_checkTimer) {
    clearInterval(_checkTimer);
    _checkTimer = null;
  }
}

module.exports = { setupUpdater, stopAutoCheck };

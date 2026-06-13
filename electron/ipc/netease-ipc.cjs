/**
 * Netease IPC — 网易云音乐 API 桥接
 *
 * 主进程直接调用 NeteaseCloudMusicApi 函数。
 * 支持扫码登录，cookie 持久化到 config.enc。
 */
const { ipcMain, safeStorage, app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

let _netease = null;
function getApi() {
  if (!_netease) {
    _netease = require('@neteasecloudmusicapienhanced/api');
  }
  return _netease;
}

// ── Cookie 持久化 ──
let _cookie = '';
let _loginInfo = null; // { userId, nickname, avatarUrl }

function _cookiePath() {
  return path.join(app.getPath('userData'), 'netease-cookie.enc');
}

function loadCookie() {
  try {
    const p = _cookiePath();
    if (fs.existsSync(p)) {
      const encrypted = Buffer.from(fs.readFileSync(p, 'utf-8'), 'base64');
      if (safeStorage.isEncryptionAvailable()) {
        _cookie = safeStorage.decryptString(encrypted);
        if (_cookie) console.log('[netease-ipc] 从加密文件加载 cookie 成功');
      }
    }
    if (!_cookie) {
      const dataPath = _cookieDataPath();
      if (fs.existsSync(dataPath)) {
        const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
        if (data.cookie) {
          _cookie = data.cookie;
          console.log('[netease-ipc] 从明文文件加载 cookie 成功');
        }
      }
    }
    if (_cookie) {
      console.log('[netease-ipc] Cookie 长度:', _cookie.length);
    } else {
      console.log('[netease-ipc] 未找到有效 cookie (加密文件存在:', fs.existsSync(_cookiePath()), '明文文件存在:', fs.existsSync(_cookieDataPath()), ')');
    }
  } catch (e) {
    console.error('[netease-ipc] loadCookie 异常:', e.message);
  }
}

function _cookieDataPath() {
  return path.join(app.getPath('userData'), 'agent-data', 'netease-cookie.json');
}

function saveCookie() {
  try {
    if (!_cookie) return;
    // 加密存储（主进程用）
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(_cookie);
      fs.mkdirSync(path.dirname(_cookiePath()), { recursive: true });
      fs.writeFileSync(_cookiePath(), encrypted.toString('base64'), 'utf-8');
    }
    // 明文存储（服务端进程用）
    fs.mkdirSync(path.dirname(_cookieDataPath()), { recursive: true });
    fs.writeFileSync(_cookieDataPath(), JSON.stringify({ cookie: _cookie, updatedAt: Date.now() }), 'utf-8');
  } catch {}
}

function clearCookie() {
  _cookie = '';
  _loginInfo = null;
  try { fs.unlinkSync(_cookiePath()); } catch {}
  try { fs.unlinkSync(_cookieDataPath()); } catch {}
}

// ── API 调用包装 ──
// 网易云对非标准 User-Agent 有反爬检测，使用移动端 UA 伪装正常设备
// ── API 调用包装 ──
async function callApi(fnName, params = {}) {
  try {
    const api = getApi();
    const opts = { ...params };
    // QR 登录不传旧 Cookie，避免过期 cookie 触发风控
    if (_cookie && !fnName.startsWith('login_qr')) opts.cookie = _cookie;
    const result = await api[fnName](opts);
    return { ok: true, data: result.body };
  } catch (err) {
    console.error(`[netease] ${fnName} 失败:`, err.message);
    return { ok: false, error: err.message };
  }
}

function mapSong(s) {
  return {
    id: String(s.id),
    name: s.name,
    artist: (s.ar || []).map(a => a.name).join(' / '),
    album: s.al?.name || '',
    cover: s.al?.picUrl || '',
    duration: (s.dt || 0) / 1000,
  };
}

// ── 启动时加载 cookie ──
loadCookie();

function registerNeteaseIPC() {

  // ═══════════════════════════════════════
  // 登录
  // ═══════════════════════════════════════

  // 获取登录状态
  ipcMain.handle('netease-login-status', async () => {
    if (!_cookie) return { ok: true, data: { loggedIn: false } };

    // 验证 cookie 是否还有效
    const r = await callApi('login_status');
    if (!r.ok || !r.data.data?.account) {
      return { ok: true, data: { loggedIn: false } };
    }
    const acc = r.data.data;
    _loginInfo = {
      userId: String(acc.account?.id || acc.id || ''),
      nickname: acc.profile?.nickname || '',
      avatarUrl: acc.profile?.avatarUrl || '',
    };
    return { ok: true, data: { loggedIn: true, user: _loginInfo } };
  });

  // ── 扫码登录 ──
  ipcMain.handle('netease-qr-create', async () => {
    const r1 = await callApi('login_qr_key');
    if (!r1.ok) return r1;
    const key = r1.data.data?.unikey;
    if (!key) return { ok: false, error: '获取二维码 key 失败' };

    const r2 = await callApi('login_qr_create', { key, qrimg: true });
    if (!r2.ok) return r2;
    return { ok: true, data: { key, qrImg: r2.data.data?.qrimg || '' } };
  });

  ipcMain.handle('netease-qr-check', async (_e, { key }) => {
    const r = await callApi('login_qr_check', { key });
    if (!r.ok) return r;
    const code = r.data.code;
    if (code === 803 && r.data.cookie) {
      _cookie = r.data.cookie;
      saveCookie();
      return { ok: true, data: { code: 803, message: '登录成功' } };
    }
    const msgs = { 800: '二维码已过期', 801: '等待扫码', 802: '请在手机上确认登录', 803: '登录成功' };
    return { ok: true, data: { code, message: msgs[code] || `状态: ${code}` } };
  });

  // 退出登录
  ipcMain.handle('netease-logout', async () => {
    await callApi('logout');
    clearCookie();
    return { ok: true };
  });

  // ═══════════════════════════════════════
  // 用户内容
  // ═══════════════════════════════════════

  // 用户歌单
  ipcMain.handle('netease-user-playlists', async (_e, { uid } = {}) => {
    const userId = uid || _loginInfo?.userId;
    if (!userId) return { ok: false, error: '未登录' };

    const r = await callApi('user_playlist', { uid: userId });
    if (!r.ok) return r;

    const playlists = (r.data.playlist || []).map(p => ({
      id: String(p.id),
      name: p.name,
      cover: p.coverImgUrl || '',
      trackCount: p.trackCount || 0,
      playCount: p.playCount || 0,
      isOwner: p.userId === parseInt(userId),
    }));
    return { ok: true, data: playlists };
  });

  // 我喜欢的音乐
  ipcMain.handle('netease-liked-songs', async (_e, { uid } = {}) => {
    const userId = uid || _loginInfo?.userId;
    if (!userId) return { ok: false, error: '未登录' };

    const r = await callApi('likelist', { uid: userId });
    if (!r.ok) return r;

    const songIds = r.data.ids || [];
    if (!songIds.length) return { ok: true, data: { tracks: [] } };

    // 批量获取歌曲详情
    const ids = songIds.slice(0, 200).map(String).join(',');
    const detail = await callApi('song_detail', { ids });
    if (!detail.ok) return { ok: true, data: { tracks: [] } };

    const tracks = (detail.data.songs || []).map(mapSong);
    return { ok: true, data: { trackCount: songIds.length, tracks } };
  });

  // 每日推荐歌曲（需登录）
  ipcMain.handle('netease-daily-songs', async () => {
    const r = await callApi('recommend_songs');
    if (!r.ok) return r;

    const songs = (r.data.data?.dailySongs || []).map(mapSong);
    return { ok: true, data: songs };
  });

  // 私人 FM
  ipcMain.handle('netease-personal-fm', async () => {
    const r = await callApi('personal_fm');
    if (!r.ok) return r;

    const songs = (r.data.data || []).map(mapSong);
    return { ok: true, data: songs };
  });

  // 心动模式（智能播放：从一首歌出发推荐相似歌曲）
  ipcMain.handle('netease-intelligence-list', async (_e, { songId, playlistId, count = 20 }) => {
    const r = await callApi('playmode_intelligence_list', {
      id: String(songId),
      pid: String(playlistId || '0'),
      startMusicId: String(songId),
      count,
    });
    if (!r.ok) return r;

    const songs = (r.data.data || []).map(mapSong);
    return { ok: true, data: songs };
  });

  // ═══════════════════════════════════════
  // 搜索 & 播放
  // ═══════════════════════════════════════

  ipcMain.handle('netease-search', async (_e, { keywords, limit = 20, offset = 0, type = 1 }) => {
    const r = await callApi('cloudsearch', { keywords, limit, offset, type });
    if (!r.ok) return r;

    const songs = (r.data.result?.songs || []).map(mapSong);
    return {
      ok: true,
      data: {
        songs,
        total: r.data.result?.songCount || 0,
        hasMore: r.data.result?.hasMore ?? false,
      },
    };
  });

  ipcMain.handle('netease-song-url', async (_e, { songId, level = 'standard' }) => {
    const r = await callApi('song_url_v1', { id: String(songId), level });
    if (!r.ok) return r;

    const info = (r.data.data || [])[0];
    if (!info?.url) {
      if (level !== 'standard') {
        const retry = await callApi('song_url_v1', { id: String(songId), level: 'standard' });
        if (retry.ok) {
          const info2 = (retry.data.data || [])[0];
          if (info2?.url) return { ok: true, data: { url: info2.url, br: info2.br, type: info2.type } };
        }
      }
      return { ok: false, error: '暂无播放源' };
    }
    return { ok: true, data: { url: info.url, br: info.br, type: info.type } };
  });

  ipcMain.handle('netease-song-detail', async (_e, { songIds }) => {
    const ids = Array.isArray(songIds) ? songIds : [songIds];
    const r = await callApi('song_detail', { ids: ids.map(String).join(',') });
    if (!r.ok) return r;
    return { ok: true, data: (r.data.songs || []).map(mapSong) };
  });

  ipcMain.handle('netease-lyric', async (_e, { songId }) => {
    const r = await callApi('lyric', { id: String(songId) });
    if (!r.ok) return r;
    return {
      ok: true,
      data: {
        lyric: r.data.lrc?.lyric || '',
        tlyric: r.data.tlyric?.lyric || '',
      },
    };
  });

  // 推荐歌单（无需登录）
  ipcMain.handle('netease-recommend-playlists', async () => {
    const r = await callApi('personalized', { limit: 10 });
    if (!r.ok) return r;

    const playlists = (r.data.result || []).map(p => ({
      id: String(p.id),
      name: p.name,
      cover: p.picUrl || '',
      playCount: p.playCount || 0,
      trackCount: p.trackCount || 0,
    }));
    return { ok: true, data: playlists };
  });

  ipcMain.handle('netease-playlist-detail', async (_e, { playlistId, limit = 50 }) => {
    const r = await callApi('playlist_detail', { id: String(playlistId) });
    if (!r.ok || !r.data.playlist) return { ok: false, error: '歌单不存在' };

    const pl = r.data.playlist;
    const tracks = (pl.tracks || []).slice(0, limit).map(mapSong);
    return {
      ok: true,
      data: {
        id: String(pl.id),
        name: pl.name,
        cover: pl.coverImgUrl || '',
        description: pl.description || '',
        trackCount: pl.trackCount || 0,
        tracks,
      },
    };
  });

  // ── Cookie 直接登录 ──
  ipcMain.handle('netease-cookie-login', async (_e, cookieStr) => {
    if (!cookieStr || typeof cookieStr !== 'string') return { ok: false, error: 'Cookie 不能为空' };
    // 如果只传了 MUSIC_U 值，补全为完整 cookie
    const c = cookieStr.includes('=') ? cookieStr : `MUSIC_U=${cookieStr}`;
    _cookie = c;
    saveCookie();
    try {
      const r = await callApi('login_status');
      if (r.ok && r.data.data?.account) {
        _loginInfo = {
          userId: String(r.data.data.account.id || ''),
          nickname: r.data.data.profile?.nickname || '',
          avatarUrl: r.data.data.profile?.avatarUrl || '',
        };
        return { ok: true, data: { nickname: _loginInfo.nickname, message: '登录成功' } };
      }
    } catch {}
    _cookie = '';
    return { ok: false, error: 'Cookie 无效或已过期' };
  });

  // ── 浏览器登录（永久解决方案，绕过 API 风控）──
  ipcMain.handle('netease-browser-login', async () => {
    const { session } = require('electron');
    const ses = session.defaultSession;

    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 450, height: 700,
        title: '网易云音乐登录',
        autoHideMenuBar: true,
      });

      let pollTimer = null;
      let resolved = false;

      const done = (ok, data) => {
        if (resolved) return;
        resolved = true;
        clearInterval(pollTimer);
        if (!win.isDestroyed()) win.close();
        resolve({ ok, data });
      };

      // 每 2 秒检查一次 Cookie
      pollTimer = setInterval(async () => {
        try {
          if (win.isDestroyed()) { done(false, { error: '窗口已关闭' }); return; }
          const cookies = await ses.cookies.get({ url: 'https://music.163.com' });
          const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          if (cookieStr.includes('MUSIC_U')) {
            _cookie = cookieStr;
            saveCookie();
            try {
              const r = await callApi('login_status');
              if (r.ok && r.data.data?.account) {
                _loginInfo = {
                  userId: String(r.data.data.account.id || ''),
                  nickname: r.data.data.profile?.nickname || '',
                  avatarUrl: r.data.data.profile?.avatarUrl || '',
                };
              }
            } catch {}
            done(true, { message: '登录成功', nickname: _loginInfo?.nickname });
          }
        } catch {}
      }, 2000);

      win.on('closed', () => done(false, { error: '登录窗口已关闭' }));
      win.loadURL('https://music.163.com');
    });
  });

  console.log('[netease-ipc] Netease IPC 已注册 (登录: ' + (_cookie ? '已登录' : '未登录') + ')');
}

module.exports = { registerNeteaseIPC };

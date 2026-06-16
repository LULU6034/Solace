/**
 * skill-tools.js — Skill 安装/卸载/列表 工具
 *
 * 让 Agent 能自主搜索、安装、管理社区 Skill。
 * Skill 是纯文本 SKILL.md 注入，不执行代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync as execSync_ } from 'node:child_process';
const execSync = (cmd, opts) => execSync_(cmd, { ...opts, encoding: 'utf-8' });
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('skill-tools');

/** 外部引用：SkillManager 实例，由 server/index.js 注入 */
let _skillManager = null;
let _onChangeCallback = null;

export function setSkillManager(sm) {
  _skillManager = sm;
}

/** 注册 skill 变更回调（供 WebSocket 广播） */
export function onSkillsChanged(cb) {
  _onChangeCallback = cb;
}

/** 生成 Skill 目录（供 system prompt 注入） */
export function getSkillCatalog() {
  if (!_skillManager) return '';
  const skills = _skillManager.getAll().filter(s => s.enabled);
  if (!skills.length) return '';
  return skills.map(s => `- **${s.name}**：${s.meta.description || '无描述'}`).join('\n');
}

function _notifyChange() {
  try { _onChangeCallback?.(); } catch (e) { log.warn('操作失败', e?.message || e); }
}

function getUserSkillsDir() {
  // 与 SkillManager 共用 persist 目录
  const persistDir = process.env.AGENT_PERSIST_DIR || path.join(os.homedir(), '.ai-desktop-pet');
  return path.join(persistDir, 'skills-user');
}

/** 获取代理配置 */
function _getProxyEnv() {
  // 环境变量优先
  let p = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (p) return p;
  // Windows: 读注册表系统代理
  try {
    const reg = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer 2>nul', { shell: 'cmd.exe', windowsHide: true, stdio: 'pipe' });
    const m = reg.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (m) p = m[1].includes('://') ? m[1] : 'http://' + m[1];
  } catch (e) { log.warn('操作失败', e?.message || e); }
  return p;
}

/** 发起可走代理的 HTTP 请求（兼容无代理环境） */
async function _fetchWithProxy(url) {
  const proxy = _getProxyEnv();
  if (!proxy) return fetch(url);
  // 使用 PowerShell 走系统代理（安全：转义 URL 中的单引号防止命令注入）
  try {
    const safeUrl = url.replace(/'/g, "''");
    const ps = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (Invoke-WebRequest -Uri '${safeUrl}' -UseBasicParsing -TimeoutSec 30).Content`;
    const data = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, stdio: 'pipe' });
    return { ok: true, text: () => data.toString(), arrayBuffer: () => Buffer.from(data) };
  } catch (e) {
    // PowerShell 也失败 → 回退到直连
    return fetch(url);
  }
}

/** 查找 git.exe 路径 */
function _findGit() {
  const candidates = [
    'git',
    'C:\\Program Files\\Git\\bin\\git.exe',
    'C:\\Program Files (x86)\\Git\\bin\\git.exe',
    process.env.USERPROFILE + '\\AppData\\Local\\Programs\\Git\\bin\\git.exe',
  ];
  for (const c of candidates) {
    try { execSync(`"${c}" --version`, { stdio: 'pipe', windowsHide: true }); return c; } catch (e) { log.warn('操作失败', e?.message || e); }
  }
  return 'git'; // fallback, let it fail naturally
}

/** 从 GitHub URL 或 owner/repo 安装 */
async function _cloneSkill(source) {
  const targetDir = getUserSkillsDir();
  fs.mkdirSync(targetDir, { recursive: true });
  const proxy = _getProxyEnv();
  const gitPath = _findGit();

  let repoUrl = source.trim();

  // 简写: "owner/repo" → 完整 URL
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoUrl)) {
    repoUrl = `https://github.com/${repoUrl}.git`;
  }

  const repoName = (repoUrl.match(/([^/]+?)(?:\.git)?$/) || ['', 'skill'])[1];
  const installDir = path.join(targetDir, repoName);

  // 已存在则跳过
  if (fs.existsSync(installDir)) {
    log.log(`Skill 已安装: ${repoName}，跳过`);
    return { existed: true, name: repoName, dir: installDir };
  }

  // clone（失败则 zip，zip 失败则 raw fetch）
  try {
    const proxyOpts = proxy ? ` -c http.proxy="${proxy}" -c https.proxy="${proxy}"` : '';
    const gitCmd = `"${gitPath}" clone${proxyOpts} --depth 1 "${repoUrl}" "${installDir}"`;
    log.log(`git: ${gitPath}${proxy ? ' (代理)' : ''}`);
    execSync(gitCmd, { stdio: 'pipe', timeout: 60_000, windowsHide: true });
  } catch (cloneErr) {
    log.warn(`git clone 失败: ${cloneErr.message}`);
    let ok = false;
    // 方式2：zip 下载
    try {
      const zipUrl = repoUrl.replace(/\.git$/, '') + '/archive/HEAD.zip';
      const resp = await _fetchWithProxy(zipUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const zipPath = path.join(targetDir, `${repoName}.zip`);
      fs.writeFileSync(zipPath, Buffer.from(await resp.arrayBuffer()));
      if (process.platform === 'win32') {
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force"`, { windowsHide: true });
      } else {
        execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, { stdio: 'pipe' });
      }
      fs.unlinkSync(zipPath);
      const extracted = fs.readdirSync(targetDir).find(f => f.startsWith(repoName));
      if (extracted && extracted !== repoName) {
        if (fs.existsSync(installDir)) fs.rmSync(installDir, { recursive: true });
        fs.renameSync(path.join(targetDir, extracted), installDir);
      }
      ok = true; log.log('zip 安装成功');
    } catch (zipErr) { log.warn(`zip 失败: ${zipErr.message}`); }
    // 方式3：直接 fetch raw SKILL.md
    if (!ok) {
      const rawUrl = repoUrl.replace(/\.git$/, '').replace('github.com', 'raw.githubusercontent.com') + '/HEAD/SKILL.md';
      const rawResp = await _fetchWithProxy(rawUrl);
      if (!rawResp.ok) throw new Error(`raw fetch 失败: HTTP ${rawResp.status}`);
      const md = await rawResp.text();
      if (!md.trim() || !md.includes('---')) throw new Error('SKILL.md 内容无效');
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, 'SKILL.md'), md);
      log.log('raw fetch 安装成功');
    }
  }

  // 验证 SKILL.md
  if (!_findSkillMd(installDir)) {
    try { fs.rmSync(installDir, { recursive: true }); } catch (e) { log.warn('操作失败', e?.message || e); }
    throw new Error('仓库中未找到 SKILL.md 文件');
  }

  log.log(`Skill 安装完成: ${repoName}`);
  return { existed: false, name: repoName, dir: installDir };
}

function _findSkillMd(dir) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === 'SKILL.md') return path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const found = _findSkillMd(path.join(dir, entry.name));
        if (found) return found;
      }
    }
  } catch (e) { log.warn('操作失败', e?.message || e); }
  return null;
}

/** 热加载 SkillManager */
function _reload() {
  if (_skillManager) {
    _skillManager.loadAll();
    log.log(`Skills 热加载完成: ${_skillManager.count} 个`);
    _notifyChange();
  }
}

// ═══════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════

export const installSkill = {
  name: 'install_skill',
  description: `从 GitHub 安装社区 Skill。Skill 是纯文本知识注入，安装后 Agent 自动获得该领域专业知识。
参数 source: GitHub URL 或 owner/repo 简写（如 "username/sonder-translate"）。
安装到用户本地 ~/.ai-desktop-pet/skills-user/，跨版本保留。`,
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'GitHub 仓库 URL 或 owner/repo 简写' },
    },
    required: ['source'],
  },
  async invoke({ source }) {
    if (!source?.trim()) return '请提供 GitHub 仓库 URL 或 owner/repo 简写';
    try {
      const result = await _cloneSkill(source);
      _reload();
      if (result.existed) {
        return `Skill "${result.name}" 已经安装过了，无需重复安装。`;
      }
      return `Skill "${result.name}" 安装成功！已自动启用，下次对话即可使用。`;
    } catch (err) {
      log.warn(`install_skill 失败: ${err.message}`);
      return `安装失败: ${err.message}。请检查仓库地址是否正确，以及仓库中是否包含 SKILL.md 文件。`;
    }
  },
};

export const uninstallSkill = {
  name: 'uninstall_skill',
  description: `卸载指定的社区 Skill。只能卸载用户安装的 Skill（~/.ai-desktop-pet/skills-user/），不能卸载内置 Skill。
参数 name: Skill 名称（文件夹名）。`,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill 名称（文件夹名）' },
    },
    required: ['name'],
  },
  async invoke({ name }) {
    if (!name?.trim()) return '请提供要卸载的 Skill 名称';
    const dir = path.join(getUserSkillsDir(), name.trim());
    if (!fs.existsSync(dir)) return `未找到 Skill "${name}"（路径: ${dir}）`;
    try {
      fs.rmSync(dir, { recursive: true });
      _reload();
      return `Skill "${name}" 已卸载。`;
    } catch (err) {
      return `卸载失败: ${err.message}`;
    }
  },
};

export const listSkills = {
  name: 'list_skills',
  description: `列出所有已安装的 Skill，包括内置和用户安装的。显示名称、描述、启用状态。`,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async invoke() {
    if (!_skillManager) return 'Skill 管理器未初始化';
    const all = _skillManager.getAll();
    if (!all.length) return '当前没有安装任何 Skill。';

    const lines = ['当前已安装的 Skill：'];
    for (const s of all) {
      const tag = s.builtin ? '[内置]' : '[用户]';
      const status = s.enabled ? '✓' : '✗';
      lines.push(`- ${status} ${tag} **${s.name}** — ${s.meta.description || '无描述'}`);
    }
    lines.push(`\n共 ${all.length} 个 Skill（${all.filter(s => s.enabled).length} 个已启用）。`);
    return lines.join('\n');
  },
};

export const skillTools = [installSkill, uninstallSkill, listSkills];

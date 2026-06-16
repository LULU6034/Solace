/**
 * skill-installer.js — Skill 安装器
 *
 * 从 GitHub 仓库安装社区 skill。
 * 支持: GitHub URL、简写 owner/repo、zip 下载
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('skill-installer');

/**
 * Install a skill from GitHub
 * @param {string} source — GitHub URL or owner/repo shorthand
 * @param {string} targetDir — destination directory
 * @returns {{ success: boolean, skillName?: string, error?: string }}
 */
export async function installSkill(source, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  try {
    let repoUrl = source.trim();

    // Normalize shorthand: "owner/repo" → full URL
    if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(repoUrl)) {
      repoUrl = `https://github.com/${repoUrl}.git`;
    }

    // Extract repo name for directory
    const repoName = (repoUrl.match(/([^/]+?)(?:\.git)?$/) || ['', 'skill'])[1];
    const installDir = path.join(targetDir, repoName);

    // Clone with depth 1 (fast)
    log.log(`安装 skill: ${repoUrl} → ${installDir}`);

    try {
      execSync(`git clone --depth 1 "${repoUrl}" "${installDir}"`, {
        stdio: 'pipe',
        timeout: 60_000,
        windowsHide: true,
      });
    } catch (cloneErr) {
      // Git not available? Try downloading zip from GitHub
      log.warn(`git clone 失败，尝试下载 zip: ${cloneErr.message}`);
      const zipUrl = repoUrl.replace(/\.git$/, '') + '/archive/HEAD.zip';
      const resp = await fetch(zipUrl);
      if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}`);

      // Write zip and extract
      const zipPath = path.join(targetDir, `${repoName}.zip`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(zipPath, buf);

      // Use Node.js built-in unzip if available, or PowerShell
      if (process.platform === 'win32') {
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force"`, { windowsHide: true });
      } else {
        execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, { stdio: 'pipe' });
      }

      fs.unlinkSync(zipPath);

      // Move extracted contents (GitHub wraps in repoName-branch/)
      const extracted = fs.readdirSync(targetDir).find(f => f.startsWith(repoName));
      if (extracted && extracted !== repoName) {
        fs.renameSync(path.join(targetDir, extracted), installDir);
      }
    }

    // Verify SKILL.md exists
    const skillMd = path.join(installDir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) {
      // Search recursively
      const found = _findSkillMd(installDir);
      if (!found) {
        throw new Error('仓库中未找到 SKILL.md 文件');
      }
    }

    log.log(`Skill 安装完成: ${repoName}`);
    return { success: true, skillName: repoName, installDir };
  } catch (err) {
    log.error(`Skill 安装失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

function _findSkillMd(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'SKILL.md') {
        return path.join(dir, entry.name);
      }
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const found = _findSkillMd(path.join(dir, entry.name));
        if (found) return found;
      }
    }
  } catch (e) { log.warn('操作失败', e?.message || e); }
  return null;
}

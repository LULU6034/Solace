/**
 * command-tool.js — 终端命令执行工具
 *
 * 需要用户审批。危险命令检测。
 */
import { execSync } from 'node:child_process';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('command-tool');

const COMMAND_TIMEOUT = 30_000; // 30 seconds
const MAX_OUTPUT = 3000;

// Dangerous command patterns (denied even if approved)
const DANGEROUS_PATTERNS = [
  'rm -rf /',
  'rd /s /q C:\\',
  'format ',
  'del /f /s',
  'shutdown',
  'mkfs.',
  'dd if=',
  '> /dev/sda',
  'chmod 777',
];

export const executeCommand = {
  name: 'execute_command',
  description: '执行终端命令（需要用户确认）。参数 command: 要执行的命令字符串。不支持交互式命令，超时 30 秒。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
    },
    required: ['command'],
  },
  async invoke({ command }) {
    if (!command?.trim()) return '命令不能为空';

    // Check dangerous patterns
    const cmdLower = command.toLowerCase();
    for (const pattern of DANGEROUS_PATTERNS) {
      if (cmdLower.includes(pattern.toLowerCase())) {
        return `拒绝执行: 命令包含危险模式 '${pattern}'`;
      }
    }

    // 自动替换 python → 完整路径（Windows 上 Agent Server 的 PATH 没有 Python）
    let finalCmd = command;
    if (process.platform === 'win32' && /^python\b/.test(cmdLower)) {
      const candidates = [
        process.env.USERPROFILE + '\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
        'C:\\Program Files\\Python312\\python.exe',
        'C:\\Python312\\python.exe',
      ];
      for (const py of candidates) {
        try { execSync(`"${py}" --version`, { windowsHide: true, stdio: 'pipe' }); finalCmd = command.replace(/^python\b/, `"${py}"`); break; } catch (e) { log.warn('操作失败', e?.message || e); }
      }
    }

    try {
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/sh';
      const shellFlag = isWindows ? '/c' : '-c';

      const output = execSync(finalCmd, {
        shell: true,
        timeout: COMMAND_TIMEOUT,
        encoding: 'utf-8',
        maxBuffer: MAX_OUTPUT * 4,
        windowsHide: true,
      });

      let result = output?.trim() || '(无输出)';
      if (result.length > MAX_OUTPUT) {
        result = result.slice(0, MAX_OUTPUT) + '\n...(输出过长，已截断)';
      }
      return result;
    } catch (err) {
      if (err.killed) return `命令超时 (${COMMAND_TIMEOUT / 1000}秒)，已终止`;
      const stderr = err.stderr?.trim();
      const stdout = err.stdout?.trim();
      let msg = `命令执行失败 (退出码: ${err.status || 'unknown'})`;
      if (stdout) msg += `\n[STDOUT]\n${stdout.slice(0, 1000)}`;
      if (stderr) msg += `\n[STDERR]\n${stderr.slice(0, 1000)}`;
      return msg;
    }
  },
};

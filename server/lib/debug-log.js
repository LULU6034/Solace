/**
 * debug-log.js — 模块级日志工具
 *
 * 参考 OpenHanako 的 createModuleLogger 模式：
 * 每个模块创建自己的 logger，统一前缀，stderr 输出。
 * Windows 兼容：避免 emoji 等可能导致终端乱码的字符。
 */
const ENABLED_MODULES = new Set(
  (process.env.AGENT_LOG_MODULES || '*').split(',').map(s => s.trim()),
);

const LEVELS = { error: 0, warn: 1, log: 2, debug: 3 };
const CURRENT_LEVEL = LEVELS[process.env.AGENT_LOG_LEVEL] ?? LEVELS.log;

function formatTime() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

export function createModuleLogger(moduleName) {
  const enabled = ENABLED_MODULES.has('*') || ENABLED_MODULES.has(moduleName);

  function write(level, args) {
    if (!enabled) return;
    if (LEVELS[level] > CURRENT_LEVEL) return;
    const prefix = `[${formatTime()}] [${moduleName}] [${level.toUpperCase()}]`;
    console.error(prefix, ...args);
  }

  return {
    error: (...args) => write('error', args),
    warn: (...args) => write('warn', args),
    log: (...args) => write('log', args),
    debug: (...args) => write('debug', args),
  };
}

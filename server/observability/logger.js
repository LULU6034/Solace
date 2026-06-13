// server/observability/logger.js — 结构化日志

export function createStructuredLogger(module) {
  return {
    info(msg, data = {}) {
      console.log(JSON.stringify({ level: 'info', module, ts: new Date().toISOString(), msg, ...data }));
    },
    warn(msg, data = {}) {
      console.warn(JSON.stringify({ level: 'warn', module, ts: new Date().toISOString(), msg, ...data }));
    },
    error(msg, data = {}) {
      console.error(JSON.stringify({ level: 'error', module, ts: new Date().toISOString(), msg, ...data }));
    },
  };
}

/**
 * ASR 熔断器（Lumi OS 风格）
 *
 * 5 次失败 / 60s 窗口 → 熔断 30s → 半开探测 → 2 次成功恢复
 */
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('circuit');

const WINDOW_MS = 60_000;
const COOLDOWN_MS = 30_000;
const FAIL_THRESHOLD = 5;
const RECOVER_SUCCESSES = 2;

const circuits = new Map();

function getCircuit(provider) {
  if (!circuits.has(provider)) {
    circuits.set(provider, {
      failures: [],       // 时间戳数组
      state: 'closed',    // closed | open | half-open
      openSince: 0,
      halfSuccesses: 0,
    });
  }
  return circuits.get(provider);
}

/** 记录成功 */
export function recordSuccess(provider) {
  const c = getCircuit(provider);
  const now = Date.now();

  if (c.state === 'half-open') {
    c.halfSuccesses++;
    if (c.halfSuccesses >= RECOVER_SUCCESSES) {
      c.state = 'closed';
      c.failures = [];
      c.halfSuccesses = 0;
      log.log(`[${provider}] 熔断器恢复 (closed)`);
    }
  }

  // 修剪过期失败
  c.failures = c.failures.filter(t => now - t < WINDOW_MS);
}

/** 记录失败。返回 true 表示触发熔断 */
export function recordFailure(provider, err) {
  const c = getCircuit(provider);
  const now = Date.now();

  if (c.state === 'half-open') {
    // 半开状态失败 → 重新熔断
    c.state = 'open';
    c.openSince = now;
    c.halfSuccesses = 0;
    log.warn(`[${provider}] 半开探测失败，重新熔断 30s`);
    return true;
  }

  c.failures.push(now);
  c.failures = c.failures.filter(t => now - t < WINDOW_MS);

  if (c.failures.length >= FAIL_THRESHOLD && c.state === 'closed') {
    c.state = 'open';
    c.openSince = now;
    log.warn(`[${provider}] 熔断器打开 (${c.failures.length}次失败/${WINDOW_MS/1000}s)，冷却${COOLDOWN_MS/1000}s`);
    return true;
  }

  return false;
}

/** 检查 provider 是否可用（未熔断） */
export function isCircuitClosed(provider) {
  const c = getCircuit(provider);
  const now = Date.now();

  if (c.state === 'open') {
    if (now - c.openSince >= COOLDOWN_MS) {
      c.state = 'half-open';
      c.halfSuccesses = 0;
      log.log(`[${provider}] 熔断器进入半开探测`);
      return true;  // 允许探测
    }
    return false;
  }

  return true;
}

/** 获取熔断器状态（调试用） */
export function getCircuitState(provider) {
  const c = getCircuit(provider);
  return { state: c.state, failures: c.failures.length };
}

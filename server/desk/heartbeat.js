/**
 * heartbeat.js — Agent 心跳系统
 *
 * Per-agent 心跳：检测用户空闲 + 主动交互触发。
 *
 * 参考 OpenHanako lib/desk/heartbeat.js:
 *   - 文件变化检测 (快照差量)
 *   - 用户空闲检测
 *   - 主动问候生成
 *
 * 宠物场景特殊设计：
 *   - 空闲时随机走动/做表情
 *   - 长时间无操作后主动搭话
 *   - 不会频繁打扰 (冷却机制)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('heartbeat');

// Default: check every 30 seconds
const DEFAULT_INTERVAL = 30_000;
// How long before considered "idle" (no user messages)
const IDLE_THRESHOLD = 5 * 60_000; // 5 minutes
// Minimum cooldown between proactive greetings
const GREETING_COOLDOWN = 15 * 60_000; // 15 minutes
// Very idle threshold: pet gets more animated
const VERY_IDLE_THRESHOLD = 30 * 60_000; // 30 minutes

const GREETINGS = [
  '嘿！好久不见，有什么需要帮忙的吗？',
  '我在这儿呢~ 想聊聊天吗？',
  '你是不是在忙？需要我帮忙查资料或者做点什么吗？',
  '叮咚！你的桌面宠物上线啦，有什么想聊的？',
  '已经安静了好一会儿了，要不要我给你讲个笑话？',
];

const IDLE_ACTIONS = [
  { type: 'wander', description: '宠物闲逛' },
  { type: 'stretch', description: '宠物伸懒腰' },
  { type: 'blink', description: '宠物眨眼' },
  { type: 'sit', description: '宠物坐下' },
  { type: 'look_around', description: '宠物四处张望' },
];

export function createHeartbeat({ agentId, agentConfig = {}, onPulse }) {
  let _timer = null;
  let _started = false;
  let _lastUserActivity = Date.now();
  let _lastGreeting = 0;
  let _pulseCount = 0;

  // File watch state
  let _fileSnapshots = new Map(); // filePath → { mtime, size }
  const _watchDirs = agentConfig.watchDirs || [];

  function _snapshotDir(dir) {
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const fp = path.join(dir, entry.name);
          const stat = fs.statSync(fp);
          const prev = _fileSnapshots.get(fp);
          if (prev && (prev.mtime !== stat.mtimeMs || prev.size !== stat.size)) {
            return { changed: fp, reason: 'file_changed' };
          }
          _fileSnapshots.set(fp, { mtime: stat.mtimeMs, size: stat.size });
        }
      }
    } catch (err) {
      log.warn(`快照目录失败: ${dir} — ${err.message}`);
    }
    return null;
  }

  function _checkWatchDirs() {
    for (const dir of _watchDirs) {
      const change = _snapshotDir(dir);
      if (change) return change;
    }
    return null;
  }

  function _generatePulse() {
    const now = Date.now();
    const idleDuration = now - _lastUserActivity;

    // Check file changes first
    const fileChange = _checkWatchDirs();
    if (fileChange) {
      return {
        reason: 'file_changed',
        file: fileChange.changed,
        greeting: `注意到你修改了文件 ${path.basename(fileChange.changed)}，需要我帮忙看看吗？`,
        idleDuration,
      };
    }

    // Very idle: pet gets more animated
    if (idleDuration > VERY_IDLE_THRESHOLD) {
      // Only greet if cooldown passed
      if (now - _lastGreeting > GREETING_COOLDOWN) {
        _lastGreeting = now;
        const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
        return {
          reason: 'very_idle',
          greeting,
          idleDuration,
          action: IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)],
        };
      }
      // Just do an idle action, no greeting
      return {
        reason: 'very_idle_silent',
        action: IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)],
        idleDuration,
      };
    }

    // Idle: occasional greeting
    if (idleDuration > IDLE_THRESHOLD && now - _lastGreeting > GREETING_COOLDOWN) {
      _lastGreeting = now;
      const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      return {
        reason: 'idle',
        greeting,
        idleDuration,
      };
    }

    // Normal: just mark alive
    return {
      reason: 'tick',
      idleDuration,
    };
  }

  function _pulse() {
    if (!_started) return;
    _pulseCount++;

    try {
      const pulseData = _generatePulse();
      // Only emit if there's something meaningful
      if (pulseData.reason !== 'tick' || _pulseCount % 10 === 0) {
        onPulse?.(pulseData);
      }
    } catch (err) {
      log.error(`心跳错误: ${err.message}`);
    }
  }

  return {
    get interval() { return DEFAULT_INTERVAL; },

    start() {
      if (_started) return;
      // Initial file snapshots
      for (const dir of _watchDirs) {
        _snapshotDir(dir);
      }
      _timer = setInterval(_pulse, DEFAULT_INTERVAL);
      _started = true;
      _lastUserActivity = Date.now();
      log.log(`心跳已启动: ${agentId}`);
    },

    stop() {
      if (_timer) {
        clearInterval(_timer);
        _timer = null;
      }
      _started = false;
      _fileSnapshots.clear();
    },

    /** Notify that user was active (sent a message) */
    notifyActivity() {
      _lastUserActivity = Date.now();
    },

    /** Force a pulse */
    pulse() {
      _pulse();
    },

    /** Get idle duration */
    getIdleDuration() {
      return Date.now() - _lastUserActivity;
    },
  };
}

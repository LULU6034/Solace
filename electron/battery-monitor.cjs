/**
 * battery-monitor.cjs — 电池优化策略 (P2)
 *
 * 监听电源状态，自动调整：
 *   L1 (>50%):  全功能 — VAD 100ms, CosyVoice 可用, Sleep Mode 启用
 *   L2 (20-50%): 降频 — VAD 300ms, CosyVoice 禁用, Sleep Mode 减少
 *   L3 (<20%):   节能 — VAD 1000ms, CosyVoice 禁用, Sleep Mode 禁用, 文字模式
 *
 * 用法: require('./battery-monitor.cjs').registerBatteryMonitor(bridge)
 */

const { powerMonitor } = require('electron');

const PROFILES = {
  high: {
    label: '全功能',
    vadIntervalMs: 100,
    cosyVoiceEnabled: true,
    sleepModeEnabled: true,
    voiceChatEnabled: true,
  },
  medium: {
    label: '降频模式',
    vadIntervalMs: 300,
    cosyVoiceEnabled: false,
    sleepModeEnabled: true,
    voiceChatEnabled: true,
  },
  low: {
    label: '节能模式',
    vadIntervalMs: 1000,
    cosyVoiceEnabled: false,
    sleepModeEnabled: false,
    voiceChatEnabled: true,
  },
  critical: {
    label: '极致节能',
    vadIntervalMs: 0,     // Disable VAD entirely
    cosyVoiceEnabled: false,
    sleepModeEnabled: false,
    voiceChatEnabled: false, // Text-only
  },
};

function classifyLevel(batteryLevel, isCharging) {
  if (isCharging) return 'high';
  if (batteryLevel > 0.5) return 'high';
  if (batteryLevel > 0.2) return 'medium';
  if (batteryLevel > 0.05) return 'low';
  return 'critical';
}

/**
 * Register battery monitor and return { start(), stop(), getProfile() }
 * @param {object} bridge — ServerBridge instance for WebSocket notifications
 */
function registerBatteryMonitor(bridge) {
  let currentLevel = 'high';
  let batteryLevel = 1.0;
  let isCharging = true;

  function applyProfile() {
    const newLevel = classifyLevel(batteryLevel, isCharging);
    if (newLevel === currentLevel) return;

    currentLevel = newLevel;
    const profile = PROFILES[currentLevel];

    console.log(`[battery] Level: ${currentLevel} (${Math.round(batteryLevel * 100)}%) — ${profile.label}`);

    // Notify Node.js server via WebSocket
    if (bridge && bridge.isReady && bridge.isReady()) {
      bridge.send({
        type: 'battery_profile',
        level: currentLevel,
        profile,
        batteryLevel,
        isCharging,
      });
    }

    // Notify all renderer windows
    const { BrowserWindow } = require('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('battery-profile', {
          level: currentLevel,
          profile,
          batteryPercent: Math.round(batteryLevel * 100),
          isCharging,
        });
      }
    }
  }

  // Get initial state
  if (powerMonitor) {
    powerMonitor.getBatteryInfo?.().then(info => {
      batteryLevel = info.batteryLevel ?? 1.0;
      isCharging = info.isCharging ?? true;
      applyProfile();
    }).catch(() => {});

    powerMonitor.on('on-battery', () => {
      isCharging = false;
      applyProfile();
    });

    powerMonitor.on('on-ac', () => {
      isCharging = true;
      applyProfile();
    });

    // Poll battery level periodically (powerMonitor doesn't have level change events)
    setInterval(async () => {
      try {
        const info = await powerMonitor.getBatteryInfo?.();
        if (info) {
          batteryLevel = info.batteryLevel ?? batteryLevel;
          isCharging = info.isCharging ?? isCharging;
          applyProfile();
        }
      } catch {}
    }, 60_000); // Check every minute
  }

  return {
    getProfile: () => ({
      level: currentLevel,
      profile: PROFILES[currentLevel],
      batteryPercent: Math.round(batteryLevel * 100),
      isCharging,
    }),
    getLevel: () => currentLevel,
    getBatteryPercent: () => Math.round(batteryLevel * 100),
  };
}

module.exports = { registerBatteryMonitor, PROFILES };

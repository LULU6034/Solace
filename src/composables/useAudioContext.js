// src/composables/useAudioContext.js — 全局共享 AudioContext 单例
// useAmbientSound 和 useInstantResponse 共用此实例，避免多 AudioContext 竞争

let _ac = null;

export function getSharedAudioContext() {
  if (!_ac) {
    _ac = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _ac;
}

/** 解锁音频（须在用户手势中调用） */
export function unlockAudio() {
  const ac = getSharedAudioContext();
  if (ac.state === 'suspended') {
    ac.resume();
  }
}

export function closeSharedAudioContext() {
  if (_ac) {
    _ac.close();
    _ac = null;
  }
}

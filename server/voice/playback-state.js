/**
 * 共享播放状态 — 供 full-duplex 和 agent-chat 两路径共用
 * 存储在模块顶层，跨会话保持（会话重建时由 full-duplex 更新）
 */
export const playbackState = {
  isPlaying: false,
  song: null, // { songId, name, artist }
};

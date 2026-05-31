/**
 * memory-store-ref.js — 记忆存储引用 (打破循环依赖)
 *
 * 由 tools/index.js 和 memory-tools.js 共享导入。
 * tools/index.js 在初始化时调用 setMemoryStore() 注入。
 */
let _store = null;

export function setMemoryStore(store) {
  _store = store;
}

export function getMemoryStore() {
  return _store;
}

// server/memory/base.js — 记忆基类
// 定义 store/recall/forget 接口

export class MemoryBase {
  constructor(name) {
    this.name = name;
  }

  /** 存储一条记忆 */
  async store(entry) { throw new Error('Not implemented'); }

  /** 召回记忆 */
  async recall(query, opts) { throw new Error('Not implemented'); }

  /** 遗忘记忆 */
  async forget(id) { throw new Error('Not implemented'); }

  /** 记忆数量 */
  count() { return 0; }
}

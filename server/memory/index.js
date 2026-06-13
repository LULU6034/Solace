// server/memory/index.js — MemoryManager 门面
// 统一记忆系统入口，合并 fact-store + episodic + vector-search

import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('memory');

export class MemoryManager {
  constructor(opts = {}) {
    this.factStore = opts.factStore || null;
    this.embedder = opts.embedder || null;
    this.initialized = false;
  }

  async init(factStore) {
    this.factStore = factStore;
    this.initialized = true;
    log.log('MemoryManager 已初始化');
  }

  async recall(query, { limit = 10, personality = null } = {}) {
    if (!this.factStore) return [];
    const facts = await this.factStore.search(query, limit);
    // TODO: 性格加权 (见 docs/restructure-plan.md §7.2)
    return facts;
  }

  async remember(entry) {
    if (!this.factStore) return null;
    return this.factStore.add(entry);
  }

  async forget(id) {
    if (!this.factStore) return false;
    return this.factStore.remove(id);
  }

  count() {
    return this.factStore?.count() || 0;
  }
}

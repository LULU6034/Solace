/**
 * index.js — MemoryManager: 统一管理四层记忆
 */
import { ShortTermMemory } from './short-term.js';
import { FactStoreEnhanced } from './fact-store-enhanced.js';
import { MemoryRetrieval } from './retrieval.js';
import * as episodic from './episodic.js';
import * as mediumTerm from './medium-term.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('mem:mgr');

export class MemoryManager {
  constructor(opts = {}) {
    this.shortTerm = new ShortTermMemory(opts.maxTurns || 20);
    this.factStore = null; // initialized async
    this.retrieval = new MemoryRetrieval({
      shortTerm: this.shortTerm,
      factStore: null,
    });
    this.sessionId = opts.sessionId || `mem_${Date.now()}`;
    this._initPromise = this._init(opts);
  }

  async _init(opts) {
    if (opts.persistDir) {
      this.factStore = new FactStoreEnhanced(opts.persistDir);
      await this.factStore.init();
      this.retrieval.factStore = this.factStore;
    }
  }

  async ready() {
    await this._initPromise;
    return this;
  }

  addTurn(role, content, metadata = {}) {
    this.shortTerm.add(role, content, metadata);
  }

  async getContext(query) {
    const results = await this.retrieval.retrieve(this.sessionId, query);
    return {
      shortTerm: results.shortTerm,
      contextStr: this.retrieval.formatForLLM(results),
      summaries: results.mediumSummaries,
      episodes: results.episodes,
      facts: results.facts,
    };
  }

  async finalizeSession(turns) {
    const now = new Date();
    const dk = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

    // Save important turns as episodic memories
    for (const t of (turns || [])) {
      if (!t.content || t.content.length < 20) continue;
      episodic.addEpisode({
        id: `ep_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        timestamp: Date.now(),
        sessionId: this.sessionId,
        context: {
          timeOfDay: now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening',
          dayOfWeek: now.getDay(),
        },
        emotionalState: {
          userMood: t.emotion || 'neutral',
          agentTone: 'neutral',
          intensity: 0.5,
        },
        content: {
          topic: '',
          userIntent: '',
          agentApproach: '',
          outcome: 'pending',
          keyQuote: (t.content || '').slice(0, 100),
        },
        tags: [],
        importance: 3,
      });
    }

    // Update daily summary
    mediumTerm.upsertSummary(dk, `对话 ${(turns || []).length} 轮`, {
      topics: [],
      turnCount: (turns || []).length,
      sessionIds: [this.sessionId],
    });

    log.log(`会话完成: ${(turns || []).length} 轮`);
  }
}

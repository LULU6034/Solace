/**
 * session-memory.js — 协作模式的会话共享记忆
 *
 * 三层记忆中的"会话记忆"层：
 *  - 协作模式中各 Agent 的中间产物暂存
 *  - 会话结束时提炼到各 Agent 私有记忆
 *  - 对话历史是所有 Agent 天然共享的
 *  - 私有记忆各 Agent 独立（FactStore）
 */
import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('session-memory');

export class SessionMemory {
  constructor() {
    /** @type {Map<string, Array<{agentId: string, content: string, phase: string, ts: number}>>} */
    this._sessions = new Map();
  }

  /**
   * Store an artifact from a collaboration phase
   */
  put(convId, { agentId, content, phase }) {
    if (!this._sessions.has(convId)) {
      this._sessions.set(convId, []);
    }
    this._sessions.get(convId).push({
      agentId,
      content,
      phase,
      ts: Date.now(),
    });
  }

  /**
   * Get all artifacts for a session
   */
  get(convId) {
    return this._sessions.get(convId) || [];
  }

  /**
   * Get artifacts for a specific agent in a session
   */
  getByAgent(convId, agentId) {
    return (this._sessions.get(convId) || []).filter(a => a.agentId === agentId);
  }

  /**
   * Get distilled context for agents (for injection into prompts)
   */
  getContext(convId) {
    const artifacts = this._sessions.get(convId) || [];
    if (artifacts.length === 0) return '';

    return artifacts
      .map(a => `[${a.phase}] ${a.content?.slice(0, 300)}`)
      .join('\n');
  }

  /**
   * End a session — optionally distill findings into agent private memories
   */
  async endSession(convId, agentManager) {
    const artifacts = this._sessions.get(convId) || [];
    if (artifacts.length === 0) return;

    // Distill: for each artifact, store a memory fact in the producing agent's private store
    for (const artifact of artifacts) {
      if (!artifact.content || artifact.content.length < 20) continue;
      try {
        const agent = agentManager?.getAgent(artifact.agentId);
        if (agent?.factStore) {
          const fact = {
            fact: artifact.content.slice(0, 500),
            tags: ['session', artifact.phase || 'collaboration'],
            time: new Date().toISOString(),
          };
          agent.factStore.add(fact);
        }
      } catch (err) {
        log.warn(`会话记忆提炼失败 (agent=${artifact.agentId}): ${err.message}`);
      }
    }

    this._sessions.delete(convId);
    log.log(`会话结束: ${convId} (${artifacts.length} 条记忆已提炼)`);
  }

  /** Clean up old sessions (older than 1 hour) */
  cleanup() {
    const cutoff = Date.now() - 3600_000;
    for (const [id, artifacts] of this._sessions) {
      if (artifacts.length === 0 || artifacts[artifacts.length - 1].ts < cutoff) {
        this._sessions.delete(id);
      }
    }
    log.log(`会话清理完成, 剩余 ${this._sessions.size} 个活跃会话`);
  }
}

// server/observability/cost-tracker.js — Token 成本追踪

export class CostTracker {
  constructor() {
    this.sessions = new Map(); // sessionId → { promptTokens, completionTokens, cost }
  }

  record(sessionId, usage) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { promptTokens: 0, completionTokens: 0, cost: 0 });
    }
    const s = this.sessions.get(sessionId);
    s.promptTokens += usage.promptTokens || 0;
    s.completionTokens += usage.completionTokens || 0;
    s.cost += (usage.promptTokens || 0) * 0.000001 + (usage.completionTokens || 0) * 0.000002;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || { promptTokens: 0, completionTokens: 0, cost: 0 };
  }

  totalCost() {
    let total = 0;
    for (const s of this.sessions.values()) total += s.cost;
    return total;
  }
}

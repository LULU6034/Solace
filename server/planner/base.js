// server/planner/base.js — 规划基类

export class PlannerBase {
  constructor(name) { this.name = name; }

  /** 规划: goal → steps[] */
  async plan(goal, context = {}) { throw new Error('Not implemented'); }
}

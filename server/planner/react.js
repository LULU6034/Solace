// server/planner/react.js — ReAct 规划器
// Thought → Action → Observation 循环

import { PlannerBase } from './base.js';

export class ReActPlanner extends PlannerBase {
  constructor() { super('react'); }

  async plan(goal, context = {}) {
    // 返回 ReAct 步骤模板
    return [
      { type: 'thought', description: '分析任务目标' },
      { type: 'action', description: '执行相关工具调用' },
      { type: 'observation', description: '观察工具返回结果' },
      { type: 'thought', description: '综合结果并回复' },
    ];
  }
}

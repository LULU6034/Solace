// server/workflows/orchestrator.js — 多 Agent 编排器
// 任务分解 → Agent 分配 → 结果聚合

import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('workflows');

export class WorkflowOrchestrator {
  constructor() {
    this.agents = new Map();
  }

  registerAgent(id, handler) {
    this.agents.set(id, handler);
  }

  /** 执行工作流 */
  async execute(workflow, context = {}) {
    const results = [];
    for (const step of workflow.steps) {
      const agent = this.agents.get(step.agent);
      if (!agent) {
        log.warn(`Agent 未注册: ${step.agent}`);
        continue;
      }
      try {
        const result = await agent(step.input, context);
        results.push({ step: step.id, result });
      } catch (err) {
        results.push({ step: step.id, error: err.message });
      }
    }
    return results;
  }
}

// server/workflows/index.js — WorkflowManager 门面

import { WorkflowOrchestrator } from './orchestrator.js';

let _orchestrator = null;

export function getOrchestrator() {
  if (!_orchestrator) {
    _orchestrator = new WorkflowOrchestrator();
  }
  return _orchestrator;
}

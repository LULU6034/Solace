// server/planner/index.js — Planner 门面

import { ReActPlanner } from './react.js';

const planners = {
  react: new ReActPlanner(),
};

export function getPlanner(type = 'react') {
  return planners[type] || planners.react;
}

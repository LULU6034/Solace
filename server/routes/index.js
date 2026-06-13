// server/routes/index.js — 路由注册表

import { handleChat } from './chat.js';

const routes = {
  agent_chat: handleChat,
};

export function getRouteHandler(eventType) {
  return routes[eventType] || null;
}

export default routes;

/**
 * Server 入口 — 由 Electron 主进程 spawn
 *
 * 用法: node server/bootstrap.js
 *
 * Electron spawns this as a child process.
 * The server listens on 127.0.0.1:{AGENT_PORT} with WebSocket.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Set persist dir from env or default
process.env.AGENT_PERSIST_DIR = process.env.AGENT_PERSIST_DIR || resolve(
  process.env.APPDATA || resolve(process.env.HOME || '', '.config'),
  'ai-desktop-pet',
  'agent-data',
);

process.env.AGENT_PORT = process.env.AGENT_PORT || '9876';

// Import and run the server
import('./index.js').catch((err) => {
  console.error('[bootstrap] Server import failed:', err);
  process.exit(1);
});

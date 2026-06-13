// server/config/index.js — 配置加载器

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _config = null;

export function loadConfig(env = process.env.NODE_ENV || 'development') {
  if (_config) return _config;

  const defaultPath = resolve(__dirname, 'default.yaml');
  const envPath = resolve(__dirname, `${env}.yaml`);

  let config = {};
  if (existsSync(defaultPath)) {
    config = yaml.load(readFileSync(defaultPath, 'utf-8'));
  }

  if (existsSync(envPath)) {
    const envConfig = yaml.load(readFileSync(envPath, 'utf-8'));
    Object.assign(config, envConfig);
  }

  // 环境变量覆盖
  if (process.env.AGENT_PORT) config.server.port = parseInt(process.env.AGENT_PORT);
  if (process.env.AGENT_PERSIST_DIR) config.server.persistDir = process.env.AGENT_PERSIST_DIR;

  _config = config;
  return config;
}

export function getConfig() {
  if (!_config) return loadConfig();
  return _config;
}

/**
 * plugin-manager.js — 插件管理器
 *
 * 参考 OpenHanako core/plugin-manager.js:
 *   - 插件清单 (manifest.json) 解析
 *   - 加载/卸载/激活生命周期
 *   - 贡献注册 (tools, routes, skills, commands)
 *   - 权限模型 (restricted / full-access)
 *   - PluginContext 服务注入
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('plugin-manager');

// Known contribution directories
const CONTRIBUTION_DIRS = ['tools', 'routes', 'skills', 'commands'];

export class PluginContext {
  constructor({ pluginId, pluginDir, services }) {
    this.pluginId = pluginId;
    this.pluginDir = pluginDir;
    this.services = services;
    this._started = false;
  }

  get eventBus() { return this.services.eventBus; }
  get logger() { return createModuleLogger(`plugin:${this.pluginId}`); }
  get agentManager() { return this.services.agentManager; }
  get config() { return this._config || {}; }

  _setConfig(config) { this._config = config; }
}

export class PluginManager {
  /**
   * @param {object} opts
   * @param {string[]} opts.pluginDirs — directories to scan for plugins
   * @param {string} opts.dataDir — plugin data directory
   * @param {object} opts.services — services to inject into PluginContext
   */
  constructor({ pluginDirs = [], dataDir, services = {} }) {
    this.pluginDirs = pluginDirs;
    this.dataDir = dataDir;
    this.services = services;

    /** @type {Map<string, {manifest,dir,context,status:'loaded'|'active'|'error'}>} */
    this._plugins = new Map();
    this._contributions = {
      tools: [],
      routes: [],
      skills: [],
      commands: [],
    };
  }

  /**
   * Scan all plugin directories and load manifests
   */
  async loadAll() {
    for (const dir of this.pluginDirs) {
      if (!fs.existsSync(dir)) continue;
      await this._scanDir(dir);
    }
    log.log(`加载完成: ${this._plugins.size} 个插件`);
    return this._plugins.size;
  }

  async _scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = path.join(dir, entry.name);
      const manifestPath = path.join(pluginDir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) continue;

      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw);

        const id = manifest.id || entry.name;
        this._plugins.set(id, {
          manifest,
          dir: pluginDir,
          context: new PluginContext({ pluginId: id, pluginDir, services: this.services }),
          status: 'loaded',
        });

        log.log(`插件加载: ${id} v${manifest.version || '0.0.0'}`);
      } catch (err) {
        log.warn(`插件加载失败: ${entry.name} — ${err.message}`);
      }
    }
  }

  /**
   * Activate a plugin: load contributions
   */
  async activatePlugin(pluginId) {
    const plugin = this._plugins.get(pluginId);
    if (!plugin) throw new Error(`插件不存在: ${pluginId}`);
    if (plugin.status === 'active') return;

    const { dir, context, manifest } = plugin;

    try {
      // Load contributions from subdirectories
      for (const contribDir of CONTRIBUTION_DIRS) {
        const contribPath = path.join(dir, contribDir);
        if (!fs.existsSync(contribPath)) continue;

        const files = fs.readdirSync(contribPath).filter(f => f.endsWith('.js'));
        for (const file of files) {
          const modPath = path.join(contribPath, file);
          try {
            const mod = await import(`file://${modPath}`);
            this._contributions[contribDir].push({
              pluginId,
              source: modPath,
              exports: mod,
            });
          } catch (err) {
            log.warn(`插件贡献加载失败: ${modPath} — ${err.message}`);
          }
        }
      }

      // Call plugin lifecycle
      if (manifest.activateEvent) {
        context.eventBus?.emit(`plugin:${pluginId}:activate`, { context });
      }

      plugin.status = 'active';
      context._started = true;
      log.log(`插件已激活: ${pluginId}`);
    } catch (err) {
      plugin.status = 'error';
      log.error(`插件激活失败: ${pluginId} — ${err.message}`);
      throw err;
    }
  }

  /**
   * Deactivate a plugin
   */
  async deactivatePlugin(pluginId) {
    const plugin = this._plugins.get(pluginId);
    if (!plugin || plugin.status !== 'active') return;

    // Remove contributions
    for (const contribDir of CONTRIBUTION_DIRS) {
      this._contributions[contribDir] = this._contributions[contribDir]
        .filter(c => c.pluginId !== pluginId);
    }

    plugin.status = 'loaded';
    plugin.context._started = false;
    log.log(`插件已停用: ${pluginId}`);
  }

  /**
   * Uninstall a plugin
   */
  async uninstallPlugin(pluginId) {
    await this.deactivatePlugin(pluginId);
    this._plugins.delete(pluginId);
    log.log(`插件已卸载: ${pluginId}`);
  }

  /** List all plugins */
  listPlugins() {
    return [...this._plugins.values()].map(p => ({
      id: p.manifest.id,
      name: p.manifest.name || p.manifest.id,
      version: p.manifest.version || '0.0.0',
      description: p.manifest.description || '',
      status: p.status,
      trust: p.manifest.trust || 'restricted',
    }));
  }

  /** Get a plugin */
  getPlugin(pluginId) {
    return this._plugins.get(pluginId) || null;
  }

  /** Get all contributions of a type */
  getContributions(type) {
    return this._contributions[type] || [];
  }

  /** Get plugin count */
  get count() {
    return this._plugins.size;
  }
}

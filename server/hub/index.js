/**
 * hub/index.js — Hub 编排器
 *
 * 同进程内的中央编排器，连接 Engine、Server、所有 Agent。
 * 参考 OpenHanako hub/index.js 设计：
 *   - 持有 Scheduler、EventBus 引用
 *   - start/stop 生命周期
 *   - 统一消息路由
 */
import { createEventBus } from './event-bus.js';
import { createScheduler } from './scheduler.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('hub');

export class Hub {
  constructor({ engine, persistDir }) {
    this.engine = engine;
    this.persistDir = persistDir;

    // Subsystems (created in start())
    this.eventBus = null;
    this.scheduler = null;

    // State
    this._started = false;
  }

  start() {
    if (this._started) return;
    log.log('Hub 启动中...');

    // 1. Event bus first (other subsystems depend on it)
    this.eventBus = createEventBus({ hub: this });
    log.log('EventBus 已创建');

    // 2. Scheduler (cron + heartbeat)
    this.scheduler = createScheduler({
      hub: this,
      persistDir: this.persistDir,
      engine: this.engine,
    });
    this.scheduler.start();
    log.log('Scheduler 已启动');

    this._started = true;
    log.log('Hub 启动完成');
  }

  async stop() {
    if (!this._started) return;
    log.log('Hub 停止中...');

    if (this.scheduler) {
      await this.scheduler.stop();
      this.scheduler = null;
    }

    if (this.eventBus) {
      this.eventBus.destroy();
      this.eventBus = null;
    }

    this._started = false;
    log.log('Hub 已停止');
  }

  /** 获取 cron scheduler */
  getCronScheduler() {
    return this.scheduler?.cron;
  }

  /** 获取 heartbeat registry */
  getHeartbeat(agentId) {
    return this.scheduler?.heartbeats?.get(agentId);
  }

  /** 广播事件到所有监听器 */
  emit(eventType, data) {
    this.eventBus?.emit(eventType, data);
  }
}

/**
 * event-bus.js — 事件总线
 *
 * 发布订阅模式：
 *   emit/subscribe — 广播通知 (cron_job_done, activity_update, etc.)
 *   request/handle  — 请求响应模式 (30s 超时)
 *
 * 参考 OpenHanako hub/event-bus.js 设计。
 */
import { v4 as uuidv4 } from 'uuid';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('event-bus');

export function createEventBus({ hub } = {}) {
  // Global subscribers: eventType → Set<{ id, callback, filter? }>
  const _subscribers = new Map();

  // Request handlers: eventType → callback
  const _handlers = new Map();

  // Session-indexed subscribers for efficient filtering
  // sessionPath → Set<subId>
  const _sessionIndex = new Map();

  let _destroyed = false;

  function _checkDestroyed() {
    if (_destroyed) throw new Error('EventBus 已销毁');
  }

  /**
   * Emit an event to all matching subscribers
   */
  function emit(eventType, data = {}) {
    _checkDestroyed();
    const subs = _subscribers.get(eventType);
    if (!subs || subs.size === 0) return;

    const event = {
      type: eventType,
      data,
      timestamp: new Date().toISOString(),
    };

    for (const sub of subs) {
      try {
        // Apply session filter if present
        if (sub.filter?.sessionPath && data.sessionPath !== sub.filter.sessionPath) {
          continue;
        }
        sub.callback(event);
      } catch (err) {
        log.error(`emit 回调失败 [${eventType}]: ${err.message}`);
      }
    }
  }

  /**
   * Subscribe to events
   * @param {string} eventType — event type or '*' for all
   * @param {Function} callback
   * @param {Object} [filter] — optional { sessionPath }
   * @returns {Function} unsubscribe
   */
  function subscribe(eventType, callback, filter = null) {
    _checkDestroyed();
    if (!_subscribers.has(eventType)) {
      _subscribers.set(eventType, new Set());
    }

    const id = uuidv4();
    const sub = { id, callback, filter };
    _subscribers.get(eventType).add(sub);

    // Session index
    if (filter?.sessionPath) {
      if (!_sessionIndex.has(filter.sessionPath)) {
        _sessionIndex.set(filter.sessionPath, new Set());
      }
      _sessionIndex.get(filter.sessionPath).add(id);
    }

    return () => {
      const subs = _subscribers.get(eventType);
      if (subs) {
        subs.delete(sub);
        if (subs.size === 0) _subscribers.delete(eventType);
      }
      if (filter?.sessionPath) {
        const idx = _sessionIndex.get(filter.sessionPath);
        if (idx) {
          idx.delete(id);
          if (idx.size === 0) _sessionIndex.delete(filter.sessionPath);
        }
      }
    };
  }

  /**
   * Register a request handler
   * @returns {Function} unregister
   */
  function handle(eventType, callback) {
    _checkDestroyed();
    if (_handlers.has(eventType)) {
      log.warn(`重复注册 handler: ${eventType}`);
    }
    _handlers.set(eventType, callback);
    return () => _handlers.delete(eventType);
  }

  /**
   * Send a request and wait for response
   * @returns {Promise<any>} response or null on timeout
   */
  async function request(eventType, data = {}, timeoutMs = 30_000) {
    _checkDestroyed();
    const handler = _handlers.get(eventType);
    if (!handler) {
      log.warn(`无 handler: ${eventType}`);
      return null;
    }

    try {
      const result = await Promise.race([
        handler(data),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`请求超时: ${eventType}`)), timeoutMs)
        ),
      ]);
      return result;
    } catch (err) {
      log.warn(`request 失败 [${eventType}]: ${err.message}`);
      return null;
    }
  }

  /**
   * Get subscriber count for diagnostics
   */
  function subscriberCount(eventType = null) {
    if (eventType) return _subscribers.get(eventType)?.size || 0;
    let total = 0;
    for (const subs of _subscribers.values()) total += subs.size;
    return total;
  }

  function destroy() {
    _subscribers.clear();
    _handlers.clear();
    _sessionIndex.clear();
    _destroyed = true;
  }

  return {
    emit,
    subscribe,
    handle,
    request,
    subscriberCount,
    destroy,
    get isDestroyed() { return _destroyed; },
  };
}

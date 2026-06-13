/**
 * reminder-tool.js — 定时提醒工具
 *
 * schedule_reminder — 设置定时提醒，到时通过 WebSocket 推送通知
 * cancel_reminder   — 取消已设置的提醒
 * list_reminders    — 列出所有活跃提醒
 */
import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('reminder');

// 模块级存储：{ id: { task, fireAt, timer } }
const _reminders = new Map();
let _sendEvent = null; // WebSocket send function, set by server

/**
 * 设置 WebSocket 发送函数，用于推送提醒通知。
 */
export function setReminderSender(sendFn) {
  _sendEvent = sendFn;
}

function _makeId() {
  return `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export const scheduleReminder = {
  name: 'schedule_reminder',
  description: `设置定时提醒。用户说"X分钟后提醒我""等会叫我""定个闹钟""XX分钟后告诉我"时使用。
参数 task: 提醒内容（要做什么）
参数 minutes: 多少分钟后提醒（数字）
参数 seconds: 多少秒后提醒（数字，与 minutes 二选一，精确到秒）`,
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '提醒内容，如"去开会""喝水""休息一下"' },
      minutes: { type: 'number', description: '多少分钟后提醒' },
      seconds: { type: 'number', description: '多少秒后提醒（与 minutes 二选一）' },
    },
    required: ['task'],
  },
  async invoke({ task, minutes = 0, seconds = 0 }) {
    const delayMs = (minutes * 60 + seconds) * 1000;
    if (delayMs <= 0) return '请指定有效的时间（分钟或秒）。';
    if (delayMs > 86400000) return '提醒时间不能超过 24 小时。';

    const id = _makeId();
    const fireAt = Date.now() + delayMs;

    const timer = setTimeout(() => {
      // 推送提醒通知
      if (_sendEvent) {
        _sendEvent('reminder_fire', {
          id,
          task,
          message: `⏰ 提醒: ${task}`,
        });
      }
      log.log(`提醒触发: ${task}`);
      _reminders.delete(id);
    }, delayMs);

    _reminders.set(id, { task, fireAt, timer });
    log.log(`提醒已设置: "${task}" ${minutes > 0 ? minutes + '分钟' : seconds + '秒'}后 (ID: ${id})`);

    const timeStr = minutes > 0 ? `${minutes} 分钟` : `${seconds} 秒`;
    return `已设置提醒: ${timeStr}后提醒你「${task}」`;
  },
};

export const cancelReminder = {
  name: 'cancel_reminder',
  description: '取消定时提醒。用户说"取消提醒""不用提醒了"时使用。',
  parameters: {
    type: 'object',
    properties: {
      task_keyword: { type: 'string', description: '要取消的提醒关键词，匹配任务描述' },
    },
    required: ['task_keyword'],
  },
  async invoke({ task_keyword }) {
    let cancelled = 0;
    for (const [id, rem] of _reminders) {
      if (rem.task.includes(task_keyword)) {
        clearTimeout(rem.timer);
        _reminders.delete(id);
        cancelled++;
        log.log(`提醒已取消: "${rem.task}" (ID: ${id})`);
      }
    }
    if (cancelled === 0) return `没有找到匹配「${task_keyword}」的提醒。`;
    return `已取消 ${cancelled} 个提醒。`;
  },
};

export const listReminders = {
  name: 'list_reminders',
  description: '列出当前所有活跃的提醒。用户问"有哪些提醒""看看我的闹钟"时使用。',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async invoke() {
    if (_reminders.size === 0) return '当前没有活跃的提醒。';
    const now = Date.now();
    const lines = [];
    for (const [id, rem] of _reminders) {
      const remaining = Math.max(0, Math.round((rem.fireAt - now) / 1000));
      const min = Math.floor(remaining / 60);
      const sec = remaining % 60;
      const timeStr = min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
      lines.push(`- ${rem.task} (${timeStr}后)`);
    }
    return `当前 ${_reminders.size} 个提醒:\n${lines.join('\n')}`;
  },
};

export const reminderTools = [scheduleReminder, cancelReminder, listReminders];

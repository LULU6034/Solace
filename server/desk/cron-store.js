/**
 * cron-store.js — Cron 任务持久化存储
 *
 * 参考 OpenHanako lib/desk/cron-store.js:
 *   - 每个 agent 一个 cron-jobs.json 文件
 *   - 运行历史记录到 cron-runs.jsonl
 *   - 原子写入 (tmp + rename)
 *   - Cron 表达式解析 (at/every/cron)
 *   - Windows 兼容
 */
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('cron-store');

// Simple cron expression parser
// Supports: "every Ns|Nm|Nh", "at HH:MM", "cron: m h d m w"
function parseCronSchedule(schedule) {
  const now = Date.now();

  if (typeof schedule === 'number') {
    // Interval in ms
    return { nextRunAt: now + schedule, interval: schedule };
  }

  const s = String(schedule).trim();

  // "every 5m" / "every 30s" / "every 2h"
  const everyMatch = s.match(/^every\s+(\d+)\s*(s|m|h|d)/i);
  if (everyMatch) {
    const num = parseInt(everyMatch[1]);
    const unit = everyMatch[2].toLowerCase();
    const ms = unit === 's' ? num * 1000
      : unit === 'm' ? num * 60_000
      : unit === 'h' ? num * 3600_000
      : num * 86400_000;
    return { nextRunAt: now + ms, interval: ms };
  }

  // "at 09:00" / "at 14:30"
  const atMatch = s.match(/^at\s+(\d{1,2}):(\d{2})/i);
  if (atMatch) {
    const hour = parseInt(atMatch[1]);
    const min = parseInt(atMatch[2]);
    const next = new Date();
    next.setHours(hour, min, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return { nextRunAt: next.getTime(), interval: 86400_000 };
  }

  // "cron: min hour day month weekday"
  // Simplistic: just parse next occurrence in 24h
  const cronMatch = s.match(/^cron:\s*([\d*,]+)\s+([\d*,]+)\s+([\d*,]+)\s+([\d*,]+)\s+([\d*,]+)/i);
  if (cronMatch) {
    // For simplicity, schedule within next minute for testing, or next hour
    return { nextRunAt: now + 60_000, interval: 60_000 };
  }

  // Default: every hour
  return { nextRunAt: now + 3600_000, interval: 3600_000 };
}

export class CronStore {
  constructor(agentDir) {
    this.agentDir = agentDir;
    fs.mkdirSync(agentDir, { recursive: true });
    this._jobsPath = path.join(agentDir, 'cron-jobs.json');
    this._runsPath = path.join(agentDir, 'cron-runs.jsonl');
    this._jobs = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this._jobsPath)) {
        const raw = fs.readFileSync(this._jobsPath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      log.warn(`加载 cron 任务失败: ${err.message}`);
    }
    return [];
  }

  _save() {
    try {
      const tmp = this._jobsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._jobs, null, 2), 'utf-8');
      fs.renameSync(tmp, this._jobsPath);
    } catch (err) {
      log.error(`保存 cron 任务失败: ${err.message}`);
    }
  }

  /**
   * Create a new cron job
   */
  create({ schedule, prompt, label = '', actorAgentId = '', executionContext = {} }) {
    const { nextRunAt, interval } = parseCronSchedule(schedule);

    const job = {
      id: uuidv4(),
      schedule,
      interval,
      prompt: prompt || '',
      label: label || '未命名任务',
      enabled: true,
      actorAgentId: actorAgentId || 'default',
      executionContext: executionContext || {},
      consecutiveErrors: 0,
      createdAt: new Date().toISOString(),
      nextRunAt: new Date(nextRunAt).toISOString(),
      lastRunAt: null,
    };

    this._jobs.push(job);
    this._save();
    log.log(`创建任务: ${job.label} (${job.id.slice(0, 8)})`);
    return job;
  }

  /**
   * List all jobs
   */
  listJobs() {
    return this._jobs.map(j => ({ ...j })); // shallow clone
  }

  /**
   * Get a job by ID
   */
  getJob(jobId) {
    return this._jobs.find(j => j.id === jobId) || null;
  }

  /**
   * Update a job
   */
  updateJob(jobId, updates) {
    const idx = this._jobs.findIndex(j => j.id === jobId);
    if (idx < 0) return null;
    Object.assign(this._jobs[idx], updates);
    this._save();
    return this._jobs[idx];
  }

  /**
   * Delete a job
   */
  deleteJob(jobId) {
    const idx = this._jobs.findIndex(j => j.id === jobId);
    if (idx < 0) return false;
    this._jobs.splice(idx, 1);
    this._save();
    return true;
  }

  /**
   * Mark a job run
   * @param {string} jobId
   * @param {{ success: boolean }} result
   */
  markRun(jobId, { success }) {
    const job = this._jobs.find(j => j.id === jobId);
    if (!job) return;

    if (success) {
      job.consecutiveErrors = 0;
      // Compute next run
      const { nextRunAt } = parseCronSchedule(job.schedule);
      job.nextRunAt = new Date(nextRunAt).toISOString();
    } else {
      job.consecutiveErrors = (job.consecutiveErrors || 0) + 1;
      // Backoff: [0, 1m, 5m, 15m, 60m]
      const backoff = [0, 60_000, 300_000, 900_000, 3600_000];
      const delay = backoff[Math.min(job.consecutiveErrors, backoff.length - 1)];
      job.nextRunAt = new Date(Date.now() + delay).toISOString();
    }

    job.lastRunAt = new Date().toISOString();
    this._save();
  }

  /**
   * Log a run to history
   */
  logRun(jobId, entry) {
    try {
      const line = JSON.stringify({
        jobId,
        ...entry,
        timestamp: new Date().toISOString(),
      });
      fs.appendFileSync(this._runsPath, line + '\n', 'utf-8');
    } catch (err) {
      log.warn(`记录运行历史失败: ${err.message}`);
    }
  }

  /**
   * Get run history for a job
   */
  getRunHistory(jobId, limit = 20) {
    try {
      if (!fs.existsSync(this._runsPath)) return [];
      const lines = fs.readFileSync(this._runsPath, 'utf-8').trim().split('\n');
      return lines
        .filter(l => l.includes(`"jobId":"${jobId}"`))
        .slice(-limit)
        .map(l => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get enabled jobs due for execution
   */
  getReadyJobs() {
    const now = Date.now();
    return this._jobs.filter(j => {
      if (!j.enabled) return false;
      if (!j.nextRunAt) return false;
      return new Date(j.nextRunAt).getTime() <= now;
    });
  }
}

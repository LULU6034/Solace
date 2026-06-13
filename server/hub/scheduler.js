/**
 * scheduler.js — Cron + Heartbeat 调度器
 *
 * 参考 OpenHanako hub/scheduler.js:
 *   - Cron: 每 60s 检查到期任务，确定性调度层，执行时调 Agent
 *   - Heartbeat: per-agent 空闲检测 + 主动问候
 *   - 分离：Cron 是 Studio 级，Heartbeat 是 per-agent
 */
import { CronStore } from '../desk/cron-store.js';
import { createHeartbeat } from '../desk/heartbeat.js';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('scheduler');

const CHECK_INTERVAL = 60_000; // 1 minute
const EXEC_TIMEOUT = 300_000;  // 5 minutes per job

export function createScheduler({ hub, persistDir, engine }) {
  const cronStore = new CronStore(persistDir);
  const heartbeats = new Map(); // agentId → heartbeat instance
  let _timer = null;
  let _checking = false;
  let _started = false;

  // Track executing jobs to prevent concurrent runs
  const _executingJobs = new Map(); // jobId → AbortController

  async function _checkJobs() {
    if (_checking) return;
    _checking = true;

    try {
      const readyJobs = cronStore.getReadyJobs();
      if (readyJobs.length === 0) { _checking = false; return; }

      log.log(`${readyJobs.length} 个到期任务`);

      for (const job of readyJobs) {
        if (_executingJobs.has(job.id)) {
          log.log(`任务 ${job.label} 正在执行中，跳过`);
          continue;
        }

        await _executeJob(job);
      }
    } catch (err) {
      log.error(`checkJobs 错误: ${err.message}`);
    } finally {
      _checking = false;
    }
  }

  async function _executeJob(job) {
    const controller = new AbortController();
    _executingJobs.set(job.id, controller);

    const startedAt = new Date().toISOString();
    log.log(`执行任务: ${job.label} (${job.id.slice(0, 8)})`);

    hub?.emit('cron_job_started', { jobId: job.id, label: job.label });

    try {
      // Execute: create a short agent session with the job prompt
      const resultPromise = engine
        ? engine.executeCronJob?.(job, controller.signal)
        : Promise.resolve({ content: '(无 engine，跳过执行)' });

      const result = await Promise.race([
        resultPromise,
        new Promise((_, reject) =>
          setTimeout(() => {
            controller.abort();
            reject(new Error('任务执行超时 (5min)'));
          }, EXEC_TIMEOUT)
        ),
      ]);

      const finishedAt = new Date().toISOString();
      cronStore.logRun(job.id, { status: 'success', startedAt, finishedAt, ...result });
      cronStore.markRun(job.id, { success: true });
      log.log(`任务成功: ${job.label}`);

      hub?.emit('cron_job_done', { jobId: job.id, label: job.label, success: true });
    } catch (err) {
      const finishedAt = new Date().toISOString();
      cronStore.logRun(job.id, { status: 'error', startedAt, finishedAt, error: err.message });
      cronStore.markRun(job.id, { success: false });
      log.error(`任务失败 ${job.id.slice(0, 8)}: ${err.message}`);

      hub?.emit('cron_job_done', { jobId: job.id, label: job.label, success: false, error: err.message });
    } finally {
      _executingJobs.delete(job.id);
    }
  }

  // ── Heartbeat management ──

  function _startAgentHeartbeat(agentId, agentConfig = {}) {
    if (heartbeats.has(agentId)) return;

    const hb = createHeartbeat({
      agentId,
      agentConfig,
      onPulse: async (pulseData) => {
        log.log(`心跳触发: ${agentId} — ${pulseData.reason}`);
        hub?.emit('heartbeat_pulse', { agentId, ...pulseData });
        // Notify frontend via WebSocket
        hub?.emit('agent_notification', {
          agentId,
          type: 'heartbeat',
          content: pulseData.greeting || `${agentId} 向你打了个招呼`,
          data: pulseData,
        });
      },
    });
    hb.start();
    heartbeats.set(agentId, hb);
    log.log(`心跳已启动: ${agentId} (间隔 ${hb.interval / 1000}s)`);
  }

  function _stopAgentHeartbeat(agentId) {
    const hb = heartbeats.get(agentId);
    if (hb) {
      hb.stop();
      heartbeats.delete(agentId);
    }
  }

  // ── Public API ──
  const api = {
    cron: {
      create: (opts) => cronStore.create(opts),
      list: () => cronStore.listJobs(),
      get: (id) => cronStore.getJob(id),
      update: (id, updates) => cronStore.updateJob(id, updates),
      delete: (id) => cronStore.deleteJob(id),
      getHistory: (id, limit) => cronStore.getRunHistory(id, limit),
      getReadyJobs: () => cronStore.getReadyJobs(),
    },
    heartbeats,
    startAgentHeartbeat: _startAgentHeartbeat,
    stopAgentHeartbeat: _stopAgentHeartbeat,

    start() {
      if (_started) return;
      _timer = setInterval(_checkJobs, CHECK_INTERVAL);
      _started = true;
      log.log('调度器已启动 (60s 检查间隔)');
      // Run initial check
      _checkJobs();
    },

    async stop() {
      _started = false;
      if (_timer) {
        clearInterval(_timer);
        _timer = null;
      }
      // Stop all heartbeats
      for (const [agentId, hb] of heartbeats) {
        hb.stop();
      }
      heartbeats.clear();
      // Abort executing jobs
      for (const [jobId, controller] of _executingJobs) {
        controller.abort();
      }
      _executingJobs.clear();
      log.log('调度器已停止');
    },
  };

  return api;
}

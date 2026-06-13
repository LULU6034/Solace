/**
 * emotion-trend.js — 情绪趋势分析 + 三级预警 (Phase 4)
 *
 * L1: 主动关怀 — 单次对话负面情绪 >60%
 * L2: 建议休息 — 连续 3 天负面情绪 >50%
 * L3: 外部资源 — 连续 7 天负面情绪 >40% + 关键词匹配
 */

import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('mem:emotion');

const ALERT_KEYWORDS = [
  '累死了', '不想活了', '没意思', '绝望', '崩溃',
  '活着没意义', '想死', '熬不下去了', '太累了',
];

export class EmotionTrend {
  constructor(persistDir) {
    this.filePath = persistDir
      ? path.join(persistDir, 'emotion-log.jsonl')
      : null;
    this.entries = []; // [{date, emotions: {happy: N, sad: N, ...}, turnCount, keywords: []}]
    this.load();
  }

  /** Record a turn's emotion */
  record(emotion) {
    const today = this._today();
    let entry = this.entries.find(e => e.date === today);
    if (!entry) {
      entry = { date: today, emotions: {}, turnCount: 0, keywords: [] };
      this.entries.push(entry);
      // Keep only last 30 days
      if (this.entries.length > 30) this.entries.shift();
    }
    entry.emotions[emotion] = (entry.emotions[emotion] || 0) + 1;
    entry.turnCount++;
    this.save();
  }

  /** Check chat text for alert keywords */
  checkKeywords(text) {
    if (!text) return [];
    return ALERT_KEYWORDS.filter(kw => text.includes(kw));
  }

  /**
   * Get alert level:
   * 0 = none, 1 = L1 (concern), 2 = L2 (suggest rest), 3 = L3 (resources)
   */
  getAlertLevel() {
    if (this.entries.length === 0) return 0;

    // L1: Last session was very negative
    const last = this.entries[this.entries.length - 1];
    const negRatio = this._negRatio(last);
    if (negRatio > 0.6) return 1;

    // L2: 3+ consecutive days with >50% negative
    let streak = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this._negRatio(this.entries[i]) > 0.5) streak++;
      else break;
    }
    if (streak >= 3) return 2;

    // L3: 7+ days with >40% negative
    const recent7 = this.entries.slice(-7);
    if (recent7.length >= 5 &&
        recent7.filter(e => this._negRatio(e) > 0.4).length >= 5) {
      return 3;
    }

    return 0;
  }

  /** Get alert response message */
  getAlertMessage() {
    const level = this.getAlertLevel();
    switch (level) {
      case 1:
        return '我注意到你今天好像有些情绪低落。想聊聊吗？';
      case 2:
        return '这几天你看起来状态不太好。如果累了就好好休息一下，我一直在这儿。';
      case 3:
        return '你最近似乎一直不太开心。如果你需要专业的支持，全国心理援助热线是 400-161-9995，随时可以拨打。我会一直陪着你。';
      default:
        return null;
    }
  }

  /** Weekly emotion report */
  getWeeklyReport() {
    const recent7 = this.entries.slice(-7);
    if (recent7.length === 0) return null;

    const dominant = {};
    for (const e of recent7) {
      const sorted = Object.entries(e.emotions).sort((a, b) => b[1] - a[1]);
      if (sorted[0]) {
        dominant[sorted[0][0]] = (dominant[sorted[0][0]] || 0) + 1;
      }
    }
    const topEmotion = Object.entries(dominant).sort((a, b) => b[1] - a[1])[0];
    const totalTurns = recent7.reduce((s, e) => s + e.turnCount, 0);
    const negDays = recent7.filter(e => this._negRatio(e) > 0.4).length;

    return {
      dominantEmotion: topEmotion?.[0] || 'unknown',
      totalTurns,
      negativeDays: negDays,
      trend: negDays >= 4 ? 'declining' : negDays >= 2 ? 'unstable' : 'stable',
    };
  }

  _negRatio(entry) {
    if (!entry || entry.turnCount === 0) return 0;
    const neg = (entry.emotions.sad || 0) + (entry.emotions.angry || 0) + (entry.emotions.worried || 0);
    return neg / entry.turnCount;
  }

  _today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  load() {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath)) {
        this.entries = fs.readFileSync(this.filePath, 'utf-8')
          .split('\n').filter(Boolean).map(JSON.parse);
      }
    } catch {}
  }

  save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath,
        this.entries.map(JSON.stringify).join('\n') + '\n');
    } catch {}
  }
}

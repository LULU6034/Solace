/**
 * style-adapter.js — 对话风格个性化适配 (Phase 4)
 *
 * 学习用户的: 长度偏好、风格倾向、专业领域
 * 动态调整: LLM system prompt 附加指令
 */

import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('mem:style');

export class StyleAdapter {
  constructor(persistDir) {
    this.filePath = persistDir
      ? path.join(persistDir, 'style-profile.json')
      : null;
    this.profile = {
      verbosity: 0.5,      // 0=short, 1=detailed
      formality: 0.5,      // 0=casual, 1=formal
      humor: 0.3,          // humor preference
      expertise: {},        // { domain: weight }
      recentLengths: [],    // Last 10 user message lengths
    };
    this.load();
  }

  /**
   * Analyze a user message and update style profile.
   */
  analyzeMessage(text) {
    if (!text || text.length < 5) return;

    // Track message length
    this.profile.recentLengths.push(text.length);
    if (this.profile.recentLengths.length > 10) this.profile.recentLengths.shift();

    // Update verbosity based on average length
    const avgLen = this.profile.recentLengths.reduce((s, l) => s + l, 0) /
                   this.profile.recentLengths.length;
    // Normalize: 10 chars → 0.3, 100 chars → 0.8
    this.profile.verbosity = Math.min(0.9, Math.max(0.2, avgLen / 150));

    // Detect formality
    const formalMarkers = ['请', '您', '谢谢', '麻烦', '能否', '是否可以', '建议'];
    const casualMarkers = ['哈哈', '哦', '嗯', '~', '吧', '吗', '啊', '耶', '！'];
    let formalScore = 0, casualScore = 0;
    for (const m of formalMarkers) if (text.includes(m)) formalScore++;
    for (const m of casualMarkers) if (text.includes(m)) casualScore++;
    if (formalScore + casualScore > 0) {
      this.profile.formality = formalScore / (formalScore + casualScore + 1);
    }

    // Detect humor
    const humorMarkers = ['哈哈', '笑', '搞笑', '逗', '😂', '🤣'];
    for (const m of humorMarkers) if (text.includes(m)) this.profile.humor += 0.05;
    this.profile.humor = Math.min(0.8, this.profile.humor * 0.95); // Decay

    // Detect expertise domains
    const domains = {
      programming: ['代码', '编程', 'bug', 'API', '函数', '类', 'JavaScript', 'Python', 'git', 'commit', 'import', 'export'],
      medicine: ['症状', '医生', '药', '医院', '诊断', '治疗', '病'],
      law: ['合同', '法律', '律师', '条款', '诉讼', '法院', '法规'],
      finance: ['股票', '投资', '基金', '理财', '贷款', '利息', '收入'],
      design: ['设计', 'UI', '颜色', '布局', '字体', '动画', '样式'],
    };
    for (const [domain, keywords] of Object.entries(domains)) {
      for (const kw of keywords) {
        if (text.includes(kw)) {
          this.profile.expertise[domain] =
            Math.min(1.0, (this.profile.expertise[domain] || 0) + 0.05);
        }
      }
    }

    this.save();
  }

  /**
   * Generate LLM system prompt suffix based on style profile.
   */
  formatForLLM() {
    const lines = [];

    // Verbosity
    if (this.profile.verbosity < 0.35) {
      lines.push('- 回复简洁，控制在 2-3 句以内');
    } else if (this.profile.verbosity > 0.7) {
      lines.push('- 提供详细分析，展示推理过程');
    }

    // Formality
    if (this.profile.formality > 0.6) {
      lines.push('- 使用礼貌专业的语气');
    } else if (this.profile.formality < 0.3) {
      lines.push('- 使用轻松自然的语气，可以适当幽默');
    }

    // Humor
    if (this.profile.humor > 0.5) {
      lines.push('- 可以适当加入幽默元素');
    }

    // Expertise
    const topDomains = Object.entries(this.profile.expertise)
      .filter(([_, w]) => w > 0.3)
      .sort((a, b) => b[1] - a[1]);
    if (topDomains.length > 0) {
      const domainChinese = {
        programming: '编程', medicine: '医学', law: '法律',
        finance: '金融', design: '设计',
      };
      const names = topDomains.map(([d]) => domainChinese[d] || d).join('、');
      lines.push(`- 用户在 ${names} 领域有经验，可使用适当术语，避免过度科普`);
    }

    if (lines.length === 0) return null;
    return '## 回复风格\n' + lines.join('\n');
  }

  load() {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath)) {
        this.profile = { ...this.profile, ...JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) };
      }
    } catch {}
  }

  save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.profile, null, 2));
    } catch {}
  }
}

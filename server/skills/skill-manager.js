/**
 * skill-manager.js — Skill 管理
 *
 * Skill 是知识注入（非可执行代码）——通过 SKILL.md 文件
 * 向 Agent system prompt 注入专业领域知识。
 *
 * 参考 OpenHanako core/skill-manager.js:
 *   - 多源发现：内置、用户、工作区、外部兼容
 *   - YAML frontmatter 元数据解析
 *   - 按 agent 过滤可见性
 *   - 安装/卸载社区 skill
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('skill-manager');

/**
 * Parse SKILL.md frontmatter
 * Returns { name, description, trigger, modelInstruction, ... }
 */
export function parseSkillMetadata(content, fallbackName = '') {
  const meta = { name: fallbackName, description: '', trigger: '', modelInstruction: '' };

  if (typeof content !== 'string' || !content.startsWith('---')) return meta;

  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return meta;

  try {
    const parsed = yaml.load(match[1]);
    if (!parsed || typeof parsed !== 'object') return meta;

    meta.name = String(parsed.name || fallbackName).trim();
    meta.description = String(parsed.description || '').trim();
    meta.trigger = String(parsed.trigger || '').trim();
    meta.modelInstruction = String(parsed.modelInstruction || '').trim();

    // Optional fields
    if (parsed.disableModelInvocation !== undefined) {
      meta.disableModelInvocation = !!parsed.disableModelInvocation;
    }
    if (parsed.defaultEnabled !== undefined) {
      meta.defaultEnabled = !!parsed.defaultEnabled;
    }
  } catch (err) {
    log.warn(`YAML 解析失败: ${fallbackName}`);
  }

  return meta;
}

/**
 * Extract skill body (content after frontmatter)
 */
export function getSkillBody(content) {
  if (!content.startsWith('---')) return content;
  const parts = content.split('---');
  return parts.length >= 3 ? parts.slice(2).join('---').trim() : content;
}

export class SkillManager {
  /**
   * @param {object} opts
   * @param {string[]} opts.skillDirs — directories to scan for SKILL.md files
   */
  constructor({ skillDirs = [] }) {
    this.skillDirs = skillDirs;
    /** @type {Map<string, {name,filePath,meta,body,enabled,builtin,pluginSkill}>} */
    this._skills = new Map();
    this._loaded = false;
  }

  /**
   * Scan all skill directories and load skills
   */
  loadAll() {
    this._skills.clear();

    for (const dir of this.skillDirs) {
      if (!fs.existsSync(dir)) continue;
      this._scanDir(dir, path.basename(dir) === 'skills-builtin');
    }

    this._loaded = true;
    log.log(`加载完成: ${this._skills.size} 个 skills`);
    return this._skills.size;
  }

  _scanDir(dir, isBuiltin = false) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(dir, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');

      if (fs.existsSync(skillFile)) {
        try {
          const content = fs.readFileSync(skillFile, 'utf-8');
          const meta = parseSkillMetadata(content, entry.name);
          const body = getSkillBody(content);

          const skill = {
            name: meta.name,
            filePath: skillFile,
            meta,
            body,
            enabled: meta.defaultEnabled !== false, // Default: enabled
            builtin: isBuiltin,
            pluginSkill: false,
            dir: skillDir,
          };

          // Dedup: built-in takes priority
          const existing = this._skills.get(skill.name);
          if (!existing || (isBuiltin && !existing.builtin)) {
            this._skills.set(skill.name, skill);
          }
        } catch (err) {
          log.warn(`加载 skill 失败: ${skillFile} — ${err.message}`);
        }
      }
    }
  }

  /** Get all skills */
  getAll() {
    return [...this._skills.values()];
  }

  /** Get enabled skills list */
  getEnabled(agentEnabledSkills = null) {
    return this.getAll().filter(s => {
      if (!s.enabled) return false;
      if (agentEnabledSkills && !agentEnabledSkills.has(s.name)) return false;
      return true;
    });
  }

  /** Format skills for system prompt injection */
  formatForPrompt(agentEnabledSkills = null) {
    const skills = this.getEnabled(agentEnabledSkills);
    if (!skills.length) return '';

    const sections = ['## 可用技能\n'];
    for (const skill of skills) {
      sections.push(`### ${skill.name}${skill.meta.description ? ` — ${skill.meta.description}` : ''}`);
      if (skill.meta.trigger) sections.push(`触发: ${skill.meta.trigger}`);
      if (skill.meta.modelInstruction) sections.push(`指令: ${skill.meta.modelInstruction}`);
      if (skill.body) {
        // Truncate body for prompt
        const bodyPreview = skill.body.length > 2000
          ? skill.body.slice(0, 2000) + '\n...(内容过长，完整内容可用工具读取)'
          : skill.body;
        sections.push(bodyPreview);
      }
      sections.push('');
    }

    return sections.join('\n');
  }

  /** Find a skill by name */
  findSkill(name) {
    return this._skills.get(name) || [...this._skills.values()].find(s =>
      s.name.toLowerCase().includes(name.toLowerCase())
    ) || null;
  }

  /** Enable/disable a skill */
  setEnabled(skillName, enabled) {
    const skill = this._skills.get(skillName);
    if (!skill) return false;
    skill.enabled = enabled;
    return true;
  }

  /** Remove a skill (non-builtin only) */
  removeSkill(skillName) {
    const skill = this._skills.get(skillName);
    if (!skill || skill.builtin) return false;
    this._skills.delete(skillName);
    return true;
  }

  /** Get skill count */
  get count() {
    return this._skills.size;
  }
}

/**
 * kb-curiosity.js — 知识缺口检测与好奇心引擎
 *
 * 检测用户消息中提及的未知实体，按优先级管理知识缺口，
 * 驱动 Agent 主动向用户提问以填补知识空白。
 *
 * 依赖 kb-schema.js (KBSchema) 管理数据库连接，
 * 可选依赖 kb-graph.js (KnowledgeGraph) 辅助实体查询。
 */

import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('kb-curiosity');

// ── 模块级会话计数器 ──
let _sessionAskedCount = 0;

// ── ID 生成 ──
function _makeId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}_${rand}`;
}

// ── 内部工具 ──

/** 获取当前 Unix 时间戳（秒） */
function _nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** 解析 JSON 别名数组，失败返回空数组 */
function _parseAliases(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 检查字符串是否包含疑问词 */
function _hasQuestionWords(text) {
  if (!text) return false;
  const patterns = /什么|谁|怎么|如何|为何|什么是|是谁|怎么样|how|what|who|why|which|where|when/i;
  return patterns.test(text);
}

/** 检查字符串是否包含大写字母 */
function _hasUppercase(str) {
  return /[A-Z]/.test(str);
}

// ── CuriosityEngine ──

export class CuriosityEngine {
  /**
   * @param {{ schema?: import('./kb-schema.js').KBSchema, graph?: import('./kb-graph.js').KnowledgeGraph }} [opts]
   *   schema — KBSchema 实例（用于数据库访问）
   *   graph  — KnowledgeGraph 实例（用于实体查询，可选）
   */
  constructor({ schema, graph } = {}) {
    this._schema = schema || null;
    this._graph = graph || null;
  }

  /**
   * 初始化：确保 Schema 已就绪。
   * 幂等调用。
   */
  async init() {
    if (this._initialized) return;
    if (this._schema) await this._schema.init();
    if (this._graph) await this._graph.init();
    this._initialized = true;
    log.log('CuriosityEngine 已初始化');
  }

  /** @returns {import('sql.js').Database} sql.js 数据库实例 */
  get db() {
    if (this._schema) return this._schema.db;
    if (this._graph) return this._graph.db;
    throw new Error('CuriosityEngine: 未提供 Schema 或 Graph 实例，无法获取数据库');
  }

  // ═══════════════════════════════════════════
  // 优先级计算
  // ═══════════════════════════════════════════

  /**
   * 计算知识缺口的优先级。
   *
   * 规则：
   *   - 基础分: 0.5
   *   - 短名称（≤4 字符）: +0.2 —— 很可能是重要概念
   *   - 上下文含疑问词（什么/谁/how/what/who）: +0.1 —— 用户正在提问
   *   - 名称包含大写字母: +0.1 —— 很可能是专有名词
   *   - 上限 1.0
   *
   * @param {string} entityName — 实体名称
   * @param {string} [context]  — 上下文文本
   * @returns {number} 0-1 的优先级分数
   */
  _calcPriority(entityName, context = '') {
    let priority = 0.5;

    if (entityName.length <= 4) {
      priority += 0.2;
    }

    if (_hasQuestionWords(context)) {
      priority += 0.1;
    }

    if (_hasUppercase(entityName)) {
      priority += 0.1;
    }

    return Math.min(priority, 1.0);
  }

  // ═══════════════════════════════════════════
  // 缺口检测
  // ═══════════════════════════════════════════

  /**
   * 检测知识缺口：查询实体是否已知，未知则创建缺口记录。
   *
   * 查找顺序：
   *   1. 精确匹配 entities.name
   *   2. 模糊匹配 entities.aliases（JSON 数组 LIKE）
   *   3. 均未命中 → 写入 gaps 表
   *
   * @param {string} entityName — 实体名称
   * @param {string} [context]  — 上下文（用于优先级计算和记录）
   * @returns {Promise<{ isNew: boolean, gapId?: string, entityName: string, priority?: number, existingEntity?: { id: string, name: string, type: string|null, aliases: string[] } }>}
   */
  async detectGap(entityName, context = '') {
    const db = this.db;
    const name = entityName.trim();

    if (!name) {
      log.debug('detectGap: 空实体名，跳过');
      return { isNew: false, entityName: '' };
    }

    // 1. 精确匹配 name
    let stmt = db.prepare('SELECT id, name, type, aliases FROM entities WHERE name = ?');
    stmt.bind([name]);
    let row = stmt.getAsObject();
    stmt.free();

    if (row && row.id) {
      log.debug(`实体已知: "${name}" (id: ${row.id})`);
      return {
        isNew: false,
        entityName: name,
        existingEntity: {
          id: row.id,
          name: row.name,
          type: row.type || null,
          aliases: _parseAliases(row.aliases),
        },
      };
    }

    // 2. 模糊匹配 aliases
    stmt = db.prepare('SELECT id, name, type, aliases FROM entities WHERE aliases LIKE ?');
    stmt.bind([`%"${name}"%`]);
    row = stmt.getAsObject();
    stmt.free();

    if (row && row.id) {
      log.debug(`实体别名命中: "${name}" → "${row.name}"`);
      return {
        isNew: false,
        entityName: name,
        existingEntity: {
          id: row.id,
          name: row.name,
          type: row.type || null,
          aliases: _parseAliases(row.aliases),
        },
      };
    }

    // 3. 未命中 → 创建知识缺口
    const priority = this._calcPriority(name, context);
    const gapId = _makeId();
    const now = _nowSeconds();
    const missingInfo = `未知实体 "${name}"，尚未收入知识库`;

    db.run(
      `INSERT INTO gaps (id, entity_name, missing_info, context, priority, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      [gapId, name, missingInfo, context || null, priority, now],
    );

    log.log(
      `检测到知识缺口: "${name}" (id: ${gapId}, priority: ${priority.toFixed(2)})`,
    );

    return { isNew: true, gapId, entityName: name, priority };
  }

  // ═══════════════════════════════════════════
  // 待处理缺口查询
  // ═══════════════════════════════════════════

  /**
   * 获取待处理的知识缺口。
   *
   * @param {{ limit?: number, minPriority?: number }} [opts]
   * @param {number} [opts.limit=5]        — 返回上限
   * @param {number} [opts.minPriority=0.4] — 最低优先级阈值
   * @returns {Promise<Array<{ id: string, entity_name: string, missing_info: string, context: string|null, priority: number, status: string, created_at: number }>>}
   */
  async getPendingGaps({ limit = 5, minPriority = 0.4 } = {}) {
    const db = this.db;

    const stmt = db.prepare(
      `SELECT id, entity_name, missing_info, context, priority, status, created_at
       FROM gaps
       WHERE status = 'open' AND priority >= ?
       ORDER BY priority DESC
       LIMIT ?`,
    );
    stmt.bind([minPriority, limit]);

    const gaps = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      gaps.push({
        id: row.id,
        entity_name: row.entity_name,
        missing_info: row.missing_info,
        context: row.context || null,
        priority: row.priority,
        status: row.status,
        created_at: row.created_at,
      });
    }
    stmt.free();

    log.debug(`获取待处理缺口: ${gaps.length} 条 (minPriority=${minPriority})`);
    return gaps;
  }

  // ═══════════════════════════════════════════
  // 缺口状态管理
  // ═══════════════════════════════════════════

  /**
   * 标记缺口为「已询问用户」。
   * @param {string} gapId — 缺口 ID
   */
  async markGapAsked(gapId) {
    const db = this.db;
    db.run(`UPDATE gaps SET status = 'asked_user' WHERE id = ?`, [gapId]);
    log.log(`缺口状态更新: ${gapId} → asked_user`);
  }

  /**
   * 标记缺口为「已解决」。
   * @param {string} gapId — 缺口 ID
   */
  async markGapResolved(gapId) {
    const db = this.db;
    const now = _nowSeconds();
    db.run(`UPDATE gaps SET status = 'resolved', resolved_at = ? WHERE id = ?`, [now, gapId]);
    log.log(`缺口状态更新: ${gapId} → resolved`);
  }

  /**
   * 标记缺口为「已搜索」。
   * @param {string} gapId — 缺口 ID
   */
  async markGapSearched(gapId) {
    const db = this.db;
    db.run(`UPDATE gaps SET status = 'searched' WHERE id = ?`, [gapId]);
    log.log(`缺口状态更新: ${gapId} → searched`);
  }

  // ═══════════════════════════════════════════
  // 提问决策引擎
  // ═══════════════════════════════════════════

  /**
   * 决策引擎：判断是否应该就该实体向用户提问。
   *
   * 规则：
   *   1. 检测缺口 → 获得优先级
   *   2. 若优先级 >= 0.7 且本会话提问次数 < 3 → 返回 true
   *   3. 若优先级 >= 0.4 且已累积 5 个以上缺口 → 返回 true
   *   4. 否则 → 返回 false
   *
   * 高优先级条件：实体名短（重要概念）、上下文含疑问词、含大写（专有名词）
   *
   * @param {string} entityName — 实体名称
   * @param {string} [context]  — 上下文文本
   * @returns {Promise<boolean>}
   */
  async shouldAskAbout(entityName, context = '') {
    const result = await this.detectGap(entityName, context);

    // 实体已知 → 无需提问
    if (!result.isNew) {
      log.debug(`shouldAskAbout: "${entityName}" 已知实体，无需提问`);
      return false;
    }

    const priority = result.priority || 0;

    // 规则 1：高优先级 + 会话配额未满
    if (priority >= 0.7 && _sessionAskedCount < 3) {
      await this.markGapAsked(result.gapId);
      _sessionAskedCount++;
      log.log(
        `shouldAskAbout: 高优先级缺口 "${entityName}" (priority=${priority.toFixed(2)}, sessionAsked=${_sessionAskedCount}) → 提问`,
      );
      return true;
    }

    // 规则 2：中等优先级 + 缺口累积达到阈值
    if (priority >= 0.4) {
      const gapCount = await this.getGapCount();
      if (gapCount >= 5) {
        await this.markGapAsked(result.gapId);
        _sessionAskedCount++;
        log.log(
          `shouldAskAbout: 累积缺口 "${entityName}" (priority=${priority.toFixed(2)}, totalGaps=${gapCount}, sessionAsked=${_sessionAskedCount}) → 提问`,
        );
        return true;
      }
    }

    log.debug(
      `shouldAskAbout: "${entityName}" (priority=${priority.toFixed(2)}, sessionAsked=${_sessionAskedCount}) → 跳过`,
    );
    return false;
  }

  // ═══════════════════════════════════════════
  // 计数与会话管理
  // ═══════════════════════════════════════════

  /**
   * 获取当前开放缺口数量。
   * @returns {Promise<number>}
   */
  async getGapCount() {
    const db = this.db;
    const stmt = db.prepare("SELECT COUNT(*) as cnt FROM gaps WHERE status = 'open'");
    const row = stmt.getAsObject();
    stmt.free();
    const count = row.cnt || 0;
    log.debug(`开放缺口数: ${count}`);
    return count;
  }

  /**
   * 重置本会话的提问计数器。
   * 在新会话开始时调用。
   */
  async resetSessionCounter() {
    _sessionAskedCount = 0;
    log.log(`会话计数器已重置 (sessionAskedCount=0)`);
  }

  // ═══════════════════════════════════════════
  // 用户消息处理
  // ═══════════════════════════════════════════

  /**
   * 扫描用户消息中的潜在实体名称，检测知识缺口。
   *
   * 识别规则：
   *   - 双引号 / 单引号 / 中文引号内的文本
   *   - 以大写字母开头的连续单词（专有名词）
   *   - 包含内部大写字母的技术术语（如 camelCase）
   *
   * 对每个候选实体调用 detectGap，仅返回新发现的缺口。
   *
   * @param {string} text — 用户消息文本
   * @returns {Promise<Array<{ isNew: true, gapId: string, entityName: string, priority: number }>>}
   */
  async processUserMessage(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const candidates = new Set();

    // 1. 引号内的文本（双引号、单引号、中文引号）
    const quotePatterns = [
      /"([^"]{1,50})"/g,
      /'([^']{1,50})'/g,
      /“([^”]{1,50})”/g, // ""
      /‘([^’]{1,50})’/g, // ''
      /「([^」]{1,50})」/g, // 「」
      /『([^』]{1,50})』/g, // 『』
    ];

    for (const pattern of quotePatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const term = match[1].trim();
        if (term.length >= 2) candidates.add(term);
      }
    }

    // 2. 以大写字母开头的连续单词（4+ 字符，可能含空格）
    const properNounRe = /\b[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{1,}){0,3}\b/g;
    let match;
    while ((match = properNounRe.exec(text)) !== null) {
      const term = match[0].trim();
      if (term.length >= 2) candidates.add(term);
    }

    // 3. 包含内部大写字母的技术术语（camelCase / PascalCase，排除全大写缩写）
    const techTermRe = /\b[a-z]+[A-Z][a-zA-Z]*\b/g;
    while ((match = techTermRe.exec(text)) !== null) {
      const term = match[0].trim();
      if (term.length >= 2) candidates.add(term);
    }

    if (candidates.size === 0) {
      log.debug('processUserMessage: 未检测到候选实体');
      return [];
    }

    log.debug(`processUserMessage: 检测到 ${candidates.size} 个候选实体`);

    // 对每个候选实体检测缺口
    const gaps = [];
    for (const name of candidates) {
      const result = await this.detectGap(name, text);
      if (result.isNew) {
        gaps.push({
          isNew: true,
          gapId: result.gapId,
          entityName: result.entityName,
          priority: result.priority,
        });
      }
    }

    log.log(`processUserMessage: 发现 ${gaps.length} 个新知识缺口`);
    return gaps;
  }
}

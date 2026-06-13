/**
 * kb-graph.js — 知识图谱引擎
 *
 * 基于 SQLite 的知识图谱操作层，提供实体归一化、关系管理、
 * 子图查询和事实管理功能。使用递归 CTE 遍历 edges 表实现
 * 多跳图查询。
 *
 * 依赖 kb-schema.js 的 KBSchema 实例管理数据库连接。
 */
import { KBSchema } from './schema.js';
import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('kb-graph');

// ── ID 生成 ──

function _makeId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}_${rand}`;
}

// ── 内部工具 ──

/**
 * 将 JSON 字符串解析为数组，解析失败返回空数组。
 * @param {string|null} json
 * @returns {string[]}
 */
function _parseAliases(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 获取当前 Unix 时间戳（秒）。
 * @returns {number}
 */
function _nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ── KnowledgeGraph ──

export class KnowledgeGraph {
  /**
   * @param {KBSchema} [schema] — KBSchema 实例，未提供则自动创建
   */
  constructor(schema) {
    this._schema = schema || new KBSchema();
  }

  /**
   * 确保 Schema 已初始化。
   * 幂等调用——多次调用不会重复初始化。
   */
  async init() {
    if (this._initialized) return;
    await this._schema.init();
    this._initialized = true;
    log.log('KnowledgeGraph 已初始化');
  }

  /** @returns {import('sql.js').Database} sql.js 数据库实例 */
  get db() {
    return this._schema.db;
  }

  // ═══════════════════════════════════════════
  // 实体管理
  // ═══════════════════════════════════════════

  /**
   * 实体归一化：按名称查找已有实体，未找到则创建。
   *
   * 查找顺序：
   *   1. 精确匹配 entities.name
   *   2. 模糊匹配 entities.aliases（JSON 数组）
   *   3. 未命中则 INSERT 新实体
   *
   * 命中已有实体时自动递增 doc_count。
   *
   * @param {string} name   — 实体名称
   * @param {string} [type] — 实体类型（如 'person', 'file', 'concept'）
   * @returns {Promise<{ id: string, name: string, type: string|null, aliases: string[], doc_count: number }>}
   */
  async normalizeEntity(name, type = null) {
    const db = this.db;
    const now = _nowSeconds();

    // 1. 精确匹配 name
    let stmt = db.prepare('SELECT * FROM entities WHERE name = ?');
    stmt.bind([name]);
    let row = stmt.getAsObject();
    stmt.free();

    if (row && row.id) {
      // 命中：更新 doc_count
      const newCount = (row.doc_count || 0) + 1;
      db.run('UPDATE entities SET doc_count = ? WHERE id = ?', [newCount, row.id]);
      log.debug(`实体命中: "${name}" (doc_count: ${newCount})`);
      return {
        id: row.id,
        name: row.name,
        type: row.type || null,
        aliases: _parseAliases(row.aliases),
        doc_count: newCount,
      };
    }

    // 2. 模糊匹配 aliases（LIKE 搜索 JSON 数组）
    stmt = db.prepare('SELECT * FROM entities WHERE aliases LIKE ?');
    stmt.bind([`%"${name}"%`]);
    row = stmt.getAsObject();
    stmt.free();

    if (row && row.id) {
      const newCount = (row.doc_count || 0) + 1;
      db.run('UPDATE entities SET doc_count = ? WHERE id = ?', [newCount, row.id]);
      log.debug(`实体别名命中: "${name}" → "${row.name}" (doc_count: ${newCount})`);
      return {
        id: row.id,
        name: row.name,
        type: row.type || null,
        aliases: _parseAliases(row.aliases),
        doc_count: newCount,
      };
    }

    // 3. 未命中：创建新实体
    const id = _makeId();
    db.run(
      `INSERT INTO entities (id, name, type, aliases, first_seen_at, doc_count)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [id, name, type, '[]', now],
    );
    log.log(`新建实体: "${name}" (id: ${id}, type: ${type || '(无)'})`);
    return {
      id,
      name,
      type: type || null,
      aliases: [],
      doc_count: 1,
    };
  }

  /**
   * 为已有实体添加别名。
   *
   * @param {string} entityName — 实体名称（必须已存在）
   * @param {string} alias      — 要添加的别名
   * @returns {Promise<{ id: string, name: string, aliases: string[] }>}
   */
  async addAlias(entityName, alias) {
    const db = this.db;

    const stmt = db.prepare('SELECT * FROM entities WHERE name = ?');
    stmt.bind([entityName]);
    const row = stmt.getAsObject();
    stmt.free();

    if (!row || !row.id) {
      throw new Error(`实体不存在: "${entityName}"`);
    }

    const aliases = _parseAliases(row.aliases);

    // 去重
    if (aliases.includes(alias)) {
      log.debug(`别名已存在: "${entityName}" ← "${alias}"`);
      return { id: row.id, name: row.name, aliases };
    }

    aliases.push(alias);
    db.run('UPDATE entities SET aliases = ? WHERE id = ?', [
      JSON.stringify(aliases),
      row.id,
    ]);
    log.log(`添加别名: "${entityName}" ← "${alias}"`);
    return { id: row.id, name: row.name, aliases };
  }

  /**
   * 搜索实体：对 name 和 aliases 做 LIKE 模糊匹配。
   *
   * @param {string} query           — 搜索关键词
   * @param {object} [opts]
   * @param {string} [opts.type]     — 按类型过滤
   * @param {number} [opts.limit=20] — 返回上限
   * @returns {Promise<Array<{ id: string, name: string, type: string|null, aliases: string[], doc_count: number }>>}
   */
  async searchEntities(query, { type = null, limit = 20 } = {}) {
    const db = this.db;
    const likePattern = `%${query}%`;

    let sql = 'SELECT * FROM entities WHERE (name LIKE ? OR aliases LIKE ?)';
    const params = [likePattern, likePattern];

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    sql += ' ORDER BY doc_count DESC LIMIT ?';
    params.push(limit);

    const stmt = db.prepare(sql);
    stmt.bind(params);

    const results = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        id: row.id,
        name: row.name,
        type: row.type || null,
        aliases: _parseAliases(row.aliases),
        doc_count: row.doc_count || 0,
      });
    }
    stmt.free();

    log.debug(`实体搜索: "${query}" → ${results.length} 条结果`);
    return results;
  }

  // ═══════════════════════════════════════════
  // 关系管理
  // ═══════════════════════════════════════════

  /**
   * 添加关系三元组 (subject → predicate → object)。
   *
   * 流程：
   *   1. normalizeEntity(subjectName) → subjectId
   *   2. normalizeEntity(objectName) → objectId
   *      （若 objectIsLiteral 为 true，则 objectId = null）
   *   3. INSERT 到 facts 表
   *   4. 若 subjectId 和 objectId 均非 null，INSERT 到 edges 表
   *   5. 返回 { factId, subjectId, objectId }
   *
   * @param {string} subjectName — 主语实体名称
   * @param {string} predicate   — 谓词（关系类型）
   * @param {string} objectName  — 宾语实体名称（或字面值）
   * @param {object} [opts]
   * @param {string} [opts.source='user']      — 来源类型
   * @param {number} [opts.confidence=0.95]    — 置信度 (0-1)
   * @param {boolean} [opts.objectIsLiteral=false] — 宾语是否为字面值
   * @returns {Promise<{ factId: string, subjectId: string, objectId: string|null }>}
   */
  async addRelation(
    subjectName,
    predicate,
    objectName,
    { source = 'user', confidence = 0.95, objectIsLiteral = false } = {},
  ) {
    const db = this.db;
    const now = _nowSeconds();

    // 1. 归一化主语
    const subject = await this.normalizeEntity(subjectName);
    const subjectId = subject.id;

    // 2. 归一化宾语（或作为字面值）
    let objectId = null;
    let objectValue = null;

    if (objectIsLiteral) {
      objectValue = objectName;
    } else {
      const object = await this.normalizeEntity(objectName);
      objectId = object.id;
    }

    // 3. INSERT facts
    const factId = _makeId();
    db.run(
      `INSERT INTO facts
         (id, subject_id, predicate, object_id, object_value, confidence,
          source_type, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [factId, subjectId, predicate, objectId, objectValue, confidence, source, now, now],
    );

    // 4. 若两端都是实体，INSERT edges
    if (subjectId && objectId) {
      const edgeId = _makeId();
      db.run(
        `INSERT INTO edges
           (id, from_entity, to_entity, relation_type, fact_id, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [edgeId, subjectId, objectId, predicate, factId, confidence],
      );
    }

    log.log(
      `添加关系: "${subjectName}" -[${predicate}]-> "${objectName}"` +
        ` (confidence: ${confidence}, source: ${source})`,
    );

    return { factId, subjectId, objectId };
  }

  /**
   * 获取实体及其关联的所有事实和相关实体。
   *
   * @param {string} entityName — 实体名称
   * @returns {Promise<{ entity: object, facts: object[], relatedEntities: object[] }>}
   */
  async getEntityWithFacts(entityName) {
    const db = this.db;

    // 1. 获取实体
    const entityStmt = db.prepare('SELECT * FROM entities WHERE name = ?');
    entityStmt.bind([entityName]);
    const entityRow = entityStmt.getAsObject();
    entityStmt.free();

    if (!entityRow || !entityRow.id) {
      throw new Error(`实体不存在: "${entityName}"`);
    }

    const entityId = entityRow.id;
    const entity = {
      id: entityRow.id,
      name: entityRow.name,
      type: entityRow.type || null,
      aliases: _parseAliases(entityRow.aliases),
      description: entityRow.description || null,
      doc_count: entityRow.doc_count || 0,
    };

    // 2. 获取该实体作为主语或宾语的所有活跃事实
    const factStmt = db.prepare(
      `SELECT * FROM facts
       WHERE (subject_id = ? OR object_id = ?)
         AND status = 'active'
       ORDER BY confidence DESC, updated_at DESC`,
    );
    factStmt.bind([entityId, entityId]);

    const facts = [];
    const relatedEntityIds = new Set();

    while (factStmt.step()) {
      const row = factStmt.getAsObject();
      facts.push({
        id: row.id,
        subject_id: row.subject_id,
        predicate: row.predicate,
        object_id: row.object_id,
        object_value: row.object_value,
        confidence: row.confidence,
        source_type: row.source_type,
        source_id: row.source_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        verified_by: row.verified_by,
        status: row.status,
      });

      // 收集关联实体 ID（排除自身）
      if (row.subject_id && row.subject_id !== entityId) {
        relatedEntityIds.add(row.subject_id);
      }
      if (row.object_id && row.object_id !== entityId) {
        relatedEntityIds.add(row.object_id);
      }
    }
    factStmt.free();

    // 3. 批量获取关联实体
    const relatedEntities = [];
    if (relatedEntityIds.size > 0) {
      const placeholders = Array.from(relatedEntityIds, () => '?').join(',');
      const relStmt = db.prepare(
        `SELECT id, name, type, aliases, doc_count FROM entities WHERE id IN (${placeholders})`,
      );
      relStmt.bind(Array.from(relatedEntityIds));

      while (relStmt.step()) {
        const row = relStmt.getAsObject();
        relatedEntities.push({
          id: row.id,
          name: row.name,
          type: row.type || null,
          aliases: _parseAliases(row.aliases),
          doc_count: row.doc_count || 0,
        });
      }
      relStmt.free();
    }

    log.debug(
      `获取实体事实: "${entityName}" → ${facts.length} 条事实, ${relatedEntities.length} 个关联实体`,
    );

    return { entity, facts, relatedEntities };
  }

  // ═══════════════════════════════════════════
  // 图查询
  // ═══════════════════════════════════════════

  /**
   * 获取以指定实体为中心的子图。
   *
   * 使用递归 CTE 遍历 edges 表，按 hops 参数控制跳数。
   * 返回 nodes（去重的实体节点）和 edges（去重的关系边）。
   *
   * @param {string} entityName    — 起始实体名称
   * @param {object} [opts]
   * @param {number} [opts.hops=1]   — 最大跳数（递归深度）
   * @param {number} [opts.limit=50] — 返回边数上限
   * @returns {Promise<{ nodes: Array<{ id: string, name: string, type: string|null, weight: number }>, edges: Array<{ from: string, to: string, relation: string, confidence: number, source: string }> }>}
   */
  async getSubgraph(entityName, { hops = 1, limit = 50 } = {}) {
    const db = this.db;

    // 1. 查找起始实体
    const entity = await this.normalizeEntity(entityName);
    const entityId = entity.id;

    // 2. 递归 CTE 遍历 edges
    const cteSql = `
      WITH RECURSIVE sub AS (
        SELECT from_entity, to_entity, relation_type, confidence, fact_id, 0 as depth
        FROM edges
        WHERE from_entity = ? OR to_entity = ?
        UNION
        SELECT e.from_entity, e.to_entity, e.relation_type, e.confidence, e.fact_id, s.depth + 1
        FROM edges e
        JOIN sub s ON e.from_entity = s.from_entity
                  OR e.to_entity = s.to_entity
                  OR e.from_entity = s.to_entity
                  OR e.to_entity = s.from_entity
        WHERE s.depth < ?
      )
      SELECT DISTINCT from_entity, to_entity, relation_type, confidence, fact_id
      FROM sub
      LIMIT ?
    `;

    const stmt = db.prepare(cteSql);
    stmt.bind([entityId, entityId, hops, limit]);

    const edgeRows = [];
    const entityIdSet = new Set();
    entityIdSet.add(entityId); // 确保起始实体在节点集中

    while (stmt.step()) {
      const row = stmt.getAsObject();
      edgeRows.push(row);
      if (row.from_entity) entityIdSet.add(row.from_entity);
      if (row.to_entity) entityIdSet.add(row.to_entity);
    }
    stmt.free();

    // 3. 批量获取实体信息
    const entityIds = Array.from(entityIdSet);
    const entityMap = new Map();

    if (entityIds.length > 0) {
      const placeholders = entityIds.map(() => '?').join(',');
      const entStmt = db.prepare(
        `SELECT id, name, type, doc_count FROM entities WHERE id IN (${placeholders})`,
      );
      entStmt.bind(entityIds);

      while (entStmt.step()) {
        const row = entStmt.getAsObject();
        entityMap.set(row.id, {
          id: row.id,
          name: row.name,
          type: row.type || null,
          weight: row.doc_count || 1,
        });
      }
      entStmt.free();
    }

    // 确保起始实体在 map 中（即使查询没返回）
    if (!entityMap.has(entityId)) {
      entityMap.set(entityId, {
        id: entity.id,
        name: entity.name,
        type: entity.type,
        weight: entity.doc_count || 1,
      });
    }

    // 4. 获取边的来源信息
    const factIdSet = new Set();
    for (const row of edgeRows) {
      if (row.fact_id) factIdSet.add(row.fact_id);
    }

    const sourceMap = new Map();
    if (factIdSet.size > 0) {
      const fPlaceholders = Array.from(factIdSet, () => '?').join(',');
      const srcStmt = db.prepare(
        `SELECT id, source_type FROM facts WHERE id IN (${fPlaceholders})`,
      );
      srcStmt.bind(Array.from(factIdSet));

      while (srcStmt.step()) {
        const row = srcStmt.getAsObject();
        sourceMap.set(row.id, row.source_type || 'unknown');
      }
      srcStmt.free();
    }

    // 5. 构建返回结果
    const nodes = Array.from(entityMap.values());
    const edges = edgeRows.map((row) => ({
      from: row.from_entity,
      to: row.to_entity,
      relation: row.relation_type,
      confidence: row.confidence || 0,
      source: sourceMap.get(row.fact_id) || 'unknown',
    }));

    log.debug(
      `子图查询: "${entityName}" (hops=${hops}) → ${nodes.length} 个节点, ${edges.length} 条边`,
    );

    return { nodes, edges };
  }

  /**
   * 分页获取实体的边。
   *
   * @param {string} entityId       — 实体 ID
   * @param {object} [opts]
   * @param {number} [opts.page=0]     — 页码（0-based）
   * @param {number} [opts.pageSize=50] — 每页条数
   * @returns {Promise<{ edges: Array<{ id: string, from: string, to: string, relation: string, confidence: number, source: string }>, total: number, page: number, pageSize: number }>}
   */
  async getEdgesPaginated(entityId, { page = 0, pageSize = 50 } = {}) {
    const db = this.db;

    // 统计总数
    const countStmt = db.prepare(
      'SELECT COUNT(*) as cnt FROM edges WHERE from_entity = ? OR to_entity = ?',
    );
    countStmt.bind([entityId, entityId]);
    const countRow = countStmt.getAsObject();
    countStmt.free();
    const total = countRow.cnt || 0;

    // 分页查询
    const offset = page * pageSize;
    const edgeStmt = db.prepare(
      `SELECT e.*, f.source_type
       FROM edges e
       LEFT JOIN facts f ON e.fact_id = f.id
       WHERE e.from_entity = ? OR e.to_entity = ?
       ORDER BY e.confidence DESC
       LIMIT ? OFFSET ?`,
    );
    edgeStmt.bind([entityId, entityId, pageSize, offset]);

    const edges = [];
    while (edgeStmt.step()) {
      const row = edgeStmt.getAsObject();
      edges.push({
        id: row.id,
        from: row.from_entity,
        to: row.to_entity,
        relation: row.relation_type,
        confidence: row.confidence || 0,
        source: row.source_type || 'unknown',
      });
    }
    edgeStmt.free();

    log.debug(`分页边查询: entity=${entityId} page=${page} → ${edges.length}/${total}`);
    return { edges, total, page, pageSize };
  }

  // ═══════════════════════════════════════════
  // 事实管理
  // ═══════════════════════════════════════════

  /**
   * 获取指定实体作为主语的所有事实。
   *
   * @param {string} entityId          — 实体 ID
   * @param {object} [opts]
   * @param {number} [opts.limit=50]       — 返回上限
   * @param {number} [opts.minConfidence=0] — 最低置信度阈值
   * @returns {Promise<Array<{ id: string, predicate: string, object_id: string|null, object_value: string|null, confidence: number, source_type: string, status: string, created_at: number, updated_at: number }>>}
   */
  async getFactsForEntity(entityId, { limit = 50, minConfidence = 0 } = {}) {
    const db = this.db;

    const stmt = db.prepare(
      `SELECT * FROM facts
       WHERE subject_id = ?
         AND status = 'active'
         AND confidence >= ?
       ORDER BY confidence DESC, updated_at DESC
       LIMIT ?`,
    );
    stmt.bind([entityId, minConfidence, limit]);

    const facts = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      facts.push({
        id: row.id,
        predicate: row.predicate,
        object_id: row.object_id || null,
        object_value: row.object_value || null,
        confidence: row.confidence,
        source_type: row.source_type,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }
    stmt.free();

    log.debug(
      `获取实体事实: ${entityId} (minConfidence=${minConfidence}) → ${facts.length} 条`,
    );
    return facts;
  }

  /**
   * 更新事实的置信度。
   *
   * @param {string} factId          — 事实 ID
   * @param {number} newConfidence   — 新置信度 (0-1)
   * @param {string} [verifiedBy]    — 验证者标识
   * @returns {Promise<{ id: string, confidence: number, verified_by: string|null, updated_at: number }>}
   */
  async updateFactConfidence(factId, newConfidence, verifiedBy = null) {
    const db = this.db;
    const now = _nowSeconds();

    // 校验事实是否存在
    const checkStmt = db.prepare('SELECT id FROM facts WHERE id = ?');
    checkStmt.bind([factId]);
    const checkRow = checkStmt.getAsObject();
    checkStmt.free();

    if (!checkRow || !checkRow.id) {
      throw new Error(`事实不存在: ${factId}`);
    }

    // 更新置信度 + 验证者 + 时间戳
    db.run(
      `UPDATE facts SET confidence = ?, verified_by = ?, updated_at = ? WHERE id = ?`,
      [newConfidence, verifiedBy, now, factId],
    );

    // 同步更新 edges 表中的置信度
    db.run('UPDATE edges SET confidence = ? WHERE fact_id = ?', [newConfidence, factId]);

    log.log(
      `更新事实置信度: ${factId} → ${newConfidence}` +
        (verifiedBy ? ` (verified by: ${verifiedBy})` : ''),
    );

    return { id: factId, confidence: newConfidence, verified_by: verifiedBy, updated_at: now };
  }

  /**
   * 废弃一条事实（标记为 deprecated）。
   *
   * @param {string} factId — 事实 ID
   * @returns {Promise<{ id: string, status: string, updated_at: number }>}
   */
  async deprecateFact(factId) {
    const db = this.db;
    const now = _nowSeconds();

    // 校验事实是否存在
    const checkStmt = db.prepare('SELECT id FROM facts WHERE id = ?');
    checkStmt.bind([factId]);
    const checkRow = checkStmt.getAsObject();
    checkStmt.free();

    if (!checkRow || !checkRow.id) {
      throw new Error(`事实不存在: ${factId}`);
    }

    // 更新状态
    db.run('UPDATE facts SET status = ?, updated_at = ? WHERE id = ?', [
      'deprecated',
      now,
      factId,
    ]);

    // 同时删除对应的 edges（废弃的事实不应该在图谱中出现）
    db.run('DELETE FROM edges WHERE fact_id = ?', [factId]);

    log.log(`废弃事实: ${factId}`);
    return { id: factId, status: 'deprecated', updated_at: now };
  }
}

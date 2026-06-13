/**
 * kb-reflection.js — 周期性知识库反思引擎
 *
 * 对知识库中的事实进行定期反思，检测矛盾、合并重复、推导新知识。
 * 反思结果写入 reflections 表，用于追溯和审计。
 *
 * 功能：
 *   - detectContradictions() — 检测同一主题+谓词下的冲突事实
 *   - detectDuplicates()      — Jaccard 相似度检测近似重复事实
 *   - attemptInference()      — 传递性推理：A→B→C 推断 A→C
 *   - runReflection()         — 主入口，串联全部检测步骤
 *
 * 依赖 kb-schema.js 的 KBSchema 和 kb-graph.js 的 KnowledgeGraph。
 * LLM 配置可选——核心检测逻辑不依赖 LLM，仅在需要语义级判断时使用。
 */
import { createModuleLogger } from '../lib/debug-log.js';
import { KBSchema } from './schema.js';
import { KnowledgeGraph } from './graph.js';

const log = createModuleLogger('kb-reflection');

// ── 内部工具 ──

/**
 * 获取当前 Unix 时间戳（秒），与 kb-graph 保持一致。
 * @returns {number}
 */
function _nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * 生成唯一 ID。
 * @returns {string}
 */
function _makeId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}_${rand}`;
}

// ── 字符 Bigram 提取 ──

/**
 * 从文本中提取字符级 bigram 集合。
 * 用于 Jaccard 相似度计算。
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function _extractBigrams(text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const bigrams = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    bigrams.add(s[i] + s[i + 1]);
  }
  return bigrams;
}

/**
 * 计算两个集合的 Jaccard 相似度。
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0-1 之间的相似度
 */
function _jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

// ── ReflectionEngine ──

export class ReflectionEngine {
  /**
   * @param {object} [opts]
   * @param {import('./schema.js').KBSchema}          [opts.schema]     KBSchema 实例
   * @param {import('./graph.js').KnowledgeGraph}     [opts.graph]      KnowledgeGraph 实例
   * @param {{ provider?: string, apiKey?: string, model?: string }} [opts.llmConfig] LLM 配置（可选）
   */
  constructor({ schema, graph, llmConfig } = {}) {
    this._schema = schema || new KBSchema();
    this._graph = graph || new KnowledgeGraph(this._schema);
    this._llmConfig = llmConfig || null;
    this._ready = false;
  }

  /**
   * 确保 schema 和 graph 已就绪。幂等调用。
   */
  async init() {
    if (this._ready) return;
    await this._graph.init();
    this._ready = true;
    log.log('ReflectionEngine 初始化完成');
  }

  // ═══════════════════════════════════════════
  // 主入口
  // ═══════════════════════════════════════════

  /**
   * 执行一次完整的反思循环。
   *
   * 流程：
   *   1. 获取最近的事实（自上次反思以来，或最近 100 条）
   *   2. 检测矛盾 → 标记 contested，降低置信度
   *   3. 检测重复 → 合并，废弃低置信度项
   *   4. 尝试传递推理 → 创建新推断事实
   *   5. 保存数据库
   *
   * @returns {Promise<{
   *   contradictions: object[],
   *   duplicates: object[],
   *   crossDocContradictions: object[],
   *   inferences: object[],
   *   actions: { factsContested: number, factsDeprecated: number, crossDocFlags: number, inferencesCreated: number }
   * }>}
   */
  async runReflection() {
    if (!this._ready) await this.init();

    log.log('开始反思循环...');

    // 1. 获取近期事实
    const facts = await this._getRecentFacts();
    log.log(`获取到 ${facts.length} 条近期事实`);

    if (facts.length === 0) {
      log.log('没有需要反思的事实，跳过');
      return {
        contradictions: [],
        duplicates: [],
        crossDocContradictions: [],
        inferences: [],
        actions: { factsContested: 0, factsDeprecated: 0, crossDocFlags: 0, inferencesCreated: 0 },
      };
    }

    // 2. 检测矛盾
    const contradictions = await this.detectContradictions(facts);

    // 3. 检测重复
    const duplicates = await this.detectDuplicates(facts);

    // 3b. 跨文档矛盾检测
    const crossDocContradictions = await this.detectCrossDocContradictions(facts);

    // 4. 尝试推理
    const inferences = await this.attemptInference(facts);

    // 5. 持久化
    this._schema.save();

    const actions = {
      factsContested: contradictions.reduce((sum, c) => sum + (c.affectedFacts || []).length, 0),
      factsDeprecated: duplicates.reduce((sum, d) => sum + (d.deprecatedFacts || []).length, 0),
      crossDocFlags: crossDocContradictions.reduce((sum, c) => sum + (c.affectedFacts || []).length, 0),
      inferencesCreated: inferences.length,
    };

    log.log(
      `反思完成: ${contradictions.length} 组矛盾, ${duplicates.length} 组重复, ` +
        `${crossDocContradictions.length} 组跨文档矛盾, ${inferences.length} 条推理`,
    );

    return { contradictions, duplicates, crossDocContradictions, inferences, actions };
  }

  // ═══════════════════════════════════════════
  // 矛盾检测
  // ═══════════════════════════════════════════

  /**
   * 检测事实中的矛盾。
   *
   * 将事实按 (subject_id, predicate) 分组。
   * 若同一组内有不同 object_id 或 object_value 的事实（且置信度 > 0.2），
   * 将它们标记为 contested，并将置信度乘以 0.8。
   *
   * @param {Array<{ id: string, subject_id: string, predicate: string, object_id: string|null, object_value: string|null, confidence: number, status: string }>} facts
   * @returns {Promise<Array<{ type: string, summary: string, detail: object, affectedFacts: string[], actions: object }>>}
   */
  async detectContradictions(facts) {
    const db = this._schema.db;
    const now = _nowSeconds();
    const results = [];

    // 按 (subject_id, predicate) 分组
    const groups = new Map();
    for (const fact of facts) {
      if (fact.status !== 'active') continue;
      const key = `${fact.subject_id}::${fact.predicate}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(fact);
    }

    for (const [key, group] of groups) {
      if (group.length < 2) continue;

      // 检查是否存在不同 object 的事实
      const objectValues = new Set();
      for (const fact of group) {
        const objKey = fact.object_id || fact.object_value || '__null__';
        objectValues.add(objKey);
      }

      // 只有一个 object 值，无矛盾
      if (objectValues.size <= 1) continue;

      // 筛选置信度 > 0.2 的冲突事实
      const contested = group.filter((f) => f.confidence > 0.2);
      if (contested.length < 2) continue;

      const affectedIds = [];
      for (const fact of contested) {
        const newConfidence = Math.max(0.01, fact.confidence * 0.8);
        db.run('UPDATE facts SET status = ?, confidence = ?, updated_at = ? WHERE id = ?', [
          'contested',
          newConfidence,
          now,
          fact.id,
        ]);
        affectedIds.push(fact.id);
      }

      // 写入反思日志
      const summary = `矛盾检测: ${contested.length} 条事实对谓词 "${group[0].predicate}" 有冲突 object`;
      const detail = {
        groupKey: key,
        subjectId: group[0].subject_id,
        predicate: group[0].predicate,
        conflictingFacts: contested.map((f) => ({
          id: f.id,
          objectId: f.object_id || null,
          objectValue: f.object_value || null,
          oldConfidence: f.confidence,
          newConfidence: Math.max(0.01, f.confidence * 0.8),
        })),
      };
      const actions = {
        type: 'contested',
        operation: 'lower_confidence',
        multiplier: 0.8,
      };

      this._insertReflection('contradiction', summary, detail, affectedIds, actions);

      results.push({
        type: 'contradiction',
        summary,
        detail,
        affectedFacts: affectedIds,
        actions,
      });

      log.log(summary);
    }

    return results;
  }

  // ═══════════════════════════════════════════
  // 重复检测
  // ═══════════════════════════════════════════

  /**
   * 检测近似重复的事实。
   *
   * 对每对事实计算「主体名 + 谓词 + 客体名/值」拼接文本的字符 bigram
   * Jaccard 相似度。相似度 > 0.7 的视为重复，保留置信度更高的一条，
   * 废弃另一条。
   *
   * @param {Array<{ id: string, subject_id: string, predicate: string, object_id: string|null, object_value: string|null, confidence: number, status: string }>} facts
   * @returns {Promise<Array<{ type: string, summary: string, detail: object, keptFact: string, deprecatedFacts: string[], actions: object }>>}
   */
  async detectDuplicates(facts) {
    const results = [];

    // 构建每条事实的文本表示
    // 需要批量查询实体名称
    const entityIds = new Set();
    for (const fact of facts) {
      if (fact.subject_id) entityIds.add(fact.subject_id);
      if (fact.object_id) entityIds.add(fact.object_id);
    }

    const entityMap = new Map();
    if (entityIds.size > 0) {
      const db = this._schema.db;
      const placeholders = Array.from(entityIds, () => '?').join(',');
      const stmt = db.prepare(
        `SELECT id, name FROM entities WHERE id IN (${placeholders})`,
      );
      stmt.bind(Array.from(entityIds));
      while (stmt.step()) {
        const row = stmt.getAsObject();
        entityMap.set(row.id, row.name);
      }
      stmt.free();
    }

    // 为每条事实构造文本
    const factTexts = facts
      .filter((f) => f.status === 'active')
      .map((fact) => {
        const subjectName = entityMap.get(fact.subject_id) || fact.subject_id || '';
        const objectText = fact.object_value || entityMap.get(fact.object_id) || fact.object_id || '';
        const text = `${subjectName} ${fact.predicate} ${objectText}`;
        return { fact, text, bigrams: _extractBigrams(text) };
      });

    // 已经处理的 fact ID 集合（避免重复处理）
    const processedIds = new Set();

    for (let i = 0; i < factTexts.length; i++) {
      const a = factTexts[i];
      if (processedIds.has(a.fact.id)) continue;

      for (let j = i + 1; j < factTexts.length; j++) {
        const b = factTexts[j];
        if (processedIds.has(b.fact.id)) continue;

        const similarity = _jaccardSimilarity(a.bigrams, b.bigrams);

        if (similarity > 0.7) {
          // 保留置信度更高的
          const [keeper, deprecated] =
            a.fact.confidence >= b.fact.confidence ? [a.fact, b.fact] : [b.fact, a.fact];

          // 废弃低置信度的事实
          try {
            await this._graph.deprecateFact(deprecated.id);
          } catch (err) {
            log.warn(`废弃重复事实失败: ${deprecated.id} — ${err.message}`);
            continue;
          }

          processedIds.add(keeper.id);
          processedIds.add(deprecated.id);

          const summary = `重复合并: "${a.text}" ≈ "${b.text}" (相似度: ${similarity.toFixed(3)})`;
          const detail = {
            kept: { id: keeper.id, confidence: keeper.confidence, text: keeper.id === a.fact.id ? a.text : b.text },
            deprecated: { id: deprecated.id, confidence: deprecated.confidence, text: deprecated.id === a.fact.id ? a.text : b.text },
            similarity,
            threshold: 0.7,
          };
          const actions = {
            type: 'dedup',
            operation: 'deprecate_lower_confidence',
            kept: keeper.id,
            deprecated: deprecated.id,
          };

          this._insertReflection('dedup', summary, detail, [keeper.id, deprecated.id], actions);

          results.push({
            type: 'dedup',
            summary,
            detail,
            keptFact: keeper.id,
            deprecatedFacts: [deprecated.id],
            actions,
          });

          log.log(summary);
        }
      }
    }

    return results;
  }

  // ═══════════════════════════════════════════
  // 跨文档矛盾检测
  // ═══════════════════════════════════════════

  /**
   * 检测跨文档矛盾。
   *
   * 当同一 (subject_id, predicate) 组合来自不同源文档，
   * 且它们的 object 不同、置信度均 > 0.3 时，标记为跨文档矛盾。
   * 矛盾事实会写入 reflections 表（type='cross_doc_contradiction'），
   * 但不会自动修改置信度——需要人类/LLM 介入判断。
   *
   * @param {Array<{ id: string, subject_id: string, predicate: string, object_id: string|null, object_value: string|null, confidence: number, status: string, source_type?: string, source_id?: string }>} facts
   * @returns {Promise<Array<{ type: string, summary: string, detail: object, affectedFacts: string[], actions: object }>>}
   */
  async detectCrossDocContradictions(facts) {
    const results = [];

    // 仅处理有 source_id 的活跃事实
    const sourcedFacts = facts.filter(
      (f) => f.status === 'active' && f.source_id,
    );

    if (sourcedFacts.length < 2) {
      log.debug('没有足够的带源信息事实用于跨文档矛盾检测');
      return results;
    }

    // 按 (subject_id, predicate) 分组
    const groups = new Map();
    for (const fact of sourcedFacts) {
      const key = `${fact.subject_id}::${fact.predicate}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(fact);
    }

    for (const [key, group] of groups) {
      if (group.length < 2) continue;

      // 收集该组内的不同 source 和对应的 object
      const sourceDocs = new Map(); // source_id → { source_type, facts: [...] }
      for (const fact of group) {
        const srcKey = fact.source_id;
        if (!sourceDocs.has(srcKey)) {
          sourceDocs.set(srcKey, {
            source_type: fact.source_type || 'unknown',
            facts: [],
          });
        }
        sourceDocs.get(srcKey).facts.push(fact);
      }

      // 需要至少 2 个不同的源文档
      if (sourceDocs.size < 2) continue;

      // 检查不同源文档的事实是否有不同的 object
      const sources = [...sourceDocs.entries()];
      let hasContradiction = false;
      const conflictingDocs = [];

      for (let i = 0; i < sources.length; i++) {
        for (let j = i + 1; j < sources.length; j++) {
          const [srcA, docA] = sources[i];
          const [srcB, docB] = sources[j];

          // 找置信度 > 0.3 且 object 不同的事实对
          for (const factA of docA.facts) {
            if (factA.confidence < 0.3) continue;
            const objA = factA.object_id || factA.object_value || null;

            for (const factB of docB.facts) {
              if (factB.confidence < 0.3) continue;
              const objB = factB.object_id || factB.object_value || null;

              if (objA !== null && objB !== null && objA !== objB) {
                hasContradiction = true;
                conflictingDocs.push({
                  factA: { id: factA.id, object: objA, confidence: factA.confidence },
                  factB: { id: factB.id, object: objB, confidence: factB.confidence },
                  sourceA: { id: srcA, type: docA.source_type },
                  sourceB: { id: srcB, type: docB.source_type },
                });
              }
            }
          }
        }
      }

      if (!hasContradiction) continue;

      // 收集所有受影响的事实 ID
      const affectedIds = new Set();
      for (const conflict of conflictingDocs) {
        affectedIds.add(conflict.factA.id);
        affectedIds.add(conflict.factB.id);
      }

      const subjectId = group[0].subject_id;
      const predicate = group[0].predicate;

      const summary =
        `跨文档矛盾: 谓词 "${predicate}" 在 ${sourceDocs.size} 个文档中 ` +
        `有 ${conflictingDocs.length} 对冲突事实`;

      const detail = {
        subjectId,
        predicate,
        sourceDocCount: sourceDocs.size,
        conflicts: conflictingDocs,
      };

      const actions = {
        type: 'cross_doc_contradiction',
        operation: 'flag_for_review',
        note: '需要人工或 LLM 介入判断哪份文档更可信',
      };

      this._insertReflection(
        'cross_doc_contradiction',
        summary,
        detail,
        [...affectedIds],
        actions,
      );

      results.push({
        type: 'cross_doc_contradiction',
        summary,
        detail,
        affectedFacts: [...affectedIds],
        actions,
      });

      // 生成详细日志
      const docInfo = conflictingDocs.map((c) =>
        `  文档 ${c.sourceA.id}(${c.sourceA.type}): ${c.factA.object} (置信度 ${c.factA.confidence.toFixed(2)})` +
        ` vs 文档 ${c.sourceB.id}(${c.sourceB.type}): ${c.factB.object} (置信度 ${c.factB.confidence.toFixed(2)})`,
      ).join('\n');
      log.log(`${summary}\n${docInfo}`);
    }

    return results;
  }

  // ═══════════════════════════════════════════
  // 传递推理
  // ═══════════════════════════════════════════

  /**
   * 尝试传递推理：若 A→pred1→B 且 B→pred2→C（通过 edges 表），
   * 则推断 A→pred2→C，置信度为 min(confA, confB) * 0.7。
   *
   * @param {Array<{ id: string, subject_id: string, predicate: string, object_id: string|null, object_value: string|null, confidence: number, status: string }>} facts
   * @returns {Promise<Array<{ type: string, summary: string, detail: object, inferredFactId: string, confidence: number }>>}
   */
  async attemptInference(facts) {
    const db = this._schema.db;
    const now = _nowSeconds();
    const results = [];

    // 收集活跃事实中有 object_id 的（可形成传递链的）
    const linkableFacts = facts.filter(
      (f) => f.status === 'active' && f.object_id && f.confidence > 0.3,
    );

    if (linkableFacts.length === 0) {
      log.debug('没有可用于传递推理的链接事实');
      return results;
    }

    // 收集所有相关 entity ID
    const allEntityIds = new Set();
    for (const fact of linkableFacts) {
      allEntityIds.add(fact.subject_id);
      allEntityIds.add(fact.object_id);
    }

    // 批量查询 edges：B 作为 from_entity 的所有边
    // 即：对于 fact (A→B)，查找所有 B→C 的边
    if (allEntityIds.size === 0) return results;

    const placeholders = Array.from(allEntityIds, () => '?').join(',');
    const edgeStmt = db.prepare(
      `SELECT id, from_entity, to_entity, relation_type, confidence, fact_id
       FROM edges
       WHERE from_entity IN (${placeholders})`,
    );
    edgeStmt.bind(Array.from(allEntityIds));

    const outgoingEdges = [];
    while (edgeStmt.step()) {
      const row = edgeStmt.getAsObject();
      outgoingEdges.push(row);
    }
    edgeStmt.free();

    if (outgoingEdges.length === 0) {
      log.debug('edges 表中没有可用的传递链');
      return results;
    }

    // 构建索引：from_entity → [{ to_entity, relation_type, confidence }]
    const edgeIndex = new Map();
    for (const edge of outgoingEdges) {
      if (!edgeIndex.has(edge.from_entity)) {
        edgeIndex.set(edge.from_entity, []);
      }
      edgeIndex.get(edge.from_entity).push({
        toEntity: edge.to_entity,
        relationType: edge.relation_type,
        confidence: edge.confidence || 0,
        edgeId: edge.id,
        factId: edge.fact_id,
      });
    }

    // 尝试推理：对于每个 fact A→B，查找 B→C
    for (const fact of linkableFacts) {
      const bOutgoing = edgeIndex.get(fact.object_id);
      if (!bOutgoing || bOutgoing.length === 0) continue;

      for (const edge of bOutgoing) {
        // 跳过自引用 A→B→A（不重要）
        if (edge.toEntity === fact.subject_id) continue;

        const inferredConfidence = Math.min(fact.confidence, edge.confidence) * 0.7;

        // 置信度过低则跳过
        if (inferredConfidence < 0.1) continue;

        // 创建推断事实
        const inferredFactId = _makeId();
        try {
          db.run(
            `INSERT INTO facts
               (id, subject_id, predicate, object_id, object_value, confidence,
                source_type, source_id, created_at, updated_at, status)
             VALUES (?, ?, ?, ?, NULL, ?, 'inference', ?, ?, ?, 'active')`,
            [
              inferredFactId,
              fact.subject_id,
              edge.relationType,
              edge.toEntity,
              inferredConfidence,
              fact.id, // source_id 指向触发推理的原始事实
              now,
              now,
            ],
          );

          // 同时在 edges 表中创建边
          const inferredEdgeId = _makeId();
          db.run(
            `INSERT INTO edges
               (id, from_entity, to_entity, relation_type, fact_id, confidence)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              inferredEdgeId,
              fact.subject_id,
              edge.toEntity,
              edge.relationType,
              inferredFactId,
              inferredConfidence,
            ],
          );
        } catch (err) {
          log.warn(`创建推断事实失败: ${err.message}`);
          continue;
        }

        // 查询实体名称用于摘要
        const subjectName = await this._getEntityName(fact.subject_id);
        const middleName = await this._getEntityName(fact.object_id);
        const objectName = await this._getEntityName(edge.toEntity);

        const summary =
          `传递推理: "${subjectName}" -[${edge.relationType}]-> "${objectName}" ` +
          `(经由 "${subjectName}" -[${fact.predicate}]-> "${middleName}" -[${edge.relationType}]-> "${objectName}")`;

        const detail = {
          chain: [
            { entityId: fact.subject_id, name: subjectName },
            { predicate: fact.predicate, entityId: fact.object_id, name: middleName },
            { predicate: edge.relationType, entityId: edge.toEntity, name: objectName },
          ],
          sourceFactId: fact.id,
          sourceFactConfidence: fact.confidence,
          sourceEdgeId: edge.edgeId,
          sourceEdgeConfidence: edge.confidence,
          inferredConfidence,
          multiplier: 0.7,
        };
        const actions = {
          type: 'inference',
          operation: 'create_inferred_fact',
          inferredFactId,
        };

        this._insertReflection('inference', summary, detail, [inferredFactId, fact.id], actions);

        results.push({
          type: 'inference',
          summary,
          detail,
          inferredFactId,
          confidence: inferredConfidence,
        });

        log.log(summary);
      }
    }

    return results;
  }

  // ═══════════════════════════════════════════
  // 反思日志查询
  // ═══════════════════════════════════════════

  /**
   * 获取最近一次反思的时间戳。
   *
   * @returns {Promise<number|null>} Unix 时间戳（秒），无记录时返回 null
   */
  async getLastReflection() {
    if (!this._ready) await this.init();

    const db = this._schema.db;
    const stmt = db.prepare('SELECT MAX(created_at) as last_ts FROM reflections');
    let lastTs = null;
    if (stmt.step()) {
      const row = stmt.getAsObject();
      lastTs = row.last_ts || null;
    }
    stmt.free();

    if (lastTs) {
      log.debug(`最近一次反思: ${new Date(lastTs * 1000).toISOString()}`);
    } else {
      log.debug('尚无反思记录');
    }

    return lastTs;
  }

  /**
   * 获取最近的反思记录摘要。
   *
   * @param {number} [limit=10] — 返回条数上限
   * @returns {Promise<Array<{ id: string, type: string, summary: string, detail: object, affected_facts: string[], actions_taken: object, created_at: number }>>}
   */
  async getReflections(limit = 10) {
    if (!this._ready) await this.init();

    const db = this._schema.db;
    const stmt = db.prepare(
      'SELECT * FROM reflections ORDER BY created_at DESC LIMIT ?',
    );
    stmt.bind([limit]);

    const results = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        id: row.id,
        type: row.type,
        summary: row.summary,
        detail: this._safeJsonParse(row.detail),
        affected_facts: this._safeJsonParse(row.affected_facts) || [],
        actions_taken: this._safeJsonParse(row.actions_taken),
        created_at: row.created_at,
      });
    }
    stmt.free();

    log.debug(`获取反思记录: ${results.length} 条`);
    return results;
  }

  // ═══════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════

  /**
   * 获取近期需要反思的事实。
   * 优先获取自上次反思以来的新事实；若无上次反思记录，返回最近 100 条。
   *
   * @returns {Promise<Array<{ id: string, subject_id: string, predicate: string, object_id: string|null, object_value: string|null, confidence: number, status: string, source_type: string|null, source_id: string|null, created_at: number }>>}
   */
  async _getRecentFacts() {
    const db = this._schema.db;
    const lastTs = await this.getLastReflection();

    let stmt;
    if (lastTs) {
      stmt = db.prepare(
        `SELECT id, subject_id, predicate, object_id, object_value, confidence, status,
                source_type, source_id, created_at
         FROM facts
         WHERE status = 'active' AND created_at > ?
         ORDER BY created_at DESC`,
      );
      stmt.bind([lastTs]);
    } else {
      stmt = db.prepare(
        `SELECT id, subject_id, predicate, object_id, object_value, confidence, status,
                source_type, source_id, created_at
         FROM facts
         WHERE status = 'active'
         ORDER BY created_at DESC
         LIMIT 100`,
      );
    }

    const facts = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      facts.push({
        id: row.id,
        subject_id: row.subject_id,
        predicate: row.predicate,
        object_id: row.object_id || null,
        object_value: row.object_value || null,
        confidence: row.confidence,
        status: row.status,
        source_type: row.source_type || null,
        source_id: row.source_id || null,
        created_at: row.created_at,
      });
    }
    stmt.free();

    return facts;
  }

  /**
   * 插入一条反思记录到 reflections 表。
   *
   * @param {string} type         — 类型: 'contradiction' | 'dedup' | 'inference'
   * @param {string} summary     — 人类可读的简短摘要
   * @param {object} detail      — 详细数据（会 JSON 序列化）
   * @param {string[]} affectedFacts — 受影响的事实 ID 列表
   * @param {object} actions     — 采取的操作描述（会 JSON 序列化）
   */
  _insertReflection(type, summary, detail, affectedFacts, actions) {
    const db = this._schema.db;
    const id = _makeId();
    const now = _nowSeconds();

    db.run(
      `INSERT INTO reflections (id, type, summary, detail, affected_facts, actions_taken, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        type,
        summary,
        JSON.stringify(detail),
        JSON.stringify(affectedFacts),
        JSON.stringify(actions),
        now,
      ],
    );
  }

  /**
   * 按 entity ID 获取实体名称（带缓存，避免重复查询）。
   *
   * @param {string} entityId
   * @returns {Promise<string>}
   */
  async _getEntityName(entityId) {
    if (!this._entityNameCache) {
      this._entityNameCache = new Map();
    }
    if (this._entityNameCache.has(entityId)) {
      return this._entityNameCache.get(entityId);
    }

    const db = this._schema.db;
    const stmt = db.prepare('SELECT name FROM entities WHERE id = ?');
    stmt.bind([entityId]);
    let name = entityId; // 回退：用 ID 代替名称
    if (stmt.step()) {
      const row = stmt.getAsObject();
      name = row.name || entityId;
    }
    stmt.free();

    this._entityNameCache.set(entityId, name);
    return name;
  }

  /**
   * 安全解析 JSON，解析失败返回原值。
   *
   * @param {string|null} str
   * @returns {any}
   */
  _safeJsonParse(str) {
    if (!str) return null;
    try {
      return JSON.parse(str);
    } catch {
      return str;
    }
  }
}

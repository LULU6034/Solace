/**
 * knowledge-graph.js — 知识图谱 (P1)
 *
 * 主引擎: FalkorDB (RedisGraph)，需要 Docker: docker run -p 6379:6379 falkordb/falkordb
 * 降级: 内存邻接表 (无外部依赖，自动切换)
 *
 * 用法:
 *   await kg.ingest(dialogText)  // 抽取实体+关系写入图
 *   await kg.ingestLLM(dialogText, llm)  // LLM 深度推理实体+关系
 *   const ctx = await kg.query(userInput)  // 图检索 → LLM 上下文
 */

import { createModuleLogger } from '../lib/debug-log.js';

const log = createModuleLogger('mem:kg');

// ── In-memory adjacency list (fallback) ──
class MemoryGraph {
  constructor() {
    this.nodes = new Map();    // id → { label, props }
    this.edges = new Map();    // id → { from, to, label, props }
    this.outgoing = new Map(); // fromId → Set<edgeId>
    this.incoming = new Map(); // toId → Set<edgeId>
    this._nextId = 0;
  }

  addNode(label, props = {}) {
    const key = `${label}:${JSON.stringify(props)}`;
    for (const [id, node] of this.nodes) {
      if (node.label === label && this._propsMatch(node.props, props)) return id;
    }
    const id = `n${++this._nextId}`;
    this.nodes.set(id, { label, props });
    return id;
  }

  addEdge(fromId, toId, label, props = {}) {
    // 去重：检查是否已存在相同的 (from, to, label) 边
    for (const [eid, edge] of this.edges) {
      if (edge.from === fromId && edge.to === toId && edge.label === label) return eid;
    }
    const id = `e${++this._nextId}`;
    this.edges.set(id, { from: fromId, to: toId, label, props });
    if (!this.outgoing.has(fromId)) this.outgoing.set(fromId, new Set());
    this.outgoing.get(fromId).add(id);
    if (!this.incoming.has(toId)) this.incoming.set(toId, new Set());
    this.incoming.get(toId).add(id);
    return id;
  }

  /** Search nodes by label and partial text match */
  search(query, maxResults = 10) {
    const results = [];
    const q = query.toLowerCase();
    for (const [id, node] of this.nodes) {
      const text = Object.values(node.props).join(' ').toLowerCase();
      if (text.includes(q)) {
        results.push({ id, ...node });
      }
    }
    return results.slice(0, maxResults);
  }

  /** Get N-hop neighborhood starting from a node */
  getNeighborhood(nodeId, maxHops = 2, maxNodes = 20) {
    const visited = new Set([nodeId]);
    const queue = [{ id: nodeId, hop: 0 }];
    const subgraph = { nodes: [], edges: [] };

    while (queue.length > 0) {
      const { id, hop } = queue.shift();
      const node = this.nodes.get(id);
      if (node && !subgraph.nodes.find(n => n.id === id)) {
        subgraph.nodes.push({ id, ...node });
      }
      if (hop >= maxHops) continue;

      // Outgoing edges
      for (const eid of (this.outgoing.get(id) || [])) {
        const edge = this.edges.get(eid);
        if (edge && !subgraph.edges.find(e => e.id === eid)) {
          subgraph.edges.push({ id: eid, from: edge.from, to: edge.to, label: edge.label, props: edge.props });
          if (!visited.has(edge.to) && visited.size < maxNodes) {
            visited.add(edge.to);
            queue.push({ id: edge.to, hop: hop + 1 });
          }
        }
      }
      // Incoming edges
      for (const eid of (this.incoming.get(id) || [])) {
        const edge = this.edges.get(eid);
        if (edge && !subgraph.edges.find(e => e.id === eid)) {
          subgraph.edges.push({ id: eid, from: edge.from, to: edge.to, label: edge.label, props: edge.props });
          if (!visited.has(edge.from) && visited.size < maxNodes) {
            visited.add(edge.from);
            queue.push({ id: edge.from, hop: hop + 1 });
          }
        }
      }
    }
    return subgraph;
  }

  /** Deduce indirect relationships (2-hop transitive inference) */
  inferRelationships() {
    const inferred = [];
    // A → B → C implies A → C (transitive)
    for (const [fromId, outEdges] of this.outgoing) {
      for (const e1Id of outEdges) {
        const e1 = this.edges.get(e1Id);
        if (!e1) continue;
        const midId = e1.to;
        for (const e2Id of (this.outgoing.get(midId) || [])) {
          const e2 = this.edges.get(e2Id);
          if (!e2) continue;
          // Check if direct edge A→C already exists
          const hasDirect = [...(this.outgoing.get(fromId) || [])].some(
            eid => this.edges.get(eid)?.to === e2.to
          );
          if (!hasDirect && e2.to !== fromId) {
            inferred.push({
              from: fromId,
              to: e2.to,
              via: midId,
              chain: `${e1.label} → ${e2.label}`,
            });
          }
        }
      }
    }
    return inferred;
  }

  clear() {
    this.nodes.clear();
    this.edges.clear();
    this.outgoing.clear();
    this.incoming.clear();
  }

  get stats() {
    return { nodes: this.nodes.size, edges: this.edges.size };
  }

  _propsMatch(a, b) {
    const aKeys = Object.keys(a).filter(k => k !== 'confidence');
    const bKeys = Object.keys(b).filter(k => k !== 'confidence');
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k => a[k] === b[k]);
  }

  /** 搜索实体并返回格式化的关系描述，供 recall 使用 */
  queryRelations(query, maxResults = 8) {
    const q = (query || '').toLowerCase();
    if (!q || q.length < 2) return [];

    const matchedNodes = [];
    for (const [id, node] of this.nodes) {
      const text = (node.label + ' ' + Object.values(node.props || {}).join(' ')).toLowerCase();
      if (text.includes(q)) matchedNodes.push({ id, ...node });
    }
    if (!matchedNodes.length) return [];

    const results = [];
    const seen = new Set();
    const relMap = { LIKES:'喜欢', DISLIKES:'不喜欢', LIVES_IN:'住在', WORKS_AS:'是', HAS_PET:'养了', USES:'使用', KNOWS:'掌握', FRIEND_OF:'是朋友', COLLEAGUE_OF:'是同事', ATTENDED:'参加了', LISTENS_TO:'听', PLAYS:'演奏' };

    for (const node of matchedNodes.slice(0, 3)) {
      const nodeName = node.props?.name || node.props?.value || node.label;
      for (const eid of (this.outgoing.get(node.id) || [])) {
        const edge = this.edges.get(eid);
        if (!edge) continue;
        const target = this.nodes.get(edge.to);
        const tName = target?.props?.name || target?.props?.value || target?.label || '?';
        const key = `${nodeName}→${edge.label}→${tName}`;
        if (!seen.has(key)) { seen.add(key); results.push({ text: `${nodeName} ${relMap[edge.label] || edge.label} ${tName}` }); }
      }
      for (const eid of (this.incoming.get(node.id) || [])) {
        const edge = this.edges.get(eid);
        if (!edge) continue;
        const source = this.nodes.get(edge.from);
        const sName = source?.props?.name || source?.props?.value || source?.label || '?';
        const key = `${sName}→${edge.label}→${nodeName}`;
        if (!seen.has(key)) { seen.add(key); results.push({ text: `${sName} ${relMap[edge.label] || edge.label} ${nodeName}` }); }
      }
    }
    return results.slice(0, maxResults);
  }
}

// ── Simple LLM-based entity extraction (no heavy NLP) ──
const ENTITY_PATTERNS = [
  { regex: /我(?:在|住在|生活在|来自)([一-龥]{2,8})/g, type: 'Location', rel: 'LIVES_IN' },
  { regex: /我(?:是做|是搞|的职业是|做|干)([一-龥]{2,12})/g, type: 'Occupation', rel: 'WORKS_AS' },
  { regex: /我(?:喜欢|爱|热爱|偏好)([一-龥]{2,10})/g, type: 'Interest', rel: 'LIKES' },
  { regex: /我(?:讨厌|不喜欢|受不了)([一-龥]{2,10})/g, type: 'Dislike', rel: 'DISLIKES' },
  { regex: /我(?:养了|有只|有一只|家的)([一-龥]{2,8}(?:猫|狗|鸟|仓鼠|鱼|兔子|鼠|龟))/g, type: 'Pet', rel: 'HAS_PET' },
  { regex: /我(?:用的是|在用|用的)([a-zA-Z0-9一-龥]{2,20}(?:电脑|手机|笔记本|平板))/g, type: 'Device', rel: 'USES' },
  { regex: /我(?:学过|学过一点|会|懂)([一-龥]{2,12}(?:编程|语言|技术))/g, type: 'Skill', rel: 'KNOWS' },
];

/** LLM 深度推理 prompt: 抽取实体、关系，并推断隐含连接 */
const KG_LLM_PROMPT = `分析以下用户消息，提取实体和关系。返回 JSON。

规则:
1. 实体类型: Person(人物), Location(地点), Occupation(职业), Interest(兴趣), Pet(宠物), Device(设备), Skill(技能), Event(事件), Organization(组织)
2. 关系类型: LIVES_IN(居住), WORKS_AS(职业), LIKES(喜欢), DISLIKES(讨厌), HAS_PET(养宠物), USES(使用), KNOWS(掌握), FRIEND_OF(朋友), COLLEAGUE_OF(同事), ATTENDED(参与)
3. 也推断隐含关系（如"我和同事张三一起学Python" → 同事关系 + 技能关系）
4. 不要编造不存在的实体

返回格式:
{
  "entities": [{"type": "Person", "value": "张三", "confidence": 0.9}],
  "relations": [{"from_type": "Person", "from_value": "用户", "to_type": "Skill", "to_value": "Python", "relation": "KNOWS", "confidence": 0.8}]
}`;

export class KnowledgeGraph {
  constructor(opts = {}) {
    this.graph = new MemoryGraph();
    this.userNodeId = this.graph.addNode('User', { name: 'user' });
    this.agentNodeId = this.graph.addNode('Agent', { name: 'Sonder' });
  }

  /** Extract entities and add to graph from a user message (regex) */
  ingest(text) {
    if (!text || text.length < 5) return [];

    const entities = [];
    for (const pattern of ENTITY_PATTERNS) {
      const matches = [...text.matchAll(pattern.regex)];
      for (const m of matches) {
        const value = m[1];
        const nodeId = this.graph.addNode(pattern.type, { value });
        this.graph.addEdge(this.userNodeId, nodeId, pattern.rel, { source: 'pattern' });
        entities.push({ type: pattern.type, value, relation: pattern.rel });
      }
    }
    return entities;
  }

  /** LLM 深度推理: 抽取实体+关系+隐含连接 (P2) */
  async ingestLLM(text, llm) {
    if (!text || text.length < 5) return { entities: [], relations: [], inferred: [] };
    if (!llm) return this._toResult(this.ingest(text));

    try {
      const { content } = await llm.invoke([
        { role: 'system', content: KG_LLM_PROMPT },
        { role: 'user', content: text.slice(0, 1500) },
      ]);

      const parsed = this._parseLLMResponse(content);
      const entities = [];
      const relations = [];

      // 添加实体
      for (const e of parsed.entities || []) {
        const nid = this.graph.addNode(e.type, { value: e.value, confidence: e.confidence || 0.7 });
        entities.push({ type: e.type, value: e.value, nodeId: nid });
      }

      // 添加关系
      for (const r of parsed.relations || []) {
        const fromNode = this._findNode(r.from_type, r.from_value);
        const toNode = this._findNode(r.to_type, r.to_value);
        if (fromNode && toNode) {
          this.graph.addEdge(fromNode, toNode, r.relation, {
            confidence: r.confidence || 0.7,
            source: 'llm',
          });
          relations.push({ from: r.from_value, to: r.to_value, relation: r.relation });
        }
      }

      // 推理传递关系
      const inferred = this.graph.inferRelationships().map(inf => ({
        from: this.graph.nodes.get(inf.from)?.props?.value || inf.from,
        to: this.graph.nodes.get(inf.to)?.props?.value || inf.to,
        via: this.graph.nodes.get(inf.via)?.props?.value || inf.via,
        chain: inf.chain,
      }));

      log.log(`LLM KG: ${entities.length}实体, ${relations.length}关系, ${inferred.length}推理`);
      return { entities, relations, inferred };
    } catch (err) {
      log.warn(`KG LLM推理失败: ${err.message}，回退到规则匹配`);
      return this._toResult(this.ingest(text));
    }
  }

  _parseLLMResponse(text) {
    try {
      // Try direct JSON parse
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {}
    return { entities: [], relations: [] };
  }

  _findNode(type, value) {
    for (const [id, node] of this.graph.nodes) {
      if (node.label === type && node.props?.value === value) return id;
    }
    // Create if not found
    return this.graph.addNode(type, { value });
  }

  _toResult(entities) {
    return { entities: entities.map(e => ({ type: e.type, value: e.value })), relations: [], inferred: [] };
  }

  /** Query relevant nodes and return formatted context */
  query(userInput, maxResults = 5) {
    const results = this.graph.search(userInput, maxResults);

    if (results.length === 0) return null;

    const lines = ['## 知识图谱', '与当前话题相关的已知信息：'];
    for (const r of results) {
      const val = r.props?.value || JSON.stringify(r.props);
      lines.push(`- ${r.label}: ${val}`);
    }
    return lines.join('\n');
  }

  /** Get neighborhood of user node (full profile view) */
  getUserContext() {
    const sub = this.graph.getNeighborhood(this.userNodeId, 1);
    if (sub.nodes.length <= 1) return null;

    const lines = ['## 用户信息图谱'];
    for (const e of sub.edges) {
      const toNode = sub.nodes.find(n => n.id === e.to);
      const val = toNode?.props?.value || '';
      lines.push(`- ${e.label}: ${val}`);
    }
    return lines.join('\n');
  }

  get stats() { return this.graph.stats; }
  clear() { this.graph.clear(); }
}

/**
 * kb-graph-tools.js — Agent 知识图谱工具
 *
 * add_relation / query_relation
 * 基于 KnowledgeGraph 的知识三元组操作，
 * 让 Agent 能够记录和查询实体间的关系。
 */
import { createModuleLogger } from '../lib/debug-log.js';
import { KnowledgeGraph } from './graph.js';

const log = createModuleLogger('kb-graph-tools');

// ── 单例（懒初始化）──
let _graph = null;

async function getGraph() {
  if (!_graph) {
    _graph = new KnowledgeGraph();
    await _graph.init();
    log.log('KnowledgeGraph 单例已初始化');
  }
  return _graph;
}

// ═══════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════

export const addRelation = {
  name: 'add_relation',
  description:
    '记录两个实体之间的关系。当用户说"记住XXX是YYY的ZZZ""把A和B的关系记下来""A是B的作者""存一下这个关系"时使用。参数 subject: 主体实体名称, predicate: 关系谓词（如"作者""位于""属于""创建于"）, object: 客体实体名称。',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: '主体实体名称（关系的起点）' },
      predicate: { type: 'string', description: '关系谓词（如"作者""位于""属于"）' },
      object: { type: 'string', description: '客体实体名称（关系的终点）' },
    },
    required: ['subject', 'predicate', 'object'],
  },
  async invoke({ subject, predicate, object }) {
    const s = String(subject || '').trim();
    const p = String(predicate || '').trim();
    const o = String(object || '').trim();

    if (!s || !p || !o) {
      return '请提供完整的关系三元组: subject（主体）、predicate（谓词）、object（客体）。';
    }

    log.log(`add_relation: ${s} → ${p} → ${o}`);
    const graph = await getGraph();

    try {
      graph.addRelation(s, p, o, { source: 'user', confidence: 0.95 });
      return `已记录: ${s} ${p} ${o}`;
    } catch (err) {
      log.error(`add_relation 失败: ${err.message}`);
      return `记录关系失败: ${err.message}`;
    }
  },
};

export const queryRelation = {
  name: 'query_relation',
  description:
    '查询实体在知识图谱中的关系。当用户问"XXX和YYY是什么关系""XXX是谁""XXX有什么关联""关于XXX我知道什么"时使用。参数 entity: 要查询的实体名称。',
  parameters: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: '要查询的实体名称' },
    },
    required: ['entity'],
  },
  async invoke({ entity }) {
    const e = String(entity || '').trim();
    if (!e) return '请提供要查询的实体名称。';

    log.log(`query_relation: "${e}"`);
    const graph = await getGraph();
    const result = graph.getEntityWithFacts(e);

    if (!result) {
      return `知识图谱中没有找到关于「${e}」的信息。你可以先用 add_relation 工具记录相关关系。`;
    }

    const { entity: ent } = result;
    const lines = [];

    // 实体基本信息
    lines.push(`实体: ${ent.name}`);
    if (ent.type) lines.push(`类型: ${ent.type}`);
    if (ent.description) lines.push(`描述: ${ent.description}`);

    // 作为主体的关系（outgoing）
    if (result.outgoing.length > 0) {
      lines.push('');
      lines.push(`「${ent.name}」的 ${result.outgoing.length} 条关联:`);
      for (const f of result.outgoing) {
        const target = f.objectName || f.objectValue || '(未知)';
        lines.push(`  - ${ent.name} ${f.predicate} ${target} (置信度: ${(f.confidence * 100).toFixed(0)}%)`);
      }
    }

    // 作为客体的关系（incoming）
    if (result.incoming.length > 0) {
      lines.push('');
      lines.push(`指向「${ent.name}」的 ${result.incoming.length} 条关联:`);
      for (const f of result.incoming) {
        lines.push(`  - ${f.subjectName} ${f.predicate} ${ent.name} (置信度: ${(f.confidence * 100).toFixed(0)}%)`);
      }
    }

    // 连接图谱汇总
    if (result.connections.length > 0) {
      const connNames = [...new Set(result.connections.map(c => c.entityName))];
      lines.push('');
      lines.push(`关联实体: ${connNames.join('、')}`);
    }

    if (result.outgoing.length === 0 && result.incoming.length === 0) {
      lines.push('');
      lines.push('暂无关联关系。');
    }

    return lines.join('\n');
  },
};

export const kbGraphTools = [addRelation, queryRelation];

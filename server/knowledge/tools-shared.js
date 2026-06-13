/**
 * kb-tools-shared.js — 共享检索器/Schema 单例
 *
 * 供 Agent 内部（KB 注入）和 kb-tools.js 共用同一索引实例，
 * 避免每次对话创建空检索器导致 KB 注入成为死代码。
 */
import { HybridRetriever } from './kb-retriever.js';
import { KBSchema } from './kb-schema.js';
import { createModuleLogger } from '../debug-log.js';

const log = createModuleLogger('kb-shared');

let _retriever = null;
let _schema = null;

export function getRetriever() {
  if (!_retriever) {
    _retriever = new HybridRetriever();
    log.log('HybridRetriever 共享单例已创建');
  }
  return _retriever;
}

export async function getSchema() {
  if (!_schema) {
    _schema = new KBSchema();
    await _schema.init();
    log.log('KBSchema 共享单例已初始化');
  }
  return _schema;
}

/**
 * test-memory.mjs — 记忆系统端到端测试
 *
 * 不依赖 Electron，直接测试：
 * 1. FactStore (长期事实) — CRUD + 搜索
 * 2. remember — 冲突检测
 * 3. recall — 4 层搜索
 * 4. forget / update_memory
 * 5. memory_status
 *
 * 用法: node test-memory.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 使用临时目录，避免污染真实数据 ──
const TEST_DIR = path.join(os.homedir(), '.ai-desktop-pet-test-' + Date.now());
process.env.HOME = os.homedir();
process.env.USERPROFILE = os.homedir();

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── 清理 ──
function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    console.log(`\n已清理测试目录: ${TEST_DIR}`);
  }
}

// ── 初始化 FactStore ──
async function initFactStore() {
  const { FactStore } = await import('./server/lib/memory/fact-store.js');
  const store = new FactStore(TEST_DIR, 'test-user');
  await store.init();
  return store;
}

// ── 构建 _MemoryStore 包装（模拟 server/index.js 的包装） ──
function wrapStore(factStore) {
  return {
    factStore,
    search(query, k = 5) { return this.factStore.search(query, k); },
    addFact(fact, tags = [], opts = {}) { return this.factStore.add({ fact, tags, confidence: opts.confidence, half_life_days: opts.half_life_days }); },
    getAll() { return this.factStore.getAll(); },
    count() { return this.factStore.count(); },
    clear() { this.factStore.clear(); },
    softDelete(fact) { return this.factStore.softDelete(fact); },
    countDeleted() { return 0; }, // FactStore 没有 countDeleted
    vectorSearch: null, // 后面设置
  };
}

async function main() {
  console.log('══════════════════════════════════════════');
  console.log('  记忆系统端到端测试');
  console.log('══════════════════════════════════════════\n');

  // ─── 第 1 步: 初始化 ───
  console.log('── 1. 初始化 FactStore ──');
  const factStore = await initFactStore();
  const store = wrapStore(factStore);

  // 注入到 memory-tools
  const { setMemoryStore } = await import('./server/lib/tools/memory-store-ref.js');
  setMemoryStore(store);

  // 加载工具
  const { remember, recall, forget, updateMemory, memoryStatus } = await import('./server/lib/tools/memory-tools.js');

  assert(factStore.count() === 0, '初始事实数为 0');

  // ─── 第 2 步: remember ───
  console.log('\n── 2. remember — 存入事实 ──');

  let r = await remember.invoke({ content: '用户喜欢喝咖啡，每天早晨一杯美式', tags: ['偏好', '饮食'] });
  console.log('  结果:', r.slice(0, 80));
  assert(r.includes('已记住'), 'remember 返回成功');
  assert(factStore.count() === 1, '事实数变为 1');

  r = await remember.invoke({ content: '用户在杭州工作，是一名前端工程师', tags: ['职业', '地点'] });
  assert(factStore.count() === 2, '事实数变为 2');

  r = await remember.invoke({ content: '用户的猫叫团团，是一只橘猫', tags: ['宠物'] });
  assert(factStore.count() === 3, '事实数变为 3');

  r = await remember.invoke({ content: '用户最近在学习 Rust 语言', tags: ['学习'] });
  assert(factStore.count() === 4, '事实数变为 4');

  // ─── 第 3 步: recall (关键词) ───
  console.log('\n── 3. recall — 关键词搜索 ──');

  r = await recall.invoke({ query: '咖啡' });
  console.log('  搜索 "咖啡":\n' + r);
  assert(r.includes('咖啡') || r.includes('美式'), 'recall "咖啡" 命中');
  assert(!r.includes('未找到'), 'recall 有结果');

  r = await recall.invoke({ query: '猫' });
  console.log('  搜索 "猫":\n' + r);
  assert(r.includes('猫') || r.includes('团团') || r.includes('橘猫'), 'recall "猫" 命中');

  r = await recall.invoke({ query: '工作' });
  console.log('  搜索 "工作":\n' + r);
  assert(r.includes('杭州') || r.includes('前端'), 'recall "工作" 命中');

  // ─── 第 4 步: recall (无结果) ───
  console.log('\n── 4. recall — 无匹配 ──');
  r = await recall.invoke({ query: '火星殖民计划' });
  console.log('  搜索 "火星殖民计划":', r.slice(0, 60));
  assert(r.includes('未找到'), 'recall 无匹配返回提示');

  // ─── 第 5 步: 冲突检测 ───
  console.log('\n── 5. remember — 冲突检测 ──');
  r = await remember.invoke({ content: '用户讨厌喝咖啡，咖啡因过敏' });
  console.log('  存入冲突记忆:', r.slice(0, 120));
  assert(r.includes('⚠️') || r.includes('冲突'), '检测到冲突');

  // ─── 第 6 步: forget ───
  console.log('\n── 6. forget — 删除记忆 ──');
  const beforeForget = factStore.count();
  r = await forget.invoke({ content: '用户最近在学习 Rust 语言' });
  console.log('  删除结果:', r.slice(0, 60));
  assert(r.includes('已遗忘'), 'forget 返回成功');

  // 验证删除后搜不到
  r = await recall.invoke({ query: 'Rust' });
  console.log('  删除后搜索 "Rust":', r.slice(0, 60));
  assert(!r.includes('Rust') || r.includes('未找到'), '删除后 recall 搜不到');

  // ─── 第 7 步: update_memory ───
  console.log('\n── 7. update_memory — 更新记忆 ──');
  r = await updateMemory.invoke({
    oldContent: '用户在杭州工作，是一名前端工程师',
    newContent: '用户在上海工作，是一名全栈工程师'
  });
  console.log('  更新结果:', r.slice(0, 60));
  assert(r.includes('已更新'), 'update_memory 返回成功');

  r = await recall.invoke({ query: '上海' });
  console.log('  搜索 "上海":', r.slice(0, 80));
  assert(r.includes('上海'), '更新后 recall 命中新内容');

  // ─── 第 8 步: memory_status ───
  console.log('\n── 8. memory_status — 状态查询 ──');
  r = await memoryStatus.invoke();
  console.log(r);
  assert(r.includes('长期事实'), 'memory_status 包含长期事实');
  // 注意: 情景记忆/中期摘要/知识图谱 可能为空（测试环境没有历史数据）

  // ─── 第 9 步: 按层搜索 ───
  console.log('\n── 9. recall — 按层搜索 ──');
  r = await recall.invoke({ query: '咖啡', layer: 'facts' });
  console.log('  layer=facts:', r.slice(0, 80));
  assert(r.includes('咖啡') || r.includes('美式'), 'layer=facts 命中');

  // ─── 第 10 步: 空内容校验 ───
  console.log('\n── 10. 参数校验 ──');
  r = await remember.invoke({ content: '' });
  assert(r.includes('不能为空'), '空内容 remember 报错');
  r = await remember.invoke({ content: '   ' });
  assert(r.includes('不能为空'), '纯空格 remember 报错');
  r = await recall.invoke({ query: '' });
  assert(r.includes('不能为空'), '空查询 recall 报错');

  // ─── 结果汇总 ───
  console.log('\n══════════════════════════════════════════');
  console.log(`  测试完成: ${passed} 通过, ${failed} 失败`);
  console.log('══════════════════════════════════════════');

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('测试异常:', err);
  cleanup();
  process.exit(1);
});

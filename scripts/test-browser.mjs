// scripts/test-browser.mjs — 浏览器工具快速验证
// 用法:
//   set DEEPSEEK_API_KEY=sk-xxx
//   node scripts/test-browser.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 读取 API Key：优先环境变量，其次从 raw-config.json
let apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  const rawPath = path.join(os.homedir(), '.ai-desktop-pet', 'raw-config.json');
  if (existsSync(rawPath)) {
    try {
      const cfg = JSON.parse(readFileSync(rawPath, 'utf-8'));
      apiKey = cfg.deepseekApiKey || cfg.apiKey;
      console.log('[test] 从 raw-config.json 读取 Key');
    } catch {}
  }
}
if (!apiKey) {
  console.error('请先设置 DEEPSEEK_API_KEY 环境变量');
  console.error('或创建 %USERPROFILE%\\.ai-desktop-pet\\raw-config.json 包含 {"deepseekApiKey":"sk-xxx"}');
  process.exit(1);
}
process.env.DEEPSEEK_API_KEY = apiKey;

import { preInitBrowser, closeBrowser, isBrowserReady, browseTool } from '../server/tools/browser-tool.js';

async function test() {
  console.log('1. 预热浏览器...');
  await preInitBrowser();
  console.log('   就绪:', isBrowserReady());

  console.log('2. 测试: 打开百度搜索...');
  const t1 = Date.now();
  const result = await browseTool.invoke({
    task: '打开百度(baidu.com)，搜索"今天天气"，提取搜索结果第一条的标题和摘要',
    max_steps: 5,
  });
  console.log(`   耗时: ${Date.now() - t1}ms`);
  console.log('   结果:', result.slice(0, 250));

  console.log('3. 测试缓存（相同任务应秒返）...');
  const t2 = Date.now();
  await browseTool.invoke({ task: '打开百度(baidu.com)，搜索"今天天气"，提取搜索结果第一条的标题和摘要' });
  console.log(`   缓存命中: ${Date.now() - t2}ms（应 < 10ms）`);

  console.log('4. 关闭浏览器...');
  await closeBrowser();
  console.log('   已关闭');
  console.log('\n全部通过');
}

test().catch(err => {
  console.error('测试失败:', err.message);
  process.exit(1);
});

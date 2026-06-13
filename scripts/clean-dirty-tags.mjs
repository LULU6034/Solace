/**
 * clean-dirty-tags.mjs — 清理 facts.db 中的系统内部标签
 * 移除: auto_extracted, 日期字符串 (YYYY-MM-DD), session_*, phase_*, #开头的标签
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const DB_PATH = path.join(os.homedir(), '.ai-desktop-pet', 'facts.db');

async function main() {
  if (!fs.existsSync(DB_PATH)) { console.log('facts.db 不存在'); return; }

  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);

  const rows = db.exec("SELECT id, fact, tags FROM facts WHERE deleted_at IS NULL");
  if (!rows.length) { console.log('无数据'); db.close(); return; }

  const cols = rows[0].columns;
  const vals = rows[0].values;
  const SYS_RE = /^(auto_|session|phase_|#)/i;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  let cleaned = 0;
  for (const row of vals) {
    const id = row[cols.indexOf('id')];
    const tagsRaw = row[cols.indexOf('tags')];
    let tags = [];
    try { tags = JSON.parse(tagsRaw || '[]'); } catch {}

    const clean = tags.filter(t => !SYS_RE.test(t) && !DATE_RE.test(t));
    if (clean.length !== tags.length) {
      db.run("UPDATE facts SET tags = ? WHERE id = ?", [JSON.stringify(clean), id]);
      const fact = row[cols.indexOf('fact')];
      const removed = tags.filter(t => !clean.includes(t));
      console.log(`清理: "${fact?.slice(0, 40)}..." 移除 [${removed.join(', ')}]`);
      cleaned++;
    }
  }

  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  console.log(`\n完成: ${cleaned} 条记录被清理`);
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });

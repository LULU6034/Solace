"""
记忆数据库恢复脚本
1. 对 facts.db 做 WAL checkpoint（合并不完整事务）
2. 迁移到 facts_default.db（兼容新版命名）
"""
import sqlite3, os, shutil

base = os.path.expanduser("~/.ai-desktop-pet")
legacy = os.path.join(base, "facts.db")
target = os.path.join(base, "facts_default.db")

if not os.path.exists(legacy):
    print("旧数据库不存在，无需恢复")
    exit(0)

# 检查是否有 WAL 数据
wal_file = legacy + "-wal"
has_wal = os.path.exists(wal_file)
wal_size = os.path.getsize(wal_file) if has_wal else 0
print(f"旧数据库: {legacy} ({os.path.getsize(legacy)} bytes)")
if has_wal:
    print(f"WAL 文件: {wal_file} ({wal_size} bytes)")

# 步骤1: 连接旧数据库做 WAL checkpoint
conn = sqlite3.connect(legacy)
# 旧表可能没有 deleted_at 列
try:
    old_count = conn.execute("SELECT COUNT(*) FROM facts WHERE deleted_at IS NULL").fetchone()[0]
except:
    old_count = conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
print(f"旧数据库事实数: {old_count}")

try:
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    print("WAL checkpoint 完成")
except Exception as e:
    print(f"WAL checkpoint: {e} (数据可能在主文件中)")

# 重新检查
try:
    old_count2 = conn.execute("SELECT COUNT(*) FROM facts WHERE deleted_at IS NULL").fetchone()[0]
except:
    old_count2 = conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
conn.close()
print(f"checkpoint 后事实数: {old_count2}")

# 步骤2: 迁移到新版数据库
shutil.copy2(legacy, target)
os.rename(legacy, legacy + ".migrated")
print(f"已迁移: facts.db → facts_default.db")
print(f"备份: facts.db.migrated")
print(f"\n恢复完成。下一步: 删除 facts_default.db 让新代码重新加载（如果已有空库）")
print(f"rm {target}  # 如果 facts_default.db 已有空数据，需要先删掉")

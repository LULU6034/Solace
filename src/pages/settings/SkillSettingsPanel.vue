<template>
  <div class="skill-settings">
    <div class="skill-header">
      <input v-model="searchQuery" placeholder="搜索 Skill..." class="setting-input" />
    </div>

    <div v-if="filteredSkills.length === 0" class="skill-empty">
      暂无 Skill。输入 GitHub 仓库地址或 owner/repo 来安装。
    </div>

    <div v-for="s in filteredSkills" :key="s.name" class="skill-card">
      <div class="skill-left">
        <span class="skill-badge" :class="{ builtin: s.builtin, user: !s.builtin }">
          {{ s.builtin ? '内置' : '用户' }}
        </span>
        <div class="skill-info">
          <span class="skill-name">{{ s.name }}</span>
          <span class="skill-desc">{{ s.description || '无描述' }}</span>
          <span v-if="s.tools?.length" class="skill-tools-hint">
            工具: {{ s.tools.join(', ') }}
          </span>
        </div>
      </div>
      <div class="skill-right">
        <button @click="toggleSkill(s)" class="toggle-btn" :class="{ on: s.enabled }">
          {{ s.enabled ? '已启用' : '已禁用' }}
        </button>
        <button v-if="!s.builtin" @click="removeSkill(s)" class="danger-btn-sm">卸载</button>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const skills = ref([])
const searchQuery = ref('')

const filteredSkills = computed(() => {
  const q = searchQuery.value.toLowerCase()
  return skills.value.filter(s =>
    !q || s.name.toLowerCase().includes(q) || (s.meta.description || '').toLowerCase().includes(q)
  )
})

async function loadSkills() {
  try {
    const list = await window.electronAPI?.skillList()
    if (list?.skills) skills.value = list.skills
    else if (Array.isArray(list)) skills.value = list
  } catch(e) {}
}

async function toggleSkill(s) {
  await window.electronAPI?.skillEnable(s.name, !s.enabled)
  s.enabled = !s.enabled
}

async function removeSkill(s) {
  if (!confirm(`确定卸载 "${s.name}"？`)) return
  await window.electronAPI?.skillUninstall(s.name)
  await loadSkills()
}

onMounted(() => {
  loadSkills()
  // 监听 skill 变更事件（安装/卸载），实时刷新列表
  try { window.electronAPI?.onSkillsChanged?.(() => loadSkills()) } catch {}
})
</script>

<style scoped>
.skill-settings { padding: 4px 0; }
.skill-header { display: flex; gap: 8px; margin-bottom: 16px; }
.skill-header .setting-input { flex: 1; }
.skill-empty { color: var(--text-muted); font-size: 13px; padding: 24px 0; text-align: center; }

.skill-card {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--border); margin-bottom: 6px;
  transition: background var(--dur-fast);
}
.skill-card:hover { background: var(--bg-sidebar); }
.skill-left { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.skill-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 600;
  white-space: nowrap; margin-top: 2px;
}
.skill-badge.builtin { background: var(--accent-soft); color: var(--accent); }
.skill-badge.user { background: rgba(76, 175, 80, 0.1); color: #4caf50; }
.skill-info { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.skill-name { font-size: 13px; font-weight: 600; }
.skill-desc { font-size: 11px; color: var(--text-muted); }
.skill-tools-hint { font-size: 10px; color: var(--text-muted); font-family: monospace; }
.skill-right { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }

.toggle-btn {
  font-size: 11px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border);
  background: transparent; cursor: pointer; font-family: inherit;
  color: var(--text-muted); transition: all var(--dur-fast);
}
.toggle-btn.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }

.danger-btn-sm {
  font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(255,0,0,0.2);
  background: transparent; cursor: pointer; font-family: inherit;
  color: rgba(255,0,0,0.6); transition: all var(--dur-fast);
}
.danger-btn-sm:hover { background: rgba(255,0,0,0.08); color: rgba(255,0,0,0.8); }

</style>

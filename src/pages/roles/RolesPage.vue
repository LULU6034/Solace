<template>
  <div class="roles-page">
    <div class="roles-header">
      <h2 class="roles-title">角色管理</h2>
      <button class="setting-btn primary" @click="$emit('openSettings')">新建角色</button>
    </div>
    <div class="roles-list">
      <div v-for="a in agents" :key="a.id" class="roles-item">
        <span class="roles-icon" :style="{ background: (a.color || '#6366F1') + '18' }">{{ a.icon || '🤖' }}</span>
        <div class="roles-info">
          <span class="roles-name">
            {{ a.name }}
            <span v-if="a.isBuiltin" class="agent-row-badge">内置</span>
          </span>
          <span class="roles-status" :class="{ active: a.isActive }">{{ a.isActive ? '当前活跃' : '未活跃' }}</span>
        </div>
        <label class="roles-switch">
          <input type="checkbox" :checked="groupIds.includes(a.id)" @change="toggleGroup(a.id)" />
          <span>群聊</span>
        </label>
      </div>
      <div v-if="agents.length === 0" class="roles-empty">加载中...</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const emit = defineEmits(['openSettings'])

const agents = ref([])
const groupIds = ref(loadGroupIds())

function loadGroupIds() {
  try {
    const s = localStorage.getItem('active-group-agent-ids')
    return s ? JSON.parse(s) : ['__builtin_manager__', '__builtin_researcher__', '__builtin_executor__', '__builtin_reviewer__', '__builtin_memory_keeper__']
  } catch { return [] }
}

function saveGroupIds() {
  localStorage.setItem('active-group-agent-ids', JSON.stringify(groupIds.value))
}

function toggleGroup(id) {
  const i = groupIds.value.indexOf(id)
  if (i >= 0) groupIds.value.splice(i, 1)
  else groupIds.value.push(id)
  saveGroupIds()
}

onMounted(async () => {
  try {
    const r = await window.electronAPI?.agentList()
    agents.value = r?.data?.agents || r?.agents || []
  } catch { agents.value = [] }
})
</script>

<style scoped>
.roles-page {
  flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden;
  background: linear-gradient(180deg, rgba(88,104,240,0.01) 0%, transparent 30%);
}
.roles-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 24px 12px;
  border-bottom: 1px solid var(--border);
}
.roles-title { font-size: 16px; font-weight: 700; color: var(--text-primary); letter-spacing: -0.01em; }
.roles-list {
  flex: 1; overflow-y: auto; padding: 12px 16px;
  display: flex; flex-direction: column; gap: 6px;
}
.roles-item {
  display: flex; align-items: center; gap: 12px; padding: 12px 14px;
  border-radius: var(--radius-md);
  background: var(--bg-card);
  border: 1px solid var(--border);
  transition: all 0.2s var(--ease-out);
}
.roles-item:hover {
  background: var(--bg-sidebar);
  border-color: var(--border-strong);
  transform: translateX(2px);
}
.roles-icon {
  width: 42px; height: 42px; border-radius: 12px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.06), inset 0 0 0 1px rgba(255,255,255,0.5);
  transition: transform 0.2s var(--ease-out);
}
.roles-item:hover .roles-icon { transform: scale(1.05); }
.roles-info { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.roles-name { font-size: 13px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px; }
.roles-status { font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; }
.roles-status::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
.roles-status.active { color: var(--success); font-weight: 500; }
.roles-status.active::before { background: var(--success); box-shadow: 0 0 4px rgba(52,199,89,0.4); }
.roles-switch {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-secondary); cursor: pointer; user-select: none;
  padding: 4px 10px; border-radius: var(--radius-sm);
  background: var(--bg-input); border: 1px solid var(--border);
  transition: all 0.2s var(--ease-out);
}
.roles-switch:hover { border-color: var(--border-strong); background: var(--bg-sidebar-hover); }
.roles-switch input { accent-color: var(--accent); width: 14px; height: 14px; cursor: pointer; }
.roles-empty { text-align: center; padding: 48px 24px; color: var(--text-muted); font-size: 13px; }
.agent-row-badge {
  font-size: 10px; padding: 2px 7px; border-radius: 4px;
  background: var(--accent-soft); color: var(--accent); font-weight: 600;
}
</style>

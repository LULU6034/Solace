<template>
  <div class="memory-panel" :class="{ dark: isDark }">
    <!-- Header -->
    <div class="mp-header">
      <h3>🧠 记忆管理</h3>
      <div class="mp-header-actions">
        <button class="mp-btn small" @click="refreshAll" :disabled="loading">刷新</button>
        <button class="mp-btn small" @click="exportMemories">导出</button>
        <label class="mp-btn small import-label">
          导入<input type="file" accept=".json" @change="importMemories" hidden />
        </label>
      </div>
    </div>

    <!-- Tabs -->
    <div class="mp-tabs">
      <button v-for="t in tabs" :key="t.id" class="mp-tab"
        :class="{ active: activeTab === t.id }" @click="activeTab = t.id">
        {{ t.label }} <span class="mp-count">({{ t.count }})</span>
      </button>
    </div>

    <!-- Facts tab -->
    <div v-if="activeTab === 'facts'" class="mp-list">
      <div v-if="facts.length === 0" class="mp-empty">暂无记忆事实</div>
      <div v-for="(f, i) in facts" :key="i" class="mp-item">
        <div class="mp-item-main">
          <span class="mp-fact-text">{{ f.fact || f }}</span>
          <span v-if="f.tags" class="mp-tags">
            <span v-for="t in f.tags" :key="t" class="mp-tag">{{ t }}</span>
          </span>
        </div>
        <button class="mp-delete" @click="deleteFact(i)" title="删除">×</button>
      </div>
    </div>

    <!-- User Profile tab -->
    <div v-if="activeTab === 'profile'" class="mp-list">
      <div v-if="profileKeys.length === 0" class="mp-empty">暂无用户画像</div>
      <div v-for="key in profileKeys" :key="key" class="mp-item">
        <div class="mp-item-main">
          <span class="mp-key">{{ profileLabels[key] || key }}</span>
          <span class="mp-value">{{ profileData[key]?.value }}</span>
          <span class="mp-conf" :style="{ color: confColor(profileData[key]?.effectiveConfidence || profileData[key]?.confidence) }">
            {{ confPct(profileData[key]?.effectiveConfidence || profileData[key]?.confidence) }}
          </span>
        </div>
        <button class="mp-delete" @click="deleteProfile(key)" title="删除">×</button>
      </div>
    </div>

    <!-- Episodes tab -->
    <div v-if="activeTab === 'episodes'" class="mp-list">
      <div v-if="episodes.length === 0" class="mp-empty">暂无情景记忆</div>
      <div v-for="(ep, i) in episodes" :key="i" class="mp-item">
        <div class="mp-item-main">
          <span class="mp-date">{{ formatDate(ep.timestamp) }}</span>
          <span class="mp-ep-text">{{ ep.content?.keyQuote || JSON.stringify(ep.content).slice(0, 80) }}</span>
        </div>
        <button class="mp-delete" @click="deleteEpisode(i)" title="删除">×</button>
      </div>
    </div>

    <!-- Actions -->
    <div class="mp-footer">
      <button class="mp-btn danger" @click="clearAll">清空所有记忆</button>
      <span class="mp-total">总计: {{ totalCount }} 条</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const props = defineProps({ isDark: Boolean })

const activeTab = ref('facts')
const loading = ref(false)
const facts = ref([])
const profileData = ref({})
const episodes = ref([])

const tabs = computed(() => [
  { id: 'facts', label: '事实', count: facts.value.length },
  { id: 'profile', label: '画像', count: profileKeys.value.length },
  { id: 'episodes', label: '情景', count: episodes.value.length },
])

const profileKeys = computed(() => Object.keys(profileData.value))
const totalCount = computed(() => facts.value.length + profileKeys.value.length + episodes.value.length)

const profileLabels = {
  name: '名字', location: '所在地', occupation: '职业',
  interest: '兴趣', currentProject: '当前项目', mood: '心情',
  language: '语言',
  personality_openness: '开放性', personality_conscientiousness: '尽责性',
  personality_extraversion: '外向性', personality_agreeableness: '宜人性',
  personality_neuroticism: '情绪稳定性',
}

function confColor(c) {
  if (!c) return '#88909E'
  if (c >= 0.7) return '#059669'
  if (c >= 0.4) return '#FF9500'
  return '#FF3B30'
}

function confPct(c) {
  if (!c && c !== 0) return ''
  return Math.round(c * 100) + '%'
}

function formatDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

async function refreshAll() {
  loading.value = true
  try {
    const [factsResult, profileResult, episodesResult] = await Promise.all([
      window.electronAPI?.memoryGetFacts?.(),
      window.electronAPI?.memoryGetProfile?.(),
      window.electronAPI?.memoryGetEpisodes?.(),
    ])
    facts.value = factsResult?.facts || []
    profileData.value = profileResult?.profile || {}
    episodes.value = episodesResult?.episodes || []
  } catch (err) {
    console.error('[MemoryPanel] 刷新失败:', err)
  } finally {
    loading.value = false
  }
}

async function deleteFact(index) {
  const f = facts.value[index]
  if (!f) return
  await window.electronAPI?.memoryDeleteFact?.(f.id || index)
  facts.value.splice(index, 1)
}

async function deleteProfile(key) {
  await window.electronAPI?.memoryDeleteProfile?.(key)
  delete profileData.value[key]
}

async function deleteEpisode(index) {
  await window.electronAPI?.memoryDeleteEpisode?.(index)
  episodes.value.splice(index, 1)
}

async function clearAll() {
  if (!confirm('确定要清空所有记忆吗？此操作不可撤销。')) return
  await window.electronAPI?.memoryClearAll?.()
  facts.value = []
  profileData.value = {}
  episodes.value = []
}

function exportMemories() {
  const data = {
    facts: facts.value,
    profile: profileData.value,
    episodes: episodes.value,
    exportedAt: new Date().toISOString(),
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `sonder-memories-${new Date().toISOString().slice(0,10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

async function importMemories(event) {
  const file = event.target.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const data = JSON.parse(text)
    await window.electronAPI?.memoryImport?.(data)
    await refreshAll()
  } catch (err) {
    console.error('[MemoryPanel] 导入失败:', err)
    alert('导入失败: ' + err.message)
  }
}

onMounted(refreshAll)
</script>

<style scoped>

/* Premium interaction refinements */
button, .btn, .setting-btn, .seg-btn, .model-chip, .conv-pill {
  transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
}
button:hover, .btn:hover, .setting-btn:hover:not(:disabled), .conv-pill:hover {
  transform: translateY(-2px);
}
button:active, .btn:active, .setting-btn:active {
  transform: translateY(0) scale(0.98) !important;
}

input, select, textarea, .setting-input, .setting-select, .setting-textarea, .input-field {
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1) !important;
}
input:focus, select:focus, textarea:focus, .setting-input:focus {
  box-shadow: 0 0 0 6px rgba(109,124,255,0.03), 0 4px 16px rgba(0,0,0,0.12) !important;
}

.glass, .glass-card, .card-premium, [class*="card"] {
  transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
}

@keyframes premiumFadeIn {
  from { opacity: 0; transform: translateY(12px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes premiumScaleIn {
  from { opacity: 0; transform: scale(0.94); }
  to { opacity: 1; transform: scale(1); }
}


.memory-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg, #F5F7FA);
  font-family: Inter, system-ui, 'Microsoft YaHei UI', sans-serif;
  font-size: 13px;
}

.mp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border, #E8ECF0);
}

.mp-header h3 { font-size: 15px; margin: 0; }

.mp-header-actions { display: flex; gap: 6px; }

.mp-btn {
  padding: 5px 12px;
  border: 1px solid var(--border, #E8ECF0);
  border-radius: 6px;
  background: var(--card, #FFFFFF);
  color: var(--text-primary, #1A1A2E);
  cursor: pointer;
  font-size: 12px;
  transition: background .15s;
}

.mp-btn:hover { background: var(--border-light, #E8ECF0); }
.mp-btn.small { padding: 3px 8px; font-size: 11px; }
.mp-btn.danger { color: var(--danger, #FF3B30); border-color: var(--danger, #FF3B30); }

.import-label { cursor: pointer; display: inline-flex; align-items: center; }

.mp-tabs {
  display: flex;
  border-bottom: 1px solid var(--border, #E8ECF0);
}

.mp-tab {
  flex: 1;
  padding: 8px;
  border: none;
  background: none;
  color: var(--text-muted, #88909E);
  font-size: 13px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all .15s;
}

.mp-tab.active {
  color: var(--brand, #059669);
  border-bottom-color: var(--brand, #059669);
  font-weight: 500;
}

.mp-count { font-size: 11px; opacity: .7; }

.mp-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.mp-empty {
  text-align: center;
  color: var(--text-muted, #88909E);
  padding: 32px;
  font-size: 13px;
}

.mp-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-radius: 8px;
  margin-bottom: 4px;
  background: var(--card, #FFFFFF);
  border: 1px solid var(--border, #E8ECF0);
}

.mp-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.mp-fact-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mp-tags { display: flex; gap: 3px; flex-shrink: 0; }
.mp-tag {
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--border-light, #E8ECF0);
  font-size: 10px;
  color: var(--text-muted, #88909E);
}

.mp-key { font-weight: 500; flex-shrink: 0; }
.mp-value { color: var(--text-secondary, #5A6170); }
.mp-conf { font-size: 11px; flex-shrink: 0; }

.mp-date { font-size: 10px; color: var(--text-muted, #88909E); flex-shrink: 0; }
.mp-ep-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary, #5A6170);
}

.mp-delete {
  border: none;
  background: none;
  color: var(--text-muted, #88909E);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  opacity: .5;
  transition: opacity .15s;
}

.mp-delete:hover { opacity: 1; color: var(--danger, #FF3B30); }

.mp-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-top: 1px solid var(--border, #E8ECF0);
}

.mp-total { font-size: 11px; color: var(--text-muted, #88909E); }
</style>

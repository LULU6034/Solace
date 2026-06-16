<template>
  <div class="privacy-panel" :class="{ dark: isDark }">
    <h3>🔒 隐私与数据</h3>
    <p class="privacy-desc">Sonder 的所有数据均存储在本地。你可以随时查看、导出或删除。</p>

    <!-- Recording -->
    <section class="privacy-section">
      <h4>🎙️ 录音保存</h4>
      <div class="privacy-row">
        <span>自动保存语音录音</span>
        <select v-model="recordingMode" @change="saveSettings">
          <option value="7days">保留 7 天</option>
          <option value="30days">保留 30 天</option>
          <option value="forever">永久保留</option>
          <option value="never">不保存</option>
        </select>
      </div>
      <div class="privacy-hint">
        当前保存目录: ~/.sonder/recordings/
      </div>
    </section>

    <!-- Memory -->
    <section class="privacy-section">
      <h4>🧠 记忆数据</h4>
      <div class="privacy-row">
        <span>短期记忆 (20 轮)</span>
        <span class="privacy-badge auto">自动</span>
      </div>
      <div class="privacy-row">
        <span>中期摘要 (7 天)</span>
        <span class="privacy-badge auto">自动</span>
      </div>
      <div class="privacy-actions">
        <button class="privacy-btn small" @click="$emit('open-memory')">管理</button>
      </div>
      <div class="privacy-row">
        <span>长期事实</span>
        <button class="privacy-btn small" @click="$emit('open-memory')">管理</button>
      </div>
    </section>

    <!-- Profile -->
    <section class="privacy-section">
      <h4>👤 用户画像</h4>
      <div class="privacy-check" v-for="item in profileToggles" :key="item.key">
        <label>
          <input type="checkbox" v-model="item.enabled" @change="saveProfileToggles" />
          {{ item.label }}
        </label>
      </div>
      <div class="privacy-actions">
        <button class="privacy-btn danger" @click="deleteProfile">删除所有画像数据</button>
      </div>
    </section>

    <!-- Emotion -->
    <section class="privacy-section">
      <h4>📊 情绪追踪</h4>
      <div class="privacy-hint">
        情绪数据仅用于趋势分析和主动关怀，不会离开本地。
      </div>
      <div class="privacy-actions">
        <button class="privacy-btn small" @click="deleteEmotionLog">清除情绪日志</button>
      </div>
    </section>

    <!-- Data export -->
    <section class="privacy-section">
      <h4>📦 数据导出</h4>
      <div class="privacy-actions">
        <button class="privacy-btn" @click="exportAll">导出全部数据 (JSON)</button>
        <button class="privacy-btn danger" @click="deleteAll">删除全部数据</button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const props = defineProps({ isDark: Boolean })
defineEmits(['open-memory'])

const recordingMode = ref('7days')

const profileToggles = ref([
  { key: 'surface', label: '表层偏好 (兴趣、项目)', enabled: true },
  { key: 'deep', label: '深层人格 (Big Five 推断)', enabled: true },
  { key: 'style', label: '对话风格学习', enabled: true },
  { key: 'emotion', label: '情绪趋势分析', enabled: true },
])

onMounted(() => {
  recordingMode.value = localStorage.getItem('sonder-recording-save') || '7days'
  const profileCfg = localStorage.getItem('sonder-privacy-profile')
  if (profileCfg) {
    const saved = JSON.parse(profileCfg)
    for (const item of profileToggles.value) {
      if (saved[item.key] !== undefined) item.enabled = saved[item.key]
    }
  }
})

function saveSettings() {
  localStorage.setItem('sonder-recording-save', recordingMode.value)
}

function saveProfileToggles() {
  const cfg = {}
  for (const item of profileToggles.value) cfg[item.key] = item.enabled
  localStorage.setItem('sonder-privacy-profile', JSON.stringify(cfg))
}

async function deleteProfile() {
  if (!confirm('确定删除所有用户画像数据？')) return
  await window.electronAPI?.memoryDeleteProfile?.('*')
  alert('用户画像已删除')
}

async function deleteEmotionLog() {
  await window.electronAPI?.memoryDeleteEmotionLog?.()
  alert('情绪日志已清除')
}

async function exportAll() {
  const [facts, profile, episodes] = await Promise.all([
    window.electronAPI?.memoryGetFacts?.(),
    window.electronAPI?.memoryGetProfile?.(),
    window.electronAPI?.memoryGetEpisodes?.(),
  ])
  const data = {
    exportedAt: new Date().toISOString(),
    facts: facts?.facts || [],
    profile: profile?.profile || {},
    episodes: episodes?.episodes || [],
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `sonder-all-data-${new Date().toISOString().slice(0,10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

async function deleteAll() {
  if (!confirm('确定删除 Sonder 的全部数据？包括所有记忆、画像、设置。此操作不可撤销！')) return
  await window.electronAPI?.memoryClearAll?.()
  recordingMode.value = 'never'
  saveSettings()
  alert('全部数据已删除')
}
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


.privacy-panel {
  font-size: 13px;
  display: flex; flex-direction: column; gap: 20px;
}

.privacy-panel h3 { font-size: 18px; font-weight: 700; color: var(--text-primary); margin: 0; letter-spacing: -.2px; }
.privacy-panel h4 { font-size: 13px; font-weight: 600; color: var(--text-primary); margin: 0; }

.privacy-desc {
  color: var(--text-muted);
  font-size: 12.5px; line-height: 1.6;
}

/* 分区卡片 */
.privacy-section {
  padding: 16px; border-radius: 12px;
  border: 1px solid var(--border); background: var(--bg-card);
  display: flex; flex-direction: column; gap: 10px;
}

.privacy-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 2px 0; font-size: 13px; color: var(--text-primary);
}

.privacy-row select {
  padding: 6px 32px 6px 12px; border-radius: 8px;
  border: 1.5px solid var(--border); font-size: 12.5px; font-family: inherit;
  background: var(--bg-input); color: var(--text-primary); cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.5'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
  transition: border-color 0.2s;
}
.privacy-row select:hover { border-color: var(--border-strong); }
.privacy-row select:focus { border-color: var(--accent); outline: none; }

.privacy-check {
  display: flex; flex-direction: column; gap: 6px;
}
.privacy-check label {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  font-size: 13px; color: var(--text-primary);
  padding: 2px 0;
}
.privacy-check input[type="checkbox"] {
  width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer;
}

.privacy-badge {
  padding: 2px 10px; border-radius: 10px; font-size: 11px; font-weight: 500;
  background: var(--accent-soft); color: var(--accent);
}

.privacy-hint {
  font-size: 11.5px; color: var(--text-muted); line-height: 1.5;
}

/* 按钮组 */
.privacy-actions {
  display: flex; gap: 8px; flex-wrap: wrap;
}
.privacy-btn {
  padding: 8px 18px; border-radius: 10px;
  border: 1.5px solid var(--border); background: var(--bg-card);
  color: var(--text-secondary); cursor: pointer;
  font-size: 13px; font-family: inherit; font-weight: 500;
  transition: all 0.2s cubic-bezier(.16,1,.3,1);
}
.privacy-btn:hover {
  border-color: var(--border-strong); background: var(--bg-sidebar-hover);
  color: var(--text-primary);
  box-shadow: 0 2px 6px rgba(0,0,0,0.05);
}
.privacy-btn:active { transform: scale(0.97); }
.privacy-btn.small { padding: 4px 12px; font-size: 11.5px; border-radius: 8px; }
.privacy-btn.danger { color: var(--danger); border-color: rgba(239,68,68,0.3); }
.privacy-btn.danger:hover { background: rgba(239,68,68,0.06); border-color: var(--danger); }
</style>

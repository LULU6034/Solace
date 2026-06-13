<template>
  <div class="kp-root" ref="rootEl">
    <!-- ═══ 顶栏 ═══ -->
    <div class="kp-topbar">
      <div class="kp-search-row">
        <Search :size="14" class="kp-search-icon" />
        <input
          v-model="searchQuery"
          placeholder="搜索知识库…"
          class="kp-search-input"
          @input="onSearchInput"
          @keydown.enter="doSearch"
        />
        <button v-if="searchQuery" class="kp-search-clear" @click="clearSearch">×</button>
        <button class="setting-btn" @click="doSearch" :disabled="!searchQuery.trim() || searching">
          {{ searching ? '搜索中...' : '搜索' }}
        </button>
      </div>
      <div class="kp-topbar-actions">
        <button class="setting-btn" @click="showAddPathDialog = true" title="添加监控文件夹">
          <FolderOpen :size="14" />
          <span>索引文件夹</span>
        </button>
        <button class="setting-btn" @click="doRebuildIndex" :disabled="rebuilding">
          <RefreshCw :size="14" :class="{ spinning: rebuilding }" />
          <span>{{ rebuilding ? '重建中...' : '重建索引' }}</span>
        </button>
      </div>
    </div>

    <!-- ═══ 标签栏 ═══ -->
    <div class="kp-tab-bar">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="kp-tab"
        :class="{ active: activeTab === t.id }"
        @click="switchTab(t.id)"
      >
        <component :is="t.icon" :size="14" />
        <span>{{ t.label }}</span>
        <span v-if="t.count !== null" class="kp-tab-count">{{ t.count }}</span>
      </button>
    </div>

    <!-- ═══ 文档列表视图 ═══ -->
    <div class="kp-main" v-if="activeTab === 'docs'">
      <!-- 监控路径 -->
      <div class="kp-section">
        <div class="kp-section-header">
          <span class="kp-section-title">监控路径</span>
          <span class="kp-section-hint">文件变更后自动索引</span>
        </div>
        <div class="kp-watch-chips">
          <div
            v-for="(p, i) in watchPaths"
            :key="i"
            class="kp-watch-chip"
            ref="chipRefs"
          >
            <Folder :size="12" class="kp-chip-icon" />
            <span class="kp-chip-text">{{ p }}</span>
            <button class="kp-chip-remove" @click="removeWatchPath(p)" title="移除">×</button>
          </div>
          <div v-if="watchPaths.length === 0" class="kp-no-paths">
            未配置监控路径，点击"索引文件夹"添加
          </div>
        </div>
      </div>

      <!-- 索引统计 -->
      <div class="kp-stats-bar" v-if="stats.totalDocs > 0">
        <span class="kp-stat">
          <FileText :size="12" />
          {{ stats.totalDocs }} 个文档
        </span>
        <span class="kp-stat-divider">·</span>
        <span class="kp-stat">
          <Layers :size="12" />
          {{ stats.totalChunks }} 个片段
        </span>
        <span v-if="stats.lastIndexed" class="kp-stat-divider">·</span>
        <span v-if="stats.lastIndexed" class="kp-stat kp-stat-date">
          上次索引: {{ formatDate(stats.lastIndexed) }}
        </span>
      </div>

      <!-- 搜索中占位 -->
      <div v-if="searching" class="kp-loading">搜索中...</div>

      <!-- 搜索结果 -->
      <div v-else-if="searchResults.length > 0" class="kp-search-results">
        <div class="kp-results-header">
          找到 {{ searchResults.length }} 条结果
          <button class="kp-results-clear" @click="clearSearch">清除结果</button>
        </div>
        <div
          v-for="(r, i) in searchResults"
          :key="r.id || i"
          class="kp-result-item"
          :style="{ animationDelay: i * 0.03 + 's' }"
        >
          <div class="kp-result-icon" :class="iconClass(r)">
            <component :is="fileTypeIcon(r)" :size="16" />
          </div>
          <div class="kp-result-info">
            <span class="kp-result-name">{{ r.fileName || r.name || '未知文件' }}</span>
            <span class="kp-result-excerpt">{{ truncate(r.content || r.excerpt || '', 120) }}</span>
          </div>
          <span class="kp-result-score" v-if="r.score !== undefined">
            {{ (r.score * 100).toFixed(0) }}%
          </span>
        </div>
      </div>

      <!-- 文档列表 -->
      <div v-else class="kp-doc-list" ref="docListEl">
        <div
          v-for="(doc, i) in documents"
          :key="doc.id || doc.path"
          class="kp-doc-item"
          :style="{ animationDelay: i * 0.04 + 's' }"
          ref="docItemRefs"
        >
          <div class="kp-doc-icon" :class="iconClass(doc)">
            <component :is="fileTypeIcon(doc)" :size="18" />
          </div>
          <div class="kp-doc-info">
            <span class="kp-doc-name">{{ doc.fileName || doc.name || doc.path }}</span>
            <span class="kp-doc-meta">
              <span>{{ doc.chunkCount || doc.chunks || 0 }} 个片段</span>
              <span class="kp-doc-meta-div">·</span>
              <span>{{ doc.pageCount ? doc.pageCount + ' 页' : doc.type || '未知类型' }}</span>
              <span class="kp-doc-meta-div">·</span>
              <span>{{ formatDate(doc.indexedAt || doc.date) }}</span>
            </span>
          </div>
          <span class="kp-doc-path-hint">{{ doc.path || '' }}</span>
        </div>

        <!-- 空状态 -->
        <div v-if="documents.length === 0 && !searching" class="kp-empty">
          <Database :size="40" stroke-width="1" />
          <p class="kp-empty-title">知识库还是空的</p>
          <p class="kp-empty-desc">配置监控路径或拖入文件开始索引</p>
        </div>
      </div>
    </div>

    <!-- ═══ 知识图谱视图 ═══ -->
    <div class="kp-main" v-if="activeTab === 'graph'">
      <div class="kp-graph-placeholder">
        <div class="kp-graph-header">
          <GitBranch :size="16" />
          <span>知识图谱</span>
        </div>

        <div class="kp-graph-stats" v-if="graphStats.entityCount > 0">
          <div class="kp-graph-stat-card">
            <span class="kp-graph-stat-num">{{ graphStats.entityCount }}</span>
            <span class="kp-graph-stat-label">实体</span>
          </div>
          <div class="kp-graph-stat-card">
            <span class="kp-graph-stat-num">{{ graphStats.relationCount }}</span>
            <span class="kp-graph-stat-label">关系</span>
          </div>
          <div class="kp-graph-stat-card">
            <span class="kp-graph-stat-num">{{ graphStats.factCount }}</span>
            <span class="kp-graph-stat-label">事实</span>
          </div>
        </div>

        <div v-else class="kp-empty">
          <GitBranch :size="40" stroke-width="1" />
          <p class="kp-empty-title">暂无图谱数据</p>
          <p class="kp-empty-desc">索引文档后，Agent 会自动提取实体与关系</p>
        </div>

        <p class="kp-graph-hint">
          完整图谱可视化请查看
          <span class="kp-graph-link" @click="goToMemoryGraph">记忆图谱页面</span>
        </p>
      </div>
    </div>

    <!-- ═══ 添加监控路径弹窗 ═══ -->
    <Transition name="dialog-fade">
      <div v-if="showAddPathDialog" class="kp-dialog-overlay" @click.self="showAddPathDialog = false">
        <div class="kp-dialog" ref="dialogEl">
          <div class="kp-dialog-header">
            <span>添加监控路径</span>
            <button class="kp-dialog-close" @click="showAddPathDialog = false">×</button>
          </div>
          <div class="kp-dialog-body">
            <p class="kp-dialog-hint">输入本地文件夹的绝对路径，知识库将自动监控变更</p>
            <div class="kp-dialog-input-row">
              <input
                v-model="newPath"
                placeholder="/path/to/your/documents"
                class="input-field"
                style="flex:1"
                @keydown.enter="addWatchPath"
              />
              <button class="setting-btn primary" @click="addWatchPath" :disabled="!newPath.trim()">
                确认
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted, nextTick } from 'vue'
import {
  Search, FolderOpen, RefreshCw, Folder, FileText, Layers,
  Database, GitBranch
} from 'lucide-vue-next'
import gsap from 'gsap'
import { Spring, animSpeed, staggerList } from '../animations/gsap'

// ── 标签页 ──
const tabs = [
  { id: 'docs', label: '文档列表', icon: FileText, count: null },
  { id: 'graph', label: '知识图谱', icon: GitBranch, count: null },
]
const activeTab = ref('docs')

function switchTab(id) {
  activeTab.value = id
  if (id === 'graph') loadGraphStats()
  if (id === 'docs' && documents.value.length === 0) loadConfig()
  nextTick(() => {
    const items = rootEl.value?.querySelectorAll('.kp-doc-item, .kp-result-item')
    if (items.length) {
      gsap.from(items, {
        y: 16, opacity: 0,
        duration: Spring.snappy.duration / animSpeed(),
        stagger: 0.04 / animSpeed(),
        ease: Spring.snappy.ease,
      })
    }
  })
}

// ── 搜索 ──
const searchQuery = ref('')
const searching = ref(false)
const searchResults = ref([])
let searchTimer = null

function onSearchInput() {
  clearTimeout(searchTimer)
  if (!searchQuery.value.trim()) {
    searchResults.value = []
    return
  }
  searchTimer = setTimeout(() => doSearch(), 300)
}

async function doSearch() {
  const q = searchQuery.value.trim()
  if (!q || searching.value) return
  searching.value = true
  searchResults.value = []
  try {
    const r = await window.electronAPI?.kbSearch(q, { topK: 10 })
    if (r?.ok && r.data?.results) {
      searchResults.value = r.data.results
    } else if (Array.isArray(r?.data)) {
      searchResults.value = r.data
    }
  } catch (err) {
    console.error('[KnowledgePage] 搜索失败:', err)
  }
  searching.value = false
}

function clearSearch() {
  searchQuery.value = ''
  searchResults.value = []
}

// ── 文档列表 ──
const documents = ref([])
const stats = reactive({ totalDocs: 0, totalChunks: 0, lastIndexed: null })

async function loadConfig() {
  try {
    const r = await window.electronAPI?.kbGetConfig()
    if (r?.ok) {
      watchPaths.value = r.data?.watchPaths || []
      documents.value = r.data?.documents || r.data?.docs || []
      if (r.data?.stats) {
        stats.totalDocs = r.data.stats.totalDocs || 0
        stats.totalChunks = r.data.stats.totalChunks || 0
        stats.lastIndexed = r.data.stats.lastIndexed || null
      }
    }
  } catch (err) {
    console.error('[KnowledgePage] 加载配置失败:', err)
  }
}

// ── 监控路径 ──
const watchPaths = ref([])
const showAddPathDialog = ref(false)
const newPath = ref('')

async function addWatchPath() {
  const p = newPath.value.trim()
  if (!p) return
  if (watchPaths.value.includes(p)) {
    newPath.value = ''
    showAddPathDialog.value = false
    return
  }
  const updated = [...watchPaths.value, p]
  try {
    await window.electronAPI?.kbUpdateConfig('watchPaths', updated)
    watchPaths.value = updated
    await window.electronAPI?.kbIndexTrigger()
  } catch (err) {
    console.error('[KnowledgePage] 添加监控路径失败:', err)
  }
  newPath.value = ''
  showAddPathDialog.value = false
}

async function removeWatchPath(p) {
  const updated = watchPaths.value.filter(x => x !== p)
  try {
    await window.electronAPI?.kbUpdateConfig('watchPaths', updated)
    watchPaths.value = updated
  } catch (err) {
    console.error('[KnowledgePage] 移除监控路径失败:', err)
  }
}

// ── 索引操作 ──
const rebuilding = ref(false)

async function doRebuildIndex() {
  if (rebuilding.value) return
  rebuilding.value = true
  try {
    await window.electronAPI?.kbIndexRebuild()
    await loadConfig()
  } catch (err) {
    console.error('[KnowledgePage] 重建索引失败:', err)
  }
  rebuilding.value = false
}

// ── 图谱统计 ──
const graphStats = reactive({ entityCount: 0, relationCount: 0, factCount: 0 })

async function loadGraphStats() {
  try {
    const r = await window.electronAPI?.kbGetConfig()
    if (r?.ok && r.data?.graphStats) {
      graphStats.entityCount = r.data.graphStats.entityCount || 0
      graphStats.relationCount = r.data.graphStats.relationCount || 0
      graphStats.factCount = r.data.graphStats.factCount || 0
    }
  } catch {
    // 静默失败
  }
}

function goToMemoryGraph() {
  // 通过事件通知 App 切换到记忆视图
  window.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'memory' } }))
}

// ── 工具函数 ──
function formatDate(val) {
  if (!val) return '--'
  const d = val instanceof Date ? val : new Date(val)
  if (isNaN(d.getTime())) return String(val)
  const now = new Date()
  const diff = now - d
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前'
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function truncate(text, maxLen) {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '…'
}

function fileTypeIcon(doc) {
  const ext = (doc.fileName || doc.name || doc.path || '').split('.').pop()?.toLowerCase()
  const map = {
    pdf: FileText,
    md: FileText,
    txt: FileText,
    html: FileText,
    doc: FileText,
    docx: FileText,
    csv: FileText,
    json: FileText,
    py: FileText,
    js: FileText,
    ts: FileText,
  }
  return map[ext] || FileText
}

function iconClass(doc) {
  const ext = (doc.fileName || doc.name || doc.path || '').split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return 'icon-pdf'
  if (ext === 'md') return 'icon-md'
  if (['js', 'ts', 'py', 'go', 'rs'].includes(ext)) return 'icon-code'
  return 'icon-generic'
}

// ── Refs ──
const rootEl = ref(null)
const docListEl = ref(null)
const dialogEl = ref(null)
const docItemRefs = ref([])
const chipRefs = ref([])

// ── Lifecycle ──
onMounted(async () => {
  await loadConfig()
  await nextTick()
  // 入场动画
  if (rootEl.value) {
    const s = animSpeed()
    gsap.from(rootEl.value, {
      opacity: 0,
      duration: Spring.smooth.duration / s,
      ease: Spring.smooth.ease,
    })
  }
  nextTick(() => {
    staggerList('.kp-doc-item', { from: 'bottom', stagger: 0.04 })
    staggerList('.kp-watch-chip', { from: 'left', stagger: 0.06 })
  })
})

onUnmounted(() => {
  clearTimeout(searchTimer)
})
</script>

<style scoped>
/* ═══ Root ═══ */
.kp-root {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* ═══ Top Bar ═══ */
.kp-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.kp-search-row {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 180px;
}

.kp-search-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.kp-search-input {
  flex: 1;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out);
  min-width: 0;
}

.kp-search-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
}

.kp-search-input::placeholder {
  color: var(--text-muted);
}

.kp-search-clear {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color var(--dur-fast);
}

.kp-search-clear:hover {
  color: var(--text-primary);
}

.kp-topbar-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.kp-topbar-actions .setting-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 6px 12px;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ═══ Tab Bar ═══ */
.kp-tab-bar {
  display: flex;
  gap: 2px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.kp-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}

.kp-tab:hover {
  color: var(--text-secondary);
  background: var(--bg-sidebar-hover);
}

.kp-tab.active {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}

.kp-tab-count {
  font-size: 10px;
  background: var(--accent-soft);
  color: var(--accent-light);
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 500;
}

/* ═══ Main Content ═══ */
.kp-main {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ═══ Section ═══ */
.kp-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kp-section-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.kp-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.kp-section-hint {
  font-size: 10px;
  color: var(--text-muted);
}

/* ═══ Watch Path Chips ═══ */
.kp-watch-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.kp-watch-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px 5px 10px;
  border-radius: 20px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary);
  transition: all var(--dur-fast) var(--ease-out);
}

.kp-watch-chip:hover {
  border-color: var(--border-strong);
  background: var(--bg-sidebar-hover);
}

.kp-chip-icon {
  color: var(--accent-light);
  flex-shrink: 0;
}

.kp-chip-text {
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kp-chip-remove {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all var(--dur-fast);
}

.kp-chip-remove:hover {
  color: var(--danger);
  background: rgba(255, 59, 48, 0.1);
}

.kp-no-paths {
  font-size: 11px;
  color: var(--text-muted);
  padding: 4px 0;
}

/* ═══ Stats Bar ═══ */
.kp-stats-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary);
  flex-wrap: wrap;
}

.kp-stat {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
}

.kp-stat svg {
  color: var(--text-muted);
}

.kp-stat-divider {
  color: var(--border-strong);
}

.kp-stat-date {
  color: var(--text-muted);
}

.kp-loading {
  text-align: center;
  padding: 20px 0;
  font-size: 12px;
  color: var(--text-muted);
}

/* ═══ Search Results ═══ */
.kp-search-results {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.kp-results-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 2px;
}

.kp-results-clear {
  padding: 2px 10px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 10px;
  font-family: inherit;
  transition: all var(--dur-fast);
}

.kp-results-clear:hover {
  color: var(--text-secondary);
  border-color: var(--border-strong);
}

.kp-result-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  border: 1px solid var(--border);
  animation: docFadeIn 0.35s var(--ease-out) both;
  transition: all var(--dur-fast) var(--ease-out);
}

.kp-result-item:hover {
  border-color: var(--border-strong);
  background: var(--bg-sidebar-hover);
}

/* ═══ Document List ═══ */
.kp-doc-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.kp-doc-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
  animation: docFadeIn 0.35s var(--ease-out) both;
}

.kp-doc-item:hover {
  background: var(--bg-sidebar-hover);
}

.kp-doc-icon,
.kp-result-icon {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid var(--border);
}

.kp-doc-icon.icon-pdf,
.kp-result-icon.icon-pdf {
  background: rgba(255, 59, 48, 0.08);
  color: #FF3B30;
}

.kp-doc-icon.icon-md,
.kp-result-icon.icon-md {
  background: rgba(109, 124, 255, 0.08);
  color: var(--accent);
}

.kp-doc-icon.icon-code,
.kp-result-icon.icon-code {
  background: rgba(52, 199, 89, 0.08);
  color: var(--success);
}

.kp-doc-icon.icon-generic,
.kp-result-icon.icon-generic {
  background: rgba(148, 152, 168, 0.06);
  color: var(--text-muted);
}

.kp-doc-info,
.kp-result-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.kp-doc-name,
.kp-result-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kp-doc-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-muted);
}

.kp-doc-meta-div {
  color: var(--border-strong);
}

.kp-doc-path-hint {
  font-size: 10px;
  color: var(--text-muted);
  max-width: 120px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
  display: none;
}

@media (min-width: 600px) {
  .kp-doc-path-hint {
    display: block;
  }
}

.kp-result-excerpt {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.kp-result-score {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-light);
  flex-shrink: 0;
}

/* ═══ Empty State ═══ */
.kp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  gap: 8px;
}

.kp-empty svg {
  color: var(--text-muted);
  opacity: 0.4;
}

.kp-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-top: 8px;
}

.kp-empty-desc {
  font-size: 12px;
  color: var(--text-muted);
  max-width: 260px;
}

/* ═══ Graph View ═══ */
.kp-graph-placeholder {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.kp-graph-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.kp-graph-stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
}

.kp-graph-stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 16px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-card);
  border: 1px solid var(--border);
}

.kp-graph-stat-num {
  font-size: 24px;
  font-weight: 700;
  color: var(--accent);
  font-family: var(--font-mono);
}

.kp-graph-stat-label {
  font-size: 11px;
  color: var(--text-muted);
}

.kp-graph-hint {
  text-align: center;
  font-size: 11px;
  color: var(--text-muted);
}

.kp-graph-link {
  color: var(--accent-light);
  cursor: pointer;
  text-decoration: underline;
  transition: color var(--dur-fast);
}

.kp-graph-link:hover {
  color: var(--accent-glow);
}

/* ═══ Dialog ═══ */
.kp-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}

.kp-dialog {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 20px 24px;
  min-width: 360px;
  max-width: 480px;
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.kp-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.kp-dialog-close {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--dur-fast);
}

.kp-dialog-close:hover {
  background: rgba(255, 59, 48, 0.08);
  color: var(--danger);
}

.kp-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.kp-dialog-hint {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}

.kp-dialog-input-row {
  display: flex;
  gap: 8px;
}

/* ═══ Dialog Transition ═══ */
.dialog-fade-enter-active {
  transition: opacity 0.2s var(--ease-out);
}

.dialog-fade-enter-active .kp-dialog {
  transition: transform 0.25s var(--ease-spring), opacity 0.2s var(--ease-out);
}

.dialog-fade-leave-active {
  transition: opacity 0.15s var(--ease-out);
}

.dialog-fade-leave-active .kp-dialog {
  transition: transform 0.15s var(--ease-out), opacity 0.15s var(--ease-out);
}

.dialog-fade-enter-from {
  opacity: 0;
}

.dialog-fade-enter-from .kp-dialog {
  transform: scale(0.94) translateY(8px);
  opacity: 0;
}

.dialog-fade-leave-to {
  opacity: 0;
}

.dialog-fade-leave-to .kp-dialog {
  transform: scale(0.96);
  opacity: 0;
}

/* ═══ Doc Fade-in ═══ */
@keyframes docFadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ═══ Responsive ═══ */
@media (max-width: 480px) {
  .kp-topbar {
    flex-direction: column;
    align-items: stretch;
  }

  .kp-topbar-actions {
    justify-content: flex-start;
  }

  .kp-doc-path-hint {
    display: none;
  }

  .kp-dialog {
    min-width: unset;
    margin: 16px;
    width: calc(100% - 32px);
  }

  .kp-graph-stats {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>

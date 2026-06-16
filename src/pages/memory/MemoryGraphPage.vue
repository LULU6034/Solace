<template>
  <div class="mgp-root">
    <!-- ═══ 顶栏 ═══ -->
    <div class="mgp-topbar">
      <div class="mgp-tabs">
        <button v-for="t in tabs" :key="t.id" class="mgp-tab" :class="{ active: activeTab === t.id }"
          @click="switchTab(t.id)">
          <component :is="t.icon" :size="14" />
          {{ t.label }}
        </button>
      </div>
      <div class="mgp-search">
        <Search :size="14" class="mgp-search-icon" />
        <input v-model="searchQuery" placeholder="搜索记忆…" class="mgp-search-input"
          @input="onSearch" />
        <button v-if="searchQuery" class="mgp-search-clear" @click="searchQuery='';onSearch()">×</button>
      </div>
      <button class="mgp-refresh" @click="loadAll" :disabled="loading">
        <RefreshCw :size="14" :class="{ spinning: loading }" />
      </button>
    </div>

    <!-- ═══ 图谱视图 ═══ -->
    <div class="mgp-main" v-if="activeTab === 'graph'">
      <div class="mgp-canvas-wrap" ref="canvasWrap">
        <canvas ref="graphCanvas" @mousedown="onCanvasMouseDown" @mousemove="onCanvasMouseMove"
          @mouseup="onCanvasMouseUp" @wheel="onCanvasWheel" @dblclick="onCanvasDblClick"
          @contextmenu.prevent />
        <div class="mgp-legend">
          <span><i style="background:#a78bfa;width:9px;height:9px"></i>主题标签</span>
          <span><i style="background:#e2e8f0;width:4px;height:4px"></i>事实</span>
          <span><i style="background:#f59e0b;width:5px;height:5px"></i>情景</span>
          <span class="mgp-legend-hint">滚轮缩放 · 拖拽平移 · 双击重置</span>
        </div>
        <div v-if="graphNodes.length === 0 && !loading" class="mgp-empty">
          <Brain :size="32" stroke-width="1" />
          <p>暂无图谱数据</p>
          <span>Agent 会在对话中自动提取实体与关系</span>
        </div>
      </div>
      <!-- 详情面板 -->
      <Transition name="detail-slide">
        <div class="mgp-detail" v-if="selectedNode">
          <div class="mgp-detail-head" :style="{ borderLeftColor: nodeColor(selectedNode.type) }">
            <span class="mgp-detail-type" :style="{ background: nodeColor(selectedNode.type) }">
              {{ nodeTypeLabel(selectedNode.type) }}
            </span>
            <button class="mgp-detail-close" @click="selectedNode=null">×</button>
          </div>
          <div class="mgp-detail-body">
            <p class="mgp-detail-text">{{ selectedNode.label }}</p>
            <!-- 标签节点：列出成员 -->
            <div v-if="selectedNode.type === 'tag' && selectedNode._members?.length" class="mgp-members">
              <div class="mgp-members-title">{{ selectedNode._members.length }} 条记忆</div>
              <div v-for="m in selectedNode._members" :key="m.id" class="mgp-member-item"
                @click="selectedNode = m">
                {{ m.label.slice(0, 60) }}{{ m.label.length > 60 ? '…' : '' }}
              </div>
            </div>
            <!-- 事实节点：显示标签 -->
            <div class="mgp-detail-meta" v-if="selectedNode.type === 'fact' && selectedNode._tags?.length">
              <span class="mgp-tag" v-for="t in selectedNode._tags" :key="t">{{ t }}</span>
            </div>
            <div class="mgp-detail-stats" v-if="selectedNode.degree > 0">
              关联 {{ selectedNode.degree }} 条记忆
            </div>
            <div class="mgp-detail-date" v-if="selectedNode.date || selectedNode.created_at">
              {{ formatDate(selectedNode.date || selectedNode.created_at) }}
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <!-- ═══ 时间线视图 ═══ -->
    <div class="mgp-timeline" v-if="activeTab === 'timeline'">
      <div v-if="timelineItems.length === 0 && !loading" class="mgp-empty">
        <Clock :size="32" stroke-width="1" />
        <p>暂无时间线数据</p>
      </div>
      <div class="mgp-tl-track" v-else>
        <div v-for="(group, gi) in timelineItems" :key="gi" class="mgp-tl-group">
          <div class="mgp-tl-date-badge">{{ group.date }}</div>
          <div class="mgp-tl-cards">
            <TransitionGroup name="tl-card">
              <div v-for="(item, ii) in group.items" :key="gi+'-'+ii" class="mgp-tl-card"
                :class="{ fact: item.type === 'fact', episode: item.type === 'episode' }"
                @click="selectTimelineItem(item)">
                <div class="mgp-tl-card-dot" :style="{ background: nodeColor(item.type) }" />
                <div class="mgp-tl-card-content">
                  <p class="mgp-tl-card-text">{{ item.label }}</p>
                  <div class="mgp-tl-card-meta">
                    <span v-if="item.tags?.length" class="mgp-tl-tags">
                      <span v-for="t in item.tags.slice(0,3)" :key="t" class="mgp-tag">{{ t }}</span>
                    </span>
                    <span class="mgp-tl-time">{{ item.time }}</span>
                  </div>
                </div>
              </div>
            </TransitionGroup>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ 统计面板 ═══ -->
    <div class="mgp-stats" v-if="activeTab === 'stats'">
      <div class="mgp-stat-grid">
        <!-- 总览卡片 -->
        <div class="mgp-stat-card overview">
          <div class="mgp-stat-icon"><Database :size="20" /></div>
          <div class="mgp-stat-val">{{ stats.totalFacts }}</div>
          <div class="mgp-stat-label">长期事实</div>
        </div>
        <div class="mgp-stat-card episodes">
          <div class="mgp-stat-icon"><Layers :size="20" /></div>
          <div class="mgp-stat-val">{{ stats.totalEpisodes }}</div>
          <div class="mgp-stat-label">情景记忆</div>
        </div>
        <div class="mgp-stat-card topics">
          <div class="mgp-stat-icon"><Tag :size="20" /></div>
          <div class="mgp-stat-val">{{ stats.totalTags }}</div>
          <div class="mgp-stat-label">标签/主题</div>
        </div>
        <div class="mgp-stat-card edges">
          <div class="mgp-stat-icon"><GitBranch :size="20" /></div>
          <div class="mgp-stat-val">{{ stats.totalEdges }}</div>
          <div class="mgp-stat-label">实体关系</div>
        </div>
      </div>

      <!-- 置信度分布 -->
      <div class="mgp-stat-section" v-if="stats.confidenceBuckets">
        <h4>置信度分布</h4>
        <div class="mgp-bar-chart">
          <div v-for="b in stats.confidenceBuckets" :key="b.label" class="mgp-bar-row">
            <span class="mgp-bar-label">{{ b.label }}</span>
            <div class="mgp-bar-track">
              <div class="mgp-bar-fill" :style="{ width: b.pct + '%', background: b.color }" />
            </div>
            <span class="mgp-bar-count">{{ b.count }}</span>
          </div>
        </div>
      </div>

      <!-- 时间衰减 -->
      <div class="mgp-stat-section" v-if="stats.decayData?.length">
        <h4>记忆留存曲线</h4>
        <div class="mgp-decay-chart">
          <svg viewBox="0 0 300 100" class="mgp-decay-svg">
            <polyline :points="stats.decayLine" fill="none" stroke="var(--accent)" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" />
            <circle v-for="(pt, i) in stats.decayPoints" :key="i" :cx="pt.x" :cy="pt.y" r="3"
              fill="var(--accent)" opacity="0.6" />
          </svg>
          <div class="mgp-decay-labels">
            <span>今天</span><span>30天</span><span>90天</span><span>180天</span>
          </div>
        </div>
      </div>

      <!-- 标签分布 -->
      <div class="mgp-stat-section" v-if="stats.topTags?.length">
        <h4>高频标签</h4>
        <div class="mgp-tag-cloud">
          <span v-for="t in stats.topTags" :key="t.name" class="mgp-cloud-tag"
            :style="{ fontSize: 11 + t.weight * 14 + 'px', opacity: 0.5 + t.weight * 0.5 }">
            {{ t.name }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { Brain, Search, RefreshCw, Clock, Database, Layers, Tag, GitBranch } from 'lucide-vue-next'

// ── 状态 ──
const activeTab = ref('graph')
const searchQuery = ref('')
const loading = ref(false)
const selectedNode = ref(null)
const graphNodes = ref([])
const graphEdges = ref([])
const factsData = ref([])
const episodesData = ref([])

const tabs = [
  { id: 'graph', icon: GitBranch, label: '图谱' },
  { id: 'timeline', icon: Clock, label: '时间线' },
  { id: 'stats', icon: Database, label: '统计' },
]

// ── 节点配色（纯色，无光晕）──
const NODE_COLORS = {
  fact:    '#e2e8f0',
  tag:     '#a78bfa',
  episode: '#f59e0b',
  topic:   '#34d399',
}
function nodeColor(t) { return NODE_COLORS[t] || NODE_COLORS.fact }
const nodeTypeLabel = t => ({ fact: '事实', tag: '主题', episode: '情景', topic: '主题' }[t] || t)

function formatDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function switchTab(id) {
  if (activeTab.value === 'graph' && id !== 'graph') stopForce()
  activeTab.value = id
  selectedNode.value = null
  if (id === 'graph') nextTick(() => restartForce())
}

// ── 标签过滤 ──
const SYS_TAG_RE = /^(auto_|session|phase_|#)/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function cleanTags(tags) {
  return (tags || []).filter(t => !SYS_TAG_RE.test(t) && !DATE_RE.test(t))
}

// ── 关键词提取（无标签时从文本自动抽取） ──
const STOP_WORDS = new Set(['的','了','是','在','我','你','他','她','它','们','和','与','或','不','很','都',
  '也','就','要','会','能','可以','一个','这个','那个','什么','怎么','为什么','把','被','对','从','到',
  '用','以','为','因为','所以','但是','如果','虽然','已经','正在','将','还','更','最','非常','比较',
  '喜欢','讨厌','有点','觉得','没有','知道','想','说','看','做','去','来','有','没'])
function extractKeywords(text) {
  if (!text) return []
  // 切词：中文按字符2-gram，英文按单词
  const words = []
  const clean = text.replace(/[，。！？、；：""''（）\s\[\]{}]/g, ' ')
  // 英文单词
  const enWords = clean.match(/[a-zA-Z]{2,}/g) || []
  words.push(...enWords.map(w => w.toLowerCase()))
  // 中文2-gram
  const cn = clean.replace(/[a-zA-Z0-9\s]/g, '')
  for (let i = 0; i < cn.length - 1; i++) {
    const bigram = cn.slice(i, i + 2)
    if (!STOP_WORDS.has(bigram)) words.push(bigram)
  }
  // 去重，取前5个
  return [...new Set(words)].slice(0, 5)
}

// ── 数据加载 ──
async function loadAll() {
  loading.value = true
  try {
    const [fr, er] = await Promise.all([
      window.electronAPI?.memoryGetFacts?.(),
      window.electronAPI?.memoryGetEpisodes?.(),
    ])
    factsData.value = (fr?.facts || []).map((f, i) => ({
      id: `f_${i}`, type: 'fact',
      label: f.fact || f.content || String(f),
      tags: cleanTags(f.tags),
      created_at: f.created_at,
      confidence: f.confidence ?? 0.5,
    }))
    episodesData.value = (er?.episodes || []).map((e, i) => ({
      id: `e_${i}`, type: 'episode',
      label: e.content?.keyQuote || e.content?.topic || '',
      topic: e.content?.topic || '',
      timestamp: e.timestamp,
      date: e.timestamp ? formatDate(e.timestamp) : '',
    })).filter(e => e.label)
  } catch (e) { console.warn('[MemoryGraph] load error:', e) }
  loading.value = false
  buildGraph()
}

// ── 图谱构建（双层：标签聚类 + 事实卫星）──
function buildGraph() {
  const nodes = [], edges = [], tagMap = new Map()
  const facts = factsData.value
  const eps = episodesData.value

  // 归类事实到标签
  for (const f of facts) {
    let tags = f.tags || []
    if (tags.length === 0) tags = extractKeywords(f.label)
    f._tags = tags
    for (const t of tags) {
      if (!tagMap.has(t)) tagMap.set(t, [])
      tagMap.get(t).push(f)
    }
  }

  // 标签节点 + 标签→事实边
  for (const [tag, members] of tagMap) {
    if (members.length < 1) continue
    const tid = `t_${tag}`
    nodes.push({
      id: tid, type: 'tag', label: tag, tags: [], degree: members.length,
      _x: 0, _y: 0, _vx: 0, _vy: 0,
      _members: members,  // 该标签下的事实列表
    })
    for (const m of members) {
      edges.push({ source: tid, target: m.id, _type: 'member' })
    }
  }

  // 事实小节点（卫星）
  for (const f of facts) {
    nodes.push({ ...f, type: 'fact', _x: 0, _y: 0, _vx: 0, _vy: 0 })
  }

  // 标签↔标签边（共享事实 ≥ 2 则连线，粗细按共享数）
  const tagIds = [...tagMap.keys()]
  const seenPairs = new Set()
  for (let i = 0; i < tagIds.length; i++) {
    for (let j = i + 1; j < tagIds.length; j++) {
      const a = new Set(tagMap.get(tagIds[i]).map(f => f.id))
      const b = new Set(tagMap.get(tagIds[j]).map(f => f.id))
      let shared = 0
      for (const id of a) { if (b.has(id)) shared++ }
      if (shared >= 2) {
        const key = `t_${tagIds[i]}|t_${tagIds[j]}`
        if (!seenPairs.has(key)) {
          seenPairs.add(key)
          edges.push({ source: `t_${tagIds[i]}`, target: `t_${tagIds[j]}`, _type: 'tagLink', _shared: shared })
        }
      }
    }
  }

  // 情景节点
  for (const e of eps) {
    nodes.push({ ...e, type: 'episode', _x: 0, _y: 0, _vx: 0, _vy: 0, tags: [] })
    if (e.topic) {
      const tids = [...tagMap.keys()]
      const match = tids.find(t => t.includes(e.topic) || e.topic.includes(t))
      if (match) edges.push({ source: `t_${match}`, target: e.id, _type: 'member' })
    }
  }

  // 无标签的事实（归不到任何标签的）互相弱连
  const orphans = facts.filter(f => !f._tags?.length)
  for (let i = 0; i < orphans.length; i++) {
    for (let j = i + 1; j < orphans.length; j++) {
      edges.push({ source: orphans[i].id, target: orphans[j].id, _type: 'orphan' })
    }
  }

  graphNodes.value = nodes
  graphEdges.value = edges
  selectedNode.value = null
  if (activeTab.value === 'graph') nextTick(() => restartForce())
}

// ── 搜索 ──
function onSearch() {
  const q = (searchQuery.value || '').toLowerCase().trim()
  if (!q) { loadAll(); return }
  // 客户端过滤
  const origFacts = factsData.value.length
  const baseFacts = factsData.value.filter(f =>
    f.label.toLowerCase().includes(q) ||
    (f.tags || []).some(t => t.toLowerCase().includes(q)))
  const baseEps = episodesData.value.filter(e =>
    e.label.toLowerCase().includes(q) || (e.topic || '').toLowerCase().includes(q))
  factsData.value = baseFacts
  episodesData.value = baseEps
  buildGraph()
}

// ═══════════════════════════════════════
// 力导向布局（带自动启停）
// ═══════════════════════════════════════
let forceRunning = false, forceRaf = null, forceSettled = false
let settleCheck = 0
const canvasWrap = ref(null), graphCanvas = ref(null)
let _draggedNode = null   // 当前被拖拽的节点（物理循环跳过它）

function stopForce() {
  forceRunning = false
  if (forceRaf) { cancelAnimationFrame(forceRaf); forceRaf = null }
}

function restartForce() {
  stopForce()
  const nodes = graphNodes.value
  if (nodes.length === 0) return
  fitCanvas()
  const wrap = canvasWrap.value
  const W = wrap?.clientWidth || 700, H = wrap?.clientHeight || 500
  const cx = W / 2, cy = H / 2
  const radius = Math.min(W, H) * 0.35

  // 环形初始布局 — 避免节点堆叠
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n._x === 0 && n._y === 0) {
      const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2
      n._x = cx + Math.cos(angle) * radius * (0.85 + Math.random() * 0.3)
      n._y = cy + Math.sin(angle) * radius * (0.85 + Math.random() * 0.3)
    }
    n._vx = 0; n._vy = 0
  }

  forceSettled = false; settleCheck = 0
  forceRunning = true
  forceLoop()
}

function forceLoop() {
  if (!forceRunning) return
  const nodes = graphNodes.value, edges = graphEdges.value
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const wrap = canvasWrap.value
  if (!wrap) { forceRaf = requestAnimationFrame(forceLoop); return }
  const W = wrap.clientWidth, H = wrap.clientHeight

  const repel = 250, damp = 0.9, centering = 0.0005
  let maxSpeed = 0

  // 排斥力 — 跳过拖拽节点
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i] === _draggedNode) continue
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[j] === _draggedNode) continue
      const dx = nodes[i]._x - nodes[j]._x, dy = nodes[i]._y - nodes[j]._y
      const dist = Math.max(30, Math.sqrt(dx * dx + dy * dy))
      // 标签↔标签之间排斥更强（防连线重叠）
      const bothTags = nodes[i].type === 'tag' && nodes[j].type === 'tag'
      const bothFacts = nodes[i].type === 'fact' && nodes[j].type === 'fact'
      let factor = 1;
      if (bothTags) factor = 3;       // 标签之间强力排斥
      else if (bothFacts) factor = 1.5; // 事实之间中等排斥
      const f = repel * factor / (dist * dist)
      nodes[i]._vx += (dx / dist) * f; nodes[i]._vy += (dy / dist) * f
      nodes[j]._vx -= (dx / dist) * f; nodes[j]._vy -= (dy / dist) * f
    }
  }

  // 引力
  for (const e of edges) {
    const s = nodeMap.get(typeof e.source === 'string' ? e.source : e.source?.id)
    const t = nodeMap.get(typeof e.target === 'string' ? e.target : e.target?.id)
    if (!s || !t) continue
    const dx = t._x - s._x, dy = t._y - s._y
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy))

    if (e._type === 'member') {
      // 事实被标签吸引（强力，近距离）
      const ideal = 65
      const f = (dist - ideal) * 0.008
      const tg = s.type === 'tag' ? s : t
      const fc = s.type === 'fact' ? s : t
      if (tg !== _draggedNode) { tg._vx += (dx / dist) * f * 0.3; tg._vy += (dy / dist) * f * 0.3 }
      if (fc !== _draggedNode) { fc._vx -= (dx / dist) * f * 0.7; fc._vy -= (dy / dist) * f * 0.7 }
    } else if (e._type === 'tagLink') {
      // 标签↔标签引力，按共享强度
      const shared = e._shared || 2
      const ideal = 140 + shared * 15
      const f = (dist - ideal) * 0.002 * shared
      if (s !== _draggedNode) { s._vx += (dx / dist) * f; s._vy += (dy / dist) * f }
      if (t !== _draggedNode) { t._vx -= (dx / dist) * f; t._vy -= (dy / dist) * f }
    } else {
      const ideal = 90
      const f = (dist - ideal) * 0.002
      if (s !== _draggedNode) { s._vx += (dx / dist) * f; s._vy += (dy / dist) * f }
      if (t !== _draggedNode) { t._vx -= (dx / dist) * f; t._vy -= (dy / dist) * f }
    }
  }

  const cx = W / 2, cy = H / 2
  for (const n of nodes) {
    if (n === _draggedNode) { n._vx = 0; n._vy = 0; continue }
    n._vx += (cx - n._x) * centering
    n._vy += (cy - n._y) * centering
    n._vx *= damp; n._vy *= damp
    n._x += n._vx; n._y += n._vy
    n._x = Math.max(30, Math.min(W - 30, n._x))
    n._y = Math.max(30, Math.min(H - 30, n._y))
    const spd = Math.sqrt(n._vx * n._vx + n._vy * n._vy)
    if (spd > maxSpeed) maxSpeed = spd
  }

  drawGraph()

  if (maxSpeed < 0.3) {
    settleCheck++
    if (settleCheck > 90) { forceSettled = true; forceRunning = false; return }
  } else {
    settleCheck = Math.max(0, settleCheck - 3)
  }
  forceRaf = requestAnimationFrame(forceLoop)
}

// ═══════════════════════════════════════
// Canvas 绘制（精致版）
// ═══════════════════════════════════════
let viewX = 0, viewY = 0, viewScale = 1
const NODE_R = { tag: 14, fact: 4, episode: 7 }

function fitCanvas() {
  const canvas = graphCanvas.value, wrap = canvasWrap.value
  if (!canvas || !wrap) return
  const dpr = devicePixelRatio || 1
  canvas.width = wrap.clientWidth * dpr
  canvas.height = wrap.clientHeight * dpr
  canvas.style.width = wrap.clientWidth + 'px'
  canvas.style.height = wrap.clientHeight + 'px'
}

function drawGraph() {
  const canvas = graphCanvas.value, nodes = graphNodes.value, edges = graphEdges.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const dpr = devicePixelRatio || 1
  const W = canvas.width / dpr, H = canvas.height / dpr

  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)

  // 背景微点阵
  ctx.fillStyle = 'rgba(0,0,0,0.025)'
  const dotGap = 36
  for (let x = (viewX % dotGap + dotGap) % dotGap; x < W; x += dotGap) {
    for (let y = (viewY % dotGap + dotGap) % dotGap; y < H; y += dotGap) {
      ctx.fillRect(x, y, 1, 1)
    }
  }

  ctx.save()
  ctx.translate(viewX, viewY)
  ctx.scale(viewScale, viewScale)

  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const selId = selectedNode.value?.id

  // ── 边（直线，无重叠）──
  for (const e of edges) {
    const s = nodeMap.get(typeof e.source === 'string' ? e.source : e.source?.id)
    const t = nodeMap.get(typeof e.target === 'string' ? e.target : e.target?.id)
    if (!s || !t) continue
    const highlighted = selId && (s.id === selId || t.id === selId)

    if (e._type === 'member') {
      ctx.strokeStyle = `rgba(148,163,255,${highlighted ? 0.35 : 0.08})`
      ctx.lineWidth = highlighted ? 1 : 0.4
      ctx.setLineDash([2, 4])
    } else if (e._type === 'tagLink') {
      const shared = e._shared || 2
      ctx.strokeStyle = `rgba(148,163,255,${highlighted ? 0.4 : 0.1 + shared * 0.03})`
      ctx.lineWidth = highlighted ? 2 : 0.8 + shared * 0.2
      ctx.setLineDash([])
    } else {
      ctx.strokeStyle = 'rgba(148,163,255,0.05)'
      ctx.lineWidth = 0.4
      ctx.setLineDash([])
    }
    ctx.beginPath()
    ctx.moveTo(s._x, s._y)
    ctx.lineTo(t._x, t._y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // ── 事实小点 ──
  for (const n of nodes) {
    if (n.type !== 'fact') continue
    const r = NODE_R.fact
    const color = nodeColor('fact')
    const isSel = selId === n.id
    ctx.fillStyle = isSel ? color : color + '40'
    ctx.beginPath(); ctx.arc(n._x, n._y, r, 0, Math.PI * 2); ctx.fill()
    if (isSel) {
      ctx.fillStyle = '#fff'; ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'center'
      ctx.fillText((n.label || '').slice(0, 18), n._x, n._y - 10)
    }
  }

  // ── 标签节点（纯色，无光晕） ──
  for (const n of nodes) {
    if (n.type !== 'tag') continue
    const r = NODE_R.tag + Math.min((n.degree || 0), 6)
    const color = nodeColor('tag')
    const isSel = selId === n.id

    // 主体纯色填充
    ctx.fillStyle = color + (isSel ? 'cc' : '88')
    ctx.beginPath(); ctx.arc(n._x, n._y, r, 0, Math.PI * 2); ctx.fill()

    // 选中虚线环
    if (isSel) {
      ctx.strokeStyle = color + '88'
      ctx.lineWidth = 1.5
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.arc(n._x, n._y, r + 4, 0, Math.PI * 2); ctx.stroke()
      ctx.setLineDash([])
    }

    // 标签名
    const label = (n.label || '').slice(0, 8)
    ctx.fillStyle = isSel ? '#fff' : 'rgba(220,224,240,0.8)'
    ctx.font = `${isSel ? '600 ' : ''}10.5px Inter, sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.fillText(label, n._x, n._y + r + 6)

    // 计数（小字右下方）
    if (n.degree > 1) {
      ctx.fillStyle = color + '55'
      ctx.font = '9px Inter, sans-serif'
      ctx.fillText(n.degree, n._x + r - 2, n._y + r - 2)
    }
  }

  // ── 情景节点 ──
  for (const n of nodes) {
    if (n.type !== 'episode') continue
    const r = NODE_R.episode
    ctx.fillStyle = nodeColor('episode') + '55'
    ctx.beginPath(); ctx.arc(n._x, n._y, r, 0, Math.PI * 2); ctx.fill()
  }

  ctx.restore()

  if (nodes.length > 0) {
    ctx.fillStyle = 'rgba(148,152,168,0.2)'
    ctx.font = '10px Inter, system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(`${Math.round(viewScale * 100)}%`, W - 12, H - 12)
  }

  ctx.restore()
}

// ── 交互 ──
let _mouseDown = false, _mouseOnNode = null, _mouseMoved = false
let _downWorldX = 0, _downWorldY = 0
let isPanning = false, panStartX = 0, panStartY = 0

function canvasToWorld(cx, cy) {
  const canvas = graphCanvas.value
  if (!canvas) return { x: cx, y: cy }
  const W = canvas.width / (devicePixelRatio || 1), H = canvas.height / (devicePixelRatio || 1)
  const midX = W / 2, midY = H / 2
  return {
    x: (cx - midX) / viewScale + midX - viewX / viewScale,
    y: (cy - midY) / viewScale + midY - viewY / viewScale,
  }
}

function hitTest(wx, wy) {
  const nodes = graphNodes.value
  for (const n of nodes) {
    const r = (NODE_R[n.type] || 14) + 8
    const dx = n._x - wx, dy = n._y - wy
    if (Math.sqrt(dx * dx + dy * dy) < r) return n
  }
  return null
}

function onCanvasMouseDown(e) {
  const rect = graphCanvas.value?.getBoundingClientRect()
  if (!rect) return
  const mx = e.clientX - rect.left, my = e.clientY - rect.top
  const world = canvasToWorld(mx, my)
  const hit = hitTest(world.x, world.y)
  _mouseDown = true
  _mouseMoved = false
  _mouseOnNode = hit
  _downWorldX = world.x; _downWorldY = world.y
  if (!hit) {
    isPanning = true; panStartX = e.clientX; panStartY = e.clientY
  }
}

function onCanvasMouseMove(e) {
  const rect = graphCanvas.value?.getBoundingClientRect()
  if (!rect) return
  const mx = e.clientX - rect.left, my = e.clientY - rect.top

  if (isPanning) {
    viewX += e.clientX - panStartX; viewY += e.clientY - panStartY
    panStartX = e.clientX; panStartY = e.clientY
    if (forceSettled) drawGraph()
    return
  }

  if (_mouseDown && _mouseOnNode) {
    const world = canvasToWorld(mx, my)
    const dx = Math.abs(world.x - _downWorldX), dy = Math.abs(world.y - _downWorldY)
    // 移动超过阈值才进入拖拽模式
    if (!_mouseMoved && (dx > 5 || dy > 5)) {
      _mouseMoved = true
      _draggedNode = _mouseOnNode
      if (forceSettled) { forceSettled = false; settleCheck = 0; forceRunning = true; forceLoop() }
    }
    if (_mouseMoved) {
      _mouseOnNode._x = world.x; _mouseOnNode._y = world.y
      if (!forceRunning) drawGraph()
    }
    return
  }

  // hover 检测
  if (!_mouseDown) {
    const world = canvasToWorld(mx, my)
    const h = hitTest(world.x, world.y)
    const canvas = graphCanvas.value
    if (canvas) canvas.style.cursor = h ? 'pointer' : 'grab'
  }
}

function onCanvasMouseUp(e) {
  if (_mouseDown && _mouseOnNode && !_mouseMoved) {
    // 纯点击 → 选中
    selectedNode.value = _mouseOnNode
  }
  _mouseDown = false; _mouseOnNode = null; _mouseMoved = false
  _draggedNode = null
  isPanning = false
}

function onCanvasWheel(e) {
  e.preventDefault()
  const delta = e.deltaY > 0 ? 0.9 : 1.1
  viewScale = Math.max(0.2, Math.min(3, viewScale * delta))
  const rect = graphCanvas.value?.getBoundingClientRect()
  if (!rect) return
  const mx = e.clientX - rect.left, my = e.clientY - rect.top
  viewX = mx - (mx - viewX) * delta
  viewY = my - (my - viewY) * delta
  if (forceSettled) drawGraph()
}

function onCanvasDblClick() {
  viewX = 0; viewY = 0; viewScale = 1
  if (forceSettled) drawGraph()
}

// ── 全局 mouseup（防止拖出 canvas 后状态残留）──
function onGlobalMouseUp() {
  _mouseDown = false; _mouseOnNode = null; _mouseMoved = false
  _draggedNode = null; isPanning = false
}
window.addEventListener('mouseup', onGlobalMouseUp)

// ── 监听 tab 切换 —— 切回图谱时重启 ──
watch(activeTab, (val) => {
  if (val === 'graph') nextTick(() => restartForce())
  else stopForce()
})

// ── 时间线 ──
const timelineItems = computed(() => {
  const all = [
    ...factsData.value.map(f => ({
      type: 'fact', label: f.label, tags: f.tags,
      ts: f.created_at || 0, time: formatDate(f.created_at),
      date: f.created_at ? formatDate(f.created_at).split(' ')[0] : '未知',
    })),
    ...episodesData.value.map(e => ({
      type: 'episode', label: e.label, tags: [e.topic].filter(Boolean),
      ts: e.timestamp || 0, time: e.date || '',
      date: e.timestamp ? formatDate(e.timestamp).split(' ')[0] : '未知',
    })),
  ].sort((a, b) => (b.ts || 0) - (a.ts || 0))

  const groups = new Map()
  for (const item of all) {
    const d = item.date
    if (!groups.has(d)) groups.set(d, [])
    groups.get(d).push(item)
  }
  return [...groups.entries()].map(([date, items]) => ({ date, items }))
})

function selectTimelineItem(item) {
  // 跳转到图谱并选中对应节点
  activeTab.value = 'graph'
  nextTick(() => {
    const node = graphNodes.value.find(n => n.label === item.label && n.type === item.type)
    if (node) selectedNode.value = node
  })
}

// ── 统计 ──
const stats = computed(() => {
  const facts = factsData.value, eps = episodesData.value
  const tags = new Set()
  for (const f of facts) { for (const t of f.tags || []) tags.add(t) }

  // 置信度分桶
  const buckets = [
    { label: '高 (>0.8)', min: 0.8, color: '#34C759' },
    { label: '中 (0.5-0.8)', min: 0.5, color: '#6d7cff' },
    { label: '低 (0.3-0.5)', min: 0.3, color: '#FF9500' },
    { label: '很低 (<0.3)', min: 0, color: '#FF3B30' },
  ].map(b => {
    const count = facts.filter(f => (f.confidence ?? 0.5) >= b.min && (f.confidence ?? 0.5) < (b.min + 0.3 || 1.1)).length
    const max = Math.max(1, ...facts.map(f => f.confidence ?? 0.5))
    return { ...b, count, pct: facts.length ? Math.round(count / facts.length * 100) : 0 }
  })

  // 时间衰减曲线
  const now = Date.now()
  const decayPoints = [0, 30, 90, 180].map(days => {
    const cutoff = now - days * 86400000
    const count = facts.filter(f => (f.created_at || 0) > cutoff).length
    return { days, count }
  })
  const maxCount = Math.max(1, ...decayPoints.map(d => d.count))
  const decayLine = decayPoints.map((d, i) => `${i * 100},${100 - (d.count / maxCount) * 80}`).join(' ')
  const decayPts = decayPoints.map((d, i) => ({ x: i * 100, y: 100 - (d.count / maxCount) * 80 }))

  // 标签频率
  const tagFreq = new Map()
  for (const f of facts) {
    for (const t of f.tags || []) tagFreq.set(t, (tagFreq.get(t) || 0) + 1)
  }
  const maxFreq = Math.max(1, ...tagFreq.values())
  const topTags = [...tagFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([name, count]) => ({ name, count, weight: count / maxFreq }))

  return {
    totalFacts: facts.length,
    totalEpisodes: eps.length,
    totalTags: tags.size,
    totalEdges: graphEdges.value.length,
    confidenceBuckets: buckets,
    decayData: decayPoints,
    decayLine,
    decayPoints: decayPts,
    topTags,
  }
})

// ── 生命周期 ──
let resizeObs = null
onMounted(async () => {
  await loadAll()
  nextTick(() => {
    fitCanvas()
    if (activeTab.value === 'graph') restartForce()
    resizeObs = new ResizeObserver(() => {
      fitCanvas()
      if (activeTab.value === 'graph') {
        if (forceSettled) drawGraph()
      }
    })
    if (canvasWrap.value) resizeObs.observe(canvasWrap.value)
  })
})

onUnmounted(() => {
  stopForce()
  resizeObs?.disconnect()
  window.removeEventListener('mouseup', onGlobalMouseUp)
})
</script>

<style scoped>
/* ═══ 根容器 ═══ */
.mgp-root {
  flex: 1; display: flex; flex-direction: column;
  background: var(--bg);
  overflow: hidden;
  animation: mgpFadeIn .4s cubic-bezier(.16,1,.3,1);
}
@keyframes mgpFadeIn { from { opacity: 0; transform: translateY(8px); } }

/* ═══ 顶栏 ═══ */
.mgp-topbar {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.mgp-tabs { display: flex; gap: 2px; }
.mgp-tab {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 14px; border: none; border-radius: 8px;
  background: none; color: var(--text-muted); font-size: 12px;
  cursor: pointer; transition: all .2s ease;
  font-family: var(--font-body);
}
.mgp-tab:hover { background: var(--bg-sidebar-hover); color: var(--text-secondary); }
.mgp-tab.active { background: var(--accent-soft); color: var(--accent-light); font-weight: 500; }

.mgp-search { flex: 1; position: relative; max-width: 280px; }
.mgp-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-muted); }
.mgp-search-input {
  width: 100%; padding: 6px 30px 6px 32px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-input); color: var(--text-primary);
  font-size: 12px; font-family: var(--font-body);
  outline: none; transition: border-color .2s;
}
.mgp-search-input:focus { border-color: var(--accent); }
.mgp-search-input::placeholder { color: var(--text-muted); }
.mgp-search-clear {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  border: none; background: none; color: var(--text-muted); cursor: pointer;
  font-size: 14px; line-height: 1;
}

.mgp-refresh {
  padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px;
  background: none; color: var(--text-muted); cursor: pointer;
  transition: all .2s;
}
.mgp-refresh:hover { background: var(--bg-input); color: var(--text-secondary); }
.mgp-refresh:disabled { opacity: .5; }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ═══ 主区域 ═══ */
.mgp-main { flex: 1; display: flex; min-height: 0; overflow: hidden; }

/* ═══ 画布 ═══ */
.mgp-canvas-wrap {
  flex: 1; position: relative; overflow: hidden;
  background: radial-gradient(ellipse at center, var(--bg-card) 0%, var(--bg) 80%);
  cursor: grab;
}
.mgp-canvas-wrap:active { cursor: grabbing; }
.mgp-canvas-wrap canvas { display: block; }

.mgp-legend {
  position: absolute; bottom: 12px; left: 12px;
  display: flex; align-items: center; gap: 12px;
  font-size: 10px; color: var(--text-muted);
}
.mgp-legend i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; }
.mgp-legend-hint { opacity: .5; margin-left: 8px; }

.mgp-empty {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  color: var(--text-muted); gap: 8px; pointer-events: none;
}
.mgp-empty p { font-size: 14px; margin: 0; }
.mgp-empty span { font-size: 11px; opacity: .6; }

/* ═══ 详情面板 ═══ */
.mgp-detail {
  width: 220px; border-left: 1px solid var(--border);
  background: var(--bg-card); display: flex; flex-direction: column; flex-shrink: 0;
}
.mgp-detail-head {
  display: flex; align-items: center; padding: 12px; gap: 8px;
  border-left: 3px solid; border-bottom: 1px solid var(--border);
}
.mgp-detail-type { font-size: 10px; padding: 2px 8px; border-radius: 4px; color: #fff; }
.mgp-detail-close { margin-left: auto; border: none; background: none; color: var(--text-muted); cursor: pointer; font-size: 16px; }
.mgp-detail-body { padding: 14px; flex: 1; overflow-y: auto; }
.mgp-detail-text { font-size: 13px; line-height: 1.7; color: var(--text-primary); margin: 0 0 10px; word-break: break-word; }
.mgp-detail-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.mgp-tag { padding: 2px 8px; border-radius: 10px; background: var(--bg-input); font-size: 10px; color: var(--text-secondary); }
.mgp-detail-stats { font-size: 11px; color: var(--text-muted); margin-bottom: 4px; }
.mgp-detail-date { font-size: 10px; color: var(--text-muted); opacity: .6; }
.mgp-members { margin-bottom: 8px; }
.mgp-members-title { font-size: 10px; color: var(--text-muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .5px; }
.mgp-member-item {
  padding: 5px 8px; margin-bottom: 3px; border-radius: 6px;
  font-size: 11px; line-height: 1.4; color: var(--text-secondary);
  cursor: pointer; background: var(--bg-input);
  transition: all .15s;
}
.mgp-member-item:hover { background: var(--accent-soft); color: var(--text-primary); }

/* 详情滑入 */
.detail-slide-enter-active { transition: all .25s cubic-bezier(.16,1,.3,1); }
.detail-slide-leave-active { transition: all .2s ease; }
.detail-slide-enter-from { transform: translateX(100%); opacity: 0; }
.detail-slide-leave-to { transform: translateX(100%); opacity: 0; }

/* ═══ 时间线 ═══ */
.mgp-timeline { flex: 1; overflow-y: auto; padding: 20px 24px; }
.mgp-tl-track { max-width: 600px; margin: 0 auto; }
.mgp-tl-group { margin-bottom: 24px; }
.mgp-tl-date-badge {
  font-size: 11px; font-weight: 600; color: var(--text-muted);
  padding: 4px 10px; margin-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.mgp-tl-cards { display: flex; flex-direction: column; gap: 6px; }
.mgp-tl-card {
  display: flex; gap: 12px; padding: 10px 14px;
  border-radius: 10px; cursor: pointer;
  background: var(--bg-card); border: 1px solid var(--border);
  transition: all .2s ease;
}
.mgp-tl-card:hover { border-color: var(--border-strong); transform: translateX(4px); }
.mgp-tl-card:active { transform: scale(.99); }
.mgp-tl-card-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; flex-shrink: 0; }
.mgp-tl-card-content { flex: 1; min-width: 0; }
.mgp-tl-card-text { font-size: 13px; line-height: 1.5; color: var(--text-primary); margin: 0 0 4px; }
.mgp-tl-card-meta { display: flex; align-items: center; gap: 8px; }
.mgp-tl-tags { display: flex; gap: 3px; }
.mgp-tl-time { font-size: 10px; color: var(--text-muted); margin-left: auto; }

.tl-card-enter-active { transition: all .3s ease; }
.tl-card-leave-active { transition: all .2s ease; }
.tl-card-enter-from { opacity: 0; transform: translateX(-12px); }
.tl-card-leave-to { opacity: 0; transform: translateX(12px); }

/* ═══ 统计 ═══ */
.mgp-stats { flex: 1; overflow-y: auto; padding: 20px 24px; }
.mgp-stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
.mgp-stat-card {
  padding: 18px; border-radius: 12px; background: var(--bg-card);
  border: 1px solid var(--border); text-align: center;
  transition: all .25s ease;
}
.mgp-stat-card:hover { transform: translateY(-2px); border-color: var(--border-strong); }
.mgp-stat-icon { color: var(--text-muted); margin-bottom: 8px; }
.mgp-stat-val { font-size: 28px; font-weight: 600; color: var(--text-primary); font-family: var(--font-display); }
.mgp-stat-label { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

.mgp-stat-section { margin-bottom: 24px; }
.mgp-stat-section h4 {
  font-size: 13px; font-weight: 600; color: var(--text-secondary);
  margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border);
}

/* 柱状图 */
.mgp-bar-chart { display: flex; flex-direction: column; gap: 8px; }
.mgp-bar-row { display: flex; align-items: center; gap: 10px; }
.mgp-bar-label { font-size: 11px; color: var(--text-muted); width: 70px; text-align: right; flex-shrink: 0; }
.mgp-bar-track { flex: 1; height: 8px; border-radius: 4px; background: var(--bg-input); overflow: hidden; }
.mgp-bar-fill { height: 100%; border-radius: 4px; transition: width .6s cubic-bezier(.16,1,.3,1); }
.mgp-bar-count { font-size: 11px; color: var(--text-secondary); width: 30px; font-weight: 500; }

/* 衰减曲线 */
.mgp-decay-chart { padding: 8px 0; }
.mgp-decay-svg { width: 100%; height: 100px; }
.mgp-decay-labels { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted); }

/* 标签云 */
.mgp-tag-cloud { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 0; }
.mgp-cloud-tag {
  color: var(--accent-light); transition: all .2s; cursor: default;
}
.mgp-cloud-tag:hover { color: var(--accent-bright); transform: scale(1.1); }
</style>

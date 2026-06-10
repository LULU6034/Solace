<template>
  <div class="mg-backdrop" @click.self="$emit('close')">
    <div class="mg-panel" @click.stop>
      <div class="mg-header">
        <h2>Memory Graph</h2>
        <span class="mg-stats">{{ nodes.length }} nodes &middot; {{ links.length }} links</span>
        <button class="mg-close" @click="$emit('close')">&times;</button>
      </div>
      <div class="mg-body">
        <div ref="canvasEl" class="mg-canvas">
          <svg ref="svgEl" class="mg-svg"></svg>
          <div v-if="nodes.length === 0" class="mg-empty-hint">
            <p>Chat more to see your memory graph here.</p>
            <p class="mg-empty-sub">Agent will automatically extract facts and topic tags about you.</p>
          </div>
        </div>
        <div class="mg-detail" v-if="selectedNode">
          <div class="mg-detail-header" :style="{ borderColor: catColor(selectedNode.type) }">
            <span class="mg-detail-type" :style="{ background: catColor(selectedNode.type) }">{{ catLabel(selectedNode.type) }}</span>
            <button class="mg-detail-close" @click="selectedNode = null">&times;</button>
          </div>
          <div class="mg-detail-content">
            <p class="mg-detail-text">{{ selectedNode.label }}</p>
            <div class="mg-detail-meta" v-if="selectedNode.tags">
              <span class="mg-tag" v-for="t in selectedNode.tags" :key="t">{{ t }}</span>
            </div>
            <p class="mg-detail-sub" v-if="selectedNode.degree">Linked to {{ selectedNode.degree }} nodes</p>
          </div>
        </div>
        <div class="mg-empty-detail" v-else>
          <p>Click a node to view details</p>
        </div>
      </div>
      <div class="mg-footer">
        <span class="mg-legend-item"><i style="background:#9aa8ff"></i> Facts</span>
        <span class="mg-legend-item"><i style="background:#F59E0B"></i> Episodes</span>
        <span class="mg-legend-item"><i style="background:#10B981"></i> Topics</span>
        <button class="mg-refresh" @click="loadData">Refresh</button>
      </div>
    </div>
  </div>
</template>

<script setup>
const emit = defineEmits(['close'])
import { ref, nextTick, onMounted, onUnmounted } from 'vue'

const canvasEl = ref(null)
const svgEl = ref(null)
const selectedNode = ref(null)
const nodes = ref([])
const links = ref([])

const COLORS = { fact: '#9aa8ff', episode: '#F59E0B', topic: '#10B981' }
const catColor = t => COLORS[t] || '#888'
const catLabel = t => ({ fact: 'Fact', episode: 'Episode', topic: 'Topic' }[t] || t)

onMounted(() => { loadData(); window.addEventListener('resize', draw) })
onUnmounted(() => window.removeEventListener('resize', draw))

async function loadData() {
  const allNodes = []
  const allLinks = []
  const topicSet = new Map()

  try {
    const r = await window.electronAPI?.agentMemoryGetFacts?.()
    const facts = r?.facts || []
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i]
      const label = typeof f === 'string' ? f : (f.fact || f.content || String(f))
      if (!label) continue
      const tags = f.tags || []
      allNodes.push({ id: `f_${i}`, type: 'fact', label, tags })
      for (const tag of tags) {
        if (!topicSet.has(tag)) topicSet.set(tag, [])
        topicSet.get(tag).push(`f_${i}`)
      }
    }
  } catch (e) { console.warn(e) }

  try {
    const r = await window.electronAPI?.agentMemoryGetEpisodes?.()
    const episodes = r?.episodes || []
    for (let i = 0; i < episodes.length; i++) {
      const e = episodes[i]
      const label = e.content?.keyQuote || e.content?.topic || e.label || ''
      if (!label) continue
      allNodes.push({ id: `e_${i}`, type: 'episode', label, date: e.timestamp })
    }
  } catch (e) { console.warn(e) }

  for (const [tag, refs] of topicSet) {
    if (refs.length >= 1) {
      const tid = `t_${tag}`
      allNodes.push({ id: tid, type: 'topic', label: tag, degree: refs.length })
      for (const rid of refs) allLinks.push({ source: tid, target: rid })
    }
  }

  nodes.value = allNodes
  links.value = allLinks
  await nextTick()
  draw()
}

function draw() {
  const svg = svgEl.value
  if (!svg || !canvasEl.value) return
  const W = canvasEl.value.clientWidth || 600
  const H = canvasEl.value.clientHeight || 400
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.innerHTML = ''

  const ns = 'http://www.w3.org/2000/svg'
  const list = nodes.value
  if (list.length === 0) return

  const cx = W / 2, cy = H / 2
  const r = Math.min(W, H) * 0.38
  list.forEach((n, i) => {
    const a = (i / list.length) * Math.PI * 2 - Math.PI / 2
    n._x = cx + Math.cos(a) * r
    n._y = cy + Math.sin(a) * r
  })

  for (const l of links.value) {
    const sid = l.source?.id || l.source
    const tid = l.target?.id || l.target
    const s = list.find(n => n.id === sid)
    const t = list.find(n => n.id === tid)
    if (!s?._x || !t?._x) continue
    const line = document.createElementNS(ns, 'line')
    line.setAttribute('x1', s._x); line.setAttribute('y1', s._y)
    line.setAttribute('x2', t._x); line.setAttribute('y2', t._y)
    line.setAttribute('stroke', 'var(--border)')
    line.setAttribute('stroke-width', '1.5')
    line.setAttribute('opacity', '0.35')
    svg.appendChild(line)
  }

  for (const n of list) {
    if (n._x == null) continue
    const g = document.createElementNS(ns, 'g')
    g.setAttribute('transform', `translate(${n._x},${n._y})`)
    g.style.cursor = 'pointer'; g.addEventListener('click', () => { selectedNode.value = n })

    const rr = n.type === 'topic' ? 22 : 16
    const c = document.createElementNS(ns, 'circle')
    c.setAttribute('r', rr); c.setAttribute('fill', catColor(n.type))
    c.setAttribute('fill-opacity', '0.18'); c.setAttribute('stroke', catColor(n.type)); c.setAttribute('stroke-width', '2')
    g.appendChild(c)

    const t = document.createElementNS(ns, 'text')
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('dy', rr + 17)
    t.setAttribute('fill', 'var(--text-primary)'); t.setAttribute('font-size', '12')
    t.textContent = (n.label || '?').slice(0, 12) + ((n.label || '').length > 12 ? '...' : '')
    g.appendChild(t)

    const title = document.createElementNS(ns, 'title'); title.textContent = n.label; g.appendChild(title)
    svg.appendChild(g)
  }
}
</script>

<style scoped>
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

.mg-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.45); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; }
.mg-panel { width: 700px; max-width: 90vw; height: 520px; max-height: 85vh; background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; display: flex; flex-direction: column; box-shadow: 0 8px 40px rgba(0,0,0,0.15); animation: mgIn .25s var(--ease-out); }
@keyframes mgIn { from { opacity: 0; transform: scale(.95) translateY(6px); } }
.mg-header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.mg-header h2 { font-size: 15px; font-weight: 600; margin: 0; }
.mg-stats { font-size: 11px; color: var(--text-muted); }
.mg-close { margin-left: auto; width: 28px; height: 28px; border: none; background: none; color: var(--text-muted); font-size: 18px; cursor: pointer; border-radius: 6px; }
.mg-close:hover { background: var(--bg-input); }
.mg-body { flex: 1; display: flex; overflow: hidden; }
.mg-canvas { flex: 1; position: relative; }
.mg-svg { width: 100%; height: 100%; }
.mg-empty-hint { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
.mg-empty-hint p { font-size: 13px; color: var(--text-muted); margin: 0; }
.mg-empty-sub { font-size: 11px !important; margin-top: 6px !important; opacity: 0.6; }
.mg-detail, .mg-empty-detail { width: 190px; border-left: 1px solid var(--border); display: flex; flex-direction: column; }
.mg-empty-detail { align-items: center; justify-content: center; }
.mg-empty-detail p { font-size: 11px; color: var(--text-muted); }
.mg-detail-header { display: flex; align-items: center; padding: 10px; border-bottom: 2px solid; gap: 8px; }
.mg-detail-type { font-size: 10px; padding: 2px 8px; border-radius: 4px; color: #fff; }
.mg-detail-close { margin-left: auto; width: 22px; height: 22px; border: none; background: none; cursor: pointer; color: var(--text-muted); }
.mg-detail-content { padding: 12px; flex: 1; overflow-y: auto; }
.mg-detail-text { font-size: 12px; line-height: 1.6; color: var(--text-primary); margin: 0; }
.mg-detail-sub { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
.mg-detail-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.mg-tag { padding: 1px 6px; border-radius: 3px; background: var(--bg-input); font-size: 10px; color: var(--text-secondary); }
.mg-footer { display: flex; align-items: center; padding: 10px 18px; border-top: 1px solid var(--border); gap: 14px; }
.mg-legend-item { font-size: 10px; color: var(--text-muted); display: flex; align-items: center; gap: 5px; }
.mg-legend-item i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.mg-refresh { margin-left: auto; padding: 4px 12px; border: 1px solid var(--border); border-radius: 6px; background: none; font-size: 11px; cursor: pointer; color: var(--text-secondary); }
.mg-refresh:hover { background: var(--bg-input); }
</style>

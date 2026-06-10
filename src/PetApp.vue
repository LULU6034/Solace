<template>
  <canvas ref="canvas" :width="canvasW" :height="canvasH"
    style="display:block;cursor:grab;-webkit-app-region:no-drag;"
    @mousedown="onMouseDown"
    @contextmenu.prevent="showPetMenu"
    @mouseenter="hovering = true" @mouseleave="hovering = false"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop" />

  <div v-if="petMenuVisible" class="pet-menu-overlay" @click="petMenuVisible = false">
    <div class="pet-menu" :style="{ left: petMenuPos.x + 'px', top: petMenuPos.y + 'px' }">
      <div class="pet-menu-title">切换角色</div>
      <button v-for="(p, i) in petList" :key="p.id" class="pet-menu-item"
        :class="{ active: pet?.id === p.id }" @click="selectBuiltin(i)">
        <span class="pet-menu-icon">{{ p.icon }}</span>
        <span>{{ p.name }}</span>
      </button>
    </div>
  </div>

  <div v-if="bubbleVisible" class="bubble" :style="{ left: bubbleX + 'px', top: bubbleY + 'px' }">{{ bubbleText }}</div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { petList } from './pets/index.js'

const canvas = ref(null)
const hovering = ref(false), isDragOver = ref(false)
const LOGICAL_W = 280, LOGICAL_H = 210, canvasW = 280, canvasH = 210

let animId, time = 0, dt = 1/60
let pet = petList[0]

function selectBuiltin(i) { pet = petList[i]; petMenuVisible.value = false }

const IDLE_ACTIONS = ['none', 'bounce', 'look', 'wiggle', 'stretch']
const IDLE_DURATIONS = { bounce: 1.8, look: 2.5, wiggle: 1.2, stretch: 2.0 }
let isWalking = false, facingRight = true, isWorking = false, isEating = false
let eatStartTime = 0, wanderTimer = null, idleTimer = null
let idleAction = 'none', idleStartTime = 0, idleBlendPrev = 0
let isWatchingTV = false, tvStartTime = 0

function tick(now) {
  const t = now/1000; if (!time) time = t; dt = Math.min(0.1, t-time); time = t
  const c = canvas.value; if (!c) { animId = requestAnimationFrame(tick); return }
  const ctx = c.getContext('2d')
  if (isEating && time-eatStartTime > 1.4) isEating = false
  if (idleAction !== 'none' && time-idleStartTime > (IDLE_DURATIONS[idleAction]||1)) idleAction = 'none'
  idleBlendPrev = idleAction !== 'none' ? Math.min(1, idleBlendPrev+0.016/0.25) : Math.max(0, idleBlendPrev-0.016/0.2)
  const idleBlend = idleBlendPrev
  const eatPhase = isEating ? (time-eatStartTime)/1.4 : 0
  const idlePhase = idleAction !== 'none' ? (time-idleStartTime)/(IDLE_DURATIONS[idleAction]||1) : 0

  try {
    ctx.clearRect(0, 0, canvasW, canvasH)
    ctx.save()
    const s = Math.min(canvasW/LOGICAL_W, canvasH/LOGICAL_H); ctx.scale(s, s)
    const tvP = isWatchingTV ? Math.min(1, (time-tvStartTime)/0.7) : 0
    const tvE = 1 - Math.pow(1-Math.min(1,tvP), 2)
    ctx.save()
    if (tvE > 0) {
      ctx.translate(0, tvE*12)
      ctx.translate(LOGICAL_W/2, LOGICAL_H/2)
      ctx.scale(1+tvE*0.08, 1-tvE*0.18)
      ctx.translate(-LOGICAL_W/2, -(LOGICAL_H/2))
    }

    if (pet.drawFn) {
      pet.drawFn(ctx, LOGICAL_W, LOGICAL_H, time, {
        isWalking, facingRight, isEating, eatPhase,
        isRejecting: false, rejectPhase: 0,
        isDragOver: isDragOver.value, isWorking,
        idleAction, idlePhase, idleBlend,
        isWatchingTV, tvPhase: tvP,
      })
    }

    if (isWorking && !isWatchingTV) {
      const bx = facingRight ? LOGICAL_W-10 : 10
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.strokeStyle = 'rgba(0,0,0,0.1)'; ctx.lineWidth = 0.5
      ctx.beginPath(); try { ctx.roundRect(bx-20, 15, 40, 16, 6) } catch { ctx.rect(bx-20, 15, 40, 16) }
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = '#333'; ctx.font = '8px Inter'; ctx.textAlign = 'center'; ctx.fillText('生成中', bx, 27)
    }
    ctx.restore()
    if (isWatchingTV) {
      ctx.save(); ctx.globalAlpha = tvE*0.92
      ctx.fillStyle = '#1a1a2e'; ctx.fillRect(LOGICAL_W*0.2, LOGICAL_H*0.55, LOGICAL_W*0.6, LOGICAL_H*0.35)
      ctx.fillStyle = '#7c8aff'; ctx.font = '6px monospace'; ctx.textAlign = 'center'
      ctx.fillText('▮ CAT-TV', LOGICAL_W/2, LOGICAL_H*0.72)
      ctx.restore()
    }
    ctx.restore()
  } catch(e) {}
  animId = requestAnimationFrame(tick)
}

async function moveWindowBy(dx, dy) {
  if (typeof window.electronAPI?.moveWindow !== 'function') return
  isWalking = true; facingRight = dx >= 0
  await new Promise(r => setTimeout(r, 450))
  const steps = Math.max(2, Math.min(6, Math.round(Math.abs(dx)/22)))
  const stepX = Math.round(dx/steps)
  for (let i = 0; i < steps; i++) {
    await new Promise(r => setTimeout(r, 480))
    window.electronAPI.moveWindow(stepX, 0, false)
  }
  await new Promise(r => setTimeout(r, 250))
  isWalking = false
}

function scheduleWander() {
  clearTimeout(wanderTimer)
  wanderTimer = setTimeout(() => {
    if (!isWalking && !hovering.value && !isEating && !isWatchingTV) {
      const d = 40 + Math.random()*80
      moveWindowBy(Math.random() > 0.5 ? -d : d, 0)
    }
    scheduleWander()
  }, 3000+Math.random()*5000)
}

function scheduleIdleAction() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (!isWalking && !isEating && !isWatchingTV && idleAction === 'none') {
      idleAction = IDLE_ACTIONS[Math.floor(Math.random()*IDLE_ACTIONS.length)]
      idleStartTime = time
    }
    scheduleIdleAction()
  }, 4000+Math.random()*8000)
}

let isDragging = false, hasMoved = false, dragStartX = 0, dragStartY = 0
const DRAG_THRESHOLD = 4
function onMouseDown(e) { if (e.button !== 0) return; isDragging = true; hasMoved = false; dragStartX = e.clientX; dragStartY = e.clientY; document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', onMouseUp) }
function onMouseMove(e) { if (!isDragging) return; const dx = e.clientX-dragStartX, dy = e.clientY-dragStartY; if (!hasMoved && (Math.abs(dx)>DRAG_THRESHOLD || Math.abs(dy)>DRAG_THRESHOLD)) hasMoved = true; if (hasMoved) { dragStartX = e.clientX; dragStartY = e.clientY; window.electronAPI?.moveWindow(dx, dy, true) } }
function onMouseUp() { isDragging = false; document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp) }

const petMenuVisible = ref(false), petMenuPos = ref({ x: 0, y: 0 })
function showPetMenu(e) { petMenuPos.value = { x: e.clientX, y: e.clientY }; petMenuVisible.value = true }

const bubbleVisible = ref(false), bubbleText = ref(''), bubbleX = ref(0), bubbleY = ref(0)
let lastCommentFile = ''
function onDragEnter(e) { isDragOver.value = true; requestComment(e) }
function onDragOver(e) { isDragOver.value = true; bubbleX.value = e.clientX - (canvas.value?.getBoundingClientRect().left||0) - 40; bubbleY.value = e.clientY - (canvas.value?.getBoundingClientRect().top||0) - 60 }
function onDragLeave() { isDragOver.value = false; bubbleVisible.value = false }
function onDrop(e) { isDragOver.value = false; bubbleVisible.value = false; const f = e.dataTransfer?.files?.[0]; if (f) { window.electronAPI?.feedFile(f.path); isEating = true; eatStartTime = time } }
async function requestComment(e) { const f = e.dataTransfer?.files?.[0]; if (!f || f.name === lastCommentFile) return; lastCommentFile = f.name; bubbleText.value = '闻一闻…'; bubbleVisible.value = true; try { const r = await window.electronAPI?.fileComment(f.name); if (r?.comment) bubbleText.value = r.comment } catch { bubbleText.value = '哼！' } }

onMounted(() => {
  animId = requestAnimationFrame(tick); scheduleWander(); scheduleIdleAction()
  window.electronAPI?.onWorkingState?.(d => { isWorking = d.isWorking })
})
onUnmounted(() => { if (animId) cancelAnimationFrame(animId); clearTimeout(wanderTimer); clearTimeout(idleTimer) })
</script>

<style scoped>
.pet-menu-item { transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) !important; }
.pet-menu-item:hover { transform: translateY(-2px); }

canvas { image-rendering: pixelated; image-rendering: crisp-edges; }
.pet-menu-overlay { position: fixed; inset: 0; z-index: 999; }
.pet-menu { position: fixed; background: var(--bg,#1e1e2e); border: 1px solid var(--border,#333); border-radius: 10px; padding: 6px; min-width: 140px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); font-size: 12px; }
.pet-menu-title { color: var(--text-muted,#888); font-size: 10px; padding: 4px 8px 2px; text-transform: uppercase; }
.pet-menu-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px; border: none; background: none; color: var(--text,#ddd); cursor: pointer; border-radius: 6px; font-size: 12px; }
.pet-menu-item:hover { background: var(--bg-hover,#333); }
.pet-menu-item.active { background: var(--accent-soft,rgba(99,102,241,0.15)); color: var(--accent,#818cf8); }
.pet-menu-icon { font-size: 14px; }
.bubble { position: absolute; pointer-events: none; background: rgba(255,255,255,0.92); color: #333; padding: 6px 12px; border-radius: 10px; font-size: 13px; font-family: 'Microsoft YaHei',sans-serif; max-width: 200px; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.12); z-index: 10; animation: bIn .2s ease-out; }
.bubble::after { content: ''; position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 6px solid rgba(255,255,255,0.92); }
@keyframes bIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
</style>

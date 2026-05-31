<template>
  <canvas ref="canvas" :width="canvasW" :height="canvasH"
    style="display:block;cursor:grab;"
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
        :class="{ active: i === currentPetIdx }"
        @click="switchPet(i)">
        <span class="pet-menu-icon">{{ p.icon }}</span>
        <span>{{ p.name }}</span>
        <span v-if="i === currentPetIdx" class="pet-menu-check">✓</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { petList, getPet } from './pets/index.js'

const canvas = ref(null)
const hovering = ref(false)
const isDragOver = ref(false)
const LOGICAL_W = 280  // 原始设计尺寸，绘制函数以此为基准
const LOGICAL_H = 210
const canvasW = 140   // 实际窗口/画布尺寸（缩放后）
const canvasH = 110

let animId = null
let time = 0
let currentPetIdx = 0
let pet = petList[0]

let isWalking = false
let facingRight = true
let wanderTimer = null

// AI 工作状态（聊天窗口思考时宠物加速呼吸）
let isWorking = false

// 空闲看电视
let isWatchingTV = false
let tvStartTime = 0

let isEating = false
let eatStartTime = 0
const EAT_DURATION = 1.4

let isRejecting = false
let rejectStartTime = 0
const REJECT_DURATION = 0.5

// 屏幕右上方活动边界
let screenBounds = { left: 0, right: 1920, top: 0, bottom: 600 }

// 随机待机动画
let idleAction = 'none'      // 'none' | 'bounce' | 'look' | 'wiggle' | 'stretch'
let idleStartTime = 0
let idleTimer = null
let idleBlendPrev = 0
const IDLE_ACTIONS = ['bounce', 'look', 'wiggle', 'stretch']
const IDLE_DURATIONS = { bounce: 1.2, look: 1.5, wiggle: 0.8, stretch: 1.6 }

const SENSITIVE_KEYWORDS = [
  '薪资', '工资', 'salary', 'payroll', '工资条',
  '合同', 'contract', 'agreement',
  '密码', 'password', 'passwd', 'pwd',
  '.env', 'secret', 'token', 'credentials',
  '身份证', '护照', 'passport', 'id_card',
  '银行', 'bank', '卡号', 'card',
  '证书', 'certificate', 'private key', '私钥',
  '密钥', 'license', 'keychain',
  '社保', '公积金', '税', 'tax',
  '简历', 'resume', 'cv',
  '病历', '体检', 'medical',
  '加密', 'encrypted', 'gpg',
]

function isSensitive(filename) {
  const lower = filename.toLowerCase()
  return SENSITIVE_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))
}

const petMenuVisible = ref(false)
const petMenuPos = ref({ x: 0, y: 0 })

function showPetMenu(e) {
  petMenuPos.value = { x: e.clientX, y: e.clientY }
  petMenuVisible.value = true
}

function switchPet(idx) {
  currentPetIdx = idx ?? (currentPetIdx + 1) % petList.length
  pet = petList[currentPetIdx]
  petMenuVisible.value = false
}

function scheduleIdleAction() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (!isWalking && !isEating && !isRejecting && !isWatchingTV && idleAction === 'none') {
      const action = IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)]
      idleAction = action
      idleStartTime = time
      const dur = (IDLE_DURATIONS[action] || 1.5) * 1000
      setTimeout(() => {
        idleAction = 'none'
      }, dur)
    }
    scheduleIdleAction()
  }, 4000 + Math.random() * 6000)
}

function scheduleWander() {
  clearTimeout(wanderTimer)
  wanderTimer = setTimeout(() => {
    if (!isWalking && !hovering.value && !isEating && !isRejecting && !isDragging && !isWatchingTV) {
      // 只在右上方区域内左右移动
      const goLeft = Math.random() > 0.5
      const dist = 40 + Math.random() * 80
      const dx = goLeft ? -dist : dist
      moveWindowBy(dx, 0)
    }
    scheduleWander()
  }, 3000 + Math.random() * 5000)
}

async function moveWindowBy(dx, dy) {
  if (typeof window.electronAPI?.moveWindow !== 'function') return
  isWalking = true
  facingRight = dx >= 0

  // 原地踏步预备阶段，让走路动画先跑起来
  await new Promise(r => setTimeout(r, 450))

  // 离散步伐，只水平移动
  const totalDist = Math.abs(dx)
  const numSteps = Math.max(2, Math.min(6, Math.round(totalDist / 22)))
  const stepX = Math.round(dx / numSteps)
  const stepInterval = 480

  for (let i = 0; i < numSteps; i++) {
    await new Promise(r => setTimeout(r, stepInterval))
    window.electronAPI.moveWindow(stepX, 0, false)
  }

  // 短暂收尾
  await new Promise(r => setTimeout(r, 250))
  isWalking = false
}

// 拖拽移动
let isDragging = false
let dragStartX = 0
let dragStartY = 0
let hasMoved = false
const DRAG_THRESHOLD = 4

// 惯性滑动
let lastDragTime = 0
let lastDragDx = 0
let lastDragDy = 0
let inertiaAnim = null

function applyInertia(vx, vy) {
  if (inertiaAnim) cancelAnimationFrame(inertiaAnim)
  const friction = 0.92
  const minSpeed = 0.5
  function step() {
    const speed = Math.sqrt(vx * vx + vy * vy)
    if (speed < minSpeed) { inertiaAnim = null; return }
    window.electronAPI?.moveWindow(Math.round(vx), Math.round(vy), true)
    vx *= friction
    vy *= friction
    inertiaAnim = requestAnimationFrame(step)
  }
  inertiaAnim = requestAnimationFrame(step)
}

let clickStartTime = 0
function onMouseDown(e) {
  if (e.button !== 0) return
  if (inertiaAnim) { cancelAnimationFrame(inertiaAnim); inertiaAnim = null }
  clickStartTime = Date.now()
  isDragging = true
  hasMoved = false
  dragStartX = e.screenX
  dragStartY = e.screenY
  lastDragTime = Date.now()
  lastDragDx = 0
  lastDragDy = 0
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

function onMouseMove(e) {
  if (!isDragging) return
  const dx = e.screenX - dragStartX
  const dy = e.screenY - dragStartY
  if (!hasMoved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
    hasMoved = true
  }
  if (hasMoved) {
    const now = Date.now()
    const dt = Math.max(1, now - lastDragTime)
    lastDragDx = dx / dt * 16  // normalize to ~16ms frame
    lastDragDy = dy / dt * 16
    lastDragTime = now
    dragStartX = e.screenX
    dragStartY = e.screenY
    window.electronAPI?.moveWindow(dx, dy, true)
  }
}

function onMouseUp() {
  isDragging = false
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
  if (!hasMoved) {
    window.electronAPI?.openChat()
  } else {
    // 松手后惯性滑动
    const vx = lastDragDx * 0.6
    const vy = lastDragDy * 0.6
    if (Math.abs(vx) > 1 || Math.abs(vy) > 1) applyInertia(vx, vy)
  }
}

let dragLeaveTimer = null

function onDragEnter(e) { isDragOver.value = true; clearTimeout(dragLeaveTimer) }
function onDragOver(e) { isDragOver.value = true; clearTimeout(dragLeaveTimer) }
function onDragLeave() { dragLeaveTimer = setTimeout(() => { isDragOver.value = false }, 100) }

function onDrop(e) {
  isDragOver.value = false; clearTimeout(dragLeaveTimer)
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  const file = files[0]
  if (isSensitive(file.name)) startReject()
  else startEat(file.path)
}

function startEat(filePath) {
  isEating = true; eatStartTime = time
  setTimeout(() => { window.electronAPI?.feedFile(filePath) }, EAT_DURATION * 1000)
}

function startReject() {
  isRejecting = true; rejectStartTime = time
  setTimeout(() => { isRejecting = false }, REJECT_DURATION * 1000)
}

// 简易伪随机
function rnd(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x, y + h - r, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

function drawTVScene(ctx, w, h, time, tvStartTime) {
  const tvPhase = Math.min(1, (time - tvStartTime) / 0.7)
  const tvX = 218, tvY = 60
  const tvW = 38, tvH = 30

  // 搬出动画：从下方弹上来 (back-ease-out with slight overshoot)
  const t = Math.min(1, tvPhase)
  // 缩放 0→1.05→1 (overshoot settle)
  const settleScale = t < 1
    ? 1 + Math.sin(t * Math.PI * 1.5) * 0.1 * (1 - t)
    : 1
  // Y 方向从下方升起来
  const settleY = (1 - t) * 30 * (1 - t)

  ctx.save()
  ctx.translate(tvX + tvW / 2, tvY + tvH / 2 + settleY)
  ctx.scale(settleScale, settleScale)
  ctx.translate(-(tvX + tvW / 2), -(tvY + tvH / 2))

  // ── 电视柜/腿 ──
  ctx.fillStyle = '#8B7355'
  ctx.fillRect(tvX + 8, tvY + tvH, 4, 6)
  ctx.fillRect(tvX + tvW - 12, tvY + tvH, 4, 6)

  // ── 电视机身外壳 ──
  const bodyGrad = ctx.createLinearGradient(tvX, tvY, tvX, tvY + tvH)
  bodyGrad.addColorStop(0, '#E8D5B8')
  bodyGrad.addColorStop(0.5, '#D4C0A0')
  bodyGrad.addColorStop(1, '#B89870')
  ctx.fillStyle = bodyGrad
  roundRect(ctx, tvX, tvY, tvW, tvH, 5)
  ctx.fill()
  ctx.strokeStyle = '#A08060'
  ctx.lineWidth = 1.2
  ctx.stroke()

  // ── 天线 ──
  ctx.strokeStyle = '#888'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(tvX + 8, tvY)
  ctx.lineTo(tvX + 3, tvY - 8)
  ctx.moveTo(tvX + tvW - 8, tvY)
  ctx.lineTo(tvX + tvW - 2, tvY - 9)
  ctx.stroke()
  ctx.fillStyle = '#ccc'
  ctx.beginPath(); ctx.arc(tvX + 3, tvY - 8, 2, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(tvX + tvW - 2, tvY - 9, 2, 0, Math.PI * 2); ctx.fill()

  // ── 屏幕 ──
  const scrX = tvX + 4, scrY = tvY + 4
  const scrW = tvW - 8, scrH = tvH - 8
  ctx.fillStyle = '#1a1a2e'
  roundRect(ctx, scrX, scrY, scrW, scrH, 2)
  ctx.fill()

  // 雪花噪点
  const noiseSeed = Math.floor(time * 15)
  for (let ny = 0; ny < scrH; ny += 3) {
    for (let nx = 0; nx < scrW; nx += 3) {
      const brightness = rnd(noiseSeed + ny * 100 + nx) * 0.35
      if (brightness > 0.15) {
        ctx.fillStyle = `rgba(180,200,255,${brightness})`
        ctx.fillRect(scrX + nx, scrY + ny, 2.5, 2.5)
      }
    }
  }

  // 屏幕微光
  const glowGrad = ctx.createRadialGradient(scrX + scrW / 2, scrY + scrH / 2, 2, scrX + scrW / 2, scrY + scrH / 2, scrW)
  glowGrad.addColorStop(0, 'rgba(120,160,255,0.12)')
  glowGrad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = glowGrad
  roundRect(ctx, scrX, scrY, scrW, scrH, 2)
  ctx.fill()

  // 电源灯
  ctx.fillStyle = '#4a4'
  ctx.beginPath(); ctx.arc(tvX + tvW - 4, tvY + tvH + 3, 1.5, 0, Math.PI * 2); ctx.fill()

  ctx.restore()

  // ── 爆米花 ──
  const popX = 175, popY = 112
  ctx.fillStyle = '#e8473a'
  ctx.beginPath()
  ctx.moveTo(popX - 8, popY - 4)
  ctx.lineTo(popX - 5, popY + 8)
  ctx.lineTo(popX + 5, popY + 8)
  ctx.lineTo(popX + 8, popY - 4)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = '#c03028'
  ctx.lineWidth = 0.8
  ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.fillRect(popX - 4, popY - 2, 8, 2)
  ctx.fillStyle = '#FFF5E0'
  ctx.beginPath(); ctx.arc(popX - 2, popY - 6, 2.5, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(popX + 3, popY - 5, 2, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(popX, popY - 8, 2.2, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#F5E6C8'
  ctx.beginPath(); ctx.arc(popX - 4, popY - 4, 1.8, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(popX + 5, popY - 3, 1.5, 0, Math.PI * 2); ctx.fill()
}

function tick() {
  time += 0.016
  if (isEating && time - eatStartTime > EAT_DURATION) isEating = false
  if (isRejecting && time - rejectStartTime > REJECT_DURATION) isRejecting = false
  // 待机动画超时自动结束
  if (idleAction !== 'none' && IDLE_DURATIONS[idleAction] && time - idleStartTime > IDLE_DURATIONS[idleAction]) {
    idleAction = 'none'
  }
  // 空闲状态平滑混合: 进入时从0过渡到1, 退出时从1退回到0
  if (idleAction !== 'none') {
    idleBlendPrev = Math.min(1, idleBlendPrev + 0.016 / 0.25)
  } else {
    idleBlendPrev = Math.max(0, idleBlendPrev - 0.016 / 0.2)
  }
  const idleBlend = idleBlendPrev

  const c = canvas.value
  if (c) {
    const ctx = c.getContext('2d')
    const eatPhase = isEating ? (time - eatStartTime) / EAT_DURATION : 0
    const rejectPhase = isRejecting ? (time - rejectStartTime) / REJECT_DURATION : 0
    const idlePhase = idleAction !== 'none' ? (time - idleStartTime) / (IDLE_DURATIONS[idleAction] || 1) : 0
    ctx.clearRect(0, 0, canvasW, canvasH)

    ctx.save()
    const s = Math.min(canvasW / LOGICAL_W, canvasH / LOGICAL_H)
    ctx.scale(s, s)
    const tvPhase = isWatchingTV ? Math.min(1, (time - tvStartTime) / 0.7) : 0
    const tvEase = 1 - Math.pow(1 - Math.min(1, tvPhase), 2)
    const sitDown = tvEase * 12     // 整体下沉
    const sitSquash = 1 - tvEase * 0.18  // 纵向轻微压扁

    // ── 宠物绘制（看电视时加坐下变换） ──
    ctx.save()
    if (tvEase > 0) {
      ctx.translate(0, sitDown)
      ctx.translate(LOGICAL_W / 2, LOGICAL_H / 2)
      ctx.scale(1 + tvEase * 0.08, sitSquash)
      ctx.translate(-LOGICAL_W / 2, -(LOGICAL_H / 2))
    }
    pet.drawFn(ctx, LOGICAL_W, LOGICAL_H, time, {
      isWalking, facingRight,
      isEating, eatPhase,
      isRejecting, rejectPhase,
      isDragOver: isDragOver.value,
      isWorking,
      idleAction,
      idlePhase,
      idleBlend,
      isWatchingTV,
      tvPhase,
    })
    ctx.restore()

    // ★ 通用看电视覆盖层（所有宠物共享，不受坐下变换影响）
    if (isWatchingTV) {
      drawTVScene(ctx, LOGICAL_W, LOGICAL_H, time, tvStartTime)
    }
    ctx.restore()
  }
  animId = requestAnimationFrame(tick)
}

let removeWorkingListener = null
let removeIdleListener = null
onMounted(async () => {
  // 获取屏幕右上方边界
  try {
    const bounds = await window.electronAPI?.getScreenBounds?.()
    if (bounds) screenBounds = bounds
  } catch { /* 使用默认值 */ }

  animId = requestAnimationFrame(tick)
  scheduleWander()
  scheduleIdleAction()

  // 主动查询当前空闲状态（避免错过初始事件）
  try {
    const idleNow = await window.electronAPI?.getIdleState?.()
    if (idleNow) {
      isWatchingTV = true
      tvStartTime = time
    }
  } catch { /* ignore */ }

  removeWorkingListener = window.electronAPI?.onWorkingState?.((data) => {
    isWorking = data.isWorking
  })
  removeIdleListener = window.electronAPI?.onIdleState?.((data) => {
    if (data.isIdle && !isWatchingTV) {
      isWatchingTV = true
      tvStartTime = time
    } else if (!data.isIdle && isWatchingTV) {
      isWatchingTV = false
    }
  })
})

onUnmounted(() => {
  if (animId) cancelAnimationFrame(animId)
  if (inertiaAnim) cancelAnimationFrame(inertiaAnim)
  clearTimeout(wanderTimer)
  clearTimeout(idleTimer)
  removeWorkingListener?.()
  removeIdleListener?.()
})
</script>

<style scoped>
.pet-menu-overlay {
  position: fixed; inset: 0; z-index: 200;
}
.pet-menu {
  position: fixed;
  background: #FEFAF5;
  border-radius: 16px;
  border: 1.8px solid #E2D9CF;
  box-shadow: 0 4px 20px rgba(0,0,0,0.06);
  padding: 6px; min-width: 140px;
}
.pet-menu-title {
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  font-size: 13px; color: #B6A792;
  padding: 4px 10px 8px;
  letter-spacing: 0.5px;
}
.pet-menu-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 7px 10px; border-radius: 12px;
  border: none; background: transparent; cursor: pointer;
  font-size: 12.5px; font-family: inherit; color: #4D3E30;
  text-align: left; transition: all 0.1s;
}
.pet-menu-item:hover { background: #F7F1E8; }
.pet-menu-item.active { background: #F7F1E8; font-weight: 600; }
.pet-menu-icon { font-size: 18px; }
.pet-menu-check { margin-left: auto; color: #9DC0AF; font-size: 14px; }
</style>

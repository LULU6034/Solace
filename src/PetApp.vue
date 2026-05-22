<template>
  <canvas ref="canvas" :width="canvasW" :height="canvasH"
    style="display:block;cursor:pointer;"
    @click="onClick"
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
const canvasW = 280
const canvasH = 210

let animId = null
let time = 0
let currentPetIdx = 0
let pet = petList[0]

let isWalking = false
let facingRight = true
let wanderTimer = null

// AI 工作状态（聊天窗口思考时宠物加速呼吸）
let isWorking = false

let isEating = false
let eatStartTime = 0
const EAT_DURATION = 1.4

let isRejecting = false
let rejectStartTime = 0
const REJECT_DURATION = 0.5

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

function scheduleWander() {
  clearTimeout(wanderTimer)
  wanderTimer = setTimeout(() => {
    if (!isWalking && !hovering.value && !isEating && !isRejecting) {
      const angle = Math.random() * Math.PI * 2
      const dist = 30 + Math.random() * 50
      moveWindowBy(Math.round(Math.cos(angle) * dist), Math.round(Math.sin(angle) * dist))
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

  // 离散步伐：每步匹配走路动画周期（~0.5s），大步移动
  const totalDist = Math.abs(dx) + Math.abs(dy)
  const numSteps = Math.max(2, Math.min(6, Math.round(totalDist / 22)))
  const stepX = Math.round(dx / numSteps)
  const stepY = Math.round(dy / numSteps)
  const stepInterval = 480

  for (let i = 0; i < numSteps; i++) {
    await new Promise(r => setTimeout(r, stepInterval))
    window.electronAPI.moveWindow(stepX, stepY)
  }

  // 短暂收尾
  await new Promise(r => setTimeout(r, 250))
  isWalking = false
}

function onClick() {
  window.electronAPI?.openChat()
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

function tick() {
  time += 0.016
  if (isEating && time - eatStartTime > EAT_DURATION) isEating = false
  if (isRejecting && time - rejectStartTime > REJECT_DURATION) isRejecting = false

  const c = canvas.value
  if (c) {
    const ctx = c.getContext('2d')
    const eatPhase = isEating ? (time - eatStartTime) / EAT_DURATION : 0
    const rejectPhase = isRejecting ? (time - rejectStartTime) / REJECT_DURATION : 0
    pet.drawFn(ctx, canvasW, canvasH, time, {
      isWalking, facingRight,
      isEating, eatPhase,
      isRejecting, rejectPhase,
      isDragOver: isDragOver.value,
      isWorking,
    })
  }
  animId = requestAnimationFrame(tick)
}

let removeWorkingListener = null
onMounted(() => {
  animId = requestAnimationFrame(tick)
  scheduleWander()
  removeWorkingListener = window.electronAPI?.onWorkingState?.((data) => {
    isWorking = data.isWorking
  })
})

onUnmounted(() => {
  if (animId) cancelAnimationFrame(animId)
  clearTimeout(wanderTimer)
  removeWorkingListener?.()
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
  font-family: 'Caveat', cursive;
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

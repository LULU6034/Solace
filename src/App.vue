<template>
  <div class="glass-window">
    <!-- 标题栏 -->
    <div class="pet-strip" @mousedown="onTitleMouseDown">
      <span class="status-dot" :class="{ online: agentOnline }" />
      <TopMiniPlayer />
    </div>

    <div class="app-body">
      <!-- ═══ 侧边菜单 ═══ -->
      <nav class="sidebar">
        <div class="sidebar-menu">
          <button v-for="item in menuItems" :key="item.id"
            class="sidebar-item" :class="{ active: activeView === item.id }"
            @click="switchView(item.id)">
            <span class="sidebar-item-icon"><component :is="item.icon" :size="18" /></span>
            <span class="sidebar-item-label">{{ item.label }}</span>
          </button>
        </div>

        <div class="sidebar-spacer" />

        <div class="sidebar-footer">
          <button class="sidebar-item" @click="showSettings = true">
            <span class="sidebar-item-icon"><Settings :size="18" /></span>
            <span class="sidebar-item-label">设置</span>
          </button>
        </div>
      </nav>

      <!-- ═══ 页面内容 ═══ -->
      <ChatPage v-if="activeView === 'chat'" />
      <GroupChatPage v-else-if="activeView === 'groupchat'" />
      <VoiceChat v-else-if="activeView === 'voice'" />
      <RolesPage v-else-if="activeView === 'roles'" @openSettings="showSettings = true" />
      <MemoryGraphPage v-else-if="activeView === 'memory'" />
      <KnowledgePage v-else-if="activeView === 'knowledge'" />
    </div>

    <Transition name="settings">
      <SettingsPanel v-if="showSettings" @done="showSettings = false" />
    </Transition>

    <ConflictDialog ref="conflictDlg" />
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { MessageCircle, Users, Settings, Sparkles, Mic, Brain, Database } from 'lucide-vue-next'
import ChatPage from './components/ChatPage.vue'
import GroupChatPage from './components/GroupChatPage.vue'
import VoiceChat from './components/VoiceChat.vue'
import RolesPage from './components/RolesPage.vue'
import TopMiniPlayer from './components/TopMiniPlayer.vue'
import ConflictDialog from './components/ConflictDialog.vue'
import MemoryGraphPage from './components/MemoryGraphPage.vue'
import KnowledgePage from './components/KnowledgePage.vue'
import SettingsPanel from './components/SettingsPanel.vue'

// ── 窗口拖动 ──
let isDragging = false, dragSX = 0, dragSY = 0
function onTitleMouseDown(e) {
  if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return
  isDragging = true; dragSX = e.screenX; dragSY = e.screenY
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}
function onMove(e) {
  if (!isDragging) return
  const dx = e.screenX - dragSX, dy = e.screenY - dragSY
  dragSX = e.screenX; dragSY = e.screenY
  window.electronAPI?.moveWindow(dx, dy)
}
function onUp() {
  isDragging = false
  document.removeEventListener('mousemove', onMove)
  document.removeEventListener('mouseup', onUp)
}

// ── 视图管理 ──
const activeView = ref('chat')
const menuItems = [
  { id: 'chat', icon: MessageCircle, label: '对话' },
  { id: 'groupchat', icon: Sparkles, label: '群聊' },
  { id: 'voice', icon: Mic, label: '语音' },
  { id: 'roles', icon: Users, label: '角色' },
  { id: 'memory', icon: Brain, label: '记忆' },
  { id: 'knowledge', icon: Database, label: '知识库' },
]

function switchView(id) {
  activeView.value = id
}

// ── 全局状态 ──
const showSettings = ref(false)
const agentOnline = ref(false)
const conflictDlg = ref(null)

// Health check
let healthInterval = setInterval(async () => {
  try { const r = await window.electronAPI?.agentPing(); agentOnline.value = !!r?.ready }
  catch { agentOnline.value = false }
}, 30000)
;(async () => { try { const r = await window.electronAPI?.agentPing(); agentOnline.value = !!r?.ready } catch {} })()

// ── Lifecycle ──
let unsubMax, unsubConflict
onMounted(async () => {
  // 窗口最大化状态监听
  unsubMax = window.electronAPI?.onWindowMaximizedChange(({ maximized }) => {
    document.body.classList.toggle('window-maximized', maximized)
  })
  // 记忆冲突对话框
  unsubConflict = window.electronAPI?.onMemoryConflict?.((conflicts) => {
    conflictDlg.value?.show(conflicts)
  })
  // 初始化主题
  const theme = localStorage.getItem('app-theme') || 'system'
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && prefersDark))
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem('app-theme') || 'system') === 'system') {
      document.documentElement.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches)
    }
  })
  // 配置恢复
  let savedConfig = await window.electronAPI?.loadConfig()
  if (!savedConfig) {
    const saved = localStorage.getItem('llm-config')
    if (saved) { try { savedConfig = JSON.parse(saved) } catch {} }
  }
  if (savedConfig) {
    try { const { llmService } = await import('./lib/llm/LLMProvider'); llmService.restore(savedConfig) } catch {}
  }
})

onUnmounted(() => {
  unsubMax?.()
  unsubConflict?.()
  clearInterval(healthInterval)
})
</script>

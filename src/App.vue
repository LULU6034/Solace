<template>
  <div class="glass-window">
    <!-- 标题栏 -->
    <div class="pet-strip" :class="{ working: loading }" @mousedown="onTitleMouseDown">
      <span class="status-dot" :class="{ online: agentOnline }" />
    </div>

    <div class="app-body">
      <!-- ═══ 侧边菜单 ═══ -->
      <nav class="sidebar">
        <div class="sidebar-menu">
          <template v-for="item in menuItems" :key="item.id">
            <!-- 顶级菜单项 -->
            <button
              class="sidebar-item" :class="{ active: activeView === item.id }"
              @click="switchView(item.id)">
              <span class="sidebar-item-icon"><component :is="item.icon" :size="18" /></span>
              <span class="sidebar-item-label">{{ item.label }}</span>
              <span v-if="item.children" class="sidebar-item-arrow"
                :class="{ open: activeView === item.id }">▾</span>
            </button>
            <!-- 子菜单 -->
            <div v-if="item.children && activeView === item.id" class="sidebar-submenu">
              <button v-for="sub in item.children" :key="sub.id"
                class="sidebar-subitem" :class="{ active: activeSubView === sub.id }"
                @click="switchView(sub.id)">
                <span class="sidebar-item-icon">{{ sub.icon }}</span>
                <span class="sidebar-item-label">{{ sub.label }}</span>
              </button>
            </div>
          </template>
        </div>

        <div class="sidebar-spacer" />

        <div class="sidebar-footer">
          <button class="sidebar-item" @click="showSettings = true">
            <span class="sidebar-item-icon"><Settings :size="18" /></span>
            <span class="sidebar-item-label">设置</span>
          </button>
        </div>
      </nav>

      <!-- ═══ 主内容区 ═══ -->
      <div class="main-area">
        <!-- 标签栏 + 操作按钮 -->
        <div class="header-bar">
          <div class="conversation-pills">
            <TransitionGroup
              @before-enter="onTabBeforeEnter"
              @enter="onTabEnter"
              @leave="onTabLeave">
              <div v-for="(c, i) in viewConvs" :key="c.id" class="pill-wrap"
                @contextmenu.prevent="ctxMenu = { idx: i, x: $event.clientX, y: $event.clientY }">
                <button class="conv-pill" :class="{ active: i === viewIdx }" @click="switchConv(i)">
                  <span class="pill-label">{{ c.title }}</span>
                  <span v-if="viewConvs.length > 1" class="pill-close"
                    @click.stop="closeConv(i)" title="关闭对话">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                  </span>
                </button>
              </div>
            </TransitionGroup>
          </div>

          <div class="tab-actions">
            <button v-if="activeView === 'groupchat'" class="header-btn group-manage-btn"
              @click="showGroupManager = true" title="群聊管理">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <circle cx="4" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="12" cy="8" r="1.5"/>
              </svg>
            </button>
            <button class="add-btn" title="新建对话" @click.stop="addNewConv">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- 右键菜单 -->
        <div v-if="ctxMenu" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
          @click="ctxMenu = null" @mouseleave="ctxMenu = null">
          <button class="ctx-menu-item" @click="renameConv(ctxMenu.idx)">重命名</button>
          <button v-if="viewConvs.length > 1" class="ctx-menu-item danger"
            @click.stop="closeConv(ctxMenu.idx)">关闭对话</button>
        </div>

        <!-- 重命名弹窗 -->
        <div v-if="renaming !== null" class="rename-overlay" @click="renaming = null">
          <div class="rename-dialog" @click.stop>
            <input v-model="renameText" class="setting-input" placeholder="对话名称..."
              @keydown.enter="doRename" @keydown.escape="renaming = null" ref="renameInput" />
            <div class="rename-actions">
              <button class="setting-btn secondary" @click="renaming = null">取消</button>
              <button class="setting-btn primary" @click="doRename">确定</button>
            </div>
          </div>
        </div>

        <!-- 协作计划确认卡片 -->
        <div v-if="pendingPlan" class="plan-confirm-card">
          <div class="plan-confirm-header">
            <span>执行计划</span>
            <span class="plan-confirm-summary">{{ pendingPlan.summary }}</span>
          </div>
          <div class="plan-confirm-phases">
            <span v-for="p in pendingPlan.phases" :key="p.phase" class="plan-phase-item">
              <span class="plan-phase-num">{{ p.phase }}.</span>
              <span class="plan-phase-title">{{ p.assigned_to }}</span>
              <span class="plan-phase-agent">{{ p.title }}</span>
            </span>
          </div>
          <div class="plan-confirm-actions">
            <button class="setting-btn secondary" @click="confirmPlan(false)">取消</button>
            <button class="setting-btn primary" @click="confirmPlan(true)">执行</button>
          </div>
        </div>

        <!-- 协作执行进度条 -->
        <div v-if="collabActive" class="collab-progress">
          <span v-for="(s, i) in collabSteps" :key="i" class="collab-step" :class="s.status">
            <span class="collab-step-dot" />
            <span class="collab-step-label">{{ s.assigned_to }}</span>
            <span v-if="i < collabSteps.length - 1" class="collab-step-line" />
          </span>
        </div>

        <!-- 消息区 -->
        <div class="messages-area" ref="msgArea" @click="ctxMenu = null">
          <div v-if="conv.messages.length === 0" class="welcome-placeholder">
            <div class="welcome-avatar-ring">
              <div class="pulse-ring r1"></div>
              <div class="pulse-ring r2"></div>
              <div class="pulse-ring r3"></div>
              <div class="welcome-icon"
                :style="{ background: (allAgents.find(a => a.isActive)?.color || char.color) + '18' }">{{ welcomeIcon }}</div>
            </div>
            <div class="welcome-title">你好，我是 {{ welcomeName }}</div>
            <div class="welcome-sub">有什么可以帮你的？</div>
          </div>

          <div v-for="(msg, i) in conv.messages" :key="i"
            class="message-row" :class="[msg.role, { review: msg._review }]"
            @mouseenter="msg._hover = true" @mouseleave="msg._hover = false">
            <div v-if="msg.role === 'assistant'" class="msg-avatar"
              :style="msg._expert?.avatarUrl
                ? { backgroundImage: 'url(' + msg._expert.avatarUrl + ')', backgroundSize: 'cover' }
                : { background: (msg._expert?.color || char.color) + '18' }">
              <span v-if="!msg._expert?.avatarUrl">{{ msg._expert?.icon || char.icon }}</span>
            </div>
            <div v-else class="msg-avatar user-avatar">
              <img v-if="userAvatar.startsWith('data:')" :src="userAvatar" class="avatar-img" />
              <div v-else class="avatar-geo" :style="{ background: avatarColor }">
                <svg viewBox="0 0 40 40" class="avatar-geo-svg">
                  <path d="M12 28 Q20 8 28 28" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5" stroke-linecap="round"/>
                  <path d="M8 22 Q20 16 32 22" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.5" stroke-linecap="round"/>
                  <circle cx="20" cy="18" r="3" fill="rgba(255,255,255,0.3)" />
                </svg>
              </div>
            </div>
            <div class="bubble-wrap">
              <div class="bubble" :class="msg.role" :style="msg._expert ? { borderColor: msg._expert.color + '60' } : {}">
                <div v-if="msg.role === 'assistant'" class="msg-role" :style="msg._expert ? { color: msg._expert.color } : {}">
                  {{ msg._expert?.name || char.name }}</div>
                <!-- 已完成消息的思考过程 -->
                <div v-if="msg._reasoning" class="bubble-reasoning">
                  <button class="bubble-reasoning-toggle"
                    @click="msg._reasoningOpen = !msg._reasoningOpen">
                    <span>🧠 思考过程</span>
                    <span class="bubble-reasoning-arrow" :class="{ open: msg._reasoningOpen }">▾</span>
                  </button>
                  <div class="bubble-reasoning-content" :class="{ open: msg._reasoningOpen }">{{ msg._reasoning }}</div>
                </div>
                <!-- 流式生成中的实时思考过程 — 出现在回复文字上方 -->
                <div v-if="isStreamingMsg(msg, i) && reasoningText" class="bubble-reasoning">
                  <button class="bubble-reasoning-toggle" @click="reasoningExpanded = !reasoningExpanded">
                    <span>🧠 思考中...</span>
                    <span class="bubble-reasoning-arrow" :class="{ open: reasoningExpanded }">▾</span>
                  </button>
                  <div class="bubble-reasoning-content" :class="{ open: reasoningExpanded }">{{ reasoningText }}</div>
                </div>
                <div v-if="msg._previewImages" class="msg-images">
                  <img v-for="(img, ii) in msg._previewImages" :key="ii" :src="img"
                    class="msg-image-preview" />
                </div>
                <div class="msg-text" v-html="renderMarkdown(msg.content)"></div>
                <span v-if="isStreamingMsg(msg, i)" class="streaming-cursor"></span>
                <div v-if="msg.timestamp" class="msg-footer">
                  <span class="msg-arrow">{{ msg.role === 'user' ? '↘︎' : '↙︎' }}</span>
                  <span class="msg-time">{{ fmtTime(msg.timestamp) }}</span>
                  <span v-if="msg.elapsed" class="msg-elapsed">⏱ {{ msg.elapsed }}s</span>
                  <span v-if="msg.role === 'user'" class="msg-check">✓</span>
                </div>
              </div>
              <button v-if="msg._hover" class="copy-btn" @click="copyMsg(msg.content)"
                :class="{ copied: msg._copied }">
                {{ msg._copied ? '✓ 已复制' : '⎘ 复制' }}
              </button>
            </div>
          </div>

          <div v-if="loading && conv.messages.length > 0" class="typing-indicator">
            <div class="typing-dot" /><div class="typing-dot" /><div class="typing-dot" />
          </div>

          <div ref="msgEnd" />
        </div>

        <!-- 输入区 -->
        <div class="input-area">
          <div v-if="pendingImages.length > 0" class="img-preview-strip">
            <div v-for="(img, i) in pendingImages" :key="i" class="img-preview">
              <img :src="img.data" />
              <button class="img-remove" @click="pendingImages.splice(i, 1)">&times;</button>
            </div>
          </div>

          <div class="input-toolbar-top">
            <select class="model-select" v-model="convModel" :disabled="loading">
              <option v-for="m in currentModels" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
            <span v-if="activeView === 'groupchat'" class="group-mode-badge">🌐 群聊</span>
            <button v-if="supportsSpeech" class="mic-btn-inline" :class="{ recording: isRecording }" :title="isRecording?'停止':'语音'" @click="toggleSpeech">{{ isRecording ? '⬤' : '🎤' }}</button>
            <button class="reasoning-btn" :class="{ on: reasoningOn }" @click="reasoningOn = !reasoningOn" :title="reasoningOn?'关闭推理':'开启推理'"><Brain :size="15" /></button>
          </div>
          <div class="input-box">
            <textarea ref="ta" v-model="text"
              :placeholder="activeView === 'groupchat' ? '@专家名 提问...' : '输入消息...'"
              @keydown="onKeydown" @paste="onPaste" rows="1" />
            <button
              v-if="sendState === 'idle'"
              class="send-btn-inline"
              :disabled="!text.trim() && pendingImages.length === 0"
              @click="handleSend" title="发送"><ArrowUp :size="16" /></button>
            <button v-else-if="sendState === 'loading'" class="send-btn-inline loading" title="发送中...">
              <span class="btn-spinner"></span>
            </button>
            <button v-else-if="sendState === 'sent'" class="send-btn-inline sent" title="已发送">
              <Check :size="16" class="btn-check" />
            </button>
            <button v-if="sendState === 'loading'" class="stop-btn" @click="stopGeneration">⏹</button>
          </div>
        </div>

        <!-- 工具审批弹窗 -->
        <div v-if="pendingApproval" class="approval-overlay" @click.self="approveTool(false)">
          <div class="approval-dialog">
            <div class="approval-icon">⚠️</div>
            <div class="approval-title">确认执行命令</div>
            <div class="approval-tool-name">{{ pendingApproval.tool }}</div>
            <pre class="approval-input">{{ fmtApprovalInput(pendingApproval.input) }}</pre>
            <div class="approval-warning">此操作需要你的批准。请确认命令安全后再执行。</div>
            <div class="approval-actions">
              <button class="setting-btn secondary" @click="approveTool(false)">拒绝</button>
              <button class="setting-btn primary approval-allow" @click="approveTool(true)">批准执行</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 角色管理弹窗 (Agent-based) -->
    <div v-if="showRoleManager" class="dialog-backdrop" @click.self="showRoleManager = false">
      <div class="role-dialog" @click.stop>
        <div class="role-dialog-title">角色管理</div>
        <div class="role-dialog-body">
          <div class="role-manager-list">
            <div v-for="a in allAgents" :key="a.id" class="role-manager-item">
              <span class="role-manager-avatar role-manager-emoji"
                :style="{ background: (a.color || '#6366F1') + '18' }">{{ a.icon || '🤖' }}</span>
              <div class="role-manager-info">
                <span class="role-manager-name">
                  {{ a.name }}
                  <span v-if="a.isBuiltin" class="agent-row-badge">内置</span>
                </span>
                <span class="role-manager-status" :class="{ active: a.isActive }">
                  {{ a.isActive ? '当前活跃' : '未活跃' }}
                </span>
              </div>
              <label class="rd-switch" style="margin-left: auto">
                <input type="checkbox" :checked="activeGroupAgentIds.includes(a.id)"
                  @change="toggleGroupAgent(a.id)" />
                <span style="font-size:11px;color:var(--text-muted)">群聊</span>
              </label>
            </div>
            <div v-if="allAgents.length === 0" class="role-manager-empty">
              加载中...
            </div>
          </div>
        </div>
        <div class="role-dialog-actions">
          <button class="setting-btn secondary" @click="showRoleManager = false">关闭</button>
          <button class="setting-btn primary" @click="openSettingsToCreate()">新建角色</button>
        </div>
      </div>
    </div>

    <!-- 群聊管理弹窗 -->
    <div v-if="showGroupManager" class="dialog-backdrop" @click.self="showGroupManager = false">
      <div class="role-dialog" @click.stop style="width:380px">
        <div class="role-dialog-title">群聊管理</div>
        <div class="role-dialog-body">
          <!-- 群聊模式切换 -->
          <div class="group-setting-row" style="margin-bottom:12px">
            <span>群聊模式</span>
            <div class="segmented-row" style="background:var(--bg-input);border-radius:6px">
              <button class="seg-btn" :class="{ active: groupSettings.mode === 'discussion' }"
                @click="groupSettings.mode = 'discussion'; saveGroupSettings()">讨论</button>
              <button class="seg-btn" :class="{ active: groupSettings.mode === 'collaboration' }"
                @click="groupSettings.mode = 'collaboration'; saveGroupSettings()">协作</button>
            </div>
          </div>

          <!-- 群成员 -->
          <div class="group-member-grid">
            <div v-for="a in activeGroupAgents" :key="a.id" class="group-member-item">
              <span class="group-member-avatar group-member-emoji"
                :style="{ background: (a.color || '#6366F1') + '18' }">{{ a.icon || '🤖' }}</span>
              <span class="group-member-name">{{ a.name }}</span>
              <button class="group-member-remove" @click="toggleGroupAgent(a.id)" title="移除">✕</button>
            </div>
            <div v-if="inactiveGroupAgents.length > 0" class="group-member-item group-member-add"
              @click="showAgentPickerInManager = !showAgentPickerInManager">
              <div class="group-member-avatar group-member-emoji" style="background:var(--accent-soft);border-style:dashed">+</div>
              <span class="group-member-name">添加</span>
            </div>
          </div>
          <!-- 添加角色下拉 -->
          <div v-if="showAgentPickerInManager" class="rd-tool-list" style="max-height:140px">
            <label v-for="a in inactiveGroupAgents" :key="a.id"
              class="rd-tool-item" @click="toggleGroupAgent(a.id); showAgentPickerInManager = false">
              <span>{{ a.icon || '🤖' }}</span>
              <span class="rd-tool-name">{{ a.name }}</span>
            </label>
          </div>

          <!-- 设置 -->
          <div class="group-settings-inline">
            <div class="group-setting-row">
              <span>同时回复数</span>
              <select v-model.number="groupSettings.maxRoles" @change="saveGroupSettings" class="rd-input" style="width:auto;padding:4px 8px;font-size:12px">
                <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>
            <div class="group-setting-row">
              <span>角色互评</span>
              <input type="checkbox" v-model="groupSettings.interReview" @change="saveGroupSettings" />
            </div>
          </div>
        </div>
        <div class="role-dialog-actions">
          <button class="setting-btn primary" @click="showGroupManager = false">完成</button>
        </div>
      </div>
    </div>

    <Transition name="settings">
      <SettingsPanel v-if="showSettings" @done="showSettings = false" />
    </Transition>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import gsap from 'gsap'
import { marked } from 'marked'
import SettingsPanel from './components/SettingsPanel.vue'
import AgentSteps from './components/AgentSteps.vue'
import { animSpeed, Spring } from './animations/gsap'
import { MessageCircle, Users, Settings, Plus, Sparkles, Mic, Brain, Check, ArrowUp } from 'lucide-vue-next'

marked.setOptions({ breaks: true, gfm: true })

function isStreamingMsg(msg, idx) {
  return idx === conv.value.messages.length - 1 && loading.value && msg.role === 'assistant'
}

function renderMarkdown(text) {
  if (!text) return ''
  try { return marked.parse(text) } catch { return text }
}

const CHARACTERS = {
  claude: { icon: '🦞', color: '#B7A48E', name: 'Clawd', desc: '沉稳睿智，擅长深度分析' },
  deepseek: { icon: '🐟', color: '#9BB7AA', name: '小鱼', desc: '灵动轻盈，中文理解超群' },
  openai: { icon: '⌨️', color: '#9DC0AF', name: 'Coco', desc: '均衡全面，创意无限' },
}

function charIcon(c) {
  const p = c?.provider || 'deepseek'
  return (CHARACTERS[p] || CHARACTERS.deepseek).icon
}

const MODELS_BY_PROVIDER = {
  claude: [
    { value: 'claude-sonnet-4-20250506', label: 'Claude-Sonnet-4' },
    { value: 'claude-opus-4-7', label: 'Claude-Opus-4.7' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude-Haiku-4.5' },
  ],
  deepseek: [
    { value: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },
  ],
  openai: [
    { value: 'gpt-4o-mini', label: 'GPT-4o-Mini' },
    { value: 'gpt-4o', label: 'GPT-4o' },
  ],
}

const currentModels = computed(() => {
  return MODELS_BY_PROVIDER[conv.value.provider] || MODELS_BY_PROVIDER.claude
})

const convModel = computed({
  get() {
    const c = conv.value
    if (c._model) return c._model
    const saved = localStorage.getItem('llm-model')
    if (saved && currentModels.value.some(m => m.value === saved)) return saved
    return currentModels.value[0]?.value || ''
  },
  set(val) {
    conv.value._model = val
    // 立即持久化到 localStorage + 主进程配置文件，防止被旧 autoSave 覆盖
    localStorage.setItem('llm-model', val)
    window.electronAPI?.loadConfig().then(cfg => {
      if (cfg) {
        cfg.model = val
        window.electronAPI?.saveConfig(cfg)
      }
    })
  },
})

function fmtTime(ts) {
  const d = new Date(ts)
  const isToday = d.toDateString() === new Date().toDateString()
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function getNextId() { return Math.max(1, ...convs.value.map(c => c.id)) + 1 }
const activeAgentId = ref(localStorage.getItem('active-agent-id') || '')
const convs = ref([
  { id: 1, title: '对话', agentId: activeAgentId.value, provider: localStorage.getItem('llm-provider') || 'deepseek', messages: [], history: [], mode: 'chat' },
])

// 按当前视图模式 + 当前 Agent 过滤对话
const viewConvs = computed(() =>
  convs.value.filter(c =>
    (c.mode || 'chat') === activeView.value &&
    (!activeAgentId.value || !c.agentId || c.agentId === activeAgentId.value)
  )
)
const viewIdx = ref(0)
const conv = computed(() => viewConvs.value[viewIdx.value] || convs.value[0])

// 监听 Agent 切换，切换到对应 Agent 的对话
watch(activeAgentId, (newId) => {
  if (!newId) return
  const agentConvs = convs.value.filter(c => c.agentId === newId)
  if (agentConvs.length === 0) {
    // Create default conversation for this agent
    const newConv = { id: getNextId(), title: '对话', agentId: newId, messages: [], history: [], mode: 'chat' }
    convs.value.push(newConv)
    viewIdx.value = convs.value.indexOf(newConv)
  } else {
    viewIdx.value = convs.value.indexOf(agentConvs[0])
  }
  // Poll for active agent ID changes (from settings panel)
  const stored = localStorage.getItem('active-agent-id')
  if (stored !== activeAgentId.value) activeAgentId.value = stored
})

// Poll localStorage for agent changes from settings panel
setInterval(() => {
  const stored = localStorage.getItem('active-agent-id')
  if (stored && stored !== activeAgentId.value) {
    activeAgentId.value = stored
  }
}, 2000)

// 聊天窗口拖动
let isDraggingChat = false, chatDragStartX = 0, chatDragStartY = 0
function onTitleMouseDown(e) {
  if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return
  isDraggingChat = true
  chatDragStartX = e.screenX
  chatDragStartY = e.screenY
  document.addEventListener('mousemove', onTitleMouseMove)
  document.addEventListener('mouseup', onTitleMouseUp)
}
function onTitleMouseMove(e) {
  if (!isDraggingChat) return
  const dx = e.screenX - chatDragStartX
  const dy = e.screenY - chatDragStartY
  chatDragStartX = e.screenX
  chatDragStartY = e.screenY
  window.electronAPI?.moveWindow(dx, dy)
}
function onTitleMouseUp() {
  isDraggingChat = false
  document.removeEventListener('mousemove', onTitleMouseMove)
  document.removeEventListener('mouseup', onTitleMouseUp)
}

const loading = ref(false)
const showSettings = ref(false)
const agentOnline = ref(false)
const statusText = ref('在线')

// Health check every 30s
setInterval(async () => {
  try { const r = await window.electronAPI?.agentPing(); agentOnline.value = !!r?.ready }
  catch { agentOnline.value = false }
}, 30000)
// Initial check on mount
;(async () => { try { const r = await window.electronAPI?.agentPing(); agentOnline.value = !!r?.ready } catch {} })()
const text = ref('')

// ── 侧边菜单 ──
const activeView = ref('chat')
const activeSubView = ref('')
const menuItems = [
  { id: 'chat', icon: MessageCircle, label: '对话' },
  { id: 'roles', icon: Users, label: '角色' },
  { id: 'groupchat', icon: Sparkles, label: '群聊' },
]

const lastGroupChatError = ref('')
const pendingPlan = ref(null)
const planConvId = ref('')
const collabSteps = ref([])       // [{title, assigned_to, status: 'pending'|'running'|'done'}]
const collabActive = ref(false)   // true during collaboration execution

function resetCollabProgress() {
  collabSteps.value = []
  collabActive.value = false
}

function confirmPlan(confirmed) {
  if (planConvId.value) {
    window.electronAPI?.agentConfirmPlan(planConvId.value, confirmed)
  }
  pendingPlan.value = null
}

// 群聊设置
const groupSettings = reactive({
  maxRoles: parseInt(localStorage.getItem('gs-max-roles') || '3'),
  mode: localStorage.getItem('gs-mode') || 'discussion',
  interReview: localStorage.getItem('gs-inter-review') === 'true',
})

function saveGroupSettings() {
  localStorage.setItem('gs-max-roles', String(groupSettings.maxRoles))
  localStorage.setItem('gs-mode', groupSettings.mode)
  localStorage.setItem('gs-inter-review', String(groupSettings.interReview))
}

function switchView(id) {
  // 角色管理 → 弹窗
  if (id === 'roles') { openRoleManager(); return }
  // 主视图切换
  if (id === activeView.value) {
    // 点击已激活的主菜单: 切到默认子视图
    const item = menuItems.find(m => m.id === id)
    if (item?.children) {
      activeSubView.value = item.children[0].id
    }
    return
  }
  activeView.value = id
  // 默认子视图
  const item = menuItems.find(m => m.id === id)
  activeSubView.value = item?.children ? item.children[0].id : ''
  // 对话模式的对话切换
  if (id === 'chat' || id === 'groupchat') {
    const matching = convs.value.filter(c => (c.mode || 'chat') === id)
    if (matching.length > 0) {
      viewIdx.value = 0
    } else {
      const provider = localStorage.getItem('llm-provider') || 'deepseek'
      const modeLabel = id === 'groupchat' ? '群聊' : '对话'
      const same = convs.value.filter(c => c.mode === id)
      const t = same.length === 0 ? modeLabel : `${modeLabel} ${getNextId()}`
      convs.value.push({ id: getNextId(), title: t, provider, messages: [], history: [], mode: id })
		}
	}
} 

// ── Agent 系统 (从服务端 AgentManager 获取) ──
const allAgents = ref([])
const activeGroupAgentIds = ref(loadGroupAgentIds())
const showRoleManager = ref(false)
const showGroupManager = ref(false)
const showAgentPickerInManager = ref(false)

const activeGroupAgents = computed(() =>
  allAgents.value.filter(a => activeGroupAgentIds.value.includes(a.id))
)
const inactiveGroupAgents = computed(() =>
  allAgents.value.filter(a => !activeGroupAgentIds.value.includes(a.id))
)

function loadGroupAgentIds() {
  try {
    const stored = localStorage.getItem('active-group-agent-ids')
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  // Default: activate all built-in agents for group chat
  return ['__builtin_manager__', '__builtin_researcher__', '__builtin_executor__', '__builtin_reviewer__', '__builtin_memory_keeper__']
}

function saveGroupAgentIds() {
  localStorage.setItem('active-group-agent-ids', JSON.stringify(activeGroupAgentIds.value))
}

async function loadAllAgents() {
  try {
    const result = await window.electronAPI?.agentList()
    allAgents.value = result?.data?.agents || result?.agents || []
  } catch { allAgents.value = [] }
}

function openRoleManager() {
  loadAllAgents()
  showRoleManager.value = true
}

function openSettingsToCreate() {
  showRoleManager.value = false
  showSettings.value = true
}

function toggleGroupAgent(id) {
  const idx = activeGroupAgentIds.value.indexOf(id)
  if (idx >= 0) activeGroupAgentIds.value.splice(idx, 1)
  else activeGroupAgentIds.value.push(id)
  saveGroupAgentIds()
}

function parseMentions(t) {
  const re = /@(\S+)/g
  const ids = []
  let m
  while ((m = re.exec(t)) !== null) {
    const found = allAgents.value.find(a => a.name === m[1] || a.id === m[1] || a.name.startsWith(m[1]))
    if (found) ids.push(found.id)
  }
  return ids
}

// 语音输入
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const supportsSpeech = ref(!!SpeechRecognition)
const isRecording = ref(false)
let recognition = null

function toggleSpeech() {
  if (isRecording.value) { stopSpeech(); return }
  if (!SpeechRecognition) return
  recognition = new SpeechRecognition()
  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = 'zh-CN'
  recognition.onresult = (e) => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) interim += e.results[i][0].transcript
    text.value = interim
  }
  recognition.onerror = () => { stopSpeech() }
  recognition.onend = () => { isRecording.value = false; recognition = null }
  recognition.start()
  isRecording.value = true
}

function stopSpeech() {
  if (recognition) { recognition.stop(); recognition = null }
  isRecording.value = false
}

const ta = ref(null)
const msgEnd = ref(null)
const msgArea = ref(null)
const char = computed(() => CHARACTERS[conv.value.provider] || CHARACTERS.claude)
// Welcome screen uses active agent's name/icon, not provider character
const welcomeName = computed(() => {
  const ag = allAgents.value.find(a => a.isActive)
  return ag?.name || char.value.name
})
const welcomeIcon = computed(() => {
  const ag = allAgents.value.find(a => a.isActive)
  return ag?.icon || char.value.icon
})
const userAvatar = ref(localStorage.getItem('user-avatar') || '')
const avatarColor = ref(localStorage.getItem('user-avatar-color') || '#6366F1')
const pendingImages = ref([])
const ctxMenu = ref(null)

// Agent 状态
const sendState = ref('idle') // idle | loading | sent
const agentSteps = ref([])
const pendingApproval = ref(null)
const reasoningOn = ref(true)
const elapsedTime = ref(0)
let elapsedTimer = null
const reasoningText = ref('')
const reasoningExpanded = ref(true)

function animateDialog(selector) {
  nextTick(() => {
    const el = document.querySelector(selector)
    if (!el) return
    const s = animSpeed()
    gsap.from(el, {
      y: 24, scale: 0.94, opacity: 0,
      duration: 0.4 / s,
      ease: 'back.out(1.3)',
    })
  })
}

function fmtApprovalInput(input) {
  if (!input) return ''
  if (typeof input === 'string') return input
  try { return JSON.stringify(input, null, 2) } catch { return String(input) }
}

function approveTool(approved) {
  if (pendingApproval.value && pendingApproval.value.approvalId) {
    if (!approved) {
      // shake the dialog before closing
      const el = document.querySelector('.approval-dialog')
      if (el) { el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 400) }
      setTimeout(() => {
        window.electronAPI?.agentApproveTool(pendingApproval.value.approvalId, approved)
        agentSteps.value.push({ type: 'thought', content: '用户拒绝了执行' })
        pendingApproval.value = null
      }, 300)
      return
    }
    window.electronAPI?.agentApproveTool(pendingApproval.value.approvalId, approved)
    agentSteps.value.push({ type: 'thought', content: '用户批准了执行' })
    pendingApproval.value = null
  }
}

function startTimer() { elapsedTime.value = 0; elapsedTimer = setInterval(() => { elapsedTime.value++ }, 1000) }
function stopTimer() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }; elapsedTime.value = 0 }

function stopGeneration() {
  if (activeAbortController) { activeAbortController.abort(); activeAbortController = null }
  stopTimer()
  loading.value = false
  sendState.value = 'idle'
  statusText.value = '在线'
  agentSteps.value = []
  reasoningText.value = ''
  reasoningExpanded.value = false
  pendingApproval.value = null
  const c = conv.value
  if (c.messages.length > 0 && c.messages[c.messages.length - 1].role === 'assistant') c.messages.pop()
}

const renaming = ref(null)
const renameText = ref('')
const renameInput = ref(null)

// IntersectionObserver: 只有用户在底部时才自动滚动
let userAtBottom = true
let scrollObserver = null
function setupScrollObserver() {
  if (!msgArea.value) return
  if (scrollObserver) scrollObserver.disconnect()
  scrollObserver = new IntersectionObserver(
    ([entry]) => { userAtBottom = entry.isIntersecting },
    { root: msgArea.value, threshold: 0.1 }
  )
  if (msgEnd.value) scrollObserver.observe(msgEnd.value)
}
function smartScrollToBottom() {
  if (userAtBottom && msgEnd.value) {
    msgEnd.value.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }
}

watch(() => conv.value.messages.length, () => {
  nextTick(() => {
    smartScrollToBottom()

    // Animate new messages with GSAP spring entrance
    const rows = msgArea.value?.querySelectorAll('.message-row')
    if (rows && rows.length > 0) {
      const lastRow = rows[rows.length - 1]
      if (!lastRow.dataset.gsapAnimated) {
        lastRow.dataset.gsapAnimated = '1'
        const s = animSpeed()
        gsap.from(lastRow, {
          y: 18,
          opacity: 0,
          scale: 0.96,
          duration: Spring.snappy.duration / s,
          ease: Spring.snappy.ease,
        })
      }
    }
  })
})

watch(loading, (val) => { window.electronAPI?.notifyWorking(val) })

// ── GSAP tab pill transitions ──
function onTabBeforeEnter(el) {
  el.style.opacity = '0'
  el.style.transform = 'translateX(-12px) scale(0.9)'
}
function onTabEnter(el, done) {
  const s = animSpeed()
  gsap.to(el, {
    opacity: 1, x: 0, scale: 1,
    duration: 0.28 / s,
    ease: 'back.out(1.5)',
    onComplete: done,
  })
}
function onTabLeave(el, done) {
  const s = animSpeed()
  gsap.to(el, {
    opacity: 0, x: -6, scale: 0.93,
    duration: 0.18 / s,
    ease: 'power2.in',
    onComplete: done,
  })
}

let _lastAddConv = 0
function addNewConv() {
  if (Date.now() - _lastAddConv < 300) return
  _lastAddConv = Date.now()
  newConv(localStorage.getItem('llm-provider') || 'deepseek')
}
function newConv(provider) {
  if (convs.value.length >= 8) return
  const modeLabel = activeView.value === 'groupchat' ? '群聊' : '对话'
  const sameMode = convs.value.filter(c => c.mode === activeView.value)
  const title = sameMode.length === 0 ? modeLabel : `${modeLabel} ${getNextId()}`
  convs.value.push({ id: getNextId(), title, agentId: activeAgentId.value, provider, messages: [], history: [], mode: activeView.value })
}
function switchConv(i) { if (i !== viewIdx.value) viewIdx.value = i }
let _lastCloseConv = 0
function closeConv(i) {
  if (Date.now() - _lastCloseConv < 300) return
  _lastCloseConv = Date.now()
  const vc = viewConvs.value
  if (vc.length <= 1) return
  const real = vc[i]
  const globalIdx = convs.value.findIndex(c => c.id === real.id)
  convs.value.splice(globalIdx, 1)
  const newVc = viewConvs.value
  if (viewIdx.value >= newVc.length) viewIdx.value = newVc.length - 1
  ctxMenu.value = null
}
function clearConv() { const c = conv.value; c.messages = []; c.history = []; c.title = (c.mode === 'groupchat' ? '群聊 ' : '对话 ') + c.id }
function renameConv(i) { ctxMenu.value = null; renaming.value = i; renameText.value = viewConvs.value[i].title; nextTick(() => renameInput.value?.focus()) }
function doRename() {
  const t = renameText.value.trim()
  if (t && renaming.value !== null) {
    const vc = viewConvs.value
    if (vc[renaming.value]) vc[renaming.value].title = t
  }
  renaming.value = null
}

function onKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); clearConv(); return }
  if ((e.metaKey || e.ctrlKey || e.shiftKey) && e.key === 'Enter') return
  if (e.key === 'Enter') { e.preventDefault(); handleSend() }
}

function onPaste(e) {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = (ev) => { pendingImages.value.push({ data: ev.target.result, file }) }
      reader.readAsDataURL(file)
    }
  }
}

function copyMsg(content) {
  navigator.clipboard.writeText(content).then(() => {
    for (const msg of conv.value.messages) {
      if (msg.content === content) { msg._copied = true; setTimeout(() => { msg._copied = false }, 1800); break }
    }
  }).catch(() => {})
}

async function handleSend() {
  console.log('[App] handleSend 触发')
  window.electronAPI?.agentPing().then(r => console.log('[App] handleSend ping:', r))
  const t = text.value.trim()
  const hasImgs = pendingImages.value.length > 0
  if (!t && !hasImgs) { console.log('[App] handleSend: 空消息, 跳过'); return }

  let userContent = t
  const imgDataList = hasImgs ? pendingImages.value.map(img => img.data) : []

  text.value = ''
  pendingImages.value = []

  const c = conv.value
  const userMsg = { role: 'user', content: userContent, timestamp: new Date() }
  if (imgDataList.length > 0) {
    userMsg.images = imgDataList
    // 在聊天框里也能看到自己发的图片
    userMsg._previewImages = imgDataList
  }
  c.messages.push(userMsg)
  const historyMsg = { role: 'user', content: userContent }
  if (imgDataList.length > 0) {
    historyMsg.images = imgDataList
    historyMsg.content = userContent || '请分析这张图片'
  }
  c.history.push(historyMsg)
  loading.value = true
  sendState.value = 'loading'
  statusText.value = '工作中...'
  reasoningText.value = ''
  reasoningExpanded.value = true
  startTimer()

  let savedConfig = await window.electronAPI?.loadConfig()
  // Fallback: safeStorage 解密可能失败，localStorage 有备份
  if (!savedConfig) {
    const saved = localStorage.getItem('llm-config')
    if (saved) { try { savedConfig = JSON.parse(saved) } catch { /* ignore */ } }
  }
  if (!savedConfig) { showSettings.value = true; stopTimer(); loading.value = false; sendState.value = 'idle'; statusText.value = '在线'; return }

  if (convModel.value) savedConfig.model = convModel.value
  savedConfig.reasoningEffort = reasoningOn.value ? 'max' : 'none'

  // 群聊模式
  if (activeView.value === 'groupchat') {
    const mentionedIds = parseMentions(t)
    const ok = await runGroupChatMode(c, savedConfig, mentionedIds)
    loading.value = false
    statusText.value = '在线'
    stopTimer()
    if (ok) return
    // 群聊失败时不要 fallthrough 到单 Agent
    const agentCount = activeGroupAgentIds.value.length
    const reason = agentCount === 0
      ? '群聊中没有激活的角色。请点击侧边栏"角色"，勾选至少一个角色的"群聊"开关。'
      : `群聊请求失败: ${lastGroupChatError.value || '请检查 Agent 服务是否就绪'}（当前 ${agentCount} 个角色选中）。`
    c.messages.push({ role: 'assistant', content: reason, timestamp: new Date() })
    return
  }

  const agentOk = await runAgentMode(c, savedConfig)
  if (agentOk) return

  await runLegacyMode(c)
}

// 监听器管理
let activeAbortController = null
function cleanupListeners(unsubs) {
  for (const u of (unsubs || [])) { try { u() } catch (_) {} }
  if (activeAbortController) { activeAbortController.abort(); activeAbortController = null }
}

async function runAgentMode(c, config) {
  let _msgIdx = -1
  let unsubs = []
  // 先清理旧监听器, 防止快速连续发消息时覆盖
  cleanupListeners(null)
  activeAbortController = new AbortController()
  const signal = activeAbortController.signal

  try {
    console.log('[App] runAgentMode 开始, 检查 agent 就绪...')
    const ready = await window.electronAPI?.agentGetReady()
    if (!ready?.ready) { console.log('[App] agent 未就绪, 降级 legacy'); return false }

    const steps = []
    agentSteps.value = steps

    let fullContent = ''
    let hasModelReasoning = false
    let firstContent = true
    let msgCreated = false

    function ensureMsg() {
      if (!msgCreated) {
        c.messages.push({ role: 'assistant', content: '', timestamp: new Date(), _reasoning: '', _reasoningOpen: true })
        _msgIdx = c.messages.length - 1
        msgCreated = true
      }
    }
    // 局部 reasoning 变量防竞态
    const localReasoning = { text: '' }

    // 自动滚动到底部
    function scrollDown() {
      nextTick(() => { msgEnd.value?.scrollIntoView({ behavior: 'smooth' }) })
    }

    unsubs.push(window.electronAPI.onAgentThought((data) => {
      const d = data?.data || data
      const text = typeof d === 'string' ? d : d?.content || ''
      if (text) {
        steps.push({ type: 'thought', content: text })
        scrollDown()
      }
    }))

    unsubs.push(window.electronAPI.onAgentAction((data) => {
      const d = data?.data || data
      steps.push({ type: 'action', tool: d?.tool || '未知工具', input: d?.input || d, round: d?.round || '' })
      scrollDown()
    }))

    unsubs.push(window.electronAPI.onAgentObservation((data) => {
      const d = data?.data || data
      steps.push({ type: 'observation', tool: d?.tool || '工具', content: d?.content || String(d), round: d?.round || '' })
      scrollDown()
    }))

    unsubs.push(window.electronAPI.onAgentChunk((data) => {
      if (signal.aborted) return
      ensureMsg()
      const d = data?.data || data
      if (firstContent) { fullContent = ''; firstContent = false }
      fullContent += d?.content || ''
      if (_msgIdx >= 0 && c.messages[_msgIdx]) c.messages[_msgIdx].content = fullContent
      scrollDown()
    }))

    unsubs.push(window.electronAPI.onAgentReasoningChunk((data) => {
      if (signal.aborted) return
      ensureMsg()
      const d = data?.data || data
      const chunk = d?.content || ''
      if (chunk === '.') return  // 只过滤单点(DeepSeek thinking 残留)
      hasModelReasoning = true
      localReasoning.text += chunk
      reasoningText.value = localReasoning.text
      scrollDown()
    }))

    unsubs.push(window.electronAPI.onAgentDone((data) => {
      if (signal.aborted) return
      ensureMsg()
      const d = data?.data || data
      if (d?.content && _msgIdx >= 0 && c.messages[_msgIdx] && !c.messages[_msgIdx].content)
        c.messages[_msgIdx].content = d.content
      if (_msgIdx >= 0 && c.messages[_msgIdx]) {
        c.messages[_msgIdx].elapsed = elapsedTime.value
        c.messages[_msgIdx]._steps = [...steps]
      }
    }))

    unsubs.push(window.electronAPI.onAgentError((data) => {
      if (signal.aborted) return
      ensureMsg()
      const d = data?.data || data
      if (_msgIdx >= 0 && c.messages[_msgIdx])
        c.messages[_msgIdx].content = `❌ ${d?.content || 'Agent 执行出错'}`
    }))

    unsubs.push(window.electronAPI.onAgentToolApprovalRequest((data) => {
      const d = data?.data || data
      pendingApproval.value = { approvalId: d?.approval_id || '', tool: d?.tool || '', input: d?.input || {} }
    }))

    const plainHistory = JSON.parse(JSON.stringify(c.history))
    const plainConfig = JSON.parse(JSON.stringify(config))
    plainConfig.userNickname = localStorage.getItem('user-nickname') || ''
    plainConfig.agentPersonality = localStorage.getItem('agent-personality') || 'default'
    plainConfig.customPersonalities = JSON.parse(localStorage.getItem('custom-personalities') || '[]')
    const result = await window.electronAPI.agentChat(plainConfig, plainHistory, `conv-${c.id}`)

    cleanupListeners(unsubs)
    const savedReasoning = localReasoning.text || reasoningText.value
    if (_msgIdx >= 0 && c.messages[_msgIdx]?.role === 'assistant' && savedReasoning) {
      c.messages[_msgIdx] = {
        ...c.messages[_msgIdx],
        _reasoning: savedReasoning,
        _reasoningOpen: true,
      }
    }
    reasoningText.value = ''
    agentSteps.value = []
    reasoningExpanded.value = false
    pendingApproval.value = null
    stopTimer()
    loading.value = false
    sendState.value = 'sent'
    setTimeout(() => { if (sendState.value === 'sent') sendState.value = 'idle' }, 1500)
    statusText.value = '在线'
    activeAbortController = null

    // 优先用流式事件累积的内容, fallback 到 agentChat 返回值
    let _finalContent = c.messages[_msgIdx]?.content || ''
    if (!_finalContent && result?.content) {
      _finalContent = result.content
      c.messages[_msgIdx].content = _finalContent
    }
    if (_finalContent && !_finalContent.startsWith('❌')) c.history.push({ role: 'assistant', content: _finalContent })
    return true
  } catch (err) {
    console.error('[Agent] 失败,降级:', err)
    if (_msgIdx >= 0 && c.messages[_msgIdx]?.role === 'assistant') c.messages.pop()
    return false
  } finally {
    cleanupListeners(unsubs)
    agentSteps.value = []
    pendingApproval.value = null
    activeAbortController = null
  }
}

async function runGroupChatMode(c, config, mentionedIds) {
  try {
    const ready = await window.electronAPI?.agentGetReady()
    if (!ready?.ready) { lastGroupChatError.value = 'Agent 服务未就绪'; return false }

    const steps = []
    agentSteps.value = steps

    const plainHistory = JSON.parse(JSON.stringify(c.history))
    const plainConfig = JSON.parse(JSON.stringify(config))
    plainConfig.userNickname = localStorage.getItem('user-nickname') || ''
    plainConfig.agentPersonality = localStorage.getItem('agent-personality') || 'default'
    plainConfig.customPersonalities = JSON.parse(localStorage.getItem('custom-personalities') || '[]')
    plainConfig.interReview = groupSettings.interReview
    plainConfig.maxRoles = groupSettings.maxRoles

    const unsubs = []
    const expertReplies = []
    // 本轮次每个专家的消息索引映射 — 避免匹配到旧消息
    const turnMsgIdx = {}

    const isCollab = groupSettings.mode === 'collaboration'

    unsubs.push(window.electronAPI.onCoordinatorStart((data) => {
      const d = data?.data || data
      if (isCollab && d?.phases) {
        pendingPlan.value = null  // Clear confirmation card
        collabActive.value = true
        collabSteps.value = d.phases.map(p => ({ title: p.title, assigned_to: p.assigned_to, status: 'pending' }))
      } else if (d?.experts) {
        steps.push({ type: 'thought', content: '已激活: ' + d.experts.map(e => e.name).join('、') })
      }
    }))

    unsubs.push(window.electronAPI.onCoordinatorInfo((data) => {
      const d = data?.data || data
      if (isCollab && d?.phase != null && d?.phase_status) {
        const cur = collabSteps.value[d.phase - 1]
        if (cur) cur.status = d.phase_status
      }
      if (d?.content) steps.push({ type: 'thought', content: d.content })
    }))

    unsubs.push(window.electronAPI.onExpertThought((data) => {
      const d = data?.data || data
      if (d?.content) steps.push({ type: 'thought', content: `${d?.expert_name}: ${d.content}` })
    }))

    unsubs.push(window.electronAPI.onExpertReasoning((data) => {
      const d = data?.data || data
      if (d?.content) steps.push({ type: 'thought', content: `${d?.expert_name} 思考: ${d.content.slice(0, 100)}`, expert: d?.expert_name })
    }))

    unsubs.push(window.electronAPI.onExpertAction((data) => {
      const d = data?.data || data
      steps.push({ type: 'action', tool: d?.tool, input: d?.input, expert: d?.expert_name })
    }))

    unsubs.push(window.electronAPI.onExpertObservation((data) => {
      const d = data?.data || data
      steps.push({ type: 'observation', tool: d?.tool, content: d?.content, expert: d?.expert_name })
    }))

    // 流式输出: 仅单专家时 Python 会发 expert_chunk
    unsubs.push(window.electronAPI.onExpertChunk((data) => {
      const d = data?.data || data
      if (!d?.content) return
      const eid = d.expert_id
      if (eid in turnMsgIdx) {
        c.messages[turnMsgIdx[eid]].content += d.content
      } else {
        const roleAgent = allAgents.value.find(a => a.id === eid)
        turnMsgIdx[eid] = c.messages.length
        c.messages.push({
          role: 'assistant', content: d.content, timestamp: new Date(),
          _expert: {
            id: eid, name: d.expert_name,
            icon: d.expert_icon, color: d.expert_color,
            avatarUrl: roleAgent?.avatarUrl || '',
          },
        })
      }
    }))

    unsubs.push(window.electronAPI.onExpertDone((data) => {
      const d = data?.data || data
      if (d?.content) {
        // 同一专家多轮回复: 保留最新轮次
        const eid = d.expert_id
        const existingIdx = expertReplies.findIndex(r => r.expert_id === eid)
        if (existingIdx >= 0) {
          expertReplies[existingIdx] = d
        } else {
          expertReplies.push(d)
        }
        const roleAgent = allAgents.value.find(a => a.id === eid)
        const msg = {
          role: 'assistant', content: d.content, timestamp: new Date(), elapsed: d.elapsed,
          _expert: {
            id: eid, name: d.expert_name,
            icon: d.expert_icon, color: d.expert_color,
            avatarUrl: roleAgent?.avatarUrl || '',
          },
        }
        // 用本轮消息索引替换，不给上一轮的旧消息
        if (eid in turnMsgIdx) {
          c.messages[turnMsgIdx[eid]] = msg
        } else {
          turnMsgIdx[eid] = c.messages.length
          c.messages.push(msg)
        }
      }
    }))

    unsubs.push(window.electronAPI.onExpertError((data) => {
      const d = data?.data || data
      const errMsg = `❌ ${d?.expert_id || '专家'} 出错: ${d?.error || '未知'}`
      steps.push({ type: 'thought', content: errMsg })
      c.messages.push({ role: 'assistant', content: errMsg, timestamp: new Date() })
    }))

    unsubs.push(window.electronAPI.onCoordinatorDone((data) => {
      const d = data?.data || data
      if (d?.replies?.length === 0) {
        c.messages.push({ role: 'assistant', content: '抱歉，群聊专家们暂时无法回答这个问题，试试换种问法？', timestamp: new Date() })
      }
    }))

    // 互评回复 —— 以缩进子消息展示，不替换第一次回复
    unsubs.push(window.electronAPI.onCoordinatorReview((data) => {
      const d = data?.data || data
      if (!d?.reviews?.length) return
      for (const rv of d.reviews) {
        if (!rv.content) continue
        c.messages.push({
          role: 'assistant', content: rv.content, timestamp: new Date(),
          _expert: {
            id: rv.expert_id, name: rv.expert_name,
            icon: rv.expert_icon, color: rv.expert_color,
            avatarUrl: (allAgents.value.find(x => x.id === rv.expert_id) || {}).avatarUrl || '',
          },
          _review: true,
        })
      }
    }))

    unsubs.push(window.electronAPI.onPlanReady((data) => {
      const d = data?.data || data
      if (d?.plan) {
        pendingPlan.value = d.plan
        planConvId.value = `group-${c.id}`
      }
    }))

    unsubs.push(window.electronAPI.onCoordinatorError((data) => {
      const d = data?.data || data
      pendingPlan.value = null
      resetCollabProgress()
      c.messages.push({ role: 'assistant', content: '群聊模式出问题了: ' + (d?.content || '未知错误') + '。已切回单 Agent 模式。', timestamp: new Date() })
    }))

    const agentIds = activeGroupAgentIds.value.length > 0
      ? [...new Set(activeGroupAgentIds.value)]
      : null

    if (typeof window.electronAPI?.agentChatGroup !== 'function') {
      lastGroupChatError.value = 'agentChatGroup API 未暴露, preload 文件可能过期'
      return false
    }

    await window.electronAPI.agentChatGroup(
      plainConfig, plainHistory, `group-${c.id}`, agentIds,
      mentionedIds.length > 0 ? mentionedIds : null,
      JSON.parse(JSON.stringify(groupSettings)),
    )

    for (const u of unsubs) u()
    agentSteps.value = []
    resetCollabProgress()
    stopTimer()
    loading.value = false
    sendState.value = 'sent'
    setTimeout(() => { if (sendState.value === 'sent') sendState.value = 'idle' }, 1500)
    statusText.value = '在线'

    for (const r of expertReplies) {
      if (r?.content && !r.content.startsWith('❌')) {
        const ag = allAgents.value.find(x => x.id === r.expert_id)
        c.history.push({
          role: 'assistant', content: r.content,
          _expert: {
            id: r.expert_id, name: r.expert_name,
            icon: r.expert_icon, color: r.expert_color,
            avatarUrl: ag?.avatarUrl || '',
          },
        })
      }
    }
    return true
  } catch (err) {
    console.error('[GroupChat] 失败:', err)
    lastGroupChatError.value = err.message || String(err)
    resetCollabProgress()
    return false
  }
}

async function runLegacyMode(c) {
  try {
    const { llmService } = await import('./lib/llm/LLMProvider')
    if (!llmService.isInitialized()) { showSettings.value = true; loading.value = false; sendState.value = 'idle'; statusText.value = '在线'; return }
    let full = ''
    c.messages.push({ role: 'assistant', content: '', timestamp: new Date() })
    await llmService.chat(
      [{ role: 'system', content: '你是一个桌面上的智能助手。回复简洁高效。' }, ...c.history],
      (chunk) => { full += chunk; c.messages[c.messages.length - 1].content = full }
    )
    c.history.push({ role: 'assistant', content: full })
  } catch (err) {
    c.messages.push({ role: 'assistant', content: `❌ ${err}`, timestamp: new Date() })
  } finally { stopTimer(); loading.value = false; sendState.value = 'idle'; statusText.value = '在线' }
}

let removeFileFed = null
onMounted(async () => {
  // 预加载 Agent 列表
  loadAllAgents()

  // 初始化主题
  const theme = localStorage.getItem('app-theme') || 'system'
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark)
  document.documentElement.classList.toggle('dark', isDark)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem('app-theme') || 'system') === 'system') {
      document.documentElement.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches)
    }
  })

  let savedConfig = await window.electronAPI?.loadConfig()
  if (!savedConfig) {
    const saved = localStorage.getItem('llm-config')
    if (saved) { try { savedConfig = JSON.parse(saved) } catch { /* ignore */ } }
  }
  if (savedConfig) {
    try { const { llmService } = await import('./lib/llm/LLMProvider'); llmService.restore(savedConfig) } catch { /* ignore */ }
  }
  removeFileFed = window.electronAPI?.onFileFed?.((data) => { feedFileToConversation(data) })

  nextTick(() => setupScrollObserver())

  // ── GSAP: Welcome screen staggered entrance ──
  nextTick(() => {
    const welcome = msgArea.value?.querySelector('.welcome-placeholder')
    if (welcome) {
      const s = animSpeed()
      const tl = gsap.timeline()
      tl.from(welcome.querySelector('.welcome-avatar-ring'), {
        scale: 0, opacity: 0, duration: 0.5 / s, ease: 'back.out(2)',
      })
      tl.from(welcome.querySelector('.welcome-title'), {
        y: 12, opacity: 0, duration: 0.4 / s, ease: 'power2.out',
      }, '-=0.15')
      tl.from(welcome.querySelector('.welcome-sub'), {
        y: 8, opacity: 0, duration: 0.3 / s, ease: 'power2.out',
      }, '-=0.2')

      gsap.to(welcome.querySelector('.welcome-avatar-ring'), {
        scale: 1.005, duration: 4 / s, ease: 'power1.inOut', repeat: -1, yoyo: true,
      })
    }
  })

  // ── GSAP: Dialog entrance watchers ──
  watch(showRoleManager, (v) => { if (v) animateDialog('.dialog-backdrop .role-dialog') })
  watch(showRoleDialog, (v) => { if (v) animateDialog('.dialog-backdrop .role-dialog') })
  watch(showGroupManager, (v) => { if (v) animateDialog('.dialog-backdrop .role-dialog') })
  watch(renaming, (v) => { if (v !== null) nextTick(() => animateDialog('.rename-dialog')) })
  watch(pendingApproval, (v) => { if (v) nextTick(() => animateDialog('.approval-dialog')) })
})
onUnmounted(() => { removeFileFed?.(); stopSpeech() })

async function feedFileToConversation(data) {
  const c = conv.value
  const displayName = data.name || '未知文件'
  let fileContent = ''
  if (window.electronAPI?.readFileContent) {
    const result = await window.electronAPI.readFileContent(data.path)
    if (result.success) fileContent = result.content
  }
  const userMsg = fileContent
    ? `📎 喂食了文件: ${displayName}\n\n\`\`\`\n${fileContent.slice(0, 3000)}\n\`\`\``
    : `📎 喂食了文件: ${displayName}（无法读取文件内容）`
  c.messages.push({ role: 'user', content: userMsg, timestamp: new Date() })
  c.history.push({ role: 'user', content: userMsg })
  loading.value = true; statusText.value = '工作中...'

  let savedConfig = await window.electronAPI?.loadConfig()
  if (!savedConfig) {
    const saved = localStorage.getItem('llm-config')
    if (saved) { try { savedConfig = JSON.parse(saved) } catch { /* ignore */ } }
  }
  if (!savedConfig) { showSettings.value = true; loading.value = false; sendState.value = 'idle'; statusText.value = '在线'; return }
  if (convModel.value) savedConfig.model = convModel.value

  const agentOk = await runAgentMode(c, savedConfig)
  if (agentOk) return

  try {
    const { llmService } = await import('./lib/llm/LLMProvider')
    if (!llmService.isInitialized()) { showSettings.value = true; loading.value = false; sendState.value = 'idle'; statusText.value = '在线'; return }
    let full = ''
    c.messages.push({ role: 'assistant', content: '', timestamp: new Date() })
    await llmService.chat(
      [{ role: 'system', content: '你是一个桌面上的智能助手。回复简洁高效。如果用户拖了一个文件给你，帮用户分析文件内容。' }, ...c.history],
      (chunk) => { full += chunk; c.messages[c.messages.length - 1].content = full }
    )
    c.history.push({ role: 'assistant', content: full })
    c.messages[c.messages.length - 1].elapsed = elapsedTime.value
  } catch (err) {
    c.messages.push({ role: 'assistant', content: `❌ ${err}`, timestamp: new Date() })
  } finally { stopTimer(); loading.value = false; sendState.value = 'idle'; statusText.value = '在线' }
}
</script>

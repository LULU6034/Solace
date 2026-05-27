<template>
  <div class="glass-window">
    <!-- 标题栏 -->
    <div class="pet-strip" :class="{ working: loading }">
      <span class="pet-name">✧ 小鱼 ✧</span>
      <div class="strip-right">
        <div class="strip-tool-badge">
          <span v-if="loading" class="spark">✦</span>
          <span>{{ loading ? '正在思考...' : '安心对话 · 手绘陪伴' }}</span>
        </div>
      </div>
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
              <span class="sidebar-item-icon">{{ item.icon }}</span>
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
            <span class="sidebar-item-icon">⚙</span>
            <span class="sidebar-item-label">设置</span>
          </button>
        </div>
      </nav>

      <!-- ═══ 主内容区 ═══ -->
      <div class="main-area">
        <!-- 标签栏 + 操作按钮 -->
        <div class="header-bar">
          <div class="conversation-pills">
            <TransitionGroup name="tab-slide">
              <div v-for="(c, i) in viewConvs" :key="c.id" class="pill-wrap"
                @contextmenu.prevent="ctxMenu = { idx: i, x: $event.clientX, y: $event.clientY }">
                <button class="conv-pill" :class="[
                  { active: i === viewIdx },
                  `provider-${c.provider}`
                ]" @click="switchConv(i)">
                  <span class="pill-icon">{{ charIcon(c) }}</span>
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
            <button class="add-btn" title="新建对话" @click="addNewConv">
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
            @click="closeConv(ctxMenu.idx)">关闭对话</button>
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

        <!-- 消息区 -->
        <div class="messages-area" ref="msgArea" @click="ctxMenu = null">
          <div v-if="conv.messages.length === 0" class="welcome-placeholder">
            <div class="welcome-ornament">✦</div>
            <div class="welcome-icon" :class="{ pulsing: true }"
              :style="{ background: char.color + '15' }">{{ char.icon }}</div>
            <div class="welcome-title">你好，我是 {{ char.name }}</div>
            <div class="welcome-sub">有什么可以帮你的？</div>
            <div class="welcome-doodle">
              <span>~</span><span>*</span><span>~</span>
            </div>
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
            <div v-else class="msg-avatar user-avatar"
              :style="userAvatar.startsWith('data:') ? {} : { background: avatarColor + '18' }">
              <img v-if="userAvatar.startsWith('data:')" :src="userAvatar" class="avatar-img" />
              <span v-else>{{ userAvatar }}</span>
            </div>
            <div class="bubble-wrap">
              <div class="bubble" :class="msg.role" :style="msg._expert ? { borderColor: msg._expert.color + '60' } : {}">
                <div v-if="msg.role === 'assistant'" class="msg-role" :style="msg._expert ? { color: msg._expert.color } : {}">
                  {{ msg._expert?.name || char.name }}</div>
                <div v-if="msg._reasoning" class="bubble-reasoning">
                  <button class="bubble-reasoning-toggle"
                    @click="msg._reasoningOpen = !msg._reasoningOpen">
                    <span>🧠 思考过程</span>
                    <span class="bubble-reasoning-arrow" :class="{ open: msg._reasoningOpen }">▾</span>
                  </button>
                  <div v-show="msg._reasoningOpen" class="bubble-reasoning-content">{{ msg._reasoning }}</div>
                </div>
                <div class="msg-text" v-html="renderMarkdown(msg.content)"></div>
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

          <AgentSteps v-if="loading && agentSteps.length > 0" :steps="agentSteps" />

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

          <div class="input-box">
            <textarea ref="ta" v-model="text"
              :placeholder="activeView === 'groupchat' ? '@专家名 提问，或用群聊模式...' : '写点什么吧...'"
              @keydown="onKeydown"
              @paste="onPaste" rows="1" />
            <div class="input-toolbar">
              <span v-if="activeView === 'groupchat'" class="group-mode-badge">🌐 群聊</span>
              <button v-if="supportsSpeech && !loading" class="mic-btn-inline"
                :class="{ recording: isRecording }"
                :title="isRecording ? '停止' : '语音'"
                @click="toggleSpeech">{{ isRecording ? '⬤' : '🎤' }}</button>
              <select class="model-select" v-model="convModel" :disabled="loading">
                <option v-for="m in currentModels" :key="m.value" :value="m.value">
                  {{ m.label }}
                </option>
              </select>
              <button class="reasoning-btn" :class="{ on: reasoningOn }"
                @click="reasoningOn = !reasoningOn"
                :title="reasoningOn ? '关闭推理' : '开启推理'">
                <svg class="bulb-svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <ellipse cx="12" cy="9" rx="6.5" ry="6.5" />
                  <path d="M8.5 15c0 1.5 1 2.5 2 3h3c1-.5 2-1.5 2-3" />
                  <line x1="9.5" y1="16.5" x2="14.5" y2="16.5" />
                  <line x1="10" y1="19.5" x2="14" y2="19.5" />
                  <line x1="12" y1="14.5" x2="12" y2="10.5" />
                  <line x1="10" y1="8" x2="8" y2="6" class="bulb-rays" />
                  <line x1="14" y1="8" x2="16" y2="6" class="bulb-rays" />
                  <line x1="7" y1="11" x2="4.5" y2="10.5" class="bulb-rays" />
                  <line x1="17" y1="11" x2="19.5" y2="10.5" class="bulb-rays" />
                </svg>
              </button>
              <button v-if="!loading" class="send-btn-inline"
                :disabled="!text.trim() && pendingImages.length === 0"
                @click="handleSend">发送 ✨</button>
              <button v-else class="stop-btn" @click="stopGeneration">
                停止 ⏹
              </button>
            </div>
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

    <!-- 角色管理弹窗 -->
    <div v-if="showRoleManager" class="dialog-backdrop" @click.self="showRoleManager = false">
      <div class="role-dialog" @click.stop>
        <div class="role-dialog-title">角色管理</div>
        <div class="role-dialog-body">
          <!-- 角色列表 -->
          <div class="role-manager-list">
            <div v-for="r in customRoles" :key="r.id"
              class="role-manager-item" @click="openRoleDialog(r)">
              <div v-if="r.avatarUrl" class="role-manager-avatar"
                :style="{ backgroundImage: 'url(' + r.avatarUrl + ')' }" />
              <span v-else class="role-manager-avatar role-manager-emoji"
                :style="{ background: r.color + '18' }">{{ r.icon }}</span>
              <div class="role-manager-info">
                <span class="role-manager-name">{{ r.name }}</span>
                <span class="role-manager-status" :class="{ active: r.auto_invoke }">
                  {{ r.auto_invoke ? '已激活' : '未激活' }}
                </span>
              </div>
              <button class="role-card-del" @click.stop="deleteRole(r.id)" title="删除">✕</button>
            </div>
            <div v-if="customRoles.length === 0" class="role-manager-empty">
              还没有角色，点击下方按钮创建
            </div>
          </div>
        </div>
        <div class="role-dialog-actions">
          <button class="setting-btn secondary" @click="showRoleManager = false">关闭</button>
          <button class="setting-btn primary" @click="openRoleDialog()">创建角色</button>
        </div>
      </div>
    </div>

    <!-- 角色编辑对话框 -->
    <div v-if="showRoleDialog" class="dialog-backdrop" @click="showRoleDialog = false">
      <div class="role-dialog" @click.stop>
        <div class="role-dialog-title">{{ editingRole ? '编辑角色' : '创建角色' }}</div>

        <div class="role-dialog-body">
          <!-- 头像 + 名称 -->
          <div class="rd-avatar-row">
            <div v-if="roleForm.avatarUrl" class="rd-avatar-big"
              :style="{ backgroundImage: 'url(' + roleForm.avatarUrl + ')' }"
              @click="pickRoleAvatar" title="点击更换" />
            <div v-else class="rd-avatar-big rd-avatar-big-default"
              @click="pickRoleAvatar" title="点击上传头像">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><circle cx="8.5" cy="8.5" r="2.5"/><path d="M21 15l-5-5L5 21"/>
              </svg>
            </div>
            <div class="rd-avatar-right">
              <input v-model="roleForm.name" class="rd-input rd-name-input"
                placeholder="角色名称" maxlength="12" />
              <button class="rd-link" @click="pickRoleAvatar">
                {{ roleForm.avatarUrl ? '更换头像' : '上传头像' }}
              </button>
            </div>
          </div>

          <!-- 预设模板 (仅新建) -->
          <div v-if="!editingRole" class="rd-template-row">
            <button v-for="tpl in roleTemplates" :key="tpl.id"
              class="rd-tpl-dot" :style="{ '--chip-color': tpl.color }"
              @click="applyRoleTemplate(tpl)" :title="tpl.name">
              {{ tpl.icon }}
            </button>
            <span class="rd-tpl-hint">模板</span>
          </div>

          <!-- 性格 + 激活 -->
          <div class="rd-row-split">
            <select v-model="roleForm.personality" class="rd-input" style="flex:1">
              <option v-for="p in personalityOptions" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <label class="rd-switch">
              <input v-model="roleForm.auto_invoke" type="checkbox" />
              <span>{{ roleForm.auto_invoke ? '激活' : '关闭' }}</span>
            </label>
          </div>

          <!-- 工具权限 (可折叠) -->
          <div class="rd-tools-toggle" @click="showToolPicker = !showToolPicker">
            <span>工具权限</span>
            <span class="rd-tool-count">{{ roleForm.tools.length }}/{{ availableTools.length }}</span>
            <span class="rd-tools-arrow" :class="{ open: showToolPicker }">▾</span>
          </div>
          <div v-if="showToolPicker" class="rd-tools-panel">
            <div class="rd-tool-actions">
              <button class="rd-tool-toggle" @click="selectAllTools">全选</button>
              <button class="rd-tool-toggle" @click="roleForm.tools = []">清空</button>
            </div>
            <div class="rd-tool-list">
              <label v-for="t in availableTools" :key="t.name"
                class="rd-tool-item" :class="{ active: roleForm.tools.includes(t.name) }">
                <input type="checkbox" :value="t.name" v-model="roleForm.tools" />
                <span class="rd-tool-name">{{ t.name }}</span>
              </label>
            </div>
          </div>
        </div>

        <div class="role-dialog-actions">
          <button class="setting-btn secondary" @click="showRoleDialog = false">取消</button>
          <button class="setting-btn primary" @click="saveRole" :disabled="!roleForm.name.trim()">
            {{ editingRole ? '保存' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 群聊管理弹窗 -->
    <div v-if="showGroupManager" class="dialog-backdrop" @click.self="showGroupManager = false">
      <div class="role-dialog" @click.stop style="width:380px">
        <div class="role-dialog-title">群聊管理</div>
        <div class="role-dialog-body">
          <!-- 群成员 -->
          <div class="group-member-grid">
            <div v-for="r in activeExperts" :key="r.id" class="group-member-item">
              <div v-if="r.avatarUrl" class="group-member-avatar"
                :style="{ backgroundImage: 'url(' + r.avatarUrl + ')' }" />
              <div v-else class="group-member-avatar group-member-emoji"
                :style="{ background: r.color + '18' }">{{ r.icon }}</div>
              <span class="group-member-name">{{ r.name }}</span>
              <button class="group-member-remove" @click="toggleExpert(r.id)" title="移除">✕</button>
            </div>
            <div class="group-member-item group-member-add" @click="showRolePickerInManager = !showRolePickerInManager">
              <div class="group-member-avatar group-member-emoji" style="background:var(--accent-soft);border-style:dashed">+</div>
              <span class="group-member-name">添加</span>
            </div>
          </div>
          <!-- 添加角色下拉 -->
          <div v-if="showRolePickerInManager" class="rd-tool-list" style="max-height:140px">
            <label v-for="e in availableExpertsForGroup" :key="e.id"
              class="rd-tool-item" @click="toggleExpert(e.id); showRolePickerInManager = false">
              <span>{{ e.icon }}</span>
              <span class="rd-tool-name">{{ e.name }}</span>
            </label>
            <div v-if="availableExpertsForGroup.length === 0" style="padding:8px;color:var(--text-muted);font-size:12px;text-align:center">
              所有角色已在群聊中
            </div>
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
              <span>回复顺序</span>
              <select v-model="groupSettings.replyOrder" @change="saveGroupSettings" class="rd-input" style="width:auto;padding:4px 8px;font-size:12px">
                <option value="random">随机</option>
                <option value="parallel">并行</option>
                <option value="priority">按优先级</option>
              </select>
            </div>
            <label class="group-setting-row">
              <span>角色互评</span>
              <input type="checkbox" v-model="groupSettings.interReview" @change="saveGroupSettings" />
            </label>
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
import { marked } from 'marked'
import SettingsPanel from './components/SettingsPanel.vue'
import AgentSteps from './components/AgentSteps.vue'

marked.setOptions({ breaks: true, gfm: true })

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
  set(val) { conv.value._model = val },
})

function fmtTime(ts) {
  const d = new Date(ts)
  const isToday = d.toDateString() === new Date().toDateString()
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

let nextId = 2
const convs = ref([
  { id: 1, title: '对话 1', provider: 'deepseek', messages: [], history: [], mode: 'chat' },
])

// 按当前视图模式过滤对话
const viewConvs = computed(() => convs.value.filter(c => (c.mode || 'chat') === activeView.value))
const viewIdx = ref(0)
const conv = computed(() => viewConvs.value[viewIdx.value] || convs.value[0])
const loading = ref(false)
const showSettings = ref(false)
const statusText = ref('在线')
const text = ref('')

// ── 侧边菜单 ──
const activeView = ref('chat')
const activeSubView = ref('')
const menuItems = [
  { id: 'chat', icon: '\u{1F4AC}', label: '对话' },
  { id: 'roles', icon: '\u{1F465}', label: '角色' },
  { id: 'groupchat', icon: '\u{1F5E3}️', label: '群聊' },
]

// 群聊设置
const groupSettings = reactive({
  maxRoles: parseInt(localStorage.getItem('gs-max-roles') || '3'),
  replyOrder: localStorage.getItem('gs-reply-order') || 'parallel',
  interReview: localStorage.getItem('gs-inter-review') === 'true',
})

function saveGroupSettings() {
  localStorage.setItem('gs-max-roles', String(groupSettings.maxRoles))
  localStorage.setItem('gs-reply-order', groupSettings.replyOrder)
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
      convs.value.push({ id: nextId++, title: `${modeLabel} ${nextId - 1}`, provider, messages: [], history: [], mode: id })
      viewIdx.value = 0
    }
  }
}

// ── 角色系统 (localStorage) ──
const customRoles = ref(loadRoles())
const activeExpertIds = ref((loadRoles()).filter(r => r.auto_invoke).map(r => r.id))
const showRolePicker = ref(false)
const experts = computed(() => customRoles.value)  // alias for template

const showRoleManager = ref(false)
const showRoleDialog = ref(false)
const showToolPicker = ref(false)
const showGroupManager = ref(false)
const showRolePickerInManager = ref(false)

const activeExperts = computed(() =>
  activeExpertIds.value.map(id => customRoles.value.find(r => r.id === id)).filter(Boolean)
)
const availableExpertsForGroup = computed(() =>
  customRoles.value.filter(r => !activeExpertIds.value.includes(r.id))
)

function openRoleManager() {
  showRoleManager.value = true
}
const editingRole = ref(null)

// 角色表单
const emptyRoleForm = () => ({
  id: '', name: '', icon: '🎨', avatarUrl: '', color: '#B7A48E', description: '',
  personality: 'default', personality_name: '默认',
  model: null, temperature: 0.7, priority: 5, auto_invoke: false,
  role_prompt: '', tools: [],
})

// 预设角色模板
const roleTemplates = [
  {
    id: 'companion', name: '情感陪伴', icon: '♡', color: '#E8A0B4',
    description: '倾听烦恼、情感支持、温柔鼓励',
    role_prompt: '你是情感陪伴师，专门倾听用户的烦恼和心事，给予情感支持和鼓励。\n\n## 职责\n- 倾听用户的心事，先安慰再建议，永远不说教\n- 遇到需要专业心理咨询的情况，建议拨打心理热线 400-161-9995\n\n## 规则\n- 不要调用任何工具，只用真心回复\n- 回复控制在 150 字以内',
    personality: 'gentle', tools: [],
  },
  {
    id: 'coder', name: '编程助手', icon: '💻', color: '#6A9FB5',
    description: '代码答疑、技术方案、Bug 排查',
    role_prompt: '你是编程助手，专注于软件开发和技术问题。\n\n## 职责\n- 解答编程语言相关问题\n- 帮助调试代码、分析架构\n- 代码审查和建议\n\n## 规则\n- 代码用 markdown 代码块，标注语言\n- 不确定时搜索，不编造\n- 回复控制在 200 字以内',
    personality: 'pro',
    tools: ['web_search_tavily', 'web_search', 'web_fetch', 'search_wikipedia'],
  },
  {
    id: 'analyst', name: '数据分析师', icon: '📊', color: '#7B9EC4',
    description: '逻辑推理、数据对比、决策分析',
    role_prompt: '你是数据分析师，专注于逻辑推理和数据分析。\n\n## 职责\n- 分析问题，给出结构化推理\n- 对比方案优劣，帮助理性决策\n- 解读数据和趋势\n\n## 规则\n- 先给结论，再给论证\n- 不确定时标注假设\n- 回复控制在一个屏幕内',
    personality: 'pro',
    tools: ['web_search_tavily', 'web_search', 'web_fetch', 'search_wikipedia', 'get_exchange_rate', 'get_world_time'],
  },
  {
    id: 'creative', name: '创意顾问', icon: '🎨', color: '#C0A0D0',
    description: '创意灵感、故事讲述、趣味互动',
    role_prompt: '你是创意顾问，充满想象力的伙伴。\n\n## 职责\n- 提供创意灵感和建议\n- 讲有趣的小故事\n- 设计文案、活动创意\n\n## 规则\n- 有趣比正确更重要（安全范围内）\n- 回复控制在 150 字以内',
    personality: 'lively',
    tools: ['get_quote', 'get_joke', 'get_activity', 'web_search_tavily'],
  },
  {
    id: 'general', name: '通用助手', icon: '🤖', color: '#9DC0AF',
    description: '全能型助手，处理各类日常问题',
    role_prompt: '你是通用助手，全能桌面伙伴。\n\n## 规则\n- 每次只调必要的工具\n- 记住用户分享的重要信息\n- 回复控制在 200 字以内',
    personality: 'default', tools: [],
  },
]
const roleForm = ref(emptyRoleForm())

const personalityOptions = [
  { id: 'default', name: '默认' },
  { id: 'gentle', name: '温柔可靠' },
  { id: 'lively', name: '活泼小精灵' },
  { id: 'grumpy', name: '脾气火爆' },
  { id: 'cold', name: '高冷话少' },
  { id: 'sarcastic', name: '腹黑毒舌' },
  { id: 'pro', name: '专业效率' },
]

const emojiOptions = ['😊','🤖','🧠','💡','🎯','🔥','❤️','🌟','🐱','🐶','🦊','🐼','🦄','🎨','⚡','☕','📚','🔧','💪','🎭']
const colorOptions = ['#B7A48E','#E8A0B4','#6A9FB5','#7B9EC4','#C0A0D0','#F0C060','#9DC0AF','#E8906A','#8AB8A0','#D4A0C0']

const availableTools = ref([])

function loadRoles() {
  try {
    const raw = JSON.parse(localStorage.getItem('custom-roles') || '[]')
    const seen = new Set()
    return raw.filter(r => {
      if (seen.has(r.id)) return false
      seen.add(r.id)
      return true
    })
  } catch { return [] }
}

function saveRoles() {
  // Dedup by id
  const seen = new Set()
  customRoles.value = customRoles.value.filter(r => {
    if (seen.has(r.id)) return false
    seen.add(r.id)
    return true
  })
  localStorage.setItem('custom-roles', JSON.stringify(customRoles.value))
  // Also dedup activeExpertIds
  activeExpertIds.value = [...new Set(activeExpertIds.value)]
}

async function loadAvailableTools() {
  try {
    const result = await window.electronAPI?.agentListTools()
    if (result?.tools) availableTools.value = result.tools
  } catch { /* ignore */ }
}

async function pickRoleAvatar() {
  const dataUrl = await window.electronAPI?.pickAvatar()
  if (dataUrl) {
    roleForm.value.avatarUrl = dataUrl
    roleForm.value.icon = ''  // 清空 emoji，用图片
  }
}

const selectedTemplate = ref('')

function onTemplateChange() {
  const tpl = roleTemplates.find(t => t.id === selectedTemplate.value)
  if (tpl) applyRoleTemplate(tpl)
}

function applyRoleTemplate(tpl) {
  roleForm.value = {
    ...roleForm.value,
    name: roleForm.value.name || tpl.name,
    icon: roleForm.value.icon || tpl.icon,
    color: roleForm.value.color || tpl.color,
    description: roleForm.value.description || tpl.description,
    role_prompt: tpl.role_prompt,
    personality: tpl.personality,
    tools: [...tpl.tools],
  }
  // 更新 personality_name
  const pers = personalityOptions.find(p => p.id === tpl.personality)
  roleForm.value.personality_name = pers ? pers.name : '默认'
}

function openRoleDialog(role) {
  if (role) {
    editingRole.value = role
    roleForm.value = { ...emptyRoleForm(), ...role }
  } else {
    editingRole.value = null
    roleForm.value = emptyRoleForm()
    roleForm.value.id = 'role_' + Date.now()
    roleForm.value.tools = availableTools.value.filter(t => t.tier === 'general').map(t => t.name)
  }
  showRoleDialog.value = true
  showToolPicker.value = false
  if (availableTools.value.length === 0) loadAvailableTools()
}

function saveRole() {
  const form = roleForm.value
  if (!form.name.trim()) return

  // 更新 personality_name
  const pers = personalityOptions.find(p => p.id === form.personality)
  form.personality_name = pers ? pers.name : '默认'

  if (editingRole.value) {
    const idx = customRoles.value.findIndex(r => r.id === editingRole.value.id)
    if (idx >= 0) customRoles.value[idx] = { ...form }
  } else {
    customRoles.value.push({ ...form })
  }
  saveRoles()
  showRoleDialog.value = false
  // 同步 activeExpertIds
  if (form.auto_invoke && !activeExpertIds.value.includes(form.id)) {
    activeExpertIds.value.push(form.id)
  }
}

function deleteRole(id) {
  customRoles.value = customRoles.value.filter(r => r.id !== id)
  activeExpertIds.value = activeExpertIds.value.filter(eid => eid !== id)
  saveRoles()
}

function selectAllTools() { roleForm.value.tools = availableTools.value.map(t => t.name) }
function selectGeneralTools() { roleForm.value.tools = availableTools.value.filter(t => t.tier === 'general').map(t => t.name) }

function toggleExpert(id) {
  const idx = activeExpertIds.value.indexOf(id)
  if (idx >= 0) activeExpertIds.value.splice(idx, 1)
  else activeExpertIds.value.push(id)
}

function addAllRoles() {
  activeExpertIds.value = customRoles.value.map(e => e.id)
}

function parseMentions(t) {
  const re = /@(\S+)/g
  const ids = []
  let m
  while ((m = re.exec(t)) !== null) {
    const found = customRoles.value.find(e => e.name === m[1] || e.id === m[1] || e.name.startsWith(m[1]))
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
const char = computed(() => CHARACTERS[conv.value.provider] || CHARACTERS.claude)
const userAvatar = ref(localStorage.getItem('user-avatar') || '🐱')
const avatarColor = ref(localStorage.getItem('user-avatar-color') || '#B7A48E')
const pendingImages = ref([])
const ctxMenu = ref(null)

// Agent 状态
const agentSteps = ref([])
const pendingApproval = ref(null)
const reasoningOn = ref(true)
const elapsedTime = ref(0)
let elapsedTimer = null
const reasoningText = ref('')
const reasoningExpanded = ref(true)

function fmtApprovalInput(input) {
  if (!input) return ''
  if (typeof input === 'string') return input
  try { return JSON.stringify(input, null, 2) } catch { return String(input) }
}

function approveTool(approved) {
  if (pendingApproval.value && pendingApproval.value.approvalId) {
    window.electronAPI?.agentApproveTool(pendingApproval.value.approvalId, approved)
    agentSteps.value.push({ type: 'thought', content: approved ? '用户批准了执行' : '用户拒绝了执行' })
    pendingApproval.value = null
  }
}

function startTimer() { elapsedTime.value = 0; elapsedTimer = setInterval(() => { elapsedTime.value++ }, 1000) }
function stopTimer() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }; elapsedTime.value = 0 }

function stopGeneration() {
  stopTimer()
  loading.value = false
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

watch(() => conv.value.messages.length, () => {
  nextTick(() => msgEnd.value?.scrollIntoView({ behavior: 'smooth' }))
})

watch(loading, (val) => { window.electronAPI?.notifyWorking(val) })

function addNewConv() { newConv(localStorage.getItem('llm-provider') || 'deepseek') }
function newConv(provider) {
  if (convs.value.length >= 8) return
  const modeLabel = activeView.value === 'groupchat' ? '群聊' : '对话'
  convs.value.push({ id: nextId++, title: `${modeLabel} ${nextId - 1}`, provider, messages: [], history: [], mode: activeView.value })
  viewIdx.value = viewConvs.value.length - 1
}
function switchConv(i) { if (i !== viewIdx.value) viewIdx.value = i }
function closeConv(i) {
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
  const t = text.value.trim()
  const hasImgs = pendingImages.value.length > 0
  if (!t && !hasImgs) return

  let userContent = t
  if (hasImgs) {
    const imgDescs = pendingImages.value.map((_, i) => `[图片 ${i + 1}]`).join(' ')
    userContent = t ? `${imgDescs} ${t}` : imgDescs
  }

  text.value = ''
  pendingImages.value = []

  const c = conv.value
  c.messages.push({ role: 'user', content: userContent, timestamp: new Date() })
  c.history.push({ role: 'user', content: userContent })
  loading.value = true
  statusText.value = '工作中...'
  reasoningText.value = ''
  reasoningExpanded.value = true
  startTimer()

  const savedConfig = await window.electronAPI?.loadConfig()
  if (!savedConfig) { showSettings.value = true; stopTimer(); loading.value = false; statusText.value = '在线'; return }

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
    c.messages.push({ role: 'assistant', content: '群聊模式暂不可用，请确认已添加角色并选中。', timestamp: new Date() })
    return
  }

  const agentOk = await runAgentMode(c, savedConfig)
  if (agentOk) return

  await runLegacyMode(c)
}

async function runAgentMode(c, config) {
  try {
    const ready = await window.electronAPI?.agentGetReady()
    if (!ready?.ready) return false

    const steps = []
    agentSteps.value = steps

    c.messages.push({ role: 'assistant', content: '', timestamp: new Date() })
    const _msgIdx = c.messages.length - 1
    let fullContent = ''

    const unsubs = []

    unsubs.push(window.electronAPI.onAgentThought((data) => {
      const d = data?.data || data
      const text = typeof d === 'string' ? d : d?.content || ''
      if (text) steps.push({ type: 'thought', content: text })
    }))

    unsubs.push(window.electronAPI.onReasoning((data) => {
      if (!reasoningOn.value) return
      const d = data?.data || data
      const text = typeof d === 'string' ? d : d?.content || ''
      if (text) { reasoningText.value += text; c.messages[_msgIdx]._reasoning = reasoningText.value; c.messages[_msgIdx]._reasoningOpen = true }
    }))

    unsubs.push(window.electronAPI.onAgentAction((data) => {
      const d = data?.data || data
      steps.push({ type: 'action', tool: d?.tool || '未知工具', input: d?.input || d, round: d?.round || '' })
    }))

    unsubs.push(window.electronAPI.onAgentObservation((data) => {
      const d = data?.data || data
      steps.push({ type: 'observation', tool: d?.tool || '工具', content: d?.content || String(d), round: d?.round || '' })
    }))

    unsubs.push(window.electronAPI.onAgentChunk((data) => {
      const d = data?.data || data
      fullContent += d?.content || ''
      c.messages[_msgIdx].content = fullContent
    }))

    unsubs.push(window.electronAPI.onAgentDone((data) => {
      const d = data?.data || data
      if (d?.content) c.messages[_msgIdx].content = d.content
      c.messages[_msgIdx].elapsed = elapsedTime.value
      c.messages[_msgIdx]._steps = [...steps]
      if (reasoningText.value) { c.messages[_msgIdx]._reasoning = reasoningText.value; reasoningText.value = '' }
      reasoningExpanded.value = false
    }))

    unsubs.push(window.electronAPI.onAgentError((data) => {
      const d = data?.data || data
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
    await window.electronAPI.agentChat(plainConfig, plainHistory, `conv-${c.id}`)

    for (const u of unsubs) u()
    agentSteps.value = []
    reasoningExpanded.value = false
    pendingApproval.value = null
    stopTimer()
    loading.value = false
    statusText.value = '在线'

    const _finalContent = c.messages[_msgIdx]?.content || ''
    if (_finalContent && !_finalContent.startsWith('❌')) c.history.push({ role: 'assistant', content: _finalContent })
    return true
  } catch (err) {
    console.error('[Agent] 失败,降级:', err)
    if (c.messages[_msgIdx] && !c.messages[_msgIdx].content) c.messages.pop()
    return false
  }
}

async function runGroupChatMode(c, config, mentionedIds) {
  try {
    const ready = await window.electronAPI?.agentGetReady()
    if (!ready?.ready) return false

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

    unsubs.push(window.electronAPI.onCoordinatorStart((data) => {
      const d = data?.data || data
      if (d?.experts) steps.push({ type: 'thought', content: '已激活: ' + d.experts.map(e => e.name).join('、') })
    }))

    unsubs.push(window.electronAPI.onCoordinatorInfo((data) => {
      const d = data?.data || data
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
        const role = customRoles.value.find(r => r.id === eid)
        turnMsgIdx[eid] = c.messages.length
        c.messages.push({
          role: 'assistant', content: d.content, timestamp: new Date(),
          _expert: {
            id: eid, name: d.expert_name,
            icon: d.expert_icon, color: d.expert_color,
            avatarUrl: role?.avatarUrl || '',
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
        const role = customRoles.value.find(r => r.id === eid)
        const msg = {
          role: 'assistant', content: d.content, timestamp: new Date(), elapsed: d.elapsed,
          _expert: {
            id: eid, name: d.expert_name,
            icon: d.expert_icon, color: d.expert_color,
            avatarUrl: role?.avatarUrl || '',
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
            avatarUrl: (customRoles.value.find(x => x.id === rv.expert_id) || {}).avatarUrl || '',
          },
          _review: true,
        })
      }
    }))

    unsubs.push(window.electronAPI.onCoordinatorError((data) => {
      const d = data?.data || data
      c.messages.push({ role: 'assistant', content: '群聊模式出问题了: ' + (d?.content || '未知错误') + '。已切回单 Agent 模式。', timestamp: new Date() })
    }))

    const expertIds = activeExpertIds.value.length > 0
      ? [...new Set(activeExpertIds.value)]
      : null
    // Dedup roles by id before sending
    const seenIds = new Set()
    const dedupedRoles = customRoles.value.filter(r => {
      if (seenIds.has(r.id)) return false
      seenIds.add(r.id)
      return true
    })
    const expertData = dedupedRoles.length > 0
      ? JSON.parse(JSON.stringify(dedupedRoles))
      : null
    await window.electronAPI.agentChatGroup(
      plainConfig, plainHistory, `group-${c.id}`, expertIds,
      mentionedIds.length > 0 ? mentionedIds : null,
      expertData,
    )

    for (const u of unsubs) u()
    agentSteps.value = []
    stopTimer()
    loading.value = false
    statusText.value = '在线'

    for (const r of expertReplies) {
      if (r?.content && !r.content.startsWith('❌')) {
        const role = customRoles.value.find(x => x.id === r.expert_id)
        c.history.push({
          role: 'assistant', content: r.content,
          _expert: {
            id: r.expert_id, name: r.expert_name,
            icon: r.expert_icon, color: r.expert_color,
            avatarUrl: role?.avatarUrl || '',
          },
        })
      }
    }
    return true
  } catch (err) {
    console.error('[GroupChat] 失败:', err)
    return false
  }
}

async function runLegacyMode(c) {
  try {
    const { llmService } = await import('./lib/llm/LLMProvider')
    if (!llmService.isInitialized()) { showSettings.value = true; loading.value = false; statusText.value = '在线'; return }
    let full = ''
    c.messages.push({ role: 'assistant', content: '', timestamp: new Date() })
    await llmService.chat(
      [{ role: 'system', content: '你是一个可爱的桌面宠物。回复简洁有活力。' }, ...c.history],
      (chunk) => { full += chunk; c.messages[c.messages.length - 1].content = full }
    )
    c.history.push({ role: 'assistant', content: full })
  } catch (err) {
    c.messages.push({ role: 'assistant', content: `❌ ${err}`, timestamp: new Date() })
  } finally { stopTimer(); loading.value = false; statusText.value = '在线' }
}

let removeFileFed = null
onMounted(async () => {
  let savedConfig = await window.electronAPI?.loadConfig()
  if (!savedConfig) {
    const saved = localStorage.getItem('llm-config')
    if (saved) { try { savedConfig = JSON.parse(saved) } catch { /* ignore */ } }
  }
  if (savedConfig) {
    try { const { llmService } = await import('./lib/llm/LLMProvider'); llmService.restore(savedConfig) } catch { /* ignore */ }
  }
  removeFileFed = window.electronAPI?.onFileFed?.((data) => { feedFileToConversation(data) })
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

  const savedConfig = await window.electronAPI?.loadConfig()
  if (!savedConfig) { showSettings.value = true; loading.value = false; statusText.value = '在线'; return }
  if (convModel.value) savedConfig.model = convModel.value

  const agentOk = await runAgentMode(c, savedConfig)
  if (agentOk) return

  try {
    const { llmService } = await import('./lib/llm/LLMProvider')
    if (!llmService.isInitialized()) { showSettings.value = true; loading.value = false; statusText.value = '在线'; return }
    let full = ''
    c.messages.push({ role: 'assistant', content: '', timestamp: new Date() })
    await llmService.chat(
      [{ role: 'system', content: '你是一个可爱的桌面宠物。回复简洁有活力。如果用户拖了一个文件给你，帮用户分析文件内容。' }, ...c.history],
      (chunk) => { full += chunk; c.messages[c.messages.length - 1].content = full }
    )
    c.history.push({ role: 'assistant', content: full })
    c.messages[c.messages.length - 1].elapsed = elapsedTime.value
  } catch (err) {
    c.messages.push({ role: 'assistant', content: `❌ ${err}`, timestamp: new Date() })
  } finally { stopTimer(); loading.value = false; statusText.value = '在线' }
}
</script>

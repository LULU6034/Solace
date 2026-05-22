<template>
  <div class="glass-window">
    <!-- 彩铅标题栏 -->
    <div class="pet-strip" :class="{ working: loading }">
      <span class="pet-name">✧ 彩铅小栈 ✧</span>
      <div class="strip-right">
        <div class="strip-tool-badge">
          <span v-if="loading" class="spark">✦</span>
          <span>{{ loading ? '彩铅沙沙响...' : '安心对话 · 手绘陪伴' }}</span>
        </div>
      </div>
    </div>

    <!-- 标签栏 + 操作按钮 -->
    <div class="header-bar">
      <div class="conversation-pills">
        <TransitionGroup name="tab-slide">
          <div v-for="(c, i) in convs" :key="c.id" class="pill-wrap"
            @contextmenu.prevent="ctxMenu = { idx: i, x: $event.clientX, y: $event.clientY }">
            <button class="conv-pill" :class="[
              { active: i === activeIdx },
              `provider-${c.provider}`
            ]" @click="switchConv(i)">
              <span class="pill-icon">{{ charForIdx(i).icon }}</span>
              <span class="pill-label">{{ c.title }}</span>
              <span v-if="convs.length > 1" class="pill-close"
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
        <!-- 新建对话：直接用设置里保存的模型 -->
        <button class="add-btn" title="新建对话" @click="addNewConv">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>

        <div class="header-actions">
          <button class="header-btn" title="设置" @click="showSettings = true">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <circle cx="7.5" cy="7.5" r="2.8" stroke="currentColor" stroke-width="1.3"/>
              <path d="M7.5 1.5v1.5M7.5 12v1.5M1.5 7.5H3M12 7.5h1.5M3.3 3.3l1 1M10.7 10.7l1 1M3.3 11.7l1-1M10.7 4.3l1-1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 右键菜单 -->
    <div v-if="ctxMenu" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click="ctxMenu = null" @mouseleave="ctxMenu = null">
      <button class="ctx-menu-item" @click="renameConv(ctxMenu.idx)">重命名</button>
      <button v-if="convs.length > 1" class="ctx-menu-item danger"
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
        <div class="welcome-icon" :class="{ pulsing: true }"
          :style="{ background: char.color + '15' }">{{ char.icon }}</div>
        <div class="title">你好，我是 {{ char.name }}</div>
        <div class="sub">有什么可以帮你的？</div>
        <div class="suggestion-grid">
          <button v-for="s in suggestions" :key="s" class="suggestion-card" @click="quickSend(s)">
            {{ s }}
          </button>
        </div>
      </div>

      <div v-for="(msg, i) in conv.messages" :key="i"
        class="message-row" :class="msg.role"
        @mouseenter="msg._hover = true" @mouseleave="msg._hover = false">
        <div v-if="msg.role === 'assistant'" class="msg-avatar"
          :style="{ background: char.color + '18' }">{{ char.icon }}</div>
        <div class="bubble-wrap">
          <div class="bubble" :class="msg.role">
            <div v-if="msg.role === 'assistant'" class="msg-role">{{ char.name }}</div>
            <div class="msg-text">{{ msg.content }}</div>
            <div v-if="msg.timestamp" class="msg-footer">
              <span class="msg-arrow">{{ msg.role === 'user' ? '↘︎' : '↙︎' }}</span>
              <span class="msg-time">{{ fmtTime(msg.timestamp) }}</span>
              <span v-if="msg.role === 'user'" class="msg-check">✓</span>
            </div>
          </div>
          <button v-if="msg._hover" class="copy-btn" @click="copyMsg(msg.content)"
            :class="{ copied: msg._copied }">
            {{ msg._copied ? '✓ 已复制' : '⎘ 复制' }}
          </button>
        </div>
      </div>

      <!-- Agent 思考步骤 -->
      <AgentSteps v-if="loading && agentSteps.length > 0" :steps="agentSteps" />

      <div v-if="loading && conv.messages.length > 0" class="typing-indicator">
        <div class="typing-dot" /><div class="typing-dot" /><div class="typing-dot" />
      </div>

      <div ref="msgEnd" />
    </div>

    <!-- 输入区 -->
    <div class="input-area">
      <!-- 图片预览 -->
      <div v-if="pendingImages.length > 0" class="img-preview-strip">
        <div v-for="(img, i) in pendingImages" :key="i" class="img-preview">
          <img :src="img.data" />
          <button class="img-remove" @click="pendingImages.splice(i, 1)">&times;</button>
        </div>
      </div>

      <div class="input-row">
        <textarea ref="ta" v-model="text"
          :disabled="loading" placeholder="写点什么吧..."
          @keydown="onKeydown"
          @paste="onPaste" rows="1" />
        <button v-if="supportsSpeech" class="mic-btn"
          :class="{ recording: isRecording }"
          :title="isRecording ? '停止录音' : '语音输入'"
          @click="toggleSpeech">
          {{ isRecording ? '⬤' : '🎤' }}
        </button>
        <button class="send-btn" :disabled="loading || (!text.trim() && pendingImages.length === 0)"
          @click="handleSend">
          发送 ✨
        </button>
      </div>
    </div>

    <!-- 工具审批弹窗 -->
    <div v-if="pendingApproval" class="approval-overlay" @click.self="approveTool(false)">
      <div class="approval-dialog">
        <div class="approval-icon">⚠️</div>
        <div class="approval-title">确认执行命令</div>
        <div class="approval-tool-name">{{ pendingApproval.tool }}</div>
        <pre class="approval-input">{{ fmtApprovalInput(pendingApproval.input) }}</pre>
        <div class="approval-warning">
          此操作需要你的批准。请确认命令安全后再执行。
        </div>
        <div class="approval-actions">
          <button class="setting-btn secondary" @click="approveTool(false)">拒绝</button>
          <button class="setting-btn primary approval-allow" @click="approveTool(true)">批准执行</button>
        </div>
      </div>
    </div>

    <SettingsPanel v-if="showSettings" @done="showSettings = false" />
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import SettingsPanel from './components/SettingsPanel.vue'
import AgentSteps from './components/AgentSteps.vue'

const CHARACTERS = {
  claude: { icon: '🦞', color: '#B7A48E', name: 'Clawd', desc: '沉稳睿智，擅长深度分析' },
  deepseek: { icon: '☁️', color: '#9BB7AA', name: '云朵', desc: '灵动轻盈，中文理解超群' },
  openai: { icon: '⌨️', color: '#9DC0AF', name: 'Coco', desc: '均衡全面，创意无限' },
}

function charForIdx(i) {
  const p = convs.value[i]?.provider || 'claude'
  return CHARACTERS[p] || CHARACTERS.claude
}

function fmtTime(ts) {
  const d = new Date(ts)
  const isToday = d.toDateString() === new Date().toDateString()
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const suggestions = [
  '帮我解释一段代码',
  '写一个简单的 Python 脚本',
  '翻译一段文字',
  '帮我查个资料',
]

let nextId = 2
const convs = ref([{ id: 1, title: '对话 1', provider: 'claude', messages: [], history: [] }])
const activeIdx = ref(0)
const loading = ref(false)
const showSettings = ref(false)
const statusText = ref('在线')
const text = ref('')
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
    for (let i = e.resultIndex; i < e.results.length; i++) {
      interim += e.results[i][0].transcript
    }
    text.value = interim
  }
  recognition.onerror = () => { stopSpeech() }
  recognition.onend = () => { isRecording.value = false; recognition = null }
  recognition.start()
  isRecording.value = true
}

function stopSpeech() {
  if (recognition) {
    recognition.stop()
    recognition = null
  }
  isRecording.value = false
}
const ta = ref(null)
const msgEnd = ref(null)
const conv = computed(() => convs.value[activeIdx.value])
const char = computed(() => CHARACTERS[conv.value.provider] || CHARACTERS.claude)

// 粘贴图片
const pendingImages = ref([])

// 右键菜单
const ctxMenu = ref(null)

// Agent 模式状态
const agentSteps = ref([])
const pendingApproval = ref(null)

function fmtApprovalInput(input) {
  if (!input) return ''
  if (typeof input === 'string') return input
  try { return JSON.stringify(input, null, 2) } catch { return String(input) }
}

function approveTool(approved) {
  if (pendingApproval.value && pendingApproval.value.approvalId) {
    window.electronAPI?.agentApproveTool(pendingApproval.value.approvalId, approved)
    agentSteps.value.push({
      type: 'thought',
      content: approved ? '用户批准了执行' : '用户拒绝了执行',
    })
    pendingApproval.value = null
  }
}

// 重命名
const renaming = ref(null)
const renameText = ref('')
const renameInput = ref(null)

watch(() => conv.value.messages.length, () => {
  nextTick(() => msgEnd.value?.scrollIntoView({ behavior: 'smooth' }))
})

// loading 变化时通知宠物窗口
watch(loading, (val) => {
  window.electronAPI?.notifyWorking(val)
})

function addNewConv() {
  const saved = localStorage.getItem('llm-provider') || 'claude'
  newConv(saved)
}

function newConv(provider) {
  if (convs.value.length >= 8) return
  const ch = CHARACTERS[provider] || CHARACTERS.claude
  convs.value.push({
    id: nextId++, title: `对话 ${nextId - 1}`,
    provider,
    messages: [], history: [],
  })
  activeIdx.value = convs.value.length - 1
}

function switchConv(i) {
  if (i === activeIdx.value) return
  activeIdx.value = i
}

function closeConv(i) {
  if (convs.value.length <= 1) return
  convs.value.splice(i, 1)
  if (activeIdx.value >= convs.value.length) activeIdx.value = convs.value.length - 1
  ctxMenu.value = null
}

function clearConv() {
  const c = conv.value
  c.messages = []; c.history = []; c.title = '对话 ' + c.id
}

function renameConv(i) {
  ctxMenu.value = null
  renaming.value = i
  renameText.value = convs.value[i].title
  nextTick(() => renameInput.value?.focus())
}

function doRename() {
  const t = renameText.value.trim()
  if (t && renaming.value !== null) {
    convs.value[renaming.value].title = t
  }
  renaming.value = null
}

function onKeydown(e) {
  // Cmd+K / Ctrl+K 清空对话
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault(); clearConv(); return
  }
  // Cmd+Enter / Shift+Enter 换行
  if ((e.metaKey || e.ctrlKey || e.shiftKey) && e.key === 'Enter') {
    return // 允许默认换行
  }
  // Enter 发送
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
      reader.onload = (ev) => {
        pendingImages.value.push({ data: ev.target.result, file })
      }
      reader.readAsDataURL(file)
    }
  }
}

function quickSend(t) {
  text.value = t
  handleSend()
}

function copyMsg(content) {
  navigator.clipboard.writeText(content).then(() => {
    // 找到对应消息并标记
    for (const msg of conv.value.messages) {
      if (msg.content === content) {
        msg._copied = true
        setTimeout(() => { msg._copied = false }, 1800)
        break
      }
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

  const savedConfig = await window.electronAPI?.loadConfig()
  if (!savedConfig) {
    showSettings.value = true
    loading.value = false
    statusText.value = '在线'
    return
  }

  // 优先尝试 Agent 模式
  const agentOk = await runAgentMode(c, savedConfig)
  if (agentOk) return

  // 降级到旧 LLM 模式
  await runLegacyMode(c)
}

async function runAgentMode(c, config) {
  try {
    console.log('[runAgentMode] 检查 Agent 就绪...')
    const ready = await window.electronAPI?.agentGetReady()
    console.log('[runAgentMode] Agent 就绪状态:', ready)
    if (!ready?.ready) {
      console.log('[runAgentMode] Agent 未就绪,降级到传统模式')
      return false
    }

    const steps = []
    agentSteps.value = steps

    // 创建助手消息占位
    const assistantMsg = { role: 'assistant', content: '', timestamp: new Date() }
    c.messages.push(assistantMsg)
    let fullContent = ''

    // 设置事件监听(在调用 agentChat 之前)
    const unsubs = []

    unsubs.push(window.electronAPI.onAgentThought((data) => {
      const text = typeof data === 'string' ? data : data?.content || ''
      if (text) steps.push({ type: 'thought', content: text })
    }))

    unsubs.push(window.electronAPI.onAgentAction((data) => {
      steps.push({
        type: 'action',
        tool: data?.tool || '未知工具',
        input: data?.input || data,
        round: data?.round || '',
      })
    }))

    unsubs.push(window.electronAPI.onAgentObservation((data) => {
      steps.push({
        type: 'observation',
        tool: data?.tool || '工具',
        content: data?.content || String(data),
        round: data?.round || '',
      })
    }))

    unsubs.push(window.electronAPI.onAgentChunk((data) => {
      const chunk = data?.content || ''
      fullContent += chunk
      assistantMsg.content = fullContent
    }))

    unsubs.push(window.electronAPI.onAgentDone((data) => {
      if (data?.content) assistantMsg.content = data.content
      assistantMsg._steps = [...steps]
    }))

    unsubs.push(window.electronAPI.onAgentError((data) => {
      assistantMsg.content = `❌ ${data?.content || 'Agent 执行出错'}`
    }))

    unsubs.push(window.electronAPI.onAgentToolApprovalRequest((data) => {
      pendingApproval.value = {
        approvalId: data?.approval_id || '',
        tool: data?.tool || '',
        input: data?.input || {},
      }
    }))

    // 启动 Agent
    await window.electronAPI.agentChat(config, c.history, `conv-${c.id}`)

    // 清理
    for (const u of unsubs) u()
    agentSteps.value = []
    pendingApproval.value = null
    loading.value = false
    statusText.value = '在线'

    // 保存到历史
    if (assistantMsg.content) {
      c.history.push({ role: 'assistant', content: assistantMsg.content })
    }
    return true
  } catch (err) {
    console.error('[Agent] 失败,降级:', err)
    // 回滚: 移除刚添加的助手消息
    const last = c.messages[c.messages.length - 1]
    if (last && last.role === 'assistant' && !last.content) {
      c.messages.pop()
    }
    return false
  }
}

async function runLegacyMode(c) {
  try {
    const { llmService } = await import('./lib/llm/LLMProvider')
    if (!llmService.isInitialized()) {
      showSettings.value = true
      loading.value = false
      statusText.value = '在线'
      return
    }
    let full = ''
    c.messages.push({ role: 'assistant', content: '', timestamp: new Date() })
    await llmService.chat(
      [{ role: 'system', content: '你是一个可爱的桌面宠物。回复简洁有活力。' }, ...c.history],
      (chunk) => { full += chunk; c.messages[c.messages.length - 1].content = full }
    )
    c.history.push({ role: 'assistant', content: full })
  } catch (err) {
    c.messages.push({ role: 'assistant', content: `❌ ${err}`, timestamp: new Date() })
  } finally {
    loading.value = false
    statusText.value = '在线'
  }
}

// 监听宠物喂食文件
let removeFileFed = null
onMounted(async () => {
  // 自动恢复上次保存的 API Key — 优先从主进程文件读取
  let savedConfig = await window.electronAPI?.loadConfig()
  if (!savedConfig) {
    // 兼容旧 localStorage 数据
    const saved = localStorage.getItem('llm-config')
    if (saved) {
      try { savedConfig = JSON.parse(saved) } catch { /* ignore */ }
    }
  }
  if (savedConfig) {
    try {
      const { llmService } = await import('./lib/llm/LLMProvider')
      llmService.restore(savedConfig)
    } catch { /* ignore */ }
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

  // 优先 Agent 模式
  const agentOk = await runAgentMode(c, savedConfig)
  if (agentOk) return

  // 降级传统模式
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
  } catch (err) {
    c.messages.push({ role: 'assistant', content: `❌ ${err}`, timestamp: new Date() })
  } finally {
    loading.value = false; statusText.value = '在线'
  }
}
</script>

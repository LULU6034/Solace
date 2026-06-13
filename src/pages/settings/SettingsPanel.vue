<template>
  <div class="settings-backdrop" @click="emit('done')">
    <div class="settings-panel" @click.stop>
      <!-- 左侧分类 -->
      <div class="settings-sidebar"
        @mousedown="onSidebarClick" @click="onSidebarClick">
        <div v-for="cat in categories" :key="cat.id"
          class="settings-cat-btn" :class="{ active: activeCat === cat.id }"
          :data-cat="cat.id">
          <span class="cat-icon" :style="{ color: cat.color }"><component :is="cat.icon" :size="18" /></span>
          <span class="cat-label">{{ cat.label }}</span>
        </div>
      </div>

      <div class="settings-divider" />

      <!-- 右侧详情 -->
      <div class="settings-detail">
        <!-- 用户 -->
        <div v-if="activeCat === 'profile'" class="cat-content">
          <div class="profile-hero">
            <div class="avatar-circle" @click="pickAvatar" title="点击更换头像">
              <img v-if="userAvatar.startsWith('data:')" :src="userAvatar" class="avatar-img" />
              <div v-else class="avatar-geo" :style="{ background: avatarColor }">
                <svg viewBox="0 0 40 40"><path d="M12 28 Q20 8 28 28" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5" stroke-linecap="round"/><path d="M8 22 Q20 16 32 22" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.5" stroke-linecap="round"/><circle cx="20" cy="18" r="3" fill="rgba(255,255,255,0.3)"/></svg>
              </div>
              <div class="avatar-overlay">📷</div>
            </div>
            <div class="profile-name">{{ userNickname || '你' }}</div>
            <button class="profile-upload-btn" @click="pickAvatar">更换头像</button>
          </div>

          <div class="setting-group">
            <label class="setting-label">称呼</label>
            <input v-model="userNickname" class="setting-input" placeholder="让 AI 这样叫你" @input="onNicknameInput" />
            <span v-if="nicknameHint" class="nickname-hint" :class="{ error: nicknameError }">{{ nicknameHint }}</span>
          </div>

          <div v-if="userProfile.name || userProfile.city || userProfile.occupation" class="profile-card">
            <div class="profile-item" v-if="userProfile.name"><span class="profile-key">名字</span><span class="profile-value">{{ userProfile.name }}</span></div>
            <div class="profile-item" v-if="userProfile.city"><span class="profile-key">城市</span><span class="profile-value">{{ userProfile.city }}</span></div>
            <div class="profile-item" v-if="userProfile.occupation"><span class="profile-key">职业</span><span class="profile-value">{{ userProfile.occupation }}</span></div>
          </div>

          <div class="setting-group">
            <div class="memory-stats">
              <span class="mem-stat">记忆 {{ memoryCount }} 条</span>
              <button class="mem-clear-btn" @click="clearMemory" :disabled="memoryCount === 0">清空</button>
            </div>
          </div>
        </div>

        <!-- 服务商 -->
        <div v-if="activeCat === 'backend'" class="cat-content">
          <div class="provider-cards">
            <button v-for="p in providers" :key="p.id" class="provider-card" :class="{ active: provider === p.id }" @click="provider = p.id">
              <span class="provider-card-icon" :style="{ background: p.color + '20' }">{{ p.icon }}</span>
              <div class="provider-card-text">
                <span class="provider-card-name">{{ p.name }}</span>
                <span class="provider-card-desc">{{ p.desc }}</span>
              </div>
              <span v-if="provider === p.id" class="provider-card-check">✓</span>
            </button>
          </div>

          <div class="setting-group">
            <label class="setting-label">主模型 API Key</label>
            <input v-model="apiKey" type="password" class="setting-input" placeholder="sk-..." />
          </div>
          <div class="setting-group">
            <label class="setting-label">视觉识别 API Key <small style="color:var(--text-muted);font-weight:400">阿里云百炼 Qwen-VL</small></label>
            <input v-model="visionApiKey" type="password" class="setting-input" placeholder="sk-...（可选）" />
          </div>
          <div class="setting-group">
            <label class="setting-label">语音合成 API Key <small style="color:var(--text-muted);font-weight:400">阿里云百炼 CosyVoice</small></label>
            <input v-model="dashscopeApiKey" type="password" class="setting-input" placeholder="sk-...（可选）" />
          </div>
          <div class="setting-group">
            <label class="setting-label">MiniMax TTS Key <small style="color:var(--color-primary);font-weight:500">推荐 — 情感表现力更强</small></label>
            <input v-model="minimaxApiKey" type="password" class="setting-input" placeholder="sk-...（可选）" />
          </div>

          <div v-if="provider === 'claude'" class="model-chips">
            <button v-for="m in claudeModels" :key="m.value" class="model-chip" :class="{ active: claudeModel === m.value }" @click="claudeModel = m.value">{{ m.label }}</button>
          </div>
          <div v-if="provider === 'deepseek'" class="model-chips">
            <button v-for="m in deepseekModels" :key="m.value" class="model-chip" :class="{ active: deepseekModel === m.value }" @click="deepseekModel = m.value">{{ m.label }}</button>
          </div>
          <div v-if="provider === 'openai'" class="provider-config">
            <input v-model="openaiBaseUrl" class="setting-input" placeholder="API 地址" />
            <input v-model="openaiModel" class="setting-input" placeholder="模型名称" />
          </div>

          <div class="agent-status">
            <div class="agent-status-header">
              <span class="agent-status-dot" :class="{ online: agentReady }" />
              <span class="agent-status-label">Agent</span>
              <span v-if="agentReady" class="agent-status-text">就绪</span>
              <span v-else-if="agentChecking" class="agent-status-text">检查中</span>
              <span v-else class="agent-status-text offline">待启动</span>
            </div>
          </div>

          <p v-if="error" class="setting-error">{{ error }}</p>

          <div class="setting-actions">
            <button class="setting-btn primary" :disabled="!apiKey || saving" @click="save">{{ saving ? '连接中...' : '保存' }}</button>
            <button class="setting-btn secondary" @click="testConn">测试</button>
          </div>
        </div>

        <!-- 助手 -->
        <div v-if="activeCat === 'pet'" class="cat-content">
          <!-- 快速风格预设 -->
          <div class="sect-label">快速风格</div>
          <div class="style-chips">
            <button v-for="p in personalityPresets" :key="p.id" class="style-chip" @click="applyPreset(p)">{{ p.icon }} {{ p.name }}</button>
          </div>

          <!-- 身份描述 -->
          <div class="sect-label">身份描述 <small style="color:var(--text-muted)">告诉 AI 它是什么角色</small></div>
          <textarea v-model="editIdentity" class="setting-textarea" rows="3" placeholder="我是彩铅，一只戴眼镜的博学小狗..."></textarea>

          <!-- 行为风格 -->
          <div class="sect-label">行为风格 <small style="color:var(--text-muted)">定义 AI 的说话方式</small></div>
          <textarea v-model="editIshiki" class="setting-textarea" rows="4" placeholder="用学者的口吻说话，偶尔用汪汪开头..."></textarea>

          <button class="setting-btn primary" @click="savePersonality" :disabled="savingPersonality">保存人格设定</button>
          <span v-if="saveMsg" class="save-msg">{{ saveMsg }}</span>

          <!-- Agent 管理 -->
          <div class="sect-label" style="margin-top:12px">角色管理</div>
          <div class="agent-list">
            <div v-for="a in agentList" :key="a.id" class="agent-row" :class="{ active: a.isActive }">
              <span class="agent-row-icon">{{ a.icon || '🐶' }}</span>
              <div class="agent-row-info">
                <span class="agent-row-name">
                  {{ a.name }}
                  <span v-if="a.isBuiltin" class="agent-row-badge">内置</span>
                </span>
                <span class="agent-row-meta">{{ a.config?.provider || 'claude' }} · {{ a.memoryCount || 0 }} 条记忆</span>
              </div>
              <button v-if="!a.isActive" class="agent-row-btn" @click="switchAgent(a.id)">切换</button>
              <button v-if="!a.isBuiltin" class="agent-row-del" @click="deleteAgent(a.id)" title="删除">✕</button>
            </div>
          </div>
          <div class="agent-create" v-if="showAgentCreate">
            <input v-model="newAgentName" class="setting-input" placeholder="角色名称" style="width:140px" />
            <select v-model="newAgentPreset" class="setting-select" style="width:130px">
              <option value="">默认风格</option>
              <option v-for="p in personalityPresets" :key="p.id" :value="p.id">{{ p.icon }} {{ p.name }}</option>
            </select>
            <button class="setting-btn primary" @click="createAgent" :disabled="!newAgentName.trim()">创建</button>
            <button class="setting-btn secondary" @click="showAgentCreate = false">取消</button>
          </div>
          <button v-else class="agent-add-btn" @click="showAgentCreate = true">+ 新建角色</button>

          <!-- 隐私 -->
          <div class="sect-label" style="margin-top:14px">隐私</div>
          <label class="setting-row">
            <span class="setting-label">共享记忆<br><small style="color:var(--text-muted)">开启后所有角色共用同一份记忆</small></span>
            <input v-model="sharedMemory" type="checkbox" class="setting-toggle" @change="toggleSharedMemory" />
          </label>

        </div>

        <!-- 系统 -->
        <div v-if="activeCat === 'system'" class="cat-content">
          <h3 class="cat-title">系统</h3>

          <div class="setting-group">
            <label class="setting-label">外观</label>
            <div class="theme-choices">
              <button v-for="t in themes" :key="t.value"
                class="theme-card" :class="{ active: appTheme === t.value }"
                @click="appTheme = t.value">
                <span class="theme-icon">{{ t.icon }}</span>
                <span class="theme-name">{{ t.label }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 关于 -->
        <!-- 人格 -->
        <div v-if="activeCat === 'personality'" class="cat-content">
          <PersonalityPanel :isDark="isDark" />
        </div>

        <!-- 记忆 -->
        <div v-if="activeCat === 'memory'" class="cat-content">
          <MemoryPanel :isDark="isDark" @refresh="refreshMemory" />
        </div>

        <!-- 音色 -->
        <div v-if="activeCat === 'voice'" class="cat-content">
          <VoiceClonePanel :isDark="isDark" />
        </div>

        <!-- 音乐 -->
        <div v-if="activeCat === 'music'" class="cat-content cat-content-wide">
          <MusicPanel />
        </div>

        <!-- 隐私 -->
        <div v-if="activeCat === 'privacy'" class="cat-content">
          <PrivacyPanel :isDark="isDark" />
        </div>

        <div v-if="activeCat === 'about'" class="cat-content">
          <h3 class="cat-title">关于</h3>

          <div class="about-icon">▮</div>
          <div class="about-app-name">案</div>
          <div class="about-version">v1.0.0</div>
          <p class="about-desc">
            桌面上的智能助手。支持多家 LLM、多角色协作、拖放文件分析、记忆系统。
          </p>

          <div class="about-section">
            <div class="about-label">灵感来源</div>
            <a class="about-link" href="https://hermespet.cc" target="_blank">HermesPet</a>
          </div>

          <div class="about-section">
            <div class="about-label">技术栈</div>
            <div class="about-stack">Electron · Vue 3 · Canvas 2D · Python LangChain Agent</div>
          </div>

          <div class="about-section">
            <div class="about-label">Agent 引擎</div>
            <div class="about-stack">ReAct 循环 · 工具调用 · Chroma 长期记忆 · RAG 文档检索</div>
          </div>

          <div class="about-section">
            <div class="about-label">存储位置</div>
            <code class="about-path">~/.ai-desktop-pet/</code>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'

const emit = defineEmits(['done'])

// 分类
import { User, Zap, Bot, Settings, Info, Brain, Shield, Mic, HardDrive, Music } from 'lucide-vue-next'
import MemoryPanel from '../memory/MemoryPanel.vue'
import PersonalityPanel from '../personality/PersonalityPanel.vue'
import PrivacyPanel from './PrivacyPanel.vue'
import VoiceClonePanel from '../voice/VoiceClonePanel.vue'
import MusicPanel from '../music/MusicPanel.vue'

const categories = [
  { id: 'profile',     icon: User,     label: '用户',   color: '#6366F1' },
  { id: 'backend',     icon: Zap,      label: '服务商', color: '#3B82F6' },
  { id: 'personality', icon: Brain,    label: '人格',   color: '#8B5CF6' },
  { id: 'pet',         icon: Bot,      label: '助手',   color: '#EC4899' },
  { id: 'memory',      icon: HardDrive, label: '记忆',  color: '#F59E0B' },
  { id: 'voice',       icon: Mic,      label: '音色',   color: '#10B981' },
  { id: 'music',       icon: Music,    label: '音乐',   color: '#EC4141' },
  { id: 'system',      icon: Settings, label: '系统',   color: '#6B7280' },
  { id: 'privacy',     icon: Shield,   label: '隐私',   color: '#EF4444' },
  { id: 'about',       icon: Info,     label: '关于',   color: '#6B7280' },
]
const activeCat = ref('profile')

function onSidebarClick(e) {
  e.stopPropagation()
  const btn = e.target.closest('[data-cat]')
  if (btn) {
    activeCat.value = btn.dataset.cat
  }
}

// 预加载配置文件（主进程文件）
const apiKey = ref('')
const visionApiKey = ref('')
const dashscopeApiKey = ref('')
const minimaxApiKey = ref('')
const provider = ref('claude')

// 异步加载已保存配置
;(async () => {
  const cfg = await window.electronAPI?.loadConfig()
  if (cfg) {
    apiKey.value = cfg.apiKey || ''
    visionApiKey.value = cfg.visionApiKey || ''
    dashscopeApiKey.value = cfg.dashscopeApiKey || ''
    minimaxApiKey.value = cfg.minimaxApiKey || ''
    provider.value = cfg.provider || 'claude'
    claudeModel.value = (cfg.provider === 'claude' && cfg.model) ? cfg.model : 'claude-sonnet-4-20250506'
    deepseekModel.value = (cfg.provider === 'deepseek' && cfg.model) ? cfg.model : 'deepseek-chat'
    openaiModel.value = (cfg.provider === 'openai' && cfg.model) ? cfg.model : 'gpt-4o'
    openaiBaseUrl.value = (cfg.provider === 'openai' && cfg.baseUrl) ? cfg.baseUrl : 'https://api.openai.com/v1'
  }
})()

// 服务商卡片
const providers = [
  { id: 'claude',   icon: '🦞', color: '#B7A48E', name: 'Claude',   desc: 'Anthropic · 深度推理' },
  { id: 'deepseek', icon: '☁️', color: '#9BB7AA', name: 'DeepSeek', desc: '高性价比 · 中文出色' },
  { id: 'openai',   icon: '⌨️', color: '#9DC0AF', name: 'OpenAI',   desc: '兼容接口 · 灵活配置' },
]
const claudeModel = ref('claude-sonnet-4-20250506')
const deepseekModel = ref('deepseek-chat')
const openaiModel = ref('gpt-4o')
const openaiBaseUrl = ref('https://api.openai.com/v1')
const userProfile = ref({})
const saving = ref(false)
const error = ref(null)

// 用户设置: 头像 + 称呼
const userAvatar = ref(localStorage.getItem('user-avatar') || '')
const avatarColor = ref(localStorage.getItem('user-avatar-color') || '#6366F1')
const userNickname = ref(localStorage.getItem('user-nickname') || '')
const nicknameHint = ref('')
const nicknameError = ref(false)

// 敏感词黑名单
const NICKNAME_BLACKLIST = [
  '爸爸','爹','爷爷','主人','主子','陛下','皇上','女王','大人',
  '老公','老婆','宝贝','亲爱的','甜心','honey','babe','daddy','mommy','master',
  '傻逼','sb','fuck','shit','damn','废物','垃圾','白痴','去死','死',
]
// 正则匹配中英文低俗模式
const NICKNAME_BAD_PATTERN = /(傻|蠢|笨|猪|狗|死|滚|操|草|艹|fuck|shit|bitch|ass|damn)/i

async function pickAvatar() {
  const dataUrl = await window.electronAPI?.pickAvatar()
  if (dataUrl) {
    userAvatar.value = dataUrl
    // 图片上传时同步设一个颜色 (从图片中提取, 默认暖色)
    avatarColor.value = '#6366F1'
  }
}

watch(userAvatar, v => {
  localStorage.setItem('user-avatar', v)
})
watch(avatarColor, v => {
  localStorage.setItem('user-avatar-color', v)
})

function onNicknameInput() {
  const v = userNickname.value.trim()
  nicknameError.value = false
  nicknameHint.value = ''

  if (!v) return

  // 黑名单检查
  for (const word of NICKNAME_BLACKLIST) {
    if (v.toLowerCase().includes(word.toLowerCase())) {
      nicknameError.value = true
      nicknameHint.value = `称呼不能包含"${word}"，请换一个`
      return
    }
  }
  // 模式匹配
  if (NICKNAME_BAD_PATTERN.test(v)) {
    nicknameError.value = true
    nicknameHint.value = '称呼包含不当用词，请换一个'
    return
  }
  if (v.length > 10) {
    nicknameError.value = true
    nicknameHint.value = '称呼不能超过 10 个字'
    return
  }
  if (v.length >= 2) {
    nicknameHint.value = '称呼已设置，Agent 将这样称呼你'
  }
}

watch(userNickname, v => {
  if (!nicknameError.value) {
    if (v) localStorage.setItem('user-nickname', v)
    else localStorage.removeItem('user-nickname')
  }
})

// Agent 状态
const agentReady = ref(false)
const agentChecking = ref(true)
const memoryCount = ref(0)
const indexedCount = ref(0)
const expertCount = ref(0)
const activeExpertCount = ref(0)

// 检查 Agent 就绪状态
;(async () => {
  try {
    const result = await window.electronAPI?.agentPing()
    agentReady.value = result?.ready || false

    // 加载角色统计
    try {
      const roles = JSON.parse(localStorage.getItem('custom-roles') || '[]')
      expertCount.value = roles.length
      activeExpertCount.value = roles.filter(r => r.auto_invoke).length
    } catch { /* ignore */ }
    memoryCount.value = result?.memory_count || result?.memoryCount || 0
    indexedCount.value = result?.indexed_files || result?.indexedFiles || 0
    if (result?.profile) {
      userProfile.value = result.profile
    }
  } catch { agentReady.value = false }
  finally { agentChecking.value = false }
})()

async function clearMemory() {
  try {
    await window.electronAPI?.agentClearMemory()
    memoryCount.value = 0
    error.value = '记忆已清空 ✓'
    setTimeout(() => { error.value = null }, 2000)
  } catch { error.value = '清空失败' }
}

// 模型选项
const claudeModels = [
  { value: 'claude-sonnet-4-20250506', label: 'Sonnet 4' },
  { value: 'claude-opus-4-20250514',   label: 'Opus 4' },
  { value: 'claude-haiku-4-20250501',  label: 'Haiku 4' },
]
const deepseekModels = [
  { value: 'deepseek-v4-flash', label: '⚡ 极速' },
  { value: 'deepseek-v4-pro',   label: '🕯️ 深度' },
]

// 快速风格预设（点击填入行为风格，新建 Agent 时可选）
const personalityPresets = [
  { id: 'default', icon: '✦', name: '自然友好',
    identity: '我是{{name}}，案中的一个智能助手，知识渊博、响应迅速。',
    ishiki: '用温暖友善的语气说话\n回复简洁自然\n可以适当使用语气词' },
  { id: 'gentle', icon: '♡', name: '温柔可靠',
    identity: '我是{{name}}，案中一个温和陪伴的伙伴，善于倾听。',
    ishiki: '温和包容的语气\n先安慰再建议，永远不说教\n主动关心对方感受\n多用温暖的话语' },
  { id: 'lively', icon: '✿', name: '活泼小精灵',
    identity: '我是{{name}}，案中一个元气满满的小帮手！',
    ishiki: '元气满满\n爱用颜文字和语气词 (✧ω✧)\n说话像蹦蹦跳跳的\n用大量感叹号和拟声词' },
  { id: 'pro', icon: '◆', name: '专业效率',
    identity: '我是{{name}}，案中的专业顾问，擅长高效解决问题。',
    ishiki: '只说有用的\n拒绝废话和寒暄\n直接给方案，先结论后论证\n语言精准干练' },
  { id: 'cold', icon: '◇', name: '高冷话少',
    identity: '我是{{name}}，案中的助手。',
    ishiki: '惜字如金\n能说一个字绝不说两个\n不寒暄不闲聊\n用最少的字表达意思' },
]

// 角色人格编辑
const editIdentity = ref('')
const editIshiki = ref('')
const saveMsg = ref('')
const savingPersonality = ref(false)

const defaultIdentity = `我是{{name}}，案中的一个智能助手。我知识渊博、响应迅速，能帮你解决各种问题——日常咨询、技术难题、文件分析、网络搜索，样样都行。说话简洁高效，但也不失温度。`
const defaultIshiki = `用干练专业的语气说话
先给结论，再展开解释
不确定的事情诚实说"让我查一下"
主动记住用户的偏好和习惯
中文为主，代码用英文`

function applyPreset(p) {
  editIshiki.value = p.ishiki
}

async function savePersonality() {
  savingPersonality.value = true
  saveMsg.value = ''
  try {
    await window.electronAPI?.agentUpdatePersonality(
      editIdentity.value || defaultIdentity,
      editIshiki.value || defaultIshiki,
    )
    saveMsg.value = '已保存 ✓'
    setTimeout(() => saveMsg.value = '', 2000)
  } catch (e) {
    saveMsg.value = '保存失败: ' + e.message
  } finally {
    savingPersonality.value = false
  }
}

// Agent 管理
const agentList = ref([])
const showAgentCreate = ref(false)
const newAgentName = ref('')
const newAgentPreset = ref('')

async function loadAgents() {
  try {
    const result = await window.electronAPI?.agentList()
    agentList.value = result?.data?.agents || result?.agents || []
  } catch { agentList.value = [] }
}
async function createAgent() {
  if (!newAgentName.value.trim()) return
  try {
    // Build identity/ishiki from preset
    let identity = ''
    let ishiki = ''
    if (newAgentPreset.value) {
      const preset = personalityPresets.find(p => p.id === newAgentPreset.value)
      if (preset) {
        identity = preset.identity || ''
        ishiki = preset.ishiki || ''
      }
    }
    await window.electronAPI?.agentCreateWithPersonality(
      newAgentName.value.trim(),
      identity,
      ishiki,
    )
    newAgentName.value = ''
    newAgentPreset.value = ''
    showAgentCreate.value = false
    await loadAgents()
  } catch (e) { console.error(e) }
}
async function switchAgent(id) {
  try {
    await window.electronAPI?.agentSwitch(id)
    localStorage.setItem('active-agent-id', id)
    await loadAgents()
  } catch (e) { console.error(e) }
}
async function deleteAgent(id) {
  if (!confirm('确定删除这个角色？')) return
  try {
    await window.electronAPI?.agentDelete(id)
    await loadAgents()
  } catch (e) { console.error(e) }
}

// 隐私
const sharedMemory = ref(localStorage.getItem('shared-memory') === 'true')
function toggleSharedMemory() {
  localStorage.setItem('shared-memory', sharedMemory.value ? 'true' : 'false')
  window.electronAPI?.agentToggleSharedMemory(sharedMemory.value)
}

const appTheme = ref(localStorage.getItem('app-theme') || 'system')
const themes = [
  { label: '浅色', value: 'light', icon: '☀️' },
  { label: '深色', value: 'dark', icon: '🌙' },
  { label: '跟随系统', value: 'system', icon: '🖥️' },
]

// 持久化
watch(appTheme, v => {
  localStorage.setItem('app-theme', v)
  applyTheme(v)
})

const isDark = ref(false)
function applyTheme(theme) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  isDark.value = theme === 'dark' || (theme === 'system' && prefersDark)
  document.documentElement.classList.toggle('dark', isDark.value)
}

function refreshMemory() {
  memoryCount.value = parseInt(localStorage.getItem('memory-count') || '0', 10)
}

// 初始化主题
applyTheme(appTheme.value)
// 监听系统主题变化
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (appTheme.value === 'system') applyTheme('system')
})

async function save() {
  saving.value = true; error.value = null
  try {
    const { llmService } = await import('../../llm/LLMProvider')
    const { useLLMStore } = await import('../../store/llmStore')

    let model = claudeModel.value
    if (provider.value === 'deepseek') model = deepseekModel.value
    else if (provider.value === 'openai') model = openaiModel.value

    const config = {
      provider: provider.value,
      apiKey: apiKey.value,
      visionApiKey: visionApiKey.value || '',
      dashscopeApiKey: dashscopeApiKey.value || '',
      minimaxApiKey: minimaxApiKey.value || '',
      model,
      baseUrl: provider.value === 'openai' ? openaiBaseUrl.value : undefined,
    }

    // 保存到主进程文件（跨重启可靠持久化）
    window.electronAPI?.saveConfig(config)
    // 同时存 localStorage 作为备份
    localStorage.setItem('llm-config', JSON.stringify(config))
    localStorage.setItem('llm-config-preview', apiKey.value)
    localStorage.setItem('llm-provider', provider.value)
    localStorage.setItem('llm-model', model)
    if (config.baseUrl) localStorage.setItem('llm-baseurl', config.baseUrl)
    await useLLMStore.getState().setConfig(config)
    emit('done')
  } catch (e) { error.value = String(e) }
  finally { saving.value = false }
}

// 立即持久化配置
function doSave() {
  if (!apiKey.value) return
  let model = claudeModel.value
  if (provider.value === 'deepseek') model = deepseekModel.value
  else if (provider.value === 'openai') model = openaiModel.value
  const cfg = { provider: provider.value, apiKey: apiKey.value, visionApiKey: visionApiKey.value || '', dashscopeApiKey: dashscopeApiKey.value || '', minimaxApiKey: minimaxApiKey.value || '', model, baseUrl: provider.value === 'openai' ? openaiBaseUrl.value : undefined }
  window.electronAPI?.saveConfig(cfg)
  localStorage.setItem('llm-config', JSON.stringify(cfg))
  localStorage.setItem('llm-provider', provider.value)
  localStorage.setItem('llm-model', model)
}

// 文本输入防抖，模型/provider 切换立即保存
let _saveTimer = null
function autoSave() {
  clearTimeout(_saveTimer)
  _saveTimer = setTimeout(doSave, 500)
}
// provider 和 model 切换立即保存（用户点击选择，不需要防抖）
watch([provider, claudeModel, deepseekModel, openaiModel], () => doSave())
// apiKey 等文本输入使用防抖
watch([apiKey, openaiBaseUrl, visionApiKey, dashscopeApiKey, minimaxApiKey], autoSave)

async function testConn() {
  error.value = null; saving.value = true
  try {
    let model = claudeModel.value
    if (provider.value === 'deepseek') model = deepseekModel.value
    else if (provider.value === 'openai') model = openaiModel.value

    const result = await window.electronAPI?.llmInit?.({
      provider: provider.value,
      apiKey: apiKey.value,
      visionApiKey: visionApiKey.value || '',
      dashscopeApiKey: dashscopeApiKey.value || '',
      model,
      baseUrl: provider.value === 'openai' ? openaiBaseUrl.value : undefined,
    })
    error.value = result?.success ? '连接成功 ✓' : `连接失败: ${result?.error || '未知错误'}`
  } catch (e) {
    error.value = `连接失败: ${e}`
  } finally {
    saving.value = false
  }
}

onMounted(() => { loadAgents() })
</script>

<style scoped>

/* Premium interaction refinements */
button, .btn, .setting-btn, .model-chip, .conv-pill {
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


/* Settings Panel — Unified Design System */

.settings-backdrop {
  position: absolute; inset: 0; z-index: 999;
  background: rgba(0,0,0,0.25);
  backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
}

.settings-panel {
  width: 720px; max-width: 92vw; height: 88vh; margin: 0;
  align-self: center;
  background: var(--bg);
  border: 1px solid var(--border);
  box-shadow: 0 16px 48px rgba(0,0,0,0.35);
  border-radius: 20px; overflow: hidden;
  display: flex;
  animation: spIn .3s cubic-bezier(.16,1,.3,1);
}
@keyframes spIn { from { opacity: 0; transform: scale(.96) translateY(12px); } }

.settings-sidebar {
  width: 180px; flex-shrink: 0;
  padding: 24px 12px; display: flex; flex-direction: column; gap: 3px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
}
.settings-cat-btn {
  display: flex; align-items: center; gap: 12px;
  width: 100%; padding: 10px 14px; border-radius: 10px;
  background: transparent; cursor: pointer;
  font-size: 13.5px; font-weight: 500; font-family: inherit; color: var(--text-secondary);
  transition: all 0.18s cubic-bezier(.16,1,.3,1); text-align: left; border: none;
}
.settings-cat-btn:hover { background: var(--bg-sidebar-hover); color: var(--text-primary); transform: translateX(2px); }
.settings-cat-btn.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
.cat-icon { display: flex; align-items: center; flex-shrink: 0; }
.cat-label { font-size: 13.5px; }

.settings-divider { width: 1px; flex-shrink: 0; background: var(--border); }

.settings-detail { flex: 1; overflow-y: auto; padding: 36px 44px; }

.cat-content { display: flex; flex-direction: column; gap: 18px; max-width: 540px; }
.cat-content-wide { max-width: 600px; }

.cat-title { font-size: 20px; font-weight: 700; color: var(--text-primary); margin: 0 0 4px; letter-spacing: -.3px; }
.cat-desc { font-size: 12.5px; color: var(--text-muted); line-height: 1.5; }

.setting-group { display: flex; flex-direction: column; gap: 7px; }
.setting-label { font-size: 12.5px; font-weight: 600; color: var(--text-primary); letter-spacing: -.1px; }
.setting-hint { font-size: 11px; color: var(--text-muted); }

.setting-input, .setting-select {
  width: 100%; padding: 10px 14px; border-radius: 10px;
  border: 1px solid var(--border); font-size: 13.5px; font-family: inherit;
  background: var(--bg-input); color: var(--text-primary);
  outline: none; transition: all 0.2s;
}
.setting-input:hover { border-color: var(--border-strong); }
.setting-input:focus { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); background: var(--bg-card); }
.setting-textarea {
  width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px;
  font-size: 13px; font-family: inherit; color: var(--text-primary); line-height: 1.6;
  background: var(--bg-input); outline: none; resize: vertical;
  transition: all 0.2s;
}
.setting-textarea:hover { border-color: var(--border-strong); }
.setting-textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); background: var(--bg-card); }
.setting-error { font-size: 12px; color: var(--danger); }

.setting-actions { display: flex; gap: 10px; margin-top: 12px; }
.setting-btn {
  padding: 10px 22px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg-card); cursor: pointer; font-family: inherit; font-size: 13.5px;
  font-weight: 500; color: var(--text-secondary); transition: all 0.18s cubic-bezier(.16,1,.3,1);
}
.setting-btn:hover { background: var(--bg-sidebar-hover); color: var(--text-primary); transform: translateY(-1px); }
.setting-btn:active { transform: scale(.98); }
.setting-btn:disabled { opacity: 0.35; cursor: default; transform: none; }
.setting-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
.setting-btn.primary:hover { filter: brightness(1.12); box-shadow: 0 4px 14px rgba(109,124,255,0.25); }
.setting-btn.secondary { background: var(--bg-card); }

/* Provider */
.provider-cards { display: flex; flex-direction: column; gap: 8px; }
.provider-card {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--bg-card);
  cursor: pointer; transition: all 0.18s cubic-bezier(.16,1,.3,1); text-align: left;
}
.provider-card:hover { border-color: var(--border-strong); background: var(--bg-sidebar-hover); transform: translateY(-1px); }
.provider-card.active { border-color: var(--accent); background: var(--accent-soft); }
.provider-card-icon { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; }
.provider-card-text { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.provider-card-name { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
.provider-card-desc { font-size: 11.5px; color: var(--text-muted); }
.provider-card-check { color: var(--accent); font-size: 16px; }

.model-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.model-chip {
  padding: 7px 16px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg-card); cursor: pointer; font-size: 12.5px; font-weight: 500; font-family: inherit;
  color: var(--text-secondary); transition: all 0.18s cubic-bezier(.16,1,.3,1);
}
.model-chip:hover { background: var(--bg-sidebar-hover); color: var(--text-primary); transform: translateY(-1px); }
.model-chip:active { transform: scale(.97); }
.model-chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }

.provider-config {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px; background: var(--bg-sidebar);
  border-radius: 10px; border: 1px solid var(--border);
}

/* Personality */
.personality-grid { display: flex; flex-direction: column; gap: 5px; }
.personality-card {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-card); cursor: pointer; transition: all 0.18s cubic-bezier(.16,1,.3,1); text-align: left;
}
.personality-card:hover { border-color: var(--border-strong); background: var(--bg-sidebar-hover); transform: translateY(-1px); }
.personality-card.active { border-color: var(--accent); background: var(--accent-soft); }
.personality-icon { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; background: var(--accent-soft); color: var(--accent); font-size: 17px; flex-shrink: 0; }
.personality-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.personality-name { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
.personality-desc { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.personality-check { color: var(--accent); font-size: 14px; flex-shrink: 0; }
.personality-del {
  width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--border);
  background: var(--bg-card); cursor: pointer; font-size: 11px; display: flex; align-items: center; justify-content: center; color: var(--text-muted); transition: all 0.15s;
}
.personality-del:hover { background: var(--danger); color: #fff; border-color: var(--danger); }
.personality-add-btn {
  padding: 8px 14px; border: 1.5px dashed var(--border); border-radius: 10px;
  background: none; cursor: pointer; font-size: 12.5px; font-family: inherit; color: var(--text-muted); transition: all 0.18s;
}
.personality-add-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

/* Section labels */
.sect-label { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); margin-bottom: 2px; letter-spacing: -.1px; }

/* Style chips */
.style-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.style-chip {
  padding: 8px 16px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg-card); cursor: pointer; font-size: 12.5px; font-family: inherit;
  color: var(--text-secondary); transition: all 0.18s cubic-bezier(.16,1,.3,1);
}
.style-chip:hover { border-color: var(--border-strong); background: var(--bg-sidebar-hover); transform: translateY(-1px); }
.custom-form { margin-top: 10px; padding: 14px; background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 10px; display: flex; flex-direction: column; gap: 10px; }
.custom-form-hint { font-size: 11.5px; color: var(--text-secondary); line-height: 1.65; margin: 8px 0; padding: 12px 14px; background: var(--bg-sidebar-hover); border-radius: 10px; }
.custom-form-hint b { color: var(--text-primary); font-weight: 600; }
.custom-form-actions { display: flex; gap: 8px; }

/* Toggle */
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.setting-toggle {
  width: 44px; height: 24px; -webkit-appearance: none; appearance: none;
  background: var(--border-strong); border-radius: 12px;
  position: relative; cursor: pointer; transition: background 0.2s; flex-shrink: 0;
}
.setting-toggle::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 20px; height: 20px; border-radius: 50%;
  background: #fff; transition: transform 0.22s cubic-bezier(0.34,1.56,0.64,1);
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
.setting-toggle:checked { background: var(--accent); }
.setting-toggle:checked::after { transform: translateX(20px); }

/* Theme */
.theme-choices { display: flex; gap: 8px; }
.theme-card {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 14px 10px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg-card);
  font-family: inherit; font-size: 12.5px; color: var(--text-muted); transition: all 0.18s cubic-bezier(.16,1,.3,1);
}
.theme-card:hover { border-color: var(--border-strong); transform: translateY(-2px); }
.theme-card.active { border-color: var(--accent); background: var(--accent-soft); color: var(--text-primary); box-shadow: 0 0 0 3px var(--accent-soft); }
.theme-icon { font-size: 22px; }
.theme-name { font-size: 12px; }

/* Profile */
.profile-card { background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
.profile-item { display: flex; gap: 10px; align-items: center; }
.profile-key { font-size: 11.5px; color: var(--text-muted); min-width: 48px; font-weight: 500; }
.profile-value { font-size: 13.5px; color: var(--text-primary); font-weight: 500; }
.profile-empty { font-size: 13px; color: var(--text-muted); }

/* Avatar */
.avatar-row { display: flex; align-items: center; gap: 14px; }
.avatar-current { width: 56px; height: 56px; border-radius: 50%; display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
.avatar-current .avatar-img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
.avatar-upload-btn { padding: 6px 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-card); cursor: pointer; font-size: 12.5px; font-family: inherit; color: var(--text-secondary); transition: all 0.18s cubic-bezier(.16,1,.3,1); }
.avatar-upload-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); transform: translateY(-1px); }

/* Misc */
.nickname-hint { font-size: 11.5px; color: var(--accent); margin-top: 4px; }
.nickname-hint.error { color: var(--danger); }
.memory-stats { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; }
.mem-stat { font-size: 13.5px; color: var(--text-primary); }
.mem-clear-btn { padding: 6px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-card); cursor: pointer; font-size: 11.5px; font-family: inherit; color: var(--text-muted); transition: all 0.18s; }
.mem-clear-btn:hover { border-color: var(--danger); color: var(--danger); background: rgba(255,59,48,0.05); }
.mem-clear-btn:disabled { opacity: 0.35; cursor: default; }
.role-stats { display: flex; gap: 20px; align-items: center; }
.role-stat { font-size: 13.5px; color: var(--text-primary); }

/* Agent */
.agent-status { display: flex; flex-direction: column; gap: 10px; padding: 14px; background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 10px; }
.agent-status-header { display: flex; align-items: center; gap: 10px; }
.agent-status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--border-strong); box-shadow: 0 0 0 3px transparent; transition: all 0.3s; }
.agent-status-dot.online { background: var(--success); box-shadow: 0 0 0 3px rgba(52,199,89,0.15); }
.agent-status-label { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
.agent-status-text { font-size: 11.5px; color: var(--text-secondary); margin-left: auto; }
.agent-status-text.offline { color: var(--text-muted); }
.agent-stats { display: flex; gap: 20px; font-size: 12.5px; color: var(--text-secondary); }
.agent-actions { display: flex; gap: 8px; }
.agent-action-btn { padding: 6px 16px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-card); cursor: pointer; font-size: 12.5px; font-family: inherit; color: var(--text-secondary); transition: all 0.18s cubic-bezier(.16,1,.3,1); }
.agent-action-btn:hover { background: var(--bg-sidebar-hover); color: var(--text-primary); transform: translateY(-1px); }
.agent-action-btn:hover { border-color: var(--danger); color: var(--danger); }

/* About */
.about-icon { font-size: 48px; text-align: center; margin-top: 16px; }
.about-app-name { font-size: 20px; font-weight: 700; text-align: center; color: var(--text-primary); margin-top: 8px; }
.about-version { font-size: 13px; color: var(--text-muted); text-align: center; }
.about-desc { font-size: 13px; color: var(--text-secondary); text-align: center; line-height: 1.6; }
.about-section { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 8px; background: var(--bg-sidebar); }
.about-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.about-link { font-size: 12px; color: var(--text-secondary); text-decoration: none; }
.about-link:hover { color: var(--accent); }
.about-stack { font-size: 12px; color: var(--text-primary); }
.about-path { font-size: 11px; background: var(--bg-sidebar); padding: 2px 8px; border-radius: 6px; font-family: monospace; color: var(--text-primary); }

/* Profile hero */
.profile-hero {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  padding: 12px 0 20px;
}
.avatar-circle {
  width: 88px; height: 88px; border-radius: 50%;
  position: relative; cursor: pointer; overflow: hidden;
  transition: transform 0.25s cubic-bezier(.16,1,.3,1);
  box-shadow: 0 4px 16px rgba(0,0,0,0.25);
}
.avatar-circle:hover { transform: scale(1.06); }
.avatar-overlay {
  position: absolute; inset: 0; border-radius: 50%;
  background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center;
  font-size: 22px; opacity: 0; transition: opacity 0.2s;
}
.avatar-circle:hover .avatar-overlay { opacity: 1; }
.avatar-circle .avatar-img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
.avatar-geo { width: 100%; height: 100%; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.avatar-geo-svg { width: 100%; height: 100%; }
.profile-name { font-size: 19px; font-weight: 700; color: var(--text-primary); letter-spacing: -.2px; }
.profile-upload-btn {
  padding: 6px 16px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg-card); cursor: pointer; font-size: 12.5px; font-family: inherit;
  color: var(--text-secondary); transition: all 0.18s cubic-bezier(.16,1,.3,1);
}
.profile-upload-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); transform: translateY(-1px); }

/* Agent row badge & create */
.agent-row-badge {
  display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: var(--accent-soft); color: var(--accent); font-weight: 600;
  margin-left: 6px; vertical-align: middle;
}
.agent-create {
  display: flex; gap: 8px; align-items: center;
}

/* Utility */
.setting-error { font-size: 12px; color: var(--danger); margin: 4px 0; }
</style>

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
                <svg viewBox="0 0 40 40"><path d="M12 28 Q20 8 28 28" fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="1.5" stroke-linecap="round"/><path d="M8 22 Q20 16 32 22" fill="none" stroke="rgba(0,0,0,0.1)" stroke-width="1.5" stroke-linecap="round"/><circle cx="20" cy="18" r="3" fill="rgba(255,255,255,0.3)"/></svg>
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

        </div>

        <!-- 服务商 -->
        <div v-if="activeCat === 'backend'" class="cat-content">
          <!-- 服务商选择：水平卡片 -->
          <div class="provider-grid">
            <button v-for="p in providers" :key="p.id"
              class="provider-tile" :class="{ active: provider === p.id }"
              @click="provider = p.id">
              <span class="provider-tile-icon" :style="{ background: p.color + '18', color: p.color }" v-html="p.icon"></span>
              <span class="provider-tile-name">{{ p.name }}</span>
              <span class="provider-tile-desc">{{ p.desc }}</span>
              <span v-if="provider === p.id" class="provider-tile-check">✓</span>
            </button>
          </div>

          <!-- 模型选择（紧跟服务商） -->
          <div v-if="provider === 'claude'" class="model-row">
            <span class="model-row-label">模型</span>
            <div class="model-chips">
              <button v-for="m in claudeModels" :key="m.value" class="model-chip" :class="{ active: claudeModel === m.value }" @click="claudeModel = m.value">{{ m.label }}</button>
            </div>
          </div>
          <div v-if="provider === 'deepseek'" class="model-row">
            <span class="model-row-label">模型</span>
            <div class="model-chips">
              <button v-for="m in deepseekModels" :key="m.value" class="model-chip" :class="{ active: deepseekModel === m.value }" @click="deepseekModel = m.value">{{ m.label }}</button>
            </div>
          </div>
          <div v-if="provider === 'openai'" class="model-row">
            <span class="model-row-label">接入</span>
            <div class="provider-config-inline">
              <input v-model="openaiBaseUrl" class="setting-input-inline" placeholder="API 地址" />
              <input v-model="openaiModel" class="setting-input-inline" placeholder="模型名称" />
            </div>
          </div>

          <!-- API Keys：双列网格 -->
          <div class="apikey-grid">
            <div class="apikey-item">
              <label class="apikey-label">主模型 Key</label>
              <input v-model="apiKey" type="password" class="apikey-input" placeholder="sk-..." />
            </div>
            <div class="apikey-item">
              <label class="apikey-label">视觉 Key <small>百炼 Qwen-VL</small></label>
              <input v-model="visionApiKey" type="password" class="apikey-input" placeholder="可选" />
            </div>
            <div class="apikey-item">
              <label class="apikey-label">语音 Key <small>百炼 CosyVoice</small></label>
              <input v-model="dashscopeApiKey" type="password" class="apikey-input" placeholder="可选" />
            </div>
            <div class="apikey-item">
              <label class="apikey-label">TTS Key <small class="text-accent">推荐</small></label>
              <input v-model="minimaxApiKey" type="password" class="apikey-input" placeholder="可选" />
            </div>
          </div>

          <!-- 底部操作 -->
          <div class="backend-footer">
            <div class="setting-actions">
              <button class="setting-btn secondary" @click="testConn">测试连接</button>
              <button class="setting-btn primary" :disabled="!apiKey || saving" @click="save">{{ saving ? '连接中...' : '保存' }}</button>
            </div>
          </div>

          <p v-if="connMessage" class="conn-banner" :class="connStatus">{{ connMessage }}</p>
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

        <div v-if="activeCat === 'skills'" class="cat-content">
          <h3 class="cat-title">Skills</h3>
          <SkillSettingsPanel />
        </div>

        <div v-if="activeCat === 'about'" class="cat-content">
          <h3 class="cat-title">关于</h3>

          <div class="about-icon">▮</div>
          <div class="about-app-name">{{ appName }}</div>
          <div class="about-version">v{{ appVersion }}</div>
          <p class="about-desc">
            桌面上的智能助手。支持多家 LLM、多角色协作、拖放文件分析、记忆系统。
          </p>

          <!-- 更新 -->
          <div class="about-section update-section" v-if="updateStatus.status">
            <div class="update-row">
              <span class="update-status-icon" :class="updateStatus.status">{{ updateIcon }}</span>
              <span class="update-text">{{ updateStatus.message }}</span>
            </div>
            <div class="update-progress" v-if="updateStatus.status === 'downloading'">
              <div class="update-progress-bar" :style="{ width: (updateStatus.percent || 0) + '%' }"></div>
              <span class="update-progress-text">{{ updateStatus.percent || 0 }}%</span>
            </div>
            <div class="update-actions">
              <button v-if="updateStatus.status === 'available'" class="setting-btn primary" @click="doUpdateDownload">下载更新</button>
              <button v-if="updateStatus.status === 'downloaded'" class="setting-btn primary" @click="doUpdateInstall">重启并安装</button>
              <button v-if="updateStatus.status === 'error'" class="setting-btn secondary" @click="doCheckUpdate">重试</button>
            </div>
          </div>
          <button v-else class="setting-btn secondary" @click="doCheckUpdate" style="margin-top: 12px;">
            检查更新
          </button>

          <div class="about-section" style="margin-top: 16px;">
            <div class="about-label">灵感来源</div>
            <a class="about-link" href="https://hermespet.cc" target="_blank">HermesPet</a>
          </div>

          <div class="about-section">
            <div class="about-label">技术栈</div>
            <div class="about-stack">Electron · Vue 3 · Canvas 2D</div>
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
import { ref, watch, computed, onBeforeUnmount } from 'vue'

const emit = defineEmits(['done'])

// 分类
import { User, Zap, Settings, Info, Shield, Mic, Music, Puzzle } from 'lucide-vue-next'
import PrivacyPanel from './PrivacyPanel.vue'
import VoiceClonePanel from '../voice/VoiceClonePanel.vue'
import MusicPanel from '../music/MusicPanel.vue'
import SkillSettingsPanel from './SkillSettingsPanel.vue'

const categories = [
  { id: 'profile',     icon: User,     label: '用户',   color: '#6366F1' },
  { id: 'backend',     icon: Zap,      label: '服务商', color: '#3B82F6' },
  { id: 'voice',       icon: Mic,      label: '音色',   color: '#10B981' },
  { id: 'music',       icon: Music,    label: '音乐',   color: '#EC4141' },
  { id: 'system',      icon: Settings, label: '系统',   color: '#6B7280' },
  { id: 'privacy',     icon: Shield,   label: '隐私',   color: '#EF4444' },
  { id: 'skills',      icon: Puzzle,   label: 'Skills', color: '#F59E0B' },
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
  { id: 'claude',   icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#D97757" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z"/></svg>', color: '#D97757', name: 'Claude',   desc: 'Anthropic · 深度推理' },
  { id: 'deepseek', icon: '<svg viewBox="0 0 24 24" fill="#4C6EF5" style="width:16px;height:16px"><path d="M12 2l9 5v10l-9 5-9-5V7z"/></svg>', color: '#4C6EF5', name: 'DeepSeek', desc: '高性价比 · 中文出色' },
  { id: 'openai',   icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#10A37F" stroke-width="2" stroke-linecap="round" style="width:16px;height:16px"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>', color: '#10A37F', name: 'OpenAI',   desc: '兼容接口 · 灵活配置' },
]
const claudeModel = ref('claude-sonnet-4-20250506')
const deepseekModel = ref('deepseek-chat')
const openaiModel = ref('gpt-4o')
const openaiBaseUrl = ref('https://api.openai.com/v1')
const userProfile = ref({})
const saving = ref(false)
const connStatus = ref('') // 'success' | 'error'
const connMessage = ref('')
const error = ref(null) // 保留给 save 的异常兜底

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

// ── 版本 & 更新 ──
const appName = ref('Solace')
const appVersion = ref('0.0.0')
const updateStatus = ref({})

const updateIcon = computed(() => {
  const map = { checking: '⏳', available: '🆕', 'up-to-date': '✅', downloading: '📥', downloaded: '⚡', error: '❌' }
  return map[updateStatus.value.status] || ''
})

async function loadVersion() {
  try {
    const result = await window.electronAPI?.updateGetVersion()
    if (result) {
      appName.value = result.name || 'SonderPet'
      appVersion.value = result.version || '0.0.0'
    }
  } catch {}
}

async function doCheckUpdate() {
  updateStatus.value = { status: 'checking', message: '正在检查更新…' }
  await window.electronAPI?.updateCheck()
}

async function doUpdateDownload() {
  await window.electronAPI?.updateDownload()
}

async function doUpdateInstall() {
  await window.electronAPI?.updateInstall()
}

// 监听更新状态
let _unsubUpdate = null
function _listenUpdate() {
  _unsubUpdate = window.electronAPI?.onUpdateStatus?.((data) => {
    updateStatus.value = { ...updateStatus.value, ...data }
  })
}

// ── 主题 ──
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

// 初始化主题
applyTheme(appTheme.value)
// 监听系统主题变化
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (appTheme.value === 'system') applyTheme('system')
})

// 加载版本号并监听更新事件
loadVersion()
_listenUpdate()

onBeforeUnmount(() => {
  _unsubUpdate?.()
})

async function save() {
  saving.value = true; connMessage.value = ''; error.value = null
  try {
    const { llmService } = await import('../../llm/LLMProvider')
    const { useLLMStore } = await import('../../store/llmStore')

    const model = getSelectedModel()

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
  const model = getSelectedModel()
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
// 统一的模型选择逻辑（避免 save/doSave/testConn 三处重复）
function getSelectedModel() {
  if (provider.value === 'deepseek') return deepseekModel.value
  if (provider.value === 'openai') return openaiModel.value
  return claudeModel.value
}

// provider 和 model 切换立即保存（用户点击选择，不需要防抖）
watch([provider, claudeModel, deepseekModel, openaiModel], () => { connMessage.value = ''; doSave() })
// apiKey 等文本输入使用防抖
watch([apiKey, openaiBaseUrl, visionApiKey, dashscopeApiKey, minimaxApiKey], () => { connMessage.value = ''; autoSave() })

async function testConn() {
  connMessage.value = ''; saving.value = true
  try {
    const model = getSelectedModel()

    const result = await window.electronAPI?.llmInit?.({
      provider: provider.value,
      apiKey: apiKey.value,
      visionApiKey: visionApiKey.value || '',
      dashscopeApiKey: dashscopeApiKey.value || '',
      model,
      baseUrl: provider.value === 'openai' ? openaiBaseUrl.value : undefined,
    })
    if (result?.success) {
      connStatus.value = 'success'
      connMessage.value = '已连接'
    } else {
      connStatus.value = 'error'
      connMessage.value = result?.error || '连接失败'
    }
  } catch (e) {
    connStatus.value = 'error'
    connMessage.value = String(e)
  } finally {
    saving.value = false
    setTimeout(() => { connMessage.value = '' }, 4000)
  }
}

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

.setting-actions {
  display: flex; gap: 12px; width: 100%;
}
.setting-actions .setting-btn {
  flex: 1;
}
.setting-btn {
  padding: 11px 24px; border-radius: 10px; border: 1.5px solid var(--border);
  background: var(--bg-card); cursor: pointer; font-family: inherit; font-size: 13.5px;
  font-weight: 500; color: var(--text-secondary);
  transition: all 0.2s cubic-bezier(.16,1,.3,1);
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.setting-btn:hover {
  background: var(--bg-sidebar-hover); color: var(--text-primary);
  border-color: var(--border-strong);
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
}
.setting-btn:active { transform: scale(0.97); }
.setting-btn:disabled { opacity: 0.3; cursor: default; transform: none; box-shadow: none; }
.setting-btn.primary {
  background: var(--accent); color: #fff; border-color: var(--accent);
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(109,124,255,0.15);
}
.setting-btn.primary:hover {
  filter: brightness(1.1);
  box-shadow: 0 4px 16px rgba(109,124,255,0.3);
}
.setting-btn.primary:disabled { filter: none; box-shadow: none; }
.setting-btn.secondary {
  background: var(--bg-card); border-color: var(--border);
  color: var(--text-secondary);
}
.setting-btn.secondary:hover {
  background: var(--bg-sidebar-hover); color: var(--text-primary);
}

/* ── 服务商 ── */

/* 水平三列 */
.provider-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
}
.provider-tile {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 16px 12px 14px; border-radius: 12px;
  border: 1.5px solid var(--border);
  background: var(--bg-card); cursor: pointer;
  transition: all 0.2s cubic-bezier(.16,1,.3,1);
  position: relative;
}
.provider-tile:hover {
  border-color: var(--border-strong);
  background: var(--bg-sidebar-hover);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.08);
}
.provider-tile.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.provider-tile-icon {
  width: 44px; height: 44px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.2s;
}
.provider-tile:hover .provider-tile-icon { transform: scale(1.08); }
.provider-tile-icon :deep(svg) { width: 22px; height: 22px; }
.provider-tile-name {
  font-size: 14px; font-weight: 600; color: var(--text-primary);
}
.provider-tile-desc {
  font-size: 11px; color: var(--text-muted); text-align: center; line-height: 1.4;
}
.provider-tile-check {
  position: absolute; top: 8px; right: 10px;
  width: 20px; height: 20px; border-radius: 50%;
  background: var(--accent); color: #fff; font-size: 11px;
  display: flex; align-items: center; justify-content: center;
}

/* 模型行 */
.model-row {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px; border-radius: 10px;
  background: var(--bg-sidebar); border: 1px solid var(--border);
}
.model-row-label {
  font-size: 12.5px; font-weight: 600; color: var(--text-secondary);
  flex-shrink: 0; min-width: 36px;
}
.provider-config-inline {
  display: flex; gap: 8px; flex: 1;
}
.setting-input-inline {
  flex: 1; padding: 8px 12px; border-radius: 8px;
  border: 1px solid var(--border); font-size: 12.5px; font-family: inherit;
  background: var(--bg-input); color: var(--text-primary); outline: none;
  transition: border-color 0.2s;
}
.setting-input-inline:focus { border-color: var(--accent); }

/* 模型 chips */
.model-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.model-chip {
  padding: 8px 18px; border-radius: 10px;
  border: 1.5px solid var(--border);
  background: var(--bg-card); cursor: pointer;
  font-size: 13px; font-weight: 500; font-family: inherit;
  color: var(--text-secondary);
  transition: all 0.2s cubic-bezier(.16,1,.3,1);
  letter-spacing: 0.01em;
}
.model-chip:hover {
  background: var(--bg-sidebar-hover); color: var(--text-primary);
  border-color: var(--border-strong);
  box-shadow: 0 2px 6px rgba(0,0,0,0.05);
}
.model-chip:active { transform: scale(0.96); }
.model-chip.active {
  background: var(--accent-soft); border-color: var(--accent);
  color: var(--accent); font-weight: 600;
  box-shadow: 0 0 0 2px var(--accent-soft);
}

/* API Key 双列 */
.apikey-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
}
.apikey-item {
  display: flex; flex-direction: column; gap: 5px;
}
.apikey-label {
  font-size: 12px; font-weight: 600; color: var(--text-secondary);
  display: flex; align-items: baseline; gap: 6px;
}
.apikey-label small {
  font-size: 10.5px; font-weight: 400; color: var(--text-muted);
}
.apikey-label small.text-accent { color: var(--accent); font-weight: 500; }
.apikey-input {
  width: 100%; padding: 9px 12px; border-radius: 8px;
  border: 1px solid var(--border); font-size: 12.5px; font-family: inherit;
  background: var(--bg-input); color: var(--text-primary); outline: none;
  transition: border-color 0.2s;
}
.apikey-input:hover { border-color: var(--border-strong); }
.apikey-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

/* 底部操作栏 */
.backend-footer {
  display: flex; align-items: center; justify-content: flex-end;
  padding-top: 6px;
}

/* 连接状态横幅 */
.conn-banner {
  margin: 0; padding: 10px 16px; border-radius: 10px;
  font-size: 13px; font-weight: 500;
  display: flex; align-items: center; gap: 8px;
  animation: bannerIn 0.3s cubic-bezier(.16,1,.3,1);
}
.conn-banner.success {
  background: rgba(52,199,89,0.08);
  border: 1px solid rgba(52,199,89,0.2);
  color: #248a45;
}
.conn-banner.error {
  background: rgba(239,68,68,0.06);
  border: 1px solid rgba(239,68,68,0.15);
  color: #d63c3c;
}
@keyframes bannerIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

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
  width: 28px; height: 28px; border-radius: 8px; border: 1.5px solid var(--border);
  background: var(--bg-card); cursor: pointer; font-size: 13px;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); transition: all 0.2s;
}
.personality-del:hover { border-color: var(--danger); color: var(--danger); background: rgba(239,68,68,0.06); }
.personality-add-btn {
  padding: 10px 16px; border: 1.5px dashed var(--border); border-radius: 10px;
  background: none; cursor: pointer; font-size: 13px; font-family: inherit;
  color: var(--text-muted); font-weight: 500;
  transition: all 0.2s cubic-bezier(.16,1,.3,1);
}
.personality-add-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

/* Section labels */
.sect-label { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); margin-bottom: 2px; letter-spacing: -.1px; }

/* Style chips */
.style-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.style-chip {
  padding: 9px 18px; border-radius: 10px;
  border: 1.5px solid var(--border);
  background: var(--bg-card); cursor: pointer;
  font-size: 13px; font-family: inherit;
  color: var(--text-secondary);
  transition: all 0.2s cubic-bezier(.16,1,.3,1);
  letter-spacing: 0.01em;
}
.style-chip:hover {
  border-color: var(--border-strong); background: var(--bg-sidebar-hover);
  color: var(--text-primary);
  box-shadow: 0 2px 6px rgba(0,0,0,0.05);
}
.style-chip:active { transform: scale(0.96); }
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

/* Update */
.update-section {
  flex-direction: column; align-items: stretch; gap: 10px;
  margin-top: 12px; padding: 14px;
  background: var(--bg-card); border: 1px solid var(--border);
}
.update-row { display: flex; align-items: center; gap: 10px; }
.update-status-icon { font-size: 18px; flex-shrink: 0; }
.update-text { font-size: 13px; color: var(--text-primary); flex: 1; }
.update-actions { display: flex; gap: 8px; }
.update-progress {
  height: 6px; background: var(--bg-sidebar); border-radius: 3px;
  overflow: hidden; position: relative;
}
.update-progress-bar {
  height: 100%; background: var(--accent);
  border-radius: 3px; transition: width 0.3s;
}
.update-progress-text {
  font-size: 11px; color: var(--text-muted); text-align: center; display: block; margin-top: 2px;
}

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
  padding: 7px 18px; border-radius: 10px;
  border: 1.5px solid var(--border);
  background: var(--bg-card); cursor: pointer;
  font-size: 13px; font-family: inherit;
  color: var(--text-secondary); font-weight: 500;
  transition: all 0.2s cubic-bezier(.16,1,.3,1);
}
.profile-upload-btn:hover {
  border-color: var(--accent); color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 2px 8px rgba(109,124,255,0.1);
}


/* Utility */
.setting-error { font-size: 12px; color: var(--danger); margin: 4px 0; }
</style>

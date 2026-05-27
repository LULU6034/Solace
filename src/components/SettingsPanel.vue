<template>
  <div class="settings-backdrop" @click="emit('done')">
    <div class="settings-panel" @click.stop>
      <!-- 左侧分类 -->
      <div class="settings-sidebar"
        @mousedown="onSidebarClick" @click="onSidebarClick">
        <div v-for="cat in categories" :key="cat.id"
          class="settings-cat-btn" :class="{ active: activeCat === cat.id }"
          :data-cat="cat.id">
          <span class="cat-icon" :style="{ color: cat.color }">{{ cat.icon }}</span>
          <span class="cat-label">{{ cat.label }}</span>
        </div>
      </div>

      <div class="settings-divider" />

      <!-- 右侧详情 -->
      <div class="settings-detail">
        <!-- 用户 -->
        <div v-if="activeCat === 'profile'" class="cat-content">
          <h3 class="cat-title">用户设置</h3>

          <!-- 头像 -->
          <div class="setting-group">
            <label class="setting-label">头像</label>
            <div class="avatar-row">
              <div class="avatar-current" :style="userAvatar.startsWith('data:') ? {} : { background: avatarColor + '18' }">
                <img v-if="userAvatar.startsWith('data:')" :src="userAvatar" class="avatar-img" />
                <span v-else>{{ userAvatar }}</span>
              </div>
              <div class="avatar-actions">
                <span class="avatar-hint">聊天中你的消息头像</span>
                <button class="avatar-upload-btn" @click="pickAvatar">上传图片</button>
              </div>
            </div>
            <div class="avatar-grid">
              <button v-for="emoji in avatarOptions" :key="emoji"
                class="avatar-option" :class="{ active: userAvatar === emoji }"
                @click="userAvatar = emoji">{{ emoji }}</button>
            </div>
          </div>

          <!-- 称呼设置 -->
          <div class="setting-group">
            <label class="setting-label">对我的称呼</label>
            <input v-model="userNickname" class="setting-input"
              placeholder="让 Agent 这样叫你（如：小明、老板、亲爱的）"
              @input="onNicknameInput" />
            <span v-if="nicknameHint" class="nickname-hint" :class="{ error: nicknameError }">{{ nicknameHint }}</span>
          </div>

          <!-- 用户画像（AI 学习） -->
          <h3 class="cat-title" style="margin-top:20px">AI 画像</h3>
          <p class="cat-desc">从对话中自动学习</p>

          <div class="profile-card" v-if="userProfile.name || userProfile.city || userProfile.occupation">
            <div class="profile-item" v-if="userProfile.name">
              <span class="profile-key">名字</span>
              <span class="profile-value">{{ userProfile.name }}</span>
            </div>
            <div class="profile-item" v-if="userProfile.city">
              <span class="profile-key">城市</span>
              <span class="profile-value">{{ userProfile.city }}</span>
            </div>
            <div class="profile-item" v-if="userProfile.occupation">
              <span class="profile-key">职业</span>
              <span class="profile-value">{{ userProfile.occupation }}</span>
            </div>
            <div class="profile-item" v-if="userProfile.interests?.length">
              <span class="profile-key">兴趣</span>
              <span class="profile-value">{{ userProfile.interests.join('、') }}</span>
            </div>
            <div class="profile-item" v-if="userProfile.skills?.length">
              <span class="profile-key">技能</span>
              <span class="profile-value">{{ userProfile.skills.join('、') }}</span>
            </div>
          </div>
          <p v-else class="profile-empty">暂无，多聊几次 AI 就会自动了解你</p>

          <div class="setting-group" style="margin-top:16px">
            <label class="setting-label">记忆数据</label>
            <div class="memory-stats">
              <span class="mem-stat">🧠 {{ memoryCount }} 条</span>
              <button class="mem-clear-btn" @click="clearMemory" :disabled="memoryCount === 0">清空全部</button>
            </div>
          </div>
        </div>

        <!-- 服务商 -->
        <div v-if="activeCat === 'backend'" class="cat-content">
          <h3 class="cat-title">服务商</h3>

          <!-- 服务商卡片选择 -->
          <div class="provider-cards">
            <button v-for="p in providers" :key="p.id"
              class="provider-card" :class="{ active: provider === p.id }"
              @click="provider = p.id">
              <span class="provider-card-icon" :style="{ background: p.color + '15' }">{{ p.icon }}</span>
              <div class="provider-card-text">
                <span class="provider-card-name">{{ p.name }}</span>
                <span class="provider-card-desc">{{ p.desc }}</span>
              </div>
              <span v-if="provider === p.id" class="provider-card-check">✓</span>
            </button>
          </div>

          <!-- 通用 API Key -->
          <div class="setting-group">
            <label class="setting-label">API Key</label>
            <input v-model="apiKey" type="password" class="setting-input"
              placeholder="输入 API Key..." />
          </div>


          <!-- Claude 模型选择 -->
          <Transition name="config-slide">
            <div v-if="provider === 'claude'" class="provider-config">
              <div class="setting-group">
                <label class="setting-label">模型</label>
                <div class="model-chips">
                  <button v-for="m in claudeModels" :key="m.value"
                    class="model-chip" :class="{ active: claudeModel === m.value }"
                    @click="claudeModel = m.value">{{ m.label }}</button>
                </div>
              </div>
            </div>
          </Transition>

          <!-- DeepSeek 模型选择 -->
          <Transition name="config-slide">
            <div v-if="provider === 'deepseek'" class="provider-config">
              <div class="setting-group">
                <label class="setting-label">模型</label>
                <div class="model-chips">
                  <button v-for="m in deepseekModels" :key="m.value"
                    class="model-chip" :class="{ active: deepseekModel === m.value }"
                    @click="deepseekModel = m.value">{{ m.label }}</button>
                </div>
              </div>
            </div>
          </Transition>

          <!-- OpenAI 兼容配置 -->
          <Transition name="config-slide">
            <div v-if="provider === 'openai'" class="provider-config">
              <div class="setting-group">
                <label class="setting-label">API 地址</label>
                <input v-model="openaiBaseUrl" class="setting-input"
                  placeholder="https://api.openai.com/v1" />
              </div>
              <div class="setting-group">
                <label class="setting-label">模型名称</label>
                <input v-model="openaiModel" class="setting-input"
                  placeholder="gpt-4o" />
              </div>
            </div>
          </Transition>

          <p v-if="error" class="setting-error">{{ error }}</p>

          <!-- Agent 状态 -->
          <div class="agent-status">
            <div class="agent-status-header">
              <span class="agent-status-dot" :class="{ online: agentReady }" />
              <span class="agent-status-label">Agent 引擎</span>
              <span v-if="agentReady" class="agent-status-text">Python LangChain 就绪</span>
              <span v-else-if="agentChecking" class="agent-status-text">检查中...</span>
              <span v-else class="agent-status-text offline">待首次对话自动启动</span>
            </div>
            <div v-if="agentReady" class="agent-stats">
              <span class="agent-stat">🧠 记忆: {{ memoryCount }} 条</span>
              <span class="agent-stat">📄 文档: {{ indexedCount }} 个</span>
            </div>
            <div v-if="agentReady" class="agent-actions">
              <button class="agent-action-btn" @click="clearMemory">清空记忆</button>
            </div>
          </div>

          <div class="setting-actions">
            <button class="setting-btn primary" :disabled="!apiKey || saving" @click="save">
              {{ saving ? '连接中...' : '保存并连接' }}
            </button>
            <button class="setting-btn secondary" @click="testConn">测试连接</button>
          </div>
        </div>

        <!-- 助手 -->
        <div v-if="activeCat === 'pet'" class="cat-content">
          <h3 class="cat-title">回复风格</h3>
          <p class="cat-desc">选择 Agent 的语气和性格</p>

          <div class="personality-grid">
            <button v-for="p in personalities" :key="p.id"
              class="personality-card" :class="{ active: agentPersonality === p.id }"
              @click="agentPersonality = p.id">
              <span class="personality-icon">{{ p.icon }}</span>
              <div class="personality-text">
                <span class="personality-name">{{ p.name }}</span>
                <span class="personality-desc">{{ p.desc }}</span>
              </div>
              <span v-if="agentPersonality === p.id" class="personality-check">✓</span>
            </button>
          </div>

          <!-- 自定义性格 -->
          <div v-if="customPersonalities.length > 0" class="personality-grid" style="margin-top:8px">
            <button v-for="(p, i) in customPersonalities" :key="'custom-'+i"
              class="personality-card" :class="{ active: agentPersonality === 'custom-'+i }"
              @click="agentPersonality = 'custom-'+i">
              <span class="personality-icon">✎</span>
              <div class="personality-text">
                <span class="personality-name">{{ p.name }}</span>
                <span class="personality-desc">{{ p.prompt.slice(0, 40) }}...</span>
              </div>
              <button class="personality-del" @click.stop="removeCustom(i)" title="删除">✕</button>
            </button>
          </div>

          <button class="personality-add-btn" v-if="customPersonalities.length < 3"
            @click="showCustomForm = !showCustomForm">
            + 添加自定义性格 ({{ customPersonalities.length }}/3)
          </button>

          <div v-if="showCustomForm" class="custom-form">
            <input v-model="customName" class="setting-input" placeholder="性格名称 (如：霸道总裁)" style="margin-bottom:6px" />
            <textarea v-model="customPrompt" class="setting-textarea"
              placeholder="提示词 (如：你是 Sonder，一位..."
              rows="4"></textarea>
            <div class="custom-form-hint">
              <b>怎么写：</b><br/>
              1. 你是谁 → "你是 Sonder，一位[身份/角色]"<br/>
              2. 语气特征 → "你说话[温柔/严厉/幽默/高冷/...]"<br/>
              3. 行为规则 → "常用[口头禅]"、"从不[某事]"、"总是先[做什么]"<br/>
              4. 加分项 → 给一个对话示例让 AI 模仿<br/><br/>
              <b>参考示例：</b><br/>
              "你是 Sonder，一位温柔的大姐姐。你说话耐心体贴，总是先安慰再给建议。常用'没事的'、'慢慢来'。用户犯错时从不说教，而是说'我们可以一起想办法'。比如用户说'我今天好累'，你回'辛苦啦~要不要先休息五分钟？我在这儿陪你。'"<br/><br/>
              <b>简洁版示例：</b><br/>
              "你是 Sonder，一位毒舌损友。表面笑嘻嘻，句句扎心。常用'哦？是吗？'、'不意外'。最后总加一句'开玩笑的啦'。"
            </div>
            <div class="custom-form-actions">
              <button class="setting-btn primary" @click="addCustom" :disabled="!customName.trim() || !customPrompt.trim()">保存</button>
              <button class="setting-btn secondary" @click="showCustomForm = false">取消</button>
            </div>
          </div>

          <h3 class="cat-title" style="margin-top:20px">桌宠</h3>
          <p class="cat-desc">桌面上的宠物伙伴</p>

          <div class="setting-group">
            <label class="setting-label">默认宠物</label>
            <div class="pet-choices">
              <button v-for="p in petOptions" :key="p.id"
                class="pet-choice-btn" :class="{ active: defaultPet === p.id }"
                @click="defaultPet = p.id">
                <span class="pet-choice-icon">{{ p.icon }}</span>
                <span class="pet-choice-name">{{ p.name }}</span>
              </button>
            </div>
          </div>

          <div class="setting-group" style="margin-top:12px">
            <label class="setting-label">群聊角色</label>
            <div class="role-stats">
              <span class="role-stat">👥 {{ expertCount }} 个角色可用</span>
              <span class="role-stat">🌐 {{ activeExpertCount }} 个在群聊中</span>
            </div>
            <p class="setting-hint">在侧边菜单「角色」中管理群聊成员</p>
          </div>

          <div class="setting-group">
            <label class="setting-row">
              <span class="setting-label">允许桌面行走</span>
              <input v-model="walkEnabled" type="checkbox" class="setting-toggle" />
            </label>
            <p class="setting-hint">宠物自动在桌面上随机漫步</p>
          </div>

          <div class="setting-group">
            <label class="setting-row">
              <span class="setting-label">拖放喂食</span>
              <input v-model="feedEnabled" type="checkbox" class="setting-toggle" />
            </label>
            <p class="setting-hint">拖文件到宠物可喂食并发送到对话</p>
          </div>
        </div>

        <!-- 系统 -->
        <div v-if="activeCat === 'system'" class="cat-content">
          <h3 class="cat-title">系统</h3>

          <div class="setting-group">
            <label class="setting-row">
              <span class="setting-label">开机自启</span>
              <input v-model="autoLaunch" type="checkbox" class="setting-toggle" />
            </label>
          </div>

          <div class="setting-group">
            <label class="setting-row">
              <span class="setting-label">显示托盘图标</span>
              <input v-model="showTray" type="checkbox" class="setting-toggle" />
            </label>
          </div>

          <div class="setting-group">
            <label class="setting-label">聊天字号</label>
            <div class="segmented-row">
              <button v-for="s in fontSizes" :key="s.value"
                class="seg-btn" :class="{ active: chatFontSize === s.value }"
                @click="chatFontSize = s.value">{{ s.label }}</button>
            </div>
          </div>

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
        <div v-if="activeCat === 'about'" class="cat-content">
          <h3 class="cat-title">关于</h3>

          <div class="about-icon">🐶</div>
          <div class="about-app-name">AI 桌面宠物</div>
          <div class="about-version">v1.0.0</div>
          <p class="about-desc">
            一个可爱的桌面宠物应用。支持多家服务商、拖放文件喂食、自动桌面漫步。
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
import { ref, watch } from 'vue'

const emit = defineEmits(['done'])

// 分类
const categories = [
  { id: 'profile', icon: '👤', label: '用户',   color: '#5C4A32' },
  { id: 'backend', icon: '⚡', label: '服务商', color: '#007aff' },
  { id: 'pet',     icon: '🤖', label: '助手',   color: '#ff6b8a' },
  { id: 'system',  icon: '⚙', label: '系统',   color: '#8e8e93' },
  { id: 'about',   icon: 'ℹ', label: '关于',   color: '#8e8e93' },
]
const activeCat = ref('backend')

function onSidebarClick(e) {
  e.stopPropagation()
  const btn = e.target.closest('[data-cat]')
  if (btn) {
    activeCat.value = btn.dataset.cat
  }
}

// 预加载配置文件（主进程文件）
const apiKey = ref('')
const provider = ref('claude')

// 异步加载已保存配置
;(async () => {
  const cfg = await window.electronAPI?.loadConfig()
  if (cfg) {
    apiKey.value = cfg.apiKey || ''
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
const avatarOptions = ['🐱','🐶','🐼','🐨','🦊','🐰','🐸','🐵','🐙','🦄','🐳','🐲','🌟','💎','🎨','🎮']
const userAvatar = ref(localStorage.getItem('user-avatar') || '🐱')
const avatarColor = ref(localStorage.getItem('user-avatar-color') || '#B7A48E')
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
    avatarColor.value = '#B7A48E'
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

// Agent 性格
const personalities = [
  { id: 'default', icon: '✦', name: '默认', desc: '自然友好，该活泼时活泼，该正经时正经' },
  { id: 'gentle', icon: '♡', name: '温柔可靠', desc: '温和包容，永远不批评，会主动关心你的感受' },
  { id: 'lively', icon: '✿', name: '活泼小精灵', desc: '元气满满，爱用颜文字和语气词，蹦蹦跳跳' },
  { id: 'grumpy', icon: '⚡', name: '火爆急性子', desc: '脾气炸裂但心地不坏，边骂边帮你解决问题' },
  { id: 'cold', icon: '◇', name: '高冷话少', desc: '惜字如金，能说一个字绝不说两个' },
  { id: 'pro', icon: '◆', name: '专业效率', desc: '只说有用的，拒绝废话和寒暄，直接给方案' },
  { id: 'sarcastic', icon: '✧', name: '腹黑毒舌', desc: '表面笑眯眯，话里藏尖刺，优雅地阴阳怪气' },
]
const agentPersonality = ref(localStorage.getItem('agent-personality') || 'default')
watch(agentPersonality, v => localStorage.setItem('agent-personality', v))

// 自定义性格
const customPersonalities = ref(JSON.parse(localStorage.getItem('custom-personalities') || '[]'))
const showCustomForm = ref(false)
const customName = ref('')
const customPrompt = ref('')

function addCustom() {
  if (!customName.value.trim() || !customPrompt.value.trim()) return
  customPersonalities.value.push({
    name: customName.value.trim(),
    prompt: customPrompt.value.trim(),
  })
  localStorage.setItem('custom-personalities', JSON.stringify(customPersonalities.value))
  customName.value = ''
  customPrompt.value = ''
  showCustomForm.value = false
  // 自动选中新加的
  const idx = customPersonalities.value.length - 1
  agentPersonality.value = 'custom-' + idx
}

function removeCustom(idx) {
  customPersonalities.value.splice(idx, 1)
  localStorage.setItem('custom-personalities', JSON.stringify(customPersonalities.value))
  if (agentPersonality.value === 'custom-' + idx) {
    agentPersonality.value = 'default'
  }
}

// 宠物设置
const petOptions = [
  { id: 'glassesDog', icon: '🐶', name: '镜框小狗' },
  { id: 'clawd', icon: '🦞', name: 'Clawd' },
  { id: 'blackCat', icon: '🐱', name: '小黑猫' },
  { id: 'yellowBird', icon: '🐤', name: '小黄鸟' },
  { id: 'fox', icon: '🦊', name: '小狐狸' },
]
const defaultPet = ref(localStorage.getItem('pet-default') || 'glassesDog')
const walkEnabled = ref(localStorage.getItem('pet-walk') !== 'false')
const feedEnabled = ref(localStorage.getItem('pet-feed') !== 'false')

// 系统设置
const autoLaunch = ref(localStorage.getItem('auto-launch') === 'true')
const showTray = ref(localStorage.getItem('show-tray') !== 'false')
const chatFontSize = ref(localStorage.getItem('chat-font-size') || 'standard')
const fontSizes = [
  { label: '小', value: 'small' },
  { label: '标准', value: 'standard' },
  { label: '大', value: 'large' },
]

const appTheme = ref(localStorage.getItem('app-theme') || 'system')
const themes = [
  { label: '浅色', value: 'light', icon: '☀️' },
  { label: '深色', value: 'dark', icon: '🌙' },
  { label: '跟随系统', value: 'system', icon: '🖥️' },
]

// 持久化
watch(defaultPet, v => localStorage.setItem('pet-default', v))
watch(walkEnabled, v => localStorage.setItem('pet-walk', String(v)))
watch(feedEnabled, v => localStorage.setItem('pet-feed', String(v)))
watch(chatFontSize, v => localStorage.setItem('chat-font-size', v))
watch(autoLaunch, v => localStorage.setItem('auto-launch', String(v)))
watch(showTray, v => localStorage.setItem('show-tray', String(v)))
watch(appTheme, v => {
  localStorage.setItem('app-theme', v)
  applyTheme(v)
})

function applyTheme(theme) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark)
  document.documentElement.classList.toggle('dark', isDark)
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
    const { llmService } = await import('../lib/llm/LLMProvider')
    const { useLLMStore } = await import('../store/llmStore')

    let model = claudeModel.value
    if (provider.value === 'deepseek') model = deepseekModel.value
    else if (provider.value === 'openai') model = openaiModel.value

    const config = {
      provider: provider.value,
      apiKey: apiKey.value,
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

async function testConn() {
  error.value = null; saving.value = true
  try {
    let model = claudeModel.value
    if (provider.value === 'deepseek') model = deepseekModel.value
    else if (provider.value === 'openai') model = openaiModel.value

    const result = await window.electronAPI?.llmInit?.({
      provider: provider.value,
      apiKey: apiKey.value,
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
</script>

<style scoped>
/* 彩铅小栈 — Settings Panel */

.settings-backdrop {
  position: absolute; inset: 0; z-index: 999;
  background: rgba(77, 62, 48, 0.06);
  display: flex; align-items: stretch; justify-content: flex-end;
  -webkit-app-region: no-drag;
  overflow: hidden;
}

.settings-panel {
  width: 520px; max-width: 100%; height: 100%; box-sizing: border-box;
  background:
    radial-gradient(circle at 25% 40%, rgba(200, 180, 150, 0.03) 1.5px, transparent 1.5px);
  background-size: 24px 24px;
  background-color: #FEFAF5;
  border-left: 1px solid #E2D9CF;
  box-shadow: -2px 0 24px rgba(0, 0, 0, 0.04);
  border-radius: 16px 0 0 16px; overflow: hidden;
  display: flex;
}

@keyframes slideIn {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}

.settings-sidebar {
  width: 130px; flex-shrink: 0; overflow: hidden;
  padding: 8px 8px 16px;
  display: flex; flex-direction: column; gap: 2px;
  background: rgba(183, 164, 142, 0.05);
  border-right: 1px solid rgba(183, 164, 142, 0.12);
  -webkit-app-region: no-drag;
}
.settings-cat-btn {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 10px 12px; border-radius: 12px;
  background: transparent; cursor: pointer;
  font-size: 13px; font-family: inherit; color: #BAAE9E;
  transition: all 0.12s; text-align: left;
  box-sizing: border-box;
  -webkit-app-region: no-drag;
}

.settings-cat-btn:hover { background: #F7F1E8; color: #7F6E5D; }

.settings-cat-btn.active {
  background: #F7F1E8;
  color: #4D3E30;
  font-weight: 600;
}

.cat-icon { font-size: 16px; width: 22px; text-align: center; flex-shrink: 0; pointer-events: none; }
.cat-label { white-space: nowrap; pointer-events: none; }

.settings-divider {
  width: 1px; flex-shrink: 0;
  background: rgba(183, 164, 142, 0.15);
  transition: opacity 0.25s;
}

.settings-detail {
  flex: 1; overflow-y: auto; overflow-x: hidden; padding: 32px 28px;
  min-width: 0;
}

.cat-content { display: flex; flex-direction: column; gap: 20px; }

.cat-title {
  font-size: 22px; font-weight: 500; color: #4D3E30;
  margin: 0 0 4px 0;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
}

.setting-group { display: flex; flex-direction: column; gap: 6px; }

.setting-label { font-size: 12.5px; font-weight: 600; color: #4D3E30; }

.setting-hint { font-size: 11px; color: #B6A792; margin: 0; }

/* Form inputs */
.setting-input, .setting-select {
  padding: 8px 12px; border-radius: 12px;
  border: 1.8px solid #CBB28B;
  font-size: 13px; font-family: inherit;
  background: #FFFBF5;
  color: #4D3E30;
  outline: none; transition: border-color 0.15s, box-shadow 0.15s;
}

.setting-input:focus, .setting-select:focus {
  border-color: #9DC0AF;
  box-shadow: 0 0 0 3px rgba(157, 192, 175, 0.2);
}

.setting-error { font-size: 12px; color: #c48070; margin: 0; }

.setting-actions { display: flex; gap: 8px; margin-top: 4px; }

.setting-btn {
  padding: 8px 20px; border-radius: 40px; border: none;
  font-size: 16px; font-family: 'Inter', system-ui, -apple-system, sans-serif; font-weight: 500;
  cursor: pointer; transition: all 0.12s;
}

.setting-btn:hover { transform: translateY(-1px); }
.setting-btn:active { transform: scale(0.96); }
.setting-btn:disabled { opacity: 0.4; cursor: default; transform: none; }

.setting-btn.primary {
  background: linear-gradient(145deg, #F7EFE4, #F1E7DC);
  color: #6A5A4A;
  border: 1.8px solid #B7A48E;
}

.setting-btn.primary:hover {
  background: linear-gradient(145deg, #F0E2D2, #E8D8C4);
}

.setting-btn.secondary {
  background: #FEFAF5;
  color: #7F6E5D;
  border: 1px solid rgba(183, 164, 142, 0.25);
}

.setting-btn.secondary:hover { background: #F7F1E8; }

/* Provider cards */
.provider-cards {
  display: flex; flex-direction: column; gap: 6px;
}

.provider-card {
  display: flex; align-items: center; gap: 10px;
  width: 100%; padding: 10px 14px; border-radius: 16px;
  border: 1.8px solid rgba(183, 164, 142, 0.2);
  background: #FEFAF5;
  cursor: pointer; font-family: inherit;
  transition: all 0.15s;
  text-align: left;
}
.provider-card:hover {
  background: #F7F1E8;
  border-color: rgba(183, 164, 142, 0.35);
  transform: translateX(2px);
}
.provider-card.active {
  border-color: #9BB7AA;
  background: #F0F7F4;
}
.provider-card-icon {
  width: 40px; height: 40px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  font-size: 22px; flex-shrink: 0;
}
.provider-card-text { display: flex; flex-direction: column; gap: 1px; flex: 1; }
.provider-card-name { font-size: 13px; font-weight: 600; color: #4D3E30; }
.provider-card-desc { font-size: 11px; color: #B6A792; }
.provider-card-check { color: #9DC0AF; font-size: 16px; font-weight: 600; }

/* Model chips */
.model-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.model-chip {
  padding: 6px 16px; border-radius: 20px;
  border: 1.5px solid rgba(183, 164, 142, 0.25);
  background: #FEFAF5; cursor: pointer;
  font-size: 12.5px; font-family: inherit; color: #7F6E5D;
  transition: all 0.12s;
}
.model-chip:hover { background: #F7F1E8; border-color: rgba(183, 164, 142, 0.4); }
.model-chip.active {
  background: #E6F0EC; border-color: #9BB7AA;
  color: #4D3E30; font-weight: 600;
}

/* Config slide animation */
.config-slide-enter-active { transition: all 0.2s cubic-bezier(0.22, 0.61, 0.36, 1); }
.config-slide-leave-active { transition: all 0.12s ease; }
.config-slide-enter-from { opacity: 0; transform: translateY(-8px); }
.config-slide-leave-to   { opacity: 0; transform: translateY(-4px); }

.provider-config {
  display: flex; flex-direction: column; gap: 16px;
  padding: 12px 14px;
  background: rgba(247, 241, 232, 0.3);
  border-radius: 16px;
  border: 1.5px dashed rgba(183, 164, 142, 0.25);
}

/* Pet choices */
/* 回复风格 */
.personality-grid { display: flex; flex-direction: column; gap: 4px; }

.personality-card {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border: 1.2px solid #E8DFD2; border-radius: 8px;
  background: #FEFAF5; cursor: pointer; font-family: inherit;
  transition: all 0.15s; text-align: left;
}
.personality-card:hover { border-color: #D4C8BA; background: #FBF8F3; transform: translateX(2px); }
.personality-card.active { border-color: #B7A48E; background: #F7F1E8; }

.personality-icon {
  font-size: 18px; flex-shrink: 0; width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 6px; background: rgba(183,164,142,0.08);
  color: #B7A48E;
}

.personality-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }

.personality-name { font-size: 12.5px; font-weight: 600; color: #5C4A32; }

.personality-desc { font-size: 10.5px; color: #A89880; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.personality-check { color: #9DC0AF; font-size: 13px; flex-shrink: 0; }

.personality-del {
  width: 20px; height: 20px; border-radius: 50%; border: none;
  background: #F5EDE4; color: #B8A38C; font-size: 10px; flex-shrink: 0;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: all 0.12s;
}
.personality-del:hover { background: #E8D5C0; color: #8B6F50; }

.personality-add-btn {
  padding: 5px 12px; border: 1px dashed #D4C8BA; border-radius: 16px;
  background: none; color: #A89880; font-size: 11.5px; font-family: inherit;
  cursor: pointer; margin-top: 6px; transition: all 0.15s;
}
.personality-add-btn:hover { border-color: #B8A38C; color: #5C4A32; background: rgba(183,164,142,0.04); }

.custom-form {
  margin-top: 8px; padding: 10px;
  background: #FBF8F3; border: 1px solid #E8DFD2; border-radius: 10px;
}

.setting-textarea {
  width: 100%; padding: 6px 10px; border: 1px solid #E2D9CF; border-radius: 6px;
  font-size: 12px; font-family: inherit; color: #5C4A32; resize: vertical;
  background: #FEFAF5; outline: none; box-sizing: border-box;
}
.setting-textarea:focus { border-color: #C4B5A0; }

.custom-form-hint {
  font-size: 11px; color: #7F6E5D; line-height: 1.6;
  margin: 8px 0; padding: 10px 12px;
  background: #F7F1E8; border-radius: 8px;
}
.custom-form-hint b { color: #5C4A32; }

.custom-form-actions { display: flex; gap: 6px; }

/* 宠物 */
.pet-choices { display: flex; gap: 8px; flex-wrap: wrap; }

.pet-choice-btn {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 12px 16px; border-radius: 20px;
  border: 1.8px solid rgba(183, 164, 142, 0.25);
  background: #FEFAF5;
  cursor: pointer; font-family: inherit;
  transition: all 0.12s;
}

.pet-choice-btn:hover {
  background: #F7F1E8;
  transform: translateY(-1px);
}

.pet-choice-btn.active {
  border-color: #9BB7AA;
  background: #E6F0EC;
}

.pet-choice-icon { font-size: 28px; }
.pet-choice-name { font-size: 11px; color: #7F6E5D; font-family: 'Inter', system-ui, -apple-system, sans-serif; }

/* Toggle switch */
.setting-row { display: flex; align-items: center; justify-content: space-between; }

.setting-toggle {
  width: 42px; height: 24px;
  -webkit-appearance: none; appearance: none;
  background: rgba(183, 164, 142, 0.25);
  border-radius: 12px;
  position: relative; cursor: pointer; transition: background 0.2s;
  flex-shrink: 0;
}

.setting-toggle::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 20px; height: 20px; border-radius: 50%;
  background: #FFFBF5;
  border: 1px solid rgba(183, 164, 142, 0.3);
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.setting-toggle:checked { background: #9DC0AF; }
.setting-toggle:checked::after { transform: translateX(18px); }

/* Segmented control */
.segmented-row { display: flex; gap: 0; }

.segmented-row .seg-btn {
  padding: 6px 14px; border: 1.8px solid rgba(183, 164, 142, 0.25);
  background: #FEFAF5; cursor: pointer;
  font-size: 12px; font-family: inherit; color: #7F6E5D;
  transition: all 0.12s;
}
.segmented-row .seg-btn:first-child { border-radius: 20px 0 0 20px; }
.segmented-row .seg-btn:last-child { border-radius: 0 20px 20px 0; }
.segmented-row .seg-btn+.seg-btn { border-left: none; }
.segmented-row .seg-btn:hover { background: #F7F1E8; }
.segmented-row .seg-btn.active {
  background: #E6F0EC; color: #4D3E30; border-color: #9BB7AA; font-weight: 600;
}

/* 外观主题 */
.theme-choices { display: flex; gap: 6px; }

.theme-card {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 10px 8px; border-radius: 10px; cursor: pointer;
  border: 1.2px solid #E8DFD2; background: #FEFAF5;
  font-family: inherit; font-size: 12px; color: #A89880;
  transition: all 0.15s;
}
.theme-card:hover { border-color: #D4C8BA; background: #FBF8F3; }
.theme-card.active { border-color: #B7A48E; background: #F7F1E8; color: #5C4A32; }
.theme-icon { font-size: 20px; }
.theme-name { font-size: 11px; }

/* About page */
.about-icon { font-size: 48px; text-align: center; margin-top: 16px; }

.about-app-name {
  font-size: 22px; font-weight: 500; text-align: center;
  margin-top: 8px; color: #4D3E30;
  font-family: 'Inter', system-ui, -apple-system, sans-serif; letter-spacing: 1px;
}

.about-version {
  font-size: 13px; color: #B6A792; text-align: center;
  margin-bottom: 8px; font-family: 'Inter', system-ui, -apple-system, sans-serif;
}

.about-desc {
  font-size: 12.5px; color: #7F6E5D; text-align: center; line-height: 1.6;
}

.about-section {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-radius: 20px;
  background: #F7F1E8;
}

.about-label {
  font-size: 12px; font-weight: 600; color: #7F6E5D; flex-shrink: 0;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
}

.about-link { font-size: 12px; color: #7F6E5D; text-decoration: none; }
.about-link:hover { color: #4D3E30; }

.about-stack { font-size: 12px; color: #4D3E30; }

.about-path {
  font-size: 11px; background: rgba(183, 164, 142, 0.1);
  padding: 2px 8px; border-radius: 8px;
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  overflow: hidden; text-overflow: ellipsis; color: #4D3E30;
}

/* Agent 状态 */
.agent-status {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px 14px;
  background: rgba(247, 241, 232, 0.4);
  border-radius: 14px;
  border: 1.2px solid rgba(183, 164, 142, 0.15);
}

.agent-status-header {
  display: flex; align-items: center; gap: 8px;
}

.agent-status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #C4B5A0; flex-shrink: 0;
}
.agent-status-dot.online { background: #9DC0AF; box-shadow: 0 0 6px rgba(157, 192, 175, 0.5); }

.agent-status-label {
  font-size: 13px; font-weight: 600; color: #4D3E30;
}

.agent-status-text {
  font-size: 11px; color: #9B8870; margin-left: auto;
}
.agent-status-text.offline { color: #C4B5A0; }

/* 用户画像 */
.cat-desc { font-size: 12px; color: #A89880; margin: 0 0 12px; }

.profile-card {
  background: #FBF8F3; border: 1px solid #E8DFD2; border-radius: 10px;
  padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
}

.profile-item { display: flex; gap: 8px; align-items: baseline; }

.profile-key {
  font-size: 11px; color: #A89880; min-width: 48px; flex-shrink: 0;
}

.profile-value { font-size: 13px; color: #5C4A32; font-weight: 500; }

.profile-empty { font-size: 13px; color: #B8A38C; }

/* 头像 */
.avatar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }

.avatar-current {
  width: 48px; height: 48px; border-radius: 50%; font-size: 26px;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid #E2D9CF; flex-shrink: 0; overflow: hidden;
}

.avatar-current .avatar-img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }

.avatar-actions { display: flex; flex-direction: column; gap: 4px; }

.avatar-hint { font-size: 11px; color: #A89880; }

.avatar-upload-btn {
  padding: 3px 10px; border: 1px solid #D4C8BA; border-radius: 12px;
  background: #FEFAF5; color: #8B7A65; font-size: 11px;
  font-family: inherit; cursor: pointer; align-self: flex-start;
}
.avatar-upload-btn:hover { border-color: #B8A38C; }

.avatar-grid { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }

.avatar-option {
  width: 34px; height: 34px; border-radius: 50%; border: 2px solid transparent;
  background: #FBF8F3; font-size: 18px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.12s;
}

.avatar-option:hover { background: #F0E8DA; }
.avatar-option.active { border-color: #B7A48E; background: #EDE4D5; }

/* 称呼 */
.nickname-hint { font-size: 11px; color: #9DC0AF; margin-top: 4px; display: block; }
.nickname-hint.error { color: #c48070; }

.memory-stats { display: flex; align-items: center; justify-content: space-between; }

.mem-stat { font-size: 13px; color: #5C4A32; }

.mem-clear-btn {
  padding: 4px 12px; border: 1px solid #E2D9CF; border-radius: 14px;
  background: #FEFAF5; color: #B8A38C; font-size: 11px;
  font-family: inherit; cursor: pointer;
}

.mem-clear-btn:hover { border-color: #c48070; color: #c48070; }
.mem-clear-btn:disabled { opacity: 0.4; cursor: default; }

.role-stats { display: flex; gap: 16px; align-items: center; }
.role-stat { font-size: 12.5px; color: #5C4A32; }

.agent-stats {
  display: flex; gap: 16px; font-size: 11.5px; color: #7F6E5D;
}

.agent-stat { font-family: 'Inter', system-ui, -apple-system, sans-serif; font-size: 14px; }

.agent-actions {
  display: flex; gap: 6px;
}

.agent-action-btn {
  padding: 4px 14px; border-radius: 14px;
  border: 1px solid rgba(183, 164, 142, 0.3);
  background: #FEFAF5; cursor: pointer;
  font-size: 12px; font-family: 'Inter', system-ui, -apple-system, sans-serif;
  color: #7F6E5D; transition: all 0.12s;
}
.agent-action-btn:hover {
  background: rgba(180, 120, 110, 0.06); color: #c48070;
  border-color: rgba(180, 120, 110, 0.3);
}

/* ═══════════════════════════════════════
   夜空静谧 · 深色模式
   ═══════════════════════════════════════ */

/* ── 通用：input / select / textarea ── */
html.dark .setting-input,
html.dark .setting-select,
html.dark .setting-textarea {
  background: #222736;
  border-color: #3d4560;
  color: #c8d0e0;
}
html.dark .setting-input:focus,
html.dark .setting-select:focus,
html.dark .setting-textarea:focus {
  border-color: #5a8090;
  box-shadow: 0 0 0 3px rgba(90, 130, 160, 0.15);
}
html.dark .setting-error { color: #c09090; }

/* ── 服务商卡片 ── */
html.dark .provider-card {
  background: #222736;
  border-color: rgba(120, 140, 180, 0.15);
}
html.dark .provider-card:hover {
  background: #262c3d;
  border-color: rgba(120, 140, 180, 0.3);
}
html.dark .provider-card.active {
  background: #1e2e3a;
  border-color: #5a8090;
}
html.dark .provider-card-name { color: #c8d0e0; }
html.dark .provider-card-desc { color: #7a8a9e; }
html.dark .provider-card-check { color: #6a9a8a; }

/* ── 模型芯片 ── */
html.dark .model-chip {
  background: #222736;
  border-color: rgba(120, 140, 180, 0.15);
  color: #7a8a9e;
}
html.dark .model-chip:hover {
  background: #262c3d;
  border-color: rgba(120, 140, 180, 0.3);
}
html.dark .model-chip.active {
  background: #1e2e3a;
  border-color: #5a8090;
  color: #c8d0e0;
}

/* ── 服务商配置区块 ── */
html.dark .provider-config {
  background: rgba(40, 50, 70, 0.25);
  border-color: rgba(120, 140, 180, 0.12);
}
html.dark .provider-config .setting-label { color: #a0b0c8; }

/* ── Agent 状态 ── */
html.dark .agent-status {
  background: rgba(40, 50, 70, 0.2);
  border-color: rgba(120, 140, 180, 0.1);
}
html.dark .agent-status-dot { background: #5a6880; }
html.dark .agent-status-dot.online {
  background: #6a9a8a;
  box-shadow: 0 0 6px rgba(106, 154, 138, 0.4);
}
html.dark .agent-status-label { color: #c8d0e0; }
html.dark .agent-status-text { color: #8a9ab8; }
html.dark .agent-status-text.offline { color: #5a6880; }
html.dark .agent-stat { color: #a0b0c8; }
html.dark .agent-action-btn {
  background: #222736;
  border-color: rgba(120, 140, 180, 0.2);
  color: #a0b0c8;
}
html.dark .agent-action-btn:hover {
  background: rgba(180, 120, 130, 0.08);
  color: #c09090;
  border-color: rgba(180, 120, 130, 0.25);
}

/* ── 用户：头像 ── */
html.dark .avatar-current { border-color: #3d4560; }
html.dark .avatar-hint { color: #7a8a9e; }
html.dark .avatar-upload-btn {
  background: #222736;
  border-color: #3d4560;
  color: #8a9ab8;
}
html.dark .avatar-upload-btn:hover { border-color: #5a6880; }
html.dark .avatar-option {
  background: #222736;
}
html.dark .avatar-option:hover {
  background: #2a3040;
}
html.dark .avatar-option.active {
  border-color: #5a8090;
  background: #283040;
}

/* ── 用户：称呼 / 画像 / 记忆 ── */
html.dark .nickname-hint { color: #6a9a8a; }
html.dark .nickname-hint.error { color: #c09090; }
html.dark .profile-empty { color: #6a7a90; }
html.dark .mem-stat { color: #c8d0e0; }
html.dark .mem-clear-btn {
  background: #222736;
  border-color: #3d4560;
  color: #7a8a9e;
}
html.dark .mem-clear-btn:hover {
  border-color: #c09090;
  color: #c09090;
}
html.dark .role-stat { color: #a0b0c8; }

/* ── 关于页面 ── */
html.dark .about-section {
  background: #222736;
}
html.dark .about-label { color: #8a9ab8; }
html.dark .about-link { color: #8a9ab8; }
html.dark .about-link:hover { color: #c8d0e0; }
html.dark .about-stack { color: #c8d0e0; }
html.dark .about-path {
  background: rgba(120, 140, 180, 0.08);
  color: #c8d0e0;
}

/* ── 设置按钮补充 ── */
html.dark .setting-btn.primary {
  background: linear-gradient(145deg, #2a3548, #222b3a);
  color: #b0c0d8;
  border-color: #4a6080;
}
html.dark .setting-btn.primary:hover {
  background: linear-gradient(145deg, #303d52, #283242);
}
html.dark .setting-btn.secondary {
  background: #222736;
  color: #a0b0c8;
  border-color: rgba(120, 140, 180, 0.15);
}
html.dark .setting-btn.secondary:hover { background: #262c3d; }
html.dark .setting-btn:disabled { opacity: 0.3; }

/* ── 分段控件 ── */
html.dark .seg-btn {
  background: #222736;
  border-color: rgba(120, 140, 180, 0.15);
  color: #7a8a9e;
}
html.dark .seg-btn:hover { background: #262c3d; }
html.dark .seg-btn.active {
  background: #1e2e3a;
  color: #a0c0c8;
  border-color: #5a8090;
}
</style>

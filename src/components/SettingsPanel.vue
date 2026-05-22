<template>
  <div class="settings-backdrop" @click="emit('done')">
    <div class="settings-panel" @click.stop>
      <!-- 左侧分类 -->
      <div class="settings-sidebar">
        <button v-for="cat in categories" :key="cat.id"
          class="settings-cat-btn" :class="{ active: activeCat === cat.id }"
          @click="activeCat = cat.id">
          <span class="cat-icon" :style="{ color: cat.color }">{{ cat.icon }}</span>
          <span class="cat-label">{{ cat.label }}</span>
        </button>
      </div>

      <div class="settings-divider" />

      <!-- 右侧详情 -->
      <div class="settings-detail">
        <!-- AI 模型 -->
        <div v-if="activeCat === 'backend'" class="cat-content">
          <h3 class="cat-title">AI 模型</h3>

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
              <span v-else class="agent-status-text offline">未启动 (将降级到普通模式)</span>
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

        <!-- 宠物 -->
        <div v-if="activeCat === 'pet'" class="cat-content">
          <h3 class="cat-title">宠物</h3>

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
        </div>

        <!-- 关于 -->
        <div v-if="activeCat === 'about'" class="cat-content">
          <h3 class="cat-title">关于</h3>

          <div class="about-icon">🐶</div>
          <div class="about-app-name">AI 桌面宠物</div>
          <div class="about-version">v1.0.0</div>
          <p class="about-desc">
            一个可爱的桌面宠物应用。支持多个 AI 模型对话、拖放文件喂食、自动桌面漫步。
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
  { id: 'backend', icon: '⚡', label: 'AI 模型', color: '#007aff' },
  { id: 'pet',     icon: '🐾', label: '宠物',   color: '#ff6b8a' },
  { id: 'system',  icon: '⚙', label: '系统',   color: '#8e8e93' },
  { id: 'about',   icon: 'ℹ', label: '关于',   color: '#8e8e93' },
]
const activeCat = ref('backend')

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
const saving = ref(false)
const error = ref(null)

// Agent 状态
const agentReady = ref(false)
const agentChecking = ref(true)
const memoryCount = ref(0)
const indexedCount = ref(0)

// 检查 Agent 就绪状态
;(async () => {
  try {
    const result = await window.electronAPI?.agentPing()
    agentReady.value = result?.ready || false
    memoryCount.value = result?.memory_count || result?.memoryCount || 0
    indexedCount.value = result?.indexed_files || result?.indexedFiles || 0
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
  { value: 'deepseek-chat',       label: 'Chat' },
  { value: 'deepseek-reasoner',   label: 'Reasoner' },
  { value: 'deepseek-v4-pro',     label: 'V4 Pro' },
  { value: 'deepseek-v4-flash',   label: 'V4 Flash' },
]

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
const autoLaunch = ref(false)
const showTray = ref(true)
const chatFontSize = ref(localStorage.getItem('chat-font-size') || 'standard')
const fontSizes = [
  { label: '小', value: 'small' },
  { label: '标准', value: 'standard' },
  { label: '大', value: 'large' },
]

// 持久化
watch(defaultPet, v => localStorage.setItem('pet-default', v))
watch(walkEnabled, v => localStorage.setItem('pet-walk', String(v)))
watch(feedEnabled, v => localStorage.setItem('pet-feed', String(v)))
watch(chatFontSize, v => localStorage.setItem('chat-font-size', v))

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
  position: fixed; inset: 0; z-index: 100;
  background: rgba(77, 62, 48, 0.06);
  display: flex; align-items: stretch; justify-content: flex-end;
}

.settings-panel {
  width: 520px; max-width: 90vw; height: 100%;
  background:
    radial-gradient(circle at 25% 40%, rgba(200, 180, 150, 0.03) 1.5px, transparent 1.5px);
  background-size: 24px 24px;
  background-color: #FEFAF5;
  border-left: 1px solid #E2D9CF;
  box-shadow: -2px 0 24px rgba(0, 0, 0, 0.04);
  display: flex; animation: slideIn 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
}

@keyframes slideIn {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}

.settings-sidebar {
  width: 130px; flex-shrink: 0;
  padding: 32px 8px 16px;
  display: flex; flex-direction: column; gap: 2px;
  background: rgba(183, 164, 142, 0.05);
  border-right: 1px solid rgba(183, 164, 142, 0.12);
}

.settings-cat-btn {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: 12px; border: none;
  background: transparent; cursor: pointer;
  font-size: 13px; font-family: inherit; color: #BAAE9E;
  transition: all 0.12s; text-align: left;
  position: relative; z-index: 1;
  pointer-events: auto;
  user-select: none;
}

.settings-cat-btn:hover { background: #F7F1E8; color: #7F6E5D; }

.settings-cat-btn.active {
  background: #F7F1E8;
  color: #4D3E30;
  font-weight: 600;
}

.cat-icon { font-size: 16px; width: 22px; text-align: center; flex-shrink: 0; }
.cat-label { white-space: nowrap; }

.settings-divider {
  width: 1px; flex-shrink: 0;
  background: rgba(183, 164, 142, 0.15);
}

.settings-detail {
  flex: 1; overflow-y: auto; padding: 32px 28px;
}

.cat-content { display: flex; flex-direction: column; gap: 20px; }

.cat-title {
  font-size: 22px; font-weight: 500; color: #4D3E30;
  margin: 0 0 4px 0;
  font-family: 'Caveat', cursive;
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
  font-size: 16px; font-family: 'Caveat', cursive; font-weight: 500;
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
.pet-choice-name { font-size: 11px; color: #7F6E5D; font-family: 'Caveat', cursive; }

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

/* About page */
.about-icon { font-size: 48px; text-align: center; margin-top: 16px; }

.about-app-name {
  font-size: 22px; font-weight: 500; text-align: center;
  margin-top: 8px; color: #4D3E30;
  font-family: 'Caveat', cursive; letter-spacing: 1px;
}

.about-version {
  font-size: 13px; color: #B6A792; text-align: center;
  margin-bottom: 8px; font-family: 'Caveat', cursive;
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
  font-family: 'Caveat', cursive;
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

.agent-stats {
  display: flex; gap: 16px; font-size: 11.5px; color: #7F6E5D;
}

.agent-stat { font-family: 'Caveat', cursive; font-size: 14px; }

.agent-actions {
  display: flex; gap: 6px;
}

.agent-action-btn {
  padding: 4px 14px; border-radius: 14px;
  border: 1px solid rgba(183, 164, 142, 0.3);
  background: #FEFAF5; cursor: pointer;
  font-size: 12px; font-family: 'Caveat', cursive;
  color: #7F6E5D; transition: all 0.12s;
}
.agent-action-btn:hover {
  background: rgba(180, 120, 110, 0.06); color: #c48070;
  border-color: rgba(180, 120, 110, 0.3);
}
</style>

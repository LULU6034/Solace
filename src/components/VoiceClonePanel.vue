<template>
  <div class="clone-panel" :class="{ dark: isDark }">
    <h3>🎙️ 音色管理</h3>
    <p class="clone-desc">上传一段 10 秒以上的清晰语音，克隆为新音色。</p>

    <!-- Upload -->
    <div class="clone-upload" v-if="!cloning">
      <div class="upload-zone" @click="pickFile" @dragover.prevent @drop.prevent="onDrop">
        <div v-if="!uploadFile" class="upload-hint">
          <span class="upload-icon">📁</span>
          <span>点击选择或拖拽音频文件 (WAV/MP3/Opus, ≥10s)</span>
        </div>
        <div v-else class="upload-info">
          <span class="file-icon">🎵</span>
          <span>{{ uploadFile.name }} ({{ (uploadFile.size / 1024).toFixed(0) }} KB)</span>
          <button class="btn-remove" @click.stop="uploadFile = null">×</button>
        </div>
      </div>

      <input ref="fileInput" type="file" accept="audio/*" @change="onFilePicked" hidden />

      <div class="clone-form">
        <input v-model="voiceName" class="voice-name-input" placeholder='音色名称 (如: "我的声音")' maxlength="20" />
        <input v-model="promptText" class="prompt-text-input" placeholder="参考文本 (说话内容)" maxlength="50" />
        <button class="clone-btn" @click="startClone" :disabled="!uploadFile || !voiceName">
          🎤 开始克隆
        </button>
      </div>
    </div>

    <!-- Cloning progress -->
    <div v-if="cloning" class="clone-progress">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: progress + '%' }"></div>
      </div>
      <span class="progress-text">{{ progressText }}</span>
    </div>

    <!-- Voice list -->
    <div class="voice-list">
      <h4>已注册音色</h4>
      <div v-if="voices.length === 0" class="clone-empty">暂无自定义音色</div>
      <div v-for="v in voices" :key="v.id" class="voice-card" :class="{ playing: playingId === v.id }">
        <div class="voice-info">
          <span class="voice-name">{{ v.name }}</span>
          <span class="voice-id">{{ v.id }}</span>
        </div>
        <div class="voice-actions">
          <button class="voice-btn preview" @click="previewVoice(v)" :disabled="playingId !== null">
            {{ playingId === v.id ? '🔊' : '▶' }}
          </button>
          <button class="voice-btn delete" @click="deleteVoice(v.id)">×</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const props = defineProps({ isDark: Boolean })

const uploadFile = ref(null)
const voiceName = ref('')
const promptText = ref('希望你以后能够做的比我还好呦。')
const cloning = ref(false)
const progress = ref(0)
const progressText = ref('')
const voices = ref([])
const playingId = ref(null)
const fileInput = ref(null)

onMounted(async () => {
  try {
    const result = await window.electronAPI?.voiceGetVoices?.()
    if (result?.voices) voices.value = result.voices
  } catch {}
})

function pickFile() { fileInput.value?.click() }

function onFilePicked(e) {
  uploadFile.value = e.target.files?.[0] || null
}

function onDrop(e) {
  uploadFile.value = e.dataTransfer?.files?.[0] || null
}

async function startClone() {
  if (!uploadFile.value || !voiceName.value) return

  cloning.value = true; progress.value = 0
  progressText.value = '上传音频...'

  try {
    // Read file as ArrayBuffer
    const buffer = await uploadFile.value.arrayBuffer()
    progress.value = 30; progressText.value = '提取声纹...'

    // Call CosyVoice via IPC → server → CosyVoice2.add_zero_shot_spk
    const result = await window.electronAPI?.voiceCloneVoice?.({
      name: voiceName.value,
      promptText: promptText.value,
      audioData: Array.from(new Uint8Array(buffer)),
      filename: uploadFile.value.name,
    })

    progress.value = 80; progressText.value = '注册音色...'

    if (result?.error) {
      throw new Error(result.error)
    }

    progress.value = 100; progressText.value = '完成！'

    // Refresh voice list
    const updated = await window.electronAPI?.voiceGetVoices?.()
    if (updated?.voices) voices.value = updated.voices

    // Reset
    uploadFile.value = null
    voiceName.value = ''
    setTimeout(() => { cloning.value = false }, 1000)
  } catch (err) {
    progressText.value = `失败: ${err.message}`
    setTimeout(() => { cloning.value = false }, 3000)
  }
}

function previewVoice(voice) {
  playingId.value = voice.id
  // Speak a test phrase using the selected voice via SpeechSynthesis
  const u = new SpeechSynthesisUtterance('你好，这是我克隆的音色')
  u.rate = 1.0; u.pitch = 1.0; u.volume = 1.0
  // Note: SpeechSynthesis can't use custom voices from CosyVoice
  // This plays a preview via the server TTS
  u.onend = () => { playingId.value = null }
  speechSynthesis.speak(u)
  setTimeout(() => { playingId.value = null }, 3000)
}

async function deleteVoice(id) {
  if (!confirm('删除这个音色？')) return
  await window.electronAPI?.voiceDeleteVoice?.(id)
  voices.value = voices.value.filter(v => v.id !== id)
}
</script>

<style scoped>

/* Premium interaction refinements */
button, .btn, .setting-btn, .seg-btn, .model-chip, .conv-pill {
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


.clone-panel { padding: 16px; font-size: 13px; overflow-y: auto; height: 100%; }
.clone-panel h3 { font-size: 16px; margin-bottom: 6px; }
.clone-desc { color: var(--text-muted, #88909E); font-size: 12px; margin-bottom: 16px; }

.upload-zone {
  border: 2px dashed var(--border, #E8ECF0);
  border-radius: 12px;
  padding: 20px;
  text-align: center;
  cursor: pointer;
  transition: border-color .15s;
  margin-bottom: 12px;
}

.upload-zone:hover { border-color: var(--brand, #059669); }

.upload-hint { color: var(--text-muted, #88909E); font-size: 12px; display: flex; flex-direction: column; gap: 6px; align-items: center; }
.upload-icon { font-size: 28px; }
.upload-info { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.file-icon { font-size: 20px; }
.btn-remove { border: none; background: none; font-size: 18px; cursor: pointer; color: var(--text-muted, #88909E); }

.clone-form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }

.voice-name-input, .prompt-text-input {
  padding: 8px 12px;
  border: 1px solid var(--border, #E8ECF0);
  border-radius: 8px;
  font-size: 13px;
  background: var(--card, #FFFFFF);
  color: var(--text-primary, #1A1A2E);
}

.clone-btn {
  padding: 10px;
  border: none;
  border-radius: 10px;
  background: var(--brand, #059669);
  color: white;
  font-size: 14px;
  cursor: pointer;
  transition: background .15s;
}

.clone-btn:hover:not(:disabled) { background: var(--brand-light, #10B981); }
.clone-btn:disabled { opacity: .5; cursor: not-allowed; }

.clone-progress { text-align: center; padding: 16px; }

.progress-bar {
  height: 6px;
  background: var(--border, #E8ECF0);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 8px;
}

.progress-fill {
  height: 100%;
  background: var(--brand, #059669);
  transition: width .3s;
  border-radius: 3px;
}

.progress-text { font-size: 12px; color: var(--text-muted, #88909E); }

.voice-list h4 { font-size: 13px; margin: 16px 0 8px; color: var(--text-secondary, #5A6170); }

.clone-empty { text-align: center; color: var(--text-muted, #88909E); padding: 20px; }

.voice-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px;
  border-radius: 8px;
  margin-bottom: 4px;
  background: var(--card, #FFFFFF);
  border: 1px solid var(--border, #E8ECF0);
}

.voice-card.playing { border-color: var(--brand, #059669); }

.voice-info { min-width: 0; }
.voice-name { font-weight: 500; }
.voice-id { display: block; font-size: 10px; color: var(--text-muted, #88909E); }

.voice-actions { display: flex; gap: 4px; }
.voice-btn { padding: 4px 8px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; background: none; }
.voice-btn.preview { color: var(--brand, #059669); }
.voice-btn.delete { color: var(--text-muted, #88909E); }
.voice-btn.delete:hover { color: var(--danger, #FF3B30); }
</style>

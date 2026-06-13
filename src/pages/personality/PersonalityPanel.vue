<template>
  <div class="personality-panel" :class="{ dark: isDark }">
    <h3>🎭 人格参数</h3>
    <p class="personality-desc">调整 Sonder 的说话风格。改动即时生效。</p>

    <div class="dim-slider" v-for="dim in dimensions" :key="dim.key">
      <div class="dim-header">
        <span class="dim-label">{{ dim.label }}</span>
        <span class="dim-val">{{ Math.round(dim.value * 100) }}%</span>
      </div>
      <div class="dim-desc">{{ dim.description }}</div>
      <input type="range" min="0" max="100" :value="Math.round(dim.value * 100)"
        @input="onSlider(dim.key, $event)" class="dim-range"
        :style="{ '--accent': dim.color }" />
      <div class="dim-extremes">
        <span class="dim-low">{{ dim.low }}</span>
        <span class="dim-high">{{ dim.high }}</span>
      </div>
    </div>

    <div class="personality-presets">
      <h4>预设</h4>
      <div class="preset-buttons">
        <button v-for="p in presets" :key="p.id" class="preset-btn"
          @click="applyPreset(p)" :class="{ active: activePreset === p.id }">
          {{ p.icon }} {{ p.name }}
        </button>
      </div>
    </div>

    <div class="personality-footer">
      <button class="btn-reset" @click="resetDefaults">恢复默认</button>
      <span class="save-hint" v-if="saved">已保存 ✓</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const props = defineProps({ isDark: Boolean })

const DIM_DEFS = [
  { key: 'warmth', label: '温暖度', low: '❄️ 冷淡', high: '🔥 热情', color: '#FF6B6B', description: '从保持距离到亲密温暖' },
  { key: 'humor', label: '幽默度', low: '😐 严肃', high: '😄 俏皮', color: '#FFD93D', description: '从不苟言笑到爱开玩笑' },
  { key: 'directness', label: '直接度', low: '🌀 委婉', high: '🎯 直白', color: '#6BCB77', description: '从含蓄铺垫到开门见山' },
  { key: 'curiosity', label: '好奇心', low: '🤐 被动', high: '🔍 追问', color: '#4D96FF', description: '从被动应答到主动了解你' },
  { key: 'empathy', label: '共情力', low: '🧠 理性', high: '💗 感性', color: '#C084FC', description: '从纯粹分析到深度共情' },
];

const presets = [
  { id: 'friend', name: '知心朋友', icon: '💕',
    values: { warmth: 0.8, humor: 0.5, directness: 0.5, curiosity: 0.7, empathy: 0.8 } },
  { id: 'mentor', name: '专业导师', icon: '📚',
    values: { warmth: 0.3, humor: 0.2, directness: 0.8, curiosity: 0.3, empathy: 0.3 } },
  { id: 'tsundere', name: '傲娇猫猫', icon: '😾',
    values: { warmth: 0.4, humor: 0.7, directness: 0.5, curiosity: 0.6, empathy: 0.5 } },
  { id: 'cheerleader', name: '元气鼓励师', icon: '🎉',
    values: { warmth: 0.9, humor: 0.6, directness: 0.4, curiosity: 0.5, empathy: 0.8 } },
];

const dimensions = ref(DIM_DEFS.map(d => ({ ...d, value: 0.5 })));
const activePreset = ref(null);
const saved = ref(false);
let saveTimer = null;

onMounted(async () => {
  try {
    const result = await window.electronAPI?.personalityGet?.();
    if (result?.dims) {
      for (const dim of dimensions.value) {
        dim.value = result.dims[dim.key] ?? 0.5;
      }
    }
  } catch {}
});

function onSlider(key, event) {
  const val = parseInt(event.target.value) / 100;
  const dim = dimensions.value.find(d => d.key === key);
  if (dim) dim.value = val;
  activePreset.value = null; // manual change → not a preset
  scheduleSave(key, val);
}

function scheduleSave(key, val) {
  saved.value = false;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await window.electronAPI?.personalitySet?.({ dim: key, value: val });
    saved.value = true;
    setTimeout(() => saved.value = false, 2000);
  }, 300); // debounce 300ms
}

function applyPreset(preset) {
  for (const dim of dimensions.value) {
    dim.value = preset.values[dim.key] ?? 0.5;
  }
  activePreset.value = preset.id;
  // Batch save
  window.electronAPI?.personalitySetBatch?.({ dims: preset.values });
  saved.value = true;
  setTimeout(() => saved.value = false, 2000);
}

async function resetDefaults() {
  const defaults = { warmth: 0.5, humor: 0.3, directness: 0.6, curiosity: 0.4, empathy: 0.6 };
  for (const dim of dimensions.value) {
    dim.value = defaults[dim.key] ?? 0.5;
  }
  activePreset.value = null;
  await window.electronAPI?.personalitySetBatch?.({ dims: defaults });
  saved.value = true;
  setTimeout(() => saved.value = false, 2000);
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


.personality-panel {
  padding: 16px;
  font-size: 13px;
  overflow-y: auto;
  height: 100%;
}

.personality-panel h3 { font-size: 16px; margin-bottom: 6px; }
.personality-desc { color: var(--text-muted, #88909E); font-size: 12px; margin-bottom: 16px; }

.dim-slider {
  margin-bottom: 18px;
  padding: 10px;
  border-radius: 10px;
  background: var(--card, #FFFFFF);
  border: 1px solid var(--border, #E8ECF0);
}

.dim-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2px;
}

.dim-label { font-weight: 500; }
.dim-val { font-size: 11px; color: var(--text-muted, #88909E); }
.dim-desc { font-size: 11px; color: var(--text-muted, #88909E); margin-bottom: 8px; }

.dim-range {
  width: 100%;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  border-radius: 3px;
  background: linear-gradient(to right, var(--border, #E8ECF0) 0%, var(--accent, #059669) 100%);
  outline: none;
}

.dim-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent, #059669);
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0,0,0,.15);
}

.dim-extremes {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-muted, #88909E);
  margin-top: 4px;
}

.personality-presets h4 {
  font-size: 13px;
  margin: 12px 0 8px;
  color: var(--text-secondary, #5A6170);
}

.preset-buttons { display: flex; gap: 6px; flex-wrap: wrap; }

.preset-btn {
  padding: 6px 14px;
  border: 1px solid var(--border, #E8ECF0);
  border-radius: 18px;
  background: var(--card, #FFFFFF);
  font-size: 12px;
  cursor: pointer;
  transition: all .15s;
}

.preset-btn:hover { border-color: var(--brand, #059669); }
.preset-btn.active {
  background: var(--brand, #059669);
  color: white;
  border-color: var(--brand, #059669);
}

.personality-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
}

.btn-reset {
  padding: 6px 14px;
  border: 1px solid var(--border, #E8ECF0);
  border-radius: 6px;
  background: none;
  cursor: pointer;
  font-size: 12px;
}

.save-hint { font-size: 11px; color: var(--brand, #059669); }
</style>

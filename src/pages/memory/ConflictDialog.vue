<template>
  <Teleport to="body">
    <div class="conflict-overlay" v-if="visible" @click.self="dismiss">
      <div class="conflict-dialog">
        <div class="conflict-header">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M12 9v4"/><path d="M12 17h.01"/>
            <circle cx="12" cy="12" r="10"/>
          </svg>
          <span class="conflict-title">Memory Conflict</span>
          <button class="conflict-close" @click="dismiss" aria-label="Close">X</button>
        </div>
        <div class="conflict-body">
          <p class="conflict-desc">New information conflicts with existing high-confidence memory. Choose how to resolve:</p>
          <div class="conflict-list">
            <div v-for="(c, i) in conflicts" :key="i" class="conflict-item">
              <div class="conflict-row old">
                <span class="conflict-label">Existing</span>
                <span class="conflict-text">{{ c.old }}</span>
              </div>
              <div class="conflict-arrow">vs</div>
              <div class="conflict-row new">
                <span class="conflict-label">New</span>
                <span class="conflict-text">{{ c.new }}</span>
              </div>
              <div class="conflict-actions">
                <button class="conflict-btn keep-old" @click="resolve(i, 'keep_old')">Keep Old</button>
                <button class="conflict-btn update-new" @click="resolve(i, 'update')">Update</button>
                <button class="conflict-btn keep-both" @click="resolve(i, 'keep_both')">Keep Both</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  isDark: Boolean,
})

const emit = defineEmits(['resolved', 'dismissed'])

const visible = ref(false)
const conflicts = ref([])

function show(newConflicts) {
  conflicts.value = newConflicts.map(c => ({
    old: c.old || '',
    new: c.new || '',
    action: c.action || 'blocked',
    resolved: false,
  }))
  visible.value = true
}

function resolve(index, choice) {
  const c = conflicts.value[index]
  if (!c || c.resolved) return
  c.resolved = true
  c.choice = choice
  emit('resolved', { index, old: c.old, new: c.new, choice })

  // Auto-dismiss when all resolved
  if (conflicts.value.every(c => c.resolved)) {
    setTimeout(() => { visible.value = false }, 300)
  }
}

function dismiss() {
  visible.value = false
  emit('dismissed')
}

// Listen for conflict events from main process
function bindIPC() {
  window.electronAPI?.onMemoryConflict?.((data) => {
    if (data?.conflicts?.length > 0) {
      show(data.conflicts)
    }
  })
}

// Expose for parent to call
defineExpose({ show, bindIPC })
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


.conflict-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  animation: overlayIn 0.2s ease-out;
}

@keyframes overlayIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.conflict-dialog {
  background: #1A1A2E;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 24px;
  max-width: 480px;
  width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
  animation: dialogIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes dialogIn {
  from { opacity: 0; transform: scale(0.95) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

.conflict-dialog.is-dark {
  background: #0F0F1A;
  border-color: rgba(255, 255, 255, 0.06);
}

.conflict-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
  color: #F59E0B;
}

.conflict-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: #E8E8F0;
}

.conflict-close {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.conflict-close:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.7);
}

.conflict-desc {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  margin: 0 0 16px;
  line-height: 1.5;
}

.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.conflict-item {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  padding: 14px;
}

.conflict-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.conflict-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.conflict-badge {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.conflict-badge.lock {
  background: rgba(125, 140, 255, 0.15);
  color: #A78BFA;
}

.conflict-text {
  font-size: 13px;
  color: #E0E0E8;
  line-height: 1.4;
}

.conflict-arrow {
  text-align: center;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.2);
  margin: 6px 0;
}

.conflict-row.old .conflict-text {
  color: rgba(255, 255, 255, 0.4);
}

.conflict-row.new .conflict-text {
  color: #F59E0B;
}

.conflict-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}

.conflict-btn {
  flex: 1;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  color: rgba(255, 255, 255, 0.5);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}

.conflict-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.8);
}

.conflict-btn.keep-old:hover {
  background: rgba(125, 140, 255, 0.15);
  border-color: rgba(125, 140, 255, 0.3);
  color: #A78BFA;
}

.conflict-btn.update-new:hover {
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.3);
  color: #F59E0B;
}

.conflict-btn.keep-both:hover {
  background: rgba(16, 185, 129, 0.15);
  border-color: rgba(16, 185, 129, 0.3);
  color: #10B981;
}
</style>


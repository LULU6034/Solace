<template>
  <div class="agent-steps" v-if="steps.length > 0">
    <div class="agent-steps-inner">
      <div v-for="(step, i) in steps" :key="i"
        class="step-item" :class="`step-${step.type}`">
        <!-- 思考气泡 -->
        <div v-if="step.type === 'thought'" class="step-thought">
          <span class="step-icon">💭</span>
          <span class="step-text">{{ step.content }}</span>
        </div>

        <!-- 工具调用卡片 -->
        <div v-else-if="step.type === 'action'" class="step-action">
          <div class="step-action-header">
            <span class="step-icon">🔧</span>
            <span class="step-tool-name">{{ step.tool }}</span>
            <span class="step-badge">第{{ step.round }}轮</span>
          </div>
          <div class="step-action-input" v-if="step.input">
            <code>{{ fmtInput(step.input) }}</code>
          </div>
        </div>

        <!-- 工具结果 -->
        <div v-else-if="step.type === 'observation'" class="step-observation">
          <div class="step-obs-header">
            <span class="step-icon">📋</span>
            <span>{{ step.tool }} 结果</span>
          </div>
          <div class="step-obs-content">
            <pre>{{ step.content }}</pre>
          </div>
        </div>

        <!-- 记忆更新 -->
        <div v-else-if="step.type === 'memory'" class="step-memory">
          <span class="step-icon">🧠</span>
          <span class="step-text">已记住: {{ step.content }}</span>
        </div>

        <!-- 连接箭头 -->
        <div v-if="i < steps.length - 1" class="step-connector">
          <svg width="14" height="20" viewBox="0 0 14 20" fill="none">
            <path d="M7 0v16M2 13l5 5 5-5" stroke="#D4C8BA" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  steps: { type: Array, default: () => [] },
})

function fmtInput(input) {
  if (!input) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}
</script>

<style scoped>
.agent-steps {
  margin: 6px 0 10px;
  padding-left: 8px;
  border-left: 2px dashed #E2D9CF;
}

.agent-steps-inner {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-item {
  font-size: 12px;
  animation: stepIn 0.25s ease-out;
}

@keyframes stepIn {
  from { opacity: 0; transform: translateX(-6px); }
  to { opacity: 1; transform: translateX(0); }
}

.step-thought {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: #8B7A65;
  padding: 4px 8px;
  background: #FBF7F2;
  border-radius: 8px;
  border: 1px solid #EDE5D9;
  font-style: italic;
}

.step-icon {
  font-size: 13px;
  flex-shrink: 0;
  margin-top: 1px;
}

.step-text {
  line-height: 1.4;
}

/* 工具调用卡片 */
.step-action {
  background: #F5EFE6;
  border-radius: 10px;
  border: 1.2px solid #E2D9CF;
  overflow: hidden;
}

.step-action-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: #EFE8DC;
  border-bottom: 1px solid #E2D9CF;
}

.step-tool-name {
  font-weight: 600;
  color: #5C4A32;
  font-family: monospace;
  font-size: 11.5px;
}

.step-badge {
  margin-left: auto;
  font-size: 10px;
  color: #9B8870;
  background: #E8DFD2;
  padding: 1px 6px;
  border-radius: 6px;
}

.step-action-input {
  padding: 6px 10px;
}

.step-action-input code {
  font-size: 10.5px;
  color: #6B5A42;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
}

/* 工具结果 */
.step-observation {
  background: #FAF8F4;
  border-radius: 10px;
  border: 1.2px solid #E5DDD0;
  overflow: hidden;
}

.step-obs-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 11px;
  color: #8B7A65;
  border-bottom: 1px solid #EDE5D9;
}

.step-obs-content {
  padding: 6px 10px;
  max-height: 120px;
  overflow-y: auto;
}

.step-obs-content pre {
  margin: 0;
  font-size: 10.5px;
  color: #5C4A32;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  line-height: 1.5;
}

/* 记忆更新 */
.step-memory {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  color: #8B7A65;
  font-size: 11px;
}

/* 连接箭头 */
.step-connector {
  display: flex;
  justify-content: center;
  padding: 1px 0;
  opacity: 0.6;
}
</style>

# 前端样式重设计 — 全息智能·超感交互系统

> **For agentic workers:** 按任务逐项实现，每步完成后验证。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AI 桌面宠物「静屿」前端整体样式严格对齐参考设计"全息智能·超感交互系统 v3"，覆盖全局样式、控件体系、语音可视化和音乐播放器。

**Architecture:** CSS 变量层 (tokens.css) → 布局/组件样式层 (chat.css) → Vue 组件层 (App.vue, VoiceChat.vue, SidebarFrame.vue)。变量层定义颜色/阴影/动画，组件样式消费变量，Vue 模板驱动交互。

**Tech Stack:** Vue 3 SFC + CSS Custom Properties + JS requestAnimationFrame

**参考设计:** `C:\Users\L\Documents\Codex\2026-06-08\ai\outputs\design-system-reference-v4.html`

---

## 文件修改清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/styles/tokens.css` | 修改 | 微调字体、补全动画变量 |
| `src/styles/chat.css` | 大幅修改 | 玻璃窗、按钮、输入框、分段控件、开关等组件样式全面重写 |
| `src/App.vue` | 小幅修改 | glass-window 类名、布局微调 |
| `src/pages/voice/VoiceChat.vue` | 大幅修改 | 语音可视化替换为参考设计 |
| `src/components/SidebarFrame.vue` | 大幅修改 | 播放器升级为参考设计风格 |

---

## 设计参数速查表

### 色板

| Token | 值 | 用途 |
|-------|-----|------|
| --color-base-deep | #08080f | 最深背景 |
| --color-base | #0c0c18 | 主背景 |
| --color-surface-1 | #141420 | 面板/卡片 |
| --color-surface-2 | #1c1c30 | 升高层/hover |
| --color-indigo | #6d7cff | 主 accent |
| --color-indigo-glow | #a8b5ff | accent 辉光 |
| --color-violet | #9a7cf5 | 辅 accent |
| --color-violet-glow | #b89aff | 紫色辉光 |
| --color-amber | #d4a860 | 金色点缀 |

### 动画曲线

| 用途 | 值 |
|------|-----|
| 弹簧 (hover/active) | cubic-bezier(0.34, 1.56, 0.64, 1) |
| 平滑 (focus/color) | cubic-bezier(0.16, 1, 0.3, 1) |
| 快速 | 0.2s |
| 正常 | 0.35s |
| 慢速/弹簧 | 0.5s |

### 阴影体系

| 层级 | 值 |
|------|-----|
| --shadow-sm | 0 1px 3px rgba(0,0,0,0.3) |
| --shadow-md | 0 4px 16px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.2) |
| --shadow-lg | 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.15) |
| --shadow-glow | 0 0 24px rgba(109,124,255,0.06), 0 0 0 1px rgba(109,124,255,0.02) |
| --shadow-glass | 0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.03) |

### 字体

| 用途 | 字体 | 替代 |
|------|------|------|
| 展示/标题 | Saira Semi Condensed | (已加载，近 Space Grotesk) |
| 正文 | Inter | system-ui fallback |
| 等宽 | JetBrains Mono | Consolas |

---

### Task 1: tokens.css — 微调

**Files:**
- Modify: `src/styles/tokens.css`

- [ ] **Step 1: 更新 body 背景为最深色 + 调整显示字体**

tokens.css body 的 `background` 从当前 radial-gradient 改为纯色 `var(--color-base-deep)`（参考设计的 `#08080f`），移除 backdrop-filter 避免与其他层毛玻璃冲突。

将 body 的 `background` 行替换为：
```css
  background: var(--color-base-deep);
```

将 `--font-display` 保持为 `'Saira Semi Condensed'`（已通过 Google Fonts 加载，与 Space Grotesk 风格接近）。

**验证:** 重启 dev，确认聊天窗口背景为深黑色 `#08080f`，无渐变。

---

### Task 2: chat.css — 玻璃窗升级

**Files:**
- Modify: `src/styles/chat.css` (`.glass-window` 块)

- [ ] **Step 1: 重写 `.glass-window` 为参考毛玻璃风格**

当前 `.glass-window` 使用 `background: var(--bg)` 实色 + 简单边框。改为参考设计的毛玻璃风格：半透明渐变背景 + `backdrop-filter: blur` + 多层阴影。

替换 `.glass-window` 块：
```css
.glass-window {
  display: flex; flex-direction: column;
  margin: 6px; width: calc(100% - 12px); height: calc(100vh - 12px);
  border-radius: var(--radius-lg);
  background: linear-gradient(145deg, rgba(255,255,255,0.008) 0%, rgba(109,124,255,0.006) 100%);
  backdrop-filter: blur(var(--glass-blur, 24px));
  -webkit-backdrop-filter: blur(var(--glass-blur, 24px));
  overflow: hidden; position: relative;
  border: 1px solid rgba(255,255,255,0.03);
  box-shadow: var(--shadow-glass);
}
```

**验证:** 重启 dev，聊天窗口应有毛玻璃模糊效果 + 微妙的半透明渐变 + 多层阴影。

---

### Task 3: chat.css — 标题栏 + 侧边栏 + 消息区对标

**Files:**
- Modify: `src/styles/chat.css` (`.pet-strip`, `.sidebar`, `.main-area`, `.messages-area` 块)

- [ ] **Step 1: 标题栏改为玻璃透明风格**

```css
.pet-strip {
  height: 40px; flex-shrink: 0; display: flex; align-items: center;
  padding: 0 20px;
  background: rgba(255,255,255,0.01);
  border-bottom: 1px solid rgba(255,255,255,0.03);
  gap: 8px;
  font-size: 13px; font-weight: 500; color: var(--text-primary);
  cursor: grab; user-select: none;
}
```

- [ ] **Step 2: 侧边栏背景对标参考**

```css
.sidebar {
  width: 220px; flex-shrink: 0; display: flex; flex-direction: column;
  background: rgba(255,255,255,0.008);
  border-right: 1px solid rgba(255,255,255,0.03);
  user-select: none;
}
```

- [ ] **Step 3: 侧边栏激活态使用渐变 + 阴影（参考 seg-item.active）**

```css
.sidebar-item.active {
  background: rgba(109,124,255,0.04);
  border: 1px solid rgba(109,124,255,0.06);
  color: var(--accent-glow, #a8b5ff);
  font-weight: 600;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
```

- [ ] **Step 4: 主内容区和消息区保持透明**

```css
.main-area {
  flex: 1; display: flex; flex-direction: column; min-width: 0;
  background: transparent;
}
.messages-area {
  flex: 1; overflow-y: auto; padding: 20px 24px;
  display: flex; flex-direction: column; gap: 16px;
  background: transparent;
}
```

**验证:** 侧边栏激活项有渐变底 + 微边框 + 阴影，标题栏半透明。

---

### Task 4: chat.css — 控件体系重写

**Files:**
- Modify: `src/styles/chat.css` (按钮、输入框、分段控件、开关相关块)

#### 4.1 按钮系统

- [ ] **Step 1: 主按钮（Primary）— send-btn-inline、setting-btn.primary**

参考 `.btn-primary`：渐变背景 + 3 层阴影 + hover 弹簧 + active 缩放。

```css
/* 主按钮：发送 / 确认 */
.send-btn-inline,
.setting-btn.primary,
.approval-allow {
  position: relative;
  background: linear-gradient(135deg, #6d7cff, #9a7cf5);
  color: #fff;
  border: none;
  box-shadow:
    0 4px 24px rgba(109,124,255,0.15),
    0 1px 2px rgba(0,0,0,0.2),
    inset 0 1px 0 rgba(255,255,255,0.15);
  transition: transform 0.5s var(--ease-spring), box-shadow 0.4s var(--ease-out), background 0.4s var(--ease-out);
  cursor: pointer;
}
.send-btn-inline:hover:not(:disabled),
.setting-btn.primary:hover:not(:disabled),
.approval-allow:hover:not(:disabled) {
  transform: translateY(-3px) scale(1.02);
  box-shadow:
    0 12px 40px rgba(109,124,255,0.2),
    0 2px 4px rgba(0,0,0,0.15),
    inset 0 1px 0 rgba(255,255,255,0.15),
    0 0 60px rgba(109,124,255,0.06);
}
.send-btn-inline:active:not(:disabled),
.setting-btn.primary:active:not(:disabled) {
  transform: translateY(-1px) scale(0.97);
  box-shadow: 0 2px 8px rgba(109,124,255,0.15);
}

/* 发送按钮特定尺寸 */
.send-btn-inline {
  width: 32px; height: 32px; padding: 0; border-radius: 16px;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; overflow: hidden;
}
```

- [ ] **Step 2: 次按钮（Secondary）— setting-btn.secondary、侧边栏按钮**

参考 `.btn-secondary`：微亮玻璃底 + 细边框 + hover 上浮。

```css
.setting-btn.secondary,
.ctx-menu-item,
.role-picker-item {
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.04);
  color: var(--text-secondary);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
  transition: all 0.35s var(--ease-spring);
}
.setting-btn.secondary:hover,
.ctx-menu-item:hover,
.role-picker-item:hover {
  background: rgba(109,124,255,0.03);
  border-color: rgba(109,124,255,0.1);
  color: var(--accent-glow);
  transform: translateY(-2px);
  box-shadow: 0 8px 30px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.02);
}
```

- [ ] **Step 3: 禁用状态**

```css
.send-btn-inline:disabled,
.setting-btn.primary:disabled {
  background: rgba(255,255,255,0.03);
  color: var(--text-muted);
  cursor: default;
  filter: none; transform: none; box-shadow: none;
}
```

#### 4.2 输入框

- [ ] **Step 4: 输入框对标参考 `.inp`**

```css
.input-box {
  display: flex; align-items: flex-end; gap: 8px;
  background: rgba(255,255,255,0.008);
  border: 1px solid rgba(255,255,255,0.03);
  border-radius: 10px; padding: 4px 4px 4px 16px;
  transition: all 0.4s var(--ease-out);
}
.input-box:hover {
  border-color: rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.012);
}
.input-box:focus-within {
  border-color: rgba(109,124,255,0.1);
  background: rgba(109,124,255,0.015);
  box-shadow: 0 0 0 6px rgba(109,124,255,0.03), 0 8px 32px rgba(0,0,0,0.12);
}
.input-box textarea::placeholder {
  color: var(--text-muted);
  font-weight: 300;
}
```

- [ ] **Step 5: 设置面板输入框、下拉框、文本域统一**

```css
.setting-input, .setting-textarea, .setting-select,
.rd-input, .rename-dialog .setting-input,
.setting-btn.secondary {
  padding: 11px 14px;
  border: 1px solid rgba(255,255,255,0.03);
  border-radius: 9px;
  background: rgba(255,255,255,0.008);
  color: var(--text-primary);
  font-family: var(--font-body, 'Inter', system-ui, sans-serif);
  font-size: 13px;
  outline: none;
  transition: all 0.4s var(--ease-out);
}
.setting-input:hover, .setting-textarea:hover, .setting-select:hover {
  border-color: rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.012);
}
.setting-input:focus, .setting-textarea:focus, .setting-select:focus {
  border-color: rgba(109,124,255,0.1);
  box-shadow: 0 0 0 6px rgba(109,124,255,0.03), 0 8px 32px rgba(0,0,0,0.12);
}
```

#### 4.3 分段控件

- [ ] **Step 6: 分段控件对标参考 `.seg-group`**

```css
.segmented-row {
  display: inline-flex; gap: 2px;
  padding: 3px;
  background: rgba(255,255,255,0.015);
  border: 1px solid rgba(255,255,255,0.02);
  border-radius: 10px;
}
.segmented-row .seg-btn {
  padding: 8px 20px; border-radius: 7px;
  border: none; background: transparent;
  color: var(--text-muted);
  font-size: 12px; font-weight: 500;
  letter-spacing: 0.2px;
  transition: all 0.35s var(--ease-out);
}
.segmented-row .seg-btn:hover { color: var(--text-secondary); }
.segmented-row .seg-btn.active {
  background: rgba(109,124,255,0.04);
  border: 1px solid rgba(109,124,255,0.06);
  color: var(--accent-glow);
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
```

#### 4.4 Model Select 下拉

- [ ] **Step 7: 下拉框对标参考 `.sel`**

```css
.model-select, .setting-select {
  padding: 11px 38px 11px 14px;
  border: 1px solid rgba(255,255,255,0.03);
  border-radius: 9px;
  background: rgba(255,255,255,0.008);
  color: var(--text-secondary);
  font-family: var(--font-body, 'Inter', system-ui, sans-serif);
  font-size: 13px;
  outline: none; cursor: pointer;
  transition: all 0.3s var(--ease-out);
  -webkit-appearance: none;
  appearance: none;
}
.model-select:hover, .setting-select:hover {
  border-color: rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.012);
}
.model-select:focus, .setting-select:focus {
  border-color: rgba(109,124,255,0.08);
  box-shadow: 0 0 0 4px rgba(109,124,255,0.03);
  color: var(--text-primary);
}
```

**验证:** 打开 app，检查发送按钮（渐变）、输入框（hover 微亮 + focus 双光晕）、分段控件（激活渐变底）、下拉框（样式一致）。

---

### Task 5: VoiceChat.vue — 语音可视化替换

**Files:**
- Modify: `src/pages/voice/VoiceChat.vue`

#### 5.1 模板替换

- [ ] **Step 1: 替换 `.voice-viz` 区块**

删除第 4-22 行的双瞳 + 能量球模板，替换为：

```html
    <!-- AI Voice Visualization (参考设计) -->
    <div class="voice-viz">
      <div class="vlabel">语音交互界面</div>
      <div class="vrow">
        <div class="veu vl">
          <div class="vec"><div class="vpillar" ref="pillarLRef"></div></div>
          <span class="vlab">感知</span>
        </div>
        <div class="veu vr">
          <div class="vec"><div class="vpillar" ref="pillarRRef"></div></div>
          <span class="vlab">理解</span>
        </div>
      </div>
      <div class="vbar"><div class="vfill" ref="vfillRef"></div></div>
      <div class="vstat"><span class="vd"></span>{{ statusLabel }}</div>
    </div>
```

- [ ] **Step 2: 在 script setup 中添加 statusLabel**

```js
const statusLabel = computed(function() {
  if (isListening.value) return "聆听中 · 随时可以说话";
  if (isThinking.value) return "思考中 · 请稍候";
  if (isSpeaking.value) return "回复中 · 正在说话";
  return "待命中 · 按住空格键说话";
});
```

以及添加 refs：
```js
const pillarLRef = ref(null);
const pillarRRef = ref(null);
const vfillRef = ref(null);
```

#### 5.2 动画简化

- [ ] **Step 3: 替换 `startVizAnim()` 函数**

删除原来 160 行的瞳孔/能量球/眨眼动画，替换为简洁的柱高呼吸 + 扫描条动画：

```js
/* === AI Voice Visualization Animation === */
var vizAnimId = null;
var vizT = 0;

function startVizAnim() {
  var lastTime = performance.now();
  function update(time) {
    vizAnimId = requestAnimationFrame(update);
    var dt = Math.min(time - lastTime, 50);
    lastTime = time;
    vizT += dt * 0.001;

    // Pillars: base 36px + breath ±6px
    var baseH = 36;
    var amp = isSpeaking.value ? 8 : isListening.value ? 5 : 3;
    var speed = isSpeaking.value ? 3.5 : isListening.value ? 2.5 : 1.2;
    var hL = baseH + Math.sin(vizT * speed) * amp;
    var hR = baseH + Math.sin(vizT * speed + 0.8) * amp;
    if (pillarLRef.value) pillarLRef.value.style.height = hL + "px";
    if (pillarRRef.value) pillarRRef.value.style.height = hR + "px";

    // Scanning bar: background-position sweep
    if (vfillRef.value) {
      var pos = ((vizT * 25) % 200) - 100;
      vfillRef.value.style.backgroundPosition = pos + "% 0";
      vfillRef.value.style.opacity = isSpeaking.value ? "0.5" : isListening.value ? "0.35" : "0.15";
    }
  }
  vizAnimId = requestAnimationFrame(update);
}
```

删除原来的 `stopVizAnim`（保留不变）。

#### 5.3 样式替换

- [ ] **Step 4: 替换所有 voice-viz 相关样式**

删除 `.voice-viz`, `.viz-eyes`, `.eye-unit`, `.eye-glow`, `.eye-pillar`, `.eye-pupil`, `.viz-energy`, `.energy-blob` 全部样式。

替换为：

```css
/* ═══ Voice Visualization (参考全息设计) ═══ */
.voice-viz {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -65%);
  display: flex; flex-direction: column; align-items: center;
  z-index: 5; pointer-events: none;
  background: rgba(255,255,255,0.008);
  border: 1px solid rgba(255,255,255,0.02);
  border-radius: 20px;
  padding: 56px 40px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.voice-viz::before {
  content: '';
  position: absolute; inset: 0; border-radius: 20px;
  background: radial-gradient(ellipse at 50% 35%, rgba(109,124,255,0.015) 0%, transparent 50%);
}
.vlabel {
  font-size: 8px; letter-spacing: 4px;
  color: rgba(255,255,255,0.08);
  margin-bottom: 28px; position: relative; z-index: 1;
  text-transform: uppercase;
}
.vrow {
  display: flex; justify-content: center; gap: 80px;
  margin-bottom: 24px; position: relative; z-index: 1;
}
.veu { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.vlab { font-size: 8px; letter-spacing: 2px; color: rgba(255,255,255,0.05); text-transform: uppercase; }
.vec {
  position: relative; width: 48px; height: 85px;
  display: flex; align-items: center; justify-content: center;
}
.vpillar {
  width: 3.5px; border-radius: 2px;
  position: absolute; bottom: 16px;
  background: linear-gradient(to bottom, #ffffff, rgba(255,255,255,0.35));
  height: 36px;
  transition: height 0.2s ease;
}
.vl .vpillar {
  box-shadow: 0 0 8px rgba(255,255,255,0.06), 0 0 24px rgba(109,124,255,0.02);
}
.vr .vpillar {
  box-shadow: 0 0 8px rgba(255,255,255,0.06), 0 0 24px rgba(154,124,245,0.02);
}
.vbar {
  width: 280px; height: 2px; margin: 0 auto 16px;
  position: relative; z-index: 1; overflow: hidden;
  border-radius: 1px;
  background: rgba(255,255,255,0.01);
}
.vfill {
  position: absolute; inset: 0;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(109,124,255,0.08) 10%, rgba(109,124,255,0.2) 25%,
    rgba(154,124,245,0.3) 40%, rgba(255,255,255,0.35) 50%,
    rgba(154,124,245,0.3) 60%, rgba(109,124,255,0.2) 75%,
    rgba(109,124,255,0.08) 90%, transparent 100%);
  background-size: 200% 100%;
}
.vstat {
  font-size: 9px; color: var(--text-muted);
  position: relative; z-index: 1;
  display: flex; align-items: center; justify-content: center; gap: 5px;
}
.vd {
  width: 3px; height: 3px; border-radius: 50%;
  background: var(--accent);
  animation: vdPulse 2.5s ease-in-out infinite;
}
@keyframes vdPulse { 0%,100% { opacity: 0.15; } 50% { opacity: 0.5; } }
```

**验证:** 进入语音页面，确认面板有毛玻璃效果 + 径向光晕，左右柱子呼吸动画，扫描条流动，状态文字显示正确。

---

### Task 6: SidebarFrame.vue — 播放器升级

**Files:**
- Modify: `src/components/SidebarFrame.vue`

#### 6.1 模板升级

- [ ] **Step 1: 替换播放器模板**

将第 31-58 行替换为：

```html
        <!-- Music Player (参考全息设计) -->
        <div class="music-player">
          <div class="pl-header">
            <span class="pl-hicon">&#9835;</span>
            <span class="pl-htitle">音乐播放器</span>
            <span class="pl-badge" v-if="isPlaying">播放中</span>
          </div>
          <div class="pl-art">
            <div class="pl-art-inner">
              <svg viewBox="0 0 80 80" class="pl-art-svg">
                <circle cx="40" cy="40" r="30" fill="none" stroke="rgba(109,124,255,0.1)" stroke-width="1"/>
                <circle cx="40" cy="40" r="20" fill="none" stroke="rgba(154,124,245,0.08)" stroke-width="0.5"/>
                <path d="M40 15 L40 40 L58 50" fill="none" stroke="rgba(109,124,255,0.15)" stroke-width="2" stroke-linecap="round"/>
                <circle cx="40" cy="40" r="4" fill="rgba(109,124,255,0.1)"/>
              </svg>
              <div class="pl-eq">
                <span v-for="i in 6" :key="i" :style="{ animationDelay: [0,0.2,0.4,0.3,0.5,0.1][i-1] + 's' }"></span>
              </div>
            </div>
          </div>
          <div class="pl-info">
            <span class="pl-name">{{ playlist[currentTrack].name }}</span>
            <span class="pl-artist">{{ playlist[currentTrack].artist }}</span>
          </div>
          <div class="pl-progress">
            <input type="range" class="pl-slider" min="0" :max="duration || 1" :value="currentTime"
              @input="onSeek($event)" :disabled="!duration" />
            <div class="pl-time">
              <span>{{ formatTime(currentTime) }}</span>
              <span>{{ formatTime(duration) }}</span>
            </div>
          </div>
          <div class="pl-controls">
            <button class="pl-btn" @click="prevTrack" title="上一首">&#x23EE;</button>
            <button class="pl-btn pl-play" @click="togglePlay" :title="isPlaying ? '暂停' : '播放'">
              <span v-if="!isPlaying">&#x25B6;</span>
              <span v-else>&#x23F8;</span>
            </button>
            <button class="pl-btn" @click="nextTrack" title="下一首">&#x23ED;</button>
          </div>
        </div>
```

#### 6.2 样式替换

- [ ] **Step 2: 替换所有播放器样式**

删除 `.music-player` 到 `.play-btn:hover` 的旧样式（约 55 行），替换为：

```css
/* ═══ Music Player (参考全息设计, 侧边栏适配) ═══ */
.music-player {
  margin: 8px 4px;
  padding: 12px 10px;
  border-radius: 14px;
  background: rgba(255,255,255,0.008);
  border: 1px solid rgba(255,255,255,0.02);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.pl-header {
  display: flex; align-items: center; gap: 5px;
  margin-bottom: 8px;
}
.pl-hicon { font-size: 10px; color: var(--text-muted); }
.pl-htitle { font-size: 9px; font-weight: 600; color: var(--text-secondary); letter-spacing: 1px; }
.pl-badge {
  margin-left: auto; font-size: 7px; padding: 1px 5px;
  border-radius: 5px; background: rgba(109,124,255,0.06);
  color: rgba(109,124,255,0.4);
  animation: badgePulse 2s ease-in-out infinite;
}
@keyframes badgePulse { 0%,100%{opacity:0.4} 50%{opacity:1} }

.pl-art {
  width: 80px; height: 80px; margin: 0 auto 10px;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(109,124,255,0.04), rgba(154,124,245,0.04));
  border: 1px solid rgba(255,255,255,0.03);
  display: flex; align-items: center; justify-content: center;
  position: relative; overflow: hidden;
}
.pl-art-inner {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px;
}
.pl-art-svg { width: 55%; height: 55%; }
.pl-eq { display: flex; gap: 2px; align-items: flex-end; height: 12px; }
.pl-eq span {
  width: 2px; border-radius: 1px;
  background: linear-gradient(to top, #6d7cff, #9a7cf5);
  animation: eqBounce 1.2s ease-in-out infinite;
}
.pl-eq span:nth-child(1) { height: 5px; }
.pl-eq span:nth-child(2) { height: 8px; }
.pl-eq span:nth-child(3) { height: 11px; }
.pl-eq span:nth-child(4) { height: 9px; }
.pl-eq span:nth-child(5) { height: 6px; }
.pl-eq span:nth-child(6) { height: 4px; }
@keyframes eqBounce {
  0%,100% { transform: scaleY(1); opacity: 0.5; }
  50% { transform: scaleY(1.5); opacity: 1; }
}

.pl-info {
  text-align: center; margin-bottom: 8px;
}
.pl-name {
  font-size: 11px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  display: block;
}
.pl-artist { font-size: 9px; color: var(--text-muted); }

.pl-progress { margin-bottom: 6px; }
.pl-slider {
  -webkit-appearance: none; width: 100%; height: 3px;
  border-radius: 2px; background: rgba(255,255,255,0.04);
  outline: none; cursor: pointer;
}
.pl-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 12px; height: 12px;
  border-radius: 50%;
  background: linear-gradient(135deg, #6d7cff, #9a7cf5);
  cursor: pointer;
  border: 2px solid rgba(255,255,255,0.08);
  box-shadow: 0 0 10px rgba(109,124,255,0.15);
  transition: transform 0.2s;
}
.pl-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
.pl-slider:disabled { opacity: 0.3; }

.pl-time {
  display: flex; justify-content: space-between; margin-top: 2px;
}
.pl-time span {
  font-size: 8px; color: var(--text-muted);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
}

.pl-controls {
  display: flex; justify-content: center; align-items: center; gap: 8px;
}
.pl-btn {
  width: 28px; height: 28px; border-radius: 50%; border: none;
  background: transparent; color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.35s var(--ease-spring);
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; line-height: 1;
}
.pl-btn:hover {
  background: rgba(109,124,255,0.06);
  color: var(--accent-glow);
  transform: scale(1.1);
}
.pl-btn:active { transform: scale(0.92); }
.pl-play {
  width: 32px; height: 32px;
  background: rgba(109,124,255,0.06);
}
.pl-play:hover {
  background: rgba(109,124,255,0.1);
  box-shadow: 0 0 20px rgba(109,124,255,0.06);
}
```

**验证:** 侧边栏底部播放器有 80px 封面区 + SVG 圆环 + 6 根均衡条动画，渐变进度滑块，播放键更大且 hover 有辉光。

---

### Task 7: chat.css — 清理废弃样式

**Files:**
- Modify: `src/styles/chat.css`

- [ ] **Step 1: 删除已被 tokens.css 覆盖的全局样式**

检查并删除以下已由 tokens.css 覆盖的重复/无关样式：

删除 `.quiet-mode`（已移入 tokens.css）、删除 `@media (prefers-reduced-motion: reduce)`（已移入 tokens.css，如果仍存在于 chat.css 中）。

如果 chat.css 中还有 body 的 `font-family`, `font-size`, `color`, `-webkit-font-smoothing`, `line-height` 等声明，与 tokens.css 重复则删除。

**验证:** 重启 dev，确认无 CSS 编译警告，视觉效果不变。

---

### Task 8: 集成验证

- [ ] **Step 1: 启动应用完整检查**

```bash
cd D:\Project\ai-desktop-pet-electron
npm run dev
```

检查清单：
1. 聊天窗口背景为深黑色，毛玻璃效果可见
2. 发送按钮有渐变 + 3 层阴影，hover 上浮
3. 输入框 hover 微亮，focus 有 6px 光晕
4. 分段控件（模型选择）激活态有渐变底
5. 下拉框样式一致
6. 侧边栏激活项有渐变底 + 微边框 + 阴影
7. 语音页面显示毛玻璃面板 + 双柱呼吸 + 扫描条 + 状态文字
8. 语音页面按住空格可录音，松开发送
9. 侧边栏播放器显示封面区 + 均衡条动画 + 渐变滑块
10. 播放器可正常播放/暂停/切换歌曲
11. 设置面板输入框/按钮样式一致
12. 深色模式自然适配（tokens.css 暗色默认）

- [ ] **Step 2: 对比参考设计截图**

用肉眼对比参考 HTML 文件 `design-system-reference-v4.html` 在浏览器中打开的效果，确认色调、动画、控件风格一致。

---

## 改动行数估算

| 文件 | 新增 | 删除 | 说明 |
|------|------|------|------|
| tokens.css | 2 | 2 | body 背景改纯色 |
| chat.css | ~150 | ~100 | 组件样式全面重写 |
| VoiceChat.vue | ~70 | ~180 | 模板+样式+动画简化 |
| SidebarFrame.vue | ~120 | ~60 | 模板+样式升级 |
| **总计** | ~342 | ~342 | 净增约 0 行 |

# Design System — AI 桌面宠物 v3

## Product Context
- **这是什么：** Electron + Vue 3 桌面宠物，透明窗口叠加在桌面上，Canvas 2D 像素宠物 + 聊天窗口
- **面向谁：** 需要桌面 AI 助手的开发者
- **品类：** 桌面伴侣/桌面工具
- **设计方向：** 静屿 — 暖灰陶土 / 暮蓝烟紫 双主题

## Aesthetic Direction
- **方向：** 静屿 (Serene Island) — 极简克制，温润质感
- **装饰级别：** intentional（环境光晕 + 细腻阴影 + 毛玻璃 + 材质温润感）
- **核心原理：** 大量留白承载内容，细腻阴影和微妙边框提供层次。所有交互克制优雅，无多余视觉噪音
- **情绪：** 静谧、温润、克制。像午后阳光下的一张素纸，不打扰、不喧哗

## Typography
- **UI/对话：** Inter (可变字重 400-600) / system-ui / PingFang SC / Microsoft YaHei UI
- **代码：** JetBrains Mono / Cascadia Code / Consolas
- **字号层级：** 10.5px（辅助）、11px（标签）、12px（正文）、14px（输入/消息）、18-22px（标题）
- **字重：** 标签 600、正文 400-500、标题 500-600

## Color

### 浅色主题（暖灰陶土）
| Token | Hex | 用途 |
|-------|-----|------|
| bg | #F6F3EF | 主背景——暖灰米白 |
| bg-elevated | rgba(255,252,248,0.98) | 卡片/对话框 |
| bg-card | #FCF8F4 | 次要面板 |
| bg-input | #FFFFFF | 输入框 |
| border | #EDE6DE | 边框 |
| border-strong | #D9D0C5 | 强边框 |
| text-primary | #3E322A | 主文字——深陶土灰 |
| text-secondary | #8F7868 | 次要文字——暖灰褐 |
| text-muted | #B8A898 | 提示文字 |
| accent | #B2957A | 点缀色/主按钮——陶土棕 |

### 深色主题（暮蓝烟紫）
| Token | Hex | 用途 |
|-------|-----|------|
| bg | #1E1E2A | 主背景——深蓝灰 |
| bg-elevated | rgba(32,33,44,0.96) | 卡片/对话框 |
| bg-card | #242533 | 次要面板 |
| bg-input | #2C2E3F | 输入框 |
| border | #343746 | 边框 |
| border-strong | #454860 | 强边框 |
| text-primary | #EDE7F0 | 主文字——浅紫灰 |
| text-secondary | #B6A8C2 | 次要文字 |
| text-muted | #7A7088 | 提示文字 |
| accent | #B7A0C0 | 点缀色/主按钮——淡紫 |

## Spacing
- **基准：** 8px
- **密度：** comfortable
- **消息间距：** 16px

## Layout
- **聊天窗口：** 480x620
- **设置面板：** 520px 宽，右侧 slide-in
- **圆角：** xs: 6px, sm: 10px, md: 16px, lg: 24px, xl: 2rem, pill: 60px

## Motion
- **方式：** intentional
- **主缓动：** cubic-bezier(0.2, 0.9, 0.4, 1.1) — spring-like entry
- **退出缓动：** cubic-bezier(0, 0, 0.2, 1) — ease-out
- **时长：** 微交互 120ms，常规 200ms，入场 300ms
- **安静模式：** .quiet-mode 或 prefers-reduced-motion 时乘 0.3

## Interaction Patterns
1. **悬停上浮：** 按钮/卡片 hover 时 translateY(-2px) + 阴影加深
2. **点击微收缩：** :active 时 scale(0.97)，持续 120ms，绝对无波纹扩散
3. **输入聚焦：** 边框颜色切换 + box-shadow 光晕
4. **对话框入场：** slideIn (translateY(16px) + scale(0.96) → 0/1)
5. **设置面板：** 右侧 slide-in + 背景渐显
6. **消息入场：** translateY(14px) → 0，spring 缓动

## 角色 Accent 映射
| 角色 | 色值 | 感觉 |
|------|------|------|
| Clawd (🦞) | #B2957A | 温暖、可靠 |
| 云朵 (☁️) | #A0B0C0 | 冷静、理性 |
| Coco (⌨️) | #B5C4B8 | 清新、亲和 |

## 关键决策
| 决策 | 理由 |
|------|------|
| Inter 替代 Caveat 手写体 | 更现代、更通透，桌面应用更舒适 |
| 大圆角体系 (pill: 60px) | 胶囊形态是静屿核心视觉语言 |
| 取消贴纸装饰 (📎/✨) | 保持克制，减少视觉噪音 |
| 毛玻璃效果 | 提升层次感，窗口更轻盈 |
| 环境光晕 (径向渐变) | 营造微妙空间氛围，不干扰内容 |
| 双主题 CSS 变量切换 | 统一 token 体系，html.dark 自动切换 |
| 安静模式 (--anim-speed) | 尊重用户偏好，动画速度可降 70% |

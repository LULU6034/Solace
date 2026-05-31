# Design System — AI 桌面宠物 v4

## Product Context
- **这是什么：** Electron + Vue 3 桌面宠物，聊天窗口 + Canvas 2D 像素宠物
- **面向谁：** 需要桌面 AI 助手的用户
- **品类：** 桌面伴侣/桌面工具
- **设计方向：** 专业 AI 工具 + 治愈宠物陪伴

## Aesthetic Direction
- **参考：** Workus AI — 绿色品牌渐变、深色侧边栏、大白卡片、充足留白
- **核心原理：** 深色导航 + 浅色内容区双栏布局。卡片承载功能，留白承载内容
- **情绪：** 专业可信赖，同时保有宠物角色的温暖

## Typography
- **UI/对话：** Inter / system-ui / PingFang SC / Microsoft YaHei UI
- **代码：** JetBrains Mono / Consolas
- **字号层级：** 11px（辅助）、12px（标签/正文）、14px（输入）、16px（消息）、20-24px（标题）
- **字重：** 标题 600-700、正文 400-500、标签 500

## Color

### 品牌色
| Token | Hex | 用途 |
|-------|-----|------|
| brand | #059669 | 品牌深绿 |
| brand-light | #10B981 | 品牌亮绿 |
| brand-gradient | linear-gradient(135deg, #059669, #10B981) | 按钮/强调 |

### 浅色主题（默认）
| Token | Hex | 用途 |
|-------|-----|------|
| bg | #F5F7FA | 主内容区背景 |
| sidebar-bg | #1E1E2E | 侧边栏背景 |
| card | #FFFFFF | 卡片/对话框 |
| card-hover | #FAFBFC | 卡片悬停 |
| border | #E8ECF0 | 边框 |
| border-strong | #D0D5DD | 强边框 |
| text-primary | #1A1A2E | 主文字 |
| text-secondary | #5A6170 | 次要文字 |
| text-muted | #88909E | 提示文字 |
| accent | #1a5c3a | 点缀色 |
| accent-soft | rgba(26,92,58,0.08) | 柔和点缀 |
| input-bg | #FFFFFF | 输入框 |
| input-border | #D0D5DD | 输入框边框 |
| input-focus | #2d8a56 | 输入框聚焦色 |
| success | #34C759 | 成功/在线 |
| danger | #FF3B30 | 错误/删除 |
| warning | #FF9500 | 警告 |

### 深色主题
| Token | Hex | 用途 |
|-------|-----|------|
| bg | #16161E | 主背景 |
| sidebar-bg | #0F0F17 | 侧边栏更深 |
| card | #1E1E2E | 卡片 |
| card-hover | #242436 | 卡片悬停 |
| border | #2A2A3C | 边框 |
| border-strong | #3A3A50 | 强边框 |
| text-primary | #EDEFF5 | 主文字 |
| text-secondary | #9CA0B0 | 次要文字 |
| text-muted | #6A6E7C | 提示文字 |
| accent | #34C759 | 点缀色 |
| accent-soft | rgba(52,199,89,0.1) | 柔和点缀 |
| input-bg | #1E1E2E | 输入框 |
| input-border | #2A2A3C | 输入框边框 |
| input-focus | #34C759 | 输入框聚焦色 |

## Spacing
- **基准：** 8px
- **密度：** comfortable（24px 模块间距）
- **消息间距：** 20px
- **卡片内边距：** 16-24px

## Layout
- **聊天窗口：** 650x780
- **侧边栏：** 64px 宽（图标）+ 可展开 200px（标签）
- **圆角：** xs: 6px, sm: 8px, md: 12px, lg: 16px, xl: 20px, pill: 60px

## Motion
- **方式：** intentional
- **主缓动：** cubic-bezier(0.2, 0.9, 0.4, 1.1)
- **退出缓动：** cubic-bezier(0, 0, 0.2, 1)
- **时长：** 微交互 120ms，常规 200ms，入场 300ms
- **安静模式：** prefers-reduced-motion 时乘 0.3

## Interaction Patterns
1. **悬停上浮：** 按钮/卡片 hover translateY(-1px) + 阴影加深
2. **点击反馈：** :active scale(0.98)
3. **输入聚焦：** 边框色切换 + 2px 外发光
4. **对话框入场：** slideIn(translateY(16px) + opacity 0→1)
5. **消息入场：** translateY(8px) + opacity 0→1, spring

## 角色 Accent 映射
| 角色 | 色值 | 感觉 |
|------|------|------|
| Clawd (🦞) | #B2957A | 温暖、可靠 |
| 小鱼 (🐟) | #2d8a56 | 清新、灵动 |
| Coco (⌨️) | #5B8BA0 | 理性、专业 |

## 关键决策
| 决策 | 理由 |
|------|------|
| 双栏布局 (深色侧边栏 + 浅色内容) | 参考 Workus AI，导航与内容分离清晰 |
| 品牌绿色系统 | 统一品牌识别，替代之前的暖灰陶土 |
| 大圆角卡片 | 现代 AI 工具风格，视觉层次明确 |
| 取消毛玻璃效果 | 更清晰的内容对比度，减少渲染负担 |
| CSS 变量双主题 | html.dark 自动切换，统一 token |

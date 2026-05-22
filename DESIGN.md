# Design System — AI 桌面宠物 v2

## Product Context
- **这是什么：** Electron + Vue 3 桌面宠物，透明窗口叠加在桌面上，Canvas 2D 像素宠物 + 聊天窗口
- **面向谁：** 需要桌面 AI 助手的开发者
- **品类：** 桌面伴侣/桌面工具
- **设计参考：** 彩铅素描画——暖纸底 + 冷铅笔线 + 淡金点缀

## Aesthetic Direction
- **方向：** 彩铅素描 (Colored Pencil Sketch)
- **装饰级别：** intentional（纸纹理 + 铅笔线边框 + 冷暖对比层次）
- **核心原理：** 冷暖对比创造层次——暖色纸底承载内容，冷蓝灰铅笔线提供定义和立体感
- **情绪：** 像朋友在本子上随手画的小画。温暖、手工感、不完美反而有生命

## Typography
- **UI/对话：** Segoe UI / PingFang SC / Microsoft YaHei UI
- **代码：** JetBrains Mono / SF Mono / Cascadia Code
- **字号层级：** 10.5px（辅助）、11px（标签）、12px（正文）、12.5-13px（输入）、16px（标题）

## Color

### 纸底（暖）
| Token | Hex | 用途 |
|-------|-----|------|
| paper | #e8e5da | 主背景——偏绿暖灰纸 |
| paper-light | #f0ede3 | 次要面板 |
| paper-card | #f8f6f0 | 卡片/气泡 |
| paper-deep | #dcd8cc | 深纸色 |

### 铅笔线（冷蓝灰）——提供层次
| Token | Hex | 用途 |
|-------|-----|------|
| pencil-dark | #6b7a90 | 文字/深线 |
| pencil | #8895a5 | 边框/图标 |
| pencil-light | #a5afbb | 提示文字 |
| pencil-line | rgba(107,122,144,0.18) | 分隔线 |
| pencil-border | rgba(107,122,144,0.22) | 卡片边框 |
| pencil-shadow | rgba(107,122,144,0.07) | 浅阴影 |
| pencil-shadow-deep | rgba(107,122,144,0.14) | 深阴影 |

### 文字（冷调）
| Token | Hex | 用途 |
|-------|-----|------|
| ink | #3d4555 | 主文字 |
| ink-soft | #6b7285 | 次要文字 |
| ink-light | #959db0 | 提示/占位 |

### 暖色点缀
| Token | Hex | 用途 |
|-------|-----|------|
| gold | #e8d5b0 | 主要点缀（标签下划线、主按钮） |
| peach | #f0cfbf | 辅助点缀 |

## Spacing
- **基准：** 8px
- **密度：** comfortable
- **消息间距：** 10px

## Layout
- **聊天窗口：** 480x620
- **设置面板：** 520px 宽，右侧 slide-in
- **圆角：** sm: 2-4px, md: 4-6px, lg: 6-8px

## Motion
- **方式：** intentional
- **缓动：** enter: cubic-bezier(0.22, 0.61, 0.36, 1)
- **时长：** 微交互 100-150ms，入场 220ms，呼吸 1.4-2.8s

## 角色 Accent 映射
| 角色 | 色值 | 感觉 |
|------|------|------|
| Clawd (🦞) | #e8d5b0 (淡金) | 温暖、可靠 |
| 云朵 (☁️) | #a8b4c3 (冷灰蓝) | 冷静、理性 |
| Coco (⌨️) | #b5c4b8 (淡青灰) | 清新、亲和 |

## 关键决策
| 决策 | 理由 |
|------|------|
| 冷蓝灰铅笔线 + 暖纸底 | 冷暖对比是彩铅画的层次来源 |
| 背景用偏绿暖灰而非纯暖米白 | 参考图 16% 主导色 #e0e0d0 带绿相 |
| 阴影用冷蓝灰而非暖棕 | 模拟铅笔排线而非炭笔涂抹 |
| 点缀色克制成淡金 | 参考图中暖色占比仅 37%，大面积要冷 |

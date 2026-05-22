# AI 桌面宠物

Electron + Vue 3 + Canvas 2D 桌面宠物，灵感来自 HermesPet。

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.

## 启动

```powershell
cd D:\Project\ai-desktop-pet-electron
npm run dev           # Vite + Electron 同时启动
```

前端预览: http://localhost:5173/
宠物窗口: http://localhost:5173/pet.html

## 技术栈

- Electron 42 — 透明无边框窗口、系统托盘、IPC
- Vue 3 + Vite 8 — SFC 前端
- Canvas 2D — 14×10 viewBox 像素精灵渲染
- Zustand 5 — 状态管理
- Anthropic SDK / OpenAI SDK — LLM 流式输出

## 项目结构

```
electron/
  main.cjs              — 主进程：宠物窗口、聊天窗口、托盘、IPC、窗口动画
  preload.cjs           — contextBridge：openChat/closeChat/moveWindow/feedFile/...
src/
  main.js               — 聊天窗口入口，挂载 App.vue
  pet-main.js            — 宠物窗口入口，挂载 PetApp.vue
  App.vue                — 聊天主界面（标签页、消息区、输入区、设置）
  PetApp.vue             — Canvas 动画循环 + 闲逛 + 拖放喂食 + 敏感文件过滤
  components/
    SettingsPanel.vue    — 设置面板（API Key、模型选择、角色切换）
  lib/llm/
    LLMProvider.ts        — LLM 统一接口
    adapters/             — Claude / DeepSeek / OpenAI 适配器
  pets/
    index.js              — 角色注册表（5 个角色）
    glassesDog.js         — 镜框小狗像素精灵
    clawd.js              — Clawd 龙虾像素精灵
    blackCat.js           — 小黑猫像素精灵
    yellowBird.js         — 小黄鸟像素精灵
    fox.js                — 小狐狸像素精灵
  store/                  — Zustand store
  styles/                 — CSS
```

## 已完成

- [x] 宠物窗口：透明 Canvas，requestAnimationFrame 60fps 渲染
- [x] 2 个像素精灵：glassesDog（镜框小狗）、clawd（龙虾）
- [x] 宠物切换：双击切换角色
- [x] 宠物闲逛：随机间隔窗口移动
- [x] 聊天窗口：HermesPet 风格 UI，玻璃态透明窗口
- [x] 多对话标签页：支持 8 个，右键重命名/关闭
- [x] 3 个 LLM provider：Claude(Anthropic) / DeepSeek / OpenAI，流式输出
- [x] 设置面板：API Key 配置，模型选择
- [x] 窗口展开/收起动画（easeOutCubic）
- [x] 拖放文件喂食：拖到宠物窗口触发聊天分析
- [x] 敏感文件过滤：黑名单关键词（薪资/密码/.env/身份证等）
- [x] 宠物拒绝动画：敏感文件抖动
- [x] 宠物进食动画 + AI 工作状态呼吸
- [x] 系统托盘：显示/隐藏/聊天/退出
- [x] 图片粘贴到聊天

## 待修复 / 待实现

### Bug
- [x] **聊天窗口闪退**：已修复 — app.disableHardwareAcceleration() + crashed 事件自动重建 + backgroundColor 显式透明
- [x] **ChatBubble.vue / ChatInput.vue / ConfigPanel.vue**：已清理，3 个孤立文件已删除

### 功能
- [x] 宠物走动动画（原地踏步 450ms 预备 + 离散步伐 + 250ms 收尾）
- [x] 全局快捷键（Ctrl+Shift+P 切换宠物显示）
- [x] 语音输入（Web Speech API，支持中文，连续识别）
- [x] 更多宠物角色（5 个：镜框小狗 / Clawd 龙虾 / 小黑猫 / 小黄鸟 / 小狐狸）
- [ ] Electron 打包（electron-builder）
- [ ] 宠物窗口始终置底（桌面壁纸层）而非 alwaysOnTop

## 关键 IPC 通道

| 通道 | 方向 | 用途 |
|------|------|------|
| open-chat | renderer→main | 打开聊天窗口 |
| close-chat | renderer→main | 关闭聊天窗口 |
| move-window | renderer→main | 移动宠物窗口 |
| feed-file | renderer→main | 拖放文件喂给 AI |
| read-file-content | renderer→main | 读取文件内容 |
| notify-working | renderer→main | 通知宠物 AI 工作状态 |
| working-state | main→renderer | 宠物接收工作状态 |
| file-fed | main→renderer | 聊天窗口接收喂食文件 |

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

- Product ideas/brainstorming → /office-hours
- Strategy/scope → /plan-ceo-review
- Architecture → /plan-eng-review
- Design system/plan review → /design-consultation or /plan-design-review
- Full review pipeline → /autoplan
- Bugs/errors → /investigate
- QA/testing site behavior → /qa or /qa-only
- Code review/diff check → /review
- Visual polish → /design-review
- Ship/deploy/PR → /ship or /land-and-deploy
- Save progress → /context-save
- Resume context → /context-restore

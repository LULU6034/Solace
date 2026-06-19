# Solace

桌面上的 AI 伙伴。全双工语音对话、多角色协作、记忆系统、音乐播放、文件分析——像朋友一样待在你的任务栏里。

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey)
![Electron](https://img.shields.io/badge/electron-42-9feaf9)
![Vue](https://img.shields.io/badge/vue-3.5-4fc08d)

---

## 功能

### 语音对话
- **全双工语音** — 像打电话一样自然交流，支持打断、停顿、情绪感知
- **TTS 语音合成** — MiniMax 引擎，14 种真实发声标签（笑、叹、喘气…），语速自适应
- **ASR 语音识别** — 支持 DashScope / Deepgram 云端识别
- **多维情绪** — 开心、难过、温柔、鼓励… 语音语调随情绪变化

### 文字聊天
- 多会话管理，历史持久化
- Markdown 渲染、图片粘贴、文件拖放
- 推理过程展示（思维链）
- 工具调用审批

### AI 能力
- **多模型支持** — Claude / DeepSeek / OpenAI 兼容接口
- **多角色协作** — 创建不同人设的 Agent，自由切换
- **知识库** — 向量搜索 + RAG 文档检索，支持 PDF、Office 等格式
- **记忆系统** — 四层记忆（短期/中期/长期/情景），自动提取 + 冲突检测 + 定期巩固
- **工具调用** — 文件读写、命令执行、网页搜索、浏览器自动化

### 音乐
- 网易云音乐集成 — 搜索、推荐、歌单、歌词
- 语音说"放首歌"即可控制
- 迷你播放器，Agent 说话时自动降低音量

### 其他
- 系统托盘常驻，Ctrl+Space 唤起
- 浅色/深色/跟随系统主题
- 自动更新（GitHub Releases）
- 隐私保护 — API Key 用系统密钥链加密存储

---

## 快速开始

### 环境要求

- **Node.js** >= 18
- **Windows** 10 / 11
- **npm** >= 9

### 安装

```bash
git clone https://github.com/LULU6034/Solace.git
cd Solace
npm install
```

### 运行

```bash
npm run dev
```

首次启动后点击左下角齿轮进入设置面板。

### 打包

```bash
npm run electron:build
```

产物在 `release/` 目录。

---

## 配置

应用需要以下 API Key（在设置面板配置，加密存储）：

| Key | 用途 | 获取地址 | 必须 |
|-----|------|---------|------|
| 主模型 Key | LLM 对话（Claude / DeepSeek / OpenAI） | 对应平台 | ✓ |
| 视觉 Key | 图片理解（百炼 Qwen-VL） | [阿里云百炼](https://bailian.console.aliyun.com/) | 可选 |
| 语音 Key | 百炼 CosyVoice 语音合成 | 同上 | 可选 |
| TTS Key | MiniMax TTS 语音合成 | [MiniMax](https://platform.minimaxi.com/) | 推荐 |
| 语音识别 Key | DashScope ASR / Deepgram | 对应平台 | 推荐 |

如果没有配置语音 Key，应用退化为纯文字聊天模式。

---

## 项目结构

```
Solace/
├── electron/           # Electron 主进程
│   ├── main.cjs        # 窗口管理、托盘、IPC
│   ├── preload.cjs     # 安全的 IPC 桥接
│   ├── updater.cjs     # 自动更新
│   └── ipc/            # IPC 模块（LLM、Voice、Agent、Netease）
├── server/             # 服务端逻辑（主进程运行）
│   ├── core/           # Agent 引擎（LLM 客户端、子 Agent、协调器）
│   ├── voice/          # 语音管道（全双工、TTS、ASR、VAD）
│   ├── memory/         # 记忆系统（提取、巩固、注入、向量搜索）
│   ├── knowledge/      # 知识库（嵌入、RAG、图谱）
│   ├── tools/          # 工具集（音乐、浏览器、文件、技能）
│   ├── lib/            # 工具库（配置、日志、睡眠模式）
│   └── prompts/        # 提示词模板
├── src/                # 前端 UI（Vue 3）
│   ├── pages/
│   │   ├── chat/       # 文字聊天页
│   │   ├── voice/      # 语音对话页
│   │   ├── music/      # 音乐面板
│   │   ├── memory/     # 记忆面板
│   │   ├── roles/      # 角色管理
│   │   ├── settings/   # 设置面板
│   │   └── knowledge/  # 知识库面板
│   ├── composables/    # 组合式函数
│   ├── llm/            # LLM Provider
│   └── styles/         # 样式 + 设计 Token
├── plugins-builtin/    # 内置插件
├── skills-builtin/     # 内置技能
├── scripts/            # 构建脚本
└── public/             # 静态资源、图标
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 42 |
| 前端 | Vue 3 + Vite 8 |
| 状态管理 | Zustand |
| 动画 | GSAP + Three.js |
| 样式 | CSS 自定义属性 + 设计 Token |
| 语音 | MiniMax TTS + DashScope ASR + Deepgram |
| 嵌入 | Xenova bge-micro-v2（本地 CPU） |
| 向量 | SQLite + 余弦相似度 |
| 工具 | Playwright 浏览器自动化、Tesseract OCR、Sharp 图像 |
| 文档解析 | pdf-parse + pdfjs + @kreuzberg/node |
| 更新 | electron-updater + GitHub Releases |

---

## 开发

```bash
# 开发模式（热重载）
npm run dev

# 单独启动 Electron（不启动 Vite）
npm run electron:dev

# 构建
npm run build

# 生成图标
npm run gen-icons
```

### 添加新工具

在 `server/tools/` 下创建文件，导出 `{ name, description, parameters, handler }`，然后在 `server/tools/index.js` 注册。

### 添加新技能

在 `skills-builtin/` 下创建 `<skill-name>/SKILL.md`，系统会自动发现。

---

## License

MIT

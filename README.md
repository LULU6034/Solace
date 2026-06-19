# Solace

> A desktop-native AI companion with full-duplex voice, persistent memory, and multi-agent orchestration.

[![Version](https://img.shields.io/badge/version-0.1.0-blue)](package.json)
[![Electron](https://img.shields.io/badge/electron-42-9feaf9)](https://www.electronjs.org/)
[![Vue](https://img.shields.io/badge/vue-3.5-4fc08d)](https://vuejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey)]()

---

## Overview

Solace is a desktop AI companion that lives in your system tray. It supports natural voice conversations, multi-turn text chat, music playback via Netease Cloud Music, and a multi-agent system where each agent has its own personality and memory. It integrates deeply with the OS — drag-and-drop files for analysis, global keyboard shortcuts, and system-level notifications.

**Core design principles:**

- **Privacy-first.** API keys are encrypted with the OS keychain. All inference happens through your own API accounts. No telemetry.
- **Truly conversational.** Full-duplex voice means you can interrupt, pause, and speak naturally. The agent reads emotional cues and adjusts tone accordingly.
- **Memory that works.** A four-tier memory architecture (short-term, medium-term, long-term, episodic) with automatic extraction, conflict detection, and periodic consolidation.
- **Tool-native.** The agent has access to a growing set of tools — file I/O, web search, browser automation, document parsing, and more.

---

## Feature Map

### Voice

| Feature | Description |
|---------|-------------|
| Full-duplex pipeline | Bidirectional streaming via WebSocket; VAD-based turn detection; interruptible playback |
| TTS engine | MiniMax v1 voice synthesis with 14 paralinguistic tags (e.g., `(chuckle)`, `(sighs)`, `(breath)`) |
| ASR | DashScope / Deepgram cloud recognition with real-time partial results |
| Emotion awareness | Multi-dimensional mood model (happy, sad, angry, playful, gentle, encouraging) — affects TTS tone and word choice |
| Adaptive speaking rate | Dynamic speed scaling based on response length (0.85×–0.94×) |
| Music ducking | Automatically lowers music volume during speech |

### Text Chat

| Feature | Description |
|---------|-------------|
| Multi-session | Independent conversation tabs with persistent history |
| Markdown rendering | Full GFM with code blocks, tables, and inline images |
| File drag-and-drop | PDF, images, Office documents — parsed and fed as context |
| Reasoning display | Chain-of-thought visibility for supported models |
| Tool approval gate | User-in-the-loop confirmation for sensitive tool calls |

### AI Engine

| Feature | Description |
|---------|-------------|
| Multi-provider | Claude (Anthropic), DeepSeek, OpenAI-compatible endpoints |
| Multi-agent | Create agents with distinct personalities; switch mid-conversation |
| Knowledge base | Local vector search (bge-micro-v2 embeddings) with RAG retrieval |
| Memory system | Four-layer architecture with auto-extraction, conflict resolution, and merge consolidation |
| Tool system | Extensible plugin architecture — web search, file operations, browser automation, document generation |

### Music

| Feature | Description |
|---------|-------------|
| Netease Cloud Music | Full API integration: search, playlists, recommendations, lyrics |
| Voice control | Natural language music commands ("放首安静的", "下一首") |
| Mini player | Compact overlay with playback controls |

---

## Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Node.js | 18.x | 22 LTS |
| npm | 9.x | 10.x |
| OS | Windows 10 | Windows 11 |
| RAM | 4 GB | 8 GB |

---

## Quick Start

```bash
# Clone
git clone https://github.com/LULU6034/Solace.git
cd Solace

# Install dependencies
npm install

# Start development server (hot reload for UI, restart on main-process changes)
npm run dev
```

The first launch opens a settings panel. Configure at minimum a primary LLM API key before use.

### Production Build

```bash
npm run electron:build
# Output: release/Solace Setup <version>.exe
```

The build includes auto-update support via GitHub Releases. Pushing a new release tag triggers `electron-updater` on all installed clients.

---

## API Key Configuration

All keys are encrypted at rest using Electron's `safeStorage` API (DPAPI on Windows). They never leave your machine.

| Provider | Purpose | Required | Sign-up |
|----------|---------|----------|---------|
| Anthropic / DeepSeek / OpenAI | Primary LLM | **Yes** | [Anthropic Console](https://console.anthropic.com/) · [DeepSeek Platform](https://platform.deepseek.com/) · [OpenAI](https://platform.openai.com/) |
| MiniMax | TTS voice synthesis | Recommended | [MiniMax Platform](https://platform.minimaxi.com/) |
| DashScope (Alibaba) | ASR + CosyVoice TTS | Recommended | [Aliyun Bailian](https://bailian.console.aliyun.com/) |
| Deepgram | Alternative ASR | Optional | [Deepgram](https://deepgram.com/) |
| 百炼 Qwen-VL | Vision (image understanding) | Optional | [Aliyun Bailian](https://bailian.console.aliyun.com/) |

Without TTS/ASR keys, the application falls back to text-only chat mode.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Electron Main Process               │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │  Window  │ │   Tray   │ │   Server (embedded)   │ │
│  │ Manager  │ │ Manager  │ │  ┌─────────────────┐  │ │
│  └──────────┘ └──────────┘ │  │   Agent Engine   │  │ │
│                            │  ├─────────────────┤  │ │
│  ┌──────────────────────┐  │  │  Voice Pipeline  │  │ │
│  │     IPC Bridge       │  │  ├─────────────────┤  │ │
│  │  (contextBridge)     │  │  │  Memory System   │  │ │
│  └──────────────────────┘  │  ├─────────────────┤  │ │
│                            │  │  Knowledge Base  │  │ │
│                            │  ├─────────────────┤  │ │
│                            │  │  Tool Registry   │  │ │
│                            │  └─────────────────┘  │ │
│                            └──────────────────────┘ │
└──────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────┐
│                  Renderer Process (Vue 3)             │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │   Chat   │ │  Voice   │ │       Settings       │ │
│  │   Page   │ │   Page   │ │        Panel         │ │
│  └──────────┘ └──────────┘ └──────────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │  Music   │ │  Memory  │ │       Roles          │ │
│  │  Panel   │ │  Panel   │ │        Page          │ │
│  └──────────┘ └──────────┘ └──────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### Directory Layout

```
Solace/
├── electron/                # Main process
│   ├── main.cjs             # Window creation, tray, lifecycle
│   ├── preload.cjs           # contextBridge API surface
│   ├── updater.cjs           # Auto-update via electron-updater
│   └── ipc/                  # IPC handlers (llm, voice, agent, netease)
├── server/                   # Embedded server (runs in main process)
│   ├── core/                 # Agent loop, LLM client, sub-agent, coordinator
│   ├── voice/                # Full-duplex, TTS, ASR, VAD, circuit breaker
│   ├── memory/               # Extraction, consolidation, injection, vector search
│   ├── knowledge/            # Embedding, chunking, indexing, retrieval
│   ├── tools/                # Music, browser, file, command, skill tools
│   ├── lib/                  # Prompt loader, user profile, sleep mode, logger
│   └── prompts/              # System prompt templates (L1–L4 architecture)
├── src/                      # Renderer process
│   ├── pages/
│   │   ├── chat/ChatPage.vue       # Text conversation
│   │   ├── voice/VoiceChat.vue     # Voice conversation
│   │   ├── music/MusicPanel.vue    # Music browser & controls
│   │   ├── memory/MemoryPanel.vue  # Memory graph & conflict resolution
│   │   ├── roles/RolesPage.vue     # Agent personality management
│   │   ├── settings/SettingsPanel.vue  # Configuration
│   │   └── knowledge/              # Knowledge base management
│   ├── composables/          # useVoice, useFullDuplex, useInstantResponse
│   ├── styles/               # Design tokens, chat styles
│   ├── llm/                  # LLM provider abstraction
│   └── store/                # Zustand stores
├── plugins-builtin/          # Built-in plugins (weather)
├── skills-builtin/           # Built-in skills (markdown)
├── scripts/                  # Build scripts, icon generation
└── public/                   # Static assets, app icons
```

### Memory Architecture

```
User Message
     │
     ▼
┌─────────────┐    ┌─────────────┐    ┌───────────────┐    ┌─────────────┐
│  Short-term │ → │  Medium-term │ → │   Long-term   │ ← │  Episodic   │
│  (session)  │   │  (recent)    │   │  (persistent)  │   │  (events)   │
└─────────────┘    └─────────────┘    └───────────────┘    └─────────────┘
                          │                     │
                          ▼                     ▼
                   ┌─────────────┐     ┌───────────────┐
                   │  Extractor  │     │  Consolidator │
                   │  (per-turn) │     │  (every N turns)│
                   └─────────────┘     └───────────────┘
```

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Application framework | Electron 42 |
| UI framework | Vue 3 (Composition API) |
| Build tooling | Vite 8 |
| State management | Zustand |
| Animation | GSAP, Three.js |
| Styling | CSS custom properties, design tokens |
| Voice synthesis | MiniMax TTS (streaming) |
| Speech recognition | DashScope ASR, Deepgram |
| Embeddings | Xenova bge-micro-v2 (local CPU, 384-dim) |
| Vector store | SQLite + cosine similarity |
| Document parsing | pdf-parse, pdfjs-dist, @kreuzberg/node |
| Browser automation | Playwright + stealth plugin |
| OCR | Tesseract.js |
| Image processing | Sharp |
| Auto-update | electron-updater (GitHub Releases) |

---

## Extending

### Adding a Tool

Create a module in `server/tools/`:

```js
export default {
  name: 'my_tool',
  description: 'What this tool does. Be specific — the LLM reads this.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' }
    },
    required: ['query']
  },
  async handler(args, context) {
    // context has: { config, sendEvent, messages }
    return 'Tool result here';
  }
};
```

Then register it in `server/tools/index.js`.

### Adding a Skill

Create a directory under `skills-builtin/<skill-name>/` with a `SKILL.md` file. The system discovers it automatically on startup. Skills are invoked by the agent via `use_skill` tool.

### Prompt Architecture

The system uses a layered prompt system (L1–L4):

| Layer | File | Purpose |
|-------|------|---------|
| L1 | `prompts/app-guide.txt` | Application context & capabilities |
| L2 | `prompts/tools-guide.txt` | Tool usage rules |
| L3 | Dynamic (agent.js) | Agent personality profile |
| L4 | `prompts/voice.txt` / `default.txt` | Mode-specific behavior rules |

All prompts support `{{AGENT_NAME}}` placeholder replacement.

---

## License

[MIT](LICENSE) © 2026

Solace is distributed under the MIT License — you are free to use, modify, distribute, and sublicense the code for any purpose, commercial or private, provided that the original copyright notice and license text are included in all copies or substantial portions of the software.

The software is provided "as is", without warranty of any kind. See [LICENSE](LICENSE) for the full terms.

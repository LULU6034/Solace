import type { LLMConfig, ChatMessage } from './types';

declare global {
  interface Window {
    electronAPI?: {
      llmInit: (config: LLMConfig) => Promise<{ success: boolean; error?: string }>;
      llmChat: (config: LLMConfig, messages: ChatMessage[]) => void;
      onLlmChunk: (cb: (text: string | null) => void) => () => void;
      onLlmDone: (cb: (result: { content?: string; error?: string }) => void) => () => void;
    };
  }
}

class LLMService {
  private config: LLMConfig | null = null;

  async initialize(config: LLMConfig): Promise<boolean> {
    if (!window.electronAPI?.llmInit) {
      throw new Error('Electron IPC 不可用，请确保在 Electron 环境中运行');
    }
    const result = await window.electronAPI.llmInit(config);
    if (!result.success) {
      throw new Error(result.error || 'LLM 初始化失败');
    }
    this.config = config;
    return true;
  }

  // 直接恢复配置，不做 API 验证（用于启动时自动恢复）
  restore(config: LLMConfig): void {
    this.config = config;
  }

  async chat(
    messages: ChatMessage[],
    onStream: (chunk: string) => void
  ): Promise<string> {
    if (!window.electronAPI) {
      throw new Error('Electron IPC 不可用');
    }
    if (!this.config) {
      throw new Error('LLM 未初始化，请先配置 API Key');
    }

    // 去掉 Vue 响应式 Proxy 包装，IPC 需要纯对象
    const plainMessages = JSON.parse(JSON.stringify(messages));
    console.log('[LLMProvider] 开始聊天, messages:', plainMessages.length);

    const removeChunk = window.electronAPI.onLlmChunk((text) => {
      if (text !== null && text !== undefined) {
        console.log('[LLMProvider] chunk:', text.slice(0, 30));
        onStream(text);
      }
    });

    return new Promise((resolve, reject) => {
      const removeDone = window.electronAPI!.onLlmDone((result) => {
        removeChunk();
        removeDone();
        console.log('[LLMProvider] done, result:', result);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result.content || '');
        }
      });

      console.log('[LLMProvider] 调用 llmChat IPC...');
      window.electronAPI!.llmChat(this.config!, plainMessages);
    });
  }

  isInitialized(): boolean {
    return this.config !== null;
  }
}

// 用 window 全局变量存储单例，绕过 Vite dev 模式下动态 import() 的模块缓存隔离问题
const _key = '__llmService';
const globalInstance = ((window as any)[_key] as LLMService) || new LLMService();
(window as any)[_key] = globalInstance;
export const llmService = globalInstance;

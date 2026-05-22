export type ModelProvider = 'claude' | 'deepseek' | 'openai' | 'custom';

export interface LLMConfig {
  provider: ModelProvider;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMAdapter {
  readonly provider: ModelProvider;
  chat(messages: ChatMessage[], onStream?: (chunk: string) => void): Promise<string>;
  validateConfig(): boolean;
}

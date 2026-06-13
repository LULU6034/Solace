import OpenAI from 'openai';
import type { LLMAdapter, LLMConfig, ChatMessage } from '../types';

export class DeepSeekAdapter implements LLMAdapter {
  readonly provider = 'deepseek' as const;
  private client: OpenAI;
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || 'https://api.deepseek.com/v1',
      dangerouslyAllowBrowser: true,
    });
  }

  validateConfig(): boolean {
    return !!this.config.apiKey;
  }

  async chat(messages: ChatMessage[], onStream?: (chunk: string) => void): Promise<string> {
    const systemMsg = messages.find((m) => m.role === 'system');

    const apiMessages = [
      { role: 'system' as const, content: systemMsg?.content || '你是一个可爱的桌面宠物。' },
      ...messages.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    if (onStream) {
      const stream = await this.client.chat.completions.create({
        model: this.config.model || 'deepseek-chat',
        messages: apiMessages,
        stream: true,
        max_tokens: 4096,
      });

      let fullContent = '';
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || '';
        fullContent += text;
        onStream(text);
      }
      return fullContent;
    } else {
      const response = await this.client.chat.completions.create({
        model: this.config.model || 'deepseek-chat',
        messages: apiMessages,
        max_tokens: 4096,
      });
      return response.choices[0]?.message?.content || '';
    }
  }
}

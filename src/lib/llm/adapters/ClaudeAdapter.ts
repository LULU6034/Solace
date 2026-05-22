import Anthropic from '@anthropic-ai/sdk';
import type { LLMAdapter, LLMConfig, ChatMessage } from '../types';

export class ClaudeAdapter implements LLMAdapter {
  readonly provider = 'claude' as const;
  private client: Anthropic;
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      dangerouslyAllowBrowser: true,
    });
  }

  validateConfig(): boolean {
    return !!this.config.apiKey && !!this.config.model;
  }

  async chat(messages: ChatMessage[], onStream?: (chunk: string) => void): Promise<string> {
    const systemMsg = messages.find((m) => m.role === 'system');
    const chatMessages = messages.filter((m) => m.role !== 'system');

    const system = systemMsg?.content || '你是一个可爱的桌面宠物，陪伴用户工作聊天。回复简洁有活力，偶尔带点小幽默。';

    if (onStream) {
      const stream = await this.client.messages.stream({
        model: this.config.model || 'claude-sonnet-4-20250506',
        max_tokens: 4096,
        system,
        messages: chatMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      });

      let fullContent = '';
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullContent += event.delta.text;
          onStream(event.delta.text);
        }
      }
      return fullContent;
    } else {
      const response = await this.client.messages.create({
        model: this.config.model || 'claude-sonnet-4-20250506',
        max_tokens: 4096,
        system,
        messages: chatMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      });
      return response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    }
  }
}

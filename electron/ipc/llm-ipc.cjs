// LLM IPC 处理器 — 在主进程中原生加载 SDK，通过 IPC 与渲染进程通信
const { ipcMain } = require('electron');

let Anthropic = null;
let OpenAI = null;

function loadSDKs() {
  try { Anthropic = require('@anthropic-ai/sdk').default; } catch (_) { /* optional */ }
  try { OpenAI = require('openai').default; } catch (_) { /* optional */ }
}
loadSDKs();

function createClient(config) {
  switch (config.provider) {
    case 'claude': {
      if (!Anthropic) throw new Error('Anthropic SDK 未安装');
      return new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseUrl || undefined,
      });
    }
    case 'deepseek': {
      if (!OpenAI) throw new Error('OpenAI SDK 未安装');
      return new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl || 'https://api.deepseek.com/v1',
      });
    }
    case 'openai': {
      if (!OpenAI) throw new Error('OpenAI SDK 未安装');
      return new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl || 'https://api.openai.com/v1',
      });
    }
    default:
      throw new Error(`不支持的 provider: ${config.provider}`);
  }
}

async function runChat(webContents, config, messages) {
  const client = createClient(config);
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system');
  const system = systemMsg?.content || '你是一个桌面上的智能助手。回复简洁高效。';

  if (config.provider === 'claude') {
    const stream = await client.messages.stream({
      model: config.model || 'claude-sonnet-4-20250506',
      max_tokens: 4096,
      system,
      messages: chatMessages.map(m => ({ role: m.role, content: m.content })),
    });

    let full = '';
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        full += ev.delta.text;
        webContents.send('llm-chunk', ev.delta.text);
      }
    }
    webContents.send('llm-done', { content: full });
  } else {
    const apiMessages = [
      { role: 'system', content: system },
      ...chatMessages.map(m => ({ role: m.role, content: m.content })),
    ];

    const stream = await client.chat.completions.create({
      model: config.model || (config.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o'),
      messages: apiMessages,
      stream: true,
      max_tokens: 4096,
    });

    let full = '';
    for await (const chunk of stream) {
      const text = chunk.choices?.[0]?.delta?.content || '';
      if (text) {
        full += text;
        webContents.send('llm-chunk', text);
      }
    }
    webContents.send('llm-done', { content: full });
  }
}

// 初始化 — 用 invoke/return 模式（简单请求/响应）
ipcMain.handle('llm-init', async (_event, config) => {
  try {
    const client = createClient(config);
    if (config.provider === 'claude') {
      await client.messages.create({
        model: config.model || 'claude-sonnet-4-20250506',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      });
    } else {
      await client.chat.completions.create({
        model: config.model || (config.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o'),
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
      });
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

// 聊天 — 用纯事件驱动模式（流式输出需要多个事件）
ipcMain.on('llm-chat', (event, { config, messages }) => {
  const wc = event.sender;
  console.log('[llm-ipc] 收到聊天请求, provider:', config.provider, 'messages:', messages?.length);
  runChat(wc, config, messages)
    .then(() => console.log('[llm-ipc] 聊天完成'))
    .catch((err) => {
      console.error('[llm-ipc] 聊天出错:', err);
      wc.send('llm-chunk', null);
      wc.send('llm-done', { error: err.message || String(err) });
    });
});

module.exports = {};

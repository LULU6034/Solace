/**
 * MiniMax 声音克隆
 * 用法: node scripts/clone-voice.mjs <MiniMax API Key> <音频文件路径> [voice_id名称]
 */
import fs from 'fs';
import path from 'path';

const apiKey = process.argv[2];
const audioPath = process.argv[3];
const customVoiceId = process.argv[4] || 'sonder_cloned';

if (!apiKey) {
  console.error('用法: node scripts/clone-voice.mjs <MiniMax API Key> <音频文件路径> [voice_id]');
  process.exit(1);
}

if (!audioPath || !fs.existsSync(audioPath)) {
  console.error(`文件不存在: ${audioPath || '(未指定)'}`);
  process.exit(1);
}

const stats = fs.statSync(audioPath);
const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
console.log(`音频文件: ${audioPath}`);
console.log(`大小: ${fileSizeMB} MB`);
console.log(`目标 voice_id: ${customVoiceId}`);

// 读取音频文件
const audioBuffer = fs.readFileSync(audioPath);

// 步骤 1: 上传音频文件，获取 file_id
console.log('\n步骤 1/2: 上传音频文件...');

const uploadForm = new FormData();
const file = new File([audioBuffer], path.basename(audioPath), { type: 'audio/wav' });
uploadForm.append('file', file);
uploadForm.append('purpose', 'voice_clone');

const uploadRes = await fetch('https://api.minimax.chat/v1/files/upload', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
  },
  body: uploadForm,
});

const uploadJson = await uploadRes.json();
console.log('上传响应:', JSON.stringify(uploadJson, null, 2));

if (uploadJson.base_resp?.status_code !== 0) {
  console.error(`\n❌ 上传失败: ${uploadJson.base_resp?.status_msg || '未知错误'}`);
  process.exit(1);
}

const fileId = uploadJson.file?.file_id || uploadJson.file_id;
console.log(`✅ 上传成功，file_id: ${fileId}`);

// 步骤 2: 用 file_id 克隆声音
console.log('\n步骤 2/2: 创建克隆音色...');

const cloneRes = await fetch('https://api.minimax.chat/v1/voice_clone', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    file_id: Number(fileId),
    voice_id: customVoiceId,
    language: 'zh-CN',
  }),
});

const cloneJson = await cloneRes.json();
console.log('克隆响应:', JSON.stringify(cloneJson, null, 2));

if (cloneJson.base_resp?.status_code === 0) {
  const voiceId = cloneJson.voice_id || customVoiceId;
  console.log(`\n✅ 克隆成功！voice_id: ${voiceId}`);
  console.log(`\n在 electron/voice-ipc.cjs 的 MINIMAX_VOICES 中添加:`);
  console.log(`    cloned: '${voiceId}',  // 自定义克隆音色`);
} else {
  console.error(`\n❌ 克隆失败: ${cloneJson.base_resp?.status_msg || '未知错误'}`);
  console.error('完整响应:', JSON.stringify(cloneJson));
}

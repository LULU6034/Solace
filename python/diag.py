import sys, os, io
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'cosyvoice-src'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'cosyvoice-src', 'third_party', 'Matcha-TTS'))

import torch
import numpy as np
import soundfile as sf
from cosyvoice.cli.cosyvoice import CosyVoice2

model_dir = os.path.join(os.path.dirname(__file__), 'models', 'iic', 'CosyVoice2-0___5B')
tts = CosyVoice2(model_dir=model_dir, load_jit=False, fp16=torch.cuda.is_available())

# CRITICAL: Convert BF16 LLM weights to FP16 for GPU (BF16 causes garbled output)
if torch.cuda.is_available():
    old_llm = tts.model.llm.llm.model
    tts.model.llm.llm.model = old_llm.to(torch.float16)
    print(f'LLM converted: BF16→FP16')
dev = 'cuda' if torch.cuda.is_available() else 'cpu'
print(f'Device: {dev}, fp16: {torch.cuda.is_available()}')

# 1. File sizes
print('--- Model files ---')
for f in ['llm.pt', 'flow.pt', 'hift.pt']:
    p = os.path.join(model_dir, f)
    sz = os.path.getsize(p) if os.path.exists(p) else 0
    print(f'{f}: {sz/1024/1024:.0f} MB')

# 2. Config
print(f'--- Config ---')
print(f'sample_rate: {tts.sample_rate}')
# Check LLM internals
llm = tts.model.llm.llm
model_type = type(llm.model).__name__ if hasattr(llm, 'model') else 'no .model'
print(f'llm type: {type(llm).__name__}')
print(f'llm inner model: {model_type}')
first_w = next(llm.model.parameters()) if hasattr(llm, 'model') else next(llm.parameters())
print(f'llm weight dtype: {first_w.dtype}')
print(f'llm weight device: {first_w.device}')
# Count BF16 params
bf16 = sum(1 for p in llm.model.parameters() if p.dtype == torch.bfloat16) if hasattr(llm, 'model') else 0
fp32 = sum(1 for p in llm.model.parameters() if p.dtype == torch.float32) if hasattr(llm, 'model') else 0
fp16_ct = sum(1 for p in llm.model.parameters() if p.dtype == torch.float16) if hasattr(llm, 'model') else 0
print(f'llm params: BF16={bf16} FP32={fp32} FP16={fp16_ct}')

# 3. Synthesis
prompt_wav = os.path.join(os.path.dirname(__file__), 'cosyvoice-src', 'asset', 'zero_shot_prompt.wav')
prompt_text = '希望你以后能够做的比我还好呦。'
text = '你好世界'
print(f'--- Synthesizing: {text} ---')

for chunk in tts.inference_zero_shot(text, prompt_text, prompt_wav, stream=False):
    a = chunk['tts_speech'].squeeze(0)
    print(f'shape: {list(a.shape)}, max: {a.abs().max():.4f}')

    # Save via soundfile
    audio_np = a.cpu().numpy()
    maxv = max(abs(audio_np.max()), abs(audio_np.min()))
    if maxv > 0.001:
        audio_np = audio_np / maxv * 0.95
    audio_i16 = (audio_np * 32767).astype('int16')
    sf.write('D:/Project/ai-desktop-pet-electron/public/test-official.wav', audio_i16, tts.sample_rate)
    print('Saved test-official.wav')

    # Also check the raw sample values around the middle
    mid = len(audio_i16) // 3
    print(f'Middle 20 samples: {audio_i16[mid:mid+20].tolist()}')

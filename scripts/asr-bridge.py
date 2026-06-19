"""
DashScope 官方 SDK 实时 ASR 桥接
启动: DASHSCOPE_API_KEY=sk-xxx python scripts/asr-bridge.py --port 8765
Node.js 发二进制 PCM → {"type":"finish"} → 收到 {"text":"..."}
"""
import asyncio, websockets, json, argparse, os, sys, numpy as np
import dashscope
from dashscope.audio.asr import Recognition, RecognitionCallback, RecognitionResult

class Callback(RecognitionCallback):
    def __init__(self, ws):
        self.ws = ws
        self.text = ""
    def on_event(self, result: RecognitionResult):
        sentence = result.get_sentence()
        t = sentence.get("text","")
        if t:
            self.text += t
            if RecognitionResult.is_sentence_end(sentence):
                asyncio.ensure_future(self.ws.send(json.dumps({"text": self.text, "emotion": "neutral"})))
                self.text = ""

async def handle(ws, _):
    buf = bytearray()
    recognition = None
    print("[连接]")
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                buf.extend(msg)
                if recognition:
                    recognition.send_audio_frame(msg)
            elif isinstance(msg, str):
                data = json.loads(msg)
                if data.get("type") == "init":
                    dashscope.api_key = data["api_key"]
                    recognition = Recognition(
                        model="paraformer-realtime-v2",
                        format="pcm",
                        sample_rate=16000,
                        callback=Callback(ws),
                    )
                    recognition.start()
                    print("[ASR] 已启动")
                elif data.get("type") == "start":
                    recognition = Recognition(
                        model="paraformer-realtime-v2",
                        format="pcm",
                        sample_rate=16000,
                        callback=Callback(ws),
                    )
                    recognition.start()
                    print("[ASR] 已启动")
                elif data.get("type") == "finish":
                    if recognition:
                        recognition.stop()
                        recognition = None
                    # 兜底：用 HTTP 文件模式
                    if buf and not data.get("text"):
                        import soundfile as sf
                        tmp = f"debug-pcm/sdk-{os.getpid()}.wav"
                        os.makedirs("debug-pcm", exist_ok=True)
                        audio = np.frombuffer(bytes(buf), dtype=np.int16)
                        sf.write(tmp, audio.astype(np.float32)/32768, 16000)
                        from dashscope.audio.asr import Recognition as R
                        r = R(model="paraformer-realtime-v2", format="wav", sample_rate=16000)
                        res = r.call(tmp)
                        if res and res.get_sentence():
                            txt = res.get_sentence().get("text","")
                            print(f"[HTTP] {txt}")
                            await ws.send(json.dumps({"text": txt, "emotion": "neutral"}))
                    buf.clear()
    except Exception as e:
        print(f"[断开] {e}")

async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8765)
    args = p.parse_args()
    print(f"ws://127.0.0.1:{args.port}")
    async with websockets.serve(lambda ws: handle(ws, ""), "127.0.0.1", args.port):
        await asyncio.Future()
asyncio.run(main())

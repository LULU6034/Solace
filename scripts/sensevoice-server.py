"""SenseVoiceSmall 本地 ASR WebSocket — 调试版"""
import asyncio, websockets, json, argparse, os, numpy as np
from funasr import AutoModel

EMOTIONS = ["HAPPY","ANGRY","SAD","NEUTRAL","FEARFUL","DISGUSTED","SURPRISED"]

async def handle(ws, model):
    buf, bcount = [], 0
    print("[连接]")
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                bcount += 1
                buf.append(np.frombuffer(msg, dtype=np.int16))
                if bcount % 10 == 0:
                    print(f"[音频] {bcount}帧, {sum(len(b) for b in buf)*2}字节")
            elif isinstance(msg, str):
                data = json.loads(msg)
                print(f"[命令] {data.get('type')}")
                if data.get("type") == "finish" and buf:
                    audio = np.concatenate(buf)
                    n = len(buf); buf.clear(); bcount = 0
                    print(f"[处理] {n}帧, {len(audio)}samples, range=[{audio.min()},{audio.max()}]")
                    import soundfile as sf
                    os.makedirs("debug-pcm", exist_ok=True)
                    tmp = f"debug-pcm/sv-{os.getpid()}.wav"
                    sf.write(tmp, audio.astype(np.float32)/32768, 16000)
                    result = model.generate(input=tmp, language="zh", use_itn=True)
                    text = ""
                    emotion = "neutral"
                    if result and len(result) > 0:
                        raw = result[0].get("text","")
                        for tag in EMOTIONS:
                            if f"<|{tag}|>" in raw: emotion = tag.lower(); break
                        for tag in EMOTIONS + ["<|zh|>","<|Speech|>"]:
                            raw = raw.replace(f"<|{tag}|>","")
                        text = raw.strip()
                    print(f"[结果] text='{text}' emotion={emotion}")
                    await ws.send(json.dumps({"type":"result","text":text,"emotion":emotion}))
    except Exception as e:
        print(f"[断开] {e}")

async def main():
    p = argparse.ArgumentParser(); p.add_argument("--port",type=int,default=8765)
    args = p.parse_args()
    print("加载模型...")
    model = AutoModel(model="iic/SenseVoiceSmall", device="cpu", disable_update=True)
    print(f"ws://127.0.0.1:{args.port}")
    async with websockets.serve(lambda ws: handle(ws,model), "127.0.0.1", args.port):
        await asyncio.Future()
asyncio.run(main())

"""
CosyVoice API Server — 阿里云百炼 DashScope WebSocket SDK
用法: python cosyvoice-server.py --port 5001
"""
import argparse, io, json, logging, os, sys, time, base64
from flask import Flask, jsonify, request, Response
from dashscope.audio.tts_v2 import SpeechSynthesizer, ResultCallback

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s %(message)s")
log = logging.getLogger("cosyvoice")
app = Flask(__name__)

def get_api_key():
    return os.environ.get('DASHSCOPE_API_KEY', '')

# 音色映射
VOICES = {
    "default_female": "longhan_v3",
    "default_male":   "longxiaoxia",
}

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": "cosyvoice-api"})

@app.route("/tts/generate", methods=["POST"])
def tts_generate():
    data = request.get_json(force=True)
    text = (data.get("text", "") or "").strip()
    if not text: return jsonify({"error": "text is required"}), 400

    api_key = get_api_key()
    if not api_key: return jsonify({"error": "未配置语音合成 API Key。请在设置面板 → 服务商 → 语音合成 Key 中填写 DashScope API Key（从 https://dashscope.console.aliyun.com/apiKey 获取）"}), 400

    voice_id = data.get("voice_id", "default_female")
    voice = VOICES.get(voice_id, "longhan_v3")
    speed = float(data.get("speed", 1.0))

    try:
        import dashscope
        dashscope.api_key = api_key
        t0 = time.time()

        # 流式回调：边生成边输出 ndjson 块
        import queue
        q = queue.Queue()

        class StreamCB(ResultCallback):
            def on_data(self, data):
                q.put(("chunk", data))
            def on_complete(self):
                q.put(("done", None))
            def on_error(self, msg):
                log.error("TTS error: %s", msg)
                q.put(("error", msg))

        def gen():
            synthesizer = SpeechSynthesizer(
                model="cosyvoice-v3-flash",
                voice=voice,
                speech_rate=1.0,
                callback=StreamCB(),
            )
            # 在后台线程调用
            import threading
            threading.Thread(target=lambda: synthesizer.call(text), daemon=True).start()

            while True:
                typ, data = q.get()
                if typ == "chunk":
                    b64 = base64.b64encode(data).decode("utf-8")
                    yield json.dumps({"audio": b64}) + "\n"
                elif typ == "done":
                    elapsed = time.time() - t0
                    log.info("TTS done: %.1fs", elapsed)
                    return
                else:  # error
                    return

        return Response(gen(), mimetype="application/x-ndjson")
    except Exception as e:
        log.error("合成失败: %s", e)
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5001)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()
    log.info("CosyVoice API Server on %s:%s", args.host, args.port)
    app.run(host=args.host, port=args.port, threaded=False)

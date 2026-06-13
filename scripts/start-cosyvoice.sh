#!/bin/bash
# CosyVoice 服务启动脚本
# 用法: bash scripts/start-cosyvoice.sh [--port 5001]

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON_DIR="$SCRIPT_DIR"
PORT=${1:-5001}

CONDA_PYTHON="$HOME/miniconda3/envs/cosyvoice/python.exe"

echo "=== Sonder CosyVoice TTS 服务 ==="

# ── 检查 Python 环境 ──
if [ ! -f "$CONDA_PYTHON" ]; then
  echo "❌ cosyvoice conda 环境未安装，请先运行: bash scripts/setup-cosyvoice.sh"
  exit 1
fi

# ── 检查模型 ──
MODEL_DIR="$PYTHON_DIR/models/iic/CosyVoice2-0___5B"
if [ ! -f "$MODEL_DIR/llm.pt" ]; then
  echo "❌ 模型未找到: $MODEL_DIR"
  echo "  请从 ModelScope 下载: git clone https://www.modelscope.cn/iic/CosyVoice2-0.5B.git $MODEL_DIR"
  exit 1
fi
echo "✅ 模型: $(du -sh "$MODEL_DIR" | cut -f1)"

# ── 检查是否已运行 ──
if curl -s http://127.0.0.1:$PORT/health >/dev/null 2>&1; then
  echo "⚠️  端口 $PORT 已有服务运行"
  curl -s http://127.0.0.1:$PORT/health | head -1
  exit 0
fi

# ── 启动 ──
echo "🚀 启动 CosyVoice 服务 (端口 $PORT)..."
echo "   模型加载中，预计 5-10 秒..."
echo ""

cd "$PYTHON_DIR"
"$CONDA_PYTHON" cosyvoice-server.py --port "$PORT" --host 127.0.0.1

echo ""
echo "服务已停止"

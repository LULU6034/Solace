#!/bin/bash
# CosyVoice 环境一键安装脚本
# 用法: bash scripts/setup-cosyvoice.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON_DIR="$SCRIPT_DIR"

echo "=== Sonder CosyVoice 环境安装 ==="
echo ""

# ── 1. 检查/安装 Miniconda ──
if ! command -v conda &>/dev/null; then
  echo "[1/4] 安装 Miniconda..."
  MINICONDA_EXE="$TMP/Miniconda3-installer.exe"
  if [ ! -f "$MINICONDA_EXE" ]; then
    echo "  下载 Miniconda..."
    curl -L -o "$MINICONDA_EXE" "https://repo.anaconda.com/miniconda/Miniconda3-latest-Windows-x86_64.exe"
  fi
  echo "  静默安装到 %USERPROFILE%/miniconda3 ..."
  "$MINICONDA_EXE" /S /D=%USERPROFILE%\miniconda3
  export PATH="$HOME/miniconda3:$HOME/miniconda3/Scripts:$HOME/miniconda3/bin:$PATH"
  ~/miniconda3/Scripts/conda.exe init bash
  echo "  Miniconda 安装完成"
else
  echo "[1/4] Miniconda 已安装: $(conda --version)"
fi

# ── 2. 创建 cosyvoice 环境 ──
CONDA_PYTHON="$HOME/miniconda3/envs/cosyvoice/python.exe"
if [ -f "$CONDA_PYTHON" ]; then
  echo "[2/4] cosyvoice 环境已存在"
else
  echo "[2/4] 创建 cosyvoice 环境 (Python 3.10)..."
  conda create -n cosyvoice python=3.10 -y
  echo "  环境创建完成"
fi

# ── 3. 安装依赖 ──
echo "[3/4] 安装 Python 依赖..."
COSYVOICE_SRC="$PYTHON_DIR/cosyvoice-src"

# 先装 PyTorch (CPU 版，RTX 3050 4GB 显存太小跑不了 CUDA)
$CONDA_PYTHON -m pip install --upgrade pip
$CONDA_PYTHON -m pip install torch==2.3.1 torchaudio==2.3.1 --index-url https://download.pytorch.org/whl/cpu

# 再装 CosyVoice 核心依赖
$CONDA_PYTHON -m pip install \
  conformer==0.3.2 \
  diffusers==0.29.0 \
  hydra-core==1.3.2 \
  HyperPyYAML==1.2.3 \
  inflect==7.3.1 \
  librosa==0.10.2 \
  lightning==2.2.4 \
  matplotlib==3.7.5 \
  modelscope==1.20.0 \
  networkx==3.1 \
  numpy==1.26.4 \
  omegaconf==2.3.0 \
  onnx==1.16.0 \
  onnxruntime==1.18.0 \
  openai-whisper==20231117 \
  protobuf==4.25 \
  pyarrow==18.1.0 \
  pydantic==2.7.0 \
  pyworld==0.3.4 \
  rich==13.7.1 \
  soundfile==0.12.1 \
  tensorboard==2.14.0 \
  transformers==4.51.3 \
  x-transformers==2.11.24 \
  uvicorn==0.30.0 \
  wetext==0.0.4 \
  wget==3.2 \
  flask

# 安装 CosyVoice 包本身
echo "  安装 CosyVoice 包..."
cd "$COSYVOICE_SRC"
$CONDA_PYTHON -m pip install -e . 2>/dev/null || {
  # 如果 setup.py 不存在，手动添加到 sys.path（sever.py 已处理）
  echo "  CosyVoice 以 PYTHONPATH 方式使用（无需 pip install）"
}

# ── 4. 注册 conda run 快捷方式 ──
echo "[4/4] 完成!"
echo ""
echo "=== 环境就绪 ==="
echo ""
echo "启动 CosyVoice 服务:"
echo "  bash scripts/start-cosyvoice.sh"
echo ""
echo "测试 TTS:"
echo "  curl -X POST http://127.0.0.1:5001/tts/generate \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"text\":\"你好，我是Sonder\",\"emotion\":\"happy\"}' \\"
echo "    --output test.wav"
echo ""

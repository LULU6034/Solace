"""
Voice Feature Extraction — 语音特征提取 (Phase 4)

通过 stdin/stdout JSON 与 Node.js 通信。

输入: 单行 JSON {"wav_path": "..."}
输出: 单行 JSON {"f0_mean": ..., "f0_std": ..., "mfcc": [...], "energy": ..., "duration_s": ...}

依赖: librosa, numpy, soundfile
"""

import json
import sys

import numpy as np
import soundfile as sf


def extract_features(wav_path: str) -> dict:
    """Extract voice features from a WAV file."""
    import librosa

    # Load audio
    y, sr = sf.read(wav_path, dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)  # Mono

    duration = len(y) / sr

    # F0 (pitch) — only if voice is present
    f0 = None
    try:
        f0, voiced_flag, _ = librosa.pyin(
            y,
            fmin=librosa.note_to_hz("C2"),
            fmax=librosa.note_to_hz("C7"),
            sr=sr,
        )
        f0 = f0[~np.isnan(f0)]  # Remove NaN
    except Exception:
        pass

    # MFCC (13 coefficients)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    mfcc_mean = mfcc.mean(axis=1).tolist()

    # Energy (RMS)
    energy = float(np.sqrt(np.mean(y**2)))

    # Spectral centroid (brightness)
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)
    centroid_mean = float(centroid.mean())

    # Zero-crossing rate
    zcr = librosa.feature.zero_crossing_rate(y)
    zcr_mean = float(zcr.mean())

    return {
        "duration_s": round(duration, 2),
        "f0_mean": round(float(f0.mean()), 1) if f0 is not None and len(f0) > 0 else None,
        "f0_std": round(float(f0.std()), 1) if f0 is not None and len(f0) > 0 else None,
        "mfcc_mean": [round(v, 3) for v in mfcc_mean],
        "energy": round(energy, 4),
        "centroid_mean": round(centroid_mean, 1),
        "zcr_mean": round(zcr_mean, 4),
        "sample_rate": sr,
    }


def main():
    line = sys.stdin.readline()
    if not line:
        print(json.dumps({"error": "no input"}))
        sys.exit(1)

    config = json.loads(line)
    wav_path = config.get("wav_path", "")

    try:
        features = extract_features(wav_path)
        print(json.dumps(features))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()

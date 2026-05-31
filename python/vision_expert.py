"""
视觉子 Agent — 固定百炼 Qwen-VL, 独立于主模型
只做一件事: 看图片 → 输出结构化描述 → 喂给主模型
"""

import asyncio
import base64
import hashlib
import io
import json
import re
import time

# 会话级视觉缓存: {image_hash: result_dict}
_vision_cache = {}

VISION_MODEL = "qwen-vl-plus"
VISION_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
MAX_IMAGE_PX = 1344         # 等比缩放目标: 长边不超过此值(API 图片过大会显著增加延迟)
JPEG_QUALITY = 78            # JPEG 压缩质量(越低越快, 78 是人眼感知拐点)
SINGLE_TIMEOUT = 15          # 单张图片分析超时(秒)
PARALLEL_MAX = 5             # 最多并行几张

VISION_SYSTEM_PROMPT = """你是图像分析专家。用中文输出严格的 JSON 格式。

## 分析要求
- summary: 一句话概述这是什么图 (≤40字)
- detail: 展开描述场景、物体、人物、颜色、氛围 (≤200字)
- ocr_text: 图片中所有文字,逐条列出。没有文字则为空数组
- objects: 画面中识别到的物体列表。不确定的标注"疑似:xxx"
- sensitive: 是否检测到身份证号/银行卡号/密码/私钥/手机号/地址/车牌等敏感个人信息。true/false
- quality: 图片质量。可选值: clear / blurry / too_small

## 输出格式 (严格 JSON, 无其他内容)
{
  "summary": "...",
  "detail": "...",
  "ocr_text": ["...", "..."],
  "objects": ["...", "..."],
  "sensitive": false,
  "quality": "clear"
}

## 铁律
- 图片里没有的东西不编造, objects 和 ocr_text 宁可空也不要脑补
- 模糊看不清的用 quality:"blurry", summary 里说明"图片模糊"
- JSON 外不要有任何解释文字"""

SENSITIVE_PATTERNS = [
    (re.compile(r'\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]'), '身份证号'),
    (re.compile(r'\d{16,19}'), '银行卡号'),
    (re.compile(r'1[3-9]\d{9}'), '手机号'),
    (re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'), '邮箱'),
    (re.compile(r'(password|passwd|secret|token|key)\s*[:=]\s*\S+', re.IGNORECASE), '凭据'),
    (re.compile(r'(sk-[A-Za-z0-9]+)'), 'API Key'),
]


# ── 图片预处理 ──

def _preprocess_image(data_url: str) -> str:
    """预处理: GIF→PNG首帧, 等比缩放, JPEG 压缩(大幅减少 API 延迟)"""
    try:
        from PIL import Image
    except ImportError:
        return data_url  # 没装 Pillow 跳过, 原样返回

    try:
        # 解析 data URL
        header, b64 = data_url.split(",", 1)
        raw = base64.b64decode(b64)
        mime = header.split(":")[1].split(";")[0] if ":" in header else "image/png"

        img = Image.open(io.BytesIO(raw))

        # GIF → 取第一帧转 RGBA
        if getattr(img, "is_animated", False) or mime == "image/gif":
            img.seek(0)
            img = img.convert("RGBA")

        # 等比缩放 (始终缩放, 避免大图拖慢 API)
        w, h = img.size
        if max(w, h) > MAX_IMAGE_PX:
            ratio = MAX_IMAGE_PX / max(w, h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

        # RGBA/P → RGB 以支持 JPEG
        if img.mode in ("RGBA", "P", "LA"):
            bg = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode == "P":
                img = img.convert("RGBA")
            if img.mode in ("RGBA", "LA"):
                bg.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else img.split()[1])
            else:
                bg.paste(img)
            img = bg

        # 始终输出 JPEG 以减小体积
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        new_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

        orig_kb = len(raw) / 1024
        new_kb = len(buf.getvalue()) / 1024
        if new_kb < orig_kb * 0.5:
            import sys
            print(f"[vision] 图片压缩: {orig_kb:.0f}KB → {new_kb:.0f}KB ({new_kb/orig_kb*100:.0f}%)", file=sys.stderr)

        return f"data:image/jpeg;base64,{new_b64}"

    except Exception:
        return data_url  # 预处理失败,原样返回


# ── 安全扫描 ──

def _scan_sensitive(text: str) -> list[dict]:
    """扫描视觉输出中的敏感信息"""
    hits = []
    for pattern, label in SENSITIVE_PATTERNS:
        for m in pattern.finditer(text):
            hits.append({
                "type": label,
                "value": m.group()[:20] + ("..." if len(m.group()) > 20 else ""),
            })
    return hits


# ── LLM 工厂 ──

def _get_api_key(config: dict) -> str:
    key = config.get("visionApiKey", "")
    if not key:
        raise ValueError("未配置百炼 API Key，请在设置中填写 visionApiKey")
    return key


def _create_vision_llm(config: dict):
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(
        model=config.get("visionModel", "") or VISION_MODEL,
        api_key=_get_api_key(config),
        base_url=VISION_BASE_URL,
        temperature=config.get("visionTemperature", 0.3),
        max_tokens=config.get("visionMaxTokens", 1024),
    )


# ── 并行分析核心 ──

async def _analyze_single(
    data_url: str,
    user_text: str,
    llm,
    idx: int,
    attempt: int = 1,
) -> dict:
    """分析单张图片,带超时保护 + 一次自动重试(降分辨率)"""
    from langchain_core.messages import HumanMessage, SystemMessage

    processed = _preprocess_image(data_url)
    timeout = SINGLE_TIMEOUT if attempt == 1 else SINGLE_TIMEOUT * 0.6
    max_tokens_req = 1024 if attempt == 1 else 512

    content_blocks = []
    prompt = f"分析第 {idx + 1} 张图片。" if not user_text else f"用户问题: {user_text}\n\n分析第 {idx + 1} 张图片。"
    content_blocks.append({"type": "text", "text": prompt})
    content_blocks.append({"type": "image_url", "image_url": {"url": processed}})

    try:
        import sys
        t_start = time.time()
        print(f"[vision] 图片{idx+1} API调用开始 (attempt={attempt})...", file=sys.stderr)
        response = await asyncio.wait_for(
            asyncio.to_thread(llm.invoke, [
                SystemMessage(content=VISION_SYSTEM_PROMPT),
                HumanMessage(content=content_blocks),
            ]),
            timeout=timeout,
        )
        elapsed = time.time() - t_start
        text = response.content if hasattr(response, 'content') else str(response)
        print(f"[vision] 图片{idx+1} API返回 ({elapsed:.1f}s): {text[:120]}...", file=sys.stderr)

        usage = {}
        if hasattr(response, 'usage_metadata'):
            usage = response.usage_metadata
        elif hasattr(response, 'response_metadata'):
            usage = response.response_metadata.get('token_usage', {})

        return {"idx": idx, "text": text.strip(), "status": "ok", "usage": usage, "retries": attempt - 1}

    except asyncio.TimeoutError:
        if attempt == 1:
            # 重试: 更大压缩
            try:
                from PIL import Image
                header, b64 = data_url.split(",", 1)
                raw = base64.b64decode(b64)
                img = Image.open(io.BytesIO(raw))
                w, h = img.size
                ratio = min(1.0, 800 / max(w, h))
                if ratio < 0.9:
                    img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
                    if img.mode in ("RGBA", "P", "LA"):
                        bg = Image.new("RGB", img.size, (255, 255, 255))
                        if img.mode == "P":
                            img = img.convert("RGBA")
                        if img.mode in ("RGBA", "LA"):
                            bg.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else img.split()[1])
                        else:
                            bg.paste(img)
                        img = bg
                    buf = io.BytesIO()
                    img.save(buf, format="JPEG", quality=55)
                    retry_url = f"data:image/jpeg;base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"
                    return await _analyze_single(retry_url, user_text, llm, idx, attempt=2)
            except Exception:
                pass
        return {"idx": idx, "text": "", "status": "timeout", "usage": {}, "retries": attempt - 1}

    except Exception as e:
        if attempt == 1:
            return await _analyze_single(data_url, user_text, llm, idx, attempt=2)
        return {"idx": idx, "text": str(e), "status": "error", "usage": {}, "retries": attempt - 1}


def _parse_vision_output(text: str) -> dict:
    """解析视觉输出 JSON, 失败则返回纯文本兜底"""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # 尝试正则提取
        m = re.search(r'\{[\s\S]*"summary"[\s\S]*\}', text)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                pass
    return {"summary": text[:80], "detail": text, "ocr_text": [], "objects": [], "sensitive": False, "quality": "clear", "_parse_failed": True}


# ── 对外接口 ──

async def analyze_images(images: list[str], user_text: str, config: dict) -> dict:
    """子 Agent 主入口: 并行分析多张图片

    Returns:
        {
            "summary_text": "给主模型的纯文本摘要",
            "results": [{parsed_json}, ...],       # 结构化结果, 供下游专家消费
            "sensitive_hits": [{type, value}, ...], # 敏感信息命中
            "stats": {elapsed, total_tokens, timeouts, errors, retries}
        }
    """
    if not images:
        return {"summary_text": "", "results": [], "sensitive_hits": [], "stats": {}}

    # 检查缓存
    cache_key = hashlib.sha256((images[0] if len(images)==1 else json.dumps(images)).encode()).hexdigest()[:32]
    if cache_key in _vision_cache:
        cached = _vision_cache[cache_key]
        print(f"[vision] 缓存命中 ({cached['stats']['elapsed']}s 前)", file=sys.stderr)
        return cached

    import sys
    vision_key = config.get("visionApiKey", "") or config.get("apiKey", "")
    print(f"[vision] analyze_images 开始: {len(images)} 张, visionApiKey={vision_key[:8]}... user_text='{user_text[:50]}'", file=sys.stderr)

    llm = _create_vision_llm(config)
    t0 = time.time()

    sem = asyncio.Semaphore(PARALLEL_MAX)

    async def bounded(i, url):
        async with sem:
            return await _analyze_single(url, user_text, llm, i)

    tasks = [bounded(i, url) for i, url in enumerate(images)]
    raw_results = await asyncio.gather(*tasks)
    raw_results.sort(key=lambda r: r["idx"])

    # 诊断日志
    for r in raw_results:
        print(f"[vision] 图片{r['idx']+1}: status={r['status']} text_len={len(r.get('text','') or '')} retries={r.get('retries',0)}",
              file=sys.stderr)

    parts = []
    structured_results = []
    all_sensitive_hits = []
    total_tokens = 0
    timeouts = 0
    errors = 0
    retries = 0

    for r in raw_results:
        if r["status"] == "timeout":
            timeouts += 1
            parts.append(f"[第{r['idx'] + 1}张图片分析超时]")
            structured_results.append({"idx": r["idx"], "status": "timeout"})
            continue
        if r["status"] == "error":
            errors += 1
            parts.append(f"[第{r['idx'] + 1}张图片分析失败: {r['text'][:100]}]")
            structured_results.append({"idx": r["idx"], "status": "error", "error": r["text"][:200]})
            continue

        retries += r.get("retries", 0)
        parsed = _parse_vision_output(r["text"])
        total_tokens += r["usage"].get("total_tokens", 0)

        # 安全扫描
        full_text = json.dumps(parsed, ensure_ascii=False)
        hits = _scan_sensitive(full_text)
        sensitive_level = "none"
        if hits:
            for h in hits:
                h["img_idx"] = r["idx"]
            all_sensitive_hits.extend(hits)
            parsed["_sensitive_scan"] = hits
            # 分级: 身份证/银行卡/凭据 → red, 手机号/邮箱 → yellow
            red_types = {"身份证号", "银行卡号", "凭据", "API Key"}
            yellow_types = {"手机号", "邮箱"}
            if any(h["type"] in red_types for h in hits):
                sensitive_level = "red"
            elif any(h["type"] in yellow_types for h in hits):
                sensitive_level = "yellow"

        parsed["_img_idx"] = r["idx"]
        parsed["_sensitive_level"] = sensitive_level
        structured_results.append(parsed)

        # 纯文本摘要
        if len(images) > 1:
            prefix = f"[图片{r['idx'] + 1}] "
        else:
            prefix = ""

        part = f"{prefix}{parsed.get('summary', '')}\n{parsed.get('detail', '')}"
        if parsed.get("ocr_text"):
            part += f"\n文字: {'; '.join(parsed['ocr_text'][:5])}"
        if parsed.get("quality") == "blurry":
            part += "\n(注意: 此图片较模糊)"
        parts.append(part)

    elapsed = round(time.time() - t0, 1)
    header = f"[图片分析 · {elapsed}s"
    if total_tokens:
        header += f" · {total_tokens} tokens"
    header += "]"

    summary_text = f"{header}\n\n" + "\n\n---\n\n".join(parts)

    if all_sensitive_hits:
        summary_text += f"\n\n⚠️ 检测到敏感信息: {'; '.join(h['type'] for h in all_sensitive_hits[:5])}"
    if timeouts or errors:
        summary_text += f"\n(分析过程中 {timeouts} 张超时, {errors} 张失败, {retries} 次重试)"

    result = {
        "summary_text": summary_text,
        "results": structured_results,
        "sensitive_hits": all_sensitive_hits,
        "stats": {"elapsed": elapsed, "total_tokens": total_tokens, "timeouts": timeouts, "errors": errors, "retries": retries},
    }
    # 存入缓存
    _vision_cache[cache_key] = result
    if len(_vision_cache) > 20:  # 限制缓存大小
        _vision_cache.pop(next(iter(_vision_cache)))
    return result


async def vision_expert_pipeline(
    images: list[str],
    user_text: str,
    config: dict,
    send_event=None,
) -> dict:
    """群聊 coordinator 调用接口 — 返回结构化结果 + 安全分级"""
    if send_event is None:
        send_event = lambda t, d: None

    await send_event("expert_thought", {
        "expert_name": "视觉子Agent (百炼Qwen-VL)",
        "content": f"并行分析 {len(images)} 张图片...",
    })

    try:
        result = await analyze_images(images, user_text, config)

        # 发安全事件
        for hit in result["sensitive_hits"]:
            await send_event("coordinator_info", {
                "content": f"视觉安全: 图片{hit.get('img_idx', '?')+1} 检测到 {hit['type']}",
            })

        # 最高敏感等级决定是否需要确认
        max_level = "green"
        for r in result["results"]:
            lv = r.get("_sensitive_level", "none")
            if lv == "red":
                max_level = "red"
            elif lv == "yellow" and max_level != "red":
                max_level = "yellow"

        await send_event("expert_done", {
            "expert_id": "vision",
            "expert_name": "视觉子Agent",
            "expert_icon": "\U0001F441",
            "expert_color": "#6A9FB5",
            "content": result["summary_text"],
            "sensitive_level": max_level,
            "structured": result["results"],
        })

        return {
            "expert_type": "vision",
            "content": result["summary_text"],
            "sensitive_hits": result["sensitive_hits"],
            "sensitive_level": max_level,
            "structured": result["results"],
            "stats": result["stats"],
            "status": "success",
        }
    except Exception as e:
        await send_event("expert_error", {"expert_id": "vision", "error": str(e)})
        return {"expert_type": "vision", "content": f"视觉子Agent出错: {e}", "status": "error"}

import base64
import json
import os
from langchain_core.tools import tool


@tool
def read_file(file_path: str) -> str:
    """读取文件内容。参数 file_path: 文件的完整路径"""
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        if len(content) > 5000:
            content = content[:5000] + "\n...(内容过长,已截断)"
        return content
    except FileNotFoundError:
        return f"文件不存在: {file_path}"
    except PermissionError:
        return f"没有权限读取文件: {file_path}"
    except Exception as e:
        return f"读取文件出错: {str(e)}"


@tool
def write_file(file_path: str, content: str) -> str:
    """写入内容到文件。参数 file_path: 文件的完整路径, content: 要写入的内容"""
    try:
        os.makedirs(os.path.dirname(file_path) or '.', exist_ok=True)
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        return f"文件已写入: {file_path} ({len(content)} 字符)"
    except PermissionError:
        return f"没有权限写入文件: {file_path}"
    except Exception as e:
        return f"写入文件出错: {str(e)}"


@tool
def read_image(file_path: str) -> str:
    """读取图片文件,获取图片信息。参数 file_path: 图片文件的完整路径。
    支持的格式: PNG, JPG, JPEG, GIF, BMP, WEBP, SVG
    返回图片的 base64 编码和前 200 字符预览,供视觉模型分析。
    SVG 会直接返回文本内容。"""
    import base64

    if not os.path.exists(file_path):
        return f"图片不存在: {file_path}"

    ext = os.path.splitext(file_path)[1].lower()

    # SVG 直接读文本
    if ext == '.svg':
        try:
            with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
                svg_content = f.read(3000)
            return f"[SVG图片] {file_path}\n内容:\n{svg_content}"
        except Exception as e:
            return f"读取 SVG 出错: {str(e)}"

    # 普通图片: base64 编码
    try:
        file_size = os.path.getsize(file_path)
        if file_size > 5 * 1024 * 1024:
            return f"图片过大({file_size / 1024 / 1024:.1f}MB),请压缩后再分析"

        mime_map = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp'}
        mime = mime_map.get(ext, 'image/png')

        with open(file_path, 'rb') as f:
            raw = f.read()
        b64 = base64.b64encode(raw).decode('ascii')
        data_url = f"data:{mime};base64,{b64}"

        return json.dumps({
            "type": "image_analysis_request",
            "file_path": file_path,
            "file_size": file_size,
            "mime_type": mime,
            "data_url": data_url[:100] + "...(base64数据, 请在下一轮对话中引用此图片)",
            "instruction": "请告知用户需要通过粘贴或拖拽图片到对话框来让AI直接分析图片内容。或者使用 read_image 工具返回的 base64 数据。",
        }, ensure_ascii=False)
    except Exception as e:
        return f"读取图片出错: {str(e)}"


@tool
def list_files(directory: str = ".") -> str:
    """列出目录中的文件。参数 directory: 目录路径,默认为当前目录"""
    try:
        items = os.listdir(directory)
        result = []
        for item in sorted(items):
            full_path = os.path.join(directory, item)
            tag = "[DIR]" if os.path.isdir(full_path) else "[FILE]"
            try:
                size = os.path.getsize(full_path)
                if size > 1024 * 1024:
                    size_str = f"{size / (1024*1024):.1f}MB"
                elif size > 1024:
                    size_str = f"{size / 1024:.1f}KB"
                else:
                    size_str = f"{size}B"
            except:
                size_str = "?"
            result.append(f"  {tag} {item} ({size_str})")
        return f"目录 {directory}:\n" + "\n".join(result[:50])
    except FileNotFoundError:
        return f"目录不存在: {directory}"
    except Exception as e:
        return f"列出目录出错: {str(e)}"

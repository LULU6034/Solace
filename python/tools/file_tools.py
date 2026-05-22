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

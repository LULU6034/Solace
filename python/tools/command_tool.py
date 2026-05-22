import subprocess
from langchain_core.tools import tool

COMMAND_NEEDS_APPROVAL = True
COMMAND_TIMEOUT = 30  # 秒
MAX_OUTPUT = 3000

# 危险命令模式（即使用户批准也拒绝执行）
DANGEROUS_PATTERNS = [
    "rm -rf /",
    "rd /s /q C:\\",
    "format ",
    "del /f /s",
    "shutdown",
    "mkfs.",
    "dd if=",
    "> /dev/sda",
]


@tool
def execute_command(command: str) -> str:
    """执行终端命令。参数 command: 要执行的命令字符串。
    此工具需要用户确认后才能执行。
    不支持交互式命令。超时时间为30秒。"""
    # 检测危险命令
    cmd_lower = command.lower()
    for pattern in DANGEROUS_PATTERNS:
        if pattern.lower() in cmd_lower:
            return f"拒绝执行: 命令包含危险模式 '{pattern}'"

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT,
            encoding='utf-8',
            errors='replace',
        )
        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            if output:
                output += "\n[STDERR]\n"
            output += result.stderr
        if not output:
            output = f"命令执行完毕，退出码: {result.returncode}"
        if len(output) > MAX_OUTPUT:
            output = output[:MAX_OUTPUT] + "\n...(输出过长,已截断)"
        return output
    except subprocess.TimeoutExpired:
        return f"命令超时 ({COMMAND_TIMEOUT}秒), 已终止"
    except Exception as e:
        return f"命令执行出错: {str(e)}"

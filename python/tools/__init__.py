from .file_tools import read_file, write_file, list_files
from .command_tool import execute_command, COMMAND_NEEDS_APPROVAL
from .web_tools import web_search, web_fetch
from .memory_tools import remember, recall

def get_all_tools():
    """返回所有可用工具的列表"""
    return [
        web_search,
        web_fetch,
        read_file,
        write_file,
        list_files,
        execute_command,
        remember,
        recall,
    ]

def get_tool_map():
    """返回 {tool_name: tool_instance} 映射"""
    return {t.name: t for t in get_all_tools()}

def tools_needing_approval():
    """返回需要用户确认的工具名集合"""
    return {"execute_command"}

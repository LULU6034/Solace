/**
 * tools/index.js — 工具注册表
 *
 * 14 个工具 (Phase 3: +6 agent tools)
 *   web_search, web_fetch, read_file, write_file, list_files,
 *   read_image, execute_command, remember, recall,
 *   agent_list, channel_read, channel_post, channel_list, dm_send, dm_read
 */
import { webSearch, webFetch } from './web-tools.js';
import { readFile, writeFile, listFiles, readImage } from './file-tools.js';
import { executeCommand } from './command-tool.js';
import { remember, recall, forget, updateMemory, memoryStatus, setKG } from './memory-tools.js';
export { setKG };
import { getAgentTools } from './agent-tools.js';
import { musicTools, setMusicMemoryStore } from '../music/tools.js';

// Re-export from shared module to break circular dependency
export { setMemoryStore, getMemoryStore } from './memory-store-ref.js';
// Expose for music tools
export { setMusicMemoryStore };

const _agentTools = getAgentTools();

export function getAllTools() {
  return [
    webSearch,
    webFetch,
    readFile,
    writeFile,
    listFiles,
    readImage,
    executeCommand,
    remember,
    recall,
    forget,
    updateMemory,
    memoryStatus,
    ..._agentTools,
    ...musicTools,
  ];
}

export function getToolMap() {
  return new Map(getAllTools().map(t => [t.name, t]));
}

export function toolsNeedingApproval() {
  return new Set(['execute_command']);
}

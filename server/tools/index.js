/**
 * tools/index.js — 工具注册表
 *
 *   web_search, web_fetch, read_file, write_file, list_files,
 *   read_image, execute_command, remember, recall,
 *   agent_list, channel_read, channel_post, channel_list, dm_send, dm_read
 *   search_music, recommend_music, play_music, play_similar
 *   search_knowledge, lookup_knowledge
 */
import { webSearch, webFetch } from './web-tools.js';
import { readFile, writeFile, listFiles, readFilePage, readImage } from './file-tools.js';
import { executeCommand } from './command-tool.js';
import { remember, recall, forget, updateMemory, memoryStatus, setKG } from './memory-tools.js';
export { setKG };
import { getAgentTools } from './agent-tools.js';
import { musicTools, setMusicMemoryStore } from './music-tools.js';
import { kbTools } from '../knowledge/tools.js';
import { kbGraphTools } from '../knowledge/graph-tools.js';
import { reminderTools } from './reminder-tool.js';

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
    readFilePage,
    readImage,
    executeCommand,
    remember,
    recall,
    forget,
    updateMemory,
    memoryStatus,
    ..._agentTools,
    ...musicTools,
    ...kbTools,
    ...kbGraphTools,
    ...reminderTools,
  ];
}

export function getToolMap() {
  return new Map(getAllTools().map(t => [t.name, t]));
}

export function toolsNeedingApproval() {
  return new Set(['execute_command']);
}

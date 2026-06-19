/**
 * agent-manager.js — 多 Agent 生命周期管理器
 *
 * 参考 OpenHanako core/agent-manager.js:
 *   - Agent 创建/初始化/切换/删除
 *   - Map<agentId, AgentInstance> 注册表
 *   - 活跃焦点 agent 跟踪
 *   - 切换队列（Promise 链，防竞态）
 *
 * 宠物场景：每个 Agent = 一个桌面宠物角色
 */
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { createModuleLogger } from '../lib/debug-log.js';
import { FactStore } from '../memory/fact-store-sqlite.js';

const log = createModuleLogger('agent-manager');

// Built-in pet characters
const BUILTIN_PETS = ['glassesDog'];

// ── 5 个内置 Agent 定义 ──
const BUILTIN_AGENTS = [
  {
    id: '__builtin_manager__',
    name: '管理者',
    icon: '🎯',
    color: '#4F46E5',
    identity: `我是{{name}}，案中的任务管理者与规划者。我负责接收用户的复杂需求，将其拆解为可执行的子任务，并协调其他专家完成。

我的核心职责：
- **需求分析**：快速理解用户真正想要什么，澄清模糊需求
- **任务拆解**：把大任务分解为有序的小步骤，标注依赖关系
- **资源调度**：判断每个步骤需要哪个专家（研究员/执行者/评审/记忆官）
- **进度把控**：跟踪每步执行状态，及时调整计划

我不直接执行搜索、读写文件或调用工具，我的价值在于"想清楚再行动"。`,
    ishiki: `## 行为风格
- 收到任务后先复述理解，确保和用户对齐
- 用编号列表输出执行计划，每步标注负责人和预估产出
- 计划展示给用户确认后再执行
- 遇到阻塞时主动提出替代方案
- 任务完成后做简短总结

## 限制
- 不亲自执行工具调用，只做规划和调度
- 不要过度拆解简单问题
- 如果用户的需求本身就很简单，直接让对应专家处理，不要强行规划`,
  },
  {
    id: '__builtin_researcher__',
    name: '研究员',
    icon: '🔍',
    color: '#6366F1',
    identity: `我是{{name}}，案中的信息研究员。我擅长从各种来源搜集、整理和验证信息。

我的核心能力：
- **网络搜索**：使用搜索工具查找最新、最相关的信息
- **文件读取**：阅读用户提供的 PDF、Word、Excel、TXT 等文件内容
- **网页抓取**：深入阅读搜索到的网页，提取关键信息
- **图片分析**：识别和理解图片内容
- **信息整理**：将零散信息归纳为结构化的摘要

我追求信息的准确性和全面性，不确定的地方会标注"待验证"。`,
    ishiki: `## 行为风格
- 先明确搜索方向，再动手搜
- 搜索结果用"来源 + 关键信息"格式呈现
- 区分"事实"和"推测"，明确标注信息来源
- 如果搜索结果互相矛盾，指出矛盾点而非武断选一边
- 输出控制在能覆盖关键信息的长度

## 限制
- 不编造信息，找不到就说找不到
- 不分析需要专业资质的内容（医疗/法律建议等）
- 搜索不到时不反复搜，诚实反馈并建议换个方向`,
  },
  {
    id: '__builtin_executor__',
    name: '执行者',
    icon: '⚡',
    color: '#22C55E',
    identity: `我是{{name}}，案中的执行者与内容创作者。我负责把计划变成实际的产出。

我的核心能力：
- **文案写作**：报告、邮件、方案、创意文案等各类文本
- **代码编写**：根据需求编写、解释、调试代码
- **文件操作**：创建、修改、保存文件
- **数据计算**：处理数值计算、逻辑推理
- **格式转换**：在不同格式之间转换内容

我追求高质量的产出——代码要能跑、文案要能直接用。`,
    ishiki: `## 行为风格
- 产出前先确认输入信息完整（依赖研究员提供的数据）
- 代码用 markdown 代码块，标注语言
- 文案直接给成品，不写"这是给你的文案"之类的废话
- 遇到可以用多种方式实现的情况，选最简洁那种
- 如果输入不足以完成高质量产出，主动要求补充信息

## 限制
- 不执行危险操作（删除文件、修改系统配置等）
- 代码不包含安全漏洞，不使用废弃的 API
- 不代替用户做重要决策，给出选项让用户选`,
  },
  {
    id: '__builtin_reviewer__',
    name: '评审',
    icon: '🔬',
    color: '#F59E0B',
    identity: `我是{{name}}，案中的质量评审与编辑。我的职责是在内容交付给用户之前做最后的把关。

我的核心能力：
- **事实核查**：验证关键信息是否准确，标注可疑之处
- **逻辑审查**：检查推理是否有漏洞、数据是否自洽
- **格式检查**：确保输出符合用户要求的格式
- **文风统一**：确保团队的产出风格一致
- **改进建议**：不只挑毛病，还给出具体的修改方向

我是一个严格的把关者，但我的目标不是否定，而是让产出更好。`,
    ishiki: `## 行为风格
- 评审结论放在最前面：通过 / 有 n 处需修改 / 需要重做
- 每个问题标注严重程度：🔴阻塞 / 🟡建议 / 🔵 可忽略
- 指出问题时附带"建议改成"而非只写"这里不对"
- 如果整体质量好，先肯定再提优化建议
- 不要吹毛求疵——小的格式差异如果用户没要求就别提

## 限制
- 不修改内容本身，只做评审
- 不确定的事实不要断言为错误，标注"建议核实"
- 最多提 3-5 个最重要的改进点，不要列一堆小问题`,
  },
  {
    id: '__builtin_memory_keeper__',
    name: '记忆官',
    icon: '🧠',
    color: '#8B5CF6',
    identity: `我是{{name}}，案中的记忆与知识管理者。我负责维护用户的长期记忆和偏好，在不同会话之间保持连续性。

我的核心能力：
- **偏好记忆**：记住用户的习惯、偏好、常用设置
- **知识检索**：从历史对话中提取相关信息
- **背景补充**：在其他专家工作前，先提供相关的历史背景
- **记忆整理**：定期清理过时信息，更新偏好变化

我在讨论模式中保持低调——只在其他专家需要历史信息时被动提供。在协作模式中，我在研究开始前主动检索相关背景。`,
    ishiki: `## 行为风格
- 被调用时简洁输出相关信息，格式："📋 已知背景: ..."
- 区分"确定的事实"和"推断的偏好"，前者不标注后者标注
- 记忆随时间可能过时，标注信息的时间
- 用户明确说"忘了这件事"时，不再提起
- 敏感信息（密码、证件号等）绝不存储

## 限制
- 不在没有被调用的情况下主动发言
- 不确定的记忆标注"可能已过时"
- 不要基于推测给其他专家下达指令`,
  },
];

const DEFAULT_IDENTITY = `我是{{name}}，案中的一个智能助手。我知识渊博、响应迅速，能帮用户解决各种问题——日常咨询、技术难题、文件分析、网络搜索，样样都行。说话简洁高效，但也不失温度。`;

const DEFAULT_ISHIKI = `## 行为风格
- 用干练专业的语气说话
- 先给结论，再展开解释
- 不确定的事情诚实说"让我查一下"
- 主动记住用户的偏好和习惯
- 中文为主，代码用英文

## 限制
- 不要假装拥有你实际没有的能力
- 如果不会做某事，诚实说不会，但可以建议其他方法`;

// ── Agent Instance ──

class AgentInstance {
  constructor({ id, name, config, identity, ishiki, agentDir, isBuiltin = false, icon = '', color = '' }) {
    this.id = id;
    this.name = name;
    this.config = config || {};
    this.identity = identity || '';
    this.ishiki = ishiki || '';
    this.agentDir = agentDir;
    this.isBuiltin = isBuiltin;
    this.icon = icon;
    this.color = color;
    this.factStore = null;
    this.enabledSkills = new Set();
    this._systemPrompt = '';
    this._initialized = false;
    this.createdAt = Date.now();
  }

  async init() {
    if (this._initialized) return;
    fs.mkdirSync(this.agentDir, { recursive: true });

    // Per-agent memory
    this.factStore = new FactStore(path.join(this.agentDir, 'memory'));

    // Build system prompt
    this._systemPrompt = this._buildSystemPrompt();

    this._initialized = true;
    log.log(`Agent 初始化完成: ${this.name} (${this.id.slice(0, 8)})`);
  }

  _buildSystemPrompt() {
    const identity = this.identity.replace('{{userName}}', '主人');
    const parts = [
      identity,
      '',
      this.ishiki || DEFAULT_ISHIKI,
      '',
      `[当前时间: ${new Date().toLocaleString('zh-CN')}]`,
    ];
    return parts.join('\n');
  }

  get systemPrompt() {
    return this._systemPrompt;
  }

  /** Inject personality into conversation messages */
  injectPersonality(messages) {
    const sysPrompt = this._systemPrompt;
    // Prepend identity as system message
    return [
      { role: 'system', content: sysPrompt },
      ...messages.filter(m => m.role !== 'system'),
    ];
  }
}

// ── AgentManager ──

export class AgentManager {
  constructor({ agentsDir, memoryStore, ragPipeline }) {
    this.agentsDir = agentsDir;
    this.memoryStore = memoryStore;
    this.ragPipeline = ragPipeline;

    /** @type {Map<string, AgentInstance>} */
    this._agents = new Map();
    this._activeAgentId = null;
    this._switchQueue = Promise.resolve(); // 切换互斥
  }

  /**
   * Create a new agent
   */
  async createAgent({ name, character = 'glassesDog', config = {}, identity = '', ishiki = '', isBuiltin = false, icon = '', color = '', fixedId = '' }) {
    const id = fixedId || uuidv4();
    const agentDir = path.join(this.agentsDir, id);

    // Load built-in character template if not custom
    if (!identity && BUILTIN_PETS.includes(character)) {
      identity = await this._loadCharacterIdentity(character, name);
    }
    if (!ishiki && BUILTIN_PETS.includes(character)) {
      ishiki = await this._loadCharacterIshiki(character);
    }

    const finalIdentity = identity || DEFAULT_IDENTITY.replace('{{name}}', name);
    const finalIshiki = ishiki || DEFAULT_ISHIKI;

    const agent = new AgentInstance({
      id, name, config, identity: finalIdentity, ishiki: finalIshiki, agentDir, isBuiltin, icon, color,
    });

    await agent.init();
    this._agents.set(id, agent);

    // Auto-activate first agent
    if (!this._activeAgentId) {
      this._activeAgentId = id;
    }

    log.log(`创建 Agent: ${name} (${isBuiltin ? '内置' : character}) [${id.slice(0, 8)}]`);
    return agent;
  }

  /**
   * Initialize built-in agents if they don't exist yet
   */
  async initBuiltinAgents() {
    for (const def of BUILTIN_AGENTS) {
      if (this._agents.has(def.id)) {
        // Already exists — update name if user renamed it (skip)
        log.log(`内置 Agent 已存在: ${def.name}`);
        continue;
      }
      await this.createAgent({
        name: def.name,
        config: { provider: 'claude', model: 'claude-sonnet-4-20250506' },
        identity: def.identity.replace('{{name}}', def.name),
        ishiki: def.ishiki,
        isBuiltin: true,
        icon: def.icon,
        color: def.color,
        fixedId: def.id,
      });
      log.log(`初始化内置 Agent: ${def.name}`);
    }
    // If the previously active agent is gone, default to manager
    if (!this._activeAgentId || !this._agents.has(this._activeAgentId)) {
      this._activeAgentId = BUILTIN_AGENTS[0].id;
    }
  }

  /**
   * Switch active agent
   */
  async switchAgent(agentId) {
    if (!this._agents.has(agentId)) {
      throw new Error(`Agent 不存在: ${agentId}`);
    }

    // Queue switch to prevent race conditions
    this._switchQueue = this._switchQueue.then(() => {
      this._activeAgentId = agentId;
      log.log(`切换 Agent: ${this._agents.get(agentId)?.name}`);
    }).catch((e) => { log.warn('操作失败', e?.message || e); });

    await this._switchQueue;
    return this.getActiveAgent();
  }

  /**
   * Delete an agent
   */
  async deleteAgent(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) throw new Error(`Agent 不存在: ${agentId}`);

    // Built-in agents cannot be deleted
    if (agent.isBuiltin) {
      throw new Error('内置 Agent 不可删除');
    }

    // Can't delete if it's the only agent
    if (this._agents.size === 1) {
      throw new Error('不能删除最后一个 Agent');
    }

    // Switch away if active
    if (this._activeAgentId === agentId) {
      const other = [...this._agents.keys()].find(k => k !== agentId);
      this._activeAgentId = other;
    }

    // Close fact store
    agent.factStore?.close();

    // Remove agent directory
    try {
      fs.rmSync(agent.agentDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`删除 agent 目录失败: ${err.message}`);
    }

    this._agents.delete(agentId);
    log.log(`删除 Agent: ${agent.name}`);
    return true;
  }

  /**
   * Get active agent
   */
  getActiveAgent() {
    if (!this._activeAgentId) return null;
    return this._agents.get(this._activeAgentId) || null;
  }

  /**
   * Get agent by ID
   */
  getAgent(agentId) {
    return this._agents.get(agentId) || null;
  }

  /**
   * List all agents
   */
  listAgents() {
    return [...this._agents.values()].map(a => ({
      id: a.id,
      name: a.name,
      config: { provider: a.config.provider, model: a.config.model },
      memoryCount: a.factStore?.count() || 0,
      isActive: a.id === this._activeAgentId,
      isBuiltin: a.isBuiltin,
      icon: a.icon,
      color: a.color,
      createdAt: a.createdAt,
    }));
  }

  get activeAgentId() {
    return this._activeAgentId;
  }

  get agentCount() {
    return this._agents.size;
  }

  /**
   * Update an agent's identity/ishiki at runtime and persist to character file
   */
  updateAgentPersonality(agentId, { identity, ishiki }) {
    const agent = this._agents.get(agentId);
    if (!agent) throw new Error(`Agent 不存在: ${agentId}`);

    if (identity != null) {
      agent.identity = identity;
      // Write back to character file
      try {
        const charFile = path.join(this.agentsDir, '..', 'characters', 'glassesDog.identity.md');
        fs.mkdirSync(path.dirname(charFile), { recursive: true });
        fs.writeFileSync(charFile, identity, 'utf-8');
      } catch (err) { log.warn(`写入 identity 文件失败: ${err.message}`); }
    }

    if (ishiki != null) {
      agent.ishiki = ishiki;
      try {
        const charFile = path.join(this.agentsDir, '..', 'characters', 'glassesDog.ishiki.md');
        fs.mkdirSync(path.dirname(charFile), { recursive: true });
        fs.writeFileSync(charFile, ishiki, 'utf-8');
      } catch (err) { log.warn(`写入 ishiki 文件失败: ${err.message}`); }
    }

    // Rebuild system prompt
    agent._systemPrompt = agent._buildSystemPrompt();
    log.log(`更新人格: ${agent.name} (${agentId.slice(0, 8)})`);
  }

  /**
   * Toggle shared memory: when enabled, all agents use the global memory store
   */
  _setSharedMemory(enabled) {
    this._sharedMemory = !!enabled;
    if (enabled) {
      // All agents use the global memory store
      for (const agent of this._agents.values()) {
        agent._sharedFactStore = this.memoryStore;
      }
    } else {
      // Each agent uses its own fact store again
      for (const agent of this._agents.values()) {
        agent._sharedFactStore = null;
      }
    }
    log.log(`共享记忆: ${enabled ? '开启' : '关闭'}`);
  }

  /** Get the effective memory store for an agent */
  _getEffectiveStore(agent) {
    if (this._sharedMemory && this.memoryStore) return this.memoryStore;
    return agent.factStore;
  }

  // ── Character templates ──

  async _loadCharacterIdentity(character, name) {
    const filePath = path.join(this.agentsDir, '..', 'characters', `${character}.identity.md`);
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8').replace('{{name}}', name);
      }
    } catch (e) { log.warn('操作失败', e?.message || e); }
    // Built-in fallback
    if (character === 'glassesDog') {
      return `我是${name}，案中的一个智能助手。知识渊博、响应迅速，能帮你解决日常咨询、技术难题、文件分析、网络搜索等各种问题。`;
    }
    return DEFAULT_IDENTITY.replace('%s', name).replace('%s', '温暖活泼');
  }

  async _loadCharacterIshiki(character) {
    const filePath = path.join(this.agentsDir, '..', 'characters', `${character}.ishiki.md`);
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
    } catch (e) { log.warn('操作失败', e?.message || e); }

    if (character === 'glassesDog') {
      return `## 行为风格\n- 用干练专业的语气说话\n- 先给结论，再展开解释\n- 不确定的事情诚实说"让我查一下"\n- 主动记住用户的偏好和习惯\n- 中文为主，代码用英文`;
    }
    return DEFAULT_ISHIKI;
  }
}

// 模块级单例，供其他模块获取已初始化的 AgentManager
let _agentManagerInstance = null;
export function setAgentManager(instance) { _agentManagerInstance = instance; }
export function getAgentManager() { return _agentManagerInstance; }

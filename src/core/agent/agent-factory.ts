/**
 * AgentFactory — Agent 实例创建/配置/销毁 + 并发控制。
 *
 * 参考 SYSTEM_DESIGN.md 3.3.2 AgentFactory 设计。
 * 全局并发限制 MAX_SUB_AGENTS=5，同类任务并发限制 MAX_SUB_AGENTS_PER_TYPE=1。
 */

import type { Tool, ToolUseContext, CanUseToolFn } from "../../interfaces/tool";
import type { LLMProvider } from "../../interfaces/llm-provider";
import type { SubAgent, SubAgentConfig } from "./sub-agent";
import { createSubAgent } from "./sub-agent";
import { filterToolsForAgent, type ToolFilterConfig, type AgentRole } from "./tool-filter";

// ─── 常量 ───

const MAX_SUB_AGENTS = 5;
const MAX_SUB_AGENTS_PER_TYPE = 1;

// ─── Agent 工厂配置 ───

export interface AgentFactoryConfig {
  readonly provider: LLMProvider;
  readonly tools: ReadonlyArray<Tool>;
  readonly canUseTool: CanUseToolFn;
  readonly toolUseContext: ToolUseContext;
  readonly maxConcurrentAgents?: number;
  readonly maxPerType?: number;
  readonly defaultMaxTurns?: number;
  readonly defaultTokenBudget?: number;
  readonly abortSignal?: AbortSignal;
}

// ─── Agent 创建请求 ───

export interface AgentCreateRequest {
  readonly taskId: string;
  readonly taskType: string;
  readonly description: string;
  readonly tools?: readonly string[];
  readonly systemPrompt?: string;
  readonly maxTurns?: number;
  readonly tokenBudget?: number;
  readonly isAsync?: boolean;
  readonly toolFilterConfig?: ToolFilterConfig;
  /** Agent 角色（自动应用角色工具白名单） */
  readonly role?: AgentRole;
}

// ─── AgentFactory ───

export interface AgentFactory {
  createAgent(request: AgentCreateRequest): SubAgent;
  destroyAgent(agentId: string): void;
  destroyAllAgents(): void;
  getActiveAgents(): readonly SubAgent[];
  getActiveCount(): number;
  getActiveCountByType(): ReadonlyMap<string, number>;
  getMaxConcurrent(): number;
}

// ─── 创建 AgentFactory ───

export function createAgentFactory(
  config: AgentFactoryConfig,
): AgentFactory {
  const maxConcurrent = config.maxConcurrentAgents ?? MAX_SUB_AGENTS;
  const maxPerType = config.maxPerType ?? MAX_SUB_AGENTS_PER_TYPE;

  const agents = new Map<string, SubAgent>();
  const agentTypes = new Map<string, number>();

  function getActiveCount(): number {
    return agents.size;
  }

  function getActiveCountByType(): ReadonlyMap<string, number> {
    return agentTypes;
  }

  function createAgent(request: AgentCreateRequest): SubAgent {
    // 并发控制检查
    if (agents.size >= maxConcurrent) {
      throw new Error(
        `Max concurrent agents reached (${maxConcurrent}). Cannot create agent for task "${request.taskId}".`,
      );
    }

    // 同类任务并发检查
    const typeCount = agentTypes.get(request.taskType) ?? 0;
    if (typeCount >= maxPerType) {
      throw new Error(
        `Max concurrent agents for type "${request.taskType}" reached (${maxPerType}).`,
      );
    }

    // 工具过滤
    const filterConfig: ToolFilterConfig = {
      isBuiltIn: false,
      isAsync: request.isAsync ?? false,
      ...(request.role !== undefined ? { role: request.role } : {}),
      ...(request.toolFilterConfig ?? {}),
    };

    // 如果请求指定了工具白名单，添加到过滤配置
    if (request.tools && request.tools.length > 0) {
      (filterConfig as Record<string, unknown>).whitelist = new Set(request.tools);
    }

    const filterResult = filterToolsForAgent(config.tools, filterConfig);
    const taskTools = filterResult.tools;

    // 构建 SubAgent 配置
    const agentId = `agent-${request.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const subAgentConfig: SubAgentConfig = {
      agentId,
      taskId: request.taskId,
      taskType: request.taskType,
      parentAgentId: "factory",
      systemPrompt: request.systemPrompt ?? buildDefaultSystemPrompt(request),
      tools: taskTools,
      provider: config.provider,
      canUseTool: config.canUseTool,
      toolUseContext: config.toolUseContext,
      maxTurns: request.maxTurns ?? config.defaultMaxTurns ?? 20,
      tokenBudget: request.tokenBudget ?? config.defaultTokenBudget ?? 50000,
      ...(config.abortSignal !== undefined ? { abortSignal: config.abortSignal } : {}),
    };

    const agent = createSubAgent(subAgentConfig);
    agents.set(agentId, agent);
    agentTypes.set(request.taskType, typeCount + 1);

    return agent;
  }

  function destroyAgent(agentId: string): void {
    const agent = agents.get(agentId);
    if (agent !== undefined) {
      agents.delete(agentId);
      const type = agent.taskType;
      if (type !== undefined) {
        const count = agentTypes.get(type);
        if (count !== undefined && count > 0) {
          if (count === 1) {
            agentTypes.delete(type);
          } else {
            agentTypes.set(type, count - 1);
          }
        }
      }
    }
  }

  function destroyAllAgents(): void {
    for (const id of agents.keys()) {
      destroyAgent(id);
    }
  }

  function getActiveAgents(): readonly SubAgent[] {
    return Array.from(agents.values());
  }

  return {
    createAgent,
    destroyAgent,
    destroyAllAgents,
    getActiveAgents,
    getActiveCount,
    getActiveCountByType,
    getMaxConcurrent: () => maxConcurrent,
  };
}

// ─── 辅助函数 ───

function buildDefaultSystemPrompt(request: AgentCreateRequest): string {
  const platform = process.platform;
  const cwd = process.cwd();
  const osName = platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux";
  const shell = platform === "win32" ? "cmd.exe / PowerShell" : "bash";
  const windowsNote = platform === "win32"
    ? "\n- Use Windows-compatible commands (e.g., 'dir' not 'ls', backslash paths)."
    : "";

  return `You are a task-execution sub-agent. Your job is to COMPLETE the assigned task by USING TOOLS, not by describing what you would do.

## Critical Rules
1. You MUST use tools (file_write, file_read, file_edit, bash, glob) to accomplish the task.
2. Do NOT stop after reading a file — if the task requires writing, you MUST call file_write next.
3. Do NOT output a text summary instead of executing tool calls. Text-only responses are considered FAILURES.
4. Continue calling tools until the task is fully done. Only stop when all deliverables are produced.
5. If you need to write code to a file, use file_write with the COMPLETE file content — do not summarize or truncate.

## Environment
- OS: ${osName} | Shell: ${shell} | CWD: ${cwd}${windowsNote}

## Your Task
${request.description}

## Completion Criteria
The task is complete ONLY when all required files have been written or all required commands have been executed. A text description of what should be done is NOT completion.`;
}

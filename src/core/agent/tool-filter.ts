/**
 * filterToolsForAgent — 子 Agent 工具过滤管道。
 *
 * 多层过滤策略：MCP 放行 → 全局禁止 → 自定义禁止 → 异步白名单 → 上下文过滤。
 * 参考 `代码片段_Agent核心循环与编排.md` 片段 #10。
 */

import type { Tool } from "../../interfaces/tool";

// ─── 过滤配置 ───

export interface ToolFilterConfig {
  /** 是否为内置 Agent（内置 Agent 有更少限制） */
  readonly isBuiltIn?: boolean;

  /** 是否为异步 Agent（后台运行，限制更多） */
  readonly isAsync?: boolean;

  /** Plan Mode：只允许只读工具（file_read/glob） */
  readonly planMode?: boolean;

  /** Agent 角色（自动应用角色工具白名单） */
  readonly role?: AgentRole;

  /** 全局禁止列表 */
  readonly globalDisallowed?: ReadonlySet<string>;

  /** 自定义 Agent 禁止列表（仅非内置 Agent 生效） */
  readonly customDisallowed?: ReadonlySet<string>;

  /** 异步 Agent 允许列表（白名单模式） */
  readonly asyncAllowed?: ReadonlySet<string>;

  /** MCP 工具前缀 */
  readonly mcpPrefix?: string;

  /** 工具名白名单（可选，覆盖其他过滤） */
  readonly whitelist?: ReadonlySet<string>;

  /** 工具名黑名单（可选，最终黑名单） */
  readonly blacklist?: ReadonlySet<string>;
}

// ─── 过滤结果 ───

export interface ToolFilterResult {
  readonly tools: readonly Tool[];
  readonly filtered: readonly string[];
  readonly reasons: ReadonlyMap<string, string>;
}

// ─── 默认禁止列表 ───

/** 全局禁止子 Agent 使用的工具（防止递归调用 AgentTool） */
const DEFAULT_GLOBAL_DISALLOWED = new Set<string>([
  "agent",
  "agent_tool",
  "spawn_agent",
  "orchestrator",
]);

/** 非内置 Agent 额外禁止的工具 */
const DEFAULT_CUSTOM_DISALLOWED = new Set<string>([
  "config_set",
  "config_get",
  "plugin_install",
  "plugin_uninstall",
]);

/** 异步 Agent 允许的工具白名单 */
const DEFAULT_ASYNC_ALLOWED = new Set<string>([
  "bash",
  "file_read",
  "file_write",
  "file_edit",
  "glob",
  ]);

/** Plan Mode 只读工具白名单 */
const PLAN_MODE_READONLY_TOOLS = new Set<string>([
  "file_read",
  "glob",
  ]);

// ─── Agent 角色工具映射 ───

/** Agent 角色类型 */
export type AgentRole = "reviewer" | "debugger" | "refactorer" | "tester" | "full";

/** 角色到工具的映射（最小权限原则） */
export const ROLE_TOOL_MAP: Readonly<Record<AgentRole, readonly string[]>> = {
  reviewer: ["file_read", "glob"],
  debugger: ["file_read", "glob", "bash"],
  refactorer: ["file_read", "file_write", "file_edit", "bash", "glob"],
  tester: ["file_read", "bash", "glob"],
  full: [], // 空数组表示不过滤（使用全部可用工具）
};

/** 根据角色获取工具白名单 Set */
export function getRoleToolWhitelist(role: AgentRole): ReadonlySet<string> | undefined {
  const tools = ROLE_TOOL_MAP[role];
  if (tools.length === 0) return undefined;
  return new Set(tools);
}

/** 角色描述 */
export const ROLE_DESCRIPTIONS: Readonly<Record<AgentRole, string>> = {
  reviewer: "只读代码审查（read/glob）",
  debugger: "调试诊断（read/glob/bash）",
  refactorer: "代码重构（read/write/edit/bash/glob）",
  tester: "测试执行（read/bash/glob）",
  full: "完全访问（全部工具）",
};

// ─── 工具使用审计 ───

/** 单次工具使用记录 */
export interface ToolUseAuditEntry {
  readonly agentId: string;
  readonly toolName: string;
  readonly timestamp: number;
  readonly allowed: boolean;
  readonly role?: AgentRole;
}

/** 工具使用审计器 */
export class ToolUseAuditor {
  private readonly entries: ToolUseAuditEntry[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  record(entry: ToolUseAuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
  }

  getEntries(): readonly ToolUseAuditEntry[] {
    return this.entries;
  }

  getByAgent(agentId: string): readonly ToolUseAuditEntry[] {
    return this.entries.filter((e) => e.agentId === agentId);
  }

  getDeniedCount(): number {
    return this.entries.filter((e) => !e.allowed).length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

// ─── 过滤函数 ───

/**
 * filterToolsForAgent — 多层工具过滤管道。
 *
 * 过滤层级：
 * 1. 白名单模式（如果指定了 whitelist，只保留白名单中的工具）
 * 2. MCP 工具始终放行
 * 3. 全局禁止列表
 * 4. 自定义 Agent 禁止列表（仅非内置 Agent）
 * 5. 异步 Agent 白名单
 * 6. 黑名单过滤
 */
export function filterToolsForAgent(
  tools: ReadonlyArray<Tool>,
  config?: ToolFilterConfig,
): ToolFilterResult {
  const isBuiltIn = config?.isBuiltIn ?? false;
  const isAsync = config?.isAsync ?? false;
  const planMode = config?.planMode ?? false;
  const mcpPrefix = config?.mcpPrefix ?? "mcp__";

  const globalDisallowed = config?.globalDisallowed ?? DEFAULT_GLOBAL_DISALLOWED;
  const customDisallowed = config?.customDisallowed ?? DEFAULT_CUSTOM_DISALLOWED;
  const asyncAllowed = config?.asyncAllowed ?? DEFAULT_ASYNC_ALLOWED;

  const whitelist = config?.whitelist ?? getRoleToolWhitelist(config?.role ?? "full");
  const blacklist = config?.blacklist;

  const filtered: Tool[] = [];
  const filteredNames: string[] = [];
  const reasons = new Map<string, string>();

  for (const tool of tools) {
    const name = tool.name;

    // 1. 白名单模式
    if (whitelist !== undefined && whitelist.size > 0) {
      if (!whitelist.has(name)) {
        filteredNames.push(name);
        reasons.set(name, "not_in_whitelist");
        continue;
      }
    }

    // 2. Plan Mode：只允许只读工具
    if (planMode && !PLAN_MODE_READONLY_TOOLS.has(name)) {
      filteredNames.push(name);
      reasons.set(name, "plan_mode_readonly");
      continue;
    }

    // 3. MCP 工具始终放行
    if (name.startsWith(mcpPrefix)) {
      filtered.push(tool);
      continue;
    }

    // 4. 全局禁止列表
    if (globalDisallowed.has(name)) {
      filteredNames.push(name);
      reasons.set(name, "global_disallowed");
      continue;
    }

    // 5. 自定义 Agent 禁止列表（仅非内置 Agent）
    if (!isBuiltIn && customDisallowed.has(name)) {
      filteredNames.push(name);
      reasons.set(name, "custom_disallowed");
      continue;
    }

    // 6. 异步 Agent 白名单
    if (isAsync && !asyncAllowed.has(name)) {
      filteredNames.push(name);
      reasons.set(name, "async_not_allowed");
      continue;
    }

    // 7. 黑名单过滤
    if (blacklist !== undefined && blacklist.has(name)) {
      filteredNames.push(name);
      reasons.set(name, "blacklisted");
      continue;
    }

    filtered.push(tool);
  }

  return { tools: filtered, filtered: filteredNames, reasons };
}

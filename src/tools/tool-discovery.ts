/**
 * 工具懒加载 — ToolDiscoveryService + 工具注册表分区。
 *
 * 阶段 E.2: 将工具分为 eagerTools 和 onDemandTools 两组，
 * 初始 prompt 只包含 eagerTools，模型按需发现 onDemandTools。
 *
 * 懒加载流程：
 * 1. [初始请求] SystemPrompt 只包含 eagerTools
 * 2. [模型推理] 模型需要 onDemand 工具 → 调用 ToolDiscoveryService(name)
 * 3. [发现] 返回工具的完整 Schema
 * 4. [后续请求] 自动包含已发现的工具
 */

import type { Tool } from "../interfaces/tool";

// ─── 工具分区结果 ───

export interface ToolPartition {
  /** 立即加载的工具（初始 prompt 包含） */
  readonly eagerTools: readonly Tool[];
  /** 按需加载的工具（初始 prompt 不包含） */
  readonly onDemandTools: readonly Tool[];
}

// ─── partitionTools ───

/**
 * 将工具分为 eager 和 onDemand 两组。
 *
 * @param tools - 所有工具
 * @returns ToolPartition — 分区结果
 */
export function partitionTools(tools: readonly Tool[]): ToolPartition {
  const eagerTools: Tool[] = [];
  const onDemandTools: Tool[] = [];

  for (const tool of tools) {
    if (tool.lazyLoad) {
      onDemandTools.push(tool);
    } else {
      eagerTools.push(tool);
    }
  }

  return { eagerTools, onDemandTools };
}

// ─── ToolDiscoveryService ───

/**
 * 工具发现服务 — 模型按需查询工具定义。
 *
 * 当模型需要使用一个 onDemand 工具时，调用此服务获取完整定义。
 */
export interface ToolDiscoveryService {
  /** 发现工具（按名称查找） */
  discover(toolName: string): Tool | undefined;
  /** 获取所有可发现的工具名称列表 */
  listDiscoverable(): readonly string[];
  /** 检查工具是否已被发现 */
  isDiscovered(toolName: string): boolean;
  /** 获取所有已发现的工具 */
  getDiscoveredTools(): readonly Tool[];
  /** 标记工具为已发现 */
  markDiscovered(toolName: string): void;
}

// ─── createToolDiscoveryService ───

/**
 * 创建工具发现服务。
 *
 * @param onDemandTools - 按需加载的工具列表
 */
export function createToolDiscoveryService(
  onDemandTools: readonly Tool[],
): ToolDiscoveryService {
  const toolMap = new Map<string, Tool>();
  for (const tool of onDemandTools) {
    toolMap.set(tool.name, tool);
  }

  const discoveredIds = new Set<string>();

  function discover(toolName: string): Tool | undefined {
    const tool = toolMap.get(toolName);
    if (tool) {
      discoveredIds.add(toolName);
    }
    return tool;
  }

  function listDiscoverable(): readonly string[] {
    return Array.from(toolMap.keys());
  }

  function isDiscovered(toolName: string): boolean {
    return discoveredIds.has(toolName);
  }

  function getDiscoveredTools(): readonly Tool[] {
    const result: Tool[] = [];
    for (const id of discoveredIds) {
      const tool = toolMap.get(id);
      if (tool) {
        result.push(tool);
      }
    }
    return result;
  }

  function markDiscovered(toolName: string): void {
    if (toolMap.has(toolName)) {
      discoveredIds.add(toolName);
    }
  }

  return { discover, listDiscoverable, isDiscovered, getDiscoveredTools, markDiscovered };
}

// ─── resolveEffectiveTools ───

/**
 * 解析有效工具列表（eager + 已发现的 onDemand）。
 *
 * @param eagerTools - 立即加载的工具
 * @param discoveryService - 工具发现服务
 * @returns 当前请求应包含的工具列表
 */
export function resolveEffectiveTools(
  eagerTools: readonly Tool[],
  discoveryService: ToolDiscoveryService,
): readonly Tool[] {
  const discoveredTools = discoveryService.getDiscoveredTools();
  return [...eagerTools, ...discoveredTools];
}

/**
 * partitionToolCalls — 并发安全/不安全分区。
 *
 * 将工具调用分为两组：
 * - concurrent: 可并发执行的工具（isConcurrencySafe = true）
 * - sequential: 必须串行执行的工具（isConcurrencySafe = false）
 */

import type { Tool, ToolUseContext } from "../interfaces/tool";

// ─── 分区结果 ───

export interface ToolCallPartition {
  /** 可并发执行的工具调用 */
  readonly concurrent: ReadonlyArray<ToolCallEntry>;

  /** 必须串行执行的工具调用 */
  readonly sequential: ReadonlyArray<ToolCallEntry>;
}

export interface ToolCallEntry {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly tool: Tool;
}

// ─── 分区函数 ───

/**
 * 将工具调用分为并发安全和串行两组。
 *
 * @param toolUses - 工具调用列表
 * @param tools - 可用工具注册表
 * @param context - 工具调用上下文
 * @returns 分区结果
 */
export function partitionToolCalls(
  toolUses: ReadonlyArray<{
    readonly toolUseId: string;
    readonly toolName: string;
    readonly input: Record<string, unknown>;
  }>,
  tools: ReadonlyArray<Tool>,
  context: ToolUseContext,
): ToolCallPartition {
  const concurrent: ToolCallEntry[] = [];
  const sequential: ToolCallEntry[] = [];

  for (const toolUse of toolUses) {
    const tool = tools.find((t) => t.name === toolUse.toolName);
    if (!tool) {
      // 未知工具归入串行（安全处理）
      sequential.push({
        toolUseId: toolUse.toolUseId,
        toolName: toolUse.toolName,
        input: toolUse.input,
        tool: createMissingTool(toolUse.toolName),
      });
      continue;
    }

    const entry: ToolCallEntry = {
      toolUseId: toolUse.toolUseId,
      toolName: toolUse.toolName,
      input: toolUse.input,
      tool,
    };

    if (tool.isConcurrencySafe(toolUse.input)) {
      concurrent.push(entry);
    } else {
      sequential.push(entry);
    }
  }

  return { concurrent, sequential };
}

// ─── 缺失工具占位 ───

function createMissingTool(name: string): Tool {
  return {
    name,
    description: `Unknown tool: ${name}`,
    inputSchema: {} as import("zod").ZodType<unknown>,
    maxResultSizeChars: 0,
    call: async () => ({
      content: `Error: Unknown tool '${name}'`,
      isError: true,
    }),
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    checkPermissions: async () => ({ behavior: "deny", reason: `Unknown tool: ${name}` }),
  };
}

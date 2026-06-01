/**
 * ToolUse / ToolResult 类型。
 *
 * 工具调用和工具结果的类型定义，用于 Agentic Loop 中的工具执行流程。
 */

// ─── ToolUse（工具调用请求） ───

export interface ToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

// ─── ToolResult（工具执行结果） ───

export interface ToolResult<T = unknown> {
  readonly content: T;
  readonly isError: boolean;
  readonly metadata?: {
    readonly durationMs?: number;
    readonly tokenUsage?: {
      readonly inputTokens: number;
      readonly outputTokens: number;
    };
  };
}

// ─── ToolResultBlock（用于 LLM API 格式） ───

export interface ToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

// ─── ToolCallProgress（工具调用进度回调） ───

export interface ToolCallProgress<P = unknown> {
  onProgress?: (progress: P) => void;
  abortSignal?: AbortSignal;
}

// ─── ToolDefinition（工具定义元数据） ───

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly isReadOnly?: boolean;
  readonly isDestructive?: boolean;
  readonly isConcurrencySafe?: boolean;
}

// ─── 工厂函数 ───

export function createToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ToolUse {
  return { id, name, input };
}

export function createToolResult<T>(
  content: T,
  isError: boolean,
  metadata?: ToolResult<T>["metadata"],
): ToolResult<T> {
  if (metadata !== undefined) {
    return { content, isError, metadata };
  }
  return { content, isError };
}

export function createToolResultBlock(
  toolUseId: string,
  content: string,
  isError?: boolean,
): ToolResultBlock {
  if (isError !== undefined) {
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content,
      is_error: isError,
    };
  }
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
  };
}

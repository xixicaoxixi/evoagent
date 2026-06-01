/**
 * createToolDefinition<I,O> — 工具工厂函数。
 *
 * 基于通用 Agent 设计模式的 createToolDefinition 设计。
 * RULES_2-2: Fail-Closed 默认值（TOOL_DEFAULTS）。
 */

import type { z } from "zod";
import type { Tool, ToolUseContext, CanUseToolFn, ToolProgressData } from "../interfaces/tool";
import type { PermissionResult, ValidationResult } from "../types/permission";
import type { ToolResult } from "../types/tool";
import { TOOL_DEFAULTS } from "../interfaces/tool";

// ─── 工具定义（部分） ───

export interface PartialToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly outputSchema?: z.ZodType<unknown>;
  readonly aliases?: readonly string[];
  readonly maxResultSizeChars?: number;
  readonly call?: (
    args: unknown,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
  ) => Promise<ToolResult>;
  readonly validateInput?: (
    input: unknown,
    context: ToolUseContext,
  ) => Promise<ValidationResult>;
  readonly checkPermissions?: (
    input: unknown,
    context: ToolUseContext,
  ) => Promise<PermissionResult>;
  readonly isEnabled?: () => boolean;
  readonly isConcurrencySafe?: (input: unknown) => boolean;
  readonly isReadOnly?: (input: unknown) => boolean;
  readonly isDestructive?: (input: unknown) => boolean;
  readonly descriptionForInput?: (
    input: unknown,
    options: { tools: ReadonlyArray<Tool> },
  ) => Promise<string>;
}

/**
 * 从部分定义构建完整的 Tool 对象。
 *
 * 未提供的方法使用 TOOL_DEFAULTS 中的安全默认值。
 */
export function createToolDefinition(def: PartialToolDef): Tool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
    ...(def.aliases ? { aliases: def.aliases } : {}),
    maxResultSizeChars: def.maxResultSizeChars ?? 100_000,
    call: def.call ?? (async () => ({
      content: "Not implemented",
      isError: true,
    })),
    ...(def.validateInput ? { validateInput: def.validateInput } : {}),
    checkPermissions: def.checkPermissions ?? TOOL_DEFAULTS.checkPermissions,
    ...(def.descriptionForInput ? { descriptionForInput: def.descriptionForInput } : {}),
    isEnabled: def.isEnabled ?? TOOL_DEFAULTS.isEnabled,
    isConcurrencySafe: def.isConcurrencySafe ?? TOOL_DEFAULTS.isConcurrencySafe,
    isReadOnly: def.isReadOnly ?? TOOL_DEFAULTS.isReadOnly,
    ...(def.isDestructive ? { isDestructive: def.isDestructive } : {}),
  } as Tool;
}

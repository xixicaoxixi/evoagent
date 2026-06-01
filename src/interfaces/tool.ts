/**
 * Tool<I, O, P> 泛型接口。
 *
 * 基于标准工具接口设计，适配 EvoAgent 核心需求。
 * RULES_2-4: 接口 + 注册表模式。
 * RULES_2-2: Fail-Closed 默认值（通过 createToolDefinition 工厂）。
 */

import type { z } from "zod";
import type { PermissionResult, ValidationResult } from "../types/permission";
import type { ToolResult } from "../types/tool";

// ─── Tool 上下文 ───

/** 工具调用上下文，提供运行时信息 */
export interface ToolUseContext {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  getAppState(): unknown;
}

/** 权限检查回调 */
export type CanUseToolFn = (permission: PermissionResult) => boolean;

/** 工具调用进度数据 */
export interface ToolProgressData {
  readonly progress: number;
  readonly message?: string;
}

/** 工具调用进度回调 */
export type ToolCallProgress<P = ToolProgressData> = {
  onProgress?: (progress: P) => void;
  abortSignal?: AbortSignal;
};

// ─── Tool 核心接口 ───

/**
 * Tool<I, O, P> — 工具泛型接口。
 *
 * @typeParam I - 输入 Schema 类型（Zod Schema）
 * @typeParam O - 输出类型
 * @typeParam P - 进度数据类型
 */
export interface Tool<
  I extends z.ZodType<unknown> = z.ZodType<unknown>,
  O = unknown,
  P extends ToolProgressData = ToolProgressData,
> {
  /** 工具唯一名称 */
  readonly name: string;

  /** 工具描述（用于 Prompt 生成） */
  readonly description: string;

  /** 输入 Zod Schema（用于验证和 Prompt 生成） */
  readonly inputSchema: I;

  /** 输出 Schema（可选，用于结果验证） */
  readonly outputSchema?: z.ZodType<O>;

  /** 别名（用于工具搜索匹配） */
  readonly aliases?: readonly string[];

  /** 最大结果大小（字符数） */
  readonly maxResultSizeChars: number;

  /** 执行工具调用 */
  call(
    args: z.infer<I>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    progress?: ToolCallProgress<P>,
  ): Promise<ToolResult<O>>;

  /** 生成工具描述（可基于输入动态调整） */
  descriptionForInput?(
    input: z.infer<I>,
    options: {
      tools: ReadonlyArray<Tool>;
    },
  ): Promise<string>;

  /** 验证输入 */
  validateInput?(
    input: z.infer<I>,
    context: ToolUseContext,
  ): Promise<ValidationResult>;

  /** 检查权限 */
  checkPermissions(
    input: z.infer<I>,
    context: ToolUseContext,
  ): Promise<PermissionResult>;

  /** 是否启用 */
  isEnabled(): boolean;

  /** 是否并发安全 */
  isConcurrencySafe(input: z.infer<I>): boolean;

  /** 是否只读 */
  isReadOnly(input: z.infer<I>): boolean;

  /** E.2: 是否延迟加载（初始 prompt 不包含此工具） */
  readonly lazyLoad?: boolean;

  /** 是否破坏性操作 */
  isDestructive?(input: z.infer<I>): boolean;
}

// ─── ToolDefinition（用于注册表） ───

export interface ToolRegistration {
  readonly tool: Tool;
  readonly priority: number;
  readonly source: string;
}

// ─── TOOL_DEFAULTS（Fail-Closed 默认值） ───

export const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  checkPermissions: async (
    _input: Record<string, unknown>,
    _context: ToolUseContext,
  ): Promise<PermissionResult> => ({
    behavior: "allow",
  }),
} as const;

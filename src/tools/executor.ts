/**
 * StreamingToolExecutor — 并发调度 + 双层 AbortController。
 *
 * 执行分好区的工具调用：
 * 1. 并发执行 concurrent 组（Promise.all + Promise.allSettled）
 * 2. 串行执行 sequential 组
 * 3. 支持全局 AbortController 和单工具 AbortController
 *
 * 阶段 A.2: 工具级错误隔离 — 错误即数据范式。
 * 工具执行错误不再抛出异常，而是返回 isError=true 的 ToolExecutionResult，
 * 包含截断堆栈（最多 3 帧），避免浪费模型上下文 token。
 */

import type { Tool, ToolUseContext, CanUseToolFn } from "../interfaces/tool";
import type { ToolResultMessage } from "../types/message";
import type { ToolCallEntry } from "./partition";
import { coerceToolArgs } from "./coerce";
import {
  extractErrorMessage,
  truncateStack,
  isCancellation,
  normalizeError,
} from "../utils/errors";

// ─── 执行结果 ───

export interface ToolExecutionResult {
  readonly message: ToolResultMessage;
  readonly durationMs: number;
  /** 错误码（仅 isError=true 时有值） */
  readonly errorCode?: string;
}

// ─── 执行器配置 ───

export interface ExecutorConfig {
  readonly tools: ReadonlyArray<Tool>;
  readonly context: ToolUseContext;
  readonly canUseTool: CanUseToolFn;
  readonly globalAbortSignal?: AbortSignal;
  readonly timeoutMs?: number;
}

// ─── StreamingToolExecutor ───

export class StreamingToolExecutor {
  private readonly config: ExecutorConfig;
  private readonly results: ToolExecutionResult[] = [];
  private readonly globalAbortController: AbortController;

  constructor(config: ExecutorConfig) {
    this.config = config;
    this.globalAbortController = new AbortController();

    // 监听外部 abort
    if (config.globalAbortSignal) {
      if (config.globalAbortSignal.aborted) {
        this.globalAbortController.abort();
      } else {
        config.globalAbortSignal.addEventListener("abort", () => {
          this.globalAbortController.abort();
        });
      }
    }
  }

  /**
   * 执行所有工具调用（先并发后串行）。
   *
   * @param entries - 工具调用条目列表
   * @yields ToolExecutionResult - 每个工具的执行结果
   */
  async *execute(
    entries: ReadonlyArray<ToolCallEntry>,
  ): AsyncGenerator<ToolExecutionResult> {
    // 分区
    const concurrent = entries.filter((e) =>
      e.tool.isConcurrencySafe(e.input),
    );
    const sequential = entries.filter(
      (e) => !e.tool.isConcurrencySafe(e.input),
    );

    // 1. 并发执行
    if (concurrent.length > 0) {
      const concurrentResults = await this.executeConcurrent(concurrent);
      for (const result of concurrentResults) {
        this.results.push(result);
        yield result;
      }
    }

    // 2. 串行执行
    for (const entry of sequential) {
      if (this.globalAbortController.signal.aborted) break;
      const result = await this.executeSingle(entry);
      this.results.push(result);
      yield result;
    }
  }

  /**
   * 获取所有已执行的结果。
   */
  getResults(): readonly ToolExecutionResult[] {
    return this.results;
  }

  /**
   * 中止所有执行。
   */
  abort(): void {
    this.globalAbortController.abort();
  }

  // ─── 并发执行 ───

  private async executeConcurrent(
    entries: ReadonlyArray<ToolCallEntry>,
  ): Promise<ToolExecutionResult[]> {
    const promises = entries.map((entry) => this.executeSingle(entry));
    const settled = await Promise.allSettled(promises);

    return settled.map((result, index) => {
      const entry = entries[index]!;
      if (result.status === "fulfilled") {
        return result.value;
      }
      // 失败的工具返回错误结果（错误即数据范式）
      return this.buildErrorResult(entry, result.reason);
    });
  }

  // ─── 单个工具执行 ───

  private async executeSingle(entry: ToolCallEntry): Promise<ToolExecutionResult> {
    const startTime = Date.now();

    // 单工具 AbortController（双层）
    const perToolAbort = new AbortController();
    const timeoutId = setTimeout(
      () => perToolAbort.abort(),
      this.config.timeoutMs ?? 60_000,
    );

    // 如果全局已中止，直接返回
    if (this.globalAbortController.signal.aborted) {
      return this.buildAbortedResult(entry, startTime);
    }

    try {
      const { coerced } = coerceToolArgs(entry.input, entry.tool.inputSchema);

      const result = await entry.tool.call(
        coerced,
        this.config.context,
        this.config.canUseTool,
      );

      return {
        message: {
          id: `result-${entry.toolUseId}`,
          role: "tool_result",
          timestamp: Date.now(),
          toolUseId: entry.toolUseId,
          content: typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content),
          isError: result.isError,
        },
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return this.buildErrorResult(entry, error, startTime);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ─── 错误结果构建（A.2: 错误即数据） ───

  /**
   * 构建工具错误结果。
   *
   * 使用 extractErrorMessage 提取安全消息，
   * 使用 truncateStack 截断堆栈（最多 3 帧），
   * 使用 normalizeError 统一错误类型。
   */
  private buildErrorResult(
    entry: ToolCallEntry,
    error: unknown,
    startTime?: number,
  ): ToolExecutionResult {
    const normalized = normalizeError(error);
    const safeMessage = extractErrorMessage(error);
    const stack = truncateStack(error, 3);

    // 构建错误内容：安全消息 + 截断堆栈
    const content = stack
      ? `${safeMessage}\n\nStack trace:\n${stack}`
      : safeMessage;

    return {
      message: {
        id: `result-${entry.toolUseId}`,
        role: "tool_result",
        timestamp: Date.now(),
        toolUseId: entry.toolUseId,
        content,
        isError: true,
      },
      durationMs: startTime ? Date.now() - startTime : 0,
      errorCode: normalized.code,
    };
  }

  /**
   * 构建中止结果。
   */
  private buildAbortedResult(
    entry: ToolCallEntry,
    startTime: number,
  ): ToolExecutionResult {
    return {
      message: {
        id: `result-${entry.toolUseId}`,
        role: "tool_result",
        timestamp: Date.now(),
        toolUseId: entry.toolUseId,
        content: "Aborted: global abort signal",
        isError: true,
      },
      durationMs: Date.now() - startTime,
      errorCode: "ABORTED",
    };
  }
}

// ─── 工具错误分类（用于查询循环判断是否可恢复） ───

export type ToolErrorCategory = "timeout" | "cancellation" | "permission" | "validation" | "unknown";

/**
 * classifyToolError — 分类工具错误。
 *
 * - timeout: 超时错误（不可恢复，应终止循环）
 * - cancellation: 用户中止（不可恢复，应终止循环）
 * - permission: 权限拒绝（可恢复，模型可换工具）
 * - unknown: 其他错误（可恢复，模型可自主决定）
 */
export function classifyToolError(error: unknown): ToolErrorCategory {
  if (isCancellation(error)) return "cancellation";

  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("timed out") || message.toLowerCase().includes("timeout")) {
    return "timeout";
  }

  if (message.toLowerCase().includes("permission denied")) {
    return "permission";
  }

  return "unknown";
}

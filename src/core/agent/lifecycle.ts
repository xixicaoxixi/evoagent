/**
 * runAsyncAgentLifecycle — 异步代理生命周期模板。
 *
 * 模板方法模式：管理 Agent 的完整异步生命周期，
 * 包括进度追踪、错误隔离、中止处理和资源清理。
 *
 * 参考 `代码片段_Agent核心循环与编排.md` 片段 #11。
 */

import type { StreamEvent, Terminal } from "../query/types";
import { isCompletedTerminal } from "../query/types";

// ─── 生命周期配置 ───

export interface AsyncAgentLifecycleConfig {
  readonly agentId: string;
  readonly taskId: string;
  readonly description: string;
  readonly abortSignal?: AbortSignal;
  readonly timeoutMs?: number;
}

// ─── 生命周期回调 ───

export interface AsyncAgentLifecycleCallbacks {
  /** 创建 Agent 消息流 */
  createStream: () => AsyncGenerator<StreamEvent, Terminal>;

  /** 消息到达回调（实时更新 UI 状态等） */
  onMessage?: (event: StreamEvent) => void;

  /** Agent 完成回调 */
  onComplete?: (result: AsyncAgentResult) => void;

  /** Agent 失败回调 */
  onFail?: (error: Error) => void;

  /** Agent 被中止回调 */
  onAbort?: () => void;

  /** 进度更新回调 */
  onProgress?: (progress: AgentProgress) => void;

  /** 资源清理回调 */
  onCleanup?: () => void | Promise<void>;
}

// ─── Agent 结果 ───

export interface AsyncAgentResult {
  readonly agentId: string;
  readonly taskId: string;
  readonly status: "completed" | "failed" | "killed";
  readonly terminal: Terminal;
  readonly totalEvents: number;
  readonly durationMs: number;
  readonly error?: string;
}

// ─── Agent 进度 ───

export interface AgentProgress {
  readonly agentId: string;
  readonly taskId: string;
  readonly currentTool?: string;
  readonly turnCount: number;
  readonly elapsedMs: number;
}

// ─── 生命周期执行 ───

/**
 * runAsyncAgentLifecycle — 执行异步 Agent 的完整生命周期。
 *
 * 流程：
 * 1. 初始化进度追踪
 * 2. 消费 Agent 消息流（实时回调）
 * 3. 处理完成/失败/中止
 * 4. 资源清理（finally）
 */
export async function runAsyncAgentLifecycle(
  config: AsyncAgentLifecycleConfig,
  callbacks: AsyncAgentLifecycleCallbacks,
): Promise<AsyncAgentResult> {
  const startTime = Date.now();
  let totalEvents = 0;
  let currentTurnCount = 0;
  let lastToolName: string | undefined;
  let status: "completed" | "failed" | "killed" = "completed";
  let errorMessage: string | undefined;

  // 超时处理
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  if (config.timeoutMs !== undefined && config.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      callbacks.onAbort?.();
    }, config.timeoutMs);
  }

  try {
    const stream = callbacks.createStream();

    for await (const event of stream) {
      // 中止检查
      if (config.abortSignal?.aborted) {
        status = "killed";
        break;
      }

      totalEvents++;

      // 更新进度状态
      if (event.type === "turn_start") {
        currentTurnCount = event.turnCount;
      }
      if (event.type === "tool_start") {
        lastToolName = event.toolName;
      }

      // 实时回调
      callbacks.onMessage?.(event);

      // 进度更新（节流：每 5 个事件更新一次）
      if (totalEvents % 5 === 0) {
        const progress: AgentProgress = {
          agentId: config.agentId,
          taskId: config.taskId,
          turnCount: currentTurnCount,
          elapsedMs: Date.now() - startTime,
        };
        if (lastToolName !== undefined) {
          (progress as { currentTool: string }).currentTool = lastToolName;
        }
        callbacks.onProgress?.(progress);
      }
    }

  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      status = "killed";
      callbacks.onAbort?.();
    } else {
      status = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
      callbacks.onFail?.(error instanceof Error ? error : new Error(String(error)));
    }
  } finally {
    // 清理超时定时器
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
    }

    // 资源清理
    await callbacks.onCleanup?.();
  }

  const durationMs = Date.now() - startTime;

  const result: AsyncAgentResult = {
    agentId: config.agentId,
    taskId: config.taskId,
    status,
    terminal: { reason: "completed", messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0 } },
    totalEvents,
    durationMs,
    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
  };

  // 完成回调
  if (status === "completed") {
    callbacks.onComplete?.(result);
  }

  return result;
}

// ─── 进度追踪器 ───

export interface ProgressTracker {
  toolCalls: number;
  totalTokens: number;
  startTime: number;
  lastActivity: string;
}

export function createProgressTracker(): ProgressTracker {
  return {
    toolCalls: 0,
    totalTokens: 0,
    startTime: Date.now(),
    lastActivity: "initialized",
  };
}

export function updateProgressFromEvent(
  tracker: ProgressTracker,
  event: StreamEvent,
): void {
  if (event.type === "tool_start") {
    tracker.toolCalls++;
    tracker.lastActivity = `tool:${event.toolName}`;
  }
  if (event.type === "content") {
    tracker.lastActivity = "content";
  }
  if (event.type === "turn_end" && event.tokenUsage) {
    tracker.totalTokens += (event.tokenUsage.inputTokens ?? 0) + (event.tokenUsage.outputTokens ?? 0);
  }
}

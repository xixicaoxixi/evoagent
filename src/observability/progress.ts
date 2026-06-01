/**
 * 进度追踪 — 任务进度追踪（ToolActivity + AgentProgress）。
 *
 * 参考 `代码片段_基础设施与可观测性补充` #5 ProgressTracker。
 *
 * 设计原则：
 * - Token 双轨统计：input（累计值取最新）+ output（逐轮累加）
 * - 活动列表 FIFO，固定容量 MAX_RECENT_ACTIVITIES = 5
 * - 接口分离：ToolActivity（原始记录）vs AgentProgress（对外快照）
 */

import { sanitizeToolInputForLogging, extractToolInputForTelemetry } from "../security/truncate";
import type { StreamEvent } from "../core/query/types";

// ─── 工具活动 ───

export interface ToolActivity {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly activityDescription?: string | undefined;
  readonly isSearch?: boolean | undefined;
  readonly isRead?: boolean | undefined;
}

// ─── Agent 进度快照 ───

export interface AgentProgress {
  readonly toolUseCount: number;
  readonly tokenCount: number;
  readonly lastActivity?: ToolActivity | undefined;
  readonly recentActivities: readonly ToolActivity[];
}

// ─── 进度追踪器（可变内部状态） ───

export interface ProgressTrackerData {
  toolUseCount: number;
  latestInputTokens: number;
  cumulativeOutputTokens: number;
  recentActivities: ToolActivity[];
}

const MAX_RECENT_ACTIVITIES = 5;

// ─── 创建进度追踪器 ───

export function createProgressTracker(): ProgressTrackerData {
  return {
    toolUseCount: 0,
    latestInputTokens: 0,
    cumulativeOutputTokens: 0,
    recentActivities: [],
  };
}

// ─── Token 计数 ───

export function getTokenCountFromTracker(tracker: ProgressTrackerData): number {
  return tracker.latestInputTokens + tracker.cumulativeOutputTokens;
}

// ─── 活动描述解析器 ───

export type ActivityDescriptionResolver = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
) => string | undefined;

// ─── 更新进度（从消息） ───

/**
 * updateProgressFromMessage — 从 assistant 消息更新进度追踪器。
 *
 * 参考标准实现的 updateProgressFromMessage：
 * - input_tokens 保留最新值（Claude API 累计值）
 * - output_tokens 逐轮累加
 * - 工具使用计数 + 活动列表
 */
export function updateProgressFromMessage(
  tracker: ProgressTrackerData,
  message: {
    readonly type: string;
    readonly usage?: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly cache_creation_input_tokens?: number;
      readonly cache_read_input_tokens?: number;
    };
    readonly content?: ReadonlyArray<{
      readonly type: string;
      readonly name?: string;
      readonly input?: Record<string, unknown>;
    }>;
  },
  resolveActivityDescription?: ActivityDescriptionResolver,
): void {
  if (message.type !== "assistant") return;

  const usage = message.usage;
  if (usage) {
    // input_tokens 是累计值，保留最新
    tracker.latestInputTokens =
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    // output_tokens 逐轮累加
    tracker.cumulativeOutputTokens += usage.output_tokens;
  }

  const content = message.content;
  if (!content) return;

  for (const block of content) {
    if (block.type === "tool_use" && block.name) {
      tracker.toolUseCount++;
      const rawInput = block.input ?? {};
      const input = sanitizeToolInputForLogging(rawInput) as Readonly<Record<string, unknown>>;
      const activity: ToolActivity = {
        toolName: block.name,
        input,
        activityDescription: resolveActivityDescription?.(block.name, input),
      };
      tracker.recentActivities.push(activity);
    }
  }

  // FIFO 淘汰
  while (tracker.recentActivities.length > MAX_RECENT_ACTIVITIES) {
    tracker.recentActivities.shift();
  }
}

// ─── 记录工具调用（底层原语） ───

export function recordToolCall(
  tracker: ProgressTrackerData,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): void {
  tracker.toolUseCount++;
  const sanitizedInput = sanitizeToolInputForLogging(input) as Readonly<Record<string, unknown>>;
  tracker.recentActivities.push({
    toolName,
    input: sanitizedInput,
    activityDescription: `Tool call: ${toolName}`,
  });
  while (tracker.recentActivities.length > MAX_RECENT_ACTIVITIES) {
    tracker.recentActivities.shift();
  }
}

// ─── 更新进度（从 StreamEvent） ───

export function updateProgressFromStreamEvent(
  tracker: ProgressTrackerData,
  event: StreamEvent,
): void {
  if (event.type === "tool_start") {
    recordToolCall(tracker, event.toolName, event.input ?? {});
  }
  if (event.type === "turn_end" && event.tokenUsage) {
    tracker.latestInputTokens += event.tokenUsage.inputTokens;
    tracker.cumulativeOutputTokens += event.tokenUsage.outputTokens;
  }
}

// ─── 获取进度快照 ───

export function getProgressUpdate(tracker: ProgressTrackerData): AgentProgress {
  return {
    toolUseCount: tracker.toolUseCount,
    tokenCount: getTokenCountFromTracker(tracker),
    lastActivity:
      tracker.recentActivities.length > 0
        ? tracker.recentActivities[tracker.recentActivities.length - 1]
        : undefined,
    recentActivities: [...tracker.recentActivities],
  };
}

// ─── 遥测数据导出 ───

export interface ToolActivityTelemetry {
  readonly toolName: string;
  readonly inputJson: string;
}

export function extractTelemetryFromActivities(tracker: ProgressTrackerData): ToolActivityTelemetry[] {
  return tracker.recentActivities.map((activity) => ({
    toolName: activity.toolName,
    inputJson: extractToolInputForTelemetry(activity.input),
  }));
}

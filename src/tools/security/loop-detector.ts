/**
 * 工具调用循环检测器 — 4 种检测器。
 *
 * 基于安全最佳实践的工具调用循环检测设计。
 * 检测 Agent 陷入重复循环的情况。
 *
 * 4 种检测器（按优先级）：
 * 1. global_circuit_breaker — 全局断路器（>=30 次无进展重复）
 * 2. known_poll_no_progress — 已知轮询无进展（>=20 次）
 * 3. ping_pong — 乒乓循环（两个工具交替 >=20 次）
 * 4. generic_repeat — 通用重复（最近 30 次中 >=10 次）
 */

import { createHash } from "node:crypto";

// ─── 类型定义 ───

export interface ToolCallRecord {
  readonly toolName: string;
  readonly argsHash: string;
  readonly resultHash?: string;
  readonly timestamp: number;
}

export interface LoopDetectionStuck {
  readonly stuck: true;
  readonly level: "critical" | "warning";
  readonly detector: string;
  readonly count: number;
  readonly message: string;
  readonly warningKey: string | undefined;
  readonly pairedToolName: string | undefined;
}

export type LoopDetectionResult = LoopDetectionStuck | { readonly stuck: false };

export interface LoopDetectionConfig {
  readonly enabled?: boolean;
  readonly globalCircuitBreakerThreshold?: number;
  readonly criticalThreshold?: number;
  readonly warningThreshold?: number;
  readonly slidingWindowSize?: number;
}

// ─── 默认配置 ───

const DEFAULT_CONFIG: {
  readonly enabled: boolean;
  readonly globalCircuitBreakerThreshold: number;
  readonly criticalThreshold: number;
  readonly warningThreshold: number;
  readonly slidingWindowSize: number;
} = {
  enabled: true,
  globalCircuitBreakerThreshold: 30,
  criticalThreshold: 20,
  warningThreshold: 10,
  slidingWindowSize: 30,
};

// ─── 已知轮询工具 ───

const KNOWN_POLL_TOOLS = new Set([
  "command_status",
  "process_poll",
  "process_log",
  "check_status",
  "get_status",
]);

// ─── 辅助函数 ───

/**
 * hashToolCall — 对工具名+参数计算 SHA-256 哈希。
 */
export function hashToolCall(toolName: string, params: unknown): string {
  const data = `${toolName}:${JSON.stringify(params)}`;
  return createHash("sha256").update(data).digest("hex");
}

/**
 * resolveLoopDetectionConfig — 合并用户配置与默认值。
 */
function resolveLoopDetectionConfig(
  config?: LoopDetectionConfig,
): typeof DEFAULT_CONFIG {
  return {
    enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
    globalCircuitBreakerThreshold:
      config?.globalCircuitBreakerThreshold ?? DEFAULT_CONFIG.globalCircuitBreakerThreshold,
    criticalThreshold:
      config?.criticalThreshold ?? DEFAULT_CONFIG.criticalThreshold,
    warningThreshold:
      config?.warningThreshold ?? DEFAULT_CONFIG.warningThreshold,
    slidingWindowSize:
      config?.slidingWindowSize ?? DEFAULT_CONFIG.slidingWindowSize,
  };
}

/**
 * getNoProgressStreak — 计算连续相同结果的无进展次数。
 */
function getNoProgressStreak(
  history: readonly ToolCallRecord[],
  toolName: string,
  currentHash: string,
): { readonly count: number; readonly latestResultHash: string | undefined } {
  let count = 0;
  let latestResultHash: string | undefined;

  // 从历史末尾向前遍历
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i];
    if (record === undefined) break;
    if (record.toolName !== toolName || record.argsHash !== currentHash) break;
    count++;
    if (latestResultHash === undefined) {
      latestResultHash = record.resultHash;
    }
  }

  return { count, latestResultHash };
}

/**
 * isKnownPollToolCall — 检查是否是已知轮询工具。
 */
function isKnownPollToolCall(toolName: string, _params: unknown): boolean {
  return KNOWN_POLL_TOOLS.has(toolName);
}

/**
 * getPingPongStreak — 检测两个工具之间的乒乓循环。
 */
function getPingPongStreak(
  history: readonly ToolCallRecord[],
  currentHash: string,
): {
  readonly count: number;
  readonly pairedSignature?: string;
  readonly pairedToolName?: string;
  readonly noProgressEvidence: boolean;
} {
  if (history.length < 2) {
    return { count: 0, noProgressEvidence: false };
  }

  // 获取当前工具的签名
  const currentRecord = history[history.length - 1];
  if (currentRecord === undefined || currentRecord.argsHash !== currentHash) {
    return { count: 0, noProgressEvidence: false };
  }

  const currentToolName = currentRecord.toolName;
  const currentResultHash = currentRecord.resultHash;

  // 检查前一个记录是否是不同的工具
  const prevRecord = history[history.length - 2];
  if (prevRecord === undefined || prevRecord.toolName === currentToolName) {
    return { count: 0, noProgressEvidence: false };
  }

  const pairedToolName = prevRecord.toolName;
  const pairedHash = prevRecord.argsHash;

  // 向前计算交替次数
  let count = 1; // 当前已经是一次
  let noProgressEvidence = currentResultHash !== undefined;

  for (let i = history.length - 3; i >= 0; i -= 2) {
    const a = history[i];
    const b = history[i + 1];
    if (a === undefined || b === undefined) break;

    if (
      a.toolName === pairedToolName &&
      a.argsHash === pairedHash &&
      b.toolName === currentToolName &&
      b.argsHash === currentHash
    ) {
      count += 2;
      if (b.resultHash !== undefined && b.resultHash === currentResultHash) {
        // 结果相同，无进展证据
      } else {
        noProgressEvidence = false;
      }
    } else {
      break;
    }
  }

  return {
    count,
    pairedSignature: pairedHash,
    pairedToolName,
    noProgressEvidence,
  };
}

// ─── 主检测函数 ───

/**
 * detectToolCallLoop — 工具调用循环检测。
 *
 * 使用 4 种检测器识别 Agent 陷入重复循环的情况。
 *
 * @param history - 工具调用历史
 * @param toolName - 当前工具名称
 * @param params - 当前工具参数
 * @param config - 检测配置
 * @returns LoopDetectionResult
 */
export function detectToolCallLoop(
  history: readonly ToolCallRecord[],
  toolName: string,
  params: unknown,
  config?: LoopDetectionConfig,
): LoopDetectionResult {
  const resolvedConfig = resolveLoopDetectionConfig(config);
  if (!resolvedConfig.enabled) {
    return { stuck: false };
  }

  const currentHash = hashToolCall(toolName, params);
  const noProgress = getNoProgressStreak(history, toolName, currentHash);
  const noProgressStreak = noProgress.count;
  const knownPollTool = isKnownPollToolCall(toolName, params);
  const pingPong = getPingPongStreak(history, currentHash);

  // 1. 全局断路器
  if (noProgressStreak >= resolvedConfig.globalCircuitBreakerThreshold) {
    return {
      stuck: true,
      level: "critical",
      detector: "global_circuit_breaker",
      count: noProgressStreak,
      message: `CRITICAL: ${toolName} has repeated identical no-progress outcomes ${noProgressStreak} times. Session execution blocked by global circuit breaker.`,
      warningKey: `global:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
      pairedToolName: undefined,
    };
  }

  // 2. 已知轮询无进展（critical）
  if (
    knownPollTool &&
    noProgressStreak >= resolvedConfig.criticalThreshold
  ) {
    return {
      stuck: true,
      level: "critical",
      detector: "known_poll_no_progress",
      count: noProgressStreak,
      message: `CRITICAL: Called ${toolName} with identical arguments and no progress ${noProgressStreak} times. Stuck polling loop detected.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
      pairedToolName: undefined,
    };
  }

  // 3. 已知轮询无进展（warning）
  if (
    knownPollTool &&
    noProgressStreak >= resolvedConfig.warningThreshold
  ) {
    return {
      stuck: true,
      level: "warning",
      detector: "known_poll_no_progress",
      count: noProgressStreak,
      message: `WARNING: You have called ${toolName} ${noProgressStreak} times with identical arguments and no progress.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
      pairedToolName: undefined,
    };
  }

  // 4. 乒乓循环（critical）
  if (
    pingPong.count >= resolvedConfig.criticalThreshold &&
    pingPong.noProgressEvidence
  ) {
    return {
      stuck: true,
      level: "critical",
      detector: "ping_pong",
      count: pingPong.count,
      message: `CRITICAL: Alternating between ${toolName} and ${pingPong.pairedToolName ?? "unknown"} ${pingPong.count} times with no progress.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: `pingpong:${toolName}:${currentHash}`,
    };
  }

  // 5. 乒乓循环（warning）
  if (pingPong.count >= resolvedConfig.warningThreshold) {
    return {
      stuck: true,
      level: "warning",
      detector: "ping_pong",
      count: pingPong.count,
      message: `WARNING: Alternating between ${toolName} and ${pingPong.pairedToolName ?? "unknown"} ${pingPong.count} times.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: `pingpong:${toolName}:${currentHash}`,
    };
  }

  // 6. 通用重复（warning only）
  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === currentHash,
  ).length;

  if (
    !knownPollTool &&
    recentCount >= resolvedConfig.warningThreshold
  ) {
    return {
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
      count: recentCount,
      message: `WARNING: You have called ${toolName} ${recentCount} times with identical arguments.`,
      warningKey: `generic:${toolName}:${currentHash}`,
      pairedToolName: undefined,
    };
  }

  return { stuck: false };
}

// ─── 工具调用签名去重（Shadow Mode） ───

export interface DuplicateCallWarning {
  readonly isDuplicate: true;
  readonly toolName: string;
  readonly signature: string;
  readonly previousCallIndex: number;
  readonly message: string;
}

export interface NoDuplicate {
  readonly isDuplicate: false;
}

export type DuplicateCheckResult = DuplicateCallWarning | NoDuplicate;

export type MutatingChecker = (toolName: string, input: unknown) => boolean;

const DEFAULT_MUTATING_TOOLS = new Set([
  "bash",
  "file_write",
  "write_file",
  "edit_file",
  "file_edit",
  "mkdir",
  "rm",
  "remove_file",
  "move_file",
  "copy_file",
  "create_file",
  "apply_diff",
  "git_commit",
  "git_push",
  "npm_publish",
]);

export class CallSignatureTracker {
  private readonly turnSignatures: Map<string, number> = new Map();
  private callIndex: number = 0;
  private readonly isMutatingFn: MutatingChecker | undefined;

  constructor(isMutatingFn?: MutatingChecker) {
    this.isMutatingFn = isMutatingFn;
  }

  checkAndRecord(toolName: string, input: unknown, isReadOnly: boolean): DuplicateCheckResult {
    const signature = hashToolCall(toolName, input);
    const isMutating = this.isMutatingFn !== undefined
      ? this.isMutatingFn(toolName, input)
      : !isReadOnly;

    const previousIndex = this.turnSignatures.get(signature);

    this.turnSignatures.set(signature, this.callIndex);
    this.callIndex++;

    if (previousIndex !== undefined && isMutating) {
      return {
        isDuplicate: true,
        toolName,
        signature,
        previousCallIndex: previousIndex,
        message: `[DUPLICATE CALL WARNING] Mutating tool "${toolName}" was called with identical arguments earlier in this turn (call #${previousIndex + 1}). Consider whether this is necessary or indicates a loop.`,
      };
    }

    return { isDuplicate: false };
  }

  reset(): void {
    this.turnSignatures.clear();
    this.callIndex = 0;
  }

  get size(): number {
    return this.turnSignatures.size;
  }
}

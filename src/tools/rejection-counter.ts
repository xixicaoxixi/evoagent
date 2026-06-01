/**
 * 拒绝追踪断路器 — 双阈值降级策略。
 *
 * 阶段 C.2: 追踪 consecutiveRejections 和 totalRejections，
 * 连续拒绝 5 次或总拒绝 30 次触发降级。
 *
 * 降级策略：
 * - 交互式 Agent → 回退到用户确认（requiresUserFallback 返回 true）
 * - 无头 Agent → 抛出 AbortError（由调用方处理）
 *
 * RULES_2-18: CoW 不可变更新。
 * RULES_2-16: 滑动窗口限流。
 */

// ─── 断路器阈值 ───

export const REJECTION_THRESHOLDS = {
  /** 连续拒绝触发降级的阈值 */
  maxConsecutive: 5,
  /** 总拒绝触发降级的阈值 */
  maxTotal: 30,
} as const;

// ─── RejectionCounter ───

export interface RejectionCounter {
  readonly consecutiveRejections: number;
  readonly totalRejections: number;
}

// ─── 初始状态 ───

export const INITIAL_REJECTION_COUNTER: RejectionCounter = {
  consecutiveRejections: 0,
  totalRejections: 0,
};

// ─── countRejection ───

/**
 * 记录一次拒绝。
 *
 * CoW 不可变更新：返回新的 RejectionCounter。
 */
export function countRejection(state: RejectionCounter): RejectionCounter {
  return {
    consecutiveRejections: state.consecutiveRejections + 1,
    totalRejections: state.totalRejections + 1,
  };
}

// ─── countApproval ───

/**
 * 记录一次批准。
 *
 * 重置连续拒绝计数（但不重置总拒绝计数）。
 */
export function countApproval(state: RejectionCounter): RejectionCounter {
  return {
    consecutiveRejections: 0,
    totalRejections: state.totalRejections,
  };
}

// ─── requiresUserFallback ───

/**
 * 判断是否需要降级到用户确认。
 *
 * 双阈值：连续拒绝 >= maxConsecutive 或总拒绝 >= maxTotal。
 */
export function requiresUserFallback(
  state: RejectionCounter,
  thresholds?: {
    readonly maxConsecutive?: number;
    readonly maxTotal?: number;
  },
): boolean {
  const maxConsecutive = thresholds?.maxConsecutive ?? REJECTION_THRESHOLDS.maxConsecutive;
  const maxTotal = thresholds?.maxTotal ?? REJECTION_THRESHOLDS.maxTotal;

  return (
    state.consecutiveRejections >= maxConsecutive ||
    state.totalRejections >= maxTotal
  );
}

// ─── getRejectionSummary ───

/**
 * 获取拒绝统计摘要（用于日志/调试）。
 */
export function getRejectionSummary(state: RejectionCounter): string {
  return `Rejections: ${state.consecutiveRejections} consecutive, ${state.totalRejections} total`;
}

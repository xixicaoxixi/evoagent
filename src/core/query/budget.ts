/**
 * Token 预算管理 — 双重停止条件。
 *
 * RULES_2-10: 两层截断（单条上限 + 总量上限）。
 * 基于通用 Agent 设计模式的 BudgetTracker 设计。
 *
 * E8 修复：滑动窗口预算，只统计最近 windowMs 内的消耗。
 * M12 修复：warn 模式添加最大超额倍数，超限后降级为 enforce。
 */

// ─── BudgetTracker ───

export interface BudgetTracker {
  readonly totalBudget: number;

  readonly used: number;

  readonly remaining: number;

  readonly usageRatio: number;

  readonly isExceeded: boolean;

  readonly isNearLimit: boolean;
}

// ─── BudgetConfig ───

export interface BudgetConfig {
  readonly totalBudget: number;

  readonly warningThreshold?: number;

  readonly maxSingleMessageTokens?: number;
}

// ─── BudgetMode ───

export type BudgetMode = "enforce" | "warn";

// ─── BudgetManagerConfig ───

export interface BudgetManagerConfig {
  readonly totalBudget: number;

  readonly warningThreshold?: number;

  readonly maxSingleMessageTokens?: number;

  readonly mode?: BudgetMode;

  readonly maxOverageMultiplier?: number;

  readonly windowMs?: number;
}

// ─── ConsumptionRecord ───

interface ConsumptionRecord {
  readonly timestamp: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

// ─── BudgetManager ───

export interface BudgetManager {
  consume(inputTokens: number, outputTokens: number): BudgetCheckResult;
  check(estimatedInputTokens: number): BudgetCheckResult;
  getTracker(): BudgetTracker;
  getMode(): BudgetMode;
  resetWindow(): void;
}

// ─── 创建 BudgetTracker ───

export function createBudgetTracker(config: BudgetConfig): BudgetTracker {
  const warningThreshold = config.warningThreshold ?? 0.9;
  return {
    totalBudget: config.totalBudget,
    used: 0,
    remaining: config.totalBudget,
    usageRatio: 0,
    isExceeded: false,
    isNearLimit: false,
  };
}

// ─── 消耗 Token ───

export function consumeTokens(
  tracker: BudgetTracker,
  inputTokens: number,
  outputTokens: number,
  config: BudgetConfig,
): { tracker: BudgetTracker; shouldStop: boolean } {
  const newUsed = tracker.used + inputTokens + outputTokens;
  const newRemaining = Math.max(0, tracker.totalBudget - newUsed);
  const newRatio = newUsed / tracker.totalBudget;
  const warningThreshold = config.warningThreshold ?? 0.9;

  const updated: BudgetTracker = {
    totalBudget: tracker.totalBudget,
    used: newUsed,
    remaining: newRemaining,
    usageRatio: newRatio,
    isExceeded: newUsed >= tracker.totalBudget,
    isNearLimit: newRatio >= warningThreshold,
  };

  return {
    tracker: updated,
    shouldStop: newUsed >= tracker.totalBudget,
  };
}

// ─── 检查单条消息是否超限 ───

export function isSingleMessageOverLimit(
  tokenCount: number,
  config: BudgetConfig,
): boolean {
  const maxSingle = config.maxSingleMessageTokens ?? Math.floor(config.totalBudget * 0.5);
  return tokenCount > maxSingle;
}

// ─── 预算检查结果 ───

export interface BudgetCheckResult {
  readonly canProceed: boolean;
  readonly reason?: "exceeded" | "near_limit" | "single_message_over_limit" | "overage_limit";
  readonly remaining: number;
}

/**
 * 综合预算检查。
 */
export function checkBudget(
  tracker: BudgetTracker,
  estimatedInputTokens: number,
  config: BudgetConfig,
): BudgetCheckResult {
  if (tracker.isExceeded) {
    return { canProceed: false, reason: "exceeded", remaining: 0 };
  }

  if (isSingleMessageOverLimit(estimatedInputTokens, config)) {
    return {
      canProceed: false,
      reason: "single_message_over_limit",
      remaining: tracker.remaining,
    };
  }

  const estimatedTotal = tracker.used + estimatedInputTokens + tracker.totalBudget * 0.1;
  if (estimatedTotal > tracker.totalBudget) {
    return {
      canProceed: false,
      reason: "near_limit",
      remaining: tracker.remaining,
    };
  }

  return { canProceed: true, remaining: tracker.remaining };
}

// ─── 创建 BudgetManager ───

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_OVERAGE_MULTIPLIER = 2;

export function createBudgetManager(config: BudgetManagerConfig): BudgetManager {
  const totalBudget = config.totalBudget;
  const warningThreshold = config.warningThreshold ?? 0.9;
  const maxOverageMultiplier = config.maxOverageMultiplier ?? DEFAULT_MAX_OVERAGE_MULTIPLIER;
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
  let mode: BudgetMode = config.mode ?? "enforce";

  const records: ConsumptionRecord[] = [];

  function pruneExpiredRecords(now: number): void {
    const cutoff = now - windowMs;
    while (records.length > 0 && records[0]!.timestamp < cutoff) {
      records.shift();
    }
  }

  function computeWindowUsage(): { inputTokens: number; outputTokens: number } {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const record of records) {
      inputTokens += record.inputTokens;
      outputTokens += record.outputTokens;
    }
    return { inputTokens, outputTokens };
  }

  function buildTracker(): BudgetTracker {
    const now = Date.now();
    pruneExpiredRecords(now);
    const usage = computeWindowUsage();
    const used = usage.inputTokens + usage.outputTokens;
    const remaining = Math.max(0, totalBudget - used);
    const usageRatio = totalBudget > 0 ? used / totalBudget : 0;

    return {
      totalBudget,
      used,
      remaining,
      usageRatio,
      isExceeded: used >= totalBudget,
      isNearLimit: usageRatio >= warningThreshold,
    };
  }

  function getEffectiveBudget(): number {
    if (mode === "warn") {
      return totalBudget * maxOverageMultiplier;
    }
    return totalBudget;
  }

  function consume(inputTokens: number, outputTokens: number): BudgetCheckResult {
    const now = Date.now();
    pruneExpiredRecords(now);

    records.push({ timestamp: now, inputTokens, outputTokens });

    const usage = computeWindowUsage();
    const used = usage.inputTokens + usage.outputTokens;
    const effectiveBudget = getEffectiveBudget();

    if (mode === "warn" && used > totalBudget && used <= effectiveBudget) {
      return {
        canProceed: true,
        reason: "overage_limit",
        remaining: Math.max(0, effectiveBudget - used),
      };
    }

    if (mode === "warn" && used > effectiveBudget) {
      mode = "enforce";
      return {
        canProceed: false,
        reason: "overage_limit",
        remaining: 0,
      };
    }

    const remaining = Math.max(0, totalBudget - used);
    const usageRatio = totalBudget > 0 ? used / totalBudget : 0;

    if (used >= totalBudget) {
      return { canProceed: false, reason: "exceeded", remaining: 0 };
    }

    if (usageRatio >= warningThreshold) {
      return { canProceed: true, reason: "near_limit", remaining };
    }

    return { canProceed: true, remaining };
  }

  function check(estimatedInputTokens: number): BudgetCheckResult {
    const tracker = buildTracker();
    const maxSingle = config.maxSingleMessageTokens ?? Math.floor(totalBudget * 0.5);

    if (isSingleMessageOverLimit(estimatedInputTokens, { totalBudget, maxSingleMessageTokens: maxSingle })) {
      return {
        canProceed: false,
        reason: "single_message_over_limit",
        remaining: tracker.remaining,
      };
    }

    return checkBudget(tracker, estimatedInputTokens, { totalBudget, warningThreshold, maxSingleMessageTokens: maxSingle });
  }

  function resetWindow(): void {
    records.length = 0;
  }

  return {
    consume,
    check,
    getTracker: buildTracker,
    getMode: () => mode,
    resetWindow,
  };
}

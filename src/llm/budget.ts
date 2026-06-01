/**
 * LLM Token 预算管理 — 阶段 E.1。
 *
 * 功能：
 * - LLMBudgetConfig 定义
 * - 预算检查中间件（每次 LLM 调用前检查）
 * - 预算耗尽时降级（返回空结果触发调用方降级）
 * - 预算使用统计（各模块的 LLM 调用次数和 token 消耗）
 */

// ─── 预算配置 ───

export interface LLMBudgetConfig {
  /** 总 token 预算（输入+输出），0 表示无限制 */
  readonly totalTokenBudget?: number;
  /** 单次调用最大 token 数，0 表示无限制 */
  readonly maxTokensPerCall?: number;
  /** 单个模块最大 token 配额，0 表示无限制 */
  readonly maxTokensPerModule?: number;
  /** 预算耗尽时的行为：'reject' 直接拒绝，'warn' 允许但记录警告 */
  readonly onBudgetExhausted?: "reject" | "warn";
}

// ─── 模块级别统计 ───

export interface ModuleBudgetStats {
  readonly callCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

// ─── 预算检查结果 ───

export interface BudgetCheckResult {
  /** 是否允许调用 */
  readonly allowed: boolean;
  /** 拒绝原因（allowed=false 时） */
  readonly reason?: string;
  /** 剩余 token 数 */
  readonly remainingTokens: number;
  /** 是否已超过模块配额 */
  readonly moduleExhausted: boolean;
}

// ─── 全局预算统计 ───

export interface BudgetStats {
  readonly totalCallCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokensUsed: number;
  readonly totalTokenBudget: number;
  readonly moduleStats: ReadonlyMap<string, ModuleBudgetStats>;
  readonly rejectedCalls: number;
}

// ─── 默认值 ───

const DEFAULT_TOTAL_BUDGET = 1_000_000; // 1M tokens
const DEFAULT_MAX_PER_CALL = 10_000; // 10K tokens per call
const DEFAULT_MAX_PER_MODULE = 200_000; // 200K tokens per module

// ─── 创建预算管理器 ───

export interface LLMBudgetManager {
  /** 检查是否允许调用 */
  checkBudget(module: string, estimatedTokens?: number): BudgetCheckResult;
  /** 记录 token 使用 */
  recordUsage(module: string, inputTokens: number, outputTokens: number): void;
  /** 获取全局统计 */
  getStats(): BudgetStats;
  /** 重置预算 */
  reset(): void;
  /** 检查预算是否已耗尽 */
  isExhausted(): boolean;
}

export function createBudgetManager(config?: LLMBudgetConfig): LLMBudgetManager {
  const totalBudget = config?.totalTokenBudget ?? DEFAULT_TOTAL_BUDGET;
  const maxPerCall = config?.maxTokensPerCall ?? DEFAULT_MAX_PER_CALL;
  const maxPerModule = config?.maxTokensPerModule ?? DEFAULT_MAX_PER_MODULE;
  const onExhausted = config?.onBudgetExhausted ?? "reject";

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCallCount = 0;
  let rejectedCalls = 0;

  const moduleStats = new Map<string, { callCount: number; inputTokens: number; outputTokens: number }>();

  function checkBudget(module: string, estimatedTokens?: number): BudgetCheckResult {
    const totalUsed = totalInputTokens + totalOutputTokens;
    const remaining = Math.max(0, totalBudget - totalUsed);

    // 检查总预算
    if (totalBudget > 0 && totalUsed >= totalBudget) {
      if (onExhausted === "reject") {
        rejectedCalls++;
        return { allowed: false, reason: "Total token budget exhausted", remainingTokens: 0, moduleExhausted: false };
      }
      // warn 模式：允许但记录
    }

    // 检查单次调用限制
    if (maxPerCall > 0 && estimatedTokens !== undefined && estimatedTokens > maxPerCall) {
      rejectedCalls++;
      return {
        allowed: false,
        reason: `Estimated tokens (${estimatedTokens}) exceeds per-call limit (${maxPerCall})`,
        remainingTokens: remaining,
        moduleExhausted: false,
      };
    }

    // 检查模块配额（仅在总预算 > 0 时生效）
    const stats = moduleStats.get(module);
    const moduleUsed = stats !== undefined ? stats.inputTokens + stats.outputTokens : 0;
    const moduleExhausted = totalBudget > 0 && maxPerModule > 0 && moduleUsed >= maxPerModule;

    if (moduleExhausted && onExhausted === "reject") {
      rejectedCalls++;
      return {
        allowed: false,
        reason: `Module "${module}" token quota exhausted (${moduleUsed}/${maxPerModule})`,
        remainingTokens: remaining,
        moduleExhausted: true,
      };
    }

    return { allowed: true, remainingTokens: remaining, moduleExhausted };
  }

  function recordUsage(module: string, inputTokens: number, outputTokens: number): void {
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalCallCount++;

    let stats = moduleStats.get(module);
    if (stats === undefined) {
      stats = { callCount: 0, inputTokens: 0, outputTokens: 0 };
      moduleStats.set(module, stats);
    }
    stats.callCount++;
    stats.inputTokens += inputTokens;
    stats.outputTokens += outputTokens;
  }

  function getStats(): BudgetStats {
    const readonlyModuleStats = new Map<string, ModuleBudgetStats>();
    for (const [key, val] of moduleStats) {
      readonlyModuleStats.set(key, {
        callCount: val.callCount,
        inputTokens: val.inputTokens,
        outputTokens: val.outputTokens,
        totalTokens: val.inputTokens + val.outputTokens,
      });
    }

    return {
      totalCallCount,
      totalInputTokens,
      totalOutputTokens,
      totalTokensUsed: totalInputTokens + totalOutputTokens,
      totalTokenBudget: totalBudget,
      moduleStats: readonlyModuleStats,
      rejectedCalls,
    };
  }

  function reset(): void {
    totalInputTokens = 0;
    totalOutputTokens = 0;
    totalCallCount = 0;
    rejectedCalls = 0;
    moduleStats.clear();
  }

  function isExhausted(): boolean {
    if (totalBudget <= 0) return false;
    return (totalInputTokens + totalOutputTokens) >= totalBudget;
  }

  return { checkBudget, recordUsage, getStats, reset, isExhausted };
}

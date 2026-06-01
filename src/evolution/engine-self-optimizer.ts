/**
 * 引擎自优化器（P4-11）— 分析任务统计并自动调整引擎参数。
 *
 * 参考 SYSTEM_DESIGN.md 3.5.4。
 * 触发条件：启用 + 最小任务数(50) + 间隔(100)。
 * 三种分析策略 + 性能退化检测。
 */

import {
  ENGINE_SELF_OPT_MIN_TASKS,
  ENGINE_SELF_OPT_INTERVAL,
  ENGINE_SELF_OPT_ROLLBACK_ON_DEGRADE,
  PROMOTION_IMPROVEMENT_MIN,
  EVOLUTION_DEPRECATE_THRESHOLD,
  EVOLUTION_SANDBOX_MIN_SUCCESS_RATE,
} from "./constants";
import {
  isEvolvable,
  validateProposal,
} from "./constitutional-guard";
import { filterArchitectureKeywords } from "../security/llm-sanitize";
import type { SimpleLLMProvider } from "../llm/adapter";
import { extractJSONArray, safeJSONParse } from "../utils/llm-parse";
import { z } from "zod";

// ─── 类型定义 ───

export interface TaskStats {
  readonly totalTasks: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly avgExecutionTimeMs: number;
  readonly successRate: number;
  readonly deprecationRate: number;
  readonly bWinRate: number;
}

export interface OptimizationProposal {
  readonly paramName: string;
  readonly currentValue: number;
  readonly proposedValue: number;
  readonly reason: string;
}

export interface OptimizationResult {
  readonly proposals: readonly OptimizationProposal[];
  readonly rollbacks: readonly string[];
}

export interface EngineSelfOptimizerConfig {
  readonly enabled?: boolean;
  readonly minTasks?: number;
  readonly interval?: number;
  readonly rollbackOnDegrade?: boolean;
  readonly llmProvider?: SimpleLLMProvider;
}

// ─── 引擎自优化器 ───

/**
 * createEngineSelfOptimizer — 创建引擎自优化器。
 */
export function createEngineSelfOptimizer(config?: EngineSelfOptimizerConfig) {
  const enabled = config?.enabled ?? true;
  const minTasks = config?.minTasks ?? ENGINE_SELF_OPT_MIN_TASKS;
  const interval = config?.interval ?? ENGINE_SELF_OPT_INTERVAL;
  const rollbackOnDegrade = config?.rollbackOnDegrade ?? true;
  const llmProvider = config?.llmProvider;

  // D.1: LLM 优化提案缓存
  const llmProposalCache = new Map<string, OptimizationProposal[]>();

  function cacheKey(stats: TaskStats, config: Readonly<Record<string, unknown>>): string {
    return `sr=${stats.successRate.toFixed(2)}|dr=${stats.deprecationRate.toFixed(2)}|bwr=${stats.bWinRate.toFixed(2)}`;
  }

  async function llmAnalyzeOptimization(
    provider: SimpleLLMProvider,
    taskStats: TaskStats,
    currentConfig: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      const response = await provider.invoke([
        {
          role: "system",
          content: `You are an engine self-optimizer. Given these task statistics, suggest optimization proposals. Respond with a JSON array of objects, each with: "param" (one of: promotion_improvement_threshold, deprecation_rate_threshold, sandbox_min_success_rate), "value" (number), "reason" (string). Max 3 proposals. If no optimization needed, return []. Use English field names in JSON output.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            successRate: taskStats.successRate,
            deprecationRate: taskStats.deprecationRate,
            bWinRate: taskStats.bWinRate,
            totalTasks: taskStats.totalTasks,
            currentConfig: Object.fromEntries(
              Object.entries(currentConfig)
                .filter(([k]) => isEvolvable(k))
                .map(([k, v]) => [filterArchitectureKeywords(k), v]),
            ),
          }),
        },
      ], { temperature: 0 });

      const jsonStr = extractJSONArray(response);
      if (!jsonStr) return;

      const rawParsed = safeJSONParse(jsonStr);
      if (!Array.isArray(rawParsed)) return;

      const LLMOptimizationProposalSchema = z.object({
        param: z.string(),
        value: z.number(),
        reason: z.string().optional(),
      });

      const PARAM_ALIAS_MAP: Readonly<Record<string, string>> = {
        promotion_improvement_threshold: "PROMOTION_IMPROVEMENT_MIN",
        deprecation_rate_threshold: "DEPRECATION_RATE_MIN",
        sandbox_min_success_rate: "EVOLUTION_SANDBOX_MIN_SUCCESS_RATE",
        PROMOTION_IMPROVEMENT_MIN: "PROMOTION_IMPROVEMENT_MIN",
        DEPRECATION_RATE_MIN: "DEPRECATION_RATE_MIN",
        EVOLUTION_SANDBOX_MIN_SUCCESS_RATE: "EVOLUTION_SANDBOX_MIN_SUCCESS_RATE",
      };

      const proposals: OptimizationProposal[] = [];

      for (const item of rawParsed) {
        const validated = LLMOptimizationProposalSchema.safeParse(item);
        if (!validated.success) continue;
        const v = validated.data;

        const internalParam = PARAM_ALIAS_MAP[v.param];
        if (internalParam === undefined) continue;

        const current = (currentConfig[internalParam] as number) ?? 0;
        const validation = validateProposal(internalParam, v.value);
        if (validation.valid) {
          proposals.push({
            paramName: internalParam,
            currentValue: current,
            proposedValue: (validation.clampedValue ?? v.value) as number,
            reason: filterArchitectureKeywords(
              typeof v.reason === "string" ? v.reason : "LLM suggested optimization",
            ),
          });
        }
      }

      if (proposals.length > 0) {
        llmProposalCache.set(cacheKey(taskStats, currentConfig), proposals);
      }
    } catch {
      // LLM 分析失败，保持规则模式
    }
  }

  /** 固定规则优化策略（降级模式） */
  function ruleBasedOptimization(
    taskStats: TaskStats,
    currentConfig: Readonly<Record<string, unknown>>,
    proposals: OptimizationProposal[],
  ): OptimizationProposal[] {
    // 策略 1：成功率 < 50% → 放宽 PROMOTION_IMPROVEMENT_MIN
    if (taskStats.successRate < 0.5) {
      const current = (currentConfig["PROMOTION_IMPROVEMENT_MIN"] as number) ?? PROMOTION_IMPROVEMENT_MIN;
      const proposed = Math.max(0.05, current * 0.8);
      const validation = validateProposal("PROMOTION_IMPROVEMENT_MIN", proposed);
      if (validation.valid) {
        proposals.push({
          paramName: "PROMOTION_IMPROVEMENT_MIN",
          currentValue: current,
          proposedValue: (validation.clampedValue ?? proposed) as number,
          reason: filterArchitectureKeywords(
            `Low success rate (${Math.round(taskStats.successRate * 100)}%): relaxing promotion threshold`,
          ),
        });
      }
    }

    // 策略 2：淘汰率 > 30% → 收紧 DEPRECATION_RATE_MIN
    if (taskStats.deprecationRate > 0.3) {
      const current = (currentConfig["DEPRECATION_RATE_MIN"] as number) ?? EVOLUTION_DEPRECATE_THRESHOLD;
      const proposed = Math.min(0.5, current * 1.2);
      const validation = validateProposal("DEPRECATION_RATE_MIN", proposed);
      if (validation.valid) {
        proposals.push({
          paramName: "DEPRECATION_RATE_MIN",
          currentValue: current,
          proposedValue: (validation.clampedValue ?? proposed) as number,
          reason: filterArchitectureKeywords(
            `High deprecation rate (${Math.round(taskStats.deprecationRate * 100)}%): tightening deprecation threshold`,
          ),
        });
      }
    }

    // 策略 3：B 胜率 < 20% → 降低 EVOLUTION_SANDBOX_MIN_SUCCESS_RATE
    if (taskStats.bWinRate < 0.2 && taskStats.bWinRate > 0) {
      const current = (currentConfig["EVOLUTION_SANDBOX_MIN_SUCCESS_RATE"] as number) ?? EVOLUTION_SANDBOX_MIN_SUCCESS_RATE;
      const proposed = Math.max(0.3, current * 0.85);
      const validation = validateProposal("EVOLUTION_SANDBOX_MIN_SUCCESS_RATE", proposed);
      if (validation.valid) {
        proposals.push({
          paramName: "EVOLUTION_SANDBOX_MIN_SUCCESS_RATE",
          currentValue: current,
          proposedValue: (validation.clampedValue ?? proposed) as number,
          reason: filterArchitectureKeywords(
            `Low B win rate (${Math.round(taskStats.bWinRate * 100)}%): lowering sandbox success rate threshold`,
          ),
        });
      }
    }

    return proposals;
  }

  let lastOptimizeTask = 0;
  let baselineSuccessRate: number | null = null;
  const appliedOptimizations = new Map<string, number>();

  return {
    /**
     * shouldOptimize — 检查是否应该触发自优化。
     */
    shouldOptimize(totalTasks: number): boolean {
      if (!enabled) return false;
      if (totalTasks < minTasks) return false;
      if (lastOptimizeTask === 0) {
        return totalTasks >= minTasks;
      }
      if (totalTasks - lastOptimizeTask < interval) return false;
      return true;
    },

    /**
     * analyzeAndPropose — 分析任务统计并提出优化建议。
     */
    analyzeAndPropose(
      taskStats: TaskStats,
      currentConfig: Readonly<Record<string, unknown>>,
    ): OptimizationProposal[] {
      const proposals: OptimizationProposal[] = [];

      // 记录基线
      if (baselineSuccessRate === null) {
        baselineSuccessRate = taskStats.successRate;
        return proposals;
      }

      // 性能退化检测
      if (rollbackOnDegrade) {
        const degradation = baselineSuccessRate - taskStats.successRate;
        if (degradation > ENGINE_SELF_OPT_ROLLBACK_ON_DEGRADE) {
          return [];
        }
      }

      // D.1: 有 LLM Provider 时使用 LLM 多维度分析（异步预填充缓存）
      if (llmProvider) {
        void llmAnalyzeOptimization(llmProvider, taskStats, currentConfig);
      }

      // 检查 LLM 缓存是否有结果
      const cachedProposals = llmProposalCache.get(cacheKey(taskStats, currentConfig));
      if (cachedProposals && cachedProposals.length > 0) {
        return cachedProposals;
      }

      // 降级：固定规则优化策略
      return ruleBasedOptimization(taskStats, currentConfig, proposals);
    },

    /**
     * applyOptimization — 应用优化。
     */
    applyOptimization(proposal: OptimizationProposal): Record<string, unknown> {
      appliedOptimizations.set(proposal.paramName, proposal.proposedValue);
      return { [proposal.paramName]: proposal.proposedValue };
    },

    /**
     * rollbackOptimization — 回退优化。
     */
    rollbackOptimization(paramName: string): Record<string, unknown> | null {
      if (!appliedOptimizations.has(paramName)) return null;
      appliedOptimizations.delete(paramName);
      return { [paramName]: null }; // 信号：恢复默认值
    },

    /** 获取已应用的优化 */
    getAppliedOptimizations(): ReadonlyMap<string, number> {
      return appliedOptimizations;
    },

    /** 更新基线 */
    updateBaseline(successRate: number): void {
      baselineSuccessRate = successRate;
    },

    /** 获取当前基线 */
    getBaseline(): number | null {
      return baselineSuccessRate;
    },
  };
}

export type EngineSelfOptimizer = ReturnType<typeof createEngineSelfOptimizer>;

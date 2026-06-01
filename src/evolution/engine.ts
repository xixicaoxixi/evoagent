/**
 * EvolutionEngine — 进化引擎统一入口。
 *
 * 整合 trigger-budget + rule-analyzer + lifecycle + ab-judge，
 * 提供 on_task_completed() 调度链。
 *
 * 参考 SYSTEM_DESIGN.md 3.4.7 调度链设计。
 */

import type { RuleStore } from "./rule-store";
import type { EMACalculator } from "./ema";
import type { ErrorRecord } from "../schemas/evolution";
import type { SimpleLLMProvider } from "../llm/adapter";
import {
  EVOLUTION_UPDATE_PERIOD,
  BASELINE_MIN_TASKS,
  EVAL_WEIGHT_ADAPT_INTERVAL,
  DEFAULT_TASK_TYPE_IMPORTANCE,
  STRATEGY_EXPLORE_EVAL_WINDOW,
  MAX_AUTO_REGISTERED_TOOLS,
} from "./constants";
import { RuleStatus } from "../types/evolution";
import { createTriggerBudget, type TriggerBudget } from "./trigger-budget";
import { createEMACalculator, type TrendDirection } from "./ema";
import {
  runLifecycleManagement,
  type LifecycleManagementResult,
} from "./lifecycle";
import { analyzeWithRules, analyzeWithLLM, type AnalysisResult } from "./rule-analyzer";
import {
  createStrategyExplorer,
  type StrategyExplorer,
  type ExplorationResult,
} from "./strategy-explorer";
import {
  createWeightAdapter,
  type WeightAdapter,
} from "./weight-adapter";
import { createToolGenerator, type ToolGenerator, type GeneratedTool } from "./tool-generator";
import {
  createEngineSelfOptimizer,
  type EngineSelfOptimizer,
  type TaskStats,
} from "./engine-self-optimizer";
import { createAsyncLock } from "../utils/async-lock";
import { createLogger, type Logger } from "../observability/logger";

// ─── 任务完成输入 ───

export interface TaskCompletedInput {
  readonly success: boolean;
  readonly taskType: string;
  readonly executionTimeMs: number;
  readonly tokensUsed: number;
  readonly goal: string;
  readonly errorMessage?: string;
  readonly errorCategory?: string;
}

// ─── 引擎状态 ───

export interface EvolutionEngineState {
  readonly totalTasks: number;
  readonly successTasks: number;
  readonly globalSuccessRate: number;
  readonly baselineSuccessRate: number;
  readonly baselineRecorded: boolean;
  readonly lastLifecycleRun: number;
  readonly lastStrategyExplore: number;
  readonly lastWeightAdapt: number;
  readonly lastSelfOptimize: number;
  readonly llmAnalysisSuccessRate: number;
  readonly ruleAnalysisSuccessRate: number;
  readonly recentPromotionRollbacks: number;
  readonly pendingRules: number;
  readonly sandboxRules: number;
  readonly probationRules: number;
  readonly activeRules: number;
}

// ─── 引擎配置 ───

export interface EvolutionEngineConfig {
  readonly ruleStore: RuleStore;
  readonly updatePeriod?: number;
  readonly llmProvider?: SimpleLLMProvider;
  readonly onToolGenerated?: (tool: GeneratedTool) => void;
}

// ─── 进化引擎 ───

export interface EvolutionEngine {
  /** 任务完成回调（调度链入口） */
  onTaskCompleted(input: TaskCompletedInput): Promise<void>;

  /** 分析错误并生成规则建议 */
  analyzeError(input: TaskCompletedInput): AnalysisResult;

  /** 获取引擎状态 */
  getState(): EvolutionEngineState;

  /** 运行生命周期管理（手动触发） */
  runLifecycle(): Promise<LifecycleManagementResult>;

  /** 获取规则存储引用 */
  getRuleStore(): RuleStore;

  /** 获取触发预算引用 */
  getTriggerBudget(): TriggerBudget;

  /** 获取 EMA 计算器引用 */
  getEMACalculator(): EMACalculator;
}

// ─── 创建进化引擎 ───

export function createEvolutionEngine(
  config: EvolutionEngineConfig,
): EvolutionEngine {
  const updatePeriod = config.updatePeriod ?? EVOLUTION_UPDATE_PERIOD;
  const ruleStore = config.ruleStore;
  const llmProvider = config.llmProvider;
  const onToolGenerated = config.onToolGenerated;
  const triggerBudget = createTriggerBudget();
  let emaCalculator: EMACalculator = createEMACalculator(0);

  const strategyExplorer = createStrategyExplorer(
    llmProvider !== undefined ? { llmProvider } : undefined,
  );
  const weightAdapter = createWeightAdapter(DEFAULT_TASK_TYPE_IMPORTANCE);
  const toolGenerator = createToolGenerator();
  const selfOptimizer = createEngineSelfOptimizer(
    llmProvider !== undefined ? { llmProvider } : undefined,
  );

  const stateLock = createAsyncLock();
  const logger = createLogger({ source: "evolution:engine" });

  let totalTasks = 0;
  let successTasks = 0;
  let baselineSuccessRate = 0;
  let baselineRecorded = false;
  let lastLifecycleRun = 0;
  let lastStrategyExplore = 0;
  let lastWeightAdapt = 0;
  let lastSelfOptimize = 0;
  let autoRegisteredToolCount = 0;

  const llmAnalysisTracker = { total: 0, success: 0 };
  const ruleAnalysisTracker = { total: 0, success: 0 };
  let recentPromotionRollbacks = 0;
  const prePromotionSuccessRates: number[] = [];
  const MAX_ROLLBACK_HISTORY = 5;
  let cachedPendingRules = 0;
  let cachedSandboxRules = 0;
  let cachedProbationRules = 0;
  let cachedActiveRules = 0;

  // EMA 计算器映射（按 rule_id）
  const emaCalculators = new Map<string, EMACalculator>();

  // M8 + 管线#2: 可变引擎配置（策略探索扰动可回写）
  let engineConfig: Record<string, unknown> = {
    PROMOTION_IMPROVEMENT_MIN: 0.15,
    DEPRECATION_RATE_MIN: 0.3,
    EVOLUTION_SANDBOX_MIN_SUCCESS_RATE: 0.6,
    EVOLUTION_SANDBOX_MIN_TRIALS: 3,
  };

  // E11 + 管线#2: 活跃探索跟踪
  let activeExploration: {
    readonly experimentId: string;
    readonly paramName: string;
    readonly originalValue: number;
    readonly perturbedValue: number;
    readonly startTask: number;
    readonly prePerturbationSuccessRate: number;
  } | null = null;

  function getState(): EvolutionEngineState {
    return {
      totalTasks,
      successTasks,
      globalSuccessRate: totalTasks > 0 ? successTasks / totalTasks : 0,
      baselineSuccessRate,
      baselineRecorded,
      lastLifecycleRun,
      lastStrategyExplore,
      lastWeightAdapt,
      lastSelfOptimize,
      llmAnalysisSuccessRate: llmAnalysisTracker.total > 0 ? llmAnalysisTracker.success / llmAnalysisTracker.total : 0,
      ruleAnalysisSuccessRate: ruleAnalysisTracker.total > 0 ? ruleAnalysisTracker.success / ruleAnalysisTracker.total : 0,
      recentPromotionRollbacks,
      pendingRules: cachedPendingRules,
      sandboxRules: cachedSandboxRules,
      probationRules: cachedProbationRules,
      activeRules: cachedActiveRules,
    };
  }

  async function onTaskCompleted(input: TaskCompletedInput): Promise<void> {
    return stateLock.locked(async () => {
      totalTasks++;

      if (input.success) {
        successTasks++;
      }

      emaCalculator.update(input.success ? 1 : 0);

      if (!baselineRecorded && totalTasks >= BASELINE_MIN_TASKS) {
        baselineSuccessRate = successTasks / totalTasks;
        baselineRecorded = true;
        emaCalculator = createEMACalculator(baselineSuccessRate);
      }

      triggerBudget.incrementTotal();
      if (!input.success) {
        triggerBudget.incrementUsed();
      }

      if (!input.success && input.errorMessage) {
        const errorRecord: ErrorRecord = {
          error_id: `err_${Date.now()}`,
          task_id: `task_${totalTasks}`,
          error_type: input.errorCategory ?? "unknown",
          error_category: input.taskType,
          error_message: input.errorMessage,
          root_cause: "",
          suggested_fix: "",
          resolved: false,
          evolution_rule_id: "",
        };

        const analysis = llmProvider
          ? await analyzeWithLLM(errorRecord, llmProvider)
          : analyzeWithRules(errorRecord);

        if (analysis.source === "llm") {
          llmAnalysisTracker.total++;
          if (analysis.rule !== null) llmAnalysisTracker.success++;
        } else {
          ruleAnalysisTracker.total++;
          if (analysis.rule !== null) ruleAnalysisTracker.success++;
        }

        if (analysis.rule !== null) {
          logger.info("Rule analysis generated", {
            ruleId: analysis.rule.rule_id,
            action: analysis.rule.action,
            triggerPattern: analysis.rule.trigger_pattern,
            confidence: analysis.confidence,
          });
          const existing = await ruleStore.getById(analysis.rule.rule_id);
          if (existing !== undefined) {
            const triggerEntry = {
              timestamp: new Date().toISOString(),
              task_id: `task_${totalTasks}`,
              success: input.success,
              ...(input.errorMessage ? { error: input.errorMessage } : {}),
              tokens_used: input.tokensUsed,
            };

            const stateSpecificUpdates: Record<string, unknown> = {};

            if (existing.status === "SANDBOX") {
              stateSpecificUpdates.sandbox_trials = existing.sandbox_trials + 1;
              if (input.success) {
                stateSpecificUpdates.sandbox_successes = existing.sandbox_successes + 1;
              }
              stateSpecificUpdates.sandbox_success_rate =
                existing.sandbox_trials + 1 > 0
                  ? (existing.sandbox_successes + (input.success ? 1 : 0)) / (existing.sandbox_trials + 1)
                  : 0;
            }

            if (existing.status === "PROBATION") {
              stateSpecificUpdates.probation_task_count = existing.probation_task_count + 1;
              if (input.success) {
                stateSpecificUpdates.probation_success_count = existing.probation_success_count + 1;
              }
            }

            await ruleStore.update(existing.rule_id, {
              activation_count: existing.activation_count + 1,
              success_count: existing.success_count + (input.success ? 1 : 0),
              success_rate: (existing.success_count + (input.success ? 1 : 0)) /
                (existing.activation_count + 1),
              trigger_log: [...existing.trigger_log, triggerEntry],
              ...stateSpecificUpdates,
            });
          } else {
            await ruleStore.add(analysis.rule);
            logger.info("New rule added to store", {
              ruleId: analysis.rule.rule_id,
              action: analysis.rule.action,
            });
          }
        } else {
          logger.info("Rule analysis produced no rule", {
            confidence: analysis.confidence,
            reason: analysis.reason,
          });
        }

        if (llmProvider && toolGenerator.shouldGenerate(totalTasks, toolGenerator.getGeneratedCount())) {
          const generatedTool = await toolGenerator.generateToolWithLLM(
            input.errorMessage,
            toolGenerator.getGeneratedTools().map((t) => t.name),
            llmProvider,
          );
          if (generatedTool !== null && onToolGenerated !== undefined && autoRegisteredToolCount < MAX_AUTO_REGISTERED_TOOLS) {
            const sandboxValid = await toolGenerator.validateTool(generatedTool);
            if (sandboxValid) {
              onToolGenerated(generatedTool);
              autoRegisteredToolCount++;
            }
          }
        }
      }

      if (totalTasks - lastLifecycleRun >= updatePeriod) {
        const preLifecycleSuccessRate = totalTasks > 0 ? successTasks / totalTasks : 0;
        prePromotionSuccessRates.push(preLifecycleSuccessRate);
        if (prePromotionSuccessRates.length > MAX_ROLLBACK_HISTORY) {
          prePromotionSuccessRates.shift();
        }

        const result = await runLifecycleManagement(
          ruleStore,
          emaCalculators,
          baselineRecorded ? baselineSuccessRate : (totalTasks > 0 ? successTasks / totalTasks : 0),
        );

        logger.info("Lifecycle management completed", {
          transitions: result.transitions.map((t) => ({
            ruleId: t.ruleId,
            from: t.from,
            to: t.to,
            reason: t.reason,
          })),
          skipped: result.skipped.length,
          totalRules: await ruleStore.count(),
          activeRules: (await ruleStore.getActive()).length,
          sandboxRules: (await ruleStore.getByStatus(RuleStatus.SANDBOX)).length,
          probationRules: (await ruleStore.getByStatus(RuleStatus.PROBATION)).length,
        });

        if (result.transitions.length > 0 && prePromotionSuccessRates.length >= 2) {
          const promotedCount = result.transitions.filter(
            (t) => t.to === RuleStatus.ACTIVE || t.to === RuleStatus.PROBATION,
          ).length;
          const approvedCount = result.transitions.filter(
            (t) => t.from === RuleStatus.PENDING_APPROVAL && t.to === RuleStatus.SANDBOX,
          ).length;
          if (promotedCount > 0 || approvedCount > 0) {
            const postLifecycleSuccessRate = totalTasks > 0 ? successTasks / totalTasks : 0;
            const prevRate = prePromotionSuccessRates[prePromotionSuccessRates.length - 2]!;
            if (postLifecycleSuccessRate < prevRate - 0.05) {
              const promotedRuleIds = result.transitions
                .filter((t) => t.to === RuleStatus.ACTIVE || t.to === RuleStatus.PROBATION)
                .map((t) => t.ruleId);
              for (const ruleId of promotedRuleIds) {
                await ruleStore.update(ruleId, { status: RuleStatus.SANDBOX });
              }
              const approvedRuleIds = result.transitions
                .filter((t) => t.from === RuleStatus.PENDING_APPROVAL && t.to === RuleStatus.SANDBOX)
                .map((t) => t.ruleId);
              for (const ruleId of approvedRuleIds) {
                await ruleStore.update(ruleId, { status: RuleStatus.ROLLED_BACK });
              }
              recentPromotionRollbacks++;
            }
          }
        }

        const activeRules = await ruleStore.getActive();
        for (const rule of activeRules) {
          if (!emaCalculators.has(rule.rule_id)) {
            const ruleBaseline = baselineRecorded ? baselineSuccessRate : rule.success_rate;
            emaCalculators.set(rule.rule_id, createEMACalculator(ruleBaseline));
          }
        }

        lastLifecycleRun = totalTasks;

        cachedPendingRules = await ruleStore.countByStatus(RuleStatus.PENDING_APPROVAL);
        cachedSandboxRules = await ruleStore.countByStatus(RuleStatus.SANDBOX);
        cachedProbationRules = await ruleStore.countByStatus(RuleStatus.PROBATION);
        cachedActiveRules = await ruleStore.countByStatus(RuleStatus.ACTIVE);
      }

      if (baselineRecorded && totalTasks % (updatePeriod * 5) === 0) {
        const newBaseline = successTasks / totalTasks;
        if (Math.abs(newBaseline - baselineSuccessRate) > 0.05) {
          baselineSuccessRate = newBaseline;
          emaCalculator = createEMACalculator(baselineSuccessRate);
          logger.info("Baseline recalibrated", { newBaseline, totalTasks });
        }
      }

      if (activeExploration !== null && totalTasks - activeExploration.startTask >= STRATEGY_EXPLORE_EVAL_WINDOW) {
        const currentSuccessRate = totalTasks > 0 ? successTasks / totalTasks : 0;
        const improved = currentSuccessRate > activeExploration.prePerturbationSuccessRate;
        const metric = currentSuccessRate - activeExploration.prePerturbationSuccessRate;

        const experimentResult = strategyExplorer.recordExperimentResult(
          activeExploration.experimentId,
          {
            improved,
            metric,
            preRate: activeExploration.prePerturbationSuccessRate,
            postRate: currentSuccessRate,
            sampleSize: STRATEGY_EXPLORE_EVAL_WINDOW,
          },
        );

        if (!experimentResult.improved) {
          engineConfig[activeExploration.paramName] = activeExploration.originalValue;
        }

        activeExploration = null;
      }

      if (strategyExplorer.shouldExplore(totalTasks)) {
        const exploration = strategyExplorer.generatePerturbation(engineConfig, totalTasks);
        if (exploration !== null) {
          activeExploration = {
            experimentId: exploration.experimentId,
            paramName: exploration.paramName,
            originalValue: exploration.originalValue as number,
            perturbedValue: exploration.perturbedValue as number,
            startTask: totalTasks,
            prePerturbationSuccessRate: totalTasks > 0 ? successTasks / totalTasks : 0,
          };
          engineConfig[exploration.paramName] = exploration.perturbedValue;
          lastStrategyExplore = totalTasks;
        }
      }

      if (lastWeightAdapt === 0 || totalTasks - lastWeightAdapt >= EVAL_WEIGHT_ADAPT_INTERVAL) {
        if (weightAdapter.shouldAdapt()) {
          weightAdapter.adaptWeights();
        }
        lastWeightAdapt = totalTasks;
      }

      if (selfOptimizer.shouldOptimize(totalTasks)) {
        const waState = weightAdapter.getState();
        const taskStats: TaskStats = {
          totalTasks,
          successCount: successTasks,
          failureCount: totalTasks - successTasks,
          avgExecutionTimeMs: 0,
          successRate: totalTasks > 0 ? successTasks / totalTasks : 0,
          deprecationRate: 0,
          bWinRate: waState.totalAttempts > 0 ? waState.bWinCount / waState.totalAttempts : 0,
        };

        const proposals = selfOptimizer.analyzeAndPropose(taskStats, engineConfig);
        for (const proposal of proposals) {
          selfOptimizer.applyOptimization(proposal);
          engineConfig[proposal.paramName] = proposal.proposedValue;
        }
        lastSelfOptimize = totalTasks;
      }
    });
  }

  function analyzeError(input: TaskCompletedInput): AnalysisResult {
    const errorRecord: ErrorRecord = {
      error_id: `err_${Date.now()}`,
      task_id: `task_${totalTasks}`,
      error_type: input.errorCategory ?? "unknown",
      error_category: input.taskType,
      error_message: input.errorMessage ?? "Unknown error",
      root_cause: "",
      suggested_fix: "",
      resolved: false,
      evolution_rule_id: "",
    };
    // analyzeError 保持同步（降级模式），LLM 分析在 onTaskCompleted 中异步执行
    return analyzeWithRules(errorRecord);
  }

  async function runLifecycle(): Promise<LifecycleManagementResult> {
    return runLifecycleManagement(
      ruleStore,
      emaCalculators,
      baselineRecorded ? baselineSuccessRate : (totalTasks > 0 ? successTasks / totalTasks : 0),
    );
  }

  function getRuleStore(): RuleStore {
    return ruleStore;
  }

  function getTriggerBudget(): TriggerBudget {
    return triggerBudget;
  }

  function getEMACalculator(): EMACalculator {
    return emaCalculator;
  }

  return {
    onTaskCompleted,
    analyzeError,
    getState,
    runLifecycle,
    getRuleStore,
    getTriggerBudget,
    getEMACalculator,
  };
}

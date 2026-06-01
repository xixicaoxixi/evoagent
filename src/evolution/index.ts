/**
 * 进化引擎模块统一导出。
 */

// 常量
export {
  EVOLUTION_SANDBOX_MIN_TRIALS,
  EVOLUTION_SANDBOX_MIN_SUCCESS_RATE,
  PROBATION_MIN_TASKS,
  PROMOTION_IMPROVEMENT_MIN,
  PROMOTION_COST_MAX,
  EVOLUTION_DEPRECATE_THRESHOLD,
  EVOLUTION_DEPRECATE_MIN_ACTIVATIONS,
  MIN_EVALUATION_TRIGGERS,
  EVOLUTION_MIN_ACTIVE_RULES,
  EVOLUTION_RULE_MAX_COUNT,
  EVOLUTION_EMA_ALPHA,
  EVOLUTION_TREND_WINDOW,
  EVOLUTION_TREND_DIFF_THRESHOLD,
  EVOLUTION_VARIANCE_THRESHOLD,
  EVOLUTION_MAX_TRIGGER_BUDGET_RATIO,
  EVOLUTION_UPDATE_PERIOD,
  AB_TEST_JUDGE_WEIGHTS,
  AB_TEST_IMPROVEMENT_THRESHOLD,
  AB_TEST_COST_TOLERANCE,
  AB_TEST_A_WIN_THRESHOLD,
  CODE_SANDBOX_TIMEOUT,
  CODE_SANDBOX_MAX_SIZE_KB,
  TOOL_GEN_MIN_TASKS,
  TOOL_GEN_INTERVAL,
  TOOL_GEN_MAX_TOOLS,
  MAX_AUTO_REGISTERED_TOOLS,
  STRATEGY_EXPLORE_MIN_TASKS,
  STRATEGY_EXPLORE_INTERVAL,
  STRATEGY_EXPLORATION_PERTURBATION,
  ENGINE_SELF_OPT_MIN_TASKS,
  ENGINE_SELF_OPT_INTERVAL,
  ENGINE_SELF_OPT_ROLLBACK_ON_DEGRADE,
  EVAL_WEIGHT_ADAPT_INTERVAL,
  EVAL_WEIGHT_ADAPT_STEP,
  EVAL_WEIGHT_ADAPT_MIN,
  EVAL_WEIGHT_ADAPT_MAX,
  META_COMM_MIN_TRUST,
  META_COMM_MIN_AGE_DAYS,
  META_COMM_MAX_PROPOSALS_PER_SYNC,
} from "./constants";

// 规则存储
export { createMemoryRuleStore, createJSONLRuleStore, type RuleStore } from "./rule-store";

// 触发预算
export { createTriggerBudget, type TriggerBudget, type TriggerBudgetState, type TriggerBudgetCheck } from "./trigger-budget";

// EMA 趋势
export { createEMACalculator, calculateVariance, calculateCompositeScore, type EMACalculator, type TrendDirection } from "./ema";

// 生命周期管理
export {
  evaluateSandboxRules,
  evaluateProbationRules,
  autoDeprecateRules,
  runLifecycleManagement,
  type LifecycleTransition,
  type LifecycleManagementResult,
} from "./lifecycle";

// 规则验证
export { validateRule, detectConflict, fuzzyMatchAction, type RuleValidationResult, type ConflictResult } from "./rule-validator";

// 规则分析
export { analyzeWithRules, analyzeWithLLM, type AnalysisResult } from "./rule-analyzer";

// 宪法守卫
export {
  isConstitutional,
  isEvolvable,
  getEvolvableParamDef,
  listConstitutionalParams,
  listEvolvableParams,
  validateProposal,
  isImmutableScope,
  type EvolvableParamDef,
  type ProposalValidation,
} from "./constitutional-guard";

// 策略探索器
export { createStrategyExplorer, type StrategyExplorer, type ExplorationResult, type StrategyExplorerConfig, type ExplorationHistoryEntry } from "./strategy-explorer";

// 引擎自优化器
export {
  createEngineSelfOptimizer,
  type EngineSelfOptimizer,
  type TaskStats,
  type OptimizationProposal,
  type OptimizationResult,
  type EngineSelfOptimizerConfig,
} from "./engine-self-optimizer";

// 代码沙箱
export { validateCode, executeInSandbox, type CodeValidationResult, type SandboxExecutionResult } from "./code-sandbox";

// A/B 测试裁判
export { judgeABTest, type ABTestInput, type ABTestVerdict, type TrialResult } from "./ab-judge";

// 权重适配器
export { createWeightAdapter, type WeightAdapter, type WeightAdapterState } from "./weight-adapter";

// 工具生成器
export { createToolGenerator, type ToolGenerator, type GeneratedTool, type ToolGeneratorConfig, createToolFromGenerated, canRegisterTool } from "./tool-generator";

// 二阶交流器
export { createMetaCommunicator, type MetaCommunicator, type MetaProposal, type ProposalFilterResult } from "./meta-communicator";

// 进化引擎统一入口
export {
  createEvolutionEngine,
  type EvolutionEngine,
  type EvolutionEngineConfig,
  type EvolutionEngineState,
  type TaskCompletedInput,
} from "./engine";

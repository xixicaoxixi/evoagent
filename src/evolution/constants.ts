/**
 * 进化引擎阈值常量。
 *
 * 参考 SYSTEM_DESIGN.md 8.2 关键阈值表。
 * 所有常量使用 Fail-Closed 默认值（安全优先）。
 */

// ─── 沙盒阶段阈值 ───

/** 沙盒阶段最少执行次数 */
export const EVOLUTION_SANDBOX_MIN_TRIALS = 2;

/** 沙盒通过门槛（成功率） */
export const EVOLUTION_SANDBOX_MIN_SUCCESS_RATE = 0.4;

// ─── 试运行阶段阈值 ───

/** Probation 阶段最少验证任务数 */
export const PROBATION_MIN_TASKS = 5;

/** 晋升 ACTIVE 的最小改善幅度 */
export const PROMOTION_IMPROVEMENT_MIN = 0.05;

/** 晋升允许的最大额外成本 */
export const PROMOTION_COST_MAX = 0.10;

/** Probation 超时天数 */
export const EVOLUTION_PROBATION_MAX_DURATION_DAYS = 7;

// ─── 淘汰阈值 ───

/** 低于此成功率触发淘汰 */
export const EVOLUTION_DEPRECATE_THRESHOLD = 0.3;

/** 淘汰最少触发次数 */
export const EVOLUTION_DEPRECATE_MIN_ACTIVATIONS = 5;

/** 低于此跳过评估 */
export const MIN_EVALUATION_TRIGGERS = 5;

/** 保底最少活跃规则数 */
export const EVOLUTION_MIN_ACTIVE_RULES = 1;

/** 宪法层规则总数上限 */
export const EVOLUTION_RULE_MAX_COUNT = 50;

// ─── EMA 趋势 ───

/** EMA 趋势平滑系数 */
export const EVOLUTION_EMA_ALPHA = 0.1;

/** 趋势检测窗口 */
export const EVOLUTION_TREND_WINDOW = 10;

/** 趋势差异判定阈值 */
export const EVOLUTION_TREND_DIFF_THRESHOLD = 0.1;

// ─── 生命周期管理 ───

/** 每N次任务运行生命周期管理 */
export const EVOLUTION_UPDATE_PERIOD = 5;

/** 自动审批每轮最多审批规则数 */
export const AUTO_APPROVE_MAX_PER_CYCLE = 5;

/** 自动审批回滚阈值（成功率下降超过此值则回退） */
export const AUTO_APPROVE_ROLLBACK_THRESHOLD = 0.05;

/** 触发预算比例上限 */
export const EVOLUTION_MAX_TRIGGER_BUDGET_RATIO = 0.2;

/** 触发预算滑动窗口大小（只统计最近 N 次任务） */
export const EVOLUTION_TRIGGER_BUDGET_WINDOW = 100;

/** 触发预算宽限期（前 N 次任务不计入预算） */
export const TRIGGER_BUDGET_GRACE_PERIOD = 5;

/** 方差阈值（超过此值降低优先级） */
export const EVOLUTION_VARIANCE_THRESHOLD = 0.15;

// ─── 基线 ───

/** 记录 E0 基线的最少任务数 */
export const BASELINE_MIN_TASKS = 20;

// ─── 快照 ───

/** 最多保留快照数 */
export const SNAPSHOT_MAX_COUNT = 10;

/** 快照自动过期天数 */
export const SNAPSHOT_AUTO_EXPIRE_DAYS = 30;

// ─── 消融测试 ───

/** 消融测试间隔（任务数） */
export const ABLATION_INTERVAL = 50;

// ─── 任务类型重要性权重 ───

/** 默认任务类型重要性 */
export const DEFAULT_TASK_TYPE_IMPORTANCE: Readonly<Record<string, number>> = {
  coding: 1.0,
  analysis: 0.8,
  research: 0.6,
  generation: 0.7,
  default: 0.5,
};

// ─── A/B 测试 ───

/** B 胜所需最小改善率 */
export const AB_TEST_IMPROVEMENT_THRESHOLD = 0.10;

/** B 胜允许的最大成本增长 */
export const AB_TEST_COST_TOLERANCE = 0.15;

/** A 胜判定阈值 */
export const AB_TEST_A_WIN_THRESHOLD = -0.05;

/** A/B 测试最低样本量（M6: 低于此数返回 TIE + insufficient_samples） */
export const AB_TEST_MIN_SAMPLE_SIZE = 5;

// ─── 代码沙箱 ───

/** 代码沙箱超时（秒） */
export const CODE_SANDBOX_TIMEOUT = 30;

/** 代码最大体积（KB） */
export const CODE_SANDBOX_MAX_SIZE_KB = 100;

// ─── 工具生成 ───

/** 工具生成最小任务数 */
export const TOOL_GEN_MIN_TASKS = 15;

/** 工具生成间隔（任务数） */
export const TOOL_GEN_INTERVAL = 30;

/** 最大自动生成工具数 */
export const TOOL_GEN_MAX_TOOLS = 20;

/** 自动注册到工具集的最大工具数 */
export const MAX_AUTO_REGISTERED_TOOLS = 5;

// ─── 策略探索 ───

/** 策略探索最小任务数 */
export const STRATEGY_EXPLORE_MIN_TASKS = 30;

/** 策略探索间隔（任务数） */
export const STRATEGY_EXPLORE_INTERVAL = 50;

/** 策略探索扰动幅度 */
export const STRATEGY_EXPLORATION_PERTURBATION = 0.15;

/** 策略探索评估窗口（扰动后 N 次任务评估效果） */
export const STRATEGY_EXPLORE_EVAL_WINDOW = 10;

// ─── 引擎自优化 ───

/** 引擎自优化最小任务数 */
export const ENGINE_SELF_OPT_MIN_TASKS = 30;

/** 引擎自优化间隔（任务数） */
export const ENGINE_SELF_OPT_INTERVAL = 50;

/** 性能退化回退阈值 */
export const ENGINE_SELF_OPT_ROLLBACK_ON_DEGRADE = 0.10;

// ─── 权重适配 ───

/** 权重适配间隔（尝试次数） */
export const EVAL_WEIGHT_ADAPT_INTERVAL = 25;

/** 权重适配步长 */
export const EVAL_WEIGHT_ADAPT_STEP = 0.05;

/** 权重适配最小值 */
export const EVAL_WEIGHT_ADAPT_MIN = 0.05;

/** 权重适配最大值 */
export const EVAL_WEIGHT_ADAPT_MAX = 0.60;

// ─── 二阶交流 ───

/** 二阶交流最小信任度 */
export const META_COMM_MIN_TRUST = 0.7;

/** 二阶交流最小来源年龄（天） */
export const META_COMM_MIN_AGE_DAYS = 30;

/** 每次同步最大提案数 */
export const META_COMM_MAX_PROPOSALS_PER_SYNC = 3;

// ─── A/B 测试评估权重（宪法层，不可修改） ───

/** A/B 测试评估维度权重 */
export const AB_TEST_JUDGE_WEIGHTS: Readonly<Record<string, number>> = {
  success_rate: 0.40,
  execution_time: 0.25,
  stability: 0.20,
  code_complexity: 0.15,
};

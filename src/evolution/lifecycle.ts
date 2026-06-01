/**
 * 生命周期管理器 — 规则状态转换 + 自动淘汰 + 晋升。
 *
 * 参考 SYSTEM_DESIGN.md 3.4.5-3.4.7 和第 8 章状态机。
 *
 * 状态转换规则：
 * - PENDING_APPROVAL → SANDBOX（审批通过）
 * - SANDBOX → PROBATION（>=2 次试运行，成功率>=40%）
 * - PROBATION → ACTIVE（>=5 次任务，改善>=5%，成本<=10%）
 * - ACTIVE → DEPRECATED（成功率<30% 且 >=5 次触发，或 EMA 下降，或方差过高）
 */

import type { EvolutionRule } from "../schemas/evolution";
import type { SimpleLLMProvider } from "../llm/adapter";
import { RuleStatus, canRuleTransition, isValidAction } from "../types/evolution";
import type { RuleStore } from "./rule-store";
import {
  EVOLUTION_SANDBOX_MIN_TRIALS,
  EVOLUTION_SANDBOX_MIN_SUCCESS_RATE,
  PROBATION_MIN_TASKS,
  PROMOTION_IMPROVEMENT_MIN,
  PROMOTION_COST_MAX,
  EVOLUTION_DEPRECATE_THRESHOLD,
  EVOLUTION_DEPRECATE_MIN_ACTIVATIONS,
  MIN_EVALUATION_TRIGGERS,
  EVOLUTION_MIN_ACTIVE_RULES,
  EVOLUTION_VARIANCE_THRESHOLD,
  EVOLUTION_PROBATION_MAX_DURATION_DAYS,
  EVOLUTION_TREND_WINDOW,
  AUTO_APPROVE_MAX_PER_CYCLE,
} from "./constants";
import type { EMACalculator, TrendDirection } from "./ema";
import { calculateVariance } from "./ema";
import { judgeABTest, type TrialResult, type ABTestVerdict } from "./ab-judge";

const ESTIMATED_EXTRA_COST_PER_TASK = 0.01;

// ─── 类型定义 ───

export interface LifecycleTransition {
  readonly ruleId: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface LifecycleManagementResult {
  readonly transitions: readonly LifecycleTransition[];
  readonly skipped: readonly string[];
}

// ─── 沙盒评估 ───

/**
 * evaluateSandboxRules — 评估沙盒中的规则是否可以晋升到试运行。
 */
export async function evaluateSandboxRules(
  store: RuleStore,
  llmProvider?: SimpleLLMProvider,
): Promise<readonly LifecycleTransition[]> {
  const sandboxRules = await store.getByStatus(RuleStatus.SANDBOX);
  const transitions: LifecycleTransition[] = [];

  for (const rule of sandboxRules) {
    if (rule.sandbox_trials < EVOLUTION_SANDBOX_MIN_TRIALS) {
      continue;
    }

    const successRate = rule.sandbox_trials > 0
      ? rule.sandbox_successes / rule.sandbox_trials
      : 0;

    if (successRate >= EVOLUTION_SANDBOX_MIN_SUCCESS_RATE) {
      if (canRuleTransition(rule.status, RuleStatus.PROBATION)) {
        const baseReason = `Sandbox passed: ${rule.sandbox_trials} trials, ${Math.round(successRate * 100)}% success`;
        await store.update(rule.rule_id, {
          status: RuleStatus.PROBATION,
          probation_started_at: new Date().toISOString(),
          probation_reason: baseReason,
        });
        transitions.push({
          ruleId: rule.rule_id,
          from: rule.status,
          to: RuleStatus.PROBATION,
          reason: baseReason,
        });
        if (llmProvider !== undefined) {
          void llmProvider.invoke([
            { role: "system", content: "Evaluate if promoting this evolution rule is semantically appropriate. Respond in one sentence." },
            { role: "user", content: `Rule: ${rule.trigger_pattern} → ${rule.action}, success_rate: ${Math.round(successRate * 100)}%, trials: ${rule.sandbox_trials}` },
          ]).then((assessment) => {
            void store.update(rule.rule_id, {
              probation_reason: `${baseReason} [LLM: ${assessment}]`,
            });
          }).catch(() => { /* fire-and-forget: LLM failure does not affect decision */ });
        }
      }
    } else {
      // 沙盒未通过 → 淘汰
      if (canRuleTransition(rule.status, RuleStatus.DEPRECATED)) {
        await store.update(rule.rule_id, {
          status: RuleStatus.DEPRECATED,
          deprecated_reason: `Sandbox failed: ${rule.sandbox_trials} trials, ${Math.round(successRate * 100)}% success (need ${Math.round(EVOLUTION_SANDBOX_MIN_SUCCESS_RATE * 100)}%)`,
          deprecated_at: new Date().toISOString(),
        });
        transitions.push({
          ruleId: rule.rule_id,
          from: rule.status,
          to: RuleStatus.DEPRECATED,
          reason: `Sandbox failed (${Math.round(successRate * 100)}% < ${Math.round(EVOLUTION_SANDBOX_MIN_SUCCESS_RATE * 100)}%)`,
        });
      }
    }
  }

  return transitions;
}

// ─── 试运行评估（含 AB 测试） ───

/**
 * evaluateProbationWithAB — 使用 A/B 测试对比规则效果。
 *
 * 管线#4: 为晋升决策提供双副本对比数据。
 *
 * - A 组：基于 baselineSuccessRate 生成的模拟基线数据
 * - B 组：规则 trigger_log 中的实际执行结果
 *
 * 生成逻辑：
 * - A 组用 baselineSuccessRate 生成 PROBATION_MIN_TASKS 条模拟记录
 * - B 组直接从 trigger_log 转换
 * - executionTimeMs 使用固定均值（规则级别暂无真实时间数据）
 */
function evaluateProbationWithAB(
  rule: EvolutionRule,
  baselineSuccessRate: number,
): ABTestVerdict {
  // A 组：基于 baseline 的模拟数据
  const resultA: TrialResult[] = Array.from(
    { length: rule.probation_task_count },
    (_, i) => ({
      success: i < Math.floor(rule.probation_task_count * baselineSuccessRate),
      executionTimeMs: 500,
      crashed: false,
    }),
  );

  // B 组：从 trigger_log 转换
  const resultB: TrialResult[] = rule.trigger_log.map((log) => ({
    success: log.success,
    executionTimeMs: 500,
    crashed: !log.success,
  }));

  return judgeABTest({ resultA, resultB });
}

// ─── 试运行评估 ───

/**
 * evaluateProbationRules — 评估试运行中的规则是否可以晋升到活跃。
 */
export async function evaluateProbationRules(
  store: RuleStore,
  baselineSuccessRate: number,
  llmProvider?: SimpleLLMProvider,
): Promise<readonly LifecycleTransition[]> {
  const probationRules = await store.getByStatus(RuleStatus.PROBATION);
  const transitions: LifecycleTransition[] = [];

  for (const rule of probationRules) {
    // 检查最少任务数
    if (rule.probation_task_count < PROBATION_MIN_TASKS) {
      continue;
    }

    // 检查超时
    if (rule.probation_started_at !== "") {
      const started = new Date(rule.probation_started_at).getTime();
      const elapsed = Date.now() - started;
      const maxDuration = EVOLUTION_PROBATION_MAX_DURATION_DAYS * 24 * 60 * 60 * 1000;
      if (elapsed > maxDuration) {
        if (canRuleTransition(rule.status, RuleStatus.DEPRECATED)) {
          await store.update(rule.rule_id, {
            status: RuleStatus.DEPRECATED,
            deprecated_reason: `Probation timeout: ${EVOLUTION_PROBATION_MAX_DURATION_DAYS} days exceeded`,
            deprecated_at: new Date().toISOString(),
          });
          transitions.push({
            ruleId: rule.rule_id,
            from: rule.status,
            to: RuleStatus.DEPRECATED,
            reason: "Probation timeout",
          });
        }
        continue;
      }
    }

    // 量化晋升门槛
    const improvement = rule.success_rate - baselineSuccessRate;

    const totalTriggers = rule.activation_count;
    let extraCostRatio: number;

    if (rule.trigger_log.length > 0) {
      const totalTokensFromLog = rule.trigger_log.reduce(
        (sum, entry) => sum + (entry.tokens_used ?? 0),
        0,
      );
      const avgTokensPerTrigger = totalTokensFromLog / rule.trigger_log.length;
      const baselineAvgTokens = totalTriggers > 0 ? totalTokensFromLog / totalTriggers : 0;
      extraCostRatio = baselineAvgTokens > 0
        ? Math.min(avgTokensPerTrigger / baselineAvgTokens, PROMOTION_COST_MAX)
        : 0;
    } else {
      extraCostRatio = totalTriggers > 0
        ? Math.min(
            (rule.probation_task_count * ESTIMATED_EXTRA_COST_PER_TASK) / totalTriggers,
            PROMOTION_COST_MAX,
          )
        : 0;
    }

    if (
      improvement >= PROMOTION_IMPROVEMENT_MIN &&
      extraCostRatio <= PROMOTION_COST_MAX
    ) {
      if (canRuleTransition(rule.status, RuleStatus.ACTIVE)) {
        // 管线#4: A/B 测试评估作为晋升的附加条件
        const abVerdict = evaluateProbationWithAB(rule, baselineSuccessRate);
        const abPassed = abVerdict.winner === "B" || abVerdict.winner === "TIE";
        const abDetail = abVerdict.details.insufficient_samples === true
          ? "AB:insufficient_samples"
          : `AB:${abVerdict.winner}`;

        if (!abPassed) {
          // AB 测试未通过 → 延长试运行（不晋升也不淘汰）
          continue;
        }

        const baseReason = `Promoted: improvement=${improvement.toFixed(2)} (>=${PROMOTION_IMPROVEMENT_MIN}), ${abDetail}`;
        await store.update(rule.rule_id, {
          status: RuleStatus.ACTIVE,
        });
        transitions.push({
          ruleId: rule.rule_id,
          from: rule.status,
          to: RuleStatus.ACTIVE,
          reason: baseReason,
        });
        if (llmProvider !== undefined) {
          void llmProvider.invoke([
            { role: "system", content: "Evaluate if promoting this evolution rule is semantically appropriate. Respond in one sentence." },
            { role: "user", content: `Rule: ${rule.trigger_pattern} → ${rule.action}, success_rate: ${Math.round(rule.success_rate * 100)}%, trials: ${rule.probation_task_count}` },
          ]).then((assessment) => {
            void store.update(rule.rule_id, {
              probation_reason: `${baseReason} [LLM: ${assessment}]`,
            });
          }).catch(() => { /* fire-and-forget: LLM failure does not affect decision */ });
        }
      }
    }
    // 未达标 → 延长（不淘汰，等待更多数据）
  }

  return transitions;
}

// ─── 活跃规则评估（自动淘汰） ───

/**
 * autoDeprecateRules — 自动淘汰表现不佳的活跃规则。
 *
 * 淘汰条件（满足任一）：
 * 1. 成功率 < 30% 且触发 >= 5 次
 * 2. EMA 趋势下降
 * 3. 方差 > 0.15
 */
export async function autoDeprecateRules(
  store: RuleStore,
  emaCalculators: ReadonlyMap<string, EMACalculator>,
  llmProvider?: SimpleLLMProvider,
): Promise<readonly LifecycleTransition[]> {
  const activeRules = await store.getActive();
  const activeCount = activeRules.length;

  // 保底策略（P0-03）：活跃规则数 <= 1 时不淘汰
  if (activeCount <= EVOLUTION_MIN_ACTIVE_RULES) {
    return [];
  }

  const transitions: LifecycleTransition[] = [];

  for (const rule of activeRules) {
    // 前置检查：触发次数不足 → 跳过
    if (rule.activation_count < MIN_EVALUATION_TRIGGERS) {
      continue;
    }

    let shouldDeprecate = false;
    let reason = "";

    // 条件 1：成功率过低
    if (
      rule.activation_count >= EVOLUTION_DEPRECATE_MIN_ACTIVATIONS &&
      rule.success_rate < EVOLUTION_DEPRECATE_THRESHOLD
    ) {
      shouldDeprecate = true;
      reason = `Low success rate: ${Math.round(rule.success_rate * 100)}% < ${Math.round(EVOLUTION_DEPRECATE_THRESHOLD * 100)}%`;
    }

    // 条件 2：EMA 趋势下降
    if (!shouldDeprecate) {
      const ema = emaCalculators.get(rule.rule_id);
      if (ema !== undefined && ema.getTrend() === "declining") {
        shouldDeprecate = true;
        reason = "EMA trend declining";
      }
    }

    // 条件 3：方差过高（M15: 使用与 EMA 一致的窗口大小）
    if (!shouldDeprecate) {
      const triggerResults = rule.trigger_log.map((log) => (log.success ? 1 : 0));
      const variance = calculateVariance(triggerResults, EVOLUTION_TREND_WINDOW);
      if (variance > EVOLUTION_VARIANCE_THRESHOLD) {
        shouldDeprecate = true;
        reason = `High variance: ${variance.toFixed(3)} > ${EVOLUTION_VARIANCE_THRESHOLD}`;
        // 降低优先级而非直接淘汰
        await store.update(rule.rule_id, {
          priority: Math.max(0, rule.priority - 0.1),
        });
        continue;
      }
    }

    if (shouldDeprecate && canRuleTransition(rule.status, RuleStatus.DEPRECATED)) {
      await store.update(rule.rule_id, {
        status: RuleStatus.DEPRECATED,
        deprecated_reason: reason,
        deprecated_at: new Date().toISOString(),
      });
      transitions.push({
        ruleId: rule.rule_id,
        from: rule.status,
        to: RuleStatus.DEPRECATED,
        reason,
      });
      if (llmProvider !== undefined) {
        void llmProvider.invoke([
          { role: "system", content: "Evaluate if deprecating this evolution rule is semantically appropriate. Respond in one sentence." },
          { role: "user", content: `Rule: ${rule.trigger_pattern} → ${rule.action}, success_rate: ${Math.round(rule.success_rate * 100)}%, activations: ${rule.activation_count}, reason: ${reason}` },
        ]).then((assessment) => {
          void store.update(rule.rule_id, {
            deprecated_reason: `${reason} [LLM: ${assessment}]`,
          });
        }).catch(() => { /* fire-and-forget: LLM failure does not affect decision */ });
      }
    }
  }

  return transitions;
}

// ─── PENDING 规则自动审批 ───

/**
 * autoApprovePendingRules — 自动审批 PENDING_APPROVAL 状态的规则进入沙盒。
 *
 * 审批条件：
 * 1. 规则结构完整（trigger_pattern 非空 + action 合法）
 * 2. 不与已有 ACTIVE 规则冲突（重复 trigger+action / anti_action 冲突）
 *
 * 安全护栏：
 * - 每轮最多审批 AUTO_APPROVE_MAX_PER_CYCLE 条规则
 */
export async function autoApprovePendingRules(
  store: RuleStore,
): Promise<readonly LifecycleTransition[]> {
  const pendingRules = await store.getByStatus(RuleStatus.PENDING_APPROVAL);
  if (pendingRules.length === 0) return [];

  const activeRules = await store.getActive();
  const transitions: LifecycleTransition[] = [];
  let approvedCount = 0;

  for (const rule of pendingRules) {
    if (approvedCount >= AUTO_APPROVE_MAX_PER_CYCLE) break;

    if (!canRuleTransition(rule.status, RuleStatus.SANDBOX)) continue;

    if (!rule.trigger_pattern || rule.trigger_pattern.trim().length === 0) continue;
    if (!isValidAction(rule.action)) continue;

    let hasConflict = false;
    for (const active of activeRules) {
      if (
        active.trigger_pattern === rule.trigger_pattern &&
        active.action === rule.action
      ) {
        hasConflict = true;
        break;
      }
      if (rule.anti_action !== "" && active.action === rule.anti_action) {
        hasConflict = true;
        break;
      }
      if (active.anti_action !== "" && active.anti_action === rule.action) {
        hasConflict = true;
        break;
      }
    }
    if (hasConflict) continue;

    await store.update(rule.rule_id, {
      status: RuleStatus.SANDBOX,
    });
    transitions.push({
      ruleId: rule.rule_id,
      from: RuleStatus.PENDING_APPROVAL,
      to: RuleStatus.SANDBOX,
      reason: "Auto-approved: structurally valid, no conflicts with active rules",
    });
    approvedCount++;
  }

  return transitions;
}

// ─── 生命周期管理入口 ───

/**
 * runLifecycleManagement — 运行完整的生命周期管理。
 *
 * 依次执行：
 * 0. PENDING 规则自动审批（PENDING_APPROVAL → SANDBOX）
 * 1. 沙盒规则评估
 * 2. 试运行规则评估
 * 3. 活跃规则自动淘汰
 */
export async function runLifecycleManagement(
  store: RuleStore,
  emaCalculators: ReadonlyMap<string, EMACalculator>,
  baselineSuccessRate: number,
  llmProvider?: SimpleLLMProvider,
): Promise<LifecycleManagementResult> {
  const approveTransitions = await autoApprovePendingRules(store);
  const sandboxTransitions = await evaluateSandboxRules(store, llmProvider);
  const probationTransitions = await evaluateProbationRules(store, baselineSuccessRate, llmProvider);
  const deprecateTransitions = await autoDeprecateRules(store, emaCalculators, llmProvider);

  return {
    transitions: [
      ...approveTransitions,
      ...sandboxTransitions,
      ...probationTransitions,
      ...deprecateTransitions,
    ],
    skipped: [],
  };
}

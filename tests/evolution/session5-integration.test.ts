/**
 * 阶段 5 集成测试 — 进化引擎端到端流程。
 */

import { describe, expect, it, beforeEach } from "vitest";
import { createMemoryRuleStore, type RuleStore } from "../../src/evolution/rule-store";
import { createTriggerBudget } from "../../src/evolution/trigger-budget";
import { createEMACalculator } from "../../src/evolution/ema";
import {
  evaluateSandboxRules,
  evaluateProbationRules,
  autoDeprecateRules,
  runLifecycleManagement,
} from "../../src/evolution/lifecycle";
import { validateRule, detectConflict } from "../../src/evolution/rule-validator";
import { analyzeWithRules } from "../../src/evolution/rule-analyzer";
import {
  isConstitutional,
  isEvolvable,
  validateProposal,
} from "../../src/evolution/constitutional-guard";
import { createStrategyExplorer } from "../../src/evolution/strategy-explorer";
import { createEngineSelfOptimizer } from "../../src/evolution/engine-self-optimizer";
import { validateCode, executeInSandbox } from "../../src/evolution/code-sandbox";
import { judgeABTest } from "../../src/evolution/ab-judge";
import { createWeightAdapter } from "../../src/evolution/weight-adapter";
import { createToolGenerator } from "../../src/evolution/tool-generator";
import { createMetaCommunicator } from "../../src/evolution/meta-communicator";
import { RuleStatus } from "../../src/types/evolution";

// ─── 端到端：错误 → 规则生成 → 沙盒 → 晋升 ───

describe("Evolution Engine E2E: Error to Active Rule", () => {
  let store: RuleStore;

  beforeEach(() => {
    store = createMemoryRuleStore();
  });

  it("完整流程：错误分析 → 规则创建 → 沙盒 → 试运行 → 活跃", async () => {
    // 1. 模拟错误记录
    const error = {
      error_id: "err_timeout_1",
      task_id: "task_1",
      error_type: "timeout",
      error_category: "execution",
      error_message: "Task execution timed out after 30 seconds",
      root_cause: "Complex computation",
      suggested_fix: "",
      resolved: false,
      evolution_rule_id: "",
    };

    // 2. 分析错误 → 生成规则建议
    const analysis = analyzeWithRules(error);
    expect(analysis.rule).not.toBeNull();
    expect(analysis.confidence).toBeGreaterThan(0);

    // 3. 验证规则
    const validation = await validateRule(analysis.rule!, store);
    expect(validation.valid).toBe(true);

    // 4. 添加规则（PENDING_APPROVAL）
    const rule = await store.add(analysis.rule!);
    expect(rule.status).toBe("PENDING_APPROVAL");

    // 5. 审批 → SANDBOX
    const approved = await store.update(rule.rule_id, { status: "SANDBOX" });
    expect(approved?.status).toBe("SANDBOX");

    // 6. 沙盒试验
    await store.update(rule.rule_id, {
      sandbox_trials: 5,
      sandbox_successes: 4, // 80% > 60%
    });

    // 7. 生命周期管理 → PROBATION
    const emaMap = new Map();
    const transitions1 = await evaluateSandboxRules(store);
    expect(transitions1).toHaveLength(1);
    expect(transitions1[0]?.to).toBe("PROBATION");

    // 8. 试运行任务
    await store.update(rule.rule_id, {
      probation_task_count: 15,
      success_rate: 0.85,
      trigger_log: Array.from({ length: 15 }, (_, i) => ({
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        task_id: `task_${i}`,
        success: i < 13,
      })),
    });

    // 9. 生命周期管理 → ACTIVE
    const transitions2 = await evaluateProbationRules(store, 0.5);
    expect(transitions2).toHaveLength(1);
    expect(transitions2[0]?.to).toBe("ACTIVE");

    // 10. 验证最终状态
    const final = await store.getById(rule.rule_id);
    expect(final?.status).toBe("ACTIVE");
  });
});

// ─── 端到端：触发预算控制 ───

describe("Evolution Engine E2E: Trigger Budget", () => {
  it("预算耗尽暂停进化", () => {
    const budget = createTriggerBudget();

    // 超过宽限期后：20 个任务完成
    for (let i = 0; i < 20; i++) budget.incrementTotal();

    // 1 次触发 → ratio ≈ 0.067
    budget.incrementUsed();
    expect(budget.check().canEvolve).toBe(true);

    // 再触发 3 次 → ratio = 4/15 ≈ 0.267 > 0.2
    budget.incrementUsed();
    budget.incrementUsed();
    budget.incrementUsed();
    expect(budget.check().canEvolve).toBe(false);
  });
});

// ─── 端到端：宪法守卫保护 ───

describe("Evolution Engine E2E: Constitutional Guard", () => {
  it("宪法层参数在任何修改中被保护", () => {
    // 直接修改
    expect(isConstitutional("AB_TEST_JUDGE_WEIGHTS")).toBe(true);
    expect(validateProposal("AB_TEST_JUDGE_WEIGHTS", 0.5).valid).toBe(false);

    // 策略探索器不会触及宪法层
    const explorer = createStrategyExplorer();
    const result = explorer.generatePerturbation({
      AB_TEST_JUDGE_WEIGHTS: 0.4,
      PROMOTION_IMPROVEMENT_MIN: 0.15,
    });
    // 宪法层参数不是可进化的，所以不会被选中
    if (result !== null) {
      expect(result.paramName).not.toBe("AB_TEST_JUDGE_WEIGHTS");
    }

    // 二阶交流器拒绝宪法层提案
    const communicator = createMetaCommunicator();
    const filterResult = communicator.filterProposals([{
      proposalId: "p1",
      sourcePeerId: "peer_1",
      paramName: "AB_TEST_JUDGE_WEIGHTS",
      proposedValue: 0.5,
      reason: "test",
      sourceTrust: 0.9,
      sourceAgeDays: 60,
    }]);
    expect(filterResult.accepted).toHaveLength(0);
    expect(filterResult.rejected[0]?.reason).toContain("constitutional");
  });
});

// ─── 端到端：A/B 测试 + 权重适配 ───

describe("Evolution Engine E2E: AB Test + Weight Adaptation", () => {
  it("A/B 测试驱动权重调整", () => {
    const adapter = createWeightAdapter();

    // B 持续获胜 → 权重增加
    for (let i = 0; i < 40; i++) adapter.recordVerdict("B");
    for (let i = 0; i < 10; i++) adapter.recordVerdict("A");

    if (adapter.shouldAdapt()) {
      adapter.adaptWeights();
    }

    const weights = adapter.getWeights();
    // 权重总和应为 1
    const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1.0, 5);
  });

  it("A/B 测试裁判正确判决", () => {
    const verdict = judgeABTest({
      resultA: Array.from({ length: 20 }, (_, i) => ({
        success: i < 10, executionTimeMs: 500, crashed: false,
      })),
      resultB: Array.from({ length: 20 }, (_, i) => ({
        success: i < 18, executionTimeMs: 550, crashed: false,
      })),
    });

    // B 成功率 90% vs A 50%，时间增加 10% < 15%
    expect(verdict.winner).toBe("B");
    expect(verdict.details.successRateB).toBe(0.9);
  });
});

// ─── 端到端：自动淘汰 ───

describe("Evolution Engine E2E: Auto Deprecation", () => {
  it("表现差的活跃规则被自动淘汰", async () => {
    const store = createMemoryRuleStore();

    // 创建 2 个活跃规则
    await store.add({
      rule_id: "good_rule",
      created_at: new Date().toISOString(),
      source_error_id: "e1",
      trigger_pattern: "pattern_a",
      action: "RETRY_WITH_HIGHER_TIMEOUT",
      status: "ACTIVE",
      activation_count: 20,
      success_count: 18,
      success_rate: 0.9,
      trigger_log: Array.from({ length: 20 }, (_, i) => ({
        timestamp: new Date(Date.now() - (20 - i) * 60000).toISOString(),
        success: i < 18,
        task_id: `t${i}`,
      })),
    });

    await store.add({
      rule_id: "bad_rule",
      created_at: new Date().toISOString(),
      source_error_id: "e2",
      trigger_pattern: "pattern_b",
      action: "ADD_VALIDATION_STEP",
      status: "ACTIVE",
      activation_count: 10,
      success_count: 1,
      success_rate: 0.1,
      trigger_log: Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(Date.now() - (10 - i) * 60000).toISOString(),
        success: i === 0,
        task_id: `t${i}`,
      })),
    });

    // 运行自动淘汰
    const emaMap = new Map();
    const transitions = await autoDeprecateRules(store, emaMap);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.ruleId).toBe("bad_rule");
    expect(transitions[0]?.to).toBe("DEPRECATED");

    // 验证最终状态
    const bad = await store.getById("bad_rule");
    expect(bad?.status).toBe("DEPRECATED");

    const good = await store.getById("good_rule");
    expect(good?.status).toBe("ACTIVE");
  });
});

// ─── 端到端：引擎自优化 ───

describe("Evolution Engine E2E: Engine Self Optimization", () => {
  it("低成功率触发参数放宽", () => {
    const optimizer = createEngineSelfOptimizer({ rollbackOnDegrade: false });
    optimizer.updateBaseline(0.7);

    const stats = {
      totalTasks: 100,
      successCount: 30,
      failureCount: 70,
      avgExecutionTimeMs: 1000,
      successRate: 0.3,
      deprecationRate: 0.1,
      bWinRate: 0.4,
    };

    const proposals = optimizer.analyzeAndPropose(stats, {
      PROMOTION_IMPROVEMENT_MIN: 0.15,
    });

    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0]?.paramName).toBe("PROMOTION_IMPROVEMENT_MIN");
    expect(proposals[0]?.proposedValue).toBeLessThan(0.15);
  });
});

// ─── 端到端：代码沙箱 + 工具生成 ───

describe("Evolution Engine E2E: Code Sandbox + Tool Generation", () => {
  it("工具生成 + 沙箱验证完整流程", async () => {
    const generator = createToolGenerator();

    // 生成工具
    const tool = generator.generateTool("Task execution timed out");
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("retry_with_backoff");

    // 在沙箱中验证
    const valid = await generator.validateTool(tool!);
    expect(valid).toBe(true);
  });

  it("危险代码被沙箱拒绝", async () => {
    const result = await executeInSandbox("eval('malicious')");
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("Forbidden");
  });
});

// ─── 端到端：完整生命周期管理 ───

describe("Evolution Engine E2E: Full Lifecycle", () => {
  it("多规则同时在不同阶段被管理", async () => {
    const store = createMemoryRuleStore();

    // 沙盒规则（通过）
    await store.add({
      rule_id: "sandbox_pass",
      created_at: new Date().toISOString(),
      source_error_id: "e1",
      trigger_pattern: "timeout",
      action: "RETRY_WITH_HIGHER_TIMEOUT",
      status: "SANDBOX",
      sandbox_trials: 5,
      sandbox_successes: 4,
    });

    // 沙盒规则（未通过）
    await store.add({
      rule_id: "sandbox_fail",
      created_at: new Date().toISOString(),
      source_error_id: "e2",
      trigger_pattern: "invalid",
      action: "ADD_VALIDATION_STEP",
      status: "SANDBOX",
      sandbox_trials: 5,
      sandbox_successes: 1,
    });

    // 活跃规则（表现差）
    await store.add({
      rule_id: "active_bad",
      created_at: new Date().toISOString(),
      source_error_id: "e3",
      trigger_pattern: "error",
      action: "ADD_ERROR_HANDLING",
      status: "ACTIVE",
      activation_count: 10,
      success_count: 1,
      success_rate: 0.1,
      trigger_log: Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date().toISOString(),
        success: i === 0,
        task_id: `t${i}`,
      })),
    });

    // 保底活跃规则
    await store.add({
      rule_id: "active_good",
      created_at: new Date().toISOString(),
      source_error_id: "e4",
      trigger_pattern: "ok",
      action: "ADVISORY_ONLY",
      status: "ACTIVE",
      activation_count: 20,
      success_count: 18,
      success_rate: 0.9,
      trigger_log: [],
    });

    // 运行完整生命周期管理
    const emaMap = new Map();
    const result = await runLifecycleManagement(store, emaMap, 0.5);

    // 预期转换：
    // sandbox_pass → PROBATION
    // sandbox_fail → DEPRECATED
    // active_bad → DEPRECATED（但保底策略需要至少 1 个活跃规则）
    // active_good 保持 ACTIVE
    expect(result.transitions.length).toBeGreaterThanOrEqual(2);

    const sandboxPass = await store.getById("sandbox_pass");
    expect(sandboxPass?.status).toBe("PROBATION");

    const sandboxFail = await store.getById("sandbox_fail");
    expect(sandboxFail?.status).toBe("DEPRECATED");

    // active_bad 可能被淘汰（如果有 2 个活跃规则）
    // 但 active_good 保底，所以 active_bad 可以被淘汰
    const activeBad = await store.getById("active_bad");
    // 注意：淘汰需要 >= 5 次触发，这里满足
    expect(activeBad?.status).toBe("DEPRECATED");

    const activeGood = await store.getById("active_good");
    expect(activeGood?.status).toBe("ACTIVE");
  });
});

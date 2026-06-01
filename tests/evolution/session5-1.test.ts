/**
 * Session 5.1 测试 — 进化引擎核心（规则存储 + 触发预算 + EMA + 生命周期管理）。
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  createMemoryRuleStore,
  type RuleStore,
} from "../../src/evolution/rule-store";
import { createTriggerBudget } from "../../src/evolution/trigger-budget";
import {
  createEMACalculator,
  calculateVariance,
  calculateCompositeScore,
} from "../../src/evolution/ema";
import {
  evaluateSandboxRules,
  evaluateProbationRules,
  autoDeprecateRules,
  runLifecycleManagement,
} from "../../src/evolution/lifecycle";
import { RuleStatus } from "../../src/types/evolution";
import {
  EVOLUTION_MAX_TRIGGER_BUDGET_RATIO,
  EVOLUTION_SANDBOX_MIN_TRIALS,
  EVOLUTION_SANDBOX_MIN_SUCCESS_RATE,
  PROBATION_MIN_TASKS,
  PROMOTION_IMPROVEMENT_MIN,
  EVOLUTION_DEPRECATE_THRESHOLD,
  EVOLUTION_DEPRECATE_MIN_ACTIVATIONS,
  MIN_EVALUATION_TRIGGERS,
  EVOLUTION_VARIANCE_THRESHOLD,
} from "../../src/evolution/constants";

// ─── 辅助函数 ───

function createRule(overrides: Record<string, unknown> = {}): import("../../src/schemas/evolution").EvolutionRuleInput {
  return {
    rule_id: `rule_${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    source_error_id: "error_1",
    trigger_pattern: "timeout error",
    action: "RETRY_WITH_HIGHER_TIMEOUT",
    ...overrides,
  };
}

// ─── 规则存储测试 ───

describe("RuleStore (Memory)", () => {
  let store: RuleStore;

  beforeEach(() => {
    store = createMemoryRuleStore();
  });

  it("添加和获取规则", async () => {
    const rule = createRule();
    const added = await store.add(rule);
    expect(added.rule_id).toBe(rule.rule_id);
    expect(added.status).toBe("PENDING_APPROVAL");

    const fetched = await store.getById(rule.rule_id);
    expect(fetched).toBeDefined();
    expect(fetched?.action).toBe("RETRY_WITH_HIGHER_TIMEOUT");
  });

  it("按状态过滤", async () => {
    await store.add(createRule({ rule_id: "r1", status: "SANDBOX" }));
    await store.add(createRule({ rule_id: "r2", status: "ACTIVE" }));
    await store.add(createRule({ rule_id: "r3", status: "SANDBOX" }));

    const sandbox = await store.getByStatus(RuleStatus.SANDBOX);
    expect(sandbox).toHaveLength(2);
  });

  it("更新规则", async () => {
    await store.add(createRule({ rule_id: "r1" }));
    const updated = await store.update("r1", { status: "SANDBOX" });
    expect(updated?.status).toBe("SANDBOX");

    const fetched = await store.getById("r1");
    expect(fetched?.status).toBe("SANDBOX");
  });

  it("删除规则", async () => {
    await store.add(createRule({ rule_id: "r1" }));
    const deleted = await store.delete("r1");
    expect(deleted).toBe(true);

    const fetched = await store.getById("r1");
    expect(fetched).toBeUndefined();
  });

  it("规则数量统计", async () => {
    await store.add(createRule({ rule_id: "r1" }));
    await store.add(createRule({ rule_id: "r2" }));
    expect(await store.count()).toBe(2);
    expect(await store.countByStatus(RuleStatus.PENDING_APPROVAL)).toBe(2);
  });

  it("更新不存在的规则返回 undefined", async () => {
    const result = await store.update("nonexistent", { status: "SANDBOX" });
    expect(result).toBeUndefined();
  });
});

// ─── 触发预算测试 ───

describe("TriggerBudget", () => {
  it("初始状态预算为零", () => {
    const budget = createTriggerBudget();
    const state = budget.getState();
    expect(state.totalBudget).toBe(0);
    expect(state.usedBudget).toBe(0);
  });

  it("完成任务增加总预算", () => {
    const budget = createTriggerBudget();
    // 宽限期内不写入窗口
    budget.incrementTotal();
    budget.incrementTotal();
    expect(budget.getState().totalBudget).toBe(0);
    // 超过宽限期后写入窗口
    budget.incrementTotal();
    budget.incrementTotal();
    budget.incrementTotal();
    budget.incrementTotal();
    budget.incrementTotal();
    budget.incrementTotal();
    expect(budget.getState().totalBudget).toBe(3);
  });

  it("触发进化增加已用预算", () => {
    const budget = createTriggerBudget();
    // 超过宽限期后才有窗口条目
    for (let i = 0; i < 7; i++) budget.incrementTotal();
    budget.incrementUsed();
    expect(budget.getState().usedBudget).toBe(1);
  });

  it("预算比例未超限时可以进化", () => {
    const budget = createTriggerBudget();
    // 超过宽限期后：20 个任务，1 次触发 → ratio = 1/15 ≈ 0.067
    for (let i = 0; i < 20; i++) budget.incrementTotal();
    budget.incrementUsed();

    const check = budget.check();
    expect(check.canEvolve).toBe(true);
    expect(check.ratio).toBeCloseTo(1 / 15, 2);
  });

  it("预算比例超限时不能进化", () => {
    const budget = createTriggerBudget();
    // 超过宽限期后：20 个任务，4 次触发 → ratio = 4/15 ≈ 0.267 > 0.2
    for (let i = 0; i < 20; i++) budget.incrementTotal();
    budget.incrementUsed();
    budget.incrementUsed();
    budget.incrementUsed();
    budget.incrementUsed();

    const check = budget.check();
    expect(check.canEvolve).toBe(false);
    expect(check.ratio).toBeCloseTo(4 / 15, 2);
  });

  it("宽限期内始终允许进化", () => {
    const budget = createTriggerBudget();
    for (let i = 0; i < 5; i++) budget.incrementTotal();
    budget.incrementUsed();
    budget.incrementUsed();

    const check = budget.check();
    expect(check.canEvolve).toBe(true);
    expect(check.ratio).toBe(0);
  });

  it("滑动窗口使旧触发过期后预算可恢复", () => {
    const budget = createTriggerBudget();
    // 前10个任务全部触发进化
    for (let i = 0; i < 10; i++) {
      budget.incrementTotal();
      budget.incrementUsed();
    }
    expect(budget.check().canEvolve).toBe(false);

    // 后续90个成功任务将旧触发推出窗口
    for (let i = 0; i < 90; i++) {
      budget.incrementTotal();
    }
    expect(budget.check().canEvolve).toBe(true);
  });

  it("重置预算", () => {
    const budget = createTriggerBudget();
    budget.incrementTotal();
    budget.incrementUsed();
    budget.reset();
    expect(budget.getState().totalBudget).toBe(0);
    expect(budget.getState().usedBudget).toBe(0);
  });
});

// ─── EMA 趋势计算测试 ───

describe("EMA Calculator", () => {
  it("首次更新使用 EMA 公式（M-06: baseline 预热）", () => {
    const ema = createEMACalculator(0.5);
    ema.update(0.8);
    // M-06: EMA 初始为 baseline=0.5，update(0.8) 后 = 0.1*0.8 + 0.9*0.5 = 0.53
    expect(ema.getCurrent()).toBeCloseTo(0.53, 2);
  });

  it("后续更新使用 EMA 公式", () => {
    const ema = createEMACalculator(0.5, 0.3);
    ema.update(0.8); // EMA = 0.3*0.8 + 0.7*0.5 = 0.59
    ema.update(0.6); // EMA = 0.3*0.6 + 0.7*0.59 = 0.18 + 0.413 = 0.593
    expect(ema.getCurrent()).toBeCloseTo(0.593, 2);
  });

  it("上升趋势检测", () => {
    const ema = createEMACalculator(0.5);
    for (let i = 0; i < 31; i++) {
      ema.update(0.9);
    }
    expect(ema.getTrend()).toBe("improving");
  });

  it("下降趋势检测", () => {
    const ema = createEMACalculator(0.5);
    for (let i = 0; i < 31; i++) {
      ema.update(0.1);
    }
    expect(ema.getTrend()).toBe("declining");
  });

  it("稳定趋势检测", () => {
    const ema = createEMACalculator(0.5);
    for (let i = 0; i < 31; i++) {
      ema.update(0.5);
    }
    expect(ema.getTrend()).toBe("stable");
  });

  it("数据不足时返回 stable", () => {
    const ema = createEMACalculator(0.5);
    ema.update(0.9);
    expect(ema.getTrend()).toBe("stable");
  });

  it("minSamples 阈值：alpha=0.3 时需至少 12 次观测才判定趋势", () => {
    const ema = createEMACalculator(0.5, 0.3);
    for (let i = 0; i < 11; i++) {
      ema.update(0.9);
    }
    expect(ema.getTrend()).toBe("stable");
    ema.update(0.9);
    expect(ema.getTrend()).toBe("improving");
  });

  it("历史窗口大小限制", () => {
    const ema = createEMACalculator(0.5, 0.3, 5);
    for (let i = 0; i < 10; i++) {
      ema.update(0.7);
    }
    expect(ema.getHistory()).toHaveLength(5);
  });

  it("重置清除所有状态", () => {
    const ema = createEMACalculator(0.5);
    ema.update(0.9);
    ema.reset();
    expect(ema.getCurrent()).toBe(0.5); // 返回基线
    expect(ema.getHistory()).toHaveLength(0);
  });
});

// ─── 方差计算测试 ───

describe("calculateVariance", () => {
  it("空数组返回 0", () => {
    expect(calculateVariance([])).toBe(0);
  });

  it("单元素返回 0", () => {
    expect(calculateVariance([0.5])).toBe(0);
  });

  it("高方差计算正确", () => {
    const variance = calculateVariance([0, 1, 0, 1, 0, 1]);
    expect(variance).toBeCloseTo(0.3, 2);
  });

  it("低方差计算正确", () => {
    const variance = calculateVariance([0.5, 0.5, 0.5, 0.5]);
    expect(variance).toBe(0);
  });
});

// ─── 综合评分测试 ───

describe("calculateCompositeScore", () => {
  it("默认重要性计算", () => {
    const score = calculateCompositeScore({
      successRate: 0.8,
      taskType: "coding",
      extraCostRatio: 0.05,
    });
    // 0.8 * 0.5 * 0.95 = 0.38（默认 importance=0.5）
    expect(score).toBeCloseTo(0.38, 2);
  });

  it("自定义重要性计算", () => {
    const score = calculateCompositeScore({
      successRate: 0.8,
      taskType: "coding",
      extraCostRatio: 0.05,
      taskTypeImportance: { coding: 1.0, default: 0.5 },
    });
    // 0.8 * 1.0 * 0.95 = 0.76
    expect(score).toBeCloseTo(0.76, 2);
  });
});

// ─── 生命周期管理测试 ───

describe("Lifecycle Management", () => {
  let store: RuleStore;

  beforeEach(() => {
    store = createMemoryRuleStore();
  });

  describe("evaluateSandboxRules", () => {
    it("沙盒规则通过晋升到 PROBATION", async () => {
      await store.add(createRule({
        rule_id: "s1",
        status: "SANDBOX",
        sandbox_trials: 5,
        sandbox_successes: 4, // 80% > 60%
      }));

      const transitions = await evaluateSandboxRules(store);
      expect(transitions).toHaveLength(1);
      expect(transitions[0]?.to).toBe("PROBATION");

      const rule = await store.getById("s1");
      expect(rule?.status).toBe("PROBATION");
    });

    it("沙盒规则未通过被淘汰", async () => {
      await store.add(createRule({
        rule_id: "s2",
        status: "SANDBOX",
        sandbox_trials: 5,
        sandbox_successes: 1, // 20% < 60%
      }));

      const transitions = await evaluateSandboxRules(store);
      expect(transitions).toHaveLength(1);
      expect(transitions[0]?.to).toBe("DEPRECATED");
    });

    it("试运行次数不足跳过", async () => {
      await store.add(createRule({
        rule_id: "s3",
        status: "SANDBOX",
        sandbox_trials: 1,
        sandbox_successes: 1,
      }));

      const transitions = await evaluateSandboxRules(store);
      expect(transitions).toHaveLength(0);
    });
  });

  describe("evaluateProbationRules", () => {
    it("试运行规则通过晋升到 ACTIVE", async () => {
      await store.add(createRule({
        rule_id: "p1",
        status: "PROBATION",
        probation_task_count: 15,
        success_rate: 0.85,
        probation_started_at: new Date().toISOString(),
        trigger_log: Array.from({ length: 15 }, (_, i) => ({
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          task_id: `task_${i}`,
          success: i < 13,
        })),
      }));

      const transitions = await evaluateProbationRules(store, 0.5);
      expect(transitions).toHaveLength(1);
      expect(transitions[0]?.to).toBe("ACTIVE");
    });

    it("任务数不足跳过", async () => {
      await store.add(createRule({
        rule_id: "p2",
        status: "PROBATION",
        probation_task_count: 5, // < 10
        success_rate: 0.9,
      }));

      const transitions = await evaluateProbationRules(store, 0.5);
      expect(transitions).toHaveLength(0);
    });

    it("改善幅度不足不晋升", async () => {
      await store.add(createRule({
        rule_id: "p3",
        status: "PROBATION",
        probation_task_count: 15,
        success_rate: 0.55, // 基线 0.5，改善 0.05 < 0.15
      }));

      const transitions = await evaluateProbationRules(store, 0.5);
      expect(transitions).toHaveLength(0);
    });
  });

  describe("autoDeprecateRules", () => {
    it("低成功率活跃规则被淘汰", async () => {
      // 需要至少 2 个活跃规则（保底策略）
      await store.add(createRule({
        rule_id: "a1",
        status: "ACTIVE",
        activation_count: 10, // >= 5
        success_count: 1, // 10% < 30%
        success_rate: 0.1,
      }));
      await store.add(createRule({
        rule_id: "a2",
        status: "ACTIVE",
        activation_count: 10,
        success_count: 9,
        success_rate: 0.9,
      }));

      const transitions = await autoDeprecateRules(store, new Map());
      expect(transitions).toHaveLength(1);
      expect(transitions[0]?.ruleId).toBe("a1");
      expect(transitions[0]?.to).toBe("DEPRECATED");
    });

    it("保底策略：只有 1 个活跃规则时不淘汰", async () => {
      await store.add(createRule({
        rule_id: "a1",
        status: "ACTIVE",
        activation_count: 100,
        success_rate: 0.05,
      }));

      const transitions = await autoDeprecateRules(store, new Map());
      expect(transitions).toHaveLength(0);
    });

    it("触发次数不足跳过", async () => {
      await store.add(createRule({
        rule_id: "a1",
        status: "ACTIVE",
        activation_count: 3, // < 5
        success_rate: 0.0,
      }));
      await store.add(createRule({
        rule_id: "a2",
        status: "ACTIVE",
      }));

      const transitions = await autoDeprecateRules(store, new Map());
      expect(transitions).toHaveLength(0);
    });

    it("EMA 下降触发淘汰", async () => {
      await store.add(createRule({
        rule_id: "a1",
        status: "ACTIVE",
        activation_count: 10,
        success_rate: 0.5,
      }));
      await store.add(createRule({
        rule_id: "a2",
        status: "ACTIVE",
      }));

      const ema = createEMACalculator(0.8);
      for (let i = 0; i < 31; i++) ema.update(0.1);

      const emaMap = new Map([["a1", ema]]);
      const transitions = await autoDeprecateRules(store, emaMap);
      expect(transitions).toHaveLength(1);
      expect(transitions[0]?.reason).toContain("declining");
    });
  });

  describe("runLifecycleManagement", () => {
    it("完整生命周期管理", async () => {
      // 沙盒规则通过
      await store.add(createRule({
        rule_id: "s1",
        status: "SANDBOX",
        sandbox_trials: 5,
        sandbox_successes: 4,
      }));

      const emaMap = new Map();
      const result = await runLifecycleManagement(store, emaMap, 0.5);
      expect(result.transitions.length).toBeGreaterThanOrEqual(1);

      const s1 = await store.getById("s1");
      expect(s1?.status).toBe("PROBATION");
    });
  });
});

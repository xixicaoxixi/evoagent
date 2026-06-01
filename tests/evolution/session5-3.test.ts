/**
 * Session 5.3 测试 — 宪法守卫 + 策略探索器 + 引擎自优化器。
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  isConstitutional,
  isEvolvable,
  getEvolvableParamDef,
  listConstitutionalParams,
  listEvolvableParams,
  validateProposal,
  isImmutableScope,
} from "../../src/evolution/constitutional-guard";
import { createStrategyExplorer } from "../../src/evolution/strategy-explorer";
import { createEngineSelfOptimizer } from "../../src/evolution/engine-self-optimizer";
import {
  STRATEGY_EXPLORE_INTERVAL,
  ENGINE_SELF_OPT_MIN_TASKS,
  ENGINE_SELF_OPT_INTERVAL,
  EVAL_WEIGHT_ADAPT_INTERVAL,
} from "../../src/evolution/constants";

// ─── 宪法守卫测试 ───

describe("ConstitutionalGuard", () => {
  it("宪法层参数识别", () => {
    expect(isConstitutional("AB_TEST_JUDGE_WEIGHTS")).toBe(true);
    expect(isConstitutional("SYSTEM_PROMPT_CORE")).toBe(true);
    expect(isConstitutional("EVOLUTION_RULE_MAX_COUNT")).toBe(true);
    expect(isConstitutional("PROMOTION_IMPROVEMENT_MIN")).toBe(false);
  });

  it("可进化参数识别", () => {
    expect(isEvolvable("PROMOTION_IMPROVEMENT_MIN")).toBe(true);
    expect(isEvolvable("EVOLUTION_SANDBOX_MIN_SUCCESS_RATE")).toBe(true);
    expect(isEvolvable("AB_TEST_JUDGE_WEIGHTS")).toBe(false);
    expect(isEvolvable("UNKNOWN_PARAM")).toBe(false);
  });

  it("可进化参数定义获取", () => {
    const def = getEvolvableParamDef("PROMOTION_IMPROVEMENT_MIN");
    expect(def).toBeDefined();
    expect(def?.type).toBe("float");
    expect(def?.min).toBe(0.05);
    expect(def?.max).toBe(0.5);
  });

  it("列表函数返回正确数量", () => {
    expect(listConstitutionalParams()).toHaveLength(7);
    expect(listEvolvableParams()).toHaveLength(8);
  });

  describe("validateProposal", () => {
    it("宪法层参数拒绝修改", () => {
      const result = validateProposal("AB_TEST_JUDGE_WEIGHTS", 0.5);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("constitutional");
    });

    it("不可进化参数拒绝修改", () => {
      const result = validateProposal("UNKNOWN_PARAM", 0.5);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not evolvable");
    });

    it("float 参数在范围内通过", () => {
      const result = validateProposal("PROMOTION_IMPROVEMENT_MIN", 0.2);
      expect(result.valid).toBe(true);
    });

    it("float 参数超出范围被钳制", () => {
      const result = validateProposal("PROMOTION_IMPROVEMENT_MIN", 0.01);
      expect(result.valid).toBe(true);
      expect(result.clampedValue).toBe(0.05);
    });

    it("float 参数超出上限被钳制", () => {
      const result = validateProposal("PROMOTION_IMPROVEMENT_MIN", 0.8);
      expect(result.valid).toBe(true);
      expect(result.clampedValue).toBe(0.5);
    });

    it("int 参数四舍五入", () => {
      const result = validateProposal("EVOLUTION_SANDBOX_MIN_TRIALS", 3.7);
      expect(result.valid).toBe(true);
      expect(result.clampedValue).toBe(4);
    });

    it("dict 参数类型检查", () => {
      const result = validateProposal("TASK_TYPE_IMPORTANCE", { coding: 1.0 });
      expect(result.valid).toBe(true);
    });

    it("dict 参数非对象拒绝", () => {
      const result = validateProposal("TASK_TYPE_IMPORTANCE", "not a dict");
      expect(result.valid).toBe(false);
    });
  });

  it("不可变范围检查", () => {
    expect(isImmutableScope("communication_protocol")).toBe(true);
    expect(isImmutableScope("safety_constraints")).toBe(true);
    expect(isImmutableScope("random_scope")).toBe(false);
  });
});

// ─── 策略探索器测试 ───

describe("StrategyExplorer", () => {
  it("任务数不足不触发", () => {
    const explorer = createStrategyExplorer();
    expect(explorer.shouldExplore(10)).toBe(false);
  });

  it("首次触发：lastExploreTask=0 时只要达到 minTasks 即可触发", () => {
    const explorer = createStrategyExplorer();
    expect(explorer.shouldExplore(30)).toBe(true);
  });

  it("首次触发：未达 minTasks 仍不触发", () => {
    const explorer = createStrategyExplorer();
    expect(explorer.shouldExplore(10)).toBe(false);
  });

  it("间隔不足不触发（已有探索记录后）", () => {
    const explorer = createStrategyExplorer({ minTasks: 5, interval: 100 });
    const config = { PROMOTION_IMPROVEMENT_MIN: 0.15 };
    explorer.generatePerturbation(config, 10);
    explorer.recordExperimentResult("nonexistent", { improved: false, metric: 0 });
    expect(explorer.shouldExplore(50)).toBe(false);
  });

  it("满足条件触发", () => {
    const explorer = createStrategyExplorer({ minTasks: 5, interval: 5 });
    expect(explorer.shouldExplore(10)).toBe(true);
  });

  it("禁用时不触发", () => {
    const explorer = createStrategyExplorer({ enabled: false });
    expect(explorer.shouldExplore(1000)).toBe(false);
  });

  it("生成扰动返回有效结果", () => {
    const explorer = createStrategyExplorer();
    const config = {
      PROMOTION_IMPROVEMENT_MIN: 0.15,
      EVOLUTION_SANDBOX_MIN_SUCCESS_RATE: 0.6,
    };
    const result = explorer.generatePerturbation(config);
    expect(result).not.toBeNull();
    expect(result!.paramName).toBeTruthy();
    expect(result!.perturbedValue).not.toBe(result!.originalValue);
  });

  it("探索中不重复触发", () => {
    const explorer = createStrategyExplorer({ minTasks: 5, interval: 5 });
    const config = { PROMOTION_IMPROVEMENT_MIN: 0.15 };
    explorer.generatePerturbation(config);
    expect(explorer.shouldExplore(100)).toBe(false);
    expect(explorer.isCurrentlyExploring()).toBe(true);
  });

  it("无可进化参数返回 null", () => {
    const explorer = createStrategyExplorer();
    const result = explorer.generatePerturbation({ UNKNOWN: 42 });
    expect(result).toBeNull();
  });

  it("记录实验结果后恢复", () => {
    const explorer = createStrategyExplorer({ minTasks: 5, interval: 5 });
    const config = { PROMOTION_IMPROVEMENT_MIN: 0.15 };
    explorer.generatePerturbation(config);
    explorer.recordExperimentResult("exp_1", { improved: true, metric: 0.1 });
    expect(explorer.isCurrentlyExploring()).toBe(false);
  });
});

// ─── 引擎自优化器测试 ───

describe("EngineSelfOptimizer", () => {
  it("任务数不足不触发", () => {
    const optimizer = createEngineSelfOptimizer();
    expect(optimizer.shouldOptimize(10)).toBe(false);
  });

  it("满足条件触发", () => {
    const optimizer = createEngineSelfOptimizer({ minTasks: 5, interval: 5 });
    expect(optimizer.shouldOptimize(10)).toBe(true);
  });

  it("首次分析记录基线", () => {
    const optimizer = createEngineSelfOptimizer();
    const stats = {
      totalTasks: 100,
      successCount: 70,
      failureCount: 30,
      avgExecutionTimeMs: 500,
      successRate: 0.7,
      deprecationRate: 0.1,
      bWinRate: 0.4,
    };
    const proposals = optimizer.analyzeAndPropose(stats, {});
    expect(proposals).toHaveLength(0);
    expect(optimizer.getBaseline()).toBe(0.7);
  });

  it("低成功率触发放宽策略", () => {
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

  it("高淘汰率触发收紧策略", () => {
    const optimizer = createEngineSelfOptimizer();
    optimizer.updateBaseline(0.7);

    const stats = {
      totalTasks: 100,
      successCount: 60,
      failureCount: 40,
      avgExecutionTimeMs: 500,
      successRate: 0.6,
      deprecationRate: 0.4,
      bWinRate: 0.4,
    };
    const proposals = optimizer.analyzeAndPropose(stats, {
      DEPRECATION_RATE_MIN: 0.3,
    });
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.some((p) => p.paramName === "DEPRECATION_RATE_MIN")).toBe(true);
  });

  it("低 B 胜率触发降低沙盒门槛", () => {
    const optimizer = createEngineSelfOptimizer();
    optimizer.updateBaseline(0.7);

    const stats = {
      totalTasks: 100,
      successCount: 60,
      failureCount: 40,
      avgExecutionTimeMs: 500,
      successRate: 0.6,
      deprecationRate: 0.1,
      bWinRate: 0.15,
    };
    const proposals = optimizer.analyzeAndPropose(stats, {
      EVOLUTION_SANDBOX_MIN_SUCCESS_RATE: 0.6,
    });
    expect(proposals.some((p) => p.paramName === "EVOLUTION_SANDBOX_MIN_SUCCESS_RATE")).toBe(true);
  });

  it("应用和回退优化", () => {
    const optimizer = createEngineSelfOptimizer();
    const proposal = {
      paramName: "PROMOTION_IMPROVEMENT_MIN",
      currentValue: 0.15,
      proposedValue: 0.12,
      reason: "test",
    };

    const applied = optimizer.applyOptimization(proposal);
    expect(applied).toEqual({ PROMOTION_IMPROVEMENT_MIN: 0.12 });
    expect(optimizer.getAppliedOptimizations().has("PROMOTION_IMPROVEMENT_MIN")).toBe(true);

    const rollback = optimizer.rollbackOptimization("PROMOTION_IMPROVEMENT_MIN");
    expect(rollback).toEqual({ PROMOTION_IMPROVEMENT_MIN: null });
    expect(optimizer.getAppliedOptimizations().has("PROMOTION_IMPROVEMENT_MIN")).toBe(false);
  });

  it("回退不存在的优化返回 null", () => {
    const optimizer = createEngineSelfOptimizer();
    expect(optimizer.rollbackOptimization("UNKNOWN")).toBeNull();
  });
});

describe("Step 8: Evolution strategy first-trigger fix", () => {
  describe("StrategyExplorer shouldExplore() first-trigger", () => {
    it("default config: shouldExplore(30) returns true (first trigger at minTasks)", () => {
      const explorer = createStrategyExplorer();
      expect(explorer.shouldExplore(30)).toBe(true);
    });

    it("default config: shouldExplore(29) returns false (below minTasks)", () => {
      const explorer = createStrategyExplorer();
      expect(explorer.shouldExplore(29)).toBe(false);
    });

    it("after first exploration, interval check applies", () => {
      const explorer = createStrategyExplorer({ minTasks: 5, interval: 50 });
      const config = { PROMOTION_IMPROVEMENT_MIN: 0.15 };
      explorer.generatePerturbation(config, 10);
      explorer.recordExperimentResult("nonexistent", { improved: false, metric: 0 });

      expect(explorer.shouldExplore(30)).toBe(false);
      expect(explorer.shouldExplore(60)).toBe(true);
    });

    it("shouldExplore(80) returns true after first explore at 30 with interval=50", () => {
      const explorer = createStrategyExplorer({ minTasks: 5, interval: 50 });
      const config = { PROMOTION_IMPROVEMENT_MIN: 0.15 };
      explorer.generatePerturbation(config, 30);
      explorer.recordExperimentResult("nonexistent", { improved: false, metric: 0 });

      expect(explorer.shouldExplore(79)).toBe(false);
      expect(explorer.shouldExplore(80)).toBe(true);
    });
  });

  describe("EngineSelfOptimizer shouldOptimize() first-trigger", () => {
    it("default config: shouldOptimize(30) returns true (first trigger at minTasks)", () => {
      const optimizer = createEngineSelfOptimizer();
      expect(optimizer.shouldOptimize(30)).toBe(true);
    });

    it("default config: shouldOptimize(29) returns false (below minTasks)", () => {
      const optimizer = createEngineSelfOptimizer();
      expect(optimizer.shouldOptimize(29)).toBe(false);
    });

    it("custom config: first trigger at custom minTasks", () => {
      const optimizer = createEngineSelfOptimizer({ minTasks: 10, interval: 50 });
      expect(optimizer.shouldOptimize(10)).toBe(true);
      expect(optimizer.shouldOptimize(9)).toBe(false);
    });
  });

  describe("Constants threshold adjustments", () => {
    it("STRATEGY_EXPLORE_INTERVAL is 50 (reduced from 100)", () => {
      expect(STRATEGY_EXPLORE_INTERVAL).toBe(50);
    });

    it("ENGINE_SELF_OPT_MIN_TASKS is 30 (reduced from 50)", () => {
      expect(ENGINE_SELF_OPT_MIN_TASKS).toBe(30);
    });

    it("ENGINE_SELF_OPT_INTERVAL is 50 (reduced from 100)", () => {
      expect(ENGINE_SELF_OPT_INTERVAL).toBe(50);
    });

    it("EVAL_WEIGHT_ADAPT_INTERVAL is 25 (reduced from 50)", () => {
      expect(EVAL_WEIGHT_ADAPT_INTERVAL).toBe(25);
    });
  });
});

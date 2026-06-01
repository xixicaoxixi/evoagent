/**
 * Session 5.4 测试 — 代码沙箱 + A/B 测试裁判 + 权重适配器。
 */

import { describe, expect, it } from "vitest";
import { validateCode, executeInSandbox } from "../../src/evolution/code-sandbox";
import { judgeABTest, type ABTestInput, type TrialResult } from "../../src/evolution/ab-judge";
import { createWeightAdapter } from "../../src/evolution/weight-adapter";

// ─── 代码沙箱测试 ───

describe("CodeSandbox", () => {
  describe("validateCode", () => {
    it("有效代码通过验证", () => {
      const result = validateCode("const x = 1 + 2; console.log(x);");
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("超大代码被拒绝", () => {
      const bigCode = "x".repeat(200 * 1024); // 200KB
      const result = validateCode(bigCode);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceeds limit"))).toBe(true);
    });

    it("禁止的调用被检测", () => {
      const result = validateCode("const result = eval('evil');");
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("eval"))).toBe(true);
    });

    it("禁止的模块被检测", () => {
      const result = validateCode("const cp = require('child_process');");
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("child_process"))).toBe(true);
    });

    it("import 禁止模块被检测", () => {
      const result = validateCode("import * as signal from 'signal';");
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("signal"))).toBe(true);
    });

    it("括号不匹配被检测", () => {
      const result = validateCode("function test() { console.log('hello'");
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Unmatched"))).toBe(true);
    });

    it("字符串内的括号不影响", () => {
      const result = validateCode("const s = '(unmatched)';");
      expect(result.valid).toBe(true);
    });
  });

  describe("executeInSandbox", () => {
    it("执行有效代码", async () => {
      const result = await executeInSandbox("console.log('hello');");
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("hello");
    });

    it("执行失败代码", async () => {
      const result = await executeInSandbox("throw new Error('test error');");
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("test error");
    });

    it("无效代码被拒绝", async () => {
      const result = await executeInSandbox("eval('evil')");
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("Forbidden");
    });
  });
});

// ─── A/B 测试裁判测试 ───

describe("ABJudge", () => {
  function createTrialResults(count: number, successRate: number, avgTime: number): TrialResult[] {
    return Array.from({ length: count }, (_, i) => ({
      success: i < Math.floor(count * successRate),
      executionTimeMs: avgTime,
      crashed: false,
    }));
  }

  it("B 显著优于 A → B 胜", () => {
    const input: ABTestInput = {
      resultA: createTrialResults(10, 0.5, 1000),
      resultB: createTrialResults(10, 0.9, 1050), // 成功率 90% vs 50%，时间增加 5%
    };

    const verdict = judgeABTest(input);
    expect(verdict.winner).toBe("B");
    expect(verdict.scoreB).toBeGreaterThan(verdict.scoreA);
    expect(verdict.improvementRate).toBeGreaterThan(0.1);
  });

  it("B 成本过高 → A 胜或平局", () => {
    const input: ABTestInput = {
      resultA: createTrialResults(10, 0.5, 100),
      resultB: createTrialResults(10, 0.6, 500), // 时间增加 400%
    };

    const verdict = judgeABTest(input);
    // 成本增长过大，B 不应获胜
    expect(verdict.winner).not.toBe("B");
  });

  it("A 和 B 相当 → 平局", () => {
    const input: ABTestInput = {
      resultA: createTrialResults(10, 0.7, 500),
      resultB: createTrialResults(10, 0.7, 510),
    };

    const verdict = judgeABTest(input);
    expect(verdict.winner).toBe("TIE");
  });

  it("B 比 A 差 → A 胜", () => {
    const input: ABTestInput = {
      resultA: createTrialResults(10, 0.9, 200),
      resultB: createTrialResults(10, 0.3, 500),
    };

    const verdict = judgeABTest(input);
    expect(verdict.winner).toBe("A");
    expect(verdict.diff).toBeLessThan(-0.05);
  });

  it("空结果返回平局", () => {
    const input: ABTestInput = {
      resultA: [],
      resultB: [],
    };

    const verdict = judgeABTest(input);
    expect(verdict.winner).toBe("TIE");
    expect(verdict.diff).toBe(0);
  });

  it("自定义权重生效", () => {
    const input: ABTestInput = {
      resultA: createTrialResults(10, 0.5, 1000),
      resultB: createTrialResults(10, 0.9, 1050),
    };

    // 只看 success_rate
    const verdict = judgeABTest(input, { success_rate: 1.0, execution_time: 0, stability: 0, code_complexity: 0 });
    expect(verdict.winner).toBe("B");
    expect(verdict.details.successRateB).toBe(0.9);
  });

  it("details 包含完整指标", () => {
    const input: ABTestInput = {
      resultA: createTrialResults(10, 0.7, 500),
      resultB: createTrialResults(10, 0.8, 600),
    };

    const verdict = judgeABTest(input);
    expect(verdict.details.successRateA).toBe(0.7);
    expect(verdict.details.successRateB).toBe(0.8);
    expect(verdict.details.avgTimeA).toBe(500);
    expect(verdict.details.avgTimeB).toBe(600);
    expect(verdict.details.stabilityA).toBe(0.7);
    expect(verdict.details.stabilityB).toBe(0.8);
  });
});

// ─── 权重适配器测试 ───

describe("WeightAdapter", () => {
  it("初始权重正确", () => {
    const adapter = createWeightAdapter();
    const weights = adapter.getWeights();
    expect(weights.success_rate).toBeCloseTo(0.40);
    expect(weights.execution_time).toBeCloseTo(0.25);
    expect(weights.stability).toBeCloseTo(0.20);
    expect(weights.code_complexity).toBeCloseTo(0.15);
  });

  it("记录判决更新计数", () => {
    const adapter = createWeightAdapter();
    adapter.recordVerdict("B");
    adapter.recordVerdict("B");
    adapter.recordVerdict("A");

    const state = adapter.getState();
    expect(state.totalAttempts).toBe(3);
    expect(state.bWinCount).toBe(2);
    expect(state.aWinCount).toBe(1);
    expect(state.tieCount).toBe(0);
  });

  it("B 胜率高时增加权重", () => {
    const adapter = createWeightAdapter();
    // 记录 50 次判决，B 胜 40 次
    for (let i = 0; i < 40; i++) adapter.recordVerdict("B");
    for (let i = 0; i < 10; i++) adapter.recordVerdict("A");

    expect(adapter.shouldAdapt()).toBe(true);

    const newWeights = adapter.adaptWeights();
    // 权重应该增加
    for (const dim of ["success_rate", "execution_time", "stability", "code_complexity"]) {
      expect(newWeights[dim]).toBeGreaterThanOrEqual(adapter.getWeights()[dim]!);
    }
  });

  it("B 胜率低时降低权重", () => {
    const adapter = createWeightAdapter();
    // 记录 50 次判决，B 胜 5 次
    for (let i = 0; i < 5; i++) adapter.recordVerdict("B");
    for (let i = 0; i < 45; i++) adapter.recordVerdict("A");

    expect(adapter.shouldAdapt()).toBe(true);

    const newWeights = adapter.adaptWeights();
    // 权重应该降低
    for (const dim of ["success_rate", "execution_time", "stability", "code_complexity"]) {
      expect(newWeights[dim]).toBeLessThanOrEqual(adapter.getWeights()[dim]!);
    }
  });

  it("权重归一化（总和 = 1）", () => {
    const adapter = createWeightAdapter();
    for (let i = 0; i < 40; i++) adapter.recordVerdict("B");
    for (let i = 0; i < 10; i++) adapter.recordVerdict("A");

    adapter.adaptWeights();
    const weights = adapter.getWeights();
    const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1.0, 5);
  });

  it("不足 50 次不触发调整", () => {
    const adapter = createWeightAdapter();
    for (let i = 0; i < 30; i++) adapter.recordVerdict("B");
    expect(adapter.shouldAdapt()).toBe(false);
  });

  it("重置恢复默认权重", () => {
    const adapter = createWeightAdapter();
    for (let i = 0; i < 50; i++) adapter.recordVerdict("B");
    adapter.adaptWeights();
    adapter.reset();

    const weights = adapter.getWeights();
    expect(weights.success_rate).toBeCloseTo(0.40);
    expect(adapter.getState().totalAttempts).toBe(0);
  });
});

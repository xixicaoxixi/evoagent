/**
 * D.2 进化引擎技术债务修复测试。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryRuleStore, type RuleStore } from "../../src/evolution/rule-store";
import { createEMACalculator, calculateVariance, calculateCompositeScore } from "../../src/evolution/ema";
import { analyzeWithRules } from "../../src/evolution/rule-analyzer";
import type { ErrorRecord } from "../../src/schemas/evolution";

// ─── 测试用 ErrorRecord 工厂 ───

function makeError(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    error_id: "err_001",
    error_type: "RuntimeError",
    error_category: "execution",
    error_message: "Operation timed out after 30s",
    root_cause: "ETIMEDOUT",
    timestamp: new Date().toISOString(),
    context: {},
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// M-02: Debounce 防抖
// ═══════════════════════════════════════════════════════════

describe("D.2 > M-02: RuleStore 基本功能", () => {
  let store: RuleStore;

  beforeEach(() => {
    store = createMemoryRuleStore();
  });

  it("add + getById + delete 基本流程", async () => {
    const rule = await store.add({
      rule_id: "rule_001",
      created_at: new Date().toISOString(),
      source_error_id: "err_001",
      trigger_pattern: "timeout",
      action: "RETRY_WITH_HIGHER_TIMEOUT",
      priority: 0.8,
    });

    expect(rule.rule_id).toBe("rule_001");
    const found = await store.getById("rule_001");
    expect(found).toBeDefined();
    expect(found!.action).toBe("RETRY_WITH_HIGHER_TIMEOUT");

    const deleted = await store.delete("rule_001");
    expect(deleted).toBe(true);
    expect(await store.getById("rule_001")).toBeUndefined();
  });

  it("getByStatus 过滤", async () => {
    await store.add({
      rule_id: "r1", created_at: "", source_error_id: "",
      trigger_pattern: "t1", action: "RETRY_WITH_HIGHER_TIMEOUT", priority: 0.5,
      status: "ACTIVE",
    });
    await store.add({
      rule_id: "r2", created_at: "", source_error_id: "",
      trigger_pattern: "t2", action: "ADD_VALIDATION_STEP", priority: 0.5,
      status: "DEPRECATED",
    });

    const active = await store.getByStatus("ACTIVE");
    expect(active).toHaveLength(1);
    expect(active[0]!.rule_id).toBe("r1");
  });

  it("count + countByStatus", async () => {
    await store.add({
      rule_id: "r1", created_at: "", source_error_id: "",
      trigger_pattern: "t1", action: "RETRY_WITH_HIGHER_TIMEOUT", priority: 0.5,
      status: "ACTIVE",
    });
    await store.add({
      rule_id: "r2", created_at: "", source_error_id: "",
      trigger_pattern: "t2", action: "ADD_VALIDATION_STEP", priority: 0.5,
      status: "ACTIVE",
    });

    expect(await store.count()).toBe(2);
    expect(await store.countByStatus("ACTIVE")).toBe(2);
    expect(await store.countByStatus("DEPRECATED")).toBe(0);
  });

  it("update 修改规则", async () => {
    await store.add({
      rule_id: "r1", created_at: "", source_error_id: "",
      trigger_pattern: "t1", action: "RETRY_WITH_HIGHER_TIMEOUT", priority: 0.5,
    });

    const updated = await store.update("r1", { priority: 0.9 });
    expect(updated).toBeDefined();
    expect(updated!.priority).toBe(0.9);
  });

  it("delete 不存在的规则返回 false", async () => {
    expect(await store.delete("nonexistent")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// M-06: EMA 初始值修正
// ═══════════════════════════════════════════════════════════

describe("D.2 > M-06: EMA 初始值修正", () => {
  it("EMA 初始值使用 baseline 而非首次观测值", () => {
    const calc = createEMACalculator(0.5);

    // M-06 修复前：首次 update(0.0) 会让 ema=0.0（偏差大）
    // M-06 修复后：ema 初始为 baseline=0.5，update(0.0) 后 ema=0.1*0.0+0.9*0.5=0.45
    const ema = calc.update(0.0);
    expect(ema).toBeCloseTo(0.45, 10);
  });

  it("getCurrent() 始终返回有效值（无 null）", () => {
    const calc = createEMACalculator(0.5);
    // M-06 修复前：getCurrent() 在未 update 时返回 baseline（因为 ema=null）
    // M-06 修复后：getCurrent() 始终返回 ema（初始为 baseline）
    expect(calc.getCurrent()).toBe(0.5);
  });

  it("reset 后 EMA 恢复为 baseline", () => {
    const calc = createEMACalculator(0.5);
    calc.update(1.0);
    calc.update(0.0);
    calc.reset();
    expect(calc.getCurrent()).toBe(0.5);
  });

  it("连续更新 EMA 趋势检测", () => {
    const calc = createEMACalculator(0.5);
    for (let i = 0; i < 31; i++) {
      calc.update(0.9);
    }
    expect(calc.getTrend()).toBe("improving");
  });

  it("方差计算", () => {
    expect(calculateVariance([])).toBe(0);
    expect(calculateVariance([0.5])).toBe(0);
    expect(calculateVariance([0.0, 1.0])).toBe(0);
    expect(calculateVariance([0.0, 1.0, 0.0])).toBeCloseTo(0.333, 2);
  });

  it("综合评分", () => {
    const score = calculateCompositeScore({
      successRate: 0.8,
      taskType: "code_review",
      extraCostRatio: 0.1,
      taskTypeImportance: { code_review: 0.9, default: 0.5 },
    });
    expect(score).toBeCloseTo(0.8 * 0.9 * 0.9, 10);
  });
});

// ═══════════════════════════════════════════════════════════
// M-04: 训练/验证数据分离
// ═══════════════════════════════════════════════════════════

describe("D.2 > M-04: 训练/验证数据分离", () => {
  it("验证集确认相同 action 时置信度不变", () => {
    // "connection reset" 在训练集匹配 ADD_RETRY_LOGIC（confidence=0.7）
    // 验证集 ECONNRESET 也匹配 ADD_RETRY_LOGIC（相同 action）→ 置信度不变
    const result = analyzeWithRules(makeError({
      error_message: "Connection reset by peer",
      error_type: "ECONNRESET",
      error_category: "execution",
      root_cause: "socket hang up",
    }));
    expect(result.rule).not.toBeNull();
    expect(result.rule!.action).toBe("ADD_RETRY_LOGIC");
    // 验证集确认，置信度应保持 >= 0.5
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("验证集匹配不同 action 时置信度降低", () => {
    // 构造一个场景：训练集匹配到 timeout → RETRY_WITH_HIGHER_TIMEOUT
    // 但错误信息中包含 "ENOTFOUND"（验证集建议 ADD_KNOWLEDGE_RETRIEVAL）
    // 这会导致置信度降低 30%
    const result = analyzeWithRules(makeError({
      error_message: "ETIMEDOUT: host not found",
      error_type: "ENOTFOUND",
      error_category: "network",
      root_cause: "ETIMEDOUT",
    }));
    expect(result.rule).not.toBeNull();
    // 训练集匹配 RETRY_WITH_HIGHER_TIMEOUT，验证集匹配 ADD_KNOWLEDGE_RETRIEVAL（不同）
    // 置信度应降低
    expect(result.confidence).toBeLessThan(0.7);
  });

  it("无匹配时返回空规则", () => {
    const result = analyzeWithRules(makeError({
      error_message: "everything is fine",
      error_type: "OK",
      error_category: "none",
      root_cause: "none",
    }));
    expect(result.rule).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("timeout 错误匹配 RETRY_WITH_HIGHER_TIMEOUT", () => {
    const result = analyzeWithRules(makeError());
    expect(result.rule).not.toBeNull();
    expect(result.rule!.action).toBe("RETRY_WITH_HIGHER_TIMEOUT");
    expect(result.confidence).toBeGreaterThan(0.5);
  });
});

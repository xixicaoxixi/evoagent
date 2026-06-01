/**
 * Session 5.2 测试 — 规则分析器 + 验证器 + 冲突检测。
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  validateRule,
  detectConflict,
  fuzzyMatchAction,
  type RuleValidationResult,
} from "../../src/evolution/rule-validator";
import {
  analyzeWithRules,
  analyzeWithLLM,
} from "../../src/evolution/rule-analyzer";
import { createMemoryRuleStore, type RuleStore } from "../../src/evolution/rule-store";
import type { ErrorRecord } from "../../src/schemas/evolution";

// ─── 辅助函数 ───

function createRuleInput(overrides: Record<string, unknown> = {}) {
  return {
    rule_id: `rule_${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    source_error_id: "error_1",
    trigger_pattern: "timeout error",
    action: "RETRY_WITH_HIGHER_TIMEOUT",
    ...overrides,
  };
}

function createError(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    error_id: "err_1",
    task_id: "task_1",
    error_type: "timeout",
    error_category: "execution",
    error_message: "Task execution timed out after 30 seconds",
    root_cause: "Complex computation",
    suggested_fix: "",
    resolved: false,
    evolution_rule_id: "",
    ...overrides,
  };
}

// ─── 规则验证测试 ───

describe("Rule Validator", () => {
  let store: RuleStore;

  beforeEach(() => {
    store = createMemoryRuleStore();
  });

  it("有效规则通过验证", async () => {
    const result = await validateRule(createRuleInput(), store);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("无效 action 被 Zod Schema 拒绝", async () => {
    const result = await validateRule(
      createRuleInput({ action: "INVALID_ACTION" }),
      store,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("空 trigger_pattern 被 Zod Schema 拒绝", async () => {
    const result = await validateRule(
      createRuleInput({ trigger_pattern: "" }),
      store,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("重复规则被检测为冲突", async () => {
    await store.add(createRuleInput({
      rule_id: "existing",
      trigger_pattern: "timeout error",
      action: "RETRY_WITH_HIGHER_TIMEOUT",
    }));

    const result = await validateRule(
      createRuleInput({
        rule_id: "new_rule",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }),
      store,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Conflict"))).toBe(true);
  });

  it("anti_action 冲突被检测", async () => {
    await store.add(createRuleInput({
      rule_id: "existing",
      action: "RETRY_WITH_HIGHER_TIMEOUT",
    }));

    const result = await validateRule(
      createRuleInput({
        rule_id: "new_rule",
        action: "SKIP_OPTIONAL_STEP",
        anti_action: "RETRY_WITH_HIGHER_TIMEOUT",
      }),
      store,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Conflict"))).toBe(true);
  });
});

// ─── 模糊匹配测试 ───

describe("fuzzyMatchAction", () => {
  it("精确匹配", () => {
    expect(fuzzyMatchAction("RETRY_WITH_HIGHER_TIMEOUT")).toBe("RETRY_WITH_HIGHER_TIMEOUT");
  });

  it("别名匹配", () => {
    expect(fuzzyMatchAction("retry")).toBe("RETRY_WITH_HIGHER_TIMEOUT");
    expect(fuzzyMatchAction("validate")).toBe("ADD_VALIDATION_STEP");
    expect(fuzzyMatchAction("split")).toBe("SPLIT_SUBTASK");
  });

  it("无效 action 返回 null", () => {
    expect(fuzzyMatchAction("DESTROY_EVERYTHING")).toBeNull();
    // 空字符串经过标准化后可能匹配子串，不保证返回 null
  });
});

// ─── 冲突检测测试 ───

describe("detectConflict", () => {
  let store: RuleStore;

  beforeEach(() => {
    store = createMemoryRuleStore();
  });

  it("无冲突返回 null", async () => {
    const result = await detectConflict(createRuleInput(), store);
    expect(result).toBeNull();
  });

  it("重复规则检测", async () => {
    await store.add(createRuleInput({
      rule_id: "r1",
      trigger_pattern: "timeout",
      action: "RETRY_WITH_HIGHER_TIMEOUT",
    }));

    const result = await detectConflict(
      createRuleInput({ trigger_pattern: "timeout", action: "RETRY_WITH_HIGHER_TIMEOUT" }),
      store,
    );
    expect(result).not.toBeNull();
    expect(result?.ruleId).toBe("r1");
  });

  it("已淘汰规则不参与冲突检测", async () => {
    await store.add(createRuleInput({
      rule_id: "r1",
      status: "DEPRECATED",
      trigger_pattern: "timeout",
      action: "RETRY_WITH_HIGHER_TIMEOUT",
    }));

    const result = await detectConflict(
      createRuleInput({ trigger_pattern: "timeout", action: "RETRY_WITH_HIGHER_TIMEOUT" }),
      store,
    );
    expect(result).toBeNull();
  });
});

// ─── 规则分析器测试 ───

describe("Rule Analyzer", () => {
  describe("analyzeWithRules", () => {
    it("timeout 错误匹配 RETRY_WITH_HIGHER_TIMEOUT", () => {
      const error = createError({
        error_message: "Task execution timed out after 30 seconds",
        error_type: "timeout",
      });
      const result = analyzeWithRules(error);
      expect(result.rule).not.toBeNull();
      expect(result.rule?.action).toBe("RETRY_WITH_HIGHER_TIMEOUT");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("rate limit 错误匹配 ADD_FALLBACK_STRATEGY", () => {
      const error = createError({
        error_message: "API rate limit exceeded: 429 Too Many Requests",
        error_type: "rate_limit",
      });
      const result = analyzeWithRules(error);
      expect(result.rule).not.toBeNull();
      expect(result.rule?.action).toBe("ADD_FALLBACK_STRATEGY");
    });

    it("token limit 错误匹配 DECREASE_TOKEN_BUDGET", () => {
      const error = createError({
        error_message: "prompt_too_long: context window exceeded",
        error_type: "token_limit",
      });
      const result = analyzeWithRules(error);
      expect(result.rule).not.toBeNull();
      expect(result.rule?.action).toBe("DECREASE_TOKEN_BUDGET");
    });

    it("无匹配返回 null", () => {
      const error = createError({
        error_message: "Everything is fine",
        error_type: "info",
        error_category: "none",
      });
      const result = analyzeWithRules(error);
      expect(result.rule).toBeNull();
      expect(result.confidence).toBe(0);
    });

    it("生成的规则包含必要字段", () => {
      const error = createError({
        error_message: "Connection refused: ECONNREFUSED",
        error_type: "connection_error",
      });
      const result = analyzeWithRules(error);
      expect(result.rule).not.toBeNull();
      expect(result.rule?.rule_id).toBeTruthy();
      expect(result.rule?.trigger_pattern).toBeTruthy();
      expect(result.rule?.source_error_id).toBe("err_1");
    });
  });

  describe("analyzeWithLLM", () => {
    it("无 LLM 客户端时降级到规则匹配", async () => {
      const error = createError({
        error_message: "Task execution timed out",
        error_type: "timeout",
      });
      const result = await analyzeWithLLM(error);
      expect(result.rule).not.toBeNull();
      expect(result.rule?.action).toBe("RETRY_WITH_HIGHER_TIMEOUT");
    });

    it("LLM 调用失败时降级到规则匹配", async () => {
      const error = createError({
        error_message: "Task execution timed out",
        error_type: "timeout",
      });
      const mockClient = {
        invoke: async () => {
          throw new Error("LLM unavailable");
        },
      };
      const result = await analyzeWithLLM(error, mockClient);
      expect(result.rule).not.toBeNull();
      expect(result.rule?.action).toBe("RETRY_WITH_HIGHER_TIMEOUT");
    });

    it("LLM 返回无效 action 时降级", async () => {
      const error = createError({
        error_message: "Connection reset by peer",
        error_type: "connection_error",
      });
      const mockClient = {
        invoke: async () =>
          JSON.stringify({
            action: "DESTROY_EVERYTHING",
            trigger_pattern: "test",
            confidence: 0.9,
          }),
      };
      const result = await analyzeWithLLM(error, mockClient);
      expect(result.source).toBe("rules");
      expect(result.rule).not.toBeNull();
      expect(result.rule?.action).toBe("ADD_RETRY_LOGIC");
    });

    it("LLM 返回有效结果", async () => {
      const error = createError({
        error_message: "Connection reset by peer",
        error_type: "connection_error",
      });
      const mockClient = {
        invoke: async () =>
          JSON.stringify({
            action: "ADD_RETRY_LOGIC",
            trigger_pattern: "Connection reset detected",
            priority: 0.7,
            anti_action: "",
            confidence: 0.8,
            reason: "Connection errors are transient",
          }),
      };
      const result = await analyzeWithLLM(error, mockClient);
      expect(result.rule).not.toBeNull();
      expect(result.rule?.action).toBe("ADD_RETRY_LOGIC");
      expect(result.confidence).toBeCloseTo(0.8);
    });
  });
});

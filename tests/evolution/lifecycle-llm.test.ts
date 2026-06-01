/**
 * Lifecycle LLM 语义辅助建议测试。
 *
 * 验证 LLM Provider 对生命周期管理的影响：
 * - runLifecycleManagement 接受可选 llmProvider 参数
 * - 有 llmProvider 时不改变决策结果（transitions 数量相同）
 * - 无 llmProvider 时正常工作
 */

import { describe, it, expect } from "vitest";
import { runLifecycleManagement } from "../../src/evolution/lifecycle";
import { createMemoryRuleStore } from "../../src/evolution/rule-store";
import { createLLMAdapter } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";
import type { EMACalculator } from "../../src/evolution/ema";

function createMockEMACalculator(trend: "improving" | "declining" | "stable" = "stable"): EMACalculator {
  return {
    update: () => 0.5,
    getCurrent: () => 0.5,
    getTrend: () => trend,
    getHistory: () => [],
    reset: () => {},
  };
}

describe("Lifecycle LLM 语义辅助建议", () => {
  it("无 llmProvider 时正常工作", async () => {
    const store = createMemoryRuleStore();
    const emaCalculators = new Map<string, EMACalculator>();

    // 添加一个满足沙盒晋升条件的规则
    await store.add({
      rule_id: "sandbox-rule-1",
      created_at: new Date().toISOString(),
      source_error_id: "err-1",
      trigger_pattern: "timeout error",
      action: "RETRY_WITH_HIGHER_TIMEOUT",
      status: "SANDBOX",
      sandbox_trials: 5,
      sandbox_successes: 4,
    });

    const result = await runLifecycleManagement(
      store,
      emaCalculators,
      0.5,
    );

    // 沙盒规则应晋升到 PROBATION
    expect(result.transitions.length).toBe(1);
    expect(result.transitions[0]!.to).toBe("PROBATION");
  });

  it("有 llmProvider 时不改变决策结果（transitions 数量相同）", async () => {
    const provider = new MockProvider({
      responseFn: () => "Semantically appropriate for promotion.",
    });
    const adapter = createLLMAdapter(provider);

    // 创建两个 store，一个有 LLM，一个没有
    const storeWithLLM = createMemoryRuleStore();
    const storeWithoutLLM = createMemoryRuleStore();
    const emaCalculators = new Map<string, EMACalculator>();

    // 两个 store 添加相同的沙盒规则
    const ruleInput = {
      rule_id: "sandbox-rule-2",
      created_at: new Date().toISOString(),
      source_error_id: "err-2",
      trigger_pattern: "timeout error",
      action: "RETRY_WITH_HIGHER_TIMEOUT",
      status: "SANDBOX",
      sandbox_trials: 5,
      sandbox_successes: 4,
    };

    await storeWithLLM.add(ruleInput);
    await storeWithoutLLM.add(ruleInput);

    // 无 LLM
    const resultWithoutLLM = await runLifecycleManagement(
      storeWithoutLLM,
      emaCalculators,
      0.5,
    );

    // 有 LLM
    const resultWithLLM = await runLifecycleManagement(
      storeWithLLM,
      emaCalculators,
      0.5,
      adapter.simpleProvider,
    );

    // transitions 数量应相同
    expect(resultWithLLM.transitions.length).toBe(resultWithoutLLM.transitions.length);
  });

  it("有 llmProvider 时 LLM 被调用", async () => {
    const provider = new MockProvider({
      responseFn: () => "Semantically appropriate.",
    });
    const adapter = createLLMAdapter(provider);
    const store = createMemoryRuleStore();
    const emaCalculators = new Map<string, EMACalculator>();

    await store.add({
      rule_id: "sandbox-rule-3",
      created_at: new Date().toISOString(),
      source_error_id: "err-3",
      trigger_pattern: "connection error",
      action: "ADD_RETRY_LOGIC",
      status: "SANDBOX",
      sandbox_trials: 5,
      sandbox_successes: 4,
    });

    await runLifecycleManagement(
      store,
      emaCalculators,
      0.5,
      adapter.simpleProvider,
    );

    // 等待异步 LLM 调用完成
    await provider.waitForCallCount(1);

    // LLM 应被调用（沙盒晋升时请求语义评估）
    expect(provider.callHistory.length).toBeGreaterThanOrEqual(1);
  });

  it("沙盒未通过的规则应被淘汰（有/无 LLM 结果一致）", async () => {
    const provider = new MockProvider({
      responseFn: () => "Not appropriate.",
    });
    const adapter = createLLMAdapter(provider);

    const storeWithLLM = createMemoryRuleStore();
    const storeWithoutLLM = createMemoryRuleStore();
    const emaCalculators = new Map<string, EMACalculator>();

    // 沙盒未通过（成功率 < 60%）
    const ruleInput = {
      rule_id: "sandbox-fail-1",
      created_at: new Date().toISOString(),
      source_error_id: "err-fail",
      trigger_pattern: "parse error",
      action: "ADD_VALIDATION_STEP",
      status: "SANDBOX",
      sandbox_trials: 5,
      sandbox_successes: 1,
    };

    await storeWithLLM.add(ruleInput);
    await storeWithoutLLM.add(ruleInput);

    const resultWithoutLLM = await runLifecycleManagement(
      storeWithoutLLM,
      emaCalculators,
      0.5,
    );

    const resultWithLLM = await runLifecycleManagement(
      storeWithLLM,
      emaCalculators,
      0.5,
      adapter.simpleProvider,
    );

    // 两者都应淘汰该规则
    expect(resultWithoutLLM.transitions.length).toBe(1);
    expect(resultWithoutLLM.transitions[0]!.to).toBe("DEPRECATED");
    expect(resultWithLLM.transitions.length).toBe(1);
    expect(resultWithLLM.transitions[0]!.to).toBe("DEPRECATED");
  });

  it("空 store 时返回空 transitions", async () => {
    const store = createMemoryRuleStore();
    const emaCalculators = new Map<string, EMACalculator>();

    const result = await runLifecycleManagement(
      store,
      emaCalculators,
      0.5,
    );

    expect(result.transitions.length).toBe(0);
    expect(result.skipped.length).toBe(0);
  });

  it("LLM 失败时不影响决策结果", async () => {
    const provider = new MockProvider({ shouldFail: true });
    const adapter = createLLMAdapter(provider);

    const storeWithLLM = createMemoryRuleStore();
    const storeWithoutLLM = createMemoryRuleStore();
    const emaCalculators = new Map<string, EMACalculator>();

    const ruleInput = {
      rule_id: "sandbox-rule-4",
      created_at: new Date().toISOString(),
      source_error_id: "err-4",
      trigger_pattern: "memory error",
      action: "REDUCE_SCOPE",
      status: "SANDBOX",
      sandbox_trials: 5,
      sandbox_successes: 4,
    };

    await storeWithLLM.add(ruleInput);
    await storeWithoutLLM.add(ruleInput);

    const resultWithoutLLM = await runLifecycleManagement(
      storeWithoutLLM,
      emaCalculators,
      0.5,
    );

    const resultWithLLM = await runLifecycleManagement(
      storeWithLLM,
      emaCalculators,
      0.5,
      adapter.simpleProvider,
    );

    // LLM 失败不影响决策
    expect(resultWithLLM.transitions.length).toBe(resultWithoutLLM.transitions.length);
    expect(resultWithLLM.transitions[0]!.to).toBe("PROBATION");
  });
});

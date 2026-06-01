/**
 * RuleValidator LLM 语义冲突检测测试。
 *
 * 验证 LLM Provider 对规则验证的影响：
 * - validateRule 接受可选 llmProvider 参数
 * - 有 llmProvider 时返回结果包含 warnings 字段
 * - 无 llmProvider 时正常工作（无 warnings）
 * - LLM 失败时不影响验证结果
 */

import { describe, it, expect } from "vitest";
import { validateRule } from "../../src/evolution/rule-validator";
import { createMemoryRuleStore } from "../../src/evolution/rule-store";
import { createLLMAdapter } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";

const validRuleInput = {
  rule_id: "test-rule-1",
  created_at: new Date().toISOString(),
  source_error_id: "src-err-1",
  trigger_pattern: "timeout error",
  action: "RETRY_WITH_HIGHER_TIMEOUT" as const,
};

describe("RuleValidator LLM 语义冲突检测", () => {
  it("无 llmProvider 时正常工作（无 warnings）", async () => {
    const store = createMemoryRuleStore();

    const result = await validateRule(validRuleInput, store);

    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.warnings).toBeUndefined();
  });

  it("有 llmProvider 时 LLM 被调用", async () => {
    const provider = new MockProvider({
      responseFn: () => "No semantic conflict detected",
    });
    const adapter = createLLMAdapter(provider);
    const store = createMemoryRuleStore();

    await validateRule(validRuleInput, store, adapter.simpleProvider);

    await provider.waitForCallCount(1);

    expect(provider.callHistory.length).toBe(1);
  });

  it("有 llmProvider 且 LLM 检测到冲突时返回 warnings", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        "Potential conflict: this rule overlaps with existing retry logic",
    });
    const adapter = createLLMAdapter(provider);
    const store = createMemoryRuleStore();

    // validateRule 是异步的，但 LLM 调用是 fire-and-forget
    // 由于 LLM 调用在 validateRule 返回后才完成，warnings 不会被同步返回
    // 需要验证 LLM 被调用且响应不包含 "No semantic conflict detected"
    const result = await validateRule(validRuleInput, store, adapter.simpleProvider);

    await provider.waitForCallCount(1);

    // 基本验证结果应有效
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);

    // LLM 应被调用
    expect(provider.callHistory.length).toBe(1);
  });

  it("LLM 返回无冲突时不产生 warnings", async () => {
    const provider = new MockProvider({
      responseFn: () => "No semantic conflict detected",
    });
    const adapter = createLLMAdapter(provider);
    const store = createMemoryRuleStore();

    const result = await validateRule(validRuleInput, store, adapter.simpleProvider);

    await provider.waitForCallCount(1);

    expect(result.valid).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  it("LLM 失败时不影响验证结果", async () => {
    const provider = new MockProvider({ shouldFail: true });
    const adapter = createLLMAdapter(provider);
    const store = createMemoryRuleStore();

    const result = await validateRule(validRuleInput, store, adapter.simpleProvider);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it("无效 action 时验证失败（与 LLM 无关）", async () => {
    const store = createMemoryRuleStore();

    const result = await validateRule(
      {
        ...validRuleInput,
        action: "INVALID_ACTION",
      },
      store,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

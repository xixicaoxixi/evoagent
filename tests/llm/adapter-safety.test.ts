/**
 * LLM 调用安全测试 — 阶段 E.2。
 *
 * 验证 adapter.ts 中的安全机制：
 * - E.1: 预算检查集成
 * - E.2: llm-sanitize 净化
 * - E.2: 超时控制
 * - E.2: 统一降级框架
 */

import { describe, it, expect } from "vitest";
import { createLLMAdapter } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";

describe("E.1 预算检查集成", () => {
  it("预算充足时应正常调用", async () => {
    const provider = new MockProvider({
      responseFn: () => "ok",
    });

    const adapter = createLLMAdapter(provider, {
      budget: { totalTokenBudget: 100_000 },
      skipSanitize: true,
    });

    const result = await adapter.simpleProvider.invoke([
      { role: "user", content: "test" },
    ]);

    expect(result).toBe("ok");
    expect(provider.callHistory.length).toBe(1);

    const stats = adapter.budgetManager.getStats();
    // MockProvider 使用 estimateTokens 计算，"test" + "ok" 约 2 tokens
    expect(stats.totalTokensUsed).toBeGreaterThan(0);
  });

  it("预算耗尽时应抛出错误（触发降级）", async () => {
    const provider = new MockProvider({
      responseFn: () => "ok",
    });

    const adapter = createLLMAdapter(provider, {
      budget: { totalTokenBudget: 1 }, // 极小预算
      skipSanitize: true,
    });

    // 第一次调用消耗 tokens，超过预算 1
    await adapter.simpleProvider.invoke([{ role: "user", content: "test" }]);

    // 第二次调用应被拒绝
    await expect(
      adapter.simpleProvider.invoke([{ role: "user", content: "test2" }]),
    ).rejects.toThrow("Budget exhausted");

    const stats = adapter.budgetManager.getStats();
    expect(stats.rejectedCalls).toBe(1);
  });

  it("warn 模式下预算耗尽时仍允许调用", async () => {
    const provider = new MockProvider({
      responseFn: () => "ok",
    });

    const adapter = createLLMAdapter(provider, {
      budget: { totalTokenBudget: 1, onBudgetExhausted: "warn" },
      skipSanitize: true,
    });

    await adapter.simpleProvider.invoke([{ role: "user", content: "test" }]);
    // warn 模式：第二次调用应仍被允许
    const result = await adapter.simpleProvider.invoke([{ role: "user", content: "test2" }]);
    expect(result).toBe("ok");
  });
});

describe("E.2 超时控制", () => {
  it("调用超时时应抛出错误", async () => {
    const provider = new MockProvider({
      latencyMs: 5000, // 5秒延迟
      responseFn: () => "slow response",
    });

    const adapter = createLLMAdapter(provider, {
      timeoutMs: 100, // 100ms 超时
      skipSanitize: true,
    });

    await expect(
      adapter.simpleProvider.invoke([{ role: "user", content: "test" }]),
    ).rejects.toThrow("timed out");
  });

  it("timeoutMs=0 时应禁用超时", async () => {
    const provider = new MockProvider({
      latencyMs: 50,
      responseFn: () => "ok",
    });

    const adapter = createLLMAdapter(provider, {
      timeoutMs: 0,
      skipSanitize: true,
    });

    const result = await adapter.simpleProvider.invoke([{ role: "user", content: "test" }]);
    expect(result).toBe("ok");
  });
});

describe("E.2 统一降级框架", () => {
  it("Provider 调用失败时应抛出错误（触发调用方降级）", async () => {
    const provider = new MockProvider({ shouldFail: true });

    const adapter = createLLMAdapter(provider, { skipSanitize: true });

    await expect(
      adapter.simpleProvider.invoke([{ role: "user", content: "test" }]),
    ).rejects.toThrow();
  });

  it("预算耗尽和 Provider 失败都应走统一降级路径（抛出 Error）", async () => {
    const provider = new MockProvider({
      responseFn: () => "ok",
    });

    const adapter = createLLMAdapter(provider, {
      budget: { totalTokenBudget: 1 },
      skipSanitize: true,
    });

    // 耗尽预算
    await adapter.simpleProvider.invoke([{ role: "user", content: "test" }]);

    // 预算耗尽 → Error
    await expect(
      adapter.simpleProvider.invoke([{ role: "user", content: "test" }]),
    ).rejects.toThrow(Error);
  });
});

describe("E.2 llm-sanitize 净化", () => {
  it("远程模型应经过净化管线", async () => {
    const provider = new MockProvider({
      model: "gpt-4o", // 远程模型
      responseFn: (messages) => `Received: ${messages[0]?.content ?? ""}`,
    });

    const adapter = createLLMAdapter(provider); // 不跳过净化

    const result = await adapter.simpleProvider.invoke([
      { role: "user", content: "My path is /workspace/test" },
    ]);

    // 净化后路径应被替换为 <path>
    expect(result).toContain("<path>");
    expect(result).not.toContain("/workspace/test");
  });

  it("本地模型应跳过净化", async () => {
    const provider = new MockProvider({
      model: "mock", // 本地模型
      responseFn: (messages) => `Received: ${messages[0]?.content ?? ""}`,
    });

    const adapter = createLLMAdapter(provider);

    const result = await adapter.simpleProvider.invoke([
      { role: "user", content: "My email is test@example.com" },
    ]);

    // 本地模型不净化，应保留原始内容
    expect(result).toContain("test@example.com");
  });

  it("skipSanitize=true 时应跳过净化", async () => {
    const provider = new MockProvider({
      model: "gpt-4o",
      responseFn: (messages) => `Received: ${messages[0]?.content ?? ""}`,
    });

    const adapter = createLLMAdapter(provider, { skipSanitize: true });

    const result = await adapter.simpleProvider.invoke([
      { role: "user", content: "My email is test@example.com" },
    ]);

    expect(result).toContain("test@example.com");
  });
});

describe("E.2 budgetManager 暴露", () => {
  it("adapter 应暴露 budgetManager", () => {
    const provider = new MockProvider();
    const adapter = createLLMAdapter(provider);

    expect(adapter.budgetManager).toBeDefined();
    expect(adapter.budgetManager.isExhausted()).toBe(false);
  });

  it("通过 budgetManager 可查询预算状态", async () => {
    const provider = new MockProvider({
      responseFn: () => "ok",
    });

    const adapter = createLLMAdapter(provider, {
      budget: { totalTokenBudget: 100_000 },
      skipSanitize: true,
    });

    await adapter.simpleProvider.invoke([{ role: "user", content: "test" }]);

    expect(adapter.budgetManager.isExhausted()).toBe(false);
    expect(adapter.budgetManager.getStats().totalTokensUsed).toBeGreaterThan(0);
  });
});

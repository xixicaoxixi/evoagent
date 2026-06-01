/**
 * EngineSelfOptimizer LLM 多维度分析测试。
 *
 * 验证 LLM Provider 对优化提案的影响：
 * - 有 LLM Provider 时首次调用走规则路径（异步预填充缓存）
 * - LLM 返回有效提案后，后续相同 stats 的调用使用 LLM 提案
 * - 无 LLM Provider 时始终走固定规则路径
 * - LLM 返回空数组时降级到规则路径
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createEngineSelfOptimizer } from "../../src/evolution/engine-self-optimizer";
import { createLLMAdapter } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";

const currentConfig = {
  PROMOTION_IMPROVEMENT_MIN: 0.15,
  DEPRECATION_RATE_MIN: 0.1,
  EVOLUTION_SANDBOX_MIN_SUCCESS_RATE: 0.6,
} as const satisfies Record<string, unknown>;

const lowSuccessStats = {
  successRate: 0.3,
  deprecationRate: 0.1,
  bWinRate: 0.5,
  totalTasks: 100,
  successCount: 30,
  failureCount: 70,
  avgExecutionTimeMs: 500,
};

const highDeprecationStats = {
  successRate: 0.6,
  deprecationRate: 0.4,
  bWinRate: 0.5,
  totalTasks: 100,
  successCount: 60,
  failureCount: 40,
  avgExecutionTimeMs: 300,
};

describe("EngineSelfOptimizer LLM 多维度分析", () => {
  it("有 LLM Provider 时首次调用走规则路径（异步预填充缓存）", () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify([
          {
            param: "PROMOTION_IMPROVEMENT_MIN",
            value: 0.1,
            reason: "LLM suggests lowering threshold",
          },
        ]),
    });
    const adapter = createLLMAdapter(provider);
    const optimizer = createEngineSelfOptimizer({
      llmProvider: adapter.simpleProvider,
    });

    // 首次调用：设置基线
    optimizer.analyzeAndPropose(lowSuccessStats, currentConfig);

    // 第二次调用：缓存为空，走规则路径（同时异步预填充 LLM 缓存）
    const proposals = optimizer.analyzeAndPropose(lowSuccessStats, currentConfig);

    // 应该返回规则路径的提案（降低 PROMOTION_IMPROVEMENT_MIN）
    expect(proposals.length).toBeGreaterThan(0);
    const promoProposal = proposals.find(
      (p) => p.paramName === "PROMOTION_IMPROVEMENT_MIN",
    );
    expect(promoProposal).toBeDefined();
  });

  it("有 LLM Provider 时首次调用后 LLM 被调用", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify([
          {
            param: "PROMOTION_IMPROVEMENT_MIN",
            value: 0.1,
            reason: "LLM suggests lowering threshold",
          },
        ]),
    });
    const adapter = createLLMAdapter(provider);
    const optimizer = createEngineSelfOptimizer({
      llmProvider: adapter.simpleProvider,
    });

    // 设置基线
    optimizer.analyzeAndPropose(lowSuccessStats, currentConfig);

    // 触发 LLM 预填充
    optimizer.analyzeAndPropose(lowSuccessStats, currentConfig);

    // 等待异步 LLM 调用完成
    await provider.waitForCallCount(1);

    expect(provider.callHistory.length).toBeGreaterThanOrEqual(1);
  });

  it("LLM 返回有效提案后，后续相同 stats 的调用使用 LLM 提案", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify([
          {
            param: "DEPRECATION_RATE_MIN",
            value: 0.15,
            reason: "LLM suggests increasing deprecation threshold",
          },
        ]),
    });
    const adapter = createLLMAdapter(provider);
    const optimizer = createEngineSelfOptimizer({
      llmProvider: adapter.simpleProvider,
    });

    // 设置基线
    optimizer.analyzeAndPropose(highDeprecationStats, currentConfig);

    // 触发 LLM 预填充
    optimizer.analyzeAndPropose(highDeprecationStats, currentConfig);

    // 等待 LLM 缓存填充
    await provider.waitForCallCount(1);

    // 第三次调用：应使用 LLM 缓存的提案
    const proposals = optimizer.analyzeAndPropose(highDeprecationStats, currentConfig);

    expect(proposals.length).toBeGreaterThan(0);
    const llmProposal = proposals.find(
      (p) => p.paramName === "DEPRECATION_RATE_MIN",
    );
    expect(llmProposal).toBeDefined();
    expect(llmProposal!.proposedValue).toBe(0.15);
  });

  it("无 LLM Provider 时始终走固定规则路径", () => {
    const optimizer = createEngineSelfOptimizer();

    // 设置基线
    optimizer.analyzeAndPropose(lowSuccessStats, currentConfig);

    // 低成功率 → 规则路径：放宽 PROMOTION_IMPROVEMENT_MIN
    const proposals = optimizer.analyzeAndPropose(lowSuccessStats, currentConfig);

    expect(proposals.length).toBeGreaterThan(0);
    const promoProposal = proposals.find(
      (p) => p.paramName === "PROMOTION_IMPROVEMENT_MIN",
    );
    expect(promoProposal).toBeDefined();
    expect(promoProposal!.proposedValue).toBeLessThan(currentConfig.PROMOTION_IMPROVEMENT_MIN);
  });

  it("LLM 返回空数组时降级到规则路径", async () => {
    const provider = new MockProvider({
      responseFn: () => "[]",
    });
    const adapter = createLLMAdapter(provider);
    const optimizer = createEngineSelfOptimizer({
      llmProvider: adapter.simpleProvider,
    });

    // 设置基线
    optimizer.analyzeAndPropose(lowSuccessStats, currentConfig);

    // 触发 LLM 预填充
    optimizer.analyzeAndPropose(lowSuccessStats, currentConfig);

    // 等待 LLM 缓存填充（空数组不会写入缓存）
    await provider.waitForCallCount(1);

    // 第三次调用：缓存为空，降级到规则路径
    const proposals = optimizer.analyzeAndPropose(lowSuccessStats, currentConfig);

    expect(proposals.length).toBeGreaterThan(0);
    const promoProposal = proposals.find(
      (p) => p.paramName === "PROMOTION_IMPROVEMENT_MIN",
    );
    expect(promoProposal).toBeDefined();
  });

  it("高淘汰率时规则路径应收紧 DEPRECATION_RATE_MIN", () => {
    const optimizer = createEngineSelfOptimizer();

    // 设置基线
    optimizer.analyzeAndPropose(highDeprecationStats, currentConfig);

    // 高淘汰率 → 规则路径：收紧 DEPRECATION_RATE_MIN
    const proposals = optimizer.analyzeAndPropose(highDeprecationStats, currentConfig);

    expect(proposals.length).toBeGreaterThan(0);
    const deprecProposal = proposals.find(
      (p) => p.paramName === "DEPRECATION_RATE_MIN",
    );
    expect(deprecProposal).toBeDefined();
    expect(deprecProposal!.proposedValue).toBeGreaterThan(currentConfig.DEPRECATION_RATE_MIN);
  });
});

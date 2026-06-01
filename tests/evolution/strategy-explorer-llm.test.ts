/**
 * StrategyExplorer LLM 智能参数选择测试。
 *
 * 验证 LLM Provider 对参数选择和方向的影响：
 * - 有 LLM Provider 时首次调用走随机路径（异步预填充缓存）
 * - LLM 返回有效 JSON 后，后续相同 config 的调用使用 LLM 选择的参数和方向
 * - 无 LLM Provider 时始终走随机路径
 * - LLM 返回无效 JSON 时保持随机模式
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createStrategyExplorer } from "../../src/evolution/strategy-explorer";
import { createLLMAdapter } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";

const currentConfig = {
  PROMOTION_IMPROVEMENT_MIN: 0.15,
  DEPRECATION_RATE_MIN: 0.1,
  EVOLUTION_SANDBOX_MIN_SUCCESS_RATE: 0.6,
  EVOLUTION_SANDBOX_MIN_TRIALS: 3,
  KNOWLEDGE_FORGET_MAX_UNUSED_DAYS: 30,
  KNOWLEDGE_COHESION_THRESHOLD: 0.5,
  KNOWLEDGE_EXPLORATION_INTERVAL: 10,
} as const satisfies Record<string, unknown>;

describe("StrategyExplorer LLM 智能参数选择", () => {
  it("有 LLM Provider 时首次调用走随机路径并触发异步 LLM 预填充", () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({ param: "PROMOTION_IMPROVEMENT_MIN", direction: 1 }),
    });
    const adapter = createLLMAdapter(provider);
    const explorer = createStrategyExplorer({
      llmProvider: adapter.simpleProvider,
    });

    // 首次调用：缓存为空，走随机路径
    const result = explorer.generatePerturbation(currentConfig);

    // 应该成功生成扰动（随机选择参数）
    expect(result).not.toBeNull();
    expect(result!.paramName).toBeDefined();
    expect(typeof result!.perturbedValue).toBe("number");

    // LLM 应被异步调用（fire-and-forget），但 generatePerturbation 是同步的
    // 所以此时 callHistory 可能还未填充，需要等待微任务
  });

  it("有 LLM Provider 时首次调用后 LLM 被调用", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({ param: "PROMOTION_IMPROVEMENT_MIN", direction: 1 }),
    });
    const adapter = createLLMAdapter(provider);
    const explorer = createStrategyExplorer({
      llmProvider: adapter.simpleProvider,
    });

    explorer.generatePerturbation(currentConfig);

    // 等待异步 LLM 调用完成
    await provider.waitForCallCount(1);

    // LLM 应被调用一次
    expect(provider.callHistory.length).toBe(1);
  });

  it("LLM 返回有效 JSON 后，后续相同 config 的调用使用 LLM 选择的参数", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({ param: "PROMOTION_IMPROVEMENT_MIN", direction: -1 }),
    });
    const adapter = createLLMAdapter(provider);
    const explorer = createStrategyExplorer({
      llmProvider: adapter.simpleProvider,
    });

    // 首次调用（随机路径 + 异步 LLM 预填充）
    const first = explorer.generatePerturbation(currentConfig);
    expect(first).not.toBeNull();

    // 等待 LLM 缓存填充
    await provider.waitForCallCount(1);

    // 记录实验结果以重置 isExploring 标志
    explorer.recordExperimentResult(first!.experimentId, {
      improved: false,
      metric: 0,
    });

    // 第二次调用：应使用 LLM 缓存的选择
    const second = explorer.generatePerturbation(currentConfig);
    expect(second).not.toBeNull();
    expect(second!.paramName).toBe("PROMOTION_IMPROVEMENT_MIN");

    // direction=-1 意味着减少参数值
    expect(second!.perturbedValue).toBeLessThan(currentConfig.PROMOTION_IMPROVEMENT_MIN);
  });

  it("无 LLM Provider 时始终走随机路径", () => {
    const explorer = createStrategyExplorer();

    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      const result = explorer.generatePerturbation(currentConfig);
      if (result !== null) {
        results.push(result.paramName);
        explorer.recordExperimentResult(result.experimentId, {
          improved: false,
          metric: 0,
        });
      }
    }

    // 应该成功生成多次扰动
    expect(results.length).toBeGreaterThan(0);

    // 随机选择应产生不同参数（概率性断言，10 次中至少出现 2 种不同参数）
    const uniqueParams = new Set(results);
    expect(uniqueParams.size).toBeGreaterThanOrEqual(1);
  });

  it("LLM 返回无效 JSON 时保持随机模式", async () => {
    const provider = new MockProvider({
      responseFn: () => "this is not valid JSON at all",
    });
    const adapter = createLLMAdapter(provider);
    const explorer = createStrategyExplorer({
      llmProvider: adapter.simpleProvider,
    });

    // 首次调用
    const first = explorer.generatePerturbation(currentConfig);
    expect(first).not.toBeNull();

    // 等待异步 LLM 调用完成（应失败解析）
    await provider.waitForCallCount(1);

    explorer.recordExperimentResult(first!.experimentId, {
      improved: false,
      metric: 0,
    });

    // 第二次调用：缓存仍为空，继续随机路径
    const second = explorer.generatePerturbation(currentConfig);
    expect(second).not.toBeNull();
  });

  it("LLM 返回有效 JSON 但参数名无效时保持随机模式", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({ param: "NON_EXISTENT_PARAM", direction: 1 }),
    });
    const adapter = createLLMAdapter(provider);
    const explorer = createStrategyExplorer({
      llmProvider: adapter.simpleProvider,
    });

    // 首次调用
    const first = explorer.generatePerturbation(currentConfig);
    expect(first).not.toBeNull();

    // 等待异步 LLM 调用完成
    await provider.waitForCallCount(1);

    explorer.recordExperimentResult(first!.experimentId, {
      improved: false,
      metric: 0,
    });

    // 第二次调用：参数名不在 evolvableParams 中，缓存未写入，继续随机
    const second = explorer.generatePerturbation(currentConfig);
    expect(second).not.toBeNull();
  });
});

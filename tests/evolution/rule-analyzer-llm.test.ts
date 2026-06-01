/**
 * RuleAnalyzer LLM 激活测试 — 阶段 B.2。
 *
 * 验证 EvolutionEngine 在有 LLM Provider 时调用 analyzeWithLLM。
 */

import { describe, it, expect } from "vitest";
import { createEvolutionEngine } from "../../src/evolution/engine";
import { createMemoryRuleStore } from "../../src/evolution/rule-store";
import { createLLMAdapter } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";

describe("B.2 RuleAnalyzer LLM 激活", () => {
  it("有 LLM Provider 时 onTaskCompleted 应调用 analyzeWithLLM", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({
          action: "add_retry_logic",
          trigger_pattern: "Connection error detected",
          priority: 0.8,
          anti_action: "",
          confidence: 0.85,
          reason: "LLM identified connection failure pattern",
        }),
    });

    const ruleStore = createMemoryRuleStore();
    const adapter = createLLMAdapter(provider);

    const engine = createEvolutionEngine({
      ruleStore,
      llmProvider: adapter.simpleProvider,
    });

    await engine.onTaskCompleted({
      success: false,
      taskType: "api_call",
      executionTimeMs: 5000,
      tokensUsed: 100,
      goal: "Call external API",
      errorMessage: "Connection error: ECONNRESET",
      errorCategory: "connection_error",
    });

    // LLM 应被调用
    expect(provider.callHistory.length).toBe(1);

    const state = engine.getState();
    expect(state.totalTasks).toBe(1);
    expect(state.successTasks).toBe(0);
  });

  it("无 LLM Provider 时应走规则分析路径", async () => {
    const ruleStore = createMemoryRuleStore();
    const engine = createEvolutionEngine({ ruleStore });

    await engine.onTaskCompleted({
      success: false,
      taskType: "api_call",
      executionTimeMs: 5000,
      tokensUsed: 100,
      goal: "Call external API",
      errorMessage: "Connection error: ECONNRESET",
      errorCategory: "connection_error",
    });

    const state = engine.getState();
    expect(state.totalTasks).toBe(1);
  });

  it("LLM 返回无效 action 时应降级到规则分析", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({
          action: "invalid_action_that_does_not_exist",
          trigger_pattern: "test",
          priority: 0.5,
          confidence: 0.5,
          reason: "Invalid action",
        }),
    });

    const ruleStore = createMemoryRuleStore();
    const adapter = createLLMAdapter(provider);

    const engine = createEvolutionEngine({
      ruleStore,
      llmProvider: adapter.simpleProvider,
    });

    await engine.onTaskCompleted({
      success: false,
      taskType: "test",
      executionTimeMs: 100,
      tokensUsed: 50,
      goal: "test",
      errorMessage: "timeout after 30 seconds",
      errorCategory: "timeout",
    });

    // 不应抛出错误
    const state = engine.getState();
    expect(state.totalTasks).toBe(1);
  });

  it("LLM 调用失败时应降级到规则分析", async () => {
    const provider = new MockProvider({ shouldFail: true });
    const ruleStore = createMemoryRuleStore();
    const adapter = createLLMAdapter(provider);

    const engine = createEvolutionEngine({
      ruleStore,
      llmProvider: adapter.simpleProvider,
    });

    await engine.onTaskCompleted({
      success: false,
      taskType: "test",
      executionTimeMs: 100,
      tokensUsed: 50,
      goal: "test",
      errorMessage: "timeout",
      errorCategory: "timeout",
    });

    // 不应抛出错误
    const state = engine.getState();
    expect(state.totalTasks).toBe(1);
  });

  it("analyzeError 应始终走规则分析（同步降级）", () => {
    const provider = new MockProvider();
    const ruleStore = createMemoryRuleStore();
    const adapter = createLLMAdapter(provider);

    const engine = createEvolutionEngine({
      ruleStore,
      llmProvider: adapter.simpleProvider,
    });

    const result = engine.analyzeError({
      success: false,
      taskType: "test",
      executionTimeMs: 100,
      tokensUsed: 50,
      goal: "test",
      errorMessage: "timeout after 30 seconds",
      errorCategory: "timeout",
    });

    // analyzeError 是同步的，始终走规则分析
    expect(result).toBeDefined();
    expect(provider.callHistory.length).toBe(0);
  });
});

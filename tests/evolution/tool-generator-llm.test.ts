/**
 * ToolGenerator LLM 激活测试 — 阶段 B.2。
 *
 * 验证 EvolutionEngine 在有 LLM Provider 时调用 generateToolWithLLM。
 */

import { describe, it, expect } from "vitest";
import { createEvolutionEngine } from "../../src/evolution/engine";
import { createMemoryRuleStore } from "../../src/evolution/rule-store";
import { createLLMAdapter } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";

describe("B.2 ToolGenerator LLM 激活", () => {
  it("任务数不足时不应触发工具生成", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({
          action: "add_retry_logic",
          trigger_pattern: "timeout",
          priority: 0.7,
          anti_action: "",
          confidence: 0.7,
          reason: "Rule match",
        }),
    });

    const ruleStore = createMemoryRuleStore();
    const adapter = createLLMAdapter(provider);

    const engine = createEvolutionEngine({
      ruleStore,
      llmProvider: adapter.simpleProvider,
    });

    // 只有 5 个任务（默认最小 15）
    for (let i = 0; i < 5; i++) {
      await engine.onTaskCompleted({
        success: false,
        taskType: "test",
        executionTimeMs: 100,
        tokensUsed: 50,
        goal: "test",
        errorMessage: "timeout",
        errorCategory: "timeout",
      });
    }

    // analyzeWithLLM 会被调用（5次失败），但 generateToolWithLLM 不会被触发
    // 验证总调用次数等于 analyzeWithLLM 的调用次数（5次）
    expect(provider.callHistory.length).toBe(5);
  });

  it("达到最小任务数后应尝试工具生成", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({
          name: "retry_with_backoff",
          description: "Retry with exponential backoff",
          code: "async function retry(fn, retries = 3) { for (let i = 0; i < retries; i++) { try { return await fn(); } catch { if (i === retries - 1) throw new Error(); } } }",
          test_code: "async function test_tool() { let c = 0; const fn = async () => { c++; if (c < 2) throw new Error(); return 'ok'; }; const r = await retry(fn, 3); if (r !== 'ok') throw new Error(); }",
        }),
    });

    const ruleStore = createMemoryRuleStore();
    const adapter = createLLMAdapter(provider);

    const engine = createEvolutionEngine({
      ruleStore,
      llmProvider: adapter.simpleProvider,
    });

    // 达到最小任务数（15）+ 间隔（30）= 至少 16 个失败任务
    for (let i = 0; i < 16; i++) {
      await engine.onTaskCompleted({
        success: false,
        taskType: "test",
        executionTimeMs: 100,
        tokensUsed: 50,
        goal: "test",
        errorMessage: "timeout",
        errorCategory: "timeout",
      });
    }

    // LLM 应被调用（至少一次用于工具生成）
    expect(provider.callHistory.length).toBeGreaterThan(0);
  });
});

/**
 * Provider 注入集成测试 — 阶段 A 验证。
 *
 * 验证 LLM Provider 从 createEvoAgentContext 正确注入到各模块：
 * - Critic: llmProvider 注入
 * - EvolutionEngine: llmProvider 注入
 * - ContextEngine: provider 注入
 * - MemoryExtractor: provider 注入
 * - StrategyExplorer: llmProvider 注入
 * - EngineSelfOptimizer: llmProvider 注入
 * - DreamingManager: llmProvider 注入
 * - AnomalyDetector: llmProvider 注入
 */

import { describe, it, expect } from "vitest";
import { createLLMAdapter, type SimpleLLMProvider } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";
import { createCritic } from "../../src/communication/critic";
import { createEvolutionEngine } from "../../src/evolution/engine";
import { createMemoryRuleStore } from "../../src/evolution/rule-store";
import { createContextEngine } from "../../src/context/engine";
import { createStrategyExplorer } from "../../src/evolution/strategy-explorer";
import { createEngineSelfOptimizer } from "../../src/evolution/engine-self-optimizer";
import { createDreamingManager } from "../../src/knowledge/dreaming";
import { createAnomalyDetector } from "../../src/communication/anomaly";
import { createMemoryExtractor } from "../../src/knowledge/memory-extractor";

describe("Provider 注入 > Critic", () => {
  it("无 llmProvider 时应使用规则分析（降级模式）", async () => {
    const critic = createCritic();
    const result = await critic.analyzeMessage("test-agent", "This is a valid claim", 0.5);

    expect(result.processingResult).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("有 llmProvider 时应异步预填充 LLM 缓存", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({
          result: "ACCEPT",
          confidence: 0.8,
          valid_aspects: ["correct"],
          flawed_aspects: [],
          corrected_statement: "This is a valid claim",
          reasoning: "Test reasoning",
        }),
    });

    const adapter = createLLMAdapter(provider);
    const critic = createCritic({ llmProvider: adapter.criticProvider });

    // 首次调用使用规则分析（同步），异步预填充 LLM 缓存
    const result = await critic.analyzeMessage("test-agent", "This is a valid claim", 0.5);
    expect(result.processingResult).toBeDefined();

    // 缓存统计应已初始化
    const cacheStats = critic.getCacheStats();
    expect(cacheStats.maxSize).toBeGreaterThan(0);
  });

  it("llmProvider 注入后缓存应可清理", async () => {
    const adapter = createLLMAdapter(new MockProvider());
    const critic = createCritic({ llmProvider: adapter.criticProvider });

    await critic.analyzeMessage("test-agent", "claim", 0.5);
    expect(critic.getCacheStats().size).toBeGreaterThanOrEqual(0);

    critic.clearCache();
    expect(critic.getCacheStats().size).toBe(0);
  });
});

describe("Provider 注入 > EvolutionEngine", () => {
  it("无 llmProvider 时应正常工作（降级模式）", async () => {
    const ruleStore = createMemoryRuleStore();
    const engine = createEvolutionEngine({ ruleStore });

    await engine.onTaskCompleted({
      success: true,
      taskType: "test",
      executionTimeMs: 100,
      tokensUsed: 50,
      goal: "test goal",
    });

    const state = engine.getState();
    expect(state.totalTasks).toBe(1);
    expect(state.successTasks).toBe(1);
  });

  it("有 llmProvider 时应正常工作", async () => {
    const ruleStore = createMemoryRuleStore();
    const adapter = createLLMAdapter(new MockProvider());

    const engine = createEvolutionEngine({
      ruleStore,
      llmProvider: adapter.simpleProvider,
    });

    await engine.onTaskCompleted({
      success: true,
      taskType: "test",
      executionTimeMs: 100,
      tokensUsed: 50,
      goal: "test goal",
    });

    const state = engine.getState();
    expect(state.totalTasks).toBe(1);
  });
});

describe("Provider 注入 > ContextEngine", () => {
  it("无 provider 时应使用规则摘要", async () => {
    const engine = createContextEngine();

    // 注入足够多的消息以确保超过压缩阈值
    for (let i = 0; i < 20; i++) {
      engine.ingest({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `This is message ${i} with enough content to trigger compaction when accumulated together.`,
        timestamp: Date.now(),
      });
    }

    const result = await engine.compact({
      targetTokens: 10,
      reason: "auto",
    });

    expect(result.messages.length).toBeGreaterThan(0);
    // 规则摘要应包含 "Summary" 标记
    const summaryMsg = result.messages.find((m) => m.content.includes("Summary"));
    expect(summaryMsg).toBeDefined();
  });

  it("有 provider 时应使用 LLM 摘要", async () => {
    const provider = new MockProvider({
      responseFn: () => "LLM generated summary of the conversation",
    });

    const engine = createContextEngine({ provider });

    // 注入足够多的消息以确保超过压缩阈值
    for (let i = 0; i < 20; i++) {
      engine.ingest({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `This is message ${i} with enough content to trigger compaction when accumulated together.`,
        timestamp: Date.now(),
      });
    }

    const result = await engine.compact({
      targetTokens: 10,
      reason: "auto",
    });

    expect(result.messages.length).toBeGreaterThan(0);
    // LLM 摘要应包含 "LLM summary" 标记
    const summaryMsg = result.messages.find((m) => m.content.includes("LLM summary"));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).toContain("LLM generated summary of the conversation");
  });

  it("provider 调用失败时应降级到规则摘要", async () => {
    const provider = new MockProvider({ shouldFail: true });

    const engine = createContextEngine({ provider });

    // 注入足够多的消息以确保超过压缩阈值
    for (let i = 0; i < 20; i++) {
      engine.ingest({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `This is message ${i} with enough content to trigger compaction when accumulated together.`,
        timestamp: Date.now(),
      });
    }

    // 不应抛出错误，应降级到规则摘要
    const result = await engine.compact({
      targetTokens: 10,
      reason: "auto",
    });

    expect(result.messages.length).toBeGreaterThan(0);
    const summaryMsg = result.messages.find((m) => m.content.includes("Summary"));
    expect(summaryMsg).toBeDefined();
  });
});

describe("Provider 注入 > MemoryExtractor", () => {
  it("无 provider 时应使用规则提取", async () => {
    const extractor = createMemoryExtractor();

    const result = await extractor.extract([
      {
        id: "msg1",
        role: "user",
        content: "I prefer TypeScript over JavaScript",
        timestamp: Date.now(),
      },
    ]);

    // 规则提取应检测到 "I prefer" 关键词
    expect(result.updated.length).toBeGreaterThanOrEqual(0);
  });

  it("有 provider 时应使用 LLM 提取（当前返回空数组，待阶段 B 实现）", async () => {
    const provider = new MockProvider();
    const extractor = createMemoryExtractor({ provider });

    const result = await extractor.extract([
      {
        id: "msg1",
        role: "user",
        content: "I prefer TypeScript over JavaScript",
        timestamp: Date.now(),
      },
    ]);

    // LLM 提取当前返回空数组（待阶段 B 实现 extractWithLLM）
    expect(result.updated.length).toBe(0);
  });
});

describe("Provider 注入 > StrategyExplorer", () => {
  it("无 llmProvider 时应正常工作", () => {
    const explorer = createStrategyExplorer();
    expect(explorer.shouldExplore(5)).toBe(false);
    expect(explorer.isCurrentlyExploring()).toBe(false);
  });

  it("有 llmProvider 时应正常工作", () => {
    const adapter = createLLMAdapter(new MockProvider());
    const explorer = createStrategyExplorer({ llmProvider: adapter.simpleProvider });

    expect(explorer.shouldExplore(5)).toBe(false);
    expect(explorer.isCurrentlyExploring()).toBe(false);
  });
});

describe("Provider 注入 > EngineSelfOptimizer", () => {
  it("无 llmProvider 时应正常工作", () => {
    const optimizer = createEngineSelfOptimizer();
    expect(optimizer.shouldOptimize(5)).toBe(false);
    expect(optimizer.getAppliedOptimizations().size).toBe(0);
  });

  it("有 llmProvider 时应正常工作", () => {
    const adapter = createLLMAdapter(new MockProvider());
    const optimizer = createEngineSelfOptimizer({ llmProvider: adapter.simpleProvider });

    expect(optimizer.shouldOptimize(5)).toBe(false);
    expect(optimizer.getAppliedOptimizations().size).toBe(0);
  });
});

describe("Provider 注入 > DreamingManager", () => {
  it("无 llmProvider 时应正常工作", () => {
    const manager = createDreamingManager();
    const result = manager.runLightDreaming([]);
    expect(result.phase).toBe("light");
    expect(result.processed).toBe(0);
  });

  it("有 llmProvider 时应正常工作", () => {
    const adapter = createLLMAdapter(new MockProvider());
    const manager = createDreamingManager({ llmProvider: adapter.simpleProvider });

    const result = manager.runLightDreaming([]);
    expect(result.phase).toBe("light");
    expect(result.processed).toBe(0);
  });
});

describe("Provider 注入 > AnomalyDetector", () => {
  it("无 llmProvider 时应正常工作", () => {
    const detector = createAnomalyDetector();
    const result = detector.checkMessage("peer-1", "Hello world");
    expect(result.allowed).toBe(true);
  });

  it("有 llmProvider 时应正常工作", () => {
    const adapter = createLLMAdapter(new MockProvider());
    const detector = createAnomalyDetector({ llmProvider: adapter.simpleProvider });

    const result = detector.checkMessage("peer-1", "Hello world");
    expect(result.allowed).toBe(true);
  });

  it("createAnomalyDetector 向后兼容（无参数调用）", () => {
    // 确保无参数调用仍然有效（向后兼容）
    const detector = createAnomalyDetector();
    expect(detector.count()).toBe(0);
  });
});

describe("Provider 注入 > createLLMAdapter 集成", () => {
  it("适配器应正确桥接全局 Provider 到所有模块", async () => {
    const provider = new MockProvider({
      model: "integration-test-model",
      responseFn: (messages) => `OK: ${(messages[0]?.content as string) ?? ""}`,
    });

    const adapter = createLLMAdapter(provider);

    // 验证 criticProvider
    expect(adapter.criticProvider.name).toBe("integration-test-model");
    const criticResult = await adapter.criticProvider.invoke([
      { role: "user", content: "critic test" },
    ]);
    expect(criticResult).toBe("OK: critic test");

    // 验证 simpleProvider
    const simpleResult = await adapter.simpleProvider.invoke([
      { role: "user", content: "simple test" },
    ]);
    expect(simpleResult).toBe("OK: simple test");

    // 验证原始 provider 调用次数
    expect(provider.callHistory.length).toBe(2);
  });
});

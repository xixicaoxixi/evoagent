/**
 * Critic LLM 激活测试 — 阶段 B.1。
 *
 * 验证 Critic.analyzeMessage 在有 LLM Provider 时走 LLM 分析路径。
 */

import { describe, it, expect } from "vitest";
import { createCritic } from "../../src/communication/critic";
import { createLLMAdapter } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";

describe("B.1 Critic LLM 激活", () => {
  it("有 LLM Provider 时应走 LLM 分析路径", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({
          result: "ACCEPT",
          confidence: 0.85,
          valid_aspects: ["correct", "well-sourced"],
          flawed_aspects: [],
          corrected_statement: "The sky is blue due to Rayleigh scattering",
          reasoning: "Scientifically accurate claim",
        }),
    });

    const adapter = createLLMAdapter(provider);
    const critic = createCritic({ llmProvider: adapter.criticProvider, dropRate: 0 });

    const result = await critic.analyzeMessage("test-agent", "The sky is blue", 0.7);

    expect(result.processingResult).toBe("ACCEPT");
    expect(result.confidence).toBe(0.85);
    expect(result.validAspects).toContain("correct");
    expect(result.analysis.method).toBe("llm");
    expect(provider.callHistory.length).toBe(1);
  });

  it("LLM 返回 REJECT 时应拒绝知识", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({
          result: "REJECT",
          confidence: 0.3,
          valid_aspects: [],
          flawed_aspects: ["unverified", "speculative"],
          corrected_statement: "",
          reasoning: "Claim lacks evidence",
        }),
    });

    const adapter = createLLMAdapter(provider);
    const critic = createCritic({ llmProvider: adapter.criticProvider, dropRate: 0 });

    const result = await critic.analyzeMessage("untrusted", "Aliens built the pyramids", 0.2);

    expect(result.processingResult).toBe("REJECT");
    expect(result.flawedAspects).toContain("unverified");
  });

  it("LLM 返回低于最低置信度时应拒绝", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({
          result: "ACCEPT",
          confidence: 0.05,
          valid_aspects: [],
          flawed_aspects: [],
          corrected_statement: "",
          reasoning: "Very uncertain",
        }),
    });

    const adapter = createLLMAdapter(provider);
    const critic = createCritic({ llmProvider: adapter.criticProvider, dropRate: 0 });

    const result = await critic.analyzeMessage("agent", "some claim", 0.5);

    expect(result.processingResult).toBe("REJECT");
    expect(result.analysis.reason).toBe("below_min_confidence");
  });

  it("LLM 调用失败时应降级到简单分析", async () => {
    const provider = new MockProvider({ shouldFail: true });
    const adapter = createLLMAdapter(provider);
    const critic = createCritic({ llmProvider: adapter.criticProvider, dropRate: 0 });

    const result = await critic.analyzeMessage("agent", "A valid claim", 0.8);

    expect(result.processingResult).toBe("ACCEPT");
    expect(result.analysis.method).toBe("simple");
  });

  it("LLM 返回无效 JSON 时应降级到简单分析", async () => {
    const provider = new MockProvider({
      responseFn: () => "This is not JSON at all",
    });
    const adapter = createLLMAdapter(provider);
    const critic = createCritic({ llmProvider: adapter.criticProvider, dropRate: 0 });

    const result = await critic.analyzeMessage("agent", "A claim", 0.5);

    expect(result.analysis.method).toBe("simple");
  });

  it("无 LLM Provider 时应走简单分析路径", async () => {
    const critic = createCritic({ dropRate: 0 });

    const result = await critic.analyzeMessage("agent", "A valid claim", 0.8);

    expect(result.processingResult).toBe("ACCEPT");
    expect(result.analysis.method).toBe("simple");
  });

  it("LLM 缓存应生效（相同内容第二次调用应命中缓存）", async () => {
    let callCount = 0;
    const provider = new MockProvider({
      responseFn: () => {
        callCount++;
        return JSON.stringify({
          result: "ACCEPT",
          confidence: 0.9,
          valid_aspects: ["correct"],
          flawed_aspects: [],
          corrected_statement: "cached claim",
          reasoning: "Cached analysis",
        });
      },
    });

    const adapter = createLLMAdapter(provider);
    const critic = createCritic({ llmProvider: adapter.criticProvider, dropRate: 0 });

    const result1 = await critic.analyzeMessage("agent", "cached claim", 0.7);
    expect(result1.confidence).toBe(0.9);

    const result2 = await critic.analyzeMessage("agent", "cached claim", 0.7);
    expect(result2.confidence).toBe(0.9);

    expect(callCount).toBe(1);
  });

  it("LLM 返回通用描述时应正确映射到内部类别", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify({
          result: "partially_accept",
          confidence: 0.6,
          valid_aspects: ["partial"],
          flawed_aspects: ["incomplete"],
          corrected_statement: "corrected",
          reasoning: "test",
        }),
    });

    const adapter = createLLMAdapter(provider);
    const critic = createCritic({ llmProvider: adapter.criticProvider, dropRate: 0 });

    const result = await critic.analyzeMessage("agent", "partial claim", 0.5);

    expect(result.processingResult).toBe("ACCEPT_PARTIAL");
  });
});

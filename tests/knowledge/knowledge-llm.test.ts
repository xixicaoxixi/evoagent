/**
 * KnowledgeManager / DreamingManager / ForgettingManager LLM 增强测试。
 *
 * 验证三个知识管理模块在有/无 LLM Provider 时的行为：
 * - KnowledgeManager: 语义检索增强
 * - DreamingManager: 语义去重 + 跨记忆模式识别
 * - ForgettingManager: 长期价值评估
 */

import { describe, it, expect } from "vitest";
import { createKnowledgeManager } from "../../src/knowledge/knowledge-manager";
import { createDreamingManager } from "../../src/knowledge/dreaming";
import { createForgettingManager } from "../../src/knowledge/forgetting";
import { createLLMAdapter } from "../../src/llm/adapter";
import { MockProvider } from "../../src/llm/mock";
import type { MemoryEntry } from "../../src/knowledge/memory-types";

// ─── 测试用记忆条目工厂 ───

function createMemory(overrides: Partial<MemoryEntry> & { readonly id: string }): MemoryEntry {
  const now = Date.now();
  return {
    type: "fact",
    title: "Test memory",
    content: "Test content",
    tags: [],
    createdAt: now,
    updatedAt: now,
    mtimeMs: now,
    source: "test",
    confidence: 0.8,
    ...overrides,
  };
}

// ─── KnowledgeManager 测试 ───

describe("KnowledgeManager LLM 语义检索", () => {
  it("有 provider 时 search 应触发 LLM 语义缓存预填充", async () => {
    const provider = new MockProvider({
      responseFn: () => JSON.stringify(["semantic", "concepts", "keywords"]),
    });
    const adapter = createLLMAdapter(provider);
    const km = createKnowledgeManager({ llmProvider: adapter.simpleProvider });

    km.store(createMemory({
      id: "m1",
      title: "TypeScript best practices",
      content: "Use strict mode and proper type annotations",
    }));

    // 第一次搜索应触发 LLM 调用
    const results = km.search("TypeScript strict mode");
    expect(results.length).toBeGreaterThanOrEqual(0);

    // 等待异步 LLM 调用完成
    await provider.waitForCallCount(1);
    expect(provider.callHistory.length).toBe(1);
  });

  it("相同查询第二次搜索应命中语义缓存", async () => {
    const provider = new MockProvider({
      responseFn: () => JSON.stringify(["cached", "keywords"]),
    });
    const adapter = createLLMAdapter(provider);
    const km = createKnowledgeManager({ llmProvider: adapter.simpleProvider });

    km.store(createMemory({
      id: "m1",
      title: "Bun runtime",
      content: "Bun is a fast JavaScript runtime",
    }));

    // 第一次搜索
    km.search("Bun runtime");
    await provider.waitForCallCount(1);

    // 第二次搜索（相同查询，应命中缓存）
    km.search("Bun runtime");
    // 缓存命中，无需额外 LLM 调用，callCount 仍为 1

    // LLM 只应被调用一次
    expect(provider.callHistory.length).toBe(1);
  });

  it("无 provider 时 search 应正常工作（纯关键词匹配）", () => {
    const km = createKnowledgeManager();

    km.store(createMemory({
      id: "m1",
      title: "TypeScript strict mode",
      content: "Always enable strict mode in TypeScript",
    }));

    const results = km.search("TypeScript strict");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.entry.id).toBe("m1");
  });

  it("LLM 调用失败时 search 应正常降级", async () => {
    const provider = new MockProvider({ shouldFail: true });
    const adapter = createLLMAdapter(provider);
    const km = createKnowledgeManager({ llmProvider: adapter.simpleProvider });

    km.store(createMemory({
      id: "m1",
      title: "Error handling",
      content: "Always handle errors properly",
    }));

    const results = km.search("error handling");
    // 即使 LLM 失败，关键词匹配仍应工作
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── DreamingManager 测试 ───

describe("DreamingManager LLM 语义去重", () => {
  const memories: MemoryEntry[] = [
    createMemory({
      id: "d1",
      type: "fact",
      title: "TypeScript preferences",
      content: "User prefers TypeScript for all projects",
      tags: ["typescript", "preference"],
    }),
    createMemory({
      id: "d2",
      type: "fact",
      title: "JS vs TS choice",
      content: "Always choose TypeScript over JavaScript",
      tags: ["typescript", "preference"],
    }),
    createMemory({
      id: "d3",
      type: "skill",
      title: "Debugging techniques",
      content: "Use console.log for quick debugging",
      tags: ["debugging"],
    }),
  ];

  it("有 provider 时 runLightDreaming 应触发 LLM 语义去重", async () => {
    const provider = new MockProvider({
      responseFn: () => JSON.stringify([
        { duplicate: "JS vs TS choice", canonical: "TypeScript preferences" },
      ]),
    });
    const adapter = createLLMAdapter(provider);
    const dm = createDreamingManager({ llmProvider: adapter.simpleProvider });

    const result = dm.runLightDreaming(memories);

    expect(result.phase).toBe("light");
    expect(result.processed).toBe(3);

    // C12/C15: 原始 result 不可变，llm_insights 通过 llmReady 获取
    expect(result.llm_insights).toBeUndefined();
    expect(result.llmReady).toBeDefined();

    const finalResult = await result.llmReady!;
    expect(finalResult.llm_insights).toBeDefined();
    expect(finalResult.llm_insights!.length).toBe(1);
  });

  it("有 provider 时 runREMDreaming 应触发 LLM 模式识别", async () => {
    const provider = new MockProvider({
      responseFn: () => JSON.stringify([
        "Strong preference for type-safe languages across all memories",
        "Debugging skills are underrepresented",
      ]),
    });
    const adapter = createLLMAdapter(provider);
    const dm = createDreamingManager({
      llmProvider: adapter.simpleProvider,
      rem: { enabled: true },
    });

    const result = dm.runREMDreaming(memories);

    expect(result.phase).toBe("rem");

    // C12/C15: 原始 result 不可变，llm_insights 通过 llmReady 获取
    expect(result.llm_insights).toBeUndefined();
    expect(result.llmReady).toBeDefined();

    const finalResult = await result.llmReady!;
    expect(finalResult.llm_insights).toBeDefined();
    expect(finalResult.llm_insights!.length).toBe(2);
  });

  it("无 provider 时 runLightDreaming 应正常工作（规则去重）", () => {
    const dm = createDreamingManager();

    const result = dm.runLightDreaming(memories);

    expect(result.phase).toBe("light");
    expect(result.processed).toBe(3);
    expect(result.llm_insights).toBeUndefined();
  });

  it("无 provider 时 runREMDreaming 应正常工作（规则模式识别）", () => {
    const dm = createDreamingManager({ rem: { enabled: true } });

    const result = dm.runREMDreaming(memories);

    expect(result.phase).toBe("rem");
    expect(result.llm_insights).toBeUndefined();
    // 规则模式识别应发现重复标签
    expect(result.patterns.length).toBeGreaterThanOrEqual(1);
  });

  it("LLM 调用失败时 dreaming 应正常降级", async () => {
    const provider = new MockProvider({ shouldFail: true });
    const adapter = createLLMAdapter(provider);
    const dm = createDreamingManager({ llmProvider: adapter.simpleProvider });

    const result = dm.runLightDreaming(memories);

    expect(result.phase).toBe("light");
    expect(result.processed).toBe(3);

    // C12/C15: 原始 result 不可变
    expect(result.llm_insights).toBeUndefined();

    if (result.llmReady) {
      const finalResult = await result.llmReady;
      expect(finalResult.llm_insights).toBeUndefined();
    }
  });
});

// ─── ForgettingManager 测试 ───

describe("ForgettingManager LLM 长期价值评估", () => {
  it("有 provider 时低价值记忆应被淘汰", () => {
    const provider = new MockProvider({
      responseFn: () => "0.3",
    });
    const adapter = createLLMAdapter(provider);
    const fm = createForgettingManager({
      llmProvider: adapter.simpleProvider,
      minConfidence: 0.5,
    });

    const memories = [
      createMemory({
        id: "f1",
        title: "Low confidence fact",
        content: "Something uncertain",
        confidence: 0.1,
      }),
      createMemory({
        id: "f2",
        title: "High confidence fact",
        content: "Something certain",
        confidence: 0.9,
      }),
    ];

    const result = fm.forget(memories);

    // 低置信度记忆应被淘汰
    expect(result.forgotten.length).toBe(1);
    expect(result.forgotten[0]!.id).toBe("f1");
    expect(result.retained.length).toBe(1);
    expect(result.retained[0]!.id).toBe("f2");
  });

  it("有 provider 时高价值记忆应被保留（LLM 评分 >= 0.7）", async () => {
    const provider = new MockProvider({
      responseFn: () => "0.9",
    });
    const adapter = createLLMAdapter(provider);
    const fm = createForgettingManager({
      llmProvider: adapter.simpleProvider,
      minConfidence: 0.5,
    });

    const memories = [
      createMemory({
        id: "f1",
        title: "Unique insight",
        content: "A rare and valuable insight about the codebase",
        confidence: 0.1,
      }),
    ];

    const result = fm.forget(memories);

    // 初始淘汰（低置信度）
    expect(result.forgotten.length).toBe(1);

    // 等待 LLM 异步评估完成
    await provider.waitForCallCount(1);

    // E4: LLM 只做标注，不直接修改 forgotten/retained
    expect(result.forgotten.length).toBe(1);
    expect(result.llmValueHints.get("f1")).toBe(0.9);
  });

  it("无 provider 时 forget 应正常工作（纯规则淘汰）", () => {
    const fm = createForgettingManager({ minConfidence: 0.5 });

    const memories = [
      createMemory({
        id: "f1",
        title: "Low value",
        content: "Low confidence content",
        confidence: 0.1,
      }),
      createMemory({
        id: "f2",
        title: "High value",
        content: "High confidence content",
        confidence: 0.9,
      }),
    ];

    const result = fm.forget(memories);

    expect(result.forgotten.length).toBe(1);
    expect(result.forgotten[0]!.id).toBe("f1");
    expect(result.retained.length).toBe(1);
  });

  it("LLM 调用失败时 forget 应保持原始淘汰决策", async () => {
    const provider = new MockProvider({ shouldFail: true });
    const adapter = createLLMAdapter(provider);
    const fm = createForgettingManager({
      llmProvider: adapter.simpleProvider,
      minConfidence: 0.5,
    });

    const memories = [
      createMemory({
        id: "f1",
        title: "Low confidence",
        content: "Uncertain content",
        confidence: 0.1,
      }),
    ];

    const result = fm.forget(memories);

    // 等待异步调用完成（shouldFail provider 无法使用 waitForCallCount）
    await new Promise((resolve) => setTimeout(resolve, 30));

    // LLM 失败，保持原始淘汰决策
    expect(result.forgotten.length).toBe(1);
    expect(result.retained.length).toBe(0);
  });

  it("淘汰原因应正确记录", () => {
    const fm = createForgettingManager({ minConfidence: 0.5 });

    const memories = [
      createMemory({
        id: "f1",
        title: "Low",
        content: "Low",
        confidence: 0.1,
      }),
    ];

    const result = fm.forget(memories);

    expect(result.reasons.get("f1")).toContain("low_confidence");
  });
});

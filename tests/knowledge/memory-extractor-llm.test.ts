/**
 * MemoryExtractor LLM 实现测试 — 阶段 B.3。
 *
 * 验证 extractWithLLM 完整实现：调用 Provider → 解析 JSON → 创建 MemoryEntry。
 */

import { describe, it, expect } from "vitest";
import { createMemoryExtractor } from "../../src/knowledge/memory-extractor";
import { MockProvider } from "../../src/llm/mock";

describe("B.3 MemoryExtractor LLM 实现", () => {
  it("有 Provider 时应调用 LLM 提取记忆", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify([
          {
            type: "preference",
            title: "TypeScript preference",
            content: "User prefers TypeScript over JavaScript",
            confidence: 0.9,
          },
          {
            type: "fact",
            title: "Project uses Bun",
            content: "The project uses Bun as runtime",
            confidence: 0.8,
          },
        ]),
    });

    const extractor = createMemoryExtractor({ provider });

    const result = await extractor.extract([
      {
        id: "msg1",
        role: "user",
        content: "I prefer TypeScript over JavaScript. The project uses Bun.",
        timestamp: Date.now(),
      },
    ]);

    expect(result.updated.length).toBe(2);
    expect(provider.callHistory.length).toBe(1);

    // 验证提取的记忆
    const memories = result.memories;
    const preference = memories.find((m) => m.type === "preference");
    expect(preference).toBeDefined();
    expect(preference!.source).toBe("conversation_llm");
    expect(preference!.confidence).toBe(0.9);

    const fact = memories.find((m) => m.type === "fact");
    expect(fact).toBeDefined();
    expect(fact!.confidence).toBe(0.8);
  });

  it("LLM 返回无效 JSON 时应返回空数组", async () => {
    const provider = new MockProvider({
      responseFn: () => "This is not JSON",
    });

    const extractor = createMemoryExtractor({ provider });

    const result = await extractor.extract([
      {
        id: "msg1",
        role: "user",
        content: "Some content",
        timestamp: Date.now(),
      },
    ]);

    expect(result.updated.length).toBe(0);
  });

  it("LLM 调用失败时应返回空数组（不抛出错误）", async () => {
    const provider = new MockProvider({ shouldFail: true });
    const extractor = createMemoryExtractor({ provider });

    const result = await extractor.extract([
      {
        id: "msg1",
        role: "user",
        content: "Some content",
        timestamp: Date.now(),
      },
    ]);

    expect(result.updated.length).toBe(0);
  });

  it("LLM 返回缺少必要字段时应过滤无效条目", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify([
          { type: "preference", title: "Valid", content: "Valid content" },
          { type: "preference" }, // 缺少 title 和 content
          { title: "No type", content: "No type content" }, // 缺少 type
          "not an object", // 非对象
        ]),
    });

    const extractor = createMemoryExtractor({ provider });

    const result = await extractor.extract([
      {
        id: "msg1",
        role: "user",
        content: "Test content",
        timestamp: Date.now(),
      },
    ]);

    // 只有第一个条目有效
    expect(result.updated.length).toBe(1);
  });

  it("无 Provider 时应走规则提取路径", async () => {
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
    expect(result.updated.length).toBeGreaterThanOrEqual(1);
    const memories = result.memories;
    const preference = memories.find((m) => m.type === "preference");
    expect(preference).toBeDefined();
    expect(preference!.source).toBe("conversation");
  });

  it("去重：相同类型+标题的记忆应更新而非重复", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify([
          {
            type: "preference",
            title: "TypeScript preference",
            content: "User prefers TypeScript",
            confidence: 0.9,
          },
        ]),
    });

    const extractor = createMemoryExtractor({ provider });

    // 第一次提取
    const result1 = await extractor.extract([
      {
        id: "msg1",
        role: "user",
        content: "I prefer TypeScript",
        timestamp: Date.now(),
      },
    ]);
    expect(result1.updated.length).toBe(1);

    // 第二次提取（相同类型+标题）
    const result2 = await extractor.extract([
      {
        id: "msg2",
        role: "user",
        content: "I prefer TypeScript",
        timestamp: Date.now(),
      },
    ]);
    expect(result2.updated.length).toBe(1);

    // 总记忆数应为 1（去重）
    expect(result2.memories.length).toBe(1);
  });

  it("置信度应在 0-1 范围内", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify([
          { type: "fact", title: "Test", content: "Test", confidence: 1.5 }, // 超出范围
          { type: "fact", title: "Test2", content: "Test2", confidence: -0.5 }, // 超出范围
        ]),
    });

    const extractor = createMemoryExtractor({ provider });

    const result = await extractor.extract([
      {
        id: "msg1",
        role: "user",
        content: "Test",
        timestamp: Date.now(),
      },
    ]);

    for (const memory of result.memories) {
      expect(memory.confidence).toBeGreaterThanOrEqual(0);
      expect(memory.confidence).toBeLessThanOrEqual(1);
    }
  });
});

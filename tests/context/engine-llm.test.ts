/**
 * ContextEngine LLM 摘要测试 — 阶段 B.4。
 *
 * 验证 ContextEngine 的 generateSummary 和 auditQuality 在有 Provider 时走 LLM 路径。
 */

import { describe, it, expect } from "vitest";
import { createContextEngine } from "../../src/context/engine";
import { MockProvider } from "../../src/llm/mock";

describe("B.4 ContextEngine LLM 摘要", () => {
  it("有 Provider 时 generateSummary 应使用 LLM 生成摘要", async () => {
    const provider = new MockProvider({
      responseFn: () => "LLM: The user asked about TypeScript preferences and the project setup.",
    });

    const engine = createContextEngine({ provider });

    // 注入足够多的消息以触发压缩
    for (let i = 0; i < 20; i++) {
      engine.ingest({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"word ".repeat(50)}`,
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
    expect(summaryMsg!.content).toContain("LLM: The user asked about TypeScript");
  });

  it("有 Provider 时 auditQuality 应使用 LLM 评估", async () => {
    const provider = new MockProvider({
      responseFn: () => "0.85",
    });

    const engine = createContextEngine({ provider });

    for (let i = 0; i < 20; i++) {
      engine.ingest({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"word ".repeat(50)}`,
        timestamp: Date.now(),
      });
    }

    const result = await engine.compact({
      targetTokens: 10,
      reason: "auto",
    });

    // LLM 评估应返回 0.85
    expect(result.qualityScore).toBe(0.85);
  });

  it("LLM 评估返回无效数字时应降级到规则评估", async () => {
    const provider = new MockProvider({
      // 第一次调用是 generateSummary，第二次是 auditQuality
      responseFn: (messages) => {
        if (messages[0]?.role === "system" && messages[0]?.content?.includes("Rate the quality")) {
          return "not a number";
        }
        return "Summary text";
      },
    });

    const engine = createContextEngine({ provider });

    for (let i = 0; i < 20; i++) {
      engine.ingest({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"word ".repeat(50)}`,
        timestamp: Date.now(),
      });
    }

    const result = await engine.compact({
      targetTokens: 10,
      reason: "auto",
    });

    // 降级到规则评估，基础分 0.5
    expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    expect(result.qualityScore).toBeLessThanOrEqual(1);
  });

  it("Provider 调用失败时 auditQuality 应降级到规则评估", async () => {
    let callCount = 0;
    const provider = new MockProvider({
      responseFn: () => {
        callCount++;
        if (callCount > 1) {
          throw new Error("LLM failed");
        }
        return "Summary text";
      },
    });

    const engine = createContextEngine({ provider });

    for (let i = 0; i < 20; i++) {
      engine.ingest({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"word ".repeat(50)}`,
        timestamp: Date.now(),
      });
    }

    const result = await engine.compact({
      targetTokens: 10,
      reason: "auto",
    });

    // 不应抛出错误
    expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    expect(result.qualityScore).toBeLessThanOrEqual(1);
  });

  it("无 Provider 时应使用规则评估", async () => {
    const engine = createContextEngine();

    for (let i = 0; i < 20; i++) {
      engine.ingest({
        id: `msg-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"word ".repeat(50)}`,
        timestamp: Date.now(),
      });
    }

    const result = await engine.compact({
      targetTokens: 10,
      reason: "auto",
    });

    // 规则评估：基础分 0.5
    expect(result.qualityScore).toBeGreaterThanOrEqual(0.5);
  });
});

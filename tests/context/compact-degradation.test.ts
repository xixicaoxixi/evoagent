/**
 * Session E.4 测试 — Cached MicroCompact + 压缩降级。
 *
 * 覆盖：
 * - 正常压缩（无 provider → 规则摘要）
 * - 降级链：LLM 失败 → 规则摘要
 * - 熔断：连续 3 次失败后硬截断
 * - 质量审计：低质量记录 warn
 * - 硬截断质量分低
 */

import { describe, expect, it } from "vitest";
import { DefaultContextEngine } from "../../src/context/engine";
import type { Message } from "../../src/types/message";
import type { LLMProvider } from "../../src/interfaces/llm-provider";

// ─── 辅助函数 ───

function createMessage(role: Message["role"], content: string): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    timestamp: Date.now(),
  };
}

function generateContent(chars: number): string {
  return "x".repeat(chars);
}

function createAlwaysFailProvider(): LLMProvider {
  return {
    providerType: "mock",
    model: "fail-model",
    temperature: 0.1,
    maxTokens: 2048,
    countTokens: () => 100,
    healthCheck: async () => true,
    async invoke() {
      throw new Error("LLM invoke failed");
    },
    async *stream() {
      yield { type: "content", content: "test" };
      yield { type: "stop", stopReason: "end_turn", tokenUsage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
}

function createSuccessProvider(): LLMProvider {
  return {
    providerType: "mock",
    model: "success-model",
    temperature: 0.1,
    maxTokens: 2048,
    countTokens: () => 100,
    healthCheck: async () => true,
    async invoke() {
      return {
        content: "This is a summary of the conversation.",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
      };
    },
    async *stream() {
      yield { type: "content", content: "test" };
      yield { type: "stop", stopReason: "end_turn", tokenUsage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
}

// ═══════════════════════════════════════════
// 正常压缩（无 provider → 规则摘要）
// ═══════════════════════════════════════════

describe("E.4: 正常压缩", () => {
  it("无 provider 应使用规则摘要", async () => {
    const engine = new DefaultContextEngine({ maxTokens: 200_000 });

    // 注入大量消息
    for (let i = 0; i < 10; i++) {
      engine.ingest(createMessage("user", `User message ${i} ${generateContent(2000)}`));
      engine.ingest(createMessage("assistant", `Assistant message ${i} ${generateContent(2000)}`));
    }

    const result = await engine.compact({ targetTokens: 1000, reason: "auto" });
    expect(result.messages.length).toBeLessThan(20);
    expect(result.compressionRatio).toBeLessThan(1);
    expect(result.qualityScore).toBeGreaterThan(0);
  });

  it("低于目标 token 数时不应压缩", async () => {
    const engine = new DefaultContextEngine({ maxTokens: 200_000 });
    engine.ingest(createMessage("user", "hello"));
    engine.ingest(createMessage("assistant", "hi"));

    const result = await engine.compact({ targetTokens: 100000, reason: "auto" });
    expect(result.messages).toHaveLength(2);
    expect(result.compressionRatio).toBe(1.0);
    expect(result.qualityScore).toBe(1.0);
  });
});

// ═══════════════════════════════════════════
// 降级链
// ═══════════════════════════════════════════

describe("E.4: 降级链", () => {
  it("LLM 失败应降级到规则摘要", async () => {
    const engine = new DefaultContextEngine({
      provider: createAlwaysFailProvider(),
      maxTokens: 200_000,
    });

    for (let i = 0; i < 10; i++) {
      engine.ingest(createMessage("user", `User message ${i} ${generateContent(2000)}`));
      engine.ingest(createMessage("assistant", `Assistant message ${i} ${generateContent(2000)}`));
    }

    const result = await engine.compact({ targetTokens: 1000, reason: "auto" });
    // 应降级到规则摘要（不抛出错误）
    expect(result.messages.length).toBeLessThan(20);
    expect(result.compressionRatio).toBeLessThan(1);
  });
});

// ═══════════════════════════════════════════
// 熔断
// ═══════════════════════════════════════════

describe("E.4: 熔断", () => {
  it("连续 3 次 LLM 失败后应硬截断", async () => {
    const engine = new DefaultContextEngine({
      provider: createAlwaysFailProvider(),
      maxTokens: 200_000,
    });

    // 注入大量消息
    for (let i = 0; i < 10; i++) {
      engine.ingest(createMessage("user", `User message ${i} ${generateContent(2000)}`));
      engine.ingest(createMessage("assistant", `Assistant message ${i} ${generateContent(2000)}`));
    }

    // 第 1 次压缩：LLM 失败 → 降级到规则摘要（failureCount = 1）
    const result1 = await engine.compact({ targetTokens: 1000, reason: "auto" });
    expect(result1.compressionRatio).toBeLessThan(1);

    // 重新注入消息（模拟新对话）
    for (let i = 0; i < 10; i++) {
      engine.ingest(createMessage("user", `New user message ${i} ${generateContent(2000)}`));
      engine.ingest(createMessage("assistant", `New assistant message ${i} ${generateContent(2000)}`));
    }

    // 第 2 次压缩：LLM 失败（failureCount = 2）
    await engine.compact({ targetTokens: 1000, reason: "auto" });

    // 重新注入消息
    for (let i = 0; i < 10; i++) {
      engine.ingest(createMessage("user", `Another user message ${i} ${generateContent(2000)}`));
      engine.ingest(createMessage("assistant", `Another assistant message ${i} ${generateContent(2000)}`));
    }

    // 第 3 次压缩：LLM 失败（failureCount = 3）
    await engine.compact({ targetTokens: 1000, reason: "auto" });

    // 重新注入消息
    for (let i = 0; i < 10; i++) {
      engine.ingest(createMessage("user", `Final user message ${i} ${generateContent(2000)}`));
      engine.ingest(createMessage("assistant", `Final assistant message ${i} ${generateContent(2000)}`));
    }

    // 第 4 次压缩：熔断触发 → 硬截断（qualityScore = 0.2）
    const result4 = await engine.compact({ targetTokens: 1000, reason: "auto" });
    expect(result4.qualityScore).toBe(0.2);
  });
});

// ═══════════════════════════════════════════
// 质量审计
// ═══════════════════════════════════════════

describe("E.4: 质量审计", () => {
  it("规则摘要应产生合理的质量分数", async () => {
    const engine = new DefaultContextEngine({ maxTokens: 200_000 });

    for (let i = 0; i < 10; i++) {
      engine.ingest(createMessage("user", `User message ${i} ${generateContent(2000)}`));
      engine.ingest(createMessage("assistant", `Assistant message ${i} ${generateContent(2000)}`));
    }

    const result = await engine.compact({ targetTokens: 1000, reason: "auto" });
    expect(result.qualityScore).toBeGreaterThan(0);
    expect(result.qualityScore).toBeLessThanOrEqual(1);
  });
});

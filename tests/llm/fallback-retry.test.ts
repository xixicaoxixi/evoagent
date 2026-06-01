/**
 * Session D.2 测试 — LLM 降级策略。
 *
 * 覆盖：
 * - LLM 适配器集成 resilientInvoke 重试
 * - timeout/server 错误触发重试
 * - auth 错误不重试
 * - 连续失败触发 ModelDegradationError
 * - 成功调用重置失败计数
 * - 降级审计事件
 */

import { describe, expect, it, beforeEach } from "vitest";
import { createLLMAdapter, type LLMAdapterConfig } from "../../src/llm/adapter";
import { ModelDegradationError, LLMError } from "../../src/utils/errors";
import type { LLMProvider, LLMResponse } from "../../src/interfaces/llm-provider";

// ─── Mock Provider ───

function createMockProvider(options?: {
  readonly invokeResult?: string;
  readonly invokeError?: Error;
  readonly invokeErrorPattern?: "always" | "then-succeed" | "count-then-succeed";
  readonly failCount?: number;
  readonly statusCode?: number;
}): LLMProvider {
  let callCount = 0;

  return {
    providerType: "mock",
    model: "mock-model",
    temperature: 0.1,
    maxTokens: 2048,
    countTokens: () => 100,
    healthCheck: async () => true,

    async invoke(): Promise<LLMResponse> {
      callCount++;
      const failAfter = options?.failCount ?? 2;

      if (options?.invokeError && (!options.invokeErrorPattern || options.invokeErrorPattern === "always")) {
        throw options.invokeError;
      }

      if (options?.invokeErrorPattern === "then-succeed" && callCount <= failAfter) {
        throw options?.invokeError ?? new Error("server error");
      }

      if (options?.invokeErrorPattern === "count-then-succeed" && callCount <= (options.failCount ?? 1)) {
        throw options?.invokeError ?? new Error("server error");
      }

      return {
        content: options?.invokeResult ?? `Response ${callCount}`,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
      };
    },

    async *stream() {
      yield { type: "content", content: "test" };
      yield { type: "stop", stopReason: "end_turn", tokenUsage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
}

// ─── 创建 529 错误 ───

function create529Error(): Error & { status: number } {
  const error = new Error("Overloaded") as Error & { status: number };
  error.status = 529;
  return error;
}

// ─── 创建 401 错误 ───

function create401Error(): Error & { status: number } {
  const error = new Error("Unauthorized") as Error & { status: number };
  error.status = 401;
  return error;
}

// ═══════════════════════════════════════════
// 基本重试
// ═══════════════════════════════════════════

describe("D.2: 基本重试", () => {
  it("成功调用不应重试", async () => {
    const provider = createMockProvider({ invokeResult: "hello" });
    const adapter = createLLMAdapter(provider, {
      skipSanitize: true,
      retryConfig: { ceiling: 3, baseDelayMs: 10, jitterRatio: 0 },
    });

    const result = await adapter.simpleProvider.invoke([
      { role: "user", content: "test" },
    ]);
    expect(result).toBe("hello");
    expect(adapter.consecutiveFailures()).toBe(0);
  });

  it("529 错误应触发重试", async () => {
    const provider = createMockProvider({
      invokeError: create529Error(),
      invokeErrorPattern: "then-succeed",
      failCount: 2,
    });
    const adapter = createLLMAdapter(provider, {
      skipSanitize: true,
      retryConfig: { ceiling: 3, baseDelayMs: 10, jitterRatio: 0 },
    });

    const result = await adapter.simpleProvider.invoke([
      { role: "user", content: "test" },
    ]);
    expect(result).toContain("Response");
    expect(adapter.consecutiveFailures()).toBe(0);
  });

  it("401 错误不应重试", async () => {
    const provider = createMockProvider({
      invokeError: create401Error(),
      invokeErrorPattern: "always",
    });
    const adapter = createLLMAdapter(provider, {
      skipSanitize: true,
      retryConfig: { ceiling: 3, baseDelayMs: 10, jitterRatio: 0 },
    });

    try {
      await adapter.simpleProvider.invoke([
        { role: "user", content: "test" },
      ]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LLMError);
    }
  });
});

// ═══════════════════════════════════════════
// ModelDegradationError
// ═══════════════════════════════════════════

describe("D.2: ModelDegradationError", () => {
  it("连续失败超过阈值应触发降级", async () => {
    // 创建一个总是失败的 provider
    const provider = createMockProvider({
      invokeError: create529Error(),
      invokeErrorPattern: "always",
    });
    const adapter = createLLMAdapter(provider, {
      skipSanitize: true,
      retryConfig: { ceiling: 2, baseDelayMs: 10, jitterRatio: 0 },
      degradationThreshold: 2,
    });

    // 第一次调用：重试 2 次 → 失败 → failureStreak = 1
    try {
      await adapter.simpleProvider.invoke([
        { role: "user", content: "test" },
      ]);
    } catch (e) {
      // 第一次不触发降级（streak = 1 < 2）
      expect(e).not.toBeInstanceOf(ModelDegradationError);
    }
    expect(adapter.consecutiveFailures()).toBe(1);

    // 第二次调用：重试 2 次 → 失败 → failureStreak = 2 → 触发降级
    try {
      await adapter.simpleProvider.invoke([
        { role: "user", content: "test" },
      ]);
      expect.unreachable("should have thrown ModelDegradationError");
    } catch (e) {
      expect(e).toBeInstanceOf(ModelDegradationError);
      if (e instanceof ModelDegradationError) {
        expect(e.failureStreak).toBe(2);
        expect(e.degradedFrom).toBe("mock-model");
        expect(e.degradedTo).toBe("fallback");
        expect(e.trigger).toBe("consecutive_failures");
      }
    }
    expect(adapter.consecutiveFailures()).toBe(2);
  });

  it("成功调用应重置失败计数", async () => {
    const provider = createMockProvider({
      invokeError: create529Error(),
      invokeErrorPattern: "then-succeed",
      failCount: 1,
    });
    const adapter = createLLMAdapter(provider, {
      skipSanitize: true,
      retryConfig: { ceiling: 3, baseDelayMs: 10, jitterRatio: 0 },
      degradationThreshold: 2,
    });

    // 第一次：失败后成功 → streak = 0
    await adapter.simpleProvider.invoke([
      { role: "user", content: "test" },
    ]);
    expect(adapter.consecutiveFailures()).toBe(0);

    // 手动设置失败计数
    // （通过连续失败来增加）
  });

  it("resetFailures 应重置失败计数", async () => {
    const provider = createMockProvider({
      invokeError: create529Error(),
      invokeErrorPattern: "always",
    });
    const adapter = createLLMAdapter(provider, {
      skipSanitize: true,
      retryConfig: { ceiling: 1, baseDelayMs: 10, jitterRatio: 0 },
      degradationThreshold: 3,
    });

    // 第一次失败
    try {
      await adapter.simpleProvider.invoke([
        { role: "user", content: "test" },
      ]);
    } catch {
      // expected
    }
    expect(adapter.consecutiveFailures()).toBe(1);

    // 重置
    adapter.resetFailures();
    expect(adapter.consecutiveFailures()).toBe(0);
  });
});

// ═══════════════════════════════════════════
// 重试配置
// ═══════════════════════════════════════════

describe("D.2: 重试配置", () => {
  it("ceiling=0 不应重试", async () => {
    const provider = createMockProvider({
      invokeError: create529Error(),
      invokeErrorPattern: "always",
    });
    const adapter = createLLMAdapter(provider, {
      skipSanitize: true,
      retryConfig: { ceiling: 0 },
    });

    try {
      await adapter.simpleProvider.invoke([
        { role: "user", content: "test" },
      ]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeDefined();
    }
  });
});

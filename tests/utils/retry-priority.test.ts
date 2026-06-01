/**
 * Session D.3 测试 — 交互式/批处理差异化重试。
 *
 * 覆盖：
 * - createPriorityAwareClassifier 交互式模式（server 可重试）
 * - createPriorityAwareClassifier 批处理模式（server 不可重试）
 * - getDefaultRetryConfig 交互式配置（ceiling=6）
 * - getDefaultRetryConfig 批处理配置（ceiling=2）
 * - timeout 在两种模式下都可重试
 * - auth 在两种模式下都不可重试
 */

import { describe, expect, it } from "vitest";
import {
  createPriorityAwareClassifier,
  getDefaultRetryConfig,
  resilientInvoke,
  type ErrorClassification,
} from "../../src/utils/retry";

// ─── 辅助函数 ───

async function collectEvents<T>(
  fn: () => Promise<T>,
  classifyError: (e: unknown) => ErrorClassification,
  config?: { ceiling?: number; baseDelayMs?: number; jitterRatio?: number },
): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of resilientInvoke(fn, classifyError, config)) {
    events.push(event as any);
  }
  return events;
}

// ─── 创建错误 ───

function createServerError(): Error & { status: number } {
  const error = new Error("Internal Server Error") as Error & { status: number };
  error.status = 500;
  return error;
}

function createTimeoutError(): Error {
  const error = new Error("Request timed out");
  error.name = "AbortError";
  return error;
}

function createAuthError(): Error & { status: number } {
  const error = new Error("Unauthorized") as Error & { status: number };
  error.status = 401;
  return error;
}

// ═══════════════════════════════════════════
// createPriorityAwareClassifier
// ═══════════════════════════════════════════

describe("D.3: createPriorityAwareClassifier", () => {
  describe("interactive 模式", () => {
    const classifier = createPriorityAwareClassifier("interactive");

    it("server 错误应可重试", () => {
      const result = classifier(createServerError());
      expect(result.retryable).toBe(true);
      expect(result.kind).toBe("server");
    });

    it("timeout 错误应可重试", () => {
      const result = classifier(createTimeoutError());
      expect(result.retryable).toBe(true);
      expect(result.kind).toBe("timeout");
    });

    it("auth 错误应不可重试", () => {
      const result = classifier(createAuthError());
      expect(result.retryable).toBe(false);
      expect(result.kind).toBe("auth");
    });
  });

  describe("batch 模式", () => {
    const classifier = createPriorityAwareClassifier("batch");

    it("server 错误应不可重试（避免阻塞）", () => {
      const result = classifier(createServerError());
      expect(result.retryable).toBe(false);
      expect(result.kind).toBe("server");
    });

    it("timeout 错误应可重试", () => {
      const result = classifier(createTimeoutError());
      expect(result.retryable).toBe(true);
      expect(result.kind).toBe("timeout");
    });

    it("auth 错误应不可重试", () => {
      const result = classifier(createAuthError());
      expect(result.retryable).toBe(false);
      expect(result.kind).toBe("auth");
    });
  });
});

// ═══════════════════════════════════════════
// getDefaultRetryConfig
// ═══════════════════════════════════════════

describe("D.3: getDefaultRetryConfig", () => {
  it("interactive 应有更多重试次数", () => {
    const config = getDefaultRetryConfig("interactive");
    expect(config.ceiling).toBe(3);
    expect(config.baseDelayMs).toBe(1000);
    expect(config.capDelayMs).toBe(16_000);
    expect(config.jitterRatio).toBe(0.25);
    expect(config.priority).toBe("interactive");
  });

  it("batch 应有更少重试次数", () => {
    const config = getDefaultRetryConfig("batch");
    expect(config.ceiling).toBe(2);
    expect(config.baseDelayMs).toBe(500);
    expect(config.capDelayMs).toBe(8000);
    expect(config.jitterRatio).toBe(0.15);
    expect(config.priority).toBe("batch");
  });
});

// ═══════════════════════════════════════════
// 端到端：差异化重试行为
// ═══════════════════════════════════════════

describe("D.3: 端到端差异化重试", () => {
  it("interactive 模式下 server 错误应重试", async () => {
    const classifier = createPriorityAwareClassifier("interactive");
    let callCount = 0;

    const events = await collectEvents(
      () => {
        callCount++;
        if (callCount <= 2) throw createServerError();
        return Promise.resolve("recovered");
      },
      classifier,
      { ceiling: 3, baseDelayMs: 10, jitterRatio: 0 },
    );

    // 应重试并恢复
    const resolved = events.find((e) => e.type === "resolved");
    expect(resolved).toBeDefined();
    expect(callCount).toBe(3);
  });

  it("batch 模式下 server 错误应立即放弃", async () => {
    const classifier = createPriorityAwareClassifier("batch");
    let callCount = 0;

    const events = await collectEvents(
      () => {
        callCount++;
        throw createServerError();
      },
      classifier,
      { ceiling: 3, baseDelayMs: 10, jitterRatio: 0 },
    );

    // batch 模式：server 不可重试 → 只调用 1 次
    expect(callCount).toBe(1);
    const depleted = events.find((e) => e.type === "depleted");
    expect(depleted).toBeDefined();
  });

  it("batch 模式下 timeout 错误应重试", async () => {
    const classifier = createPriorityAwareClassifier("batch");
    let callCount = 0;

    const events = await collectEvents(
      () => {
        callCount++;
        if (callCount <= 1) throw createTimeoutError();
        return Promise.resolve("recovered");
      },
      classifier,
      { ceiling: 3, baseDelayMs: 10, jitterRatio: 0 },
    );

    const resolved = events.find((e) => e.type === "resolved");
    expect(resolved).toBeDefined();
    expect(callCount).toBe(2);
  });
});

describe("E1: 网络错误分类", () => {
  const classifier = createPriorityAwareClassifier("interactive");

  it("ECONNRESET 应标记为可重试（瞬态）", () => {
    const result = classifier(new Error("read ECONNRESET"));
    expect(result.retryable).toBe(true);
    expect(result.kind).toBe("network_transient");
  });

  it("ETIMEDOUT 应标记为可重试（瞬态）", () => {
    const result = classifier(new Error("connect ETIMEDOUT"));
    expect(result.retryable).toBe(true);
    expect(result.kind).toBe("network_transient");
  });

  it("EPIPE 应标记为可重试（瞬态）", () => {
    const result = classifier(new Error("write EPIPE"));
    expect(result.retryable).toBe(true);
    expect(result.kind).toBe("network_transient");
  });

  it("ECONNREFUSED 应标记为不可重试（永久）", () => {
    const result = classifier(new Error("connect ECONNREFUSED"));
    expect(result.retryable).toBe(false);
    expect(result.kind).toBe("network_permanent");
  });

  it("ENOTFOUND 应标记为不可重试（永久）", () => {
    const result = classifier(new Error("getaddrinfo ENOTFOUND"));
    expect(result.retryable).toBe(false);
    expect(result.kind).toBe("network_permanent");
  });

  it("fetch failed 应标记为不可重试", () => {
    const result = classifier(new Error("fetch failed"));
    expect(result.retryable).toBe(false);
    expect(result.kind).toBe("network_fetch");
  });
});

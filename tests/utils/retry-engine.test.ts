/**
 * Session D.1 测试 — resilientInvoke 重试引擎。
 *
 * 覆盖：
 * - 成功调用不重试
 * - 可重试错误正确重试
 * - 不可重试错误立即放弃
 * - 指数退避序列正确
 * - Jitter 在范围内
 * - 服务端提示优先
 * - 重试耗尽 yield depleted
 * - ceiling 限制
 */

import { describe, expect, it } from "vitest";
import {
  resilientInvoke,
  calculateBackoff,
  type RetryEvent,
  type ResilienceConfig,
  type ErrorClassification,
} from "../../src/utils/retry";

// ─── 辅助函数 ───

/** 收集所有事件 */
async function collectEvents<T>(
  fn: () => Promise<T>,
  classifyError: (e: unknown) => ErrorClassification,
  config?: ResilienceConfig,
): Promise<RetryEvent<T>[]> {
  const events: RetryEvent<T>[] = [];
  for await (const event of resilientInvoke(fn, classifyError, config)) {
    events.push(event);
  }
  return events;
}

const retryableClassifier: (e: unknown) => ErrorClassification = () => ({
  retryable: true,
  kind: "server",
});

const nonRetryableClassifier: (e: unknown) => ErrorClassification = () => ({
  retryable: false,
  kind: "auth",
});

// ═══════════════════════════════════════════
// 成功调用
// ═══════════════════════════════════════════

describe("成功调用", () => {
  it("应直接返回结果，不重试", async () => {
    const events = await collectEvents(
      () => Promise.resolve("success"),
      nonRetryableClassifier,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("resolved");
    if (events[0]?.type === "resolved") {
      expect(events[0].result).toBe("success");
      expect(events[0].attempt).toBe(1);
      expect(events[0].totalDelayMs).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════
// 可重试错误
// ═══════════════════════════════════════════

describe("可重试错误", () => {
  it("第 1 次失败第 2 次成功应产生正确事件序列", async () => {
    let callCount = 0;
    const events = await collectEvents(
      () => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error("server error"));
        return Promise.resolve("recovered");
      },
      retryableClassifier,
      { ceiling: 3 },
    );

    expect(callCount).toBe(2);

    // 事件序列: failed → retrying → resolved
    expect(events.length).toBeGreaterThanOrEqual(3);

    const failed = events.find((e) => e.type === "failed");
    expect(failed).toBeDefined();
    if (failed?.type === "failed") {
      expect(failed.willRetry).toBe(true);
      expect(failed.attempt).toBe(1);
    }

    const retrying = events.find((e) => e.type === "retrying");
    expect(retrying).toBeDefined();

    const resolved = events.find((e) => e.type === "resolved");
    expect(resolved).toBeDefined();
    if (resolved?.type === "resolved") {
      expect(resolved.result).toBe("recovered");
      expect(resolved.attempt).toBe(2);
    }
  });

  it("不可重试错误应立即放弃", async () => {
    let callCount = 0;
    const events = await collectEvents(
      () => {
        callCount++;
        return Promise.reject(new Error("auth error"));
      },
      nonRetryableClassifier,
      { ceiling: 5 },
    );

    expect(callCount).toBe(1);
    // failed → depleted
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("failed");
    if (events[0]?.type === "failed") {
      expect(events[0].willRetry).toBe(false);
    }
    expect(events[1]?.type).toBe("depleted");
  });
});

// ═══════════════════════════════════════════
// 重试耗尽
// ═══════════════════════════════════════════

describe("重试耗尽", () => {
  it("ceiling=2 时最多重试 2 次（共 3 次调用）", async () => {
    let callCount = 0;
    const events = await collectEvents(
      () => {
        callCount++;
        return Promise.reject(new Error("always fail"));
      },
      retryableClassifier,
      { ceiling: 2 },
    );

    expect(callCount).toBe(3); // 1 初始 + 2 重试

    const depleted = events.find((e) => e.type === "depleted");
    expect(depleted).toBeDefined();
    if (depleted?.type === "depleted") {
      expect(depleted.totalAttempts).toBe(3);
    }
  });

  it("ceiling=0 时不应重试", async () => {
    let callCount = 0;
    const events = await collectEvents(
      () => {
        callCount++;
        return Promise.reject(new Error("fail"));
      },
      retryableClassifier,
      { ceiling: 0 },
    );

    expect(callCount).toBe(1);
    const depleted = events.find((e) => e.type === "depleted");
    expect(depleted).toBeDefined();
  });
});

// ═══════════════════════════════════════════
// calculateBackoff
// ═══════════════════════════════════════════

describe("calculateBackoff", () => {
  it("attempt=1 应返回基础延迟（±Jitter）", () => {
    const baseDelay = 1000;
    const jitterRatio = 0.25;
    for (let i = 0; i < 50; i++) {
      const delay = calculateBackoff(1, {
        baseDelayMs: baseDelay,
        capDelayMs: 32000,
        jitterRatio,
      });
      // 1000 * (1 ± 0.25) = [750, 1250]
      expect(delay).toBeGreaterThanOrEqual(Math.round(baseDelay * (1 - jitterRatio)));
      expect(delay).toBeLessThanOrEqual(Math.round(baseDelay * (1 + jitterRatio)));
    }
  });

  it("attempt=2 应约为 2000ms（±Jitter）", () => {
    const delay = calculateBackoff(2, {
      baseDelayMs: 1000,
      capDelayMs: 32000,
      jitterRatio: 0,
    });
    expect(delay).toBe(2000);
  });

  it("attempt=3 应约为 4000ms（±Jitter）", () => {
    const delay = calculateBackoff(3, {
      baseDelayMs: 1000,
      capDelayMs: 32000,
      jitterRatio: 0,
    });
    expect(delay).toBe(4000);
  });

  it("attempt=5 应约为 16000ms（±Jitter）", () => {
    const delay = calculateBackoff(5, {
      baseDelayMs: 1000,
      capDelayMs: 32000,
      jitterRatio: 0,
    });
    expect(delay).toBe(16000);
  });

  it("attempt=6 应封顶 32000ms", () => {
    const delay = calculateBackoff(6, {
      baseDelayMs: 1000,
      capDelayMs: 32000,
      jitterRatio: 0,
    });
    // 1000 * 2^5 = 32000 = cap
    expect(delay).toBe(32000);
  });

  it("attempt=7 应封顶 32000ms", () => {
    const delay = calculateBackoff(7, {
      baseDelayMs: 1000,
      capDelayMs: 32000,
      jitterRatio: 0,
    });
    // 1000 * 2^6 = 64000 > 32000 → cap
    expect(delay).toBe(32000);
  });

  it("服务端提示应优先于指数退避", () => {
    const delay = calculateBackoff(5, {
      serverRetryHint: 5000,
      jitterRatio: 0,
    });
    expect(delay).toBe(5000);
  });

  it("服务端提示 + Jitter 应在范围内", () => {
    for (let i = 0; i < 50; i++) {
      const delay = calculateBackoff(1, {
        serverRetryHint: 2000,
        jitterRatio: 0.25,
        capDelayMs: 32000,
      });
      // 2000 * (1 ± 0.25) = [1500, 2500]
      expect(delay).toBeGreaterThanOrEqual(1500);
      expect(delay).toBeLessThanOrEqual(2500);
    }
  });

  it("serverRetryHint=null 应使用指数退避", () => {
    const delay = calculateBackoff(1, {
      serverRetryHint: null,
      baseDelayMs: 1000,
      capDelayMs: 32000,
      jitterRatio: 0,
    });
    expect(delay).toBe(1000);
  });
});

// ═══════════════════════════════════════════
// 事件字段验证
// ═══════════════════════════════════════════

describe("事件字段验证", () => {
  it("failed 事件应包含 kind", async () => {
    const classifier: (e: unknown) => ErrorClassification = () => ({
      retryable: true,
      kind: "timeout",
    });
    const events = await collectEvents(
      () => Promise.reject(new Error("timeout")),
      classifier,
      { ceiling: 1 },
    );

    const failed = events.find((e) => e.type === "failed");
    if (failed?.type === "failed") {
      expect(failed.kind).toBe("timeout");
    }

    const retrying = events.find((e) => e.type === "retrying");
    if (retrying?.type === "retrying") {
      expect(retrying.kind).toBe("timeout");
    }
  });

  it("retrying 事件应包含正确的 attempt 和 delay", async () => {
    let callCount = 0;
    const events = await collectEvents(
      () => {
        callCount++;
        if (callCount <= 2) return Promise.reject(new Error("fail"));
        return Promise.resolve("ok");
      },
      retryableClassifier,
      { ceiling: 5, baseDelayMs: 100, jitterRatio: 0 },
    );

    const retrying = events.find((e) => e.type === "retrying");
    if (retrying?.type === "retrying") {
      expect(retrying.attempt).toBe(2);
      expect(retrying.delay).toBe(100); // baseDelayMs * 2^(1-1) = 100
    }
  });
});

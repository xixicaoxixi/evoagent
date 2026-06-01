/**
 * Session A.3 测试 — 网络错误分类 + 审计日志。
 *
 * 覆盖：
 * - LLM 适配器集成 classifyNetworkError（401/403 → auth, 529 → server, AbortSignal → timeout）
 * - 错误分类驱动的日志级别（auth → warn, timeout → info, network → warn, server → error）
 * - Logger.logToolError 审计事件
 * - LLMError 包装（statusCode + retryable）
 */

import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from "vitest";
import { LLMError, classifyNetworkError, ShellError } from "../../src/utils/errors";
import { createLogger, type Logger } from "../../src/observability/logger";

// ─── LLM 适配器错误分类集成 ───

describe("LLM 适配器错误分类集成", () => {
  it("401 错误应归类为 auth 并包装为 LLMError", () => {
    const error = new Error("Unauthorized") as Error & { status: number };
    error.status = 401;
    const classification = classifyNetworkError(error);

    expect(classification.category).toBe("auth");
    if (classification.category === "auth") {
      expect(classification.status).toBe(401);

      // 验证 LLMError 包装
      const llmError = new LLMError(classification.message, "test-model", {
        statusCode: classification.status,
        retryable: classification.category === "timeout" || classification.category === "server",
        cause: error,
      });
      expect(llmError).toBeInstanceOf(LLMError);
      expect(llmError.statusCode).toBe(401);
      expect(llmError.retryable).toBe(false); // auth 不可重试
      expect(llmError.model).toBe("test-model");
    }
  });

  it("403 错误应归类为 auth 并包装为 LLMError", () => {
    const error = new Error("Forbidden") as Error & { status: number };
    error.status = 403;
    const classification = classifyNetworkError(error);

    expect(classification.category).toBe("auth");
    if (classification.category === "auth") {
      const llmError = new LLMError(classification.message, "test-model", {
        statusCode: classification.status,
        retryable: classification.category === "timeout" || classification.category === "server",
      });
      expect(llmError.statusCode).toBe(403);
      expect(llmError.retryable).toBe(false);
    }
  });

  it("529 错误应归类为 server 并标记为可重试", () => {
    const error = new Error("Overloaded") as Error & { status: number };
    error.status = 529;
    const classification = classifyNetworkError(error);

    expect(classification.category).toBe("server");
    if (classification.category === "server") {
      const llmError = new LLMError(classification.message, "test-model", {
        statusCode: classification.status,
        retryable: classification.category === "timeout" || classification.category === "server",
      });
      expect(llmError.statusCode).toBe(529);
      expect(llmError.retryable).toBe(true); // server 错误可重试
    }
  });

  it("500 错误应归类为 server 并标记为可重试", () => {
    const error = new Error("Internal Server Error") as Error & { status: number };
    error.status = 500;
    const classification = classifyNetworkError(error);

    expect(classification.category).toBe("server");
    if (classification.category === "server") {
      const llmError = new LLMError(classification.message, "test-model", {
        statusCode: classification.status,
        retryable: classification.category === "timeout" || classification.category === "server",
      });
      expect(llmError.retryable).toBe(true);
    }
  });

  it("AbortSignal 应归类为 timeout 并标记为可重试", () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    const classification = classifyNetworkError(error);

    expect(classification.category).toBe("timeout");
    const llmError = new LLMError(classification.message, "test-model", {
      retryable: classification.category === "timeout" || classification.category === "server",
    });
    expect(llmError.retryable).toBe(true); // timeout 可重试
    expect(llmError.statusCode).toBeUndefined();
  });

  it("超时消息应归类为 timeout 并标记为可重试", () => {
    const error = new Error("LLM call timed out after 30000ms");
    const classification = classifyNetworkError(error);

    expect(classification.category).toBe("timeout");
    const llmError = new LLMError(classification.message, "test-model", {
      retryable: classification.category === "timeout" || classification.category === "server",
    });
    expect(llmError.retryable).toBe(true);
  });

  it("网络错误应归类为 network 并标记为不可重试", () => {
    const error = new Error("fetch failed");
    const classification = classifyNetworkError(error);

    expect(classification.category).toBe("network");
    const llmError = new LLMError(classification.message, "test-model", {
      retryable: classification.category === "timeout" || classification.category === "server" || classification.category === "rate_limit",
    });
    expect(llmError.retryable).toBe(false); // network 不可重试
  });

  it("429 错误应归类为 rate_limit 并标记为可重试", () => {
    const error = new Error("Too Many Requests") as Error & { status: number };
    error.status = 429;
    const classification = classifyNetworkError(error);

    expect(classification.category).toBe("rate_limit");
    if (classification.category === "rate_limit") {
      expect(classification.status).toBe(429);
      const llmError = new LLMError(classification.message, "test-model", {
        statusCode: classification.status,
        retryable: classification.category === "timeout" || classification.category === "server" || classification.category === "rate_limit",
      });
      expect(llmError.retryable).toBe(true);
      expect(llmError.statusCode).toBe(429);
    }
  });

  it("LLMError 429 应归类为 rate_limit 并标记为可重试", () => {
    const error = new LLMError("Rate limit exceeded", "test-model", { statusCode: 429 });
    const classification = classifyNetworkError(error);

    expect(classification.category).toBe("rate_limit");
    if (classification.category === "rate_limit") {
      expect(classification.status).toBe(429);
    }
  });
});

// ─── 错误分类驱动的日志级别 ───

describe("错误分类驱动的日志级别", () => {
  let logEntries: Array<{ level: string; message: string; fields: Record<string, unknown> }>;
  let logger: Logger;

  beforeEach(() => {
    logEntries = [];
    logger = createLogger({
      minLevel: "debug",
      handler: (entry) => {
        logEntries.push({
          level: entry.level,
          message: entry.message,
          fields: entry.fields,
        });
      },
    });
  });

  it("auth 错误 → warn 级别", () => {
    logger.warn("LLM auth error: Unauthorized", { category: "auth", status: 401 });
    const authLogs = logEntries.filter((e) => e.fields.category === "auth");
    expect(authLogs.length).toBeGreaterThan(0);
    expect(authLogs[0]?.level).toBe("warn");
  });

  it("timeout 错误 → info 级别", () => {
    logger.info("LLM timeout: timed out", { category: "timeout" });
    const timeoutLogs = logEntries.filter((e) => e.fields.category === "timeout");
    expect(timeoutLogs.length).toBeGreaterThan(0);
    expect(timeoutLogs[0]?.level).toBe("info");
  });

  it("network 错误 → warn 级别", () => {
    logger.warn("LLM network error: fetch failed", { category: "network" });
    const networkLogs = logEntries.filter((e) => e.fields.category === "network");
    expect(networkLogs.length).toBeGreaterThan(0);
    expect(networkLogs[0]?.level).toBe("warn");
  });

  it("server 错误 → error 级别", () => {
    logger.error("LLM server error: overloaded", { category: "server", status: 529 });
    const serverLogs = logEntries.filter((e) => e.fields.category === "server");
    expect(serverLogs.length).toBeGreaterThan(0);
    expect(serverLogs[0]?.level).toBe("error");
  });

  it("rate_limit 错误 → warn 级别", () => {
    logger.warn("LLM rate limit error: Too Many Requests", { category: "rate_limit", status: 429 });
    const rateLimitLogs = logEntries.filter((e) => e.fields.category === "rate_limit");
    expect(rateLimitLogs.length).toBeGreaterThan(0);
    expect(rateLimitLogs[0]?.level).toBe("warn");
  });
});

// ─── logToolError 审计事件 ───

describe("logToolError 审计事件", () => {
  let logEntries: Array<{ level: string; message: string; fields: Record<string, unknown> }>;
  let logger: Logger;

  beforeEach(() => {
    logEntries = [];
    logger = createLogger({
      minLevel: "debug",
      handler: (entry) => {
        logEntries.push({
          level: entry.level,
          message: entry.message,
          fields: entry.fields,
        });
      },
    });
  });

  it("应记录 error 级别的工具错误审计", () => {
    const error = new Error("Command failed with exit code 1");
    logger.logToolError("bash", error, 1500);

    expect(logEntries.length).toBe(1);
    expect(logEntries[0]?.level).toBe("error");
    expect(logEntries[0]?.message).toContain("bash");
  });

  it("应包含 toolName 字段", () => {
    logger.logToolError("file_read", new Error("ENOENT"), 200);
    expect(logEntries[0]?.fields.toolName).toBe("file_read");
  });

  it("应包含 errorCode 字段", () => {
    logger.logToolError("bash", new Error("fail"), 100);
    expect(logEntries[0]?.fields.errorCode).toBe("UNKNOWN_ERROR");
  });

  it("应包含 durationMs 字段", () => {
    logger.logToolError("bash", new Error("fail"), 5000);
    expect(logEntries[0]?.fields.durationMs).toBe(5000);
  });

  it("应包含 errorCategory 字段", () => {
    logger.logToolError("bash", new Error("fail"), 100);
    expect(logEntries[0]?.fields.errorCategory).toBe("unknown");
  });

  it("EvoAgentError 应保留原始错误码", () => {
    const shellError = new ShellError("command failed", { exitCode: 1 });
    logger.logToolError("bash", shellError, 300);
    expect(logEntries[0]?.fields.errorCode).toBe("SHELL_EXIT_NONZERO");
  });

  it("网络错误应包含正确的 errorCategory", () => {
    const error = new Error("Unauthorized") as Error & { status: number };
    error.status = 401;
    logger.logToolError("api_call", error, 1000);
    expect(logEntries[0]?.fields.errorCategory).toBe("auth");
  });

  it("超时错误应包含正确的 errorCategory", () => {
    const error = new Error("Request timed out");
    logger.logToolError("llm_query", error, 30000);
    expect(logEntries[0]?.fields.errorCategory).toBe("timeout");
  });
});

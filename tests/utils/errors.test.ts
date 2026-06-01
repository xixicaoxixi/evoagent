/**
 * Session A.1 测试 — 结构化错误类型体系。
 *
 * 覆盖：
 * - EvoAgentError 基类（code/context/cause）
 * - 领域错误子类继承（ShellError/ConfigParseError/SandboxError/LLMError）
 * - isCancellation（Bun AbortError / DOMException）
 * - normalizeError / extractErrorMessage
 * - truncateStack
 * - isPathUnreachable
 * - classifyNetworkError（auth/timeout/network/server/unknown）
 */

import { describe, expect, it } from "vitest";
import {
  EvoAgentError,
  ShellError,
  ConfigParseError,
  SandboxError,
  LLMError,
  ModelDegradationError,
  SafeReportError,
  isCancellation,
  normalizeError,
  extractErrorMessage,
  truncateStack,
  isPathUnreachable,
  classifyNetworkError,
} from "../../src/utils/errors";

// ─── EvoAgentError 基类 ───

describe("EvoAgentError", () => {
  it("应正确设置 code、message 和 context", () => {
    const error = new EvoAgentError("test error", "TEST_CODE", {
      context: { key: "value" },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(EvoAgentError);
    expect(error.name).toBe("EvoAgentError");
    expect(error.message).toBe("test error");
    expect(error.code).toBe("TEST_CODE");
    expect(error.context).toEqual({ key: "value" });
  });

  it("应支持 cause 因果链", () => {
    const cause = new Error("original");
    const error = new EvoAgentError("wrapped", "WRAP", { cause });
    expect(error.cause).toBe(cause);
    expect(error.cause?.message).toBe("original");
  });

  it("context 和 cause 均为可选", () => {
    const error = new EvoAgentError("simple", "SIMPLE");
    expect(error.context).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});

// ─── ShellError ───

describe("ShellError", () => {
  it("应正确继承 EvoAgentError 并设置 shell 特有字段", () => {
    const error = new ShellError("command failed", {
      stdout: "output",
      stderr: "error output",
      exitCode: 1,
      wasSignaled: false,
    });
    expect(error).toBeInstanceOf(EvoAgentError);
    expect(error).toBeInstanceOf(ShellError);
    expect(error.name).toBe("ShellError");
    expect(error.code).toBe("SHELL_EXIT_NONZERO");
    expect(error.stdout).toBe("output");
    expect(error.stderr).toBe("error output");
    expect(error.exitCode).toBe(1);
    expect(error.wasSignaled).toBe(false);
  });

  it("所有字段均有默认值", () => {
    const error = new ShellError("no details");
    expect(error.stdout).toBe("");
    expect(error.stderr).toBe("");
    expect(error.exitCode).toBeNull();
    expect(error.wasSignaled).toBe(false);
  });

  it("支持 cause 传递", () => {
    const cause = new Error("spawn failed");
    const error = new ShellError("shell error", { cause });
    expect(error.cause).toBe(cause);
  });
});

// ─── ConfigParseError ───

describe("ConfigParseError", () => {
  it("应正确设置 filePath 和 fallbackConfig", () => {
    const fallback = { key: "default" };
    const error = new ConfigParseError("parse failed", "/path/to/config.json", fallback);
    expect(error).toBeInstanceOf(EvoAgentError);
    expect(error).toBeInstanceOf(ConfigParseError);
    expect(error.name).toBe("ConfigParseError");
    expect(error.code).toBe("CONFIG_PARSE_FAILED");
    expect(error.filePath).toBe("/path/to/config.json");
    expect(error.fallbackConfig).toEqual(fallback);
  });

  it("fallbackConfig 可选", () => {
    const error = new ConfigParseError("missing file", "/missing.json");
    expect(error.fallbackConfig).toBeUndefined();
  });
});

// ─── SandboxError ───

describe("SandboxError", () => {
  const violationTypes = ["filesystem", "network", "process"] as const;

  for (const vt of violationTypes) {
    it(`应支持 violationType: ${vt}`, () => {
      const error = new SandboxError(`sandbox ${vt} violation`, vt);
      expect(error).toBeInstanceOf(EvoAgentError);
      expect(error).toBeInstanceOf(SandboxError);
      expect(error.name).toBe("SandboxError");
      expect(error.code).toBe("SANDBOX_VIOLATION");
      expect(error.violationType).toBe(vt);
    });
  }
});

// ─── LLMError ───

describe("LLMError", () => {
  it("应正确设置 model、statusCode、retryable", () => {
    const error = new LLMError("rate limited", "claude-3", {
      statusCode: 429,
      retryable: true,
    });
    expect(error).toBeInstanceOf(EvoAgentError);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.name).toBe("LLMError");
    expect(error.code).toBe("LLM_INVOKE_FAILED");
    expect(error.model).toBe("claude-3");
    expect(error.statusCode).toBe(429);
    expect(error.retryable).toBe(true);
  });

  it("retryable 默认为 false", () => {
    const error = new LLMError("failed", "gpt-4");
    expect(error.retryable).toBe(false);
    expect(error.statusCode).toBeUndefined();
  });
});

// ─── ModelDegradationError ───

describe("ModelDegradationError", () => {
  it("应正确设置降级相关字段", () => {
    const sourceError = new LLMError("529 overloaded", "claude-3", { statusCode: 529 });
    const error = new ModelDegradationError("degrading model", {
      sourceError,
      failureStreak: 3,
      degradedFrom: "claude-3",
      degradedTo: "claude-3-haiku",
      trigger: "consecutive_529",
    });
    expect(error).toBeInstanceOf(EvoAgentError);
    expect(error).toBeInstanceOf(ModelDegradationError);
    expect(error.name).toBe("ModelDegradationError");
    expect(error.code).toBe("MODEL_DEGRADATION");
    expect(error.sourceError).toBe(sourceError);
    expect(error.failureStreak).toBe(3);
    expect(error.degradedFrom).toBe("claude-3");
    expect(error.degradedTo).toBe("claude-3-haiku");
    expect(error.trigger).toBe("consecutive_529");
  });
});

// ─── SafeReportError ───

describe("SafeReportError", () => {
  it("应正确继承 EvoAgentError", () => {
    const error = new SafeReportError("safe message", "SAFE_CODE");
    expect(error).toBeInstanceOf(EvoAgentError);
    expect(error).toBeInstanceOf(SafeReportError);
    expect(error.name).toBe("SafeReportError");
    expect(error.message).toBe("safe message");
    expect(error.code).toBe("SAFE_CODE");
  });
});

// ─── isCancellation ───

describe("isCancellation", () => {
  it("应识别 Bun AbortError", () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    expect(isCancellation(abortError)).toBe(true);
  });

  it("应识别 DOMException AbortError", () => {
    const domException = new DOMException("The operation was aborted", "AbortError");
    expect(isCancellation(domException)).toBe(true);
  });

  it("普通 Error 不应被识别为取消", () => {
    expect(isCancellation(new Error("normal error"))).toBe(false);
  });

  it("非 Error 值不应被识别为取消", () => {
    expect(isCancellation("some string")).toBe(false);
    expect(isCancellation(null)).toBe(false);
    expect(isCancellation(undefined)).toBe(false);
  });
});

// ─── normalizeError ───

describe("normalizeError", () => {
  it("EvoAgentError 直接返回", () => {
    const original = new ShellError("shell fail");
    const normalized = normalizeError(original);
    expect(normalized).toBe(original);
  });

  it("普通 Error 包装为 EvoAgentError", () => {
    const original = new TypeError("type error");
    const normalized = normalizeError(original);
    expect(normalized).toBeInstanceOf(EvoAgentError);
    expect(normalized.message).toBe("type error");
    expect(normalized.code).toBe("UNKNOWN_ERROR");
    expect(normalized.cause).toBe(original);
  });

  it("非 Error 值转为字符串消息", () => {
    const normalized = normalizeError("string error");
    expect(normalized).toBeInstanceOf(EvoAgentError);
    expect(normalized.message).toBe("string error");
    expect(normalized.code).toBe("UNKNOWN_ERROR");
  });

  it("null/undefined 转为字符串", () => {
    expect(normalizeError(null).message).toBe("null");
    expect(normalizeError(undefined).message).toBe("undefined");
  });
});

// ─── extractErrorMessage ───

describe("extractErrorMessage", () => {
  it("SafeReportError 优先返回安全消息", () => {
    const error = new SafeReportError("safe msg", "CODE");
    expect(extractErrorMessage(error)).toBe("safe msg");
  });

  it("普通 Error 返回 message", () => {
    expect(extractErrorMessage(new Error("normal msg"))).toBe("normal msg");
  });

  it("非 Error 值返回 String()", () => {
    expect(extractErrorMessage(42)).toBe("42");
    expect(extractErrorMessage(null)).toBe("null");
  });
});

// ─── truncateStack ───

describe("truncateStack", () => {
  it("应截断堆栈到指定帧数", () => {
    const error = new Error("test");
    // 确保有堆栈
    if (!error.stack) {
      expect(truncateStack(error)).toBe("");
      return;
    }
    const truncated = truncateStack(error, 2);
    const lines = truncated.split("\n");
    // 第一行（错误消息）+ 最多 2 帧
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toContain("test");
  });

  it("默认最多 3 帧", () => {
    const error = new Error("default");
    if (!error.stack) {
      expect(truncateStack(error)).toBe("");
      return;
    }
    const truncated = truncateStack(error);
    const lines = truncated.split("\n");
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it("非 Error 值返回空字符串", () => {
    expect(truncateStack("not an error")).toBe("");
    expect(truncateStack(null)).toBe("");
  });

  it("无堆栈的 Error 返回空字符串", () => {
    const error = new Error("no stack");
    // 强制移除堆栈
    Object.defineProperty(error, "stack", { value: undefined });
    expect(truncateStack(error)).toBe("");
  });
});

// ─── isPathUnreachable ───

describe("isPathUnreachable", () => {
  it("应识别 ENOENT", () => {
    const error = new Error("file not found") as Error & { code: string };
    error.code = "ENOENT";
    expect(isPathUnreachable(error)).toBe(true);
  });

  it("应识别 EACCES", () => {
    const error = new Error("permission denied") as Error & { code: string };
    error.code = "EACCES";
    expect(isPathUnreachable(error)).toBe(true);
  });

  it("应识别 EPERM", () => {
    const error = new Error("operation not permitted") as Error & { code: string };
    error.code = "EPERM";
    expect(isPathUnreachable(error)).toBe(true);
  });

  it("应识别 ENOTDIR", () => {
    const error = new Error("not a directory") as Error & { code: string };
    error.code = "ENOTDIR";
    expect(isPathUnreachable(error)).toBe(true);
  });

  it("非文件系统错误返回 false", () => {
    const error = new Error("some other error") as Error & { code: string };
    error.code = "EINVAL";
    expect(isPathUnreachable(error)).toBe(false);
  });

  it("无 code 字段的 Error 返回 false", () => {
    expect(isPathUnreachable(new Error("no code"))).toBe(false);
  });

  it("非 Error 值返回 false", () => {
    expect(isPathUnreachable("string")).toBe(false);
  });
});

// ─── classifyNetworkError ───

describe("classifyNetworkError", () => {
  it("LLMError 401 归类为 auth", () => {
    const error = new LLMError("unauthorized", "model", { statusCode: 401 });
    const result = classifyNetworkError(error);
    expect(result.category).toBe("auth");
    if (result.category === "auth") {
      expect(result.status).toBe(401);
    }
  });

  it("LLMError 403 归类为 auth", () => {
    const error = new LLMError("forbidden", "model", { statusCode: 403 });
    const result = classifyNetworkError(error);
    expect(result.category).toBe("auth");
  });

  it("LLMError 500 归类为 server", () => {
    const error = new LLMError("internal error", "model", { statusCode: 500 });
    const result = classifyNetworkError(error);
    expect(result.category).toBe("server");
    if (result.category === "server") {
      expect(result.status).toBe(500);
    }
  });

  it("LLMError 529 归类为 server", () => {
    const error = new LLMError("overloaded", "model", { statusCode: 529 });
    const result = classifyNetworkError(error);
    expect(result.category).toBe("server");
  });

  it("LLMError 429 归类为 rate_limit", () => {
    const error = new LLMError("rate limit exceeded", "model", { statusCode: 429 });
    const result = classifyNetworkError(error);
    expect(result.category).toBe("rate_limit");
    if (result.category === "rate_limit") {
      expect(result.status).toBe(429);
    }
  });

  it("带 status 字段的普通 Error 429 归类为 rate_limit", () => {
    const error = new Error("Too Many Requests") as Error & { status: number };
    error.status = 429;
    const result = classifyNetworkError(error);
    expect(result.category).toBe("rate_limit");
    if (result.category === "rate_limit") {
      expect(result.status).toBe(429);
    }
  });

  it("LLMError 429 带 Retry-After 头解析 retryAfterMs", () => {
    const error = new LLMError("rate limit exceeded", "model", { statusCode: 429 }) as LLMError & { headers: { get: (name: string) => string | null } };
    error.headers = { get: (name: string) => name === "retry-after" ? "30" : null };
    const result = classifyNetworkError(error);
    expect(result.category).toBe("rate_limit");
    if (result.category === "rate_limit") {
      expect(result.retryAfterMs).toBe(30000);
    }
  });

  it("AbortError 归类为 timeout", () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    const result = classifyNetworkError(error);
    expect(result.category).toBe("timeout");
  });

  it("DOMException AbortError 归类为 timeout", () => {
    const error = new DOMException("aborted", "AbortError");
    const result = classifyNetworkError(error);
    expect(result.category).toBe("timeout");
  });

  it("包含 'timed out' 的消息归类为 timeout", () => {
    const error = new Error("Request timed out after 30000ms");
    const result = classifyNetworkError(error);
    expect(result.category).toBe("timeout");
  });

  it("ECONNREFUSED 归类为 network", () => {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    const result = classifyNetworkError(error);
    expect(result.category).toBe("network");
  });

  it("ENOTFOUND 归类为 network", () => {
    const error = new Error("getaddrinfo ENOTFOUND api.example.com");
    const result = classifyNetworkError(error);
    expect(result.category).toBe("network");
  });

  it("fetch failed 归类为 network", () => {
    const error = new Error("fetch failed");
    const result = classifyNetworkError(error);
    expect(result.category).toBe("network");
  });

  it("带 status 字段的普通 Error 401 归类为 auth", () => {
    const error = new Error("Unauthorized") as Error & { status: number };
    error.status = 401;
    const result = classifyNetworkError(error);
    expect(result.category).toBe("auth");
  });

  it("带 status 字段的普通 Error 503 归类为 server", () => {
    const error = new Error("Service Unavailable") as Error & { status: number };
    error.status = 503;
    const result = classifyNetworkError(error);
    expect(result.category).toBe("server");
  });

  it("无法分类的错误归类为 unknown", () => {
    const error = new Error("something unexpected happened");
    const result = classifyNetworkError(error);
    expect(result.category).toBe("unknown");
  });

  it("非 Error 值归类为 unknown", () => {
    const result = classifyNetworkError("just a string");
    expect(result.category).toBe("unknown");
  });
});

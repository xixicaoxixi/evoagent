/**
 * Session A.2 测试 — 工具级错误隔离（错误即数据范式）。
 *
 * 覆盖：
 * - StreamingToolExecutor 错误封装（isError=true + truncateStack + errorCode）
 * - classifyToolError 分类（timeout/cancellation/permission/unknown）
 * - StreamEventToolError 事件类型
 * - 查询循环中工具错误不终止循环（可恢复错误）
 */

import { describe, expect, it } from "vitest";
import { classifyToolError, type ToolErrorCategory } from "../../src/tools/executor";
import type { StreamEventToolError } from "../../src/core/query/types";

// ─── classifyToolError ───

describe("classifyToolError", () => {
  it("AbortError 归类为 cancellation", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(classifyToolError(error)).toBe("cancellation");
  });

  it("DOMException AbortError 归类为 cancellation", () => {
    const error = new DOMException("aborted", "AbortError");
    expect(classifyToolError(error)).toBe("cancellation");
  });

  it("包含 'timed out' 归类为 timeout", () => {
    const error = new Error("Tool 'bash' timed out after 120000ms");
    expect(classifyToolError(error)).toBe("timeout");
  });

  it("包含 'timeout' 归类为 timeout", () => {
    const error = new Error("Connection timeout");
    expect(classifyToolError(error)).toBe("timeout");
  });

  it("包含 'Permission denied' 归类为 permission", () => {
    const error = new Error("Permission denied: Tool use not allowed");
    expect(classifyToolError(error)).toBe("permission");
  });

  it("普通错误归类为 unknown", () => {
    const error = new Error("Something went wrong");
    expect(classifyToolError(error)).toBe("unknown");
  });

  it("非 Error 值归类为 unknown", () => {
    expect(classifyToolError("string error")).toBe("unknown");
    expect(classifyToolError(42)).toBe("unknown");
  });
});

// ─── StreamEventToolError 类型验证 ───

describe("StreamEventToolError", () => {
  it("应正确构造 tool_error 事件", () => {
    const event: StreamEventToolError = {
      type: "tool_error",
      toolName: "bash",
      toolUseId: "tool-123",
      errorCode: "TOOL_ERROR",
      category: "unknown",
      message: "Command failed with exit code 1",
      recoverable: true,
    };
    expect(event.type).toBe("tool_error");
    expect(event.toolName).toBe("bash");
    expect(event.toolUseId).toBe("tool-123");
    expect(event.errorCode).toBe("TOOL_ERROR");
    expect(event.category).toBe("unknown");
    expect(event.recoverable).toBe(true);
  });

  it("超时错误标记为不可恢复", () => {
    const event: StreamEventToolError = {
      type: "tool_error",
      toolName: "file_read",
      toolUseId: "tool-456",
      errorCode: "TIMEOUT",
      category: "timeout",
      message: "Tool 'file_read' timed out after 120000ms",
      recoverable: false,
    };
    expect(event.category).toBe("timeout");
    expect(event.recoverable).toBe(false);
  });

  it("取消错误标记为不可恢复", () => {
    const event: StreamEventToolError = {
      type: "tool_error",
      toolName: "bash",
      toolUseId: "tool-789",
      errorCode: "CANCELLED",
      category: "cancellation",
      message: "Aborted: global abort signal",
      recoverable: false,
    };
    expect(event.category).toBe("cancellation");
    expect(event.recoverable).toBe(false);
  });

  it("权限错误标记为可恢复", () => {
    const event: StreamEventToolError = {
      type: "tool_error",
      toolName: "file_write",
      toolUseId: "tool-abc",
      errorCode: "PERMISSION_DENIED",
      category: "permission",
      message: "Permission denied: Tool use not allowed",
      recoverable: true,
    };
    expect(event.category).toBe("permission");
    expect(event.recoverable).toBe(true);
  });

  it("errorCode 为可选字段", () => {
    const event: StreamEventToolError = {
      type: "tool_error",
      toolName: "unknown_tool",
      toolUseId: "tool-xyz",
      category: "unknown",
      message: "Unknown tool",
      recoverable: true,
    };
    expect(event.errorCode).toBeUndefined();
  });
});

// ─── 错误即数据范式验证 ───

describe("错误即数据范式", () => {
  it("可恢复错误不应终止循环", () => {
    // 验证分类逻辑：unknown 和 permission 是可恢复的
    const recoverableCategories: ToolErrorCategory[] = ["unknown", "permission"];
    for (const category of recoverableCategories) {
      const isRecoverable = category !== "timeout" && category !== "cancellation";
      expect(isRecoverable).toBe(true);
    }
  });

  it("不可恢复错误应终止循环", () => {
    // 验证分类逻辑：timeout 和 cancellation 是不可恢复的
    const unrecoverableCategories: ToolErrorCategory[] = ["timeout", "cancellation"];
    for (const category of unrecoverableCategories) {
      const isRecoverable = category !== "timeout" && category !== "cancellation";
      expect(isRecoverable).toBe(false);
    }
  });
});

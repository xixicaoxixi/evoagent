/**
 * Session C.3 测试 — 权限审计日志（环形缓冲区 + 慢决策检测）。
 *
 * 覆盖：
 * - RingBuffer 基本操作（push/toArray/size/isFull）
 * - RingBuffer 环形覆盖（满时覆盖最旧元素）
 * - PermissionAuditLog.record 记录审计事件
 * - 慢决策检测（>500ms 记录 warn 日志）
 * - getEntriesForTool / getEntriesSince / getDenials / getSlowDecisions
 * - 集成到 permission-chain（auditLog 配置）
 */

import { describe, expect, it, beforeEach } from "vitest";
import { RingBuffer, PermissionAuditLog } from "../../src/tools/permission-audit";
import { evaluateToolAccess, type PermissionChainConfig } from "../../src/tools/permission-chain";
import type { Tool, ToolUseContext } from "../../src/interfaces/tool";
import type { PermissionResult } from "../../src/types/permission";
import { isDenied } from "../../src/types/permission";

// ─── Mock Tool ───

function createMockTool(options?: {
  readonly checkPermissionsResult?: PermissionResult;
}): Tool {
  return {
    name: "test_tool",
    description: "A test tool",
    inputSchema: {} as any,
    maxResultSizeChars: 10000,
    call: async () => ({ content: "ok", isError: false }),
    checkPermissions: async () =>
      options?.checkPermissionsResult ?? { behavior: "allow" as const },
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
  } as Tool;
}

const mockContext: ToolUseContext = {
  cwd: "/test",
  getAppState: () => ({}),
};

// ═══════════════════════════════════════════
// RingBuffer
// ═══════════════════════════════════════════

describe("RingBuffer", () => {
  it("应正确添加和读取元素", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
    expect(buf.size).toBe(3);
  });

  it("满时应覆盖最旧元素", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // 覆盖 1
    expect(buf.toArray()).toEqual([2, 3, 4]);
    expect(buf.size).toBe(3);
  });

  it("连续覆盖应保持正确顺序", () => {
    const buf = new RingBuffer<number>(2);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    buf.push(5);
    expect(buf.toArray()).toEqual([4, 5]);
  });

  it("isFull 应正确反映状态", () => {
    const buf = new RingBuffer<number>(2);
    expect(buf.isFull).toBe(false);
    buf.push(1);
    expect(buf.isFull).toBe(false);
    buf.push(2);
    expect(buf.isFull).toBe(true);
    buf.push(3);
    expect(buf.isFull).toBe(true);
  });

  it("空缓冲区应返回空数组", () => {
    const buf = new RingBuffer<string>(5);
    expect(buf.toArray()).toEqual([]);
    expect(buf.size).toBe(0);
  });

  it("capacity=1 应只保留最后一个元素", () => {
    const buf = new RingBuffer<number>(1);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([3]);
    expect(buf.size).toBe(1);
  });
});

// ═══════════════════════════════════════════
// PermissionAuditLog
// ═══════════════════════════════════════════

describe("PermissionAuditLog", () => {
  let logEntries: Array<{ level: string; message: string; fields: Record<string, unknown> }>;
  let auditLog: PermissionAuditLog;

  beforeEach(() => {
    logEntries = [];
    auditLog = new PermissionAuditLog({
      bufferCapacity: 100,
      slowDecisionThresholdMs: 500,
    });
  });

  it("record 应添加审计记录", () => {
    const entry = auditLog.createEntry({
      toolName: "bash",
      decision: "deny",
      verdictPhase: "matchedDenyRule",
      reason: "Blocked by rule",
      durationMs: 10,
    });
    auditLog.record(entry);
    expect(auditLog.size).toBe(1);
    expect(auditLog.getEntries()[0]?.toolName).toBe("bash");
  });

  it("getEntriesForTool 应过滤指定工具", () => {
    auditLog.record(auditLog.createEntry({ toolName: "bash", decision: "deny", verdictPhase: "test", reason: "r", durationMs: 10 }));
    auditLog.record(auditLog.createEntry({ toolName: "file_read", decision: "allow", verdictPhase: "test", reason: "r", durationMs: 5 }));
    auditLog.record(auditLog.createEntry({ toolName: "bash", decision: "deny", verdictPhase: "test", reason: "r2", durationMs: 8 }));

    const bashEntries = auditLog.getEntriesForTool("bash");
    expect(bashEntries).toHaveLength(2);
    expect(bashEntries.every((e) => e.toolName === "bash")).toBe(true);
  });

  it("getDenials 应只返回拒绝记录", () => {
    auditLog.record(auditLog.createEntry({ toolName: "bash", decision: "deny", verdictPhase: "test", reason: "r", durationMs: 10 }));
    auditLog.record(auditLog.createEntry({ toolName: "file_read", decision: "allow", verdictPhase: "test", reason: "r", durationMs: 5 }));
    auditLog.record(auditLog.createEntry({ toolName: "file_edit", decision: "ask_user", verdictPhase: "test", reason: "r", durationMs: 8 }));

    const denials = auditLog.getDenials();
    expect(denials).toHaveLength(1);
    expect(denials[0]?.toolName).toBe("bash");
  });

  it("getSlowDecisions 应只返回慢决策记录", () => {
    auditLog.record(auditLog.createEntry({ toolName: "bash", decision: "deny", verdictPhase: "test", reason: "r", durationMs: 100 }));
    auditLog.record(auditLog.createEntry({ toolName: "bash", decision: "deny", verdictPhase: "test", reason: "r", durationMs: 600 }));
    auditLog.record(auditLog.createEntry({ toolName: "file_read", decision: "allow", verdictPhase: "test", reason: "r", durationMs: 500 }));

    const slow = auditLog.getSlowDecisions();
    expect(slow).toHaveLength(1);
    expect(slow[0]?.durationMs).toBe(600);
  });

  it("getEntriesSince 应过滤时间范围", () => {
    const now = Date.now();
    auditLog.record(auditLog.createEntry({ toolName: "bash", decision: "deny", verdictPhase: "test", reason: "r", durationMs: 10 }));
    // 手动设置旧时间戳
    const entries = auditLog.getEntries();
    if (entries[0]) {
      (entries[0] as any).timestamp = now - 10000;
    }

    const recent = auditLog.getEntriesSince(now - 5000);
    expect(recent).toHaveLength(0);
  });

  it("环形缓冲区满时应覆盖最旧记录", () => {
    const smallLog = new PermissionAuditLog({ bufferCapacity: 3 });
    for (let i = 0; i < 5; i++) {
      smallLog.record(smallLog.createEntry({
        toolName: `tool_${i}`,
        decision: "allow",
        verdictPhase: "test",
        reason: `r${i}`,
        durationMs: i,
      }));
    }
    expect(smallLog.size).toBe(3);
    const entries = smallLog.getEntries();
    // 应保留最后 3 个
    expect(entries[0]?.toolName).toBe("tool_2");
    expect(entries[1]?.toolName).toBe("tool_3");
    expect(entries[2]?.toolName).toBe("tool_4");
  });
});

// ═══════════════════════════════════════════
// 集成到 permission-chain
// ═══════════════════════════════════════════

describe("集成到 permission-chain", () => {
  it("evaluateToolAccess 应记录审计日志", async () => {
    const auditLog = new PermissionAuditLog({ bufferCapacity: 100 });
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, {
      auditLog,
    });

    expect(auditLog.size).toBe(1);
    const entry = auditLog.getEntries()[0];
    expect(entry?.toolName).toBe("test_tool");
    expect(entry?.verdictPhase).toBe(result.verdict.phase);
    expect(entry?.durationMs).toBe(result.durationMs);
  });

  it("deny 决策应记录 decision=deny", async () => {
    const auditLog = new PermissionAuditLog({ bufferCapacity: 100 });
    const tool = createMockTool({
      checkPermissionsResult: { behavior: "deny", reason: "Tool denied" },
    });
    await evaluateToolAccess("test_tool", {}, tool, mockContext, { auditLog });

    const entry = auditLog.getEntries()[0];
    expect(entry?.decision).toBe("deny");
  });

  it("allow 决策应记录 decision=allow", async () => {
    const auditLog = new PermissionAuditLog({ bufferCapacity: 100 });
    const tool = createMockTool();
    await evaluateToolAccess("test_tool", {}, tool, mockContext, {
      auditLog,
      overrideMode: true,
    });

    const entry = auditLog.getEntries()[0];
    expect(entry?.decision).toBe("allow");
  });

  it("多次调用应累积审计记录", async () => {
    const auditLog = new PermissionAuditLog({ bufferCapacity: 100 });
    const tool = createMockTool();

    await evaluateToolAccess("tool_a", {}, tool, mockContext, { auditLog });
    await evaluateToolAccess("tool_b", {}, tool, mockContext, { auditLog });
    await evaluateToolAccess("tool_c", {}, tool, mockContext, { auditLog });

    expect(auditLog.size).toBe(3);
    expect(auditLog.getEntriesForTool("tool_a")).toHaveLength(1);
    expect(auditLog.getEntriesForTool("tool_b")).toHaveLength(1);
    expect(auditLog.getEntriesForTool("tool_c")).toHaveLength(1);
  });

  it("未配置 auditLog 时不应报错", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext);
    expect(result).toBeDefined();
  });
});

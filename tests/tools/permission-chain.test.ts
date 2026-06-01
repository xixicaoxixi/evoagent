/**
 * Session C.1 测试 — 多步权限检查链。
 *
 * 覆盖：
 * - Phase 1.1: Deny 规则匹配（override-proof，优先于一切）
 * - Phase 1.2: Ask 规则匹配
 * - Phase 1.3: 工具 checkPermissions
 * - Phase 1.4: 工具返回 deny
 * - Phase 1.5: requiresUserInteraction
 * - Phase 1.6: 内容安全检查（override-proof）
 * - Phase 1.7: 安全检查（override-proof）
 * - Phase 2.1: Override 模式
 * - Phase 2.2: Allow 规则
 * - Phase 3: 默认 ask（Fail-Closed）
 * - Plan 模式硬权限集成
 * - 规则优先级排序
 */

import { describe, expect, it } from "vitest";
import { evaluateToolAccess, type PermissionChainConfig } from "../../src/tools/permission-chain";
import type { Tool, ToolUseContext } from "../../src/interfaces/tool";
import type { PermissionResult, PermissionRule } from "../../src/types/permission";
import { isDenied, isAskUser, isAllowed, isOverrideProof } from "../../src/types/permission";
import {
  createInitialModeContext,
  switchAgentMode,
  type AgentModeContext,
} from "../../src/types/mode";

// ─── Mock Tool ───

function createMockTool(options?: {
  readonly checkPermissionsResult?: PermissionResult;
  readonly checkPermissionsError?: Error;
}): Tool {
  return {
    name: "test_tool",
    description: "A test tool",
    inputSchema: {} as any,
    maxResultSizeChars: 10000,
    call: async () => ({ content: "ok", isError: false }),
    checkPermissions: async () =>
      options?.checkPermissionsError
        ? Promise.reject(options.checkPermissionsError)
        : (options?.checkPermissionsResult ?? { behavior: "allow" as const }),
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
// Phase 1.1: Deny 规则（override-proof）
// ═══════════════════════════════════════════

describe("Phase 1.1: Deny 规则", () => {
  it("匹配的 deny 规则应返回 deny", async () => {
    const rules: readonly PermissionRule[] = [
      { id: "r1", behavior: "deny", pattern: "test_tool", reason: "Test deny" },
    ];
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, { rules });

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("matchedDenyRule");
    expect(result.verdict.reason).toBe("Test deny");
  });

  it("deny 规则应优先于工具的 allow 返回", async () => {
    const rules: readonly PermissionRule[] = [
      { id: "r1", behavior: "deny", pattern: "test_tool", reason: "Blocked by rule" },
    ];
    const tool = createMockTool({ checkPermissionsResult: { behavior: "allow" } });
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, { rules });

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("matchedDenyRule");
  });

  it("deny 规则应优先于 override 模式", async () => {
    const rules: readonly PermissionRule[] = [
      { id: "r1", behavior: "deny", pattern: "test_tool", reason: "Override-proof deny" },
    ];
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, {
      rules,
      overrideMode: true,
    });

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("matchedDenyRule");
  });

  it("通配符 deny 规则应匹配所有工具", async () => {
    const rules: readonly PermissionRule[] = [
      { id: "r1", behavior: "deny", pattern: "*", reason: "All blocked" },
    ];
    const tool = createMockTool();
    const result = await evaluateToolAccess("any_tool", {}, tool, mockContext, { rules });

    expect(isDenied(result.result)).toBe(true);
  });
});

// ═══════════════════════════════════════════
// Phase 1.2: Ask 规则
// ═══════════════════════════════════════════

describe("Phase 1.2: Ask 规则", () => {
  it("匹配的 ask 规则应返回 ask_user", async () => {
    const rules: readonly PermissionRule[] = [
      { id: "r1", behavior: "ask", pattern: "test_tool", reason: "Needs review" },
    ];
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, { rules });

    expect(isAskUser(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("matchedAskRule");
  });
});

// ═══════════════════════════════════════════
// Phase 1.3-1.5: 工具自身检查
// ═══════════════════════════════════════════

describe("Phase 1.3-1.5: 工具自身检查", () => {
  it("工具返回 deny 应产生 toolDeny 判定", async () => {
    const tool = createMockTool({
      checkPermissionsResult: { behavior: "deny", reason: "Tool denied" },
    });
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext);

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("toolDeny");
    expect(result.verdict.reason).toBe("Tool denied");
  });

  it("工具返回 ask_user 应产生 requiresUserInteraction 判定", async () => {
    const tool = createMockTool({
      checkPermissionsResult: { behavior: "ask_user", reason: "Tool asks user" },
    });
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext);

    expect(isAskUser(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("requiresUserInteraction");
  });

  it("工具 checkPermissions 异常应 Fail-Closed 为 ask", async () => {
    const tool = createMockTool({
      checkPermissionsError: new Error("Permission check crashed"),
    });
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext);

    expect(isAskUser(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("toolSelfCheck");
  });
});

// ═══════════════════════════════════════════
// Phase 1.6-1.7: 安全检查（override-proof）
// ═══════════════════════════════════════════

describe("Phase 1.6-1.7: 安全检查", () => {
  it("内容安全检查返回 deny 应产生 contentSafetyAsk 判定", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, {
      contentSafetyCheck: () => ({ behavior: "deny", reason: "Dangerous content" }),
    });

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("contentSafetyAsk");
  });

  it("安全检查返回 ask 应产生 safetyCheck 判定", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, {
      safetyCheck: () => ({ behavior: "ask_user", reason: "Sensitive path" }),
    });

    expect(isAskUser(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("safetyCheck");
  });

  it("安全检查应 override-proof（不受 override 模式影响）", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, {
      safetyCheck: () => ({ behavior: "deny", reason: "Safety blocked" }),
      overrideMode: true,
    });

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("safetyCheck");
  });

  it("安全检查返回 undefined 应跳过", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, {
      safetyCheck: () => undefined,
    });

    // 应继续到 Phase 3（默认 ask）
    expect(result.verdict.phase).toBe("defaultAsk");
  });
});

// ═══════════════════════════════════════════
// Phase 2.1: Override 模式
// ═══════════════════════════════════════════

describe("Phase 2.1: Override 模式", () => {
  it("override 模式应返回 allow", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, {
      overrideMode: true,
    });

    expect(isAllowed(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("overrideMode");
  });

  it("override 模式不应用于 override-proof 判定", async () => {
    const rules: readonly PermissionRule[] = [
      { id: "r1", behavior: "deny", pattern: "test_tool", reason: "Override-proof" },
    ];
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, {
      rules,
      overrideMode: true,
    });

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("matchedDenyRule");
  });
});

// ═══════════════════════════════════════════
// Phase 2.2: Allow 规则
// ═══════════════════════════════════════════

describe("Phase 2.2: Allow 规则", () => {
  it("匹配的 allow 规则应返回 allow", async () => {
    const rules: readonly PermissionRule[] = [
      { id: "r1", behavior: "allow", pattern: "test_tool", reason: "Allowed" },
    ];
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, { rules });

    expect(isAllowed(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("matchedAllowRule");
  });
});

// ═══════════════════════════════════════════
// Phase 3: 默认 ask（Fail-Closed）
// ═══════════════════════════════════════════

describe("Phase 3: 默认 ask", () => {
  it("无规则匹配时应返回 ask（Fail-Closed）", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext);

    expect(isAskUser(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("defaultAsk");
  });
});

// ═══════════════════════════════════════════
// Plan 模式集成
// ═══════════════════════════════════════════

describe("Plan 模式集成", () => {
  it("Plan 模式下写入工具应被拦截", async () => {
    const modeCtx = switchAgentMode(createInitialModeContext("default"), "plan", {
      restrictions: [
        { toolId: "file_write", restriction: "Plan 模式限制", origin: "plan-mode" },
      ],
    });
    const tool = createMockTool();
    tool.name = "file_write";
    const result = await evaluateToolAccess("file_write", {}, tool, mockContext, {
      modeContext: modeCtx,
    });

    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("safetyCheck");
  });

  it("Plan 模式下只读工具应放行到后续检查", async () => {
    const modeCtx = switchAgentMode(createInitialModeContext("default"), "plan");
    const tool = createMockTool();
    tool.name = "file_read";
    const result = await evaluateToolAccess("file_read", {}, tool, mockContext, {
      modeContext: modeCtx,
    });

    // Plan 模式不拦截 file_read → 继续到 Phase 3（默认 ask）
    expect(result.verdict.phase).toBe("defaultAsk");
  });
});

// ═══════════════════════════════════════════
// 规则优先级
// ═══════════════════════════════════════════

describe("规则优先级", () => {
  it("deny 规则优先于 ask 规则", async () => {
    const rules: readonly PermissionRule[] = [
      { id: "r1", behavior: "ask", pattern: "test_tool", reason: "Ask first" },
      { id: "r2", behavior: "deny", pattern: "test_tool", reason: "Deny overrides" },
    ];
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, { rules });

    // deny 规则先于 ask 规则检查
    expect(isDenied(result.result)).toBe(true);
    expect(result.verdict.phase).toBe("matchedDenyRule");
  });

  it("deny 规则优先于 allow 规则", async () => {
    const rules: readonly PermissionRule[] = [
      { id: "r1", behavior: "allow", pattern: "test_tool", reason: "Allow" },
      { id: "r2", behavior: "deny", pattern: "test_tool", reason: "Deny" },
    ];
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, { rules });

    expect(isDenied(result.result)).toBe(true);
  });

  it("不匹配的规则应跳过", async () => {
    const rules: readonly PermissionRule[] = [
      { id: "r1", behavior: "deny", pattern: "other_tool", reason: "Other blocked" },
    ];
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext, { rules });

    // 不匹配 → Phase 3 默认 ask
    expect(result.verdict.phase).toBe("defaultAsk");
  });
});

// ═══════════════════════════════════════════
// isOverrideProof
// ═══════════════════════════════════════════

describe("isOverrideProof", () => {
  it("matchedDenyRule 是 override-proof", () => {
    expect(isOverrideProof({ phase: "matchedDenyRule", reason: "test" })).toBe(true);
  });

  it("contentSafetyAsk 是 override-proof", () => {
    expect(isOverrideProof({ phase: "contentSafetyAsk", reason: "test" })).toBe(true);
  });

  it("safetyCheck 是 override-proof", () => {
    expect(isOverrideProof({ phase: "safetyCheck", reason: "test" })).toBe(true);
  });

  it("overrideMode 不是 override-proof", () => {
    expect(isOverrideProof({ phase: "overrideMode", reason: "test" })).toBe(false);
  });

  it("matchedAllowRule 不是 override-proof", () => {
    expect(isOverrideProof({ phase: "matchedAllowRule", reason: "test" })).toBe(false);
  });

  it("defaultAsk 不是 override-proof", () => {
    expect(isOverrideProof({ phase: "defaultAsk", reason: "test" })).toBe(false);
  });
});

// ═══════════════════════════════════════════
// durationMs
// ═══════════════════════════════════════════

describe("durationMs", () => {
  it("应记录检查耗时", async () => {
    const tool = createMockTool();
    const result = await evaluateToolAccess("test_tool", {}, tool, mockContext);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe("number");
  });
});

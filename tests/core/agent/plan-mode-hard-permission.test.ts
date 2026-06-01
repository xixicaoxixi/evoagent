/**
 * Session B.2 + B.3 测试 — Plan 模式硬权限 + 审批流程。
 *
 * B.2 覆盖：
 * - checkPlanModePermission 在 Plan 模式下拦截写入类工具
 * - 非 Plan 模式下放行所有工具
 * - restrictedAbilities 驱动的权限决策
 *
 * B.3 覆盖：
 * - submitForApproval 两阶段提交
 * - confirmApproval 正常/过期/重复/无效票据
 * - isApprovalValid 有效性检查
 * - PlanModeManager 完整流程
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  createPlanModeManager,
  checkPlanModePermission,
  type ExecutionPlanResult,
  type PlanStep,
  type PlanConfirmation,
} from "../../../src/core/agent/plan-mode";
import {
  createInitialModeContext,
  switchAgentMode,
  type AgentModeContext,
  type RestrictedAbility,
} from "../../../src/types/mode";
import { EvoAgentError } from "../../../src/utils/errors";
import { isDenied } from "../../../src/types/permission";

// ─── 测试数据 ───

const sampleSteps: readonly PlanStep[] = [
  {
    id: "1",
    description: "Add error handling to executor",
    files: ["src/tools/executor.ts"],
    risk: "low",
    reason: "Adding try-catch blocks",
  },
  {
    id: "2",
    description: "Refactor query loop",
    files: ["src/core/query/loop.ts", "src/core/query/types.ts"],
    risk: "medium",
    reason: "Restructuring control flow",
  },
];

const samplePlan: ExecutionPlanResult = {
  steps: sampleSteps,
  summary: "Improve error handling in tool executor",
  totalRisk: "medium",
  affectedFiles: ["src/tools/executor.ts", "src/core/query/loop.ts", "src/core/query/types.ts"],
  createdAt: Date.now(),
};

const planModeRestrictions: readonly RestrictedAbility[] = [
  { toolId: "file_write", restriction: "Plan 模式下禁止文件写入", origin: "plan-mode" },
  { toolId: "file_edit", restriction: "Plan 模式下禁止文件编辑", origin: "plan-mode" },
  { toolId: "bash", restriction: "Plan 模式下禁止命令执行", origin: "plan-mode" },
  { toolId: "execute_command", restriction: "Plan 模式下禁止命令执行", origin: "plan-mode" },
  { toolId: "delete_file", restriction: "Plan 模式下禁止文件删除", origin: "plan-mode" },
  { toolId: "create_directory", restriction: "Plan 模式下禁止目录创建", origin: "plan-mode" },
];

function createPlanModeContext(): AgentModeContext {
  return switchAgentMode(
    createInitialModeContext("default"),
    "plan",
    { restrictions: planModeRestrictions },
  );
}

// ═══════════════════════════════════════════
// B.2: 硬权限检查
// ═══════════════════════════════════════════

describe("B.2: checkPlanModePermission", () => {
  it("Plan 模式下 file_write 被拦截", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "file_write");
    expect(isDenied(result)).toBe(true);
    if (isDenied(result)) {
      expect(result.reason).toContain("Plan 模式限制");
    }
  });

  it("Plan 模式下 file_edit 被拦截", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "file_edit");
    expect(isDenied(result)).toBe(true);
  });

  it("Plan 模式下 bash 被拦截", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "bash");
    expect(isDenied(result)).toBe(true);
  });

  it("Plan 模式下 execute_command 被拦截", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "execute_command");
    expect(isDenied(result)).toBe(true);
  });

  it("Plan 模式下 delete_file 被拦截", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "delete_file");
    expect(isDenied(result)).toBe(true);
  });

  it("Plan 模式下 create_directory 被拦截", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "create_directory");
    expect(isDenied(result)).toBe(true);
  });

  it("Plan 模式下 file_read 放行", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "file_read");
    expect(result.behavior).toBe("allow");
  });

  it("Plan 模式下 glob 放行", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "glob");
    expect(result.behavior).toBe("allow");
  });

    it("Plan 模式下 MCP 工具放行", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "mcp__custom_tool");
    expect(result.behavior).toBe("allow");
  });

  it("非 Plan 模式下所有工具放行", () => {
    const ctx = createInitialModeContext("default");
    const result = checkPlanModePermission(ctx, "file_write");
    expect(result.behavior).toBe("allow");
  });

  it("非 Plan 模式下 bash 放行", () => {
    const ctx = createInitialModeContext("default");
    const result = checkPlanModePermission(ctx, "bash");
    expect(result.behavior).toBe("allow");
  });

  it("restrictedAbilities 中的工具被拦截（即使不在黑名单中）", () => {
    const ctx = switchAgentMode(createInitialModeContext("default"), "plan", {
      restrictions: [
        { toolId: "custom_tool", restriction: "自定义限制", origin: "test" },
      ],
    });
    const result = checkPlanModePermission(ctx, "custom_tool");
    expect(isDenied(result)).toBe(true);
    if (isDenied(result)) {
      expect(result.reason).toContain("自定义限制");
    }
  });
});

// ═══════════════════════════════════════════
// B.3: 审批流程
// ═══════════════════════════════════════════

describe("B.3: submitForApproval", () => {
  it("应创建 pending 状态的审批票据", () => {
    const manager = createPlanModeManager({ enabled: true });
    const ticket = manager.submitForApproval(samplePlan);

    expect(ticket.state).toBe("pending");
    expect(ticket.plan).toBe(samplePlan);
    expect(ticket.planId).toMatch(/^plan-\d+-[a-z0-9]+$/);
    expect(ticket.createdAt).toBeLessThanOrEqual(Date.now());
    expect(ticket.expiresAt).toBeGreaterThan(Date.now());
  });

  it("应可通过 getCurrentTicket 获取当前票据", () => {
    const manager = createPlanModeManager({ enabled: true });
    const ticket = manager.submitForApproval(samplePlan);
    const current = manager.getCurrentTicket();

    expect(current).toBeDefined();
    expect(current?.planId).toBe(ticket.planId);
  });

  it("未提交时 getCurrentTicket 返回 undefined", () => {
    const manager = createPlanModeManager({ enabled: true });
    expect(manager.getCurrentTicket()).toBeUndefined();
  });
});

describe("B.3: confirmApproval", () => {
  it("approve 应更新票据状态为 approved", () => {
    const manager = createPlanModeManager({ enabled: true });
    const ticket = manager.submitForApproval(samplePlan);
    const confirmed = manager.confirmApproval(ticket.planId, { status: "approved" });

    expect(confirmed.state).toBe("approved");
    expect(confirmed.confirmation?.status).toBe("approved");
  });

  it("reject 应更新票据状态为 rejected", () => {
    const manager = createPlanModeManager({ enabled: true });
    const ticket = manager.submitForApproval(samplePlan);
    const confirmed = manager.confirmApproval(ticket.planId, {
      status: "rejected",
      feedback: "Too risky",
    });

    expect(confirmed.state).toBe("rejected");
    expect(confirmed.confirmation?.feedback).toBe("Too risky");
  });

  it("无效票据 ID 应抛出错误", () => {
    const manager = createPlanModeManager({ enabled: true });
    manager.submitForApproval(samplePlan);

    try {
      manager.confirmApproval("invalid-ticket-id", { status: "approved" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvoAgentError);
      expect((e as EvoAgentError).code).toBe("INVALID_APPROVAL_TICKET");
    }
  });

  it("重复确认应抛出错误", () => {
    const manager = createPlanModeManager({ enabled: true });
    const ticket = manager.submitForApproval(samplePlan);
    manager.confirmApproval(ticket.planId, { status: "approved" });

    try {
      manager.confirmApproval(ticket.planId, { status: "approved" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvoAgentError);
      expect((e as EvoAgentError).code).toBe("APPROVAL_ALREADY_PROCESSED");
    }
  });

  it("过期票据应抛出错误", () => {
    const manager = createPlanModeManager({ enabled: true });
    const ticket = manager.submitForApproval(samplePlan, { timeoutMs: 0 });

    // 等待 1ms 确保过期
    const wait = new Promise<void>((resolve) => setTimeout(resolve, 2));

    return wait.then(() => {
      try {
        manager.confirmApproval(ticket.planId, { status: "approved" });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(EvoAgentError);
        expect((e as EvoAgentError).code).toBe("APPROVAL_EXPIRED");
      }
    });
  });
});

describe("B.3: isApprovalValid", () => {
  it("approved 且未过期的票据有效", () => {
    const manager = createPlanModeManager({ enabled: true });
    const ticket = manager.submitForApproval(samplePlan, { timeoutMs: 60_000 });
    const confirmed = manager.confirmApproval(ticket.planId, { status: "approved" });

    expect(manager.isApprovalValid(confirmed)).toBe(true);
  });

  it("rejected 票据无效", () => {
    const manager = createPlanModeManager({ enabled: true });
    const ticket = manager.submitForApproval(samplePlan);
    const confirmed = manager.confirmApproval(ticket.planId, { status: "rejected" });

    expect(manager.isApprovalValid(confirmed)).toBe(false);
  });

  it("pending 票据无效", () => {
    const manager = createPlanModeManager({ enabled: true });
    const ticket = manager.submitForApproval(samplePlan);

    expect(manager.isApprovalValid(ticket)).toBe(false);
  });
});

// ═══════════════════════════════════════════
// PlanModeManager 完整流程
// ═══════════════════════════════════════════

describe("PlanModeManager 完整流程", () => {
  it("isActive 应反映配置", () => {
    const enabled = createPlanModeManager({ enabled: true });
    const disabled = createPlanModeManager({ enabled: false });

    expect(enabled.isActive).toBe(true);
    expect(disabled.isActive).toBe(false);
  });

  it("assessRisk 正确评估", () => {
    const manager = createPlanModeManager({ enabled: true });

    expect(manager.assessRisk([])).toBe("low");
    expect(manager.assessRisk([{ id: "1", description: "t", files: [], risk: "low", reason: "r" }])).toBe("low");
    expect(manager.assessRisk([
      { id: "1", description: "t", files: [], risk: "low", reason: "r" },
      { id: "2", description: "t", files: [], risk: "medium", reason: "r" },
    ])).toBe("medium");
    expect(manager.assessRisk([
      { id: "1", description: "t", files: [], risk: "high", reason: "r" },
    ])).toBe("high");
  });

  it("formatPlanOutput 应包含计划信息", () => {
    const manager = createPlanModeManager({ enabled: true });
    const output = manager.formatPlanOutput(samplePlan);

    expect(output).toContain("Execution Plan");
    expect(output).toContain(samplePlan.summary);
    expect(output).toContain("Step 1");
    expect(output).toContain("Step 2");
    expect(output).toContain("Waiting for confirmation");
  });

  it("autoApprove 应直接返回 approved", async () => {
    const manager = createPlanModeManager({ enabled: true, autoApprove: true });
    const confirmation = await manager.waitForConfirmation(samplePlan);
    expect(confirmation.status).toBe("approved");
  });

  it("onPlanGenerated 回调应被调用", async () => {
    const manager = createPlanModeManager({
      enabled: true,
      onPlanGenerated: async (plan) => {
        return { status: "approved", feedback: "Looks good" };
      },
    });
    const confirmation = await manager.waitForConfirmation(samplePlan);
    expect(confirmation.status).toBe("approved");
    expect(confirmation.feedback).toBe("Looks good");
  });

  it("完整流程: Plan → Submit → Approve → Execute", () => {
    const manager = createPlanModeManager({ enabled: true });
    const modeCtx = createPlanModeContext();

    // 1. Plan 模式下写入工具被拦截
    const perm = manager.checkPermission(modeCtx, "file_write");
    expect(isDenied(perm)).toBe(true);

    // 2. 只读工具放行
    const readPerm = manager.checkPermission(modeCtx, "file_read");
    expect(readPerm.behavior).toBe("allow");

    // 3. 提交审批
    const ticket = manager.submitForApproval(samplePlan);
    expect(ticket.state).toBe("pending");

    // 4. 确认审批
    const confirmed = manager.confirmApproval(ticket.planId, { status: "approved" });
    expect(confirmed.state).toBe("approved");
    expect(manager.isApprovalValid(confirmed)).toBe(true);
  });
});

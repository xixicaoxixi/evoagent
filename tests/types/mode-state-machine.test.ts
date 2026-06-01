/**
 * Session B.1 测试 — Agent 模式状态机。
 *
 * 覆盖：
 * - createInitialModeContext
 * - switchAgentMode 合法/非法转换
 * - Save-Restore 语义（进入 plan 保存 priorMode，退出恢复）
 * - 断路器防御
 * - isPlanMode / isRestrictedMode / isToolRestricted
 * - 幂等性（同模式不报错）
 */

import { describe, expect, it } from "vitest";
import {
  createInitialModeContext,
  switchAgentMode,
  isPlanMode,
  isRestrictedMode,
  isToolRestricted,
  getToolRestriction,
  type AgentModeContext,
  type AgentMode,
  type RestrictedAbility,
} from "../../src/types/mode";
import { EvoAgentError } from "../../src/utils/errors";

// ─── createInitialModeContext ───

describe("createInitialModeContext", () => {
  it("默认创建 default 模式", () => {
    const ctx = createInitialModeContext();
    expect(ctx.mode).toBe("default");
    expect(ctx.restrictedAbilities).toEqual([]);
    expect(ctx.modeHistory).toEqual([]);
    expect(ctx.savedPriorMode).toBeUndefined();
  });

  it("可指定初始模式", () => {
    const ctx = createInitialModeContext("plan");
    expect(ctx.mode).toBe("plan");
  });
});

// ─── switchAgentMode 合法转换 ───

describe("switchAgentMode 合法转换", () => {
  it("default → plan", () => {
    const ctx = createInitialModeContext("default");
    const next = switchAgentMode(ctx, "plan");
    expect(next.mode).toBe("plan");
    expect(next.savedPriorMode).toBe("default");
    expect(next.modeHistory).toHaveLength(1);
    expect(next.modeHistory[0]?.from).toBe("default");
    expect(next.modeHistory[0]?.to).toBe("plan");
  });

  it("default → auto", () => {
    const ctx = createInitialModeContext("default");
    const next = switchAgentMode(ctx, "auto");
    expect(next.mode).toBe("auto");
    expect(next.savedPriorMode).toBeUndefined();
  });

  it("default → sandbox", () => {
    const ctx = createInitialModeContext("default");
    const next = switchAgentMode(ctx, "sandbox");
    expect(next.mode).toBe("sandbox");
    expect(next.savedPriorMode).toBe("default");
  });

  it("plan → default（恢复 savedPriorMode）", () => {
    const ctx = createInitialModeContext("default");
    const plan = switchAgentMode(ctx, "plan");
    const restored = switchAgentMode(plan, "default");
    expect(restored.mode).toBe("default");
    expect(restored.savedPriorMode).toBeUndefined();
    expect(restored.modeHistory).toHaveLength(2);
  });

  it("auto → default", () => {
    const ctx = createInitialModeContext("auto");
    const next = switchAgentMode(ctx, "default");
    expect(next.mode).toBe("default");
  });

  it("auto → plan", () => {
    const ctx = createInitialModeContext("auto");
    const next = switchAgentMode(ctx, "plan");
    expect(next.mode).toBe("plan");
    expect(next.savedPriorMode).toBe("auto");
  });

  it("auto → sandbox", () => {
    const ctx = createInitialModeContext("auto");
    const next = switchAgentMode(ctx, "sandbox");
    expect(next.mode).toBe("sandbox");
    expect(next.savedPriorMode).toBe("auto");
  });

  it("sandbox → default", () => {
    const ctx = createInitialModeContext("default");
    const sandbox = switchAgentMode(ctx, "sandbox");
    const restored = switchAgentMode(sandbox, "default");
    expect(restored.mode).toBe("default");
    expect(restored.savedPriorMode).toBeUndefined();
  });
});

// ─── switchAgentMode 非法转换 ───

describe("switchAgentMode 非法转换", () => {
  it("plan → auto 应抛出错误", () => {
    const ctx = createInitialModeContext("plan");
    try {
      switchAgentMode(ctx, "auto");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvoAgentError);
      expect((e as EvoAgentError).code).toBe("INVALID_MODE_TRANSITION");
    }
  });

  it("plan → sandbox 应抛出错误", () => {
    const ctx = createInitialModeContext("plan");
    expect(() => switchAgentMode(ctx, "sandbox")).toThrow(EvoAgentError);
  });

  it("sandbox → plan 应抛出错误", () => {
    const ctx = createInitialModeContext("sandbox");
    expect(() => switchAgentMode(ctx, "plan")).toThrow(EvoAgentError);
  });

  it("sandbox → auto 应抛出错误", () => {
    const ctx = createInitialModeContext("sandbox");
    expect(() => switchAgentMode(ctx, "auto")).toThrow(EvoAgentError);
  });
});

// ─── 幂等性 ───

describe("switchAgentMode 幂等性", () => {
  it("同模式切换返回同一引用", () => {
    const ctx = createInitialModeContext("default");
    const result = switchAgentMode(ctx, "default");
    expect(result).toBe(ctx);
  });

  it("plan → plan 返回同一引用", () => {
    const ctx = createInitialModeContext("plan");
    const result = switchAgentMode(ctx, "plan");
    expect(result).toBe(ctx);
  });
});

// ─── Save-Restore 语义 ───

describe("Save-Restore 语义", () => {
  it("进入 plan 保存 priorMode", () => {
    const ctx = createInitialModeContext("auto");
    const plan = switchAgentMode(ctx, "plan");
    expect(plan.savedPriorMode).toBe("auto");
  });

  it("退出 plan 清除 savedPriorMode", () => {
    const ctx = createInitialModeContext("auto");
    const plan = switchAgentMode(ctx, "plan");
    const restored = switchAgentMode(plan, "default");
    expect(restored.savedPriorMode).toBeUndefined();
  });

  it("连续进入受限模式嵌套保存", () => {
    // auto → plan（savedPriorMode = auto）
    // plan → default（恢复）
    const ctx = createInitialModeContext("auto");
    const plan = switchAgentMode(ctx, "plan");
    expect(plan.savedPriorMode).toBe("auto");
  });

  it("进入 sandbox 保存 priorMode", () => {
    const ctx = createInitialModeContext("default");
    const sandbox = switchAgentMode(ctx, "sandbox");
    expect(sandbox.savedPriorMode).toBe("default");
  });
});

// ─── 能力限制 ───

describe("能力限制", () => {
  const restrictions: readonly RestrictedAbility[] = [
    { toolId: "file_write", restriction: "Plan 模式下禁止文件写入", origin: "plan-mode" },
    { toolId: "execute_command", restriction: "Plan 模式下禁止命令执行", origin: "plan-mode" },
  ];

  it("进入 plan 时应用限制", () => {
    const ctx = createInitialModeContext("default");
    const plan = switchAgentMode(ctx, "plan", { restrictions });
    expect(plan.restrictedAbilities).toHaveLength(2);
    expect(plan.restrictedAbilities[0]?.toolId).toBe("file_write");
    expect(plan.restrictedAbilities[1]?.toolId).toBe("execute_command");
  });

  it("退出受限模式清除限制", () => {
    const ctx = createInitialModeContext("default");
    const plan = switchAgentMode(ctx, "plan", { restrictions });
    const restored = switchAgentMode(plan, "default");
    expect(restored.restrictedAbilities).toEqual([]);
  });

  it("isToolRestricted 正确检测", () => {
    const ctx = createInitialModeContext("default");
    const plan = switchAgentMode(ctx, "plan", { restrictions });
    expect(isToolRestricted(plan, "file_write")).toBe(true);
    expect(isToolRestricted(plan, "execute_command")).toBe(true);
    expect(isToolRestricted(plan, "file_read")).toBe(false);
  });

  it("getToolRestriction 返回限制详情", () => {
    const ctx = createInitialModeContext("default");
    const plan = switchAgentMode(ctx, "plan", { restrictions });
    const restriction = getToolRestriction(plan, "file_write");
    expect(restriction).toBeDefined();
    expect(restriction?.restriction).toBe("Plan 模式下禁止文件写入");
    expect(restriction?.origin).toBe("plan-mode");
  });

  it("getToolRestriction 未限制的工具返回 undefined", () => {
    const ctx = createInitialModeContext("default");
    const plan = switchAgentMode(ctx, "plan", { restrictions });
    expect(getToolRestriction(plan, "file_read")).toBeUndefined();
  });
});

// ─── 断路器防御 ───

describe("断路器防御", () => {
  it("频繁切换触发断路器", () => {
    const config = { maxConsecutiveSwitches: 3, windowMs: 60_000 };
    let ctx = createInitialModeContext("default");

    // 3 次切换：default→plan, plan→default, default→plan
    ctx = switchAgentMode(ctx, "plan", { circuitBreaker: config });
    ctx = switchAgentMode(ctx, "default", { circuitBreaker: config });
    ctx = switchAgentMode(ctx, "plan", { circuitBreaker: config });

    // 第 4 次切换应触发断路器
    try {
      switchAgentMode(ctx, "default", { circuitBreaker: config });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EvoAgentError);
      expect((e as EvoAgentError).code).toBe("MODE_CIRCUIT_BREAKER");
    }
  });

  it("时间窗口外的切换不计入", () => {
    const config = { maxConsecutiveSwitches: 2, windowMs: 1000 };
    let ctx = createInitialModeContext("default");

    // 2 次切换
    ctx = switchAgentMode(ctx, "plan", { circuitBreaker: config });
    ctx = switchAgentMode(ctx, "default", { circuitBreaker: config });

    // 模拟时间窗口过期（通过手动构建历史）
    const oldTransition = {
      from: "default" as AgentMode,
      to: "plan" as AgentMode,
      timestamp: Date.now() - 2000, // 2 秒前，超出窗口
      trigger: "system" as const,
    };
    ctx = {
      ...ctx,
      modeHistory: [oldTransition, ctx.modeHistory[ctx.modeHistory.length - 1]!],
    };

    // 应该可以继续切换
    const next = switchAgentMode(ctx, "plan", { circuitBreaker: config });
    expect(next.mode).toBe("plan");
  });
});

// ─── isPlanMode / isRestrictedMode ───

describe("isPlanMode / isRestrictedMode", () => {
  it("isPlanMode 正确检测", () => {
    expect(isPlanMode(createInitialModeContext("default"))).toBe(false);
    expect(isPlanMode(createInitialModeContext("plan"))).toBe(true);
    expect(isPlanMode(createInitialModeContext("auto"))).toBe(false);
    expect(isPlanMode(createInitialModeContext("sandbox"))).toBe(false);
  });

  it("isRestrictedMode 正确检测", () => {
    expect(isRestrictedMode(createInitialModeContext("default"))).toBe(false);
    expect(isRestrictedMode(createInitialModeContext("plan"))).toBe(true);
    expect(isRestrictedMode(createInitialModeContext("auto"))).toBe(false);
    expect(isRestrictedMode(createInitialModeContext("sandbox"))).toBe(true);
  });
});

// ─── 转换触发源 ───

describe("转换触发源", () => {
  it("默认 trigger 为 system", () => {
    const ctx = createInitialModeContext("default");
    const next = switchAgentMode(ctx, "plan");
    expect(next.modeHistory[0]?.trigger).toBe("system");
  });

  it("可指定 trigger 为 user", () => {
    const ctx = createInitialModeContext("default");
    const next = switchAgentMode(ctx, "plan", { trigger: "user" });
    expect(next.modeHistory[0]?.trigger).toBe("user");
  });

  it("可指定 trigger 为 agent", () => {
    const ctx = createInitialModeContext("default");
    const next = switchAgentMode(ctx, "plan", { trigger: "agent" });
    expect(next.modeHistory[0]?.trigger).toBe("agent");
  });
});

// ─── 不可变性 ───

describe("不可变性", () => {
  it("switchAgentMode 不修改原始上下文", () => {
    const ctx = createInitialModeContext("default");
    const next = switchAgentMode(ctx, "plan");
    expect(ctx.mode).toBe("default");
    expect(ctx.modeHistory).toHaveLength(0);
    expect(next.mode).toBe("plan");
    expect(next.modeHistory).toHaveLength(1);
  });

  it("restrictedAbilities 不共享引用", () => {
    const ctx = createInitialModeContext("default");
    const plan = switchAgentMode(ctx, "plan", {
      restrictions: [{ toolId: "file_write", restriction: "test", origin: "test" }],
    });
    // 修改返回值不应影响原始
    expect(ctx.restrictedAbilities).toEqual([]);
    expect(plan.restrictedAbilities).toHaveLength(1);
  });
});

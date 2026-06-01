/**
 * Session B.4 测试 — 编排层集成（SubAgent/Orchestrator/Prompt + AgentModeContext）。
 *
 * 覆盖：
 * - SubAgent.checkModePermission 在 Plan 模式下的权限检查
 * - SubAgent 接受 modeContext 配置
 * - assemblePrompt 在 Plan 模式下注入模式提示
 * - buildModePrompt 为不同模式生成正确提示
 */

import { describe, expect, it } from "vitest";
import {
  createInitialModeContext,
  switchAgentMode,
  type AgentModeContext,
  type RestrictedAbility,
} from "../../../src/types/mode";
import { checkPlanModePermission } from "../../../src/core/agent/plan-mode";
import { assemblePrompt, type PromptConfig } from "../../../src/core/query/prompt";
import { isDenied } from "../../../src/types/permission";

// ─── 测试数据 ───

const planModeRestrictions: readonly RestrictedAbility[] = [
  { toolId: "file_write", restriction: "Plan 模式下禁止文件写入", origin: "plan-mode" },
  { toolId: "bash", restriction: "Plan 模式下禁止命令执行", origin: "plan-mode" },
];

function createPlanModeContext(): AgentModeContext {
  return switchAgentMode(
    createInitialModeContext("default"),
    "plan",
    { restrictions: planModeRestrictions },
  );
}

// ═══════════════════════════════════════════
// SubAgent 模式权限检查
// ═══════════════════════════════════════════

describe("B.4: SubAgent 模式权限检查", () => {
  it("Plan 模式下 file_write 被拦截", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "file_write");
    expect(isDenied(result)).toBe(true);
  });

  it("Plan 模式下 bash 被拦截", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "bash");
    expect(isDenied(result)).toBe(true);
  });

  it("Plan 模式下 file_read 放行", () => {
    const ctx = createPlanModeContext();
    const result = checkPlanModePermission(ctx, "file_read");
    expect(result.behavior).toBe("allow");
  });

  it("default 模式下所有工具放行", () => {
    const ctx = createInitialModeContext("default");
    const result = checkPlanModePermission(ctx, "file_write");
    expect(result.behavior).toBe("allow");
  });

  it("auto 模式下所有工具放行", () => {
    const ctx = createInitialModeContext("auto");
    const result = checkPlanModePermission(ctx, "bash");
    expect(result.behavior).toBe("allow");
  });
});

// ═══════════════════════════════════════════
// assemblePrompt 模式提示注入
// ═══════════════════════════════════════════

describe("B.4: assemblePrompt 模式提示注入", () => {
  it("Plan 模式应注入只读限制提示", () => {
    const ctx = createPlanModeContext();
    const config: PromptConfig = {
      baseSystemPrompt: "You are a helpful assistant.",
      modeContext: ctx,
    };
    const result = assemblePrompt(config);
    expect(result.systemPrompt).toContain("Plan Mode");
    expect(result.systemPrompt).toContain("只读模式");
    expect(result.systemPrompt).toContain("file_read");
    expect(result.systemPrompt).toContain("glob");
  });

  it("Plan 模式应包含限制详情", () => {
    const ctx = createPlanModeContext();
    const config: PromptConfig = {
      baseSystemPrompt: "You are a helpful assistant.",
      modeContext: ctx,
    };
    const result = assemblePrompt(config);
    expect(result.systemPrompt).toContain("file_write");
    expect(result.systemPrompt).toContain("Plan 模式下禁止文件写入");
    expect(result.systemPrompt).toContain("bash");
    expect(result.systemPrompt).toContain("Plan 模式下禁止命令执行");
  });

  it("Plan 模式应提示等待用户确认", () => {
    const ctx = createPlanModeContext();
    const config: PromptConfig = {
      baseSystemPrompt: "You are a helpful assistant.",
      modeContext: ctx,
    };
    const result = assemblePrompt(config);
    expect(result.systemPrompt).toContain("等待用户确认");
  });

  it("Sandbox 模式应注入沙箱限制提示", () => {
    const ctx = switchAgentMode(createInitialModeContext("default"), "sandbox");
    const config: PromptConfig = {
      baseSystemPrompt: "You are a helpful assistant.",
      modeContext: ctx,
    };
    const result = assemblePrompt(config);
    expect(result.systemPrompt).toContain("Sandbox Mode");
    expect(result.systemPrompt).toContain("沙箱模式");
  });

  it("default 模式不应注入额外提示", () => {
    const ctx = createInitialModeContext("default");
    const config: PromptConfig = {
      baseSystemPrompt: "You are a helpful assistant.",
      modeContext: ctx,
    };
    const result = assemblePrompt(config);
    expect(result.systemPrompt).toContain("You are a helpful assistant.");
    expect(result.systemPrompt).not.toContain("Plan Mode");
    expect(result.systemPrompt).not.toContain("Sandbox Mode");
  });

  it("auto 模式不应注入额外提示", () => {
    const ctx = createInitialModeContext("auto");
    const config: PromptConfig = {
      baseSystemPrompt: "You are a helpful assistant.",
      modeContext: ctx,
    };
    const result = assemblePrompt(config);
    expect(result.systemPrompt).toContain("You are a helpful assistant.");
    expect(result.systemPrompt).not.toContain("Plan Mode");
    expect(result.systemPrompt).not.toContain("Sandbox Mode");
  });

  it("无 modeContext 时不应注入额外提示", () => {
    const config: PromptConfig = {
      baseSystemPrompt: "You are a helpful assistant.",
    };
    const result = assemblePrompt(config);
    expect(result.systemPrompt).toContain("You are a helpful assistant.");
    expect(result.systemPrompt).not.toContain("Plan Mode");
    expect(result.systemPrompt).not.toContain("Sandbox Mode");
  });

  it("模式提示应在其他层之后注入", () => {
    const ctx = createPlanModeContext();
    const config: PromptConfig = {
      baseSystemPrompt: "Base prompt",
      appendSystemPrompt: "Additional instructions",
      modeContext: ctx,
    };
    const result = assemblePrompt(config);
    // 基础提示在前，追加提示在中，模式提示在后
    const baseIndex = result.systemPrompt.indexOf("Base prompt");
    const appendIndex = result.systemPrompt.indexOf("Additional instructions");
    const modeIndex = result.systemPrompt.indexOf("Plan Mode");
    expect(baseIndex).toBeLessThan(appendIndex);
    expect(appendIndex).toBeLessThan(modeIndex);
  });

  it("无限制的 Plan 模式仍应注入基本提示", () => {
    const ctx = switchAgentMode(createInitialModeContext("default"), "plan");
    const config: PromptConfig = {
      baseSystemPrompt: "You are a helpful assistant.",
      modeContext: ctx,
    };
    const result = assemblePrompt(config);
    expect(result.systemPrompt).toContain("Plan Mode");
    expect(result.systemPrompt).toContain("只读工具");
  });
});

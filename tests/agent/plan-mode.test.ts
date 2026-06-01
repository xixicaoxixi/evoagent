/**
 * Session B.1 测试 — Plan Mode。
 *
 * 验证 Plan Mode 配置、只读工具过滤器、计划确认机制、格式化输出。
 */

import { describe, expect, it } from "vitest";
import { filterToolsForAgent } from "../../src/core/agent/tool-filter";
import {
  createPlanModeManager,
  type PlanStep,
  type ExecutionPlanResult,
} from "../../src/core/agent/plan-mode";
import type { Tool } from "../../src/interfaces/tool";

// ─── Mock Tools ───

function createMockTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    execute: async () => ({ output: "", error: undefined }),
  };
}

const ALL_TOOLS: Tool[] = [
  createMockTool("file_read"),
  createMockTool("file_write"),
  createMockTool("file_edit"),
  createMockTool("bash"),
  createMockTool("glob"),
    createMockTool("agent"),
  createMockTool("spawn_agent"),
  createMockTool("config_set"),
];

// ─── 测试 ───

describe("Plan Mode 工具过滤", () => {
  it("非 Plan Mode 时保留所有非禁止工具", () => {
    const result = filterToolsForAgent(ALL_TOOLS);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("file_write");
    expect(names).toContain("bash");
    expect(names).toContain("glob");
      });

  it("Plan Mode 下只保留只读工具", () => {
    const result = filterToolsForAgent(ALL_TOOLS, { planMode: true });
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("glob");
        expect(names).not.toContain("file_write");
    expect(names).not.toContain("file_edit");
    expect(names).not.toContain("bash");
  });

  it("Plan Mode 下 file_write 被标记为 plan_mode_readonly", () => {
    const result = filterToolsForAgent(ALL_TOOLS, { planMode: true });
    expect(result.reasons.get("file_write")).toBe("plan_mode_readonly");
    expect(result.reasons.get("bash")).toBe("plan_mode_readonly");
    expect(result.reasons.get("file_edit")).toBe("plan_mode_readonly");
  });

  it("Plan Mode 下 MCP 工具也被过滤（安全优先）", () => {
    const mcpTool = createMockTool("mcp__custom_tool");
    const tools = [...ALL_TOOLS, mcpTool];
    const result = filterToolsForAgent(tools, { planMode: true });
    const names = result.tools.map((t) => t.name);
    // Plan Mode 优先级高于 MCP 放行，MCP 工具也被过滤
    expect(names).not.toContain("mcp__custom_tool");
    expect(result.reasons.get("mcp__custom_tool")).toBe("plan_mode_readonly");
  });

  it("Plan Mode + 白名单模式", () => {
    const result = filterToolsForAgent(ALL_TOOLS, {
      planMode: true,
      whitelist: new Set(["file_read"]),
    });
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(["file_read"]);
  });

  it("非 Plan Mode 时 planMode_readonly 不出现", () => {
    const result = filterToolsForAgent(ALL_TOOLS);
    for (const [, reason] of result.reasons) {
      expect(reason).not.toBe("plan_mode_readonly");
    }
  });
});

describe("PlanModeManager", () => {
  it("启用时 isActive 为 true", () => {
    const manager = createPlanModeManager({ enabled: true });
    expect(manager.isActive).toBe(true);
  });

  it("禁用时 isActive 为 false", () => {
    const manager = createPlanModeManager({ enabled: false });
    expect(manager.isActive).toBe(false);
  });

  it("禁用时 getReadonlyTools 返回全部工具", () => {
    const manager = createPlanModeManager({ enabled: false });
    const tools = manager.getReadonlyTools(ALL_TOOLS);
    expect(tools).toHaveLength(ALL_TOOLS.length);
  });

  it("启用时 getReadonlyTools 返回只读工具", () => {
    const manager = createPlanModeManager({ enabled: true });
    const tools = manager.getReadonlyTools(ALL_TOOLS);
    const names = tools.map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("glob");
        expect(names).not.toContain("file_write");
    expect(names).not.toContain("bash");
  });
});

describe("formatPlanOutput", () => {
  it("格式化包含步骤的计划", () => {
    const manager = createPlanModeManager({ enabled: true });
    const plan: ExecutionPlanResult = {
      steps: [
        {
          id: "1",
          description: "Add new API endpoint",
          files: ["src/api.ts"],
          risk: "medium",
          reason: "New feature requirement",
        },
        {
          id: "2",
          description: "Write tests",
          files: ["tests/api.test.ts"],
          risk: "low",
          reason: "Verify correctness",
        },
      ],
      summary: "Implement new API endpoint with tests",
      totalRisk: "medium",
      affectedFiles: ["src/api.ts", "tests/api.test.ts"],
      createdAt: Date.now(),
    };

    const output = manager.formatPlanOutput(plan);
    expect(output).toContain("# 📋 Execution Plan");
    expect(output).toContain("Implement new API endpoint with tests");
    expect(output).toContain("Step 1: Add new API endpoint");
    expect(output).toContain("Step 2: Write tests");
    expect(output).toContain("src/api.ts");
    expect(output).toContain("tests/api.test.ts");
    expect(output).toContain("MEDIUM");
    expect(output).toContain("Waiting for confirmation");
  });
});

describe("assessRisk", () => {
  it("无步骤返回 low", () => {
    const manager = createPlanModeManager({ enabled: true });
    expect(manager.assessRisk([])).toBe("low");
  });

  it("全部 low 返回 low", () => {
    const manager = createPlanModeManager({ enabled: true });
    const steps: PlanStep[] = [
      { id: "1", description: "a", files: [], risk: "low", reason: "r" },
      { id: "2", description: "b", files: [], risk: "low", reason: "r" },
    ];
    expect(manager.assessRisk(steps)).toBe("low");
  });

  it("存在 high 返回 high", () => {
    const manager = createPlanModeManager({ enabled: true });
    const steps: PlanStep[] = [
      { id: "1", description: "a", files: [], risk: "low", reason: "r" },
      { id: "2", description: "b", files: [], risk: "high", reason: "r" },
    ];
    expect(manager.assessRisk(steps)).toBe("high");
  });

  it("多数 medium 返回 high", () => {
    const manager = createPlanModeManager({ enabled: true });
    const steps: PlanStep[] = [
      { id: "1", description: "a", files: [], risk: "medium", reason: "r" },
      { id: "2", description: "b", files: [], risk: "medium", reason: "r" },
      { id: "3", description: "c", files: [], risk: "low", reason: "r" },
    ];
    expect(manager.assessRisk(steps)).toBe("high");
  });

  it("少数 medium 返回 medium", () => {
    const manager = createPlanModeManager({ enabled: true });
    const steps: PlanStep[] = [
      { id: "1", description: "a", files: [], risk: "medium", reason: "r" },
      { id: "2", description: "b", files: [], risk: "low", reason: "r" },
      { id: "3", description: "c", files: [], risk: "low", reason: "r" },
    ];
    expect(manager.assessRisk(steps)).toBe("medium");
  });
});

describe("waitForConfirmation", () => {
  it("autoApprove 直接返回 approved", async () => {
    const manager = createPlanModeManager({ enabled: true, autoApprove: true });
    const plan: ExecutionPlanResult = {
      steps: [],
      summary: "test",
      totalRisk: "low",
      affectedFiles: [],
      createdAt: Date.now(),
    };
    const result = await manager.waitForConfirmation(plan);
    expect(result.status).toBe("approved");
  });

  it("自定义回调返回自定义结果", async () => {
    const manager = createPlanModeManager({
      enabled: true,
      onPlanGenerated: async () => ({
        status: "rejected",
        feedback: "Too risky",
      }),
    });
    const plan: ExecutionPlanResult = {
      steps: [],
      summary: "test",
      totalRisk: "high",
      affectedFiles: [],
      createdAt: Date.now(),
    };
    const result = await manager.waitForConfirmation(plan);
    expect(result.status).toBe("rejected");
    expect(result.feedback).toBe("Too risky");
  });

  it("无回调默认返回 approved", async () => {
    const manager = createPlanModeManager({ enabled: true });
    const plan: ExecutionPlanResult = {
      steps: [],
      summary: "test",
      totalRisk: "low",
      affectedFiles: [],
      createdAt: Date.now(),
    };
    const result = await manager.waitForConfirmation(plan);
    expect(result.status).toBe("approved");
  });
});

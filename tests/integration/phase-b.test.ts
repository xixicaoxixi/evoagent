﻿﻿﻿import { describe, it, expect } from "vitest";
import { createTaskPlanner } from "../../src/core/agent/task-planner";
import { createOrchestrator } from "../../src/core/agent/orchestrator";
import { MockProvider } from "../../src/llm/mock";

function createToolUseContext() {
  return {
    cwd: process.cwd(),
    getAppState: () => ({}),
  };
}

describe("Phase B planner diagnostics", () => {
  it("无 provider 时返回 no_provider_simple 诊断", async () => {
    const planner = createTaskPlanner();
    const plan = await planner.plan("analyze repository");

    expect(plan.diagnostics).toEqual({
      source: "no_provider_simple",
      failureStage: "none",
      usedFallback: false,
      hasProvider: false,
    });
    expect(plan.subTasks.length).toBeGreaterThan(0);
  });

  it("provider 调用失败时返回 llm_call_fallback 诊断", async () => {
    const provider = new MockProvider({
      responseFn: () => {
        throw new Error("provider timeout");
      },
    });
    const planner = createTaskPlanner({ provider });
    const plan = await planner.plan("build api");

    expect(plan.diagnostics.source).toBe("llm_call_fallback");
    expect(plan.diagnostics.failureStage).toBe("provider_invoke");
    expect(plan.diagnostics.usedFallback).toBe(true);
    expect(plan.diagnostics.hasProvider).toBe(true);
    expect(plan.diagnostics.errorSummary).toContain("provider timeout");
  });

  it("provider 返回不可解析结果时返回 llm_parse_fallback 诊断", async () => {
    const provider = new MockProvider({
      responseFn: () => "not json",
    });
    const planner = createTaskPlanner({ provider });
    const plan = await planner.plan("build api");

    expect(plan.diagnostics.source).toBe("llm_parse_fallback");
    expect(plan.diagnostics.failureStage).toBe("response_parse");
    expect(plan.diagnostics.usedFallback).toBe(true);
    expect(plan.diagnostics.hasProvider).toBe(true);
  });

  it("provider 成功规划时返回 llm_success 诊断", async () => {
    const provider = new MockProvider({
      responseFn: () => JSON.stringify({
        tasks: [
          {
            type: "analysis",
            description: "Analyze request",
            input: "build api",
            expectedOutput: "analysis",
            tools: ["file_read"],
            dependsOn: [],
          },
        ],
      }),
    });
    const planner = createTaskPlanner({ provider });
    const plan = await planner.plan("build api");

    expect(plan.diagnostics).toEqual({
      source: "llm_success",
      failureStage: "none",
      usedFallback: false,
      hasProvider: true,
    });
    expect(plan.subTasks).toHaveLength(1);
  });

  it("Orchestrator.plan 透传规划诊断", async () => {
    const provider = new MockProvider({
      responseFn: () => {
        throw new Error("invoke failed");
      },
    });
    const orchestrator = createOrchestrator({
      provider,
      tools: [],
      canUseTool: (_permission) => true,
      toolUseContext: createToolUseContext(),
    });

    const plan = await orchestrator.plan("complex task");
    expect(plan.diagnostics.source).toBe("llm_call_fallback");
    expect(plan.diagnostics.errorSummary).toContain("invoke failed");
  });
});

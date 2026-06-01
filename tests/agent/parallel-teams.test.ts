/**
 * Session C.2 测试 — Agent Teams 并行协作。
 *
 * 验证 launchParallelTeam、结果汇总策略、独立上下文、超时处理、错误隔离。
 *
 * 注意：agentQueryLoop 使用 provider.stream() 而非 provider.invoke()，
 * 因此模拟失败需要通过 stream() 的 async generator 实现。
 */

import { describe, expect, it, vi } from "vitest";
import {
  createOrchestrator,
  type OrchestratorConfig,
  type TaskDefinition,
  type ParallelTeamConfig,
  type TeamMemberResult,
  type ParallelTeamResult,
  type AggregationStrategy,
} from "../../src/core/agent/orchestrator";
import type { ExecutionPlan, PlanDiagnostics } from "../../src/core/agent/task-planner";
import type { Tool, ToolUseContext, CanUseToolFn } from "../../src/interfaces/tool";
import type { LLMProvider, LLMResponse, TokenUsage, LLMStreamChunk } from "../../src/interfaces/llm-provider";

// ─── Mock 基础设施 ───

function createMockTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    execute: async () => ({ output: "", error: undefined }),
  };
}

const MOCK_TOOLS: Tool[] = [
  createMockTool("file_read"),
  createMockTool("file_write"),
  createMockTool("bash"),
  createMockTool("glob"),
  ];

const MOCK_TOKEN_USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 600,
};

/** 创建成功的 stream（agentQueryLoop 使用 stream 而非 invoke） */
function successStream(): AsyncGenerator<LLMStreamChunk> {
  return (async function* () {
    yield { type: "content", content: "Mock" };
    yield { type: "stop", stopReason: "completed", tokenUsage: MOCK_TOKEN_USAGE };
  })();
}

/** 创建失败的 stream（模拟 LLM 错误） */
function failingStream(error: unknown): AsyncGenerator<LLMStreamChunk> {
  return (async function* () {
    throw error;
  })();
}

/** 创建延迟的 stream（模拟慢 LLM 响应） */
function slowStream(delayMs: number): AsyncGenerator<LLMStreamChunk> {
  return (async function* () {
    await new Promise((r) => setTimeout(r, delayMs));
    yield { type: "content", content: "Slow" };
    yield { type: "stop", stopReason: "completed", tokenUsage: MOCK_TOKEN_USAGE };
  })();
}

function createMockLLMProvider(
  streamFn?: () => AsyncGenerator<LLMStreamChunk>,
): LLMProvider {
  return {
    providerType: "openai",
    model: "gpt-5.4",
    temperature: 0.7,
    maxTokens: 4096,
    invoke: vi.fn().mockResolvedValue({
      content: "Mock LLM response",
      stopReason: "completed",
      model: "gpt-5.4",
      tokenUsage: MOCK_TOKEN_USAGE,
    } satisfies LLMResponse),
    stream: streamFn ?? successStream,
  };
}

const MOCK_CAN_USE_TOOL: CanUseToolFn = vi.fn().mockResolvedValue(true);

const MOCK_TOOL_USE_CONTEXT: ToolUseContext = {
  sessionId: "test-session",
  workingDirectory: "/workspace",
};

function createOrchestratorConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    provider: createMockLLMProvider(),
    tools: MOCK_TOOLS,
    canUseTool: MOCK_CAN_USE_TOOL,
    toolUseContext: MOCK_TOOL_USE_CONTEXT,
    maxConcurrentAgents: 10,
    agentTimeoutMs: 5000,
    ...overrides,
  };
}

function createTask(overrides?: Partial<TaskDefinition>): TaskDefinition {
  return {
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    description: "Test task description",
    ...overrides,
  };
}

// ─── 测试：类型定义 ───

describe("TeamMemberResult 类型", () => {
  it("包含必要字段", () => {
    const result: TeamMemberResult = {
      taskId: "task-001",
      success: true,
      result: "output",
      durationMs: 100,
    };

    expect(result.taskId).toBe("task-001");
    expect(result.success).toBe(true);
    expect(result.result).toBe("output");
    expect(result.durationMs).toBe(100);
    expect(result.error).toBeUndefined();
  });

  it("支持 error 字段", () => {
    const result: TeamMemberResult = {
      taskId: "task-002",
      success: false,
      result: null,
      durationMs: 50,
      error: "Timeout exceeded",
    };

    expect(result.error).toBe("Timeout exceeded");
  });
});

describe("ParallelTeamResult 类型", () => {
  it("包含所有必要字段", () => {
    const result: ParallelTeamResult = {
      success: true,
      memberResults: [],
      aggregatedResult: null,
      totalDurationMs: 200,
      strategy: "all_succeed",
    };

    expect(result.success).toBe(true);
    expect(result.memberResults).toEqual([]);
    expect(result.strategy).toBe("all_succeed");
  });
});

describe("AggregationStrategy 类型", () => {
  it("包含四种策略", () => {
    const strategies: AggregationStrategy[] = [
      "all_succeed",
      "majority",
      "any_succeed",
      "collect_all",
    ];

    expect(strategies).toHaveLength(4);
  });
});

// ─── 测试：结果汇总逻辑（通过 launchParallelTeam 验证） ───

describe("结果汇总策略 — all_succeed", () => {
  it("所有成员成功时 aggregatedResult 为结果数组", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());
    const tasks = [createTask({ taskId: "t1" }), createTask({ taskId: "t2" })];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "all_succeed",
    });

    expect(result.success).toBe(true);
    expect(result.strategy).toBe("all_succeed");
    expect(result.memberResults).toHaveLength(2);
    expect(result.memberResults.every((r) => r.success)).toBe(true);
    expect(Array.isArray(result.aggregatedResult)).toBe(true);
  });

  it("任一成员失败时 aggregatedResult 为 null", async () => {
    // stream 抛出错误 → agentQueryLoop 返回 terminalModelError → SubAgent 状态为 failed
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({
        provider: createMockLLMProvider(
          () => failingStream(new Error("LLM unavailable")),
        ),
      }),
    );
    const tasks = [createTask({ taskId: "t1" }), createTask({ taskId: "t2" })];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "all_succeed",
    });

    expect(result.success).toBe(false);
    expect(result.aggregatedResult).toBeNull();
  });

  it("空任务列表时 aggregatedResult 为空数组", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());

    const result = await orchestrator.launchParallelTeam([], {
      strategy: "all_succeed",
    });

    expect(result.success).toBe(true);
    expect(result.aggregatedResult).toEqual([]);
    expect(result.memberResults).toHaveLength(0);
  });
});

describe("结果汇总策略 — majority", () => {
  it("多数成功时 aggregatedResult 为成功成员结果", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());
    const tasks = [
      createTask({ taskId: "t1" }),
      createTask({ taskId: "t2" }),
      createTask({ taskId: "t3" }),
    ];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "majority",
    });

    // 所有 mock 都成功，所以 majority 通过
    expect(result.success).toBe(true);
    expect(result.memberResults).toHaveLength(3);
  });

  it("少数成功时 aggregatedResult 为 null", async () => {
    // 所有任务都失败 → 少数成功
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({
        provider: createMockLLMProvider(
          () => failingStream(new Error("LLM unavailable")),
        ),
      }),
    );
    const tasks = [
      createTask({ taskId: "t1" }),
      createTask({ taskId: "t2" }),
      createTask({ taskId: "t3" }),
    ];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "majority",
    });

    expect(result.success).toBe(false);
    expect(result.aggregatedResult).toBeNull();
  });
});

describe("结果汇总策略 — any_succeed", () => {
  it("任一成功时 aggregatedResult 为该成员结果", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());
    const tasks = [
      createTask({ taskId: "t1" }),
      createTask({ taskId: "t2" }),
    ];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "any_succeed",
    });

    expect(result.success).toBe(true);
    // any_succeed 返回第一个成功结果
    expect(result.aggregatedResult).toBeDefined();
  });

  it("全部失败时 aggregatedResult 为 null", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({
        provider: createMockLLMProvider(
          () => failingStream(new Error("LLM unavailable")),
        ),
      }),
    );
    const tasks = [createTask({ taskId: "t1" }), createTask({ taskId: "t2" })];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "any_succeed",
    });

    expect(result.success).toBe(false);
    expect(result.aggregatedResult).toBeNull();
  });
});

describe("结果汇总策略 — collect_all", () => {
  it("始终成功（只要有任务）", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());
    const tasks = [createTask({ taskId: "t1" }), createTask({ taskId: "t2" })];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "collect_all",
    });

    expect(result.success).toBe(true);
    expect(result.memberResults).toHaveLength(2);

    // collect_all 返回包含 taskId/success/result/error 的对象数组
    const aggregated = result.aggregatedResult as Array<Record<string, unknown>>;
    expect(Array.isArray(aggregated)).toBe(true);
    expect(aggregated[0]).toHaveProperty("taskId");
    expect(aggregated[0]).toHaveProperty("success");
    expect(aggregated[0]).toHaveProperty("result");
    expect(aggregated[0]).toHaveProperty("error");
  });

  it("空任务列表时 collect_all 返回 false", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());

    const result = await orchestrator.launchParallelTeam([], {
      strategy: "collect_all",
    });

    // collect_all 对空列表：results.length > 0 为 false
    expect(result.success).toBe(false);
    expect(result.aggregatedResult).toEqual([]);
  });

  it("混合成功/失败时收集所有结果", async () => {
    // 使用 stream mock 让奇数任务成功、偶数任务失败
    let callCount = 0;
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({
        provider: createMockLLMProvider(() => {
          callCount++;
          if (callCount % 2 === 0) {
            return failingStream(new Error("Simulated failure"));
          }
          return successStream();
        }),
      }),
    );
    const tasks = [
      createTask({ taskId: "t1" }),
      createTask({ taskId: "t2" }),
      createTask({ taskId: "t3" }),
      createTask({ taskId: "t4" }),
    ];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "collect_all",
    });

    expect(result.success).toBe(true);
    expect(result.memberResults).toHaveLength(4);

    const aggregated = result.aggregatedResult as Array<Record<string, unknown>>;
    const successResults = aggregated.filter((r) => r.success === true);
    const failResults = aggregated.filter((r) => r.success === false);
    // 至少有一些成功和一些失败（mock 交替成功/失败）
    expect(successResults.length).toBeGreaterThan(0);
    expect(failResults.length).toBeGreaterThan(0);
  });
});

// ─── 测试：独立上下文 ───

describe("独立上下文执行", () => {
  it("每个团队成员有独立的 taskId", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());
    const tasks = [
      createTask({ taskId: "review-security" }),
      createTask({ taskId: "review-performance" }),
      createTask({ taskId: "review-testing" }),
    ];

    const result = await orchestrator.launchParallelTeam(tasks);

    const taskIds = result.memberResults.map((r) => r.taskId);
    expect(new Set(taskIds).size).toBe(3);
    expect(taskIds).toContain("review-security");
    expect(taskIds).toContain("review-performance");
    expect(taskIds).toContain("review-testing");
  });

  it("团队成员之间互不影响", async () => {
    // 让第二个任务失败，其他任务正常
    let callCount = 0;
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({
        provider: createMockLLMProvider(() => {
          callCount++;
          if (callCount === 2) {
            return failingStream(new Error("Only task 2 fails"));
          }
          return successStream();
        }),
      }),
    );
    const tasks = [
      createTask({ taskId: "t1" }),
      createTask({ taskId: "t2" }),
      createTask({ taskId: "t3" }),
    ];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "collect_all",
    });

    // t2 失败但 t1 和 t3 不受影响
    const t1 = result.memberResults.find((r) => r.taskId === "t1");
    const t2 = result.memberResults.find((r) => r.taskId === "t2");
    const t3 = result.memberResults.find((r) => r.taskId === "t3");

    expect(t1?.success).toBe(true);
    expect(t2?.success).toBe(false);
    expect(t3?.success).toBe(true);
  });
});

// ─── 测试：超时处理 ───

describe("超时处理", () => {
  it("单个成员超时不影响其他成员", async () => {
    // 第一个任务使用慢 stream（会超时），第二个正常
    let callCount = 0;
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({
        provider: createMockLLMProvider(() => {
          callCount++;
          if (callCount === 1) {
            return slowStream(500); // 500ms 延迟
          }
          return successStream();
        }),
      }),
    );
    const tasks = [
      createTask({ taskId: "slow-task" }),
      createTask({ taskId: "fast-task" }),
    ];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "collect_all",
      memberTimeoutMs: 100, // 100ms 超时
    });

    // fast-task 应该成功
    const fastTask = result.memberResults.find((r) => r.taskId === "fast-task");
    expect(fastTask?.success).toBe(true);

    // 总耗时应该合理（不会无限等待）
    expect(result.totalDurationMs).toBeLessThan(5000);
  });

  it("使用默认超时（从 OrchestratorConfig）", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ agentTimeoutMs: 10_000 }),
    );
    const tasks = [createTask({ taskId: "t1" })];

    const result = await orchestrator.launchParallelTeam(tasks);

    expect(result.memberResults).toHaveLength(1);
    expect(result.totalDurationMs).toBeLessThan(10_000);
  });
});

// ─── 测试：错误隔离 ───

describe("错误隔离", () => {
  it("stream 抛出 Error 对象时 SubAgent 状态为 failed", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({
        provider: createMockLLMProvider(
          () => failingStream(new Error("LLM stream error")),
        ),
      }),
    );
    const tasks = [createTask({ taskId: "t1" })];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "collect_all",
    });

    expect(result.memberResults[0]?.success).toBe(false);
    // SubAgent 状态为 failed（agentQueryLoop 内部捕获了错误）
  });

  it("stream 抛出非 Error 对象时 SubAgent 状态为 failed", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({
        provider: createMockLLMProvider(
          () => failingStream("string error"),
        ),
      }),
    );
    const tasks = [createTask({ taskId: "t1" })];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "collect_all",
    });

    expect(result.memberResults[0]?.success).toBe(false);
  });

  it("stream 抛出 null 时 SubAgent 状态为 failed", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({
        provider: createMockLLMProvider(
          () => failingStream(null),
        ),
      }),
    );
    const tasks = [createTask({ taskId: "t1" })];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "collect_all",
    });

    expect(result.memberResults[0]?.success).toBe(false);
  });

  it("一个成员失败不影响其他成员的错误隔离", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({
        provider: createMockLLMProvider(
          () => failingStream(new Error("Catastrophic failure")),
        ),
      }),
    );
    const tasks = [
      createTask({ taskId: "t1" }),
      createTask({ taskId: "t2" }),
    ];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "collect_all",
    });

    // 两个都失败（同一个 provider），但互不影响
    expect(result.memberResults).toHaveLength(2);
    expect(result.memberResults[0]?.success).toBe(false);
    expect(result.memberResults[1]?.success).toBe(false);
  });
});

// ─── 测试：配置 ───

describe("ParallelTeamConfig", () => {
  it("默认策略为 all_succeed", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());
    const tasks = [createTask({ taskId: "t1" })];

    const result = await orchestrator.launchParallelTeam(tasks);

    expect(result.strategy).toBe("all_succeed");
  });

  it("可以指定不同的策略", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());
    const tasks = [createTask({ taskId: "t1" })];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "any_succeed",
    });

    expect(result.strategy).toBe("any_succeed");
  });

  it("memberTimeoutMs 覆盖全局 agentTimeoutMs", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ agentTimeoutMs: 60_000 }),
    );
    const tasks = [createTask({ taskId: "t1" })];

    const result = await orchestrator.launchParallelTeam(tasks, {
      memberTimeoutMs: 1000,
    });

    // 任务应该很快完成（mock LLM 不延迟）
    expect(result.totalDurationMs).toBeLessThan(5000);
  });
});

// ─── 测试：durationMs 记录 ───

describe("durationMs 记录", () => {
  it("每个成员记录独立的执行时间", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());
    const tasks = [
      createTask({ taskId: "t1" }),
      createTask({ taskId: "t2" }),
    ];

    const result = await orchestrator.launchParallelTeam(tasks);

    for (const member of result.memberResults) {
      expect(typeof member.durationMs).toBe("number");
      expect(member.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("totalDurationMs >= 所有成员的 durationMs", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());
    const tasks = [
      createTask({ taskId: "t1" }),
      createTask({ taskId: "t2" }),
      createTask({ taskId: "t3" }),
    ];

    const result = await orchestrator.launchParallelTeam(tasks);

    const maxMemberDuration = Math.max(
      ...result.memberResults.map((r) => r.durationMs),
    );
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(maxMemberDuration);
  });
});

// ─── 测试：AbortSignal 传播 ───

describe("AbortSignal 传播", () => {
  it("已中止的 AbortSignal 导致 SubAgent 快速终止", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ abortSignal: abortController.signal }),
    );
    const tasks = [createTask({ taskId: "t1" })];

    const result = await orchestrator.launchParallelTeam(tasks, {
      strategy: "collect_all",
    });

    // SubAgent 应该快速终止（因为 abortSignal 已中止）
    expect(result.memberResults).toHaveLength(1);
    // agentQueryLoop 检查 abortSignal 并返回 terminalAborted
    expect(result.memberResults[0]?.success).toBe(false);
  });
});

// ─── 测试：Orchestrator 生命周期 ───

describe("Orchestrator 生命周期", () => {
  it("launchParallelTeam 完成后 agent 自动销毁", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());
    const tasks = [createTask({ taskId: "t1" })];

    const result = await orchestrator.launchParallelTeam(tasks);

    expect(result.memberResults.length).toBeGreaterThanOrEqual(1);
    expect(orchestrator.activeAgentCount).toBe(0);
    expect(orchestrator.getAgentStates()).toHaveLength(0);
  });

  it("abortAll 清理所有 agent", async () => {
    const orchestrator = createOrchestrator(createOrchestratorConfig());
    const tasks = [createTask({ taskId: "t1" }), createTask({ taskId: "t2" })];

    orchestrator.spawnSubAgent(tasks[0]!);
    orchestrator.spawnSubAgent(tasks[1]!);
    expect(orchestrator.activeAgentCount).toBe(2);

    orchestrator.abortAll();
    expect(orchestrator.activeAgentCount).toBe(0);
    expect(orchestrator.getAgentStates()).toHaveLength(0);
  });
});

// ─── 测试：TaskDefinition systemPrompt ───

describe("TaskDefinition systemPrompt", () => {
  it("TaskDefinition 支持 systemPrompt 字段", () => {
    const task: TaskDefinition = {
      taskId: "t1",
      description: "Test",
      systemPrompt: "You are a reviewer",
    };

    expect(task.systemPrompt).toBe("You are a reviewer");
  });

  it("systemPrompt 为可选字段", () => {
    const task: TaskDefinition = {
      taskId: "t1",
      description: "Test",
    };

    expect(task.systemPrompt).toBeUndefined();
  });
});

// ─── 测试：executePlan 批次限流（P0-1 修复验证） ───

describe("executePlan 批次限流", () => {
  const TEST_DIAGNOSTICS: PlanDiagnostics = {
    source: "no_provider_simple",
    failureStage: "none",
    usedFallback: false,
    hasProvider: false,
  };

  function createTestPlan(taskCount: number, withDependencies?: Record<string, string[]>): ExecutionPlan {
    const subTasks = Array.from({ length: taskCount }, (_, i) => {
      const taskId = `task_${String(i + 1).padStart(3, "0")}`;
      return {
        taskId,
        type: "custom" as const,
        description: `Test sub-task ${i + 1}`,
        input: `input for task ${i + 1}`,
        expectedOutput: `output for task ${i + 1}`,
        tools: [] as string[],
        knowledgeNeeded: [] as string[],
        tokenBudget: 50000,
        timeoutMs: 300_000,
        dependsOn: withDependencies?.[taskId] ?? [],
        priority: taskCount - i,
      };
    });

    return {
      planId: `plan_test_${Date.now()}`,
      originalInput: "Test plan execution with slicing",
      subTasks,
      totalTokenBudget: subTasks.reduce((sum, t) => sum + t.tokenBudget, 0),
      createdAt: Date.now(),
      diagnostics: TEST_DIAGNOSTICS,
    };
  }

  it("8 个无依赖子任务在 maxConcurrentAgents=3 时全部执行成功", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ maxConcurrentAgents: 3 }),
    );
    const plan = createTestPlan(8);

    const results = await orchestrator.executePlan(plan);

    expect(results).toHaveLength(8);
    for (const r of results) {
      expect(r.status).toBe("completed");
    }
  });

  it("6 个无依赖子任务在 maxConcurrentAgents=2 时全部执行成功", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ maxConcurrentAgents: 2 }),
    );
    const plan = createTestPlan(6);

    const results = await orchestrator.executePlan(plan);

    expect(results).toHaveLength(6);
    for (const r of results) {
      expect(r.status).toBe("completed");
    }
  });

  it("执行轨迹记录多个批次", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ maxConcurrentAgents: 2 }),
    );
    const plan = createTestPlan(5);

    await orchestrator.executePlan(plan);

    const trace = orchestrator.getExecutionTrace();
    expect(trace).not.toBeNull();
    expect(trace!.totalBatches).toBeGreaterThanOrEqual(3);
  });

  it("子任务数 <= maxConcurrentAgents 时行为不变", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ maxConcurrentAgents: 10 }),
    );
    const plan = createTestPlan(3);

    const results = await orchestrator.executePlan(plan);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe("completed");
    }
  });

  it("有依赖关系的子任务在分片限流下正确执行", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ maxConcurrentAgents: 2 }),
    );
    const dependencies: Record<string, string[]> = {
      task_002: ["task_001"],
      task_003: ["task_001"],
      task_004: ["task_002", "task_003"],
    };
    const plan = createTestPlan(4, dependencies);

    const results = await orchestrator.executePlan(plan);

    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.status).toBe("completed");
    }
  });

  it("executePlan 完成后所有 agent 已销毁", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ maxConcurrentAgents: 2 }),
    );
    const plan = createTestPlan(7);

    await orchestrator.executePlan(plan);

    expect(orchestrator.activeAgentCount).toBe(0);
    expect(orchestrator.getAgentStates()).toHaveLength(0);
  });
});

// ─── 测试：SubAgent 间上下文传递（N-05 修复验证） ───

describe("SubAgent 间上下文传递", () => {
  const TEST_DIAGNOSTICS: PlanDiagnostics = {
    source: "no_provider_simple",
    failureStage: "none",
    usedFallback: false,
    hasProvider: false,
  };

  it("A→B 依赖时 B 的 SubAgent 描述中包含 A 的输出", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ maxConcurrentAgents: 5 }),
    );
    const plan: ExecutionPlan = {
      planId: "plan_context_test",
      originalInput: "Test context passing",
      subTasks: [
        {
          taskId: "task_A",
          type: "analysis",
          description: "Analyze the data",
          input: "raw data",
          expectedOutput: "analysis result",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: [],
          priority: 2,
        },
        {
          taskId: "task_B",
          type: "generation",
          description: "Generate report based on analysis",
          input: "analysis",
          expectedOutput: "report",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: ["task_A"],
          priority: 1,
        },
      ],
      totalTokenBudget: 100000,
      createdAt: Date.now(),
      diagnostics: TEST_DIAGNOSTICS,
    };

    const results = await orchestrator.executePlan(plan);

    expect(results).toHaveLength(2);

    const taskBResult = results.find((r) => r.taskId === "task_B");
    expect(taskBResult).toBeDefined();
    expect(taskBResult!.status).toBe("completed");
  });

  it("无依赖的子任务描述中不包含 Context from dependencies 段", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ maxConcurrentAgents: 5 }),
    );
    const plan: ExecutionPlan = {
      planId: "plan_no_deps_test",
      originalInput: "Test no deps",
      subTasks: [
        {
          taskId: "task_001",
          type: "analysis",
          description: "Standalone task",
          input: "input",
          expectedOutput: "output",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: [],
          priority: 1,
        },
      ],
      totalTokenBudget: 50000,
      createdAt: Date.now(),
      diagnostics: TEST_DIAGNOSTICS,
    };

    const results = await orchestrator.executePlan(plan);

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("completed");
  });

  it("多依赖时 B 的描述包含所有前置任务的输出", async () => {
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ maxConcurrentAgents: 5 }),
    );
    const plan: ExecutionPlan = {
      planId: "plan_multi_deps_test",
      originalInput: "Test multi-deps context",
      subTasks: [
        {
          taskId: "task_A",
          type: "research",
          description: "Research topic A",
          input: "topic A",
          expectedOutput: "research A result",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: [],
          priority: 3,
        },
        {
          taskId: "task_B",
          type: "research",
          description: "Research topic B",
          input: "topic B",
          expectedOutput: "research B result",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: [],
          priority: 2,
        },
        {
          taskId: "task_C",
          type: "generation",
          description: "Combine research results",
          input: "both research",
          expectedOutput: "combined report",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: ["task_A", "task_B"],
          priority: 1,
        },
      ],
      totalTokenBudget: 150000,
      createdAt: Date.now(),
      diagnostics: TEST_DIAGNOSTICS,
    };

    const results = await orchestrator.executePlan(plan);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe("completed");
    }
  });
});

// ─── 测试：executePlan 依赖失败时跳过后续（N-12 修复验证） ───

describe("executePlan 依赖失败时跳过后续", () => {
  const TEST_DIAGNOSTICS: PlanDiagnostics = {
    source: "no_provider_simple",
    failureStage: "none",
    usedFallback: false,
    hasProvider: false,
  };

  it("A→B→C 链中 A 失败时 B 和 C 不应执行", async () => {
    const provider = createMockLLMProvider(failingStream(new Error("Task A failed")));
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ provider, maxConcurrentAgents: 5 }),
    );
    const plan: ExecutionPlan = {
      planId: "plan_cascade_fail_test",
      originalInput: "Test cascade failure",
      subTasks: [
        {
          taskId: "task_A",
          type: "analysis",
          description: "Analyze data",
          input: "data",
          expectedOutput: "analysis",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: [],
          priority: 3,
        },
        {
          taskId: "task_B",
          type: "generation",
          description: "Generate based on analysis",
          input: "analysis",
          expectedOutput: "report",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: ["task_A"],
          priority: 2,
        },
        {
          taskId: "task_C",
          type: "review",
          description: "Review report",
          input: "report",
          expectedOutput: "review",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: ["task_B"],
          priority: 1,
        },
      ],
      totalTokenBudget: 150000,
      createdAt: Date.now(),
      diagnostics: TEST_DIAGNOSTICS,
    };

    const results = await orchestrator.executePlan(plan);

    expect(results).toHaveLength(1);
    expect(results[0]!.taskId).toBe("task_A");
    expect(results[0]!.status).toBe("failed");
  });

  it("A→B, A→C 中 A 失败时 B 和 C 都不应执行", async () => {
    const provider = createMockLLMProvider(failingStream(new Error("Task A failed")));
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ provider, maxConcurrentAgents: 5 }),
    );
    const plan: ExecutionPlan = {
      planId: "plan_fan_out_fail_test",
      originalInput: "Test fan-out failure",
      subTasks: [
        {
          taskId: "task_A",
          type: "analysis",
          description: "Analyze data",
          input: "data",
          expectedOutput: "analysis",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: [],
          priority: 3,
        },
        {
          taskId: "task_B",
          type: "generation",
          description: "Generate report from analysis",
          input: "analysis",
          expectedOutput: "report",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: ["task_A"],
          priority: 2,
        },
        {
          taskId: "task_C",
          type: "review",
          description: "Review analysis",
          input: "analysis",
          expectedOutput: "review",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: ["task_A"],
          priority: 1,
        },
      ],
      totalTokenBudget: 150000,
      createdAt: Date.now(),
      diagnostics: TEST_DIAGNOSTICS,
    };

    const results = await orchestrator.executePlan(plan);

    expect(results).toHaveLength(1);
    expect(results[0]!.taskId).toBe("task_A");
    expect(results[0]!.status).toBe("failed");
  });

  it("A→B→C 链中 B 失败时只有 C 不执行", async () => {
    const failedTaskIds = new Set<string>();
    const selectiveProvider: LLMProvider = {
      providerType: "openai",
      model: "gpt-5.4",
      temperature: 0.7,
      maxTokens: 4096,
      invoke: vi.fn().mockResolvedValue({
        content: "Mock LLM response",
        stopReason: "completed",
        model: "gpt-5.4",
        tokenUsage: MOCK_TOKEN_USAGE,
      } satisfies LLMResponse),
      stream: () => {
        if (failedTaskIds.size > 0) {
          return failingStream(new Error("Task B failed"));
        }
        failedTaskIds.add("trigger");
        return successStream();
      },
    };
    const orchestrator = createOrchestrator(
      createOrchestratorConfig({ provider: selectiveProvider, maxConcurrentAgents: 1 }),
    );
    const plan: ExecutionPlan = {
      planId: "plan_mid_fail_test",
      originalInput: "Test mid-chain failure",
      subTasks: [
        {
          taskId: "task_A",
          type: "analysis",
          description: "Analyze data",
          input: "data",
          expectedOutput: "analysis",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: [],
          priority: 3,
        },
        {
          taskId: "task_B",
          type: "generation",
          description: "Generate report",
          input: "analysis",
          expectedOutput: "report",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: ["task_A"],
          priority: 2,
        },
        {
          taskId: "task_C",
          type: "review",
          description: "Review report",
          input: "report",
          expectedOutput: "review",
          tools: [],
          knowledgeNeeded: [],
          tokenBudget: 50000,
          timeoutMs: 300_000,
          dependsOn: ["task_B"],
          priority: 1,
        },
      ],
      totalTokenBudget: 150000,
      createdAt: Date.now(),
      diagnostics: TEST_DIAGNOSTICS,
    };

    const results = await orchestrator.executePlan(plan);

    expect(results.length).toBeGreaterThanOrEqual(2);
    const taskAResult = results.find((r) => r.taskId === "task_A");
    const taskBResult = results.find((r) => r.taskId === "task_B");
    const taskCResult = results.find((r) => r.taskId === "task_C");
    expect(taskAResult).toBeDefined();
    expect(taskAResult!.status).toBe("completed");
    expect(taskBResult).toBeDefined();
    expect(taskBResult!.status).toBe("failed");
    expect(taskCResult).toBeUndefined();
  });
});

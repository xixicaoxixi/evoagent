/**
 * 阶段 2 集成测试 — Agentic Loop 核心。
 */

import { describe, test, expect } from "vitest";

// ─── Continue/Terminal 类型测试 ───

import {
  continueNextTurn,
  terminalCompleted,
  terminalAborted,
  terminalMaxTurns,
  terminalModelError,
  terminalBudgetExceeded,
  isTerminal,
  isCompletedTerminal,
} from "../../src/core/query/types";
import type { Continue, Terminal } from "../../src/core/query/types";

// ─── LoopState 测试 ───

import { createLoopState, updateLoopState } from "../../src/core/query/state";

// ─── Prompt 组装测试 ───

import { assemblePrompt, generateToolPromptSection } from "../../src/core/query/prompt";

// ─── Budget 测试 ───

import {
  createBudgetTracker,
  consumeTokens,
  checkBudget,
  isSingleMessageOverLimit,
} from "../../src/core/query/budget";

// ─── 工具系统测试 ───

import { createToolRegistry } from "../../src/tools/registry";
import { createToolDefinition } from "../../src/tools/builder";
import { partitionToolCalls } from "../../src/tools/partition";
import { assembleToolPool } from "../../src/tools/pool";
import { StreamingToolExecutor } from "../../src/tools/executor";
import type { Tool } from "../../src/interfaces/tool";
import { z } from "zod";

// ─── SubAgent + Orchestrator 测试 ───

import { createSubAgent } from "../../src/core/agent/sub-agent";
import { createOrchestrator } from "../../src/core/agent/orchestrator";
import { MockProvider } from "../../src/llm/mock";

// ═══════════════════════════════════════════════
// 1. Continue / Terminal 类型
// ═══════════════════════════════════════════════

describe("Continue / Terminal Types", () => {
  test("Continue 工厂函数", () => {
    const c = continueNextTurn();
    expect(c.reason).toBe("next_turn");
  });

  test("Terminal 工厂函数", () => {
    const t1 = terminalCompleted([], { inputTokens: 100, outputTokens: 50 });
    expect(t1.reason).toBe("completed");

    const t2 = terminalAborted("aborted_user");
    expect(t2.reason).toBe("aborted_user");

    const t3 = terminalMaxTurns(10, []);
    expect(t3.reason).toBe("max_turns");
    expect(t3.turnCount).toBe(10);

    const t4 = terminalModelError(new Error("test"));
    expect(t4.reason).toBe("model_error");

    const t5 = terminalBudgetExceeded(5000, 10000);
    expect(t5.reason).toBe("budget_exceeded");
  });

  test("isTerminal 类型守卫", () => {
    expect(isTerminal({ reason: "completed" })).toBe(true);
    expect(isTerminal({ reason: "max_turns" })).toBe(true);
    expect(isTerminal({ reason: "next_turn" })).toBe(false);
    expect(isTerminal(null)).toBe(false);
    expect(isTerminal("string")).toBe(false);
  });

  test("isCompletedTerminal 类型守卫", () => {
    const completed = terminalCompleted([], { inputTokens: 0, outputTokens: 0 });
    expect(isCompletedTerminal(completed)).toBe(true);

    const aborted = terminalAborted();
    expect(isCompletedTerminal(aborted)).toBe(false);
  });
});

// ═══════════════════════════════════════════════
// 2. LoopState
// ═══════════════════════════════════════════════

describe("LoopState", () => {
  test("createLoopState 初始化", () => {
    const mockProvider = new MockProvider();
    const state = createLoopState({
      messages: [],
      systemPrompt: "test",
      tools: [],
      provider: mockProvider,
      canUseTool: () => true,
      toolUseContext: { getAppState: () => ({}) },
      maxTurns: 10,
      tokenBudget: 1000,
    });

    expect(state.turnCount).toBe(1);
    expect(state.budgetRemaining).toBe(1000);
    expect(state.messages).toHaveLength(0);
  });

  test("updateLoopState 更新", () => {
    const mockProvider = new MockProvider();
    const state = createLoopState({
      messages: [],
      systemPrompt: "test",
      tools: [],
      provider: mockProvider,
      canUseTool: () => true,
      toolUseContext: { getAppState: () => ({}) },
      maxTurns: 10,
      tokenBudget: 1000,
    });

    const updated = updateLoopState(state, { turnCount: 2 });
    expect(updated.turnCount).toBe(2);
    // 原始不变
    expect(state.turnCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════
// 3. Prompt 组装
// ═══════════════════════════════════════════════

describe("Prompt Assembly", () => {
  test("基本组装", () => {
    const result = assemblePrompt({
      baseSystemPrompt: "You are a helpful assistant.",
    });

    expect(result.systemPrompt).toContain("You are a helpful assistant.");
    expect(result.userContextMessage).toBeUndefined();
  });

  test("多层 Prompt 组装", () => {
    const result = assemblePrompt({
      baseSystemPrompt: "Base prompt",
      memoryPrompt: "Memory context",
      appendSystemPrompt: "Additional instructions",
      systemContext: "Git status: clean",
      userContext: "CLAUDE.md content here",
    });

    expect(result.systemPrompt).toContain("Base prompt");
    expect(result.systemPrompt).toContain("Memory context");
    expect(result.systemPrompt).toContain("Additional instructions");
    expect(result.systemPrompt).toContain("Git status: clean");
    expect(result.userContextMessage?.content).toBe("CLAUDE.md content here");
  });

  test("工具描述生成", () => {
    const tool = createToolDefinition({
      name: "test_tool",
      description: "A test tool",
      inputSchema: z.object({ query: z.string() }),
    });

    const desc = generateToolPromptSection([tool]);
    expect(desc).toContain("test_tool");
    expect(desc).toContain("A test tool");
  });
});

// ═══════════════════════════════════════════════
// 4. Token 预算
// ═══════════════════════════════════════════════

describe("Token Budget", () => {
  test("createBudgetTracker 初始化", () => {
    const tracker = createBudgetTracker({ totalBudget: 10000 });
    expect(tracker.totalBudget).toBe(10000);
    expect(tracker.remaining).toBe(10000);
    expect(tracker.isExceeded).toBe(false);
  });

  test("consumeTokens 消耗", () => {
    const tracker = createBudgetTracker({ totalBudget: 10000 });
    const result = consumeTokens(tracker, 3000, 2000, { totalBudget: 10000 });

    expect(result.tracker.used).toBe(5000);
    expect(result.tracker.remaining).toBe(5000);
    expect(result.shouldStop).toBe(false);
  });

  test("consumeTokens 超预算", () => {
    const tracker = createBudgetTracker({ totalBudget: 10000 });
    const result = consumeTokens(tracker, 6000, 5000, { totalBudget: 10000 });

    expect(result.tracker.isExceeded).toBe(true);
    expect(result.shouldStop).toBe(true);
  });

  test("checkBudget 综合检查", () => {
    const tracker = createBudgetTracker({ totalBudget: 10000 });
    const result = consumeTokens(tracker, 8000, 1000, { totalBudget: 10000 });

    const check = checkBudget(result.tracker, 2000, { totalBudget: 10000 });
    expect(check.canProceed).toBe(false);
    expect(check.reason).toBe("near_limit");
  });

  test("isSingleMessageOverLimit", () => {
    expect(isSingleMessageOverLimit(6000, { totalBudget: 10000 })).toBe(true);
    expect(isSingleMessageOverLimit(3000, { totalBudget: 10000 })).toBe(false);
  });
});

// ═══════════════════════════════════════════════
// 5. ToolRegistry
// ═══════════════════════════════════════════════

describe("ToolRegistry", () => {
  test("注册和查找", () => {
    const registry = createToolRegistry();
    const tool = createToolDefinition({
      name: "test_tool",
      description: "Test",
      inputSchema: z.object({}),
    });

    registry.register(tool);
    expect(registry.has("test_tool")).toBe(true);
    expect(registry.get("test_tool")?.name).toBe("test_tool");
    expect(registry.size).toBe(1);
  });

  test("优先级覆盖", () => {
    const registry = createToolRegistry();

    const tool1 = createToolDefinition({
      name: "tool_a",
      description: "Version 1",
      inputSchema: z.object({}),
    });
    const tool2 = createToolDefinition({
      name: "tool_a",
      description: "Version 2",
      inputSchema: z.object({}),
    });

    registry.register(tool1, { priority: 1 });
    registry.register(tool2, { priority: 10 });

    expect(registry.get("tool_a")?.description).toBe("Version 2");
  });

  test("注销", () => {
    const registry = createToolRegistry();
    const tool = createToolDefinition({
      name: "to_remove",
      description: "Remove me",
      inputSchema: z.object({}),
    });

    registry.register(tool);
    expect(registry.unregister("to_remove")).toBe(true);
    expect(registry.has("to_remove")).toBe(false);
  });

  test("listAll 按优先级排序", () => {
    const registry = createToolRegistry();

    registry.register(createToolDefinition({
      name: "low",
      description: "Low priority",
      inputSchema: z.object({}),
    }), { priority: 1 });

    registry.register(createToolDefinition({
      name: "high",
      description: "High priority",
      inputSchema: z.object({}),
    }), { priority: 10 });

    const all = registry.listAll();
    expect(all[0]?.name).toBe("high");
    expect(all[1]?.name).toBe("low");
  });
});

// ═══════════════════════════════════════════════
// 6. partitionToolCalls
// ═══════════════════════════════════════════════

describe("partitionToolCalls", () => {
  test("并发安全/不安全分区", () => {
    const safeTool = createToolDefinition({
      name: "safe_tool",
      description: "Safe",
      inputSchema: z.object({}),
      isConcurrencySafe: () => true,
    });

    const unsafeTool = createToolDefinition({
      name: "unsafe_tool",
      description: "Unsafe",
      inputSchema: z.object({}),
      isConcurrencySafe: () => false,
    });

    const result = partitionToolCalls(
      [
        { toolUseId: "1", toolName: "safe_tool", input: {} },
        { toolUseId: "2", toolName: "unsafe_tool", input: {} },
        { toolUseId: "3", toolName: "unknown_tool", input: {} },
      ],
      [safeTool, unsafeTool],
      { getAppState: () => ({}) },
    );

    expect(result.concurrent).toHaveLength(1);
    expect(result.concurrent[0]?.toolName).toBe("safe_tool");
    expect(result.sequential).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════
// 7. assembleToolPool
// ═══════════════════════════════════════════════

describe("assembleToolPool", () => {
  test("多来源合并 + 去重", () => {
    const tool1 = createToolDefinition({
      name: "shared",
      description: "From source 1",
      inputSchema: z.object({}),
    });
    const tool2 = createToolDefinition({
      name: "shared",
      description: "From source 2 (higher priority)",
      inputSchema: z.object({}),
    });
    const tool3 = createToolDefinition({
      name: "unique",
      description: "Only in source 2",
      inputSchema: z.object({}),
    });

    const pool = assembleToolPool([
      { name: "source1", tools: [tool1], priority: 1 },
      { name: "source2", tools: [tool2, tool3], priority: 10 },
    ]);

    expect(pool).toHaveLength(2);
    const shared = pool.find((t) => t.name === "shared");
    expect(shared?.description).toBe("From source 2 (higher priority)");
  });

  test("白名单过滤", () => {
    const tools = [
      createToolDefinition({ name: "a", description: "A", inputSchema: z.object({}) }),
      createToolDefinition({ name: "b", description: "B", inputSchema: z.object({}) }),
      createToolDefinition({ name: "c", description: "C", inputSchema: z.object({}) }),
    ];

    const pool = assembleToolPool(
      [{ name: "src", tools, priority: 1 }],
      { toolNameFilter: new Set(["a", "c"]) },
    );

    expect(pool).toHaveLength(2);
    expect(pool.map((t) => t.name)).toEqual(["a", "c"]);
  });

  test("maxTools 截断", () => {
    const tools = Array.from({ length: 10 }, (_, i) =>
      createToolDefinition({ name: `tool_${i}`, description: `Tool ${i}`, inputSchema: z.object({}) }),
    );

    const pool = assembleToolPool(
      [{ name: "src", tools, priority: 1 }],
      { maxTools: 3 },
    );

    expect(pool).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════
// 8. StreamingToolExecutor
// ═══════════════════════════════════════════════

describe("StreamingToolExecutor", () => {
  test("执行工具并收集结果", async () => {
    const tool = createToolDefinition({
      name: "echo",
      description: "Echo tool",
      inputSchema: z.object({ message: z.string() }),
      call: async (args) => ({
        content: `Echo: ${(args as { message: string }).message}`,
        isError: false,
      }),
      isConcurrencySafe: () => true,
    });

    const executor = new StreamingToolExecutor({
      tools: [tool],
      context: { getAppState: () => ({}) },
      canUseTool: () => true,
    });

    const results: Array<{ message: { content: string; isError: boolean } }> = [];
    for await (const result of executor.execute([
      { toolUseId: "1", toolName: "echo", input: { message: "hello" }, tool },
    ])) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0]?.message.content).toBe("Echo: hello");
    expect(results[0]?.message.isError).toBe(false);
  });

  test("未知工具返回错误", async () => {
    const executor = new StreamingToolExecutor({
      tools: [],
      context: { getAppState: () => ({}) },
      canUseTool: () => true,
    });

    const results: Array<{ message: { isError: boolean } }> = [];
    for await (const result of executor.execute([
      {
        toolUseId: "1",
        toolName: "unknown",
        input: {},
        tool: {
          name: "unknown",
          description: "",
          inputSchema: z.object({}),
          maxResultSizeChars: 0,
          call: async () => ({ content: "missing", isError: true }),
          isEnabled: () => true,
          isConcurrencySafe: () => false,
          isReadOnly: () => true,
          checkPermissions: async () => ({ behavior: "deny" as const, reason: "" }),
        },
      },
    ])) {
      results.push(result);
    }

    expect(results[0]?.message.isError).toBe(true);
  });
});

// ═══════════════════════════════════════════════
// 9. SubAgent
// ═══════════════════════════════════════════════

describe("SubAgent", () => {
  test("创建 SubAgent", () => {
    const mockProvider = new MockProvider();
    const agent = createSubAgent({
      agentId: "agent-1",
      taskId: "task-1",
      parentAgentId: "orchestrator",
      systemPrompt: "You are a sub-agent.",
      tools: [],
      provider: mockProvider,
      canUseTool: () => true,
      toolUseContext: { getAppState: () => ({}) },
    });

    expect(agent.getState().status).toBe("created");
    expect(agent.getState().agentId).toBe("agent-1");
  });

  test("运行 SubAgent（Mock Provider）", async () => {
    const mockProvider = new MockProvider({ defaultResponse: "Task completed." });
    const agent = createSubAgent({
      agentId: "agent-2",
      taskId: "task-2",
      parentAgentId: "orchestrator",
      systemPrompt: "Complete the task.",
      tools: [],
      provider: mockProvider,
      canUseTool: () => true,
      toolUseContext: { getAppState: () => ({}) },
      maxTurns: 3,
      tokenBudget: 5000,
    });

    // 收集所有事件
    const events: Array<{ type: string }> = [];
    const gen = agent.run("Do something simple");
    let result = await gen.next();
    while (!result.done) {
      events.push(result.value);
      result = await gen.next();
    }

    expect(result.value.reason).toBe("completed");
    expect(agent.getState().status).toBe("completed");
  });
});

// ═══════════════════════════════════════════════
// 10. Orchestrator
// ═══════════════════════════════════════════════

describe("Orchestrator", () => {
  test("创建编排器", () => {
    const mockProvider = new MockProvider();
    const orchestrator = createOrchestrator({
      provider: mockProvider,
      tools: [],
      canUseTool: () => true,
      toolUseContext: { getAppState: () => ({}) },
    });

    expect(orchestrator.activeAgentCount).toBe(0);
  });

  test("派生 SubAgent", () => {
    const mockProvider = new MockProvider();
    const orchestrator = createOrchestrator({
      provider: mockProvider,
      tools: [],
      canUseTool: () => true,
      toolUseContext: { getAppState: () => ({}) },
    });

    const agent = orchestrator.spawnSubAgent({
      taskId: "task-1",
      description: "Test task",
    });

    expect(agent.getState().agentId).toContain("agent-");
  });

  test("中止所有 Agent", () => {
    const mockProvider = new MockProvider();
    const orchestrator = createOrchestrator({
      provider: mockProvider,
      tools: [],
      canUseTool: () => true,
      toolUseContext: { getAppState: () => ({}) },
    });

    orchestrator.spawnSubAgent({ taskId: "t1", description: "Task 1" });
    orchestrator.spawnSubAgent({ taskId: "t2", description: "Task 2" });

    orchestrator.abortAll();
    // 验证 abortController 已触发
    expect(orchestrator.activeAgentCount).toBe(0);
  });
});

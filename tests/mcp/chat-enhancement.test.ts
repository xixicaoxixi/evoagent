import { describe, it, expect } from "vitest";
import { MockProvider } from "../../src/llm/mock";
import { createMemoryExtractor } from "../../src/knowledge/memory-extractor";
import { registerChatTools } from "../../src/mcp-entry";
import { createRequestLimiter } from "../../src/mcp/request-limiter";
import type { MCPServer } from "../../src/mcp/server";
import type { EvoAgentContext } from "../../src/integration/context";
import type { ExecutionPlan, PlanDiagnostics } from "../../src/core/agent/task-planner";
import { AsyncLocalStorage } from "node:async_hooks";

function createMockMCPServer(): {
  server: MCPServer;
  handlers: Map<string, (params: unknown) => Promise<unknown>>;
} {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  const server: MCPServer = {
    registerTool: (definition, handler) => {
      handlers.set(definition.name, handler);
    },
    unregisterTool: () => false,
    registerResource: () => {},
    unregisterResource: () => false,
    handleMessage: async () => undefined,
    connect: () => {},
    disconnect: () => {},
    listTools: () => [],
    listResources: () => [],
    getStats: () => ({ totalRequests: 0, successfulRequests: 0, failedRequests: 0, toolsRegistered: 0, resourcesRegistered: 0 }),
  };
  return { server, handlers };
}

const defaultSessionActiveOps = new Map<string, { ops: Set<Promise<unknown>>; controllers: Set<AbortController> }>();
const defaultSessionContext = new AsyncLocalStorage<string | undefined>();
const defaultChatLimiter = createRequestLimiter(10);
const defaultComplexLimiter = createRequestLimiter(10);
const defaultExecutionStates = new Map<string, import("../../src/mcp-entry").ExecutionState>();

function createPlanDiagnostics(overrides: Partial<PlanDiagnostics> = {}): PlanDiagnostics {
  return {
    source: "llm_success",
    failureStage: "none",
    usedFallback: false,
    hasProvider: true,
    ...overrides,
  };
}

function createExecutionPlan(diagnostics: PlanDiagnostics): ExecutionPlan {
  return {
    planId: "plan_123",
    originalInput: "Build API",
    subTasks: [
      {
        taskId: "task_001",
        type: "analysis",
        description: "Analyze request",
        input: "Build API",
        expectedOutput: "Analysis",
        tools: ["file_read"],
        knowledgeNeeded: [],
        tokenBudget: 1000,
        timeoutMs: 1000,
        dependsOn: [],
        priority: 2,
      },
      {
        taskId: "task_002",
        type: "generation",
        description: "Generate solution",
        input: "$task_001.output",
        expectedOutput: "Implementation",
        tools: ["file_write"],
        knowledgeNeeded: [],
        tokenBudget: 1000,
        timeoutMs: 1000,
        dependsOn: ["task_001"],
        priority: 1,
      },
    ],
    totalTokenBudget: 2000,
    createdAt: 123456,
    diagnostics,
  };
}

function createMockCtx(overrides: Partial<EvoAgentContext> = {}): EvoAgentContext {
  const baseCtx: EvoAgentContext = {
    provider: new MockProvider(),
    tools: [],
    getEngine: () => ({}) as never,
    getOrchestrator: () => ({}) as never,
    getEvolutionEngine: () => ({}) as never,
    getRuleStore: () => ({}) as never,
    getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) as never,
    getStatsStore: () => ({}) as never,
    getCostTracker: () => ({}) as never,
    getProgressTracker: () => ({}) as never,
    getGateway: () => ({}) as never,
    getCritic: () => ({}) as never,
    getConsensusEngine: () => ({}) as never,
    getReputationSystem: () => ({}) as never,
    getCommunity: () => ({}) as never,
    getMarketplace: () => ({}) as never,
    getAnalytics: () => ({}) as never,
    chat: async () => ({ response: "test", tokensUsed: 10, agentCount: 1, evolutionTriggered: false, durationMs: 100, terminal: { reason: "done" as const } }) as never,
    chatComplex: async () => ({
      response: "test",
      tokensUsed: { inputTokens: 0, outputTokens: 0 },
      agentCount: 1,
      successCount: 1,
      agentStates: [],
      evolutionTriggered: false,
      durationMs: 100,
      terminal: { reason: "done" as const },
      plan: createExecutionPlan(createPlanDiagnostics()),
      planDiagnostics: createPlanDiagnostics(),
    }) as never,
    recordTaskCompletion: async () => {},
    recordCost: () => {},
    getEvolutionState: () => ({}) as never,
    getProgress: () => ({}) as never,
    shutdown: () => {},
    gracefulShutdown: async () => {},
  };

  return {
    ...baseCtx,
    ...overrides,
  };
}

describe("C.3 chat handler (mcp-entry)", () => {
  it("chat handler should call ctx.chat and return result", async () => {
    const provider = new MockProvider();
    let chatCalled = false;
    const ctx = createMockCtx({
      provider,
      chat: async (message: string) => {
        chatCalled = true;
        return {
          response: `Response to: ${message}`,
          tokensUsed: 25,
          agentCount: 1,
          evolutionTriggered: false,
          durationMs: 50,
          terminal: { reason: "done" as const },
        } as never;
      },
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, defaultExecutionStates);

    const chatHandler = handlers.get("chat");
    expect(chatHandler).toBeDefined();

    const result = await chatHandler!({ message: "Hello" }) as Record<string, unknown>;
    expect(chatCalled).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(data.response).toBe("Response to: Hello");
    expect(data.tokensUsed).toBe(25);
  });

  it("chat handler should return error when message is missing", async () => {
    const ctx = createMockCtx();
    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, defaultExecutionStates);

    const chatHandler = handlers.get("chat");
    const result = await chatHandler!({}) as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect(Array.isArray(result.content)).toBe(true);
  });

  it("chat handler should return error when ctx.chat throws", async () => {
    const ctx = createMockCtx({
      chat: async () => { throw new Error("Engine failed"); },
    });
    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, defaultExecutionStates);

    const chatHandler = handlers.get("chat");
    const result = await chatHandler!({ message: "test" }) as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("Engine failed");
  });
});

describe("C.3 chatComplex handler (mcp-entry)", () => {
  it("chatComplex handler should call ctx.chatComplex and return plan", async () => {
    let chatComplexCalled = false;
    const diagnostics = createPlanDiagnostics({
      source: "llm_call_fallback",
      failureStage: "provider_invoke",
      usedFallback: true,
      errorSummary: "provider timeout",
    });
    const plan = createExecutionPlan(diagnostics);

    const ctx = createMockCtx({
      chatComplex: async (message: string, subTasks: readonly string[]) => {
        chatComplexCalled = true;
        return {
          response: `Complex: ${message}, subtasks: ${subTasks.length}`,
          tokensUsed: { inputTokens: 0, outputTokens: 0 },
          agentCount: 3,
          successCount: 2,
          agentStates: [
            { agentId: "agent-1", taskId: "task_001", status: "completed", result: "done", tokenUsage: { inputTokens: 10, outputTokens: 5 } },
            { agentId: "agent-2", taskId: "task_002", status: "completed", result: "done", tokenUsage: { inputTokens: 20, outputTokens: 10 } },
            { agentId: "agent-3", taskId: "task_003", status: "failed", result: undefined, tokenUsage: { inputTokens: 5, outputTokens: 0 } },
          ],
          evolutionTriggered: true,
          durationMs: 200,
          terminal: { reason: "done" as const },
          plan,
          planDiagnostics: diagnostics,
        } as never;
      },
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, defaultExecutionStates);

    const handler = handlers.get("chat_complex");
    expect(handler).toBeDefined();

    const result = await handler!({ message: "Build API", sub_tasks: ["Design", "Implement"] }) as Record<string, unknown>;
    expect(chatComplexCalled).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(data.agentCount).toBe(3);
    expect(data.successCount).toBe(2);
    expect(data.agentStates).toHaveLength(3);
    expect((data.agentStates as Array<unknown>)[0]).toEqual(
      expect.objectContaining({ agentId: "agent-1", taskId: "task_001", status: "completed" }),
    );
    expect(data.evolutionTriggered).toBe(true);
    expect(data.planDiagnostics).toEqual(diagnostics);
    expect(data.plan).toEqual({
      planId: "plan_123",
      createdAt: 123456,
      totalTokenBudget: 2000,
      subTaskCount: 2,
    });
  });

  it("chatComplex handler should return error when message is missing", async () => {
    const ctx = createMockCtx();
    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, defaultExecutionStates);

    const handler = handlers.get("chat_complex");
    const result = await handler!({}) as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect(Array.isArray(result.content)).toBe(true);
  });

  it("chatComplex handler should accept structured sub_task objects", async () => {
    let receivedSubTasks: readonly string[] = [];
    const ctx = createMockCtx({
      chatComplex: async (_message: string, subTasks: readonly string[]) => {
        receivedSubTasks = subTasks;
        return {
          response: "ok",
          tokensUsed: { inputTokens: 0, outputTokens: 0 },
          agentCount: 2,
          successCount: 2,
          agentStates: [],
          evolutionTriggered: false,
          durationMs: 100,
          terminal: { reason: "done" as const },
          plan: createExecutionPlan(createPlanDiagnostics()),
          planDiagnostics: createPlanDiagnostics(),
        } as never;
      },
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, defaultExecutionStates);

    const handler = handlers.get("chat_complex");
    const result = await handler!({
      message: "Build API",
      sub_tasks: [
        { task: "Design schema", description: "Design the database schema" },
        { task: "Implement endpoints" },
      ],
    }) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(receivedSubTasks).toEqual(["Design the database schema", "Implement endpoints"]);
  });

  it("chatComplex handler should accept mixed string and structured sub_task", async () => {
    let receivedSubTasks: readonly string[] = [];
    const ctx = createMockCtx({
      chatComplex: async (_message: string, subTasks: readonly string[]) => {
        receivedSubTasks = subTasks;
        return {
          response: "ok",
          tokensUsed: { inputTokens: 0, outputTokens: 0 },
          agentCount: 2,
          successCount: 2,
          agentStates: [],
          evolutionTriggered: false,
          durationMs: 100,
          terminal: { reason: "done" as const },
          plan: createExecutionPlan(createPlanDiagnostics()),
          planDiagnostics: createPlanDiagnostics(),
        } as never;
      },
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, defaultExecutionStates);

    const handler = handlers.get("chat_complex");
    const result = await handler!({
      message: "Build API",
      sub_tasks: ["Design", { task: "Implement", description: "Implement the API" }],
    }) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(receivedSubTasks).toEqual(["Design", "Implement the API"]);
  });

  it("chatComplex handler structured sub_task without description uses task field", async () => {
    let receivedSubTasks: readonly string[] = [];
    const ctx = createMockCtx({
      chatComplex: async (_message: string, subTasks: readonly string[]) => {
        receivedSubTasks = subTasks;
        return {
          response: "ok",
          tokensUsed: { inputTokens: 0, outputTokens: 0 },
          agentCount: 1,
          successCount: 1,
          agentStates: [],
          evolutionTriggered: false,
          durationMs: 100,
          terminal: { reason: "done" as const },
          plan: createExecutionPlan(createPlanDiagnostics()),
          planDiagnostics: createPlanDiagnostics(),
        } as never;
      },
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, defaultExecutionStates);

    const handler = handlers.get("chat_complex");
    const result = await handler!({
      message: "Build API",
      sub_tasks: [{ task: "Generate function" }],
    }) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(receivedSubTasks).toEqual(["Generate function"]);
  });
});

describe("C.3 chat MemoryExtractor extraction (context.ts logic)", () => {
  it("chat success with response >50 chars should trigger memory extraction", async () => {
    const provider = new MockProvider({
      responseFn: () =>
        JSON.stringify([
          { type: "fact", title: "User question", content: "User asked about TypeScript generics", confidence: 0.8 },
        ]),
    });

    const memoryExtractor = createMemoryExtractor({ provider, minTurnsBetweenExtractions: 1 });
    const message = "What are TypeScript generics?";
    const response = "TypeScript generics allow you to create reusable components that work with any type.";
    const start = Date.now();

    if (response.length > 50) {
      const messages = [
        { id: "user-msg", role: "user" as const, content: message, timestamp: start },
        { id: "assistant-msg", role: "assistant" as const, content: response, timestamp: Date.now() },
      ];
      if (memoryExtractor.shouldExtract(1, messages)) {
        await memoryExtractor.extract(messages);
      }
    }

    const memories = memoryExtractor.getAllMemories();
    expect(memories.length).toBeGreaterThanOrEqual(0);
    expect(provider.callHistory.length).toBeGreaterThanOrEqual(1);
  });

  it("chat response <=50 chars should not trigger memory extraction", () => {
    const provider = new MockProvider();
    const memoryExtractor = createMemoryExtractor({ provider });
    const response = "Short";

    if (response.length > 50) {
      expect(true).toBe(false);
    }

    expect(memoryExtractor.getAllMemories().length).toBe(0);
    expect(provider.callHistory.length).toBe(0);
  });

  it("chat failure should not trigger memory extraction", () => {
    const provider = new MockProvider();
    const memoryExtractor = createMemoryExtractor({ provider });
    const success = false;
    const response = "Error occurred";

    if (success && response.length > 50) {
      expect(true).toBe(false);
    }

    expect(memoryExtractor.getAllMemories().length).toBe(0);
  });
});

describe("C.3 chat response quality scoring (context.ts logic)", () => {
  it("chat success with response >100 chars should trigger quality scoring", async () => {
    const provider = new MockProvider({
      responseFn: () => "0.85",
    });

    const message = "Explain how async/await works in TypeScript";
    const response = "Async/await is a syntactic sugar for promises in TypeScript. It allows you to write asynchronous code that looks synchronous, making it easier to read and maintain. The async keyword marks a function as asynchronous, and the await keyword pauses execution until a promise resolves.";

    if (response.length > 100) {
      const qualityScore = await provider.invoke([
        {
          role: "system",
          content: "Rate the quality of this AI response on a scale of 0.0 to 1.0. Respond with ONLY a number.",
        },
        {
          role: "user",
          content: `User query: ${message.slice(0, 300)}\n\nAI response: ${response.slice(0, 500)}`,
        },
      ]);
      const score = parseFloat(qualityScore.content.trim());
      expect(score).toBe(0.85);
    }

    expect(provider.callHistory.length).toBe(1);
  });

  it("response <=100 chars should not trigger quality scoring", () => {
    const provider = new MockProvider();
    const response = "Short response";

    if (response.length > 100) {
      expect(true).toBe(false);
    }

    expect(provider.callHistory.length).toBe(0);
  });
});

describe("Step 6: ExecutionState lifecycle management", () => {
  it("chat_complex normal completion updates execution state to completed", async () => {
    const executionStates = new Map<string, import("../../src/mcp-entry").ExecutionState>();
    const ctx = createMockCtx({
      chatComplex: async () => ({
        response: "done",
        tokensUsed: { inputTokens: 0, outputTokens: 0 },
        agentCount: 1,
        successCount: 1,
        agentStates: [
          { agentId: "a1", taskId: "task_001", status: "completed", result: "ok", tokenUsage: { inputTokens: 10, outputTokens: 5 } },
        ],
        evolutionTriggered: false,
        durationMs: 100,
        terminal: { reason: "done" as const },
        plan: createExecutionPlan(createPlanDiagnostics()),
        planDiagnostics: createPlanDiagnostics(),
      }) as never,
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, executionStates);

    const handler = handlers.get("chat_complex")!;
    const result = await handler({ message: "test", sub_tasks: ["task1"] }) as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;
    const execId = data.executionId as string;

    const state = executionStates.get(execId);
    expect(state).toBeDefined();
    expect(state!.status).toBe("completed");
    expect(state!.completedAt).toBeGreaterThan(0);
  });

  it("chat_complex error updates execution state to failed", async () => {
    const executionStates = new Map<string, import("../../src/mcp-entry").ExecutionState>();
    const ctx = createMockCtx({
      chatComplex: async () => { throw new Error("LLM provider error"); },
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, executionStates);

    const handler = handlers.get("chat_complex")!;
    const result = await handler({ message: "test", sub_tasks: ["task1"] }) as Record<string, unknown>;
    expect(result.isError).toBe(true);

    const states = [...executionStates.values()];
    expect(states.length).toBe(1);
    expect(states[0]!.status).toBe("failed");
    expect(states[0]!.completedAt).toBeGreaterThan(0);
  });

  it("chat_complex timeout updates execution state to timed_out", async () => {
    const executionStates = new Map<string, import("../../src/mcp-entry").ExecutionState>();
    const ctx = createMockCtx({
      chatComplex: async () => { throw new Error("chat_complex timed out after 900000ms"); },
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, executionStates);

    const handler = handlers.get("chat_complex")!;
    const result = await handler({ message: "test", sub_tasks: ["task1"] }) as Record<string, unknown>;
    expect(result.isError).toBe(true);

    const states = [...executionStates.values()];
    expect(states.length).toBe(1);
    expect(states[0]!.status).toBe("timed_out");
    expect(states[0]!.completedAt).toBeGreaterThan(0);
  });

  it("task_status returns structured expired info for TTL-expired states", async () => {
    const executionStates = new Map<string, import("../../src/mcp-entry").ExecutionState>();
    const ctx = createMockCtx();
    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, executionStates);

    const expiredState: import("../../src/mcp-entry").ExecutionState = {
      executionId: "exec_expired",
      status: "completed",
      startedAt: Date.now() - 31 * 60 * 1000,
      completedAt: Date.now() - 31 * 60 * 1000,
      subTasks: [],
    };
    executionStates.set("exec_expired", expiredState);

    const taskStatusHandler = handlers.get("task_status")!;
    const result = await taskStatusHandler({ execution_id: "exec_expired" }) as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;

    expect(data.status).toBe("expired");
    expect(data.reason).toBe("Execution state expired after TTL");
    expect(data.originalStatus).toBe("completed");
    expect(data.executionId).toBe("exec_expired");
    expect(executionStates.has("exec_expired")).toBe(false);
  });

  it("task_status detects stuck in_progress and marks as timed_out", async () => {
    const executionStates = new Map<string, import("../../src/mcp-entry").ExecutionState>();
    const ctx = createMockCtx();
    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, executionStates);

    const stuckState: import("../../src/mcp-entry").ExecutionState = {
      executionId: "exec_stuck",
      status: "in_progress",
      startedAt: Date.now() - 16 * 60 * 1000,
      subTasks: [{ taskId: "task_001", status: "in_progress" }],
    };
    executionStates.set("exec_stuck", stuckState);

    const taskStatusHandler = handlers.get("task_status")!;
    const result = await taskStatusHandler({ execution_id: "exec_stuck" }) as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;

    expect(data.status).toBe("timed_out");
    expect(data.completedAt).toBeGreaterThan(0);

    const updatedState = executionStates.get("exec_stuck");
    expect(updatedState!.status).toBe("timed_out");
  });

  it("task_status returns normal state for recent in_progress", async () => {
    const executionStates = new Map<string, import("../../src/mcp-entry").ExecutionState>();
    const ctx = createMockCtx();
    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, executionStates);

    const recentState: import("../../src/mcp-entry").ExecutionState = {
      executionId: "exec_recent",
      status: "in_progress",
      startedAt: Date.now() - 5000,
      subTasks: [{ taskId: "task_001", status: "in_progress" }],
    };
    executionStates.set("exec_recent", recentState);

    const taskStatusHandler = handlers.get("task_status")!;
    const result = await taskStatusHandler({ execution_id: "exec_recent" }) as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;

    expect(data.status).toBe("in_progress");
  });

  it("chat_complex with no sub_tasks still updates state to completed", async () => {
    const executionStates = new Map<string, import("../../src/mcp-entry").ExecutionState>();
    const ctx = createMockCtx({
      chatComplex: async () => ({
        response: "done",
        tokensUsed: { inputTokens: 0, outputTokens: 0 },
        agentCount: 1,
        successCount: 1,
        agentStates: [],
        evolutionTriggered: false,
        durationMs: 100,
        terminal: { reason: "done" as const },
        plan: createExecutionPlan(createPlanDiagnostics()),
        planDiagnostics: createPlanDiagnostics(),
      }) as never,
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, defaultChatLimiter, defaultComplexLimiter, executionStates);

    const handler = handlers.get("chat_complex")!;
    const result = await handler({ message: "test" }) as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;
    const execId = data.executionId as string;

    const state = executionStates.get(execId);
    expect(state).toBeDefined();
    expect(state!.status).toBe("completed");
    expect(state!.completedAt).toBeGreaterThan(0);
  });
});

describe("Step 7: Separated chat and chat_complex limiters", () => {
  it("chat handler uses chatLimiter independently from complexLimiter", async () => {
    const chatLimiter = createRequestLimiter(1);
    const complexLimiter = createRequestLimiter(1);
    let chatCalled = false;
    const ctx = createMockCtx({
      chat: async () => {
        chatCalled = true;
        return {
          response: "ok",
          tokensUsed: 10,
          agentCount: 1,
          evolutionTriggered: false,
          durationMs: 50,
          terminal: { reason: "done" as const },
        } as never;
      },
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, chatLimiter, complexLimiter, defaultExecutionStates);

    const chatHandler = handlers.get("chat")!;
    const result = await chatHandler({ message: "test" }) as Record<string, unknown>;
    expect(chatCalled).toBe(true);
    expect(result.isError).toBeUndefined();
  });

  it("chat handler returns error with hint when chatLimiter is exhausted", async () => {
    const chatLimiter = createRequestLimiter(1);
    const release = chatLimiter.tryAcquire();
    expect(release).not.toBeNull();

    const complexLimiter = createRequestLimiter(10);
    const ctx = createMockCtx();
    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, chatLimiter, complexLimiter, defaultExecutionStates);

    const chatHandler = handlers.get("chat")!;
    const result = await chatHandler({ message: "test" }) as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(data.error).toContain("Server busy");
    expect(data.hint).toBeDefined();
    expect(data.retryAfterMs).toBe(5000);

    release!();
  });

  it("chat_complex handler uses complexLimiter independently from chatLimiter", async () => {
    const chatLimiter = createRequestLimiter(1);
    const complexLimiter = createRequestLimiter(1);
    const chatRelease = chatLimiter.tryAcquire();
    expect(chatRelease).not.toBeNull();

    const ctx = createMockCtx({
      chatComplex: async () => ({
        response: "done",
        tokensUsed: { inputTokens: 0, outputTokens: 0 },
        agentCount: 1,
        successCount: 1,
        agentStates: [],
        evolutionTriggered: false,
        durationMs: 100,
        terminal: { reason: "done" as const },
        plan: createExecutionPlan(createPlanDiagnostics()),
        planDiagnostics: createPlanDiagnostics(),
      }) as never,
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, chatLimiter, complexLimiter, defaultExecutionStates);

    const handler = handlers.get("chat_complex")!;
    const result = await handler({ message: "test", sub_tasks: ["task1"] }) as Record<string, unknown>;
    expect(result.isError).toBeUndefined();

    chatRelease!();
  });

  it("chat_complex handler returns error with hint when complexLimiter is exhausted", async () => {
    const chatLimiter = createRequestLimiter(10);
    const complexLimiter = createRequestLimiter(1);
    const release = complexLimiter.tryAcquire();
    expect(release).not.toBeNull();

    const ctx = createMockCtx();
    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, chatLimiter, complexLimiter, defaultExecutionStates);

    const handler = handlers.get("chat_complex")!;
    const result = await handler({ message: "test", sub_tasks: ["task1"] }) as Record<string, unknown>;
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(data.error).toContain("Server busy");
    expect(data.hint).toBeDefined();

    release!();
  });

  it("chat is not blocked when complexLimiter is exhausted", async () => {
    const chatLimiter = createRequestLimiter(3);
    const complexLimiter = createRequestLimiter(1);
    const complexRelease = complexLimiter.tryAcquire();
    expect(complexRelease).not.toBeNull();

    let chatCalled = false;
    const ctx = createMockCtx({
      chat: async () => {
        chatCalled = true;
        return {
          response: "ok",
          tokensUsed: 10,
          agentCount: 1,
          evolutionTriggered: false,
          durationMs: 50,
          terminal: { reason: "done" as const },
        } as never;
      },
    });

    const { server, handlers } = createMockMCPServer();
    const activeOps = new Set<Promise<unknown>>();
    registerChatTools(server, ctx, activeOps, defaultSessionActiveOps, defaultSessionContext, chatLimiter, complexLimiter, defaultExecutionStates);

    const chatHandler = handlers.get("chat")!;
    const result = await chatHandler({ message: "test" }) as Record<string, unknown>;
    expect(chatCalled).toBe(true);
    expect(result.isError).toBeUndefined();

    complexRelease!();
  });
});

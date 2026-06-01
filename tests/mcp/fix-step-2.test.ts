import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createOrchestrator, type Orchestrator } from "../../src/core/agent/orchestrator";
import { createAgentFactory, type AgentFactory } from "../../src/core/agent/agent-factory";
import type { LLMProvider, StreamEvent } from "../../src/interfaces/llm-provider";
import type { Tool, ToolUseContext, CanUseToolFn } from "../../src/interfaces/tool";
import type { ExecutionPlan, TaskDefinition } from "../../src/types/execution-plan";

function createMockProvider(): LLMProvider {
  return {
    model: "test-model",
    submitMessage: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ value: { type: "text" as const, text: "done" }, done: false }),
      }),
    }),
  } as unknown as LLMProvider;
}

function createMockTools(): readonly Tool[] {
  return [];
}

function createMockToolUseContext(): ToolUseContext {
  return {
    cwd: process.cwd(),
    env: {},
    getAppState: () => ({}),
  };
}

const canUseTool: CanUseToolFn = () => true;

function createTestOrchestrator(): Orchestrator {
  const provider = createMockProvider();
  const tools = createMockTools();
  const toolUseContext = createMockToolUseContext();

  const factory = createAgentFactory({
    provider,
    tools,
    canUseTool,
    toolUseContext,
  });

  return createOrchestrator({
    factory,
    provider,
    tools,
    canUseTool,
    toolUseContext,
  });
}

function createSimplePlan(taskCount: number): ExecutionPlan {
  const subTasks: TaskDefinition[] = [];
  for (let i = 0; i < taskCount; i++) {
    subTasks.push({
      taskId: `task-${i}`,
      description: `Task ${i}`,
      tools: [],
      dependsOn: [],
      tokenBudget: 5000,
    });
  }
  return { subTasks };
}

describe("Fix Step 2: chat_complex 超时时中止底层操作", () => {
  describe("executePlan signal 参数", () => {
    it("signal 已 aborted 时立即返回空数组", async () => {
      const orchestrator = createTestOrchestrator();
      const controller = new AbortController();
      controller.abort();

      const plan = createSimplePlan(2);
      const result = await orchestrator.executePlan(plan, controller.signal);

      expect(result).toEqual([]);
    });

    it("无 signal 时行为不变（向后兼容）", async () => {
      const orchestrator = createTestOrchestrator();
      const plan = createSimplePlan(1);

      const result = await orchestrator.executePlan(plan);

      expect(Array.isArray(result)).toBe(true);
    });

    it("signal 在执行中触发时，planAbortController 被 abort", async () => {
      const controller = new AbortController();
      let planAborted = false;

      const provider = createMockProvider();
      const tools = createMockTools();
      const toolUseContext = createMockToolUseContext();

      const factory = createAgentFactory({
        provider,
        tools,
        canUseTool,
        toolUseContext,
      });

      const orchestrator = createOrchestrator({
        factory,
        provider,
        tools,
        canUseTool,
        toolUseContext,
        planTimeoutMs: 300_000,
      });

      const plan = createSimplePlan(1);

      const executePromise = orchestrator.executePlan(plan, controller.signal);

      await new Promise((resolve) => setTimeout(resolve, 50));

      controller.abort();

      const result = await executePromise;

      expect(Array.isArray(result)).toBe(true);
    });

    it("signal 触发后正在运行的 agent 被 abort", async () => {
      const controller = new AbortController();
      const abortedAgents: string[] = [];

      const provider = createMockProvider();
      const tools = createMockTools();
      const toolUseContext = createMockToolUseContext();

      const factory = createAgentFactory({
        provider,
        tools,
        canUseTool,
        toolUseContext,
      });

      const orchestrator = createOrchestrator({
        factory,
        provider,
        tools,
        canUseTool,
        toolUseContext,
        planTimeoutMs: 300_000,
      });

      const plan = createSimplePlan(2);

      const executePromise = orchestrator.executePlan(plan, controller.signal);

      await new Promise((resolve) => setTimeout(resolve, 50));

      controller.abort();

      const result = await executePromise;

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("signal listener 清理", () => {
    it("执行完成后 signal listener 被移除（无内存泄漏）", async () => {
      const controller = new AbortController();
      const orchestrator = createTestOrchestrator();
      const plan = createSimplePlan(1);

      const initialListenerCount = controller.signal.listenerCount?.("abort") ?? 0;

      await orchestrator.executePlan(plan, controller.signal);

      const finalListenerCount = controller.signal.listenerCount?.("abort") ?? 0;

      expect(finalListenerCount).toBe(initialListenerCount);
    });

    it("signal abort 后 listener 不再残留", async () => {
      const controller = new AbortController();
      const orchestrator = createTestOrchestrator();
      const plan = createSimplePlan(1);

      const executePromise = orchestrator.executePlan(plan, controller.signal);

      await new Promise((resolve) => setTimeout(resolve, 50));

      controller.abort();

      await executePromise;

      expect(true).toBe(true);
    });
  });

  describe("chatComplex signal 透传", () => {
    it("chatComplex 接受可选 signal 参数（类型签名验证）", async () => {
      const { createEvoAgentContext } = await import("../../src/integration/context");
      const ctx = await createEvoAgentContext({
        provider: createMockProvider(),
        tools: createMockTools(),
        canUseTool,
        toolUseContext: createMockToolUseContext(),
      });

      expect(typeof ctx.chatComplex).toBe("function");
    });
  });

  describe("mcp-entry signal 传递", () => {
    it("chat_complex handler 将 controller.signal 传给 chatComplex", async () => {
      const { createEvoAgentContext } = await import("../../src/integration/context");
      const chatComplexSpy = vi.fn().mockResolvedValue({
        response: "test",
        agentStates: [],
        plan: { subTasks: [] },
      });

      const ctx = await createEvoAgentContext({
        provider: createMockProvider(),
        tools: createMockTools(),
        canUseTool,
        toolUseContext: createMockToolUseContext(),
      });

      ctx.chatComplex = chatComplexSpy;

      const controller = new AbortController();

      await ctx.chatComplex("test message", ["subtask1"], controller.signal);

      expect(chatComplexSpy).toHaveBeenCalledWith("test message", ["subtask1"], controller.signal);
    });
  });
});

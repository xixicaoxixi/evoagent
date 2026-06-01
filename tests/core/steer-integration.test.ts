import { describe, it, expect } from "vitest";
import { agentQueryLoop } from "../../src/core/query/loop";
import { createSteerControl, type SteerControl } from "../../src/core/query/state";
import type { LoopParams } from "../../src/core/query/state";
import type { LLMProvider } from "../../src/interfaces/llm-provider";
import type { StreamEvent, Terminal } from "../../src/core/query/types";

function createToolCallingProvider(toolCalls: Array<{ name: string; input: Record<string, unknown> }>): LLMProvider {
  let callIndex = 0;

  return {
    model: "test-model",
    async *stream(messages) {
      if (callIndex < toolCalls.length) {
        const tc = toolCalls[callIndex]!;
        callIndex++;
        yield {
          type: "tool_use" as const,
          toolUseId: `tool-use-${callIndex}`,
          toolName: tc.name,
          input: tc.input,
        };
        yield {
          type: "stop" as const,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
        };
      } else {
        yield { type: "content" as const, content: "Done" };
        yield {
          type: "stop" as const,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
        };
      }
    },
    simpleProvider: {
      model: "test-model",
      async complete() {
        return { content: "test", inputTokens: 10, outputTokens: 5 };
      },
    },
  };
}

function createCompletingProvider(responses: string[]): LLMProvider {
  let responseIndex = 0;

  return {
    model: "test-model",
    async *stream(messages) {
      const response = responses[responseIndex] ?? "Done";
      responseIndex++;

      if (response.startsWith("TOOL_CALL:")) {
        const [_, name, inputJson] = response.split(":", 3);
        yield {
          type: "tool_use" as const,
          toolUseId: `tool-use-${responseIndex}`,
          toolName: name ?? "test-tool",
          input: inputJson ? JSON.parse(inputJson) : {},
        };
      }

      yield { type: "content" as const, content: response.replace(/^TOOL_CALL:.*$/, "") };
      yield {
        type: "stop" as const,
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    simpleProvider: {
      model: "test-model",
      async complete() {
        return { content: "test", inputTokens: 10, outputTokens: 5 };
      },
    },
  };
}

function createAlwaysCompleteProvider(): LLMProvider {
  return {
    model: "test-model",
    async *stream() {
      yield { type: "content" as const, content: "Task complete" };
      yield { type: "stop" as const, tokenUsage: { inputTokens: 10, outputTokens: 5 } };
    },
    simpleProvider: {
      model: "test-model",
      async complete() {
        return { content: "test", inputTokens: 10, outputTokens: 5 };
      },
    },
  };
}

function createMultiTurnProvider(turnsBeforeComplete: number): LLMProvider {
  let turn = 0;

  return {
    model: "test-model",
    async *stream() {
      turn++;
      if (turn <= turnsBeforeComplete) {
        yield {
          type: "tool_use" as const,
          toolUseId: `tool-use-${turn}`,
          toolName: "test-tool",
          input: { step: turn },
        };
        yield {
          type: "stop" as const,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
        };
      } else {
        yield { type: "content" as const, content: "All done" };
        yield {
          type: "stop" as const,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
        };
      }
    },
    simpleProvider: {
      model: "test-model",
      async complete() {
        return { content: "test", inputTokens: 10, outputTokens: 5 };
      },
    },
  };
}

function createTestTool() {
  return {
    name: "test-tool",
    description: "A test tool",
    inputSchema: {} as any,
    async call(input: Record<string, unknown>) {
      return {
        content: `Tool executed with: ${JSON.stringify(input)}`,
        isError: false,
      };
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    checkPermissions: async () => ({ behavior: "allow" as const }),
  };
}

function createLoopParams(overrides: Partial<LoopParams> = {}): LoopParams {
  return {
    messages: [
      { id: "msg-1", role: "user" as const, content: "Do something", timestamp: Date.now() },
    ],
    systemPrompt: "You are a test assistant",
    tools: [createTestTool()],
    provider: createAlwaysCompleteProvider(),
    canUseTool: () => true,
    toolUseContext: { getAppState: () => ({}) },
    maxTurns: 50,
    tokenBudget: 100000,
    ...overrides,
  };
}

async function collectLoopEvents(params: LoopParams): Promise<{ events: StreamEvent[]; terminal: Terminal }> {
  const events: StreamEvent[] = [];
  let terminal: Terminal | undefined;

  for await (const event of agentQueryLoop(params)) {
    events.push(event);
  }

  const gen = agentQueryLoop(params);
  let result = await gen.next();
  const allEvents: StreamEvent[] = [];

  while (!result.done) {
    allEvents.push(result.value);
    result = await gen.next();
  }

  return { events: allEvents, terminal: result.value };
}

async function runLoopToCompletion(params: LoopParams): Promise<{ events: StreamEvent[]; terminal: Terminal }> {
  const events: StreamEvent[] = [];
  const gen = agentQueryLoop(params);
  let result = await gen.next();

  while (!result.done) {
    events.push(result.value);
    result = await gen.next();
  }

  return { events, terminal: result.value };
}

describe("Steer + Generation 集成 — 代际过期检测", () => {
  it("generation 未变时循环正常完成", async () => {
    const ctrl = createSteerControl();
    const params = createLoopParams({ steerControl: ctrl });
    const { terminal } = await runLoopToCompletion(params);

    expect(terminal.reason).toBe("completed");
  });

  it("generation 递增后循环以 aborted_generation 终止", async () => {
    const ctrl = createSteerControl();
    const provider = createMultiTurnProvider(3);
    const params = createLoopParams({
      steerControl: ctrl,
      provider,
      maxTurns: 10,
    });

    const gen = agentQueryLoop(params);
    const events: StreamEvent[] = [];
    let result = await gen.next();

    let turnCount = 0;
    while (!result.done) {
      events.push(result.value);
      if (result.value.type === "turn_end") {
        turnCount++;
        if (turnCount === 1) {
          ctrl.generation++;
        }
      }
      result = await gen.next();
    }

    expect(result.value.reason).toBe("aborted_generation");
  });

  it("无 SteerControl 时循环不受代际检查影响", async () => {
    const params = createLoopParams();
    const { terminal } = await runLoopToCompletion(params);

    expect(terminal.reason).toBe("completed");
  });
});

describe("Steer + Generation 集成 — steer 消息注入", () => {
  it("pendingSteer 设置后下一轮对话包含 steer 消息", async () => {
    const ctrl = createSteerControl();
    const provider = createMultiTurnProvider(2);
    const params = createLoopParams({
      steerControl: ctrl,
      provider,
      maxTurns: 10,
    });

    const gen = agentQueryLoop(params);
    const events: StreamEvent[] = [];
    let result = await gen.next();

    let turnCount = 0;
    while (!result.done) {
      events.push(result.value);
      if (result.value.type === "turn_end") {
        turnCount++;
        if (turnCount === 1) {
          ctrl.pendingSteer = "Focus on the error handling";
        }
      }
      result = await gen.next();
    }

    const steerEvents = events.filter((e) => e.type === "steer_injected");
    expect(steerEvents.length).toBe(1);
    expect((steerEvents[0] as { type: "steer_injected"; content: string }).content).toBe("Focus on the error handling");
  });

  it("steer 消息注入后 pendingSteer 被清除", async () => {
    const ctrl = createSteerControl();
    const provider = createMultiTurnProvider(3);
    const params = createLoopParams({
      steerControl: ctrl,
      provider,
      maxTurns: 10,
    });

    const gen = agentQueryLoop(params);
    const events: StreamEvent[] = [];
    let result = await gen.next();

    let turnCount = 0;
    while (!result.done) {
      events.push(result.value);
      if (result.value.type === "turn_end") {
        turnCount++;
        if (turnCount === 1) {
          ctrl.pendingSteer = "First steer";
        }
      }
      result = await gen.next();
    }

    expect(ctrl.pendingSteer).toBeNull();
  });

  it("无 SteerControl 时循环正常完成且无 steer_injected 事件", async () => {
    const params = createLoopParams();
    const { events, terminal } = await runLoopToCompletion(params);

    const steerEvents = events.filter((e) => e.type === "steer_injected");
    expect(steerEvents).toHaveLength(0);
    expect(terminal.reason).toBe("completed");
  });
});

describe("Steer + Generation 集成 — /stop 模拟", () => {
  it("模拟 /stop：递增 generation 后旧流结果被丢弃", async () => {
    const ctrl = createSteerControl();
    const provider = createMultiTurnProvider(5);
    const params = createLoopParams({
      steerControl: ctrl,
      provider,
      maxTurns: 10,
    });

    const gen = agentQueryLoop(params);
    const events: StreamEvent[] = [];
    let result = await gen.next();

    let turnCount = 0;
    while (!result.done) {
      events.push(result.value);
      if (result.value.type === "turn_end") {
        turnCount++;
        if (turnCount === 2) {
          ctrl.generation++;
        }
      }
      result = await gen.next();
    }

    expect(result.value.reason).toBe("aborted_generation");
    expect(turnCount).toBeLessThan(5);
  });

  it("模拟 /stop 后新循环使用新 generation", async () => {
    const ctrl = createSteerControl();
    ctrl.generation++;

    const params = createLoopParams({
      steerControl: ctrl,
      maxTurns: 10,
    });

    const { terminal } = await runLoopToCompletion(params);

    expect(terminal.reason).toBe("completed");
  });
});

describe("Steer + Generation 集成 — steer + generation 组合", () => {
  it("steer 注入后 generation 变化仍能终止循环", async () => {
    const ctrl = createSteerControl();
    const provider = createMultiTurnProvider(5);
    const params = createLoopParams({
      steerControl: ctrl,
      provider,
      maxTurns: 10,
    });

    const gen = agentQueryLoop(params);
    const events: StreamEvent[] = [];
    let result = await gen.next();

    let turnCount = 0;
    while (!result.done) {
      events.push(result.value);
      if (result.value.type === "turn_end") {
        turnCount++;
        if (turnCount === 1) {
          ctrl.pendingSteer = "Steer message";
        }
        if (turnCount === 2) {
          ctrl.generation++;
        }
      }
      result = await gen.next();
    }

    const steerEvents = events.filter((e) => e.type === "steer_injected");
    expect(steerEvents.length).toBe(1);
    expect(result.value.reason).toBe("aborted_generation");
  });
});

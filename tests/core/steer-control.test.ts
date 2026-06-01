import { describe, it, expect } from "vitest";
import {
  createSteerControl,
  createLoopState,
  updateLoopState,
  type SteerControl,
  type LoopParams,
} from "../../src/core/query/state";
import type { LLMProvider } from "../../src/interfaces/llm-provider";
import type { Tool } from "../../src/interfaces/tool";

function createMinimalProvider(): LLMProvider {
  return {
    model: "test-model",
    async *stream() {
      yield { type: "content" as const, content: "test" };
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

function createMinimalParams(overrides?: Partial<LoopParams>): LoopParams {
  return {
    messages: [],
    systemPrompt: "test",
    tools: [],
    provider: createMinimalProvider(),
    canUseTool: () => true,
    toolUseContext: { getAppState: () => ({}) },
    maxTurns: 50,
    tokenBudget: 100000,
    ...overrides,
  };
}

describe("SteerControl — 创建", () => {
  it("初始状态：pendingSteer 为 null，generation 为 0", () => {
    const ctrl = createSteerControl();
    expect(ctrl.pendingSteer).toBeNull();
    expect(ctrl.generation).toBe(0);
  });
});

describe("SteerControl — pendingSteer 设置和清除", () => {
  it("设置 pendingSteer 后可读取", () => {
    const ctrl = createSteerControl();
    ctrl.pendingSteer = "Focus on testing";
    expect(ctrl.pendingSteer).toBe("Focus on testing");
  });

  it("清除 pendingSteer 后为 null", () => {
    const ctrl = createSteerControl();
    ctrl.pendingSteer = "Focus on testing";
    ctrl.pendingSteer = null;
    expect(ctrl.pendingSteer).toBeNull();
  });

  it("多次设置 pendingSteer 取最后一次", () => {
    const ctrl = createSteerControl();
    ctrl.pendingSteer = "First";
    ctrl.pendingSteer = "Second";
    expect(ctrl.pendingSteer).toBe("Second");
  });
});

describe("SteerControl — generation 递增", () => {
  it("初始 generation 为 0", () => {
    const ctrl = createSteerControl();
    expect(ctrl.generation).toBe(0);
  });

  it("递增 generation 后值增加", () => {
    const ctrl = createSteerControl();
    ctrl.generation++;
    expect(ctrl.generation).toBe(1);
  });

  it("多次递增 generation", () => {
    const ctrl = createSteerControl();
    ctrl.generation++;
    ctrl.generation++;
    ctrl.generation++;
    expect(ctrl.generation).toBe(3);
  });
});

describe("LoopState — initialGeneration 捕获", () => {
  it("无 SteerControl 时 initialGeneration 为 0", () => {
    const params = createMinimalParams();
    const state = createLoopState(params);
    expect(state.initialGeneration).toBe(0);
    expect(state.steerControl).toBeUndefined();
  });

  it("有 SteerControl 时 initialGeneration 捕获当前 generation", () => {
    const ctrl = createSteerControl();
    ctrl.generation = 5;
    const params = createMinimalParams({ steerControl: ctrl });
    const state = createLoopState(params);
    expect(state.initialGeneration).toBe(5);
    expect(state.steerControl).toBe(ctrl);
  });

  it("generation 递增后 initialGeneration 不变", () => {
    const ctrl = createSteerControl();
    const params = createMinimalParams({ steerControl: ctrl });
    const state = createLoopState(params);
    expect(state.initialGeneration).toBe(0);

    ctrl.generation++;
    expect(state.initialGeneration).toBe(0);
    expect(ctrl.generation).toBe(1);
  });
});

describe("LoopState — 代际过期检测", () => {
  it("generation 未变时不过期", () => {
    const ctrl = createSteerControl();
    const params = createMinimalParams({ steerControl: ctrl });
    const state = createLoopState(params);

    const isStale = state.steerControl !== undefined && state.steerControl.generation !== state.initialGeneration;
    expect(isStale).toBe(false);
  });

  it("generation 递增后检测到过期", () => {
    const ctrl = createSteerControl();
    const params = createMinimalParams({ steerControl: ctrl });
    const state = createLoopState(params);

    ctrl.generation++;

    const isStale = state.steerControl !== undefined && state.steerControl.generation !== state.initialGeneration;
    expect(isStale).toBe(true);
  });

  it("updateLoopState 保留 initialGeneration 和 steerControl", () => {
    const ctrl = createSteerControl();
    ctrl.generation = 3;
    const params = createMinimalParams({ steerControl: ctrl });
    const state = createLoopState(params);

    const updated = updateLoopState(state, { turnCount: 2 });
    expect(updated.initialGeneration).toBe(3);
    expect(updated.steerControl).toBe(ctrl);
  });
});

describe("SteerControl — 共享引用语义", () => {
  it("多个消费者共享同一个 SteerControl 实例", () => {
    const ctrl = createSteerControl();
    const params1 = createMinimalParams({ steerControl: ctrl });
    const params2 = createMinimalParams({ steerControl: ctrl });

    const state1 = createLoopState(params1);
    const state2 = createLoopState(params2);

    ctrl.pendingSteer = "Shared message";
    ctrl.generation++;

    expect(state1.steerControl!.pendingSteer).toBe("Shared message");
    expect(state2.steerControl!.pendingSteer).toBe("Shared message");
    expect(state1.steerControl!.generation).toBe(1);
    expect(state2.steerControl!.generation).toBe(1);
  });
});

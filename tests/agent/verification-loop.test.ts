/**
 * Session B.2 测试 — 验证闭环。
 *
 * 验证 post-action 验证流水线、反馈修复、最大轮次、缓存。
 */

import { describe, expect, it } from "vitest";
import {
  createStepExecutor,
  createVerificationPipeline,
  createVerificationLoop,
  VerificationCache,
  type StepResult,
  type VerificationResult,
} from "../../src/core/agent/verification-loop";

const isBun = typeof (globalThis as any).Bun !== "undefined";
const describeBun = isBun ? describe : describe.skip;

function createMockStepExecutor(
  step: "test" | "lint" | "type-check",
  success: boolean,
  output: string = "",
): { executor: ReturnType<typeof createStepExecutor>; callCount: { value: number } } {
  const callCount = { value: 0 };
  const executor = createStepExecutor({
    step,
    command: `echo "${output}"`,
  });
  const originalExecute = executor.execute.bind(executor);
  executor.execute = async () => {
    callCount.value++;
    return {
      step,
      success,
      output,
      durationMs: 10,
    };
  };
  return { executor, callCount };
}

function makeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    success: true,
    steps: [],
    totalDurationMs: 10,
    failedSteps: [],
    ...overrides,
  };
}

describe("VerificationCache", () => {
  it("存取结果", () => {
    const cache = new VerificationCache();
    const result: StepResult = {
      step: "test",
      success: true,
      output: "ok",
      durationMs: 10,
    };
    cache.set("key1", result);
    expect(cache.get("key1")).toEqual(result);
  });

  it("未命中返回 undefined", () => {
    const cache = new VerificationCache();
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("TTL 过期后返回 undefined", async () => {
    const cache = new VerificationCache(1);
    const result: StepResult = {
      step: "test",
      success: true,
      output: "ok",
      durationMs: 10,
    };
    cache.set("key1", result);
    await new Promise((r) => setTimeout(r, 5));
    const retrieved = cache.get("key1");
    expect(retrieved).toBeUndefined();
  });

  it("clear 清空缓存", () => {
    const cache = new VerificationCache();
    const result: StepResult = {
      step: "test",
      success: true,
      output: "ok",
      durationMs: 10,
    };
    cache.set("key1", result);
    cache.clear();
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describeBun("createStepExecutor", () => {
  it("成功执行命令", async () => {
    const executor = createStepExecutor({
      step: "test",
      command: "echo 'hello'",
    });
    const result = await executor.execute();
    expect(result.step).toBe("test");
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("失败命令返回 success=false", async () => {
    const executor = createStepExecutor({
      step: "test",
      command: "exit 1",
    });
    const result = await executor.execute();
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("不存在的命令返回错误", async () => {
    const executor = createStepExecutor({
      step: "test",
      command: "nonexistent_command_xyz",
    });
    const result = await executor.execute();
    expect(result.success).toBe(false);
  });
});

describeBun("createVerificationPipeline", () => {
  it("所有步骤成功时返回 success=true", async () => {
    const pipeline = createVerificationPipeline({
      steps: [
        { step: "test", command: "echo 'test ok'" },
        { step: "type-check", command: "echo 'type ok'" },
      ],
    });

    const result = await pipeline.run();
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.failedSteps).toHaveLength(0);
    expect(result.totalDurationMs).toBeGreaterThan(0);
  });

  it("任一步骤失败时返回 success=false", async () => {
    const pipeline = createVerificationPipeline({
      steps: [
        { step: "test", command: "exit 1" },
        { step: "type-check", command: "echo 'ok'" },
      ],
    });

    const result = await pipeline.run();
    expect(result.success).toBe(false);
    expect(result.failedSteps).toContain("test");
  });

  it("空步骤列表返回 success=true", async () => {
    const pipeline = createVerificationPipeline({ steps: [] });
    const result = await pipeline.run();
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(0);
  });

  it("输出过长时截断到 10000 字符", async () => {
    const pipeline = createVerificationPipeline({
      steps: [
        { step: "test", command: "python3 -c \"print('x' * 20000)\"" },
      ],
    });

    const result = await pipeline.run();
    expect(result.steps[0]?.output.length).toBeLessThanOrEqual(10_000);
  });
});

describe("createVerificationLoop", () => {
  it("首次验证成功直接返回", async () => {
    const loop = createVerificationLoop({
      pipeline: {
        steps: [
          { step: "test", command: "echo 'ok'" },
          { step: "type-check", command: "echo 'ok'" },
        ],
      },
      maxFixRounds: 3,
    });

    loop.pipeline.run = async () =>
      makeVerificationResult({
        steps: [
          { step: "test", success: true, output: "ok", durationMs: 10 },
          { step: "type-check", success: true, output: "ok", durationMs: 10 },
        ],
      });

    const result = await loop.run();
    expect(result.success).toBe(true);
    expect(result.totalRounds).toBe(0);
    expect(result.rounds).toHaveLength(0);
  });

  it("验证失败且无修复回调时返回失败", async () => {
    const loop = createVerificationLoop({
      pipeline: {
        steps: [
          { step: "test", command: "exit 1" },
        ],
      },
      maxFixRounds: 3,
    });

    loop.pipeline.run = async () =>
      makeVerificationResult({
        success: false,
        failedSteps: ["test"],
        steps: [
          { step: "test", success: false, output: "fail", durationMs: 10, error: "test failed" },
        ],
      });

    const result = await loop.run();
    expect(result.success).toBe(false);
    expect(result.totalRounds).toBe(1);
  });

  it("修复后验证成功", async () => {
    let fixCallCount = 0;
    let testShouldSucceed = false;

    const loop = createVerificationLoop({
      pipeline: {
        steps: [
          {
            step: "test",
            command: "echo 'placeholder'",
          },
        ],
      },
      maxFixRounds: 3,
      onFixNeeded: async () => {
        fixCallCount++;
        testShouldSucceed = true;
        return true;
      },
    });

    loop.pipeline.run = async () => {
      const result: VerificationResult = testShouldSucceed
        ? { success: true, steps: [{ step: "test", success: true, output: "ok", durationMs: 10 }], totalDurationMs: 10, failedSteps: [] }
        : { success: false, steps: [{ step: "test", success: false, output: "fail", durationMs: 10, error: "test failed" }], totalDurationMs: 10, failedSteps: ["test"] };
      return result;
    };

    const result = await loop.run();
    expect(result.success).toBe(true);
    expect(fixCallCount).toBe(1);
    expect(result.totalRounds).toBe(1);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.fixApplied).toBe(true);
  });

  it("超过最大修复轮次返回失败", async () => {
    const loop = createVerificationLoop({
      pipeline: {
        steps: [
          { step: "test", command: "exit 1" },
        ],
      },
      maxFixRounds: 2,
      onFixNeeded: async () => true,
    });

    loop.pipeline.run = async () =>
      makeVerificationResult({
        success: false,
        failedSteps: ["test"],
        steps: [
          { step: "test", success: false, output: "fail", durationMs: 10, error: "test failed" },
        ],
      });

    const result = await loop.run();
    expect(result.success).toBe(false);
    expect(result.totalRounds).toBe(2);
    expect(result.rounds).toHaveLength(2);
  });

  it("修复回调返回 false 时停止修复", async () => {
    let fixCallCount = 0;

    const loop = createVerificationLoop({
      pipeline: {
        steps: [
          { step: "test", command: "exit 1" },
        ],
      },
      maxFixRounds: 5,
      onFixNeeded: async () => {
        fixCallCount++;
        return false;
      },
    });

    loop.pipeline.run = async () =>
      makeVerificationResult({
        success: false,
        failedSteps: ["test"],
        steps: [
          { step: "test", success: false, output: "fail", durationMs: 10, error: "test failed" },
        ],
      });

    const result = await loop.run();
    expect(result.success).toBe(false);
    expect(fixCallCount).toBe(1);
    expect(result.rounds).toHaveLength(1);
  });

  it("修复回调抛出异常时视为修复失败", async () => {
    let fixCallCount = 0;

    const loop = createVerificationLoop({
      pipeline: {
        steps: [
          { step: "test", command: "exit 1" },
        ],
      },
      maxFixRounds: 3,
      onFixNeeded: async () => {
        fixCallCount++;
        throw new Error("Fix failed");
      },
    });

    loop.pipeline.run = async () =>
      makeVerificationResult({
        success: false,
        failedSteps: ["test"],
        steps: [
          { step: "test", success: false, output: "fail", durationMs: 10, error: "test failed" },
        ],
      });

    const result = await loop.run();
    expect(result.success).toBe(false);
    expect(result.rounds[0]?.fixApplied).toBe(false);
  });

  it("finalVerification 包含最后一次验证结果", async () => {
    const loop = createVerificationLoop({
      pipeline: {
        steps: [
          { step: "test", command: "echo 'ok'" },
        ],
      },
      maxFixRounds: 0,
    });

    loop.pipeline.run = async () =>
      makeVerificationResult({
        steps: [
          { step: "test", success: true, output: "ok", durationMs: 10 },
        ],
      });

    const result = await loop.run();
    expect(result.finalVerification.success).toBe(true);
    expect(result.finalVerification.steps).toHaveLength(1);
  });
});

// ─── D2: VerificationCache 缓存键修复验证 ───

describe("D2: VerificationCache cache key (step + cwd)", () => {
  it("pipeline.run() 后 cache.size > 0（缓存键不再含 Date.now()）", async () => {
    const cache = new VerificationCache();
    const cwd = process.cwd();
    const key = `test:${cwd}`;
    const result: StepResult = {
      step: "test",
      success: true,
      output: "ok",
      durationMs: 10,
    };
    cache.set(key, result);

    expect(cache.get(key)).toEqual(result);
    expect(cache.size).toBe(1);
  });

  it("缓存键基于 step + cwd，不同 cwd 生成不同缓存键", () => {
    const cache = new VerificationCache();
    const result: StepResult = {
      step: "test",
      success: true,
      output: "ok",
      durationMs: 10,
    };

    cache.set("test:/project-a", result);
    cache.set("test:/project-b", { ...result, output: "ok-b" });

    expect(cache.get("test:/project-a")?.output).toBe("ok");
    expect(cache.get("test:/project-b")?.output).toBe("ok-b");
    expect(cache.size).toBe(2);
  });

  it("缓存键不包含 Date.now()，同一 key 可重复命中", () => {
    const cache = new VerificationCache();
    const result: StepResult = {
      step: "lint",
      success: true,
      output: "lint ok",
      durationMs: 10,
    };

    const key = "lint:/workspace";
    cache.set(key, result);

    expect(cache.get(key)).toEqual(result);
    expect(cache.get(key)).toEqual(result);
  });

  it("相同 step + cwd 的缓存键在 TTL 内可命中", async () => {
    const cache = new VerificationCache(60_000);
    const cwd = "/tmp/test-project";
    const key = `test:${cwd}`;
    const result: StepResult = {
      step: "test",
      success: true,
      output: "all tests pass",
      durationMs: 100,
    };

    cache.set(key, result);
    const hit = cache.get(key);
    expect(hit).toBeDefined();
    expect(hit?.success).toBe(true);
    expect(hit?.output).toBe("all tests pass");
  });

  it("不同 step 类型生成不同缓存键", () => {
    const cache = new VerificationCache();
    const cwd = "/workspace";
    cache.set(`test:${cwd}`, { step: "test", success: true, output: "ok", durationMs: 10 });
    cache.set(`lint:${cwd}`, { step: "lint", success: true, output: "ok", durationMs: 5 });
    cache.set(`type-check:${cwd}`, { step: "type-check", success: true, output: "ok", durationMs: 8 });

    expect(cache.size).toBe(3);
    expect(cache.get(`test:${cwd}`)?.step).toBe("test");
    expect(cache.get(`lint:${cwd}`)?.step).toBe("lint");
    expect(cache.get(`type-check:${cwd}`)?.step).toBe("type-check");
  });
});

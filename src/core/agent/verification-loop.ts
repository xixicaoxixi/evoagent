/**
 * 验证闭环 — post-action 验证流水线。
 *
 * Agent 完成代码修改后，自动执行验证步骤（test → lint → type-check）。
 * 验证失败时将错误信息反馈给 Agent 进行修复，最多修复 N 轮。
 *
 * 参考：工作原理.md L1520-1544
 */

// ─── 验证步骤类型 ───

/** 验证步骤类型 */
export type VerificationStepType = "test" | "lint" | "type-check";

/** 单个验证步骤结果 */
export interface StepResult {
  readonly step: VerificationStepType;
  readonly success: boolean;
  readonly output: string;
  readonly durationMs: number;
  readonly error?: string;
}

/** 验证流水线结果 */
export interface VerificationResult {
  readonly success: boolean;
  readonly steps: readonly StepResult[];
  readonly totalDurationMs: number;
  readonly failedSteps: readonly VerificationStepType[];
}

/** 验证修复轮次结果 */
export interface FixRoundResult {
  readonly round: number;
  readonly verificationResult: VerificationResult;
  readonly fixApplied: boolean;
  readonly fixDurationMs: number;
}

/** 验证闭环最终结果 */
export interface VerificationLoopResult {
  readonly success: boolean;
  readonly rounds: readonly FixRoundResult[];
  readonly totalDurationMs: number;
  readonly totalRounds: number;
  readonly finalVerification: VerificationResult;
}

// ─── 验证步骤执行器 ───

/** 验证步骤执行器接口 */
export interface StepExecutor {
  readonly step: VerificationStepType;
  execute(): Promise<StepResult>;
}

/** 验证步骤执行器配置 */
export interface StepExecutorConfig {
  readonly step: VerificationStepType;
  /** 自定义执行命令 */
  readonly command?: string;
  /** 工作目录 */
  readonly cwd?: string;
  /** 超时（毫秒） */
  readonly timeoutMs?: number;
}

/** 创建验证步骤执行器 */
export function createStepExecutor(config: StepExecutorConfig): StepExecutor {
  const defaultCommands: Record<VerificationStepType, string> = {
    test: "bun test",
    lint: "bunx tsc --noEmit",
    "type-check": "bunx tsc --noEmit",
  };

  const command = config.command ?? defaultCommands[config.step];
  const timeoutMs = config.timeoutMs ?? 120_000;

  return {
    step: config.step,
    async execute(): Promise<StepResult> {
      const start = Date.now();
      try {
        const isWindows = process.platform === "win32";
        const spawnArgs: string[] = isWindows
          ? ["cmd", "/c", command]
          : ["sh", "-c", command];

        const proc = Bun.spawn(spawnArgs, {
          cwd: config.cwd ?? process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        });

        // 超时处理
        const timer = setTimeout(() => proc.kill(), timeoutMs);

        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          Bun.readableStreamToText(proc.stdout),
          Bun.readableStreamToText(proc.stderr),
        ]);

        clearTimeout(timer);

        const durationMs = Date.now() - start;
        const output = stdout + (stderr ? `\n${stderr}` : "");
        const success = exitCode === 0;

        return {
          step: config.step,
          success,
          output: output.slice(0, 10_000), // 截断过长输出
          durationMs,
          ...(exitCode !== 0 ? { error: `Exit code: ${exitCode}` } : {}),
        };
      } catch (e) {
        const durationMs = Date.now() - start;
        const errorMsg = e instanceof Error ? e.message : "Unknown error";
        return {
          step: config.step,
          success: false,
          output: errorMsg,
          durationMs,
          error: errorMsg,
        };
      }
    },
  };
}

// ─── 验证流水线 ───

/** 验证流水线配置 */
export interface VerificationPipelineConfig {
  /** 验证步骤（按顺序执行） */
  readonly steps: readonly StepExecutorConfig[];
  /** 工作目录 */
  readonly cwd?: string;
  /** 单步超时（毫秒） */
  readonly stepTimeoutMs?: number;
}

/** 验证结果缓存 */
export class VerificationCache {
  private readonly cache = new Map<string, { result: StepResult; timestamp: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 60_000) {
    this.ttlMs = ttlMs;
  }

  get(key: string): StepResult | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  set(key: string, result: StepResult): void {
    this.cache.set(key, { result, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/** 创建验证流水线 */
export function createVerificationPipeline(config: VerificationPipelineConfig) {
  const executors = config.steps.map((step) =>
    createStepExecutor({
      ...step,
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.stepTimeoutMs ? { timeoutMs: config.stepTimeoutMs } : {}),
    }),
  );

  const cache = new VerificationCache();

  async function run(): Promise<VerificationResult> {
    const start = Date.now();
    const results: StepResult[] = [];
    const failedSteps: VerificationStepType[] = [];

    for (const executor of executors) {
      // 检查缓存
      const cacheKey = `${executor.step}:${config.cwd ?? process.cwd()}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        results.push(cached);
        if (!cached.success) failedSteps.push(cached.step);
        continue;
      }

      const result = await executor.execute();
      results.push(result);
      cache.set(cacheKey, result);

      if (!result.success) {
        failedSteps.push(result.step);
      }
    }

    return {
      success: failedSteps.length === 0,
      steps: results,
      totalDurationMs: Date.now() - start,
      failedSteps,
    };
  }

  return { run, cache };
}

// ─── 验证闭环 ───

/** 验证闭环配置 */
export interface VerificationLoopConfig {
  /** 验证流水线配置 */
  readonly pipeline: VerificationPipelineConfig;
  /** 最大修复轮次 */
  readonly maxFixRounds: number;
  /** 修复回调（Agent 根据错误信息修复代码） */
  readonly onFixNeeded?: (errors: readonly StepResult[]) => Promise<boolean>;
}

/** 创建验证闭环 */
export function createVerificationLoop(config: VerificationLoopConfig) {
  const pipeline = createVerificationPipeline(config.pipeline);

  async function run(): Promise<VerificationLoopResult> {
    const start = Date.now();
    const rounds: FixRoundResult[] = [];

    for (let round = 0; round <= config.maxFixRounds; round++) {
      const verificationResult = await pipeline.run();

      if (verificationResult.success) {
        return {
          success: true,
          rounds,
          totalDurationMs: Date.now() - start,
          totalRounds: round,
          finalVerification: verificationResult,
        };
      }

      // 最后一轮不再修复
      if (round >= config.maxFixRounds) {
        return {
          success: false,
          rounds,
          totalDurationMs: Date.now() - start,
          totalRounds: round,
          finalVerification: verificationResult,
        };
      }

      // 尝试修复
      const fixStart = Date.now();
      const failedSteps = verificationResult.steps.filter((s) => !s.success);

      let fixApplied = false;
      if (config.onFixNeeded) {
        try {
          fixApplied = await config.onFixNeeded(failedSteps);
        } catch {
          fixApplied = false;
        }
      }

      rounds.push({
        round,
        verificationResult,
        fixApplied,
        fixDurationMs: Date.now() - fixStart,
      });

      if (!fixApplied) {
        return {
          success: false,
          rounds,
          totalDurationMs: Date.now() - start,
          totalRounds: round + 1,
          finalVerification: verificationResult,
        };
      }

      // 修复后清除缓存，确保重新验证
      pipeline.cache.clear();
    }

    return {
      success: false,
      rounds,
      totalDurationMs: Date.now() - start,
      totalRounds: config.maxFixRounds,
      finalVerification: rounds[rounds.length - 1]?.verificationResult ?? {
        success: false,
        steps: [],
        totalDurationMs: 0,
        failedSteps: [],
      },
    };
  }

  return { run, pipeline };
}

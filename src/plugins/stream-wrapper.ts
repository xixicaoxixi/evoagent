/**
 * 流包装器链 — Provider 流的装饰器链（日志/重试/缓存）。
 *
 * 参考 `代码片段_状态管理与插件扩展` #22 composeProviderStreamWrappers()。
 *
 * 设计原则：
 * - 洋葱模型：从基础流开始，逐层包装
 * - 条件组合：通过 undefined 跳过不需要的包装器
 * - 高阶函数：每个包装器是 (T) => T 的变换
 */

// ─── 流包装器类型 ───

export type StreamWrapper<T> = (value: T) => T;

// ─── 流包装器配置 ───

export interface StreamWrapperConfig<T> {
  readonly wrappers: ReadonlyArray<StreamWrapper<T> | undefined>;
}

// ─── 组合流包装器 ───

/**
 * composeStreamWrappers — 将多个包装器按顺序组合。
 *
 * 参考 composeProviderStreamWrappers()：
 * - 过滤 undefined（跳过不需要的包装器）
 * - 按顺序从内到外包装（第一个包装器最接近核心）
 *
 * @example
 * ```ts
 * const wrapped = composeStreamWrappers(baseStream, [
 *   withLogging,    // 最内层
 *   withRetry,      // 中间层
 *   withCache,      // 最外层
 * ]);
 * ```
 */
export function composeStreamWrappers<T>(
  baseValue: T,
  wrappers: ReadonlyArray<StreamWrapper<T> | undefined>,
): T {
  let result = baseValue;
  for (const wrapper of wrappers) {
    if (wrapper !== undefined) {
      result = wrapper(result);
    }
  }
  return result;
}

// ─── 内置包装器工厂 ───

/**
 * createLoggingWrapper — 日志包装器。
 *
 * 在函数执行前后记录日志。
 */
export function createLoggingWrapper<T extends (...args: unknown[]) => unknown>(
  label: string,
  logger?: (message: string) => void,
): StreamWrapper<T> {
  const log = logger ?? console.log;
  return (fn: T): T => {
    return ((...args: unknown[]) => {
      log(`[${label}] called`);
      const result = fn(...args);
      log(`[${label}] completed`);
      return result;
    }) as T;
  };
}

/**
 * createRetryWrapper — 重试包装器。
 *
 * 失败时自动重试指定次数。
 */
export function createRetryWrapper<T extends (...args: unknown[]) => Promise<unknown>>(
  maxRetries: number,
  delayMs: number = 100,
): StreamWrapper<T> {
  return (fn: T): T => {
    return (async (...args: unknown[]) => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn(...args);
        } catch (error) {
          lastError = error;
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
      }
      throw lastError;
    }) as T;
  };
}

/**
 * createMemoizeWrapper — 缓存包装器。
 *
 * 相同参数返回缓存结果。
 */
export function createMemoizeWrapper<T extends (...args: unknown[]) => unknown>(
  keyFn?: (...args: unknown[]) => string,
): StreamWrapper<T> {
  const cache = new Map<string, unknown>();
  const getKey = keyFn ?? ((...args: unknown[]) => JSON.stringify(args));

  return (fn: T): T => {
    return ((...args: unknown[]) => {
      const key = getKey(...args);
      if (cache.has(key)) {
        return cache.get(key);
      }
      const result = fn(...args);
      cache.set(key, result);
      return result;
    }) as T;
  };
}

/**
 * createTimingWrapper — 计时包装器。
 *
 * 记录函数执行耗时。
 */
export function createTimingWrapper<T extends (...args: unknown[]) => unknown>(
  label: string,
  logger?: (message: string) => void,
): StreamWrapper<T> {
  const log = logger ?? console.log;
  return (fn: T): T => {
    return ((...args: unknown[]) => {
      const start = Date.now();
      const result = fn(...args);
      const duration = Date.now() - start;
      log(`[${label}] ${duration}ms`);
      return result;
    }) as T;
  };
}

/**
 * Promise 链式锁 — 轻量级异步互斥。
 *
 * 参考 `代码片段_状态管理与插件扩展` #11 locked()。
 * RULES_2-8: 串行化消竞态。
 *
 * 设计原则：
 * - 基于 Promise 链，不依赖原生锁原语
 * - resolveChain 确保链不会因异常中断
 * - 支持多级锁（全局锁 + per-key 锁）
 */

// ─── AsyncLock ───

export interface AsyncLockOptions {
  /** 最大等待队列长度（默认无限制） */
  readonly maxQueueSize?: number;
}

/**
 * createAsyncLock — 创建异步互斥锁。
 *
 * 同一锁上的操作按 FIFO 顺序串行执行。
 * 基于安全最佳实践的异步互斥锁实现。
 */
export function createAsyncLock(_options?: AsyncLockOptions) {
  let chain: Promise<void> = Promise.resolve();

  function resolveChain(promise: Promise<unknown>): Promise<void> {
    return promise.then(
      () => undefined,
      () => undefined,
    );
  }

  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chain;
    let resolveItem!: () => void;

    const next = new Promise<void>((resolve) => {
      resolveItem = resolve;
    });

    // 将 fn 链接到 prev 之后
    const result = resolveChain(prev).then(fn);

    // 保持链存活
    chain = result.then(
      () => { resolveItem(); },
      () => { resolveItem(); },
    );

    return result as Promise<T>;
  }

  return { locked };
}

/**
 * createKeyedAsyncLock — 创建按 key 分区的异步锁。
 *
 * 不同 key 的操作可并行，同一 key 的操作串行执行。
 */
export function createKeyedAsyncLock(options?: AsyncLockOptions) {
  const locks = new Map<string, ReturnType<typeof createAsyncLock>>();

  function getLock(key: string): ReturnType<typeof createAsyncLock> {
    let lock = locks.get(key);
    if (!lock) {
      lock = createAsyncLock(options);
      locks.set(key, lock);
    }
    return lock;
  }

  async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return getLock(key).locked(fn);
  }

  function getLockCount(): number {
    return locks.size;
  }

  return { locked, getLockCount };
}

// ─── DebouncedWrite ───

export interface DebouncedWrite<T> {
  readonly schedule: (data: T) => void;
  readonly flush: () => Promise<void>;
}

/**
 * createDebouncedWrite — 创建防抖写入函数。
 *
 * 多次快速调用 schedule 只会执行最后一次写入。
 * 适用于高频写入场景，减少 I/O 操作次数。
 */
export function createDebouncedWrite<T>(
  writeFn: (data: T) => Promise<void>,
  delayMs: number = 100,
): DebouncedWrite<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingData: T | undefined;
  let flushResolve: (() => void) | undefined;
  let flushPromise: Promise<void> | undefined;

  function schedule(data: T): void {
    pendingData = data;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(async () => {
      timer = undefined;
      if (pendingData !== undefined) {
        const toWrite = pendingData;
        pendingData = undefined;
        await writeFn(toWrite);
        if (flushResolve !== undefined) {
          flushResolve();
          flushResolve = undefined;
          flushPromise = undefined;
        }
      }
    }, delayMs);
  }

  async function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pendingData !== undefined) {
      const toWrite = pendingData;
      pendingData = undefined;
      await writeFn(toWrite);
    }
    if (flushPromise !== undefined) {
      await flushPromise;
    }
  }

  return { schedule, flush };
}

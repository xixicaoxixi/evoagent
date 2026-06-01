/**
 * 按键串行化队列 — KeyedAsyncQueue。
 *
 * 参考 `代码片段_Agent运行时与编排补充` #4 SessionActorQueue。
 * RULES_2-8: 串行化消竞态 — 按 key 串行化并发操作。
 *
 * 设计原则：
 * - 同一 key 的操作按序执行（FIFO）
 * - 不同 key 的操作可并行
 * - onEnqueue/onSettle 回调用于监控
 */

// ─── 队列项 ───

interface QueueItem<T> {
  readonly fn: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

// ─── KeyedAsyncQueue ───

export interface KeyedAsyncQueueOptions {
  readonly onEnqueue?: (key: string) => void;
  readonly onSettle?: (key: string) => void;
}

export class KeyedAsyncQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly options: KeyedAsyncQueueOptions;

  constructor(options?: KeyedAsyncQueueOptions) {
    this.options = options ?? {};
  }

  /**
   * enqueue — 按 key 串行化执行操作。
   *
   * 同一 key 的操作按 FIFO 顺序执行。
   * 不同 key 的操作可并行。
   */
  async enqueue<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.options.onEnqueue?.(key);

    const prev = this.tails.get(key) ?? Promise.resolve();
    let resolveItem: () => void;
    let rejectItem: (reason: unknown) => void;

    const next = new Promise<void>((resolve, reject) => {
      resolveItem = resolve;
      rejectItem = reject;
    });

    this.tails.set(key, next);

    // 链式执行：等待前一个操作完成后执行当前操作
    const result = prev.then(async () => {
      try {
        return await fn();
      } finally {
        resolveItem!();
      }
    }, (err) => {
      // 前一个操作失败不影响当前操作
      resolveItem!();
      throw err;
    });

    // 确保异常不会中断链
    result.catch(() => {
      // 异常已通过 fn 的 reject 传播
    });

    try {
      return await result as Promise<T>;
    } finally {
      this.options.onSettle?.(key);
    }
  }

  /**
   * getPendingCount — 获取指定 key 的待处理操作数（仅测试用）。
   */
  getPendingCount(key: string): number {
    return this.tails.has(key) ? 1 : 0;
  }

  /**
   * getTotalPendingKeys — 获取所有有待处理操作的 key 数量。
   */
  getTotalPendingKeys(): number {
    return this.tails.size;
  }
}

// ─── SessionActorQueue ───

export interface SessionActorQueueOptions {
  readonly onEnqueue?: (actorKey: string) => void;
  readonly onSettle?: (actorKey: string) => void;
}

/**
 * SessionActorQueue — 会话级串行化队列。
 *
 * 在 KeyedAsyncQueue 基础上叠加会话级监控。
 * 确保同一会话（actorKey）的操作按序执行，不同会话可并行。
 */
export class SessionActorQueue {
  private readonly queue: KeyedAsyncQueue;
  private readonly pendingBySession = new Map<string, number>();

  constructor(options?: SessionActorQueueOptions) {
    this.queue = new KeyedAsyncQueue({
      onEnqueue: options?.onEnqueue ?? (() => {}),
      onSettle: options?.onSettle ?? (() => {}),
    });
  }

  /**
   * run — 在指定会话中串行执行操作。
   */
  async run<T>(actorKey: string, op: () => Promise<T>): Promise<T> {
    this.pendingBySession.set(
      actorKey,
      (this.pendingBySession.get(actorKey) ?? 0) + 1,
    );

    try {
      return await this.queue.enqueue(actorKey, op);
    } finally {
      const pending = (this.pendingBySession.get(actorKey) ?? 1) - 1;
      if (pending <= 0) {
        this.pendingBySession.delete(actorKey);
      } else {
        this.pendingBySession.set(actorKey, pending);
      }
    }
  }

  /** 获取全局待处理操作数 */
  getTotalPendingCount(): number {
    let total = 0;
    for (const count of this.pendingBySession.values()) {
      total += count;
    }
    return total;
  }

  /** 获取指定会话的待处理操作数 */
  getPendingCountForSession(actorKey: string): number {
    return this.pendingBySession.get(actorKey) ?? 0;
  }

  /** 获取内部 Promise 链（仅测试用） */
  getTailMapForTesting(): Map<string, Promise<void>> {
    return this.queue["tails"] as unknown as Map<string, Promise<void>>;
  }
}

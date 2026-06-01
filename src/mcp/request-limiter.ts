export interface RequestLimiterStats {
  readonly maxConcurrency: number;
  readonly available: number;
  readonly pendingCount: number;
  readonly totalAcquired: number;
  readonly totalRejected: number;
  readonly totalTimedOut: number;
}

export interface RequestLimiter {
  acquire(timeoutMs?: number): Promise<() => void>;
  tryAcquire(): (() => void) | null;
  readonly stats: RequestLimiterStats;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createRequestLimiter(maxConcurrency: number = 2): RequestLimiter {
  let available = maxConcurrency;
  let totalAcquired = 0;
  let totalRejected = 0;
  let totalTimedOut = 0;
  const waiters: Waiter[] = [];

  function dispatch(): void {
    while (available > 0 && waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (waiter.timer !== null) {
        clearTimeout(waiter.timer);
      }
      available -= 1;
      totalAcquired += 1;
      waiter.resolve(createReleaser());
    }
  }

  function createReleaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      available += 1;
      dispatch();
    };
  }

  function acquire(timeoutMs?: number): Promise<() => void> {
    if (available > 0 && waiters.length === 0) {
      available -= 1;
      totalAcquired += 1;
      return Promise.resolve(createReleaser());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: null };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          totalTimedOut += 1;
          reject(new Error(`Request limiter: acquire timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      waiters.push(waiter);
    });
  }

  function tryAcquire(): (() => void) | null {
    if (available > 0 && waiters.length === 0) {
      available -= 1;
      totalAcquired += 1;
      return createReleaser();
    }
    totalRejected += 1;
    return null;
  }

  return {
    acquire,
    tryAcquire,
    get stats(): RequestLimiterStats {
      return {
        maxConcurrency,
        available,
        pendingCount: waiters.length,
        totalAcquired,
        totalRejected,
        totalTimedOut,
      };
    },
  };
}

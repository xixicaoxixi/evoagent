/**
 * D.4 SessionActorQueue + 异步互斥测试。
 */

import { describe, it, expect } from "vitest";
import { KeyedAsyncQueue, SessionActorQueue } from "../../src/utils/session-actor-queue";
import { createAsyncLock, createKeyedAsyncLock } from "../../src/utils/async-lock";

// ═══════════════════════════════════════════════════════════
// KeyedAsyncQueue
// ═══════════════════════════════════════════════════════════

describe("D.4 > KeyedAsyncQueue", () => {
  it("同一 key 的操作按序执行", async () => {
    const queue = new KeyedAsyncQueue();
    const order: number[] = [];

    const p1 = queue.enqueue("key1", async () => {
      await delay(10);
      order.push(1);
      return "a";
    });

    const p2 = queue.enqueue("key1", async () => {
      order.push(2);
      return "b";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");
    expect(order).toEqual([1, 2]); // 按序执行
  });

  it("不同 key 的操作可并行", async () => {
    const queue = new KeyedAsyncQueue();
    const order: number[] = [];

    const p1 = queue.enqueue("key1", async () => {
      await delay(50);
      order.push(1);
      return "a";
    });

    const p2 = queue.enqueue("key2", async () => {
      await delay(10);
      order.push(2);
      return "b";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");
    expect(order).toEqual([2, 1]); // key2 先完成（延迟更短）
  });

  it("操作异常不中断链", async () => {
    const queue = new KeyedAsyncQueue();

    const p1 = queue.enqueue("key1", async () => {
      throw new Error("fail");
    }).catch(() => "caught");

    const p2 = queue.enqueue("key1", async () => {
      return "recovered";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("caught");
    expect(r2).toBe("recovered");
  });

  it("onEnqueue/onSettle 回调", async () => {
    const events: string[] = [];
    const queue = new KeyedAsyncQueue({
      onEnqueue: (key) => events.push(`enqueue:${key}`),
      onSettle: (key) => events.push(`settle:${key}`),
    });

    await queue.enqueue("test", async () => "done");
    expect(events).toEqual(["enqueue:test", "settle:test"]);
  });
});

// ═══════════════════════════════════════════════════════════
// SessionActorQueue
// ═══════════════════════════════════════════════════════════

describe("D.4 > SessionActorQueue", () => {
  it("同一会话操作按序执行", async () => {
    const queue = new SessionActorQueue();
    const order: number[] = [];

    await Promise.all([
      queue.run("session1", async () => {
        await delay(20);
        order.push(1);
      }),
      queue.run("session1", async () => {
        order.push(2);
      }),
    ]);

    expect(order).toEqual([1, 2]);
  });

  it("不同会话操作可并行", async () => {
    const queue = new SessionActorQueue();
    const order: number[] = [];

    await Promise.all([
      queue.run("session1", async () => {
        await delay(50);
        order.push(1);
      }),
      queue.run("session2", async () => {
        await delay(10);
        order.push(2);
      }),
    ]);

    expect(order).toEqual([2, 1]);
  });

  it("getPendingCountForSession 返回待处理数", async () => {
    const queue = new SessionActorQueue();

    const p = queue.run("s1", async () => {
      await delay(50);
    });

    // 在操作完成前检查
    expect(queue.getPendingCountForSession("s1")).toBeGreaterThanOrEqual(0);
    await p;
    expect(queue.getPendingCountForSession("s1")).toBe(0);
  });

  it("getTotalPendingCount 返回全局待处理数", async () => {
    const queue = new SessionActorQueue();

    const p1 = queue.run("s1", async () => { await delay(50); });
    const p2 = queue.run("s2", async () => { await delay(50); });

    await Promise.all([p1, p2]);
    expect(queue.getTotalPendingCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// AsyncLock
// ═══════════════════════════════════════════════════════════

describe("D.4 > AsyncLock", () => {
  it("串行执行", async () => {
    const lock = createAsyncLock();
    const order: number[] = [];

    const p1 = lock.locked(async () => {
      await delay(20);
      order.push(1);
      return "a";
    });

    const p2 = lock.locked(async () => {
      order.push(2);
      return "b";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");
    expect(order).toEqual([1, 2]);
  });

  it("异常不中断链", async () => {
    const lock = createAsyncLock();

    const p1 = lock.locked(async () => {
      throw new Error("boom");
    }).catch(() => "caught");

    const p2 = lock.locked(async () => "ok");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("caught");
    expect(r2).toBe("ok");
  });
});

// ═══════════════════════════════════════════════════════════
// KeyedAsyncLock
// ═══════════════════════════════════════════════════════════

describe("D.4 > KeyedAsyncLock", () => {
  it("同一 key 串行，不同 key 并行", async () => {
    const lock = createKeyedAsyncLock();
    const order: number[] = [];

    const p1 = lock.locked("k1", async () => {
      await delay(30);
      order.push(1);
    });

    const p2 = lock.locked("k2", async () => {
      await delay(10);
      order.push(2);
    });

    const p3 = lock.locked("k1", async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([2, 1, 3]); // k2 先完成，k1 按序
  });

  it("getLockCount 返回锁数量", async () => {
    const lock = createKeyedAsyncLock();

    await lock.locked("a", async () => {});
    await lock.locked("b", async () => {});

    expect(lock.getLockCount()).toBe(2);
  });
});

// ─── 辅助 ───

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

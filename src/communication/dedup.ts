/**
 * BoundedUUIDSet — 环形缓冲区去重（RULES_2-15）。
 *
 * O(capacity) 内存有界集合，基于环形缓冲区实现。
 * 用于 P2P 消息去重和事件去重。
 */

// ─── 接口 ───

export interface BoundedUUIDSet {
  /** 添加 UUID（已存在则跳过） */
  add(uuid: string): boolean;
  /** 检查 UUID 是否存在 */
  has(uuid: string): boolean;
  /** 获取当前大小 */
  readonly size: number;
  /** 获取容量 */
  readonly capacity: number;
  /** 清空 */
  clear(): void;
}

// ─── 创建 ───

export function createBoundedUUIDSet(capacity: number): BoundedUUIDSet {
  if (capacity < 1) {
    throw new Error("Capacity must be at least 1");
  }

  const ring: Array<string | undefined> = new Array(capacity).fill(undefined);
  const set = new Set<string>();
  let writeIdx = 0;
  let count = 0;

  return {
    get size() {
      return count;
    },
    get capacity() {
      return capacity;
    },

    add(uuid: string): boolean {
      if (set.has(uuid)) return false;

      // 驱逐当前写入位置的旧条目
      const evicted = ring[writeIdx];
      if (evicted !== undefined) {
        set.delete(evicted);
      }

      ring[writeIdx] = uuid;
      set.add(uuid);
      writeIdx = (writeIdx + 1) % capacity;
      count = Math.min(count + 1, capacity);
      return true;
    },

    has(uuid: string): boolean {
      return set.has(uuid);
    },

    clear(): void {
      set.clear();
      ring.fill(undefined);
      writeIdx = 0;
      count = 0;
    },
  };
}

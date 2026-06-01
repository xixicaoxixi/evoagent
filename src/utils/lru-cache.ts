/**
 * LRU + TTL 有界缓存。
 *
 * 规则 #10（两层截断）：单条上限 + 总量上限。
 * 规则 #12（半衰期衰减）：TTL 过期自动淘汰。
 */

interface CacheEntry<V> {
  value: V;
  createdAt: number;
  lastAccessedAt: number;
}

export interface LRUCacheOptions {
  readonly maxSize: number;
  readonly ttlMs: number;
}

export class LRUCache<V> {
  private readonly cache = new Map<string, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options: LRUCacheOptions) {
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
  }

  get(key: string): V | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;

    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    entry.lastAccessedAt = Date.now();
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      this.cache.delete(key);
    }

    this.cache.set(key, {
      value,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    while (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

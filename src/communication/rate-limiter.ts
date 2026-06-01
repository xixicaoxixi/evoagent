/**
 * 滑动窗口限流器（RULES_2-17）。
 *
 * 带锁定的请求频率控制。
 * 用于 API 限流、进化触发预算、异常检测频率控制。
 */

// ─── 接口 ───

export interface RateLimiter {
  /** 检查是否允许请求 */
  check(key: string): RateLimiterCheck;
  /** 记录一次请求 */
  record(key: string): void;
  /** 获取指定 key 的当前计数 */
  getCount(key: string): number;
  /** 重置指定 key */
  reset(key: string): void;
  /** 清除所有 */
  clear(): void;
}

export interface RateLimiterCheck {
  readonly allowed: boolean;
  readonly currentCount: number;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
}

// ─── 配置 ───

export interface RateLimiterConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}

// ─── 创建 ───

export function createRateLimiter(
  config: RateLimiterConfig,
): RateLimiter {
  const windows = new Map<string, { count: number; startMs: number }>();

  function check(key: string): RateLimiterCheck {
    const now = Date.now();
    let entry = windows.get(key);

    // 窗口过期，重置
    if (entry === undefined || now - entry.startMs >= config.windowMs) {
      entry = { count: 0, startMs: now };
      windows.set(key, entry);
    }

    const allowed = entry.count < config.maxRequests;
    return {
      allowed,
      currentCount: entry.count,
      limit: config.maxRequests,
      remaining: Math.max(0, config.maxRequests - entry.count),
      resetAtMs: entry.startMs + config.windowMs,
    };
  }

  function record(key: string): void {
    const now = Date.now();
    let entry = windows.get(key);

    if (entry === undefined || now - entry.startMs >= config.windowMs) {
      entry = { count: 0, startMs: now };
      windows.set(key, entry);
    }

    entry.count++;
  }

  function getCount(key: string): number {
    const now = Date.now();
    const entry = windows.get(key);
    if (entry === undefined || now - entry.startMs >= config.windowMs) {
      return 0;
    }
    return entry.count;
  }

  function reset(key: string): void {
    windows.delete(key);
  }

  function clear(): void {
    windows.clear();
  }

  return { check, record, getCount, reset, clear };
}

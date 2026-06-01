/**
 * 速率限制中间件 — 滑动窗口 + 固定窗口双模式。
 *
 * 参考 `代码片段_基础设施与可观测性补充`：
 * - #3 认证滑动窗口速率限制器（auth-rate-limit）
 * - #4 控制面固定窗口速率限制器（control-plane-rate-limit）
 *
 * 设计原则：
 * - 滑动窗口：认证失败限制（按 IP + scope，超限锁定）
 * - 固定窗口：API 请求限制（按 IP，每窗口 N 次）
 * - 内存上限防护（最多 N 个桶，防止 CWE-400）
 * - 定期清理过期桶
 * - 回环地址豁免
 */

// ─── 速率限制检查结果 ───

export interface RateLimitCheckResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

// ─── 滑动窗口桶 ───

interface SlidingBucket {
  readonly attempts: number[];
  readonly lockedUntil: number;
}

// ─── 固定窗口桶 ───

interface FixedBucket {
  readonly count: number;
  readonly windowStart: number;
}

// ─── 滑动窗口速率限制器配置 ───

export interface SlidingRateLimitConfig {
  /** 最大尝试次数（默认 10） */
  readonly maxAttempts?: number;
  /** 窗口大小（毫秒，默认 60000） */
  readonly windowMs?: number;
  /** 锁定时间（毫秒，默认 300000 = 5 分钟） */
  readonly lockoutMs?: number;
  /** 最大桶数量（默认 10000） */
  readonly maxBuckets?: number;
  /** 回环地址豁免（默认 true） */
  readonly loopbackExempt?: boolean;
}

// ─── 固定窗口速率限制器配置 ───

export interface FixedRateLimitConfig {
  /** 每窗口最大请求数（默认 60） */
  readonly maxRequests?: number;
  /** 窗口大小（毫秒，默认 60000） */
  readonly windowMs?: number;
  /** 最大桶数量（默认 10000） */
  readonly maxBuckets?: number;
  /** 桶最大存活时间（毫秒，默认 300000） */
  readonly maxStaleMs?: number;
  /** 回环地址豁免（默认 true） */
  readonly loopbackExempt?: boolean;
}

// ─── 滑动窗口速率限制器接口 ───

export interface SlidingRateLimiter {
  /** 检查是否允许 */
  check(key: string): RateLimitCheckResult;
  /** 记录失败 */
  recordFailure(key: string): void;
  /** 重置 */
  reset(key: string): void;
  /** 桶数量 */
  size(): number;
  /** 清理过期桶 */
  prune(): number;
}

// ─── 固定窗口速率限制器接口 ───

export interface FixedRateLimiter {
  /** 检查并消费配额 */
  consume(key: string): RateLimitCheckResult;
  /** 桶数量 */
  size(): number;
  /** 清理过期桶 */
  prune(): number;
}

// ─── 判断是否为回环地址 ───

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "localhost" || address === "unknown";
}

// ─── 创建滑动窗口速率限制器 ───

export function createSlidingRateLimiter(config?: SlidingRateLimitConfig): SlidingRateLimiter {
  const maxAttempts = config?.maxAttempts ?? 10;
  const windowMs = config?.windowMs ?? 60_000;
  const lockoutMs = config?.lockoutMs ?? 300_000;
  const maxBuckets = config?.maxBuckets ?? 10_000;
  const loopbackExempt = config?.loopbackExempt ?? true;

  const buckets = new Map<string, SlidingBucket>();

  function now(): number {
    return Date.now();
  }

  function check(key: string): RateLimitCheckResult {
    if (loopbackExempt && isLoopback(key)) {
      return { allowed: true, remaining: maxAttempts, retryAfterMs: 0 };
    }

    const bucket = buckets.get(key);
    if (!bucket) {
      return { allowed: true, remaining: maxAttempts, retryAfterMs: 0 };
    }

    // 检查是否被锁定
    if (bucket.lockedUntil > now()) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: bucket.lockedUntil - now(),
      };
    }

    // 清理窗口外的尝试记录
    const cutoff = now() - windowMs;
    const recentAttempts = bucket.attempts.filter((t) => t > cutoff);
    const remaining = Math.max(0, maxAttempts - recentAttempts.length);

    return {
      allowed: remaining > 0,
      remaining,
      retryAfterMs: 0,
    };
  }

  function recordFailure(key: string): void {
    if (loopbackExempt && isLoopback(key)) return;

    const current = buckets.get(key);
    const cutoff = now() - windowMs;
    const attempts = current
      ? current.attempts.filter((t) => t > cutoff)
      : [];

    attempts.push(now());

    // 内存上限防护
    if (buckets.size >= maxBuckets && !buckets.has(key)) {
      prune();
    }

    // 检查是否需要锁定
    const lockedUntil = attempts.length >= maxAttempts ? now() + lockoutMs : 0;

    buckets.set(key, { attempts, lockedUntil });
  }

  function reset(key: string): void {
    buckets.delete(key);
  }

  function size(): number {
    return buckets.size;
  }

  function prune(): number {
    const cutoff = now() - windowMs - lockoutMs;
    let pruned = 0;
    for (const [key, bucket] of buckets) {
      if (bucket.lockedUntil < cutoff && (bucket.attempts.length === 0 || bucket.attempts[bucket.attempts.length - 1]! < cutoff)) {
        buckets.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  return { check, recordFailure, reset, size, prune };
}

// ─── 创建固定窗口速率限制器 ───

export function createFixedRateLimiter(config?: FixedRateLimitConfig): FixedRateLimiter {
  const maxRequests = config?.maxRequests ?? 60;
  const windowMs = config?.windowMs ?? 60_000;
  const maxBuckets = config?.maxBuckets ?? 10_000;
  const maxStaleMs = config?.maxStaleMs ?? 300_000;
  const loopbackExempt = config?.loopbackExempt ?? true;

  const buckets = new Map<string, FixedBucket>();

  function now(): number {
    return Date.now();
  }

  function consume(key: string): RateLimitCheckResult {
    if (loopbackExempt && isLoopback(key)) {
      return { allowed: true, remaining: maxRequests, retryAfterMs: 0 };
    }

    const current = buckets.get(key);
    const windowStart = Math.floor(now() / windowMs) * windowMs;

    if (!current || current.windowStart !== windowStart) {
      // 新窗口
      if (buckets.size >= maxBuckets && !buckets.has(key)) {
        prune();
      }
      buckets.set(key, { count: 1, windowStart });
      return { allowed: true, remaining: maxRequests - 1, retryAfterMs: 0 };
    }

    if (current.count >= maxRequests) {
      const retryAfterMs = (current.windowStart + windowMs) - now();
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, retryAfterMs),
      };
    }

    buckets.set(key, { count: current.count + 1, windowStart });
    return {
      allowed: true,
      remaining: maxRequests - current.count - 1,
      retryAfterMs: 0,
    };
  }

  function size(): number {
    return buckets.size;
  }

  function prune(): number {
    const cutoff = now() - maxStaleMs;
    let pruned = 0;
    for (const [key, bucket] of buckets) {
      if (bucket.windowStart < cutoff) {
        buckets.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  return { consume, size, prune };
}

// ─── 创建速率限制中间件 ───

import type { HttpRequest, HttpResponse, Middleware } from "../server";

export interface RateLimitMiddlewareConfig {
  /** 固定窗口限制器（用于 API 请求限制） */
  readonly fixedLimiter?: FixedRateLimiter;
  /** 滑动窗口限制器（用于认证失败限制） */
  readonly slidingLimiter?: SlidingRateLimiter;
}

export function createRateLimitMiddleware(config?: RateLimitMiddlewareConfig): Middleware {
  const fixedLimiter = config?.fixedLimiter ?? createFixedRateLimiter();
  const slidingLimiter = config?.slidingLimiter;

  return (req: HttpRequest, next: () => HttpResponse | Promise<HttpResponse>): HttpResponse | Promise<HttpResponse> => {
    // 固定窗口检查（所有请求）
    const fixedResult = fixedLimiter.consume(req.remoteAddress);
    if (!fixedResult.allowed) {
      return {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Remaining": "0",
          "Retry-After": String(Math.ceil(fixedResult.retryAfterMs / 1000)),
        },
        body: { error: "Too Many Requests", retryAfterMs: fixedResult.retryAfterMs },
      };
    }

    // 注入剩余配额到响应头（通过 context 传递）
    (req as { context: Record<string, unknown> }).context.rateLimitRemaining = fixedResult.remaining;

    return next();
  };
}

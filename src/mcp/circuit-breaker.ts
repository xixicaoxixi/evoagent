/**
 * MCP Circuit Breaker — per-endpoint 断路器状态机。
 *
 * 借鉴 src/llm/adapter.ts 中已有的 3 态断路器模式，
 * 为 MCP 客户端提供对不可达服务器的熔断保护。
 *
 * 状态转换：
 *   CLOSED ──(连续失败 ≥ threshold)──→ OPEN
 *   OPEN   ──(冷却期 expired)────────→ HALF_OPEN
 *   HALF_OPEN ──(探测成功)───────────→ CLOSED
 *   HALF_OPEN ──(探测失败)───────────→ OPEN
 *
 * 设计原则：
 * - Fail-Closed：OPEN 状态拒绝所有请求
 * - 可观测：状态变更通过 observer 回调上报
 * - 可配置：失败阈值和冷却时间可调
 */

// ─── 断路器状态 ───

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

// ─── 断路器配置 ───

export interface CircuitBreakerConfig {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
}

// ─── 断路器观测回调 ───

export interface CircuitBreakerObserver {
  readonly onStateChange?: (
    from: CircuitState,
    to: CircuitState,
    reason: string,
    context?: Readonly<Record<string, unknown>>,
  ) => void;
}

// ─── 断路器接口 ───

export interface CircuitBreaker {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly openedAt: number;
  canExecute(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
  reset(): void;
}

// ─── 默认值 ───

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

// ─── 创建断路器 ───

export function createCircuitBreaker(
  config?: CircuitBreakerConfig,
  observer?: CircuitBreakerObserver,
): CircuitBreaker {
  const failureThreshold = config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  let state: CircuitState = "CLOSED";
  let openedAt = 0;
  let failures = 0;

  function transitionTo(
    newState: CircuitState,
    reason: string,
    context?: Readonly<Record<string, unknown>>,
  ): void {
    const oldState = state;
    if (oldState === newState) return;
    state = newState;
    observer?.onStateChange?.(oldState, newState, reason, context);
  }

  function canExecute(): boolean {
    if (state === "CLOSED") return true;
    if (state === "OPEN") {
      if (Date.now() - openedAt >= cooldownMs) {
        transitionTo("HALF_OPEN", "cooldown_expired", {
          cooldownMs,
          elapsedMs: Date.now() - openedAt,
        });
        return true;
      }
      return false;
    }
    return true;
  }

  function recordSuccess(): void {
    if (state === "HALF_OPEN") {
      transitionTo("CLOSED", "probe_succeeded");
    }
    failures = 0;
  }

  function recordFailure(): void {
    failures++;
    if (state === "HALF_OPEN") {
      openedAt = Date.now();
      transitionTo("OPEN", "probe_failed", { consecutiveFailures: failures });
    } else if (state === "CLOSED" && failures >= failureThreshold) {
      openedAt = Date.now();
      transitionTo("OPEN", "failure_threshold_reached", {
        consecutiveFailures: failures,
        threshold: failureThreshold,
      });
    }
  }

  function reset(): void {
    transitionTo("CLOSED", "manual_reset");
    failures = 0;
    openedAt = 0;
  }

  return {
    get state() {
      return state;
    },
    get consecutiveFailures() {
      return failures;
    },
    get openedAt() {
      return openedAt;
    },
    canExecute,
    recordSuccess,
    recordFailure,
    reset,
  };
}

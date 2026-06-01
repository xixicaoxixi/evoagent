import type { InvocationPriority } from "../types/common";

export type { InvocationPriority } from "../types/common";

export type RetryEvent<T> =
  | { readonly type: "retrying"; readonly attempt: number; readonly delay: number; readonly kind: string }
  | { readonly type: "resolved"; readonly result: T; readonly attempt: number; readonly totalDelayMs: number }
  | { readonly type: "failed"; readonly error: Error; readonly attempt: number; readonly willRetry: boolean; readonly kind: string }
  | { readonly type: "depleted"; readonly lastError: Error; readonly totalAttempts: number };

export interface ResilienceConfig {
  readonly ceiling?: number;
  readonly baseDelayMs?: number;
  readonly capDelayMs?: number;
  readonly jitterRatio?: number;
  readonly serverRetryHint?: number | null;
  readonly priority?: InvocationPriority;
}

const DEFAULT_CEILING = 6;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_CAP_DELAY_MS = 32_000;
const DEFAULT_JITTER_RATIO = 0.25;

export interface ErrorClassification {
  readonly retryable: boolean;
  readonly kind: string;
}

export function calculateBackoff(attempt: number, config?: ResilienceConfig): number {
  const baseDelayMs = config?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const capDelayMs = config?.capDelayMs ?? DEFAULT_CAP_DELAY_MS;
  const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO;

  if (config?.serverRetryHint !== undefined && config.serverRetryHint !== null) {
    const hinted = config.serverRetryHint;
    const jittered = hinted * (1 + (Math.random() * 2 - 1) * jitterRatio);
    return Math.min(Math.max(0, Math.round(jittered)), capDelayMs);
  }

  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, capDelayMs);
  const jitter = cappedDelay * (1 + (Math.random() * 2 - 1) * jitterRatio);
  return Math.max(0, Math.round(jitter));
}

export async function* resilientInvoke<T>(
  fn: () => Promise<T>,
  classifyError: (e: unknown) => ErrorClassification,
  config?: ResilienceConfig,
): AsyncGenerator<RetryEvent<T>> {
  const ceiling = config?.ceiling ?? DEFAULT_CEILING;
  let totalDelayMs = 0;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= ceiling + 1; attempt++) {
    try {
      const result = await fn();
      yield {
        type: "resolved",
        result,
        attempt,
        totalDelayMs,
      };
      return;
    } catch (error) {
      const classification = classifyError(error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      lastError = errorObj;

      const isLastAttempt = attempt > ceiling;
      const shouldRetry = classification.retryable && !isLastAttempt;

      yield {
        type: "failed",
        error: errorObj,
        attempt,
        willRetry: shouldRetry,
        kind: classification.kind,
      };

      if (!shouldRetry) {
        yield {
          type: "depleted",
          lastError: errorObj,
          totalAttempts: attempt,
        };
        return;
      }

      const delay = calculateBackoff(attempt, config);
      totalDelayMs += delay;

      yield {
        type: "retrying",
        attempt: attempt + 1,
        delay,
        kind: classification.kind,
      };

      await sleep(delay);
    }
  }

  if (lastError) {
    yield {
      type: "depleted",
      lastError,
      totalAttempts: ceiling + 1,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPriorityAwareClassifier(
  priority: InvocationPriority,
): (e: unknown) => ErrorClassification {
  return (e: unknown): ErrorClassification => {
    const message = e instanceof Error ? e.message : String(e);

    let status: number | undefined;
    if (e instanceof Error) {
      const errorWithStatus = e as Error & { readonly status?: number };
      if (typeof errorWithStatus.status === "number") {
        status = errorWithStatus.status;
      }
    }

    const isAbort = e instanceof Error && e.name === "AbortError";
    const isTimeout = !isAbort && (
      message.toLowerCase().includes("timed out") ||
      message.toLowerCase().includes("timeout")
    );

    if (isAbort || isTimeout) {
      return { retryable: true, kind: "timeout" };
    }

    if (status !== undefined) {
      if (status === 401 || status === 403) {
        return { retryable: false, kind: "auth" };
      }
      if (status >= 500 && status < 600) {
        if (priority === "batch") {
          return { retryable: false, kind: "server" };
        }
        return { retryable: true, kind: "server" };
      }
    }

    const TRANSIENT_NETWORK_ERRORS = ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE"] as const;
    const PERMANENT_NETWORK_ERRORS = ["ECONNREFUSED", "ENOTFOUND", "ENOENT"] as const;

    const lowerMessage = message.toLowerCase();

    for (const pattern of TRANSIENT_NETWORK_ERRORS) {
      if (lowerMessage.includes(pattern.toLowerCase())) {
        return { retryable: true, kind: "network_transient" };
      }
    }
    for (const pattern of PERMANENT_NETWORK_ERRORS) {
      if (lowerMessage.includes(pattern.toLowerCase())) {
        return { retryable: false, kind: "network_permanent" };
      }
    }
    if (lowerMessage.includes("fetch failed")) {
      return { retryable: false, kind: "network_fetch" };
    }

    return { retryable: false, kind: "unknown" };
  };
}

export function getDefaultRetryConfig(priority: InvocationPriority): ResilienceConfig {
  switch (priority) {
    case "interactive":
      return {
        ceiling: 3,
        baseDelayMs: 1000,
        capDelayMs: 16_000,
        jitterRatio: 0.25,
        priority,
      };
    case "background":
      return {
        ceiling: 4,
        baseDelayMs: 750,
        capDelayMs: 16_000,
        jitterRatio: 0.2,
        priority,
      };
    case "batch":
      return {
        ceiling: 2,
        baseDelayMs: 500,
        capDelayMs: 8000,
        jitterRatio: 0.15,
        priority,
      };
  }
}

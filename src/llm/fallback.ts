import type {
  LLMProvider,
  LLMMessageParam,
  LLMResponse,
  LLMStreamChunk,
  StreamOptions,
} from "../interfaces/llm-provider";
import { resilientInvoke, type ResilienceConfig, type ErrorClassification } from "../utils/retry";
import { classifyNetworkError, ModelDegradationError } from "../utils/errors";
import type { InvocationPriority } from "../types/common";

const RETRYABLE_STATUS_CODES = new Set([401, 402, 403, 404, 429, 500, 502, 503]);

function isRetryableError(error: unknown): boolean {
  if (error instanceof ModelDegradationError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("rate limit") ||
      msg.includes("quota") ||
      msg.includes("insufficient") ||
      msg.includes("unauthorized") ||
      msg.includes("forbidden") ||
      msg.includes("429") ||
      msg.includes("402") ||
      msg.includes("401") ||
      msg.includes("404") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("timeout") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("model not found") ||
      msg.includes("does not exist")
    ) {
      return true;
    }
  }

  const status = (error as { status?: number }).status;
  if (status !== undefined && RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }
  return false;
}

function classifyFallbackError(e: unknown): ErrorClassification {
  const classification = classifyNetworkError(e);
  switch (classification.category) {
    case "timeout":
      return { retryable: true, kind: "timeout" };
    case "server":
      return { retryable: true, kind: "server" };
    case "auth":
      return { retryable: false, kind: "auth" };
    case "network":
      return { retryable: false, kind: "network" };
    default:
      return { retryable: false, kind: "unknown" };
  }
}

export interface FallbackProviderConfig {
  readonly providers: ReadonlyArray<LLMProvider>;
  readonly onFallback?: (fromType: string, toType: string, error: unknown) => void;
  /** H3: 重试配置（提供时使用 resilientInvoke 替代简单重试） */
  readonly retryConfig?: ResilienceConfig;
  /** H3: 调用优先级 */
  readonly priority?: InvocationPriority;
  /** H3: 降级触发阈值（连续失败次数，默认 3） */
  readonly degradationThreshold?: number;
}

export class FallbackProvider implements LLMProvider {
  private readonly providers: ReadonlyArray<LLMProvider>;
  private readonly onFallback?: ((fromType: string, toType: string, error: unknown) => void) | undefined;
  private activeIndex = 0;
  private readonly retryConfig: ResilienceConfig | undefined;
  private readonly priority: InvocationPriority | undefined;
  private readonly degradationThreshold: number;
  private failureStreak = 0;

  constructor(config: FallbackProviderConfig) {
    if (config.providers.length === 0) {
      throw new Error("FallbackProvider requires at least one provider");
    }
    this.providers = config.providers;
    this.onFallback = config.onFallback;
    this.retryConfig = config.retryConfig;
    this.priority = config.priority;
    this.degradationThreshold = config.degradationThreshold ?? 3;
  }

  get providerType(): string {
    return this.activeProvider.providerType;
  }

  get model(): string {
    return this.activeProvider.model;
  }

  get temperature(): number {
    return this.activeProvider.temperature;
  }

  get maxTokens(): number {
    return this.activeProvider.maxTokens;
  }

  private get activeProvider(): LLMProvider {
    return this.providers[this.activeIndex]!;
  }

  get activeProviderIndex(): number {
    return this.activeIndex;
  }

  get providerCount(): number {
    return this.providers.length;
  }

  get allProviderTypes(): ReadonlyArray<string> {
    return this.providers.map((p) => p.providerType);
  }

  private tryFallback(error: unknown): LLMProvider | null {
    const failedType = this.activeProvider.providerType;

    for (let i = 0; i < this.providers.length; i++) {
      if (i === this.activeIndex) continue;

      const candidate = this.providers[i]!;
      this.activeIndex = i;
      this.onFallback?.(failedType, candidate.providerType, error);
      console.error(`[Fallback] ${failedType} failed, switching to ${candidate.providerType}`);
      return candidate;
    }

    return null;
  }

  async invoke(messages: readonly LLMMessageParam[]): Promise<LLMResponse> {
    // H3: 使用 resilientInvoke 驱动重试（当 retryConfig 提供时）
    if (this.retryConfig || this.priority) {
      return this.invokeWithResilience(messages);
    }

    const tried = new Set<number>();
    let lastError: unknown = null;

    while (tried.size < this.providers.length) {
      tried.add(this.activeIndex);
      try {
        const result = await this.activeProvider.invoke(messages);
        this.failureStreak = 0;
        return result;
      } catch (err) {
        lastError = err;
        this.failureStreak++;
        if (!isRetryableError(err)) throw err;

        if (this.failureStreak >= this.degradationThreshold) {
          throw new ModelDegradationError(
            `FallbackProvider degraded after ${this.failureStreak} consecutive failures`,
            {
              sourceError: err instanceof Error ? err : new Error(String(err)),
              failureStreak: this.failureStreak,
              degradedFrom: this.activeProvider.model,
              degradedTo: "next_provider",
              trigger: "consecutive_failures",
            },
          );
        }

        const next = this.tryFallback(err);
        if (!next) throw err;
      }
    }

    throw lastError;
  }

  private async invokeWithResilience(messages: readonly LLMMessageParam[]): Promise<LLMResponse> {
    const tried = new Set<number>();
    let lastError: unknown = null;

    while (tried.size < this.providers.length) {
      tried.add(this.activeIndex);
      const currentProvider = this.activeProvider;

      const retryOpts: ResilienceConfig = {
        ceiling: this.retryConfig?.ceiling ?? 3,
        baseDelayMs: this.retryConfig?.baseDelayMs ?? 1000,
        capDelayMs: this.retryConfig?.capDelayMs ?? 8000,
        jitterRatio: this.retryConfig?.jitterRatio ?? 0.25,
        ...(this.priority !== undefined ? { priority: this.priority } : {}),
      };

      try {
        let result: LLMResponse | undefined;
        for await (const event of resilientInvoke(
          () => currentProvider.invoke(messages),
          classifyFallbackError,
          retryOpts,
        )) {
          if (event.type === "resolved") {
            result = event.result;
            this.failureStreak = 0;
            break;
          }
          if (event.type === "depleted") {
            this.failureStreak++;
            if (this.failureStreak >= this.degradationThreshold) {
              throw new ModelDegradationError(
                `FallbackProvider degraded after ${this.failureStreak} consecutive failures`,
                {
                  sourceError: event.lastError,
                  failureStreak: this.failureStreak,
                  degradedFrom: currentProvider.model,
                  degradedTo: "next_provider",
                  trigger: "consecutive_failures",
                },
              );
            }
            lastError = event.lastError;
            const next = this.tryFallback(event.lastError);
            if (!next) throw event.lastError;
            break;
          }
          if (event.type === "failed" && !event.willRetry) {
            const classification = classifyNetworkError(event.error);
            if (classification.category !== "server" && classification.category !== "timeout") {
              throw event.error;
            }
          }
        }

        if (result !== undefined) return result;
      } catch (error) {
        if (error instanceof ModelDegradationError) throw error;
        lastError = error;
        if (!isRetryableError(error)) throw error;
        const next = this.tryFallback(error);
        if (!next) throw error;
      }
    }

    throw lastError;
  }

  async *stream(messages: readonly LLMMessageParam[], options?: StreamOptions): AsyncGenerator<LLMStreamChunk> {
    const tried = new Set<number>();
    let lastError: unknown = null;

    while (tried.size < this.providers.length) {
      tried.add(this.activeIndex);
      let yieldedContent = false;
      let streamError: unknown = null;

      try {
        for await (const chunk of this.activeProvider.stream(messages, options)) {
          if (chunk.type === "error") {
            const errorMsg = (chunk as { error: string }).error;
            streamError = new Error(errorMsg);

            if (!yieldedContent && isRetryableError(streamError)) {
              break;
            }

            yield chunk;
            return;
          }

          if (chunk.type === "content" || chunk.type === "thinking") {
            yieldedContent = true;
          }
          yield chunk;
        }

        if (streamError && !yieldedContent) {
          lastError = streamError;
          const next = this.tryFallback(streamError);
          if (!next) {
            yield { type: "error", error: streamError instanceof Error ? streamError.message : String(streamError) } as LLMStreamChunk;
            return;
          }
          continue;
        }

        return;
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err)) {
          yield { type: "error", error: err instanceof Error ? err.message : String(err) } as LLMStreamChunk;
          return;
        }

        const next = this.tryFallback(err);
        if (!next) {
          yield { type: "error", error: err instanceof Error ? err.message : String(err) } as LLMStreamChunk;
          return;
        }
      }
    }

    yield { type: "error", error: lastError instanceof Error ? lastError.message : String(lastError) } as LLMStreamChunk;
  }

  countTokens(text: string): number {
    return this.activeProvider.countTokens(text);
  }

  async healthCheck(): Promise<boolean> {
    for (const provider of this.providers) {
      const healthy = await provider.healthCheck().catch(() => false);
      if (healthy) return true;
    }
    return false;
  }
}

export interface RunWithModelFallbackResult {
  readonly response: LLMResponse;
  readonly providerIndex: number;
  readonly retries: number;
}

export interface RunWithModelFallbackConfig {
  readonly providers: ReadonlyArray<LLMProvider>;
  readonly maxRetries?: number;
  readonly onFallback?: (fromIndex: number, toIndex: number, error: unknown) => void;
}

export async function runWithModelFallback(
  messages: readonly LLMMessageParam[],
  config: RunWithModelFallbackConfig,
): Promise<RunWithModelFallbackResult> {
  const maxRetries = config.maxRetries ?? config.providers.length - 1;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    for (let providerIdx = 0; providerIdx < config.providers.length; providerIdx++) {
      try {
        const response = await config.providers[providerIdx]!.invoke(messages);
        return { response, providerIndex: providerIdx, retries: attempt };
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err)) continue;
        config.onFallback?.(providerIdx, (providerIdx + 1) % config.providers.length, err);
      }
    }
  }

  throw new Error(`All providers failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

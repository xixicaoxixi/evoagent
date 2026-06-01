/**
 * LLM Adapter — 统一 Provider 适配接口。
 *
 * 将全局 LLMProvider（invoke 返回 LLMResponse）适配为各模块所需的简化接口。
 *
 * 阶段 A.1: Provider 注入管线基础设施。
 * 阶段 A.3: 网络错误分类集成 — safeInvoke 中使用 classifyNetworkError 分类错误。
 * 阶段 E.1: Token 预算管理集成。
 * 阶段 E.2: LLM 调用安全（净化、超时、统一降级）。
 *
 * 设计原则：
 * - 接口+注册表：先定义接口，再通过工厂函数创建实现
 * - 降级必须保留：所有 LLM 增强必须保留规则降级路径
 * - 单一职责：本文件只负责适配，不实现业务逻辑
 * - 安全优先：所有内部 LLM 调用经过 5 层净化管线
 */

import type { LLMProvider, LLMMessageParam } from "../interfaces/llm-provider";
import { sanitizeForLLM, shouldSanitizeForLLM } from "../security/llm-sanitize";
import { createBudgetManager, type LLMBudgetManager, type LLMBudgetConfig } from "./budget";
import { classifyNetworkError, type NetworkErrorClassification, LLMError, ModelDegradationError } from "../utils/errors";
import { resilientInvoke, type ResilienceConfig } from "../utils/retry";
import type { InvocationPriority } from "../types/common";
import { defaultLogger, type RetryStats } from "../observability/logger";
import { estimateTokens } from "../types/common";

// ─── 适配器配置 ───

export interface LLMAdapterConfig {
  readonly budget?: LLMBudgetConfig;
  readonly timeoutMs?: number;
  readonly skipSanitize?: boolean;
  readonly sanitizeMaxLength?: number;
  readonly adapterId?: string;
  readonly retryConfig?: ResilienceConfig;
  readonly degradationThreshold?: number;
  readonly priority?: InvocationPriority;
  readonly circuitCooldownMs?: number;
  readonly circuitFailureThreshold?: number;
}

// ─── Critic 模块所需的简化 LLM 接口 ───

export interface CriticLLMProvider {
  readonly name: string;
  invoke(messages: ReadonlyArray<{ readonly role: string; readonly content: string }>): Promise<string>;
}

// ─── 内部模块（Evolution/Strategy/SelfOptimizer/Anomaly/Dreaming）所需的简化 LLM 接口 ───

export interface SimpleLLMProvider {
  invoke(messages: ReadonlyArray<{ readonly role: string; readonly content: string }>, options?: { readonly temperature?: number }): Promise<string>;
}

// ─── 适配器结果 ───

export interface LLMAdapter {
  readonly criticProvider: CriticLLMProvider;
  readonly simpleProvider: SimpleLLMProvider;
  readonly originalProvider: LLMProvider;
  /** 预算管理器（用于查询预算状态） */
  readonly budgetManager: LLMBudgetManager;
  /** D.2: 连续失败计数 */
  readonly consecutiveFailures: () => number;
  /** D.2: 重置连续失败计数 */
  readonly resetFailures: () => void;
}

// ─── 默认值 ───

const DEFAULT_TIMEOUT_MS = 120_000;

const EVOAGENT_LLM_TIMEOUT_ENV = "EVOAGENT_LLM_TIMEOUT_MS";

function resolveTimeoutMs(configTimeout?: number): number {
  if (configTimeout !== undefined) return configTimeout;
  const envValue = parseInt(process.env[EVOAGENT_LLM_TIMEOUT_ENV] ?? "", 10);
  if (Number.isFinite(envValue) && envValue > 0) return envValue;
  return DEFAULT_TIMEOUT_MS;
}

// ─── 创建 LLM 适配器 ───

/**
 * createLLMAdapter — 将全局 LLMProvider 适配为各模块所需的简化接口。
 *
 * A.3: 集成 classifyNetworkError，根据错误分类决定日志级别。
 * E.1: 集成 Token 预算管理，每次调用前检查预算。
 * E.2: 集成 llm-sanitize 净化管线 + 超时控制 + 统一降级框架。
 *
 * @param provider - 全局 LLMProvider 实例
 * @param config - 适配器配置（可选）
 * @returns 包含 criticProvider、simpleProvider 和 budgetManager 的适配器
 */
export function createLLMAdapter(provider: LLMProvider, config?: LLMAdapterConfig): LLMAdapter {
  const budgetManager = createBudgetManager(config?.budget);
  const timeoutMs = resolveTimeoutMs(config?.timeoutMs);
  const skipSanitize = config?.skipSanitize ?? false;
  const adapterId = config?.adapterId ?? "llm-adapter";
  const logger = defaultLogger.child(adapterId);

  let failureStreak = 0;
  const degradationThreshold = config?.degradationThreshold ?? 3;

  type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
  let circuitState: CircuitState = "CLOSED";
  let circuitOpenedAt = 0;
  const CIRCUIT_COOLDOWN_MS = config?.circuitCooldownMs ?? 60_000;
  const CIRCUIT_FAILURE_THRESHOLD = config?.circuitFailureThreshold ?? 3;

  function consecutiveFailures(): number {
    return failureStreak;
  }

  function resetFailures(): void {
    failureStreak = 0;
  }

  /**
   * D.2: LLM 错误分类器。
   *
   * timeout/server → 可重试
   * auth → 不可重试
   * network/unknown → 不可重试
   */
  function classifyLLMError(e: unknown): { retryable: boolean; kind: string } {
    const classification = classifyNetworkError(e);
    switch (classification.category) {
      case "timeout":
        return { retryable: true, kind: "timeout" };
      case "server":
        return { retryable: true, kind: "server" };
      case "rate_limit":
        return { retryable: true, kind: "rate_limit" };
      default:
        return { retryable: false, kind: classification.category };
    }
  }

  /**
   * A.3: 根据网络错误分类记录不同级别的日志。
   *
   * - auth → warn（认证失败，需要人工介入）
   * - timeout → info（临时性问题，重试可能恢复）
   * - network → warn（网络问题，可能需要检查连接）
   * - server → error（服务端错误，可能影响所有用户）
   * - unknown → warn（未知错误，需要调查）
   */
  function logClassifiedError(
    classification: NetworkErrorClassification,
    module: string,
  ): void {
    const fields: Record<string, unknown> = {
      category: classification.category,
      module,
    };
    if ("status" in classification) {
      fields.status = classification.status;
    }

    switch (classification.category) {
      case "auth":
        logger.warn(`LLM auth error: ${classification.message}`, fields);
        break;
      case "rate_limit":
        logger.warn(`LLM rate limit error: ${classification.message}`, {
          ...fields,
          ...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
        });
        break;
      case "timeout":
        logger.info(`LLM timeout: ${classification.message}`, fields);
        break;
      case "network":
        logger.warn(`LLM network error: ${classification.message}`, fields);
        break;
      case "server":
        logger.error(`LLM server error: ${classification.message}`, fields);
        break;
      case "unknown":
        logger.warn(`LLM unknown error: ${classification.message}`, fields);
        break;
    }
  }

  /**
   * E.2: 统一降级框架 + D.2: 重试引擎集成。
   *
   * D.2: safeInvoke 使用 resilientInvoke 包装，timeout/server 错误触发重试。
   * 连续失败超过 degradationThreshold 时抛出 ModelDegradationError。
   */
  async function safeInvoke(
    messages: ReadonlyArray<{ readonly role: string; readonly content: string }>,
    module: string,
    options?: { readonly temperature?: number },
  ): Promise<string> {
    // E9: 断路器检查
    if (circuitState === "OPEN") {
      if (Date.now() - circuitOpenedAt >= CIRCUIT_COOLDOWN_MS) {
        circuitState = "HALF_OPEN";
        logger.info("Circuit breaker entering HALF_OPEN state", { module });
      } else {
        throw new ModelDegradationError(
          `Circuit breaker OPEN for ${provider.model}, cooldown remaining ${Math.ceil((CIRCUIT_COOLDOWN_MS - (Date.now() - circuitOpenedAt)) / 1000)}s`,
          {
            sourceError: new Error("circuit_open"),
            failureStreak,
            degradedFrom: provider.model,
            degradedTo: "fallback",
            trigger: "circuit_breaker",
          },
        );
      }
    }

    // E.1: 预算检查
    const budgetCheck = budgetManager.checkBudget(module);
    if (!budgetCheck.allowed) {
      throw new Error(`Budget exhausted for model ${provider.model} (module: ${module}): ${budgetCheck.reason}`);
    }

    // E.2: llm-sanitize 净化（5 层管线）
    let sanitizedMessages = messages;
    if (!skipSanitize && shouldSanitizeForLLM(provider.model)) {
      const sanitizeOpts = config?.sanitizeMaxLength !== undefined ? { maxLength: config.sanitizeMaxLength } : {};
      sanitizedMessages = messages.map((m) => ({
        role: m.role,
        content: sanitizeForLLM(m.content, sanitizeOpts).sanitized,
      }));
    }

    // A7: temperature=0 时注入确定性指令
    if (options?.temperature === 0) {
      const hasSystemMsg = sanitizedMessages.some((m) => m.role === "system");
      const determinismHint: { readonly role: string; readonly content: string } = {
        role: "system",
        content: "Be precise and deterministic. Output exact JSON without creative variation.",
      };
      if (hasSystemMsg) {
        sanitizedMessages = sanitizedMessages.map((m) =>
          m.role === "system"
            ? { role: m.role, content: `${m.content}\n\nBe precise and deterministic. Output exact JSON without creative variation.` }
            : m,
        );
      } else {
        sanitizedMessages = [determinismHint, ...sanitizedMessages];
      }
    }

    // 适配消息格式
    const adaptedMessages: readonly LLMMessageParam[] = sanitizedMessages.map((m) => ({
      role: m.role as LLMMessageParam["role"],
      content: m.content,
    }));

    // D.2: 使用 resilientInvoke 包装
    // 当未配置重试时（ceiling=0），超时/服务端错误不重试
    const retryCeiling = config?.retryConfig?.ceiling ?? 0;
    const retryOptsBase = {
      ceiling: retryCeiling,
      baseDelayMs: config?.retryConfig?.baseDelayMs ?? 1000,
      capDelayMs: config?.retryConfig?.capDelayMs ?? 8000,
      jitterRatio: config?.retryConfig?.jitterRatio ?? 0.25,
    };
    const retryOpts: ResilienceConfig = config?.priority !== undefined
      ? { ...retryOptsBase, priority: config.priority }
      : retryOptsBase;

    // M4: 重试统计追踪
    let retryCount = 0;
    let degradationCount = 0;
    let abandonCount = 0;
    const effectivePriority: InvocationPriority = config?.priority ?? "interactive";

    // A13: 累计 token 消耗
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;

    let response: Awaited<ReturnType<typeof provider.invoke>>;

    try {
      // 构建单次调用函数
      const invokeOnce = async (): Promise<string> => {
        // E.2: 超时控制 + E17: clearTimeout
        if (timeoutMs > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`LLM call to model ${provider.model} timed out after ${timeoutMs}ms (module: ${module})`)), timeoutMs);
          });
          try {
            const result = await Promise.race([
              provider.invoke(adaptedMessages).then((r) => r.content),
              timeoutPromise,
            ]);
            return result;
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        } else {
          const result = await provider.invoke(adaptedMessages);
          return result.content;
        }
      };

      // D.2: resilientInvoke 驱动重试
      let result: string | undefined;
      for await (const event of resilientInvoke(invokeOnce, classifyLLMError, retryOpts)) {
        if (event.type === "resolved") {
          result = event.result;
          failureStreak = 0;
          // E9: 断路器 — 成功时回到 CLOSED
          if (circuitState === "HALF_OPEN") {
            circuitState = "CLOSED";
            logger.info("Circuit breaker recovered to CLOSED state", { module });
          }
          // A13: 累计本次成功的 token
          cumulativeInputTokens += estimateTokens(adaptedMessages.map((m) => m.content).join(""));
          cumulativeOutputTokens += estimateTokens(result);
          // M4: 记录重试统计
          if (retryCount > 0 || degradationCount > 0 || abandonCount > 0) {
            defaultLogger.logRetryStats({
              priority: effectivePriority,
              retries: retryCount,
              degradations: degradationCount,
              abandons: abandonCount,
              module,
            });
          }
          break;
        }
        if (event.type === "depleted") {
          // D.2: 重试耗尽，检查是否需要降级
          failureStreak++;
          abandonCount++;
          // E9: 断路器 — 连续失败触发 OPEN
          if (failureStreak >= CIRCUIT_FAILURE_THRESHOLD && circuitState !== "OPEN") {
            circuitState = "OPEN";
            circuitOpenedAt = Date.now();
            logger.warn("Circuit breaker entering OPEN state", {
              model: provider.model,
              failureStreak,
              module,
            });
          }
          if (failureStreak >= degradationThreshold) {
            degradationCount++;
            logger.error(`Model degradation triggered: ${failureStreak} consecutive failures`, {
              model: provider.model,
              failureStreak,
              module,
            });
            // M4: 记录重试统计
            defaultLogger.logRetryStats({
              priority: effectivePriority,
              retries: retryCount,
              degradations: degradationCount,
              abandons: abandonCount,
              module,
            });
            throw new ModelDegradationError(
              `Model ${provider.model} degraded after ${failureStreak} consecutive failures`,
              {
                sourceError: event.lastError,
                failureStreak,
                degradedFrom: provider.model,
                degradedTo: "fallback",
                trigger: "consecutive_failures",
              },
            );
          }
          throw event.lastError;
        }
        if (event.type === "failed" && !event.willRetry) {
          // 不可重试错误（auth/network）— 立即失败，不等待 depleted
          // E9: HALF_OPEN 中失败 → 回到 OPEN
          if (circuitState === "HALF_OPEN") {
            circuitState = "OPEN";
            circuitOpenedAt = Date.now();
            logger.warn("Circuit breaker test call failed, returning to OPEN state", { module });
          }
          // 但如果是重试耗尽导致的 willRetry=false，由 depleted 处理
          const classification = classifyNetworkError(event.error);
          if (classification.category !== "server" && classification.category !== "timeout" && classification.category !== "rate_limit") {
            // 非 server/timeout 的不可重试错误：立即抛出
            failureStreak++;
            logClassifiedError(classification, module);

            const llmOpts: { statusCode?: number; retryable?: boolean; cause?: Error } = {
              retryable: false,
            };
            if ("status" in classification) {
              llmOpts.statusCode = classification.status;
            }
            llmOpts.cause = event.error;
            throw new LLMError(classification.message, provider.model, llmOpts);
          }
          // server/timeout 重试耗尽：继续到 depleted 处理
        }
        // retrying 事件 — 日志记录
        if (event.type === "retrying") {
          retryCount++;
          logger.info(`Retrying LLM call: attempt ${event.attempt}, delay ${event.delay}ms`, {
            module,
            kind: event.kind,
            attempt: event.attempt,
            delay: event.delay,
          });
        }
      }

      if (result === undefined) {
        throw new Error(`resilientInvoke completed without result for model ${provider.model} (module: ${module}, retries: ${retryCount})`);
      }

      // E.1: 记录 token 使用（A13: 使用累计值）
      budgetManager.recordUsage(module, cumulativeInputTokens, cumulativeOutputTokens);
      return result;
    } catch (error) {
      if (error instanceof ModelDegradationError) throw error;
      if (error instanceof LLMError) throw error;

      // 未预期的错误
      const classification = classifyNetworkError(error);
      logClassifiedError(classification, module);
      throw error;
    }
  }

  const simpleProvider: SimpleLLMProvider = {
    invoke: (messages, options) => safeInvoke(messages, `${adapterId}:simple`, options),
  };

  const criticProvider: CriticLLMProvider = {
    name: provider.model,
    invoke: (messages) => safeInvoke(messages, `${adapterId}:critic`),
  };

  return {
    criticProvider,
    simpleProvider,
    originalProvider: provider,
    budgetManager,
    consecutiveFailures,
    resetFailures,
  };
}

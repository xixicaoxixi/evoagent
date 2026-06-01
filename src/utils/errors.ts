/**
 * 结构化错误类型体系 — EvoAgent 所有自定义错误的基类与工具函数。
 *
 * 设计原则：
 * - 错误即数据：工具错误封装为结构化结果，而非中断循环的异常
 * - 错误分类驱动：网络错误分类（auth/timeout/network/server/unknown）指导降级策略
 * - 因果链追踪：EvoAgentError.cause 支持错误链，便于根因分析
 * - 安全报告：SafeReportError 标记确保错误消息不含敏感数据
 *
 * RULES_1-3: Discriminated Union（NetworkErrorClassification.category 区分）
 * RULES_1-4: Branded Types（SafeReportError 通过 JSDoc 标记）
 */

// ─── EvoAgentError 基类 ───

export class EvoAgentError extends Error {
  /** 机器可读的错误码（如 'SHELL_EXIT_NONZERO'、'CONFIG_PARSE_FAILED'） */
  readonly code: string;
  /** 结构化上下文字段，用于日志和调试 */
  readonly context?: Readonly<Record<string, unknown>>;
  /** 原始错误（因果链） */
  readonly cause?: Error;

  constructor(
    message: string,
    code: string,
    options?: {
      readonly context?: Readonly<Record<string, unknown>>;
      readonly cause?: Error;
    },
  ) {
    super(message);
    this.name = "EvoAgentError";
    this.code = code;
    if (options?.context !== undefined) {
      this.context = options.context;
    }
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

// ─── 领域错误子类 ───

/**
 * ShellError — Shell 命令执行失败。
 *
 * 包含 stdout/stderr/exitCode，便于模型理解命令失败原因。
 */
export class ShellError extends EvoAgentError {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly wasSignaled: boolean;

  constructor(
    message: string,
    options: {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly exitCode?: number | null;
      readonly wasSignaled?: boolean;
      readonly cause?: Error;
    } = {},
  ) {
    const causeOpt = options.cause !== undefined ? { cause: options.cause } : undefined;
    const contextOpt = {
      stdout: options.stdout ?? "",
      stderr: options.stderr ?? "",
      exitCode: options.exitCode ?? null,
      wasSignaled: options.wasSignaled ?? false,
    };
    super(message, "SHELL_EXIT_NONZERO", {
      context: contextOpt,
      ...causeOpt,
    });
    this.name = "ShellError";
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.exitCode = options.exitCode ?? null;
    this.wasSignaled = options.wasSignaled ?? false;
  }
}

/**
 * ConfigParseError — 配置文件解析失败。
 *
 * 包含 filePath 和 fallbackConfig，支持降级到默认配置。
 */
export class ConfigParseError extends EvoAgentError {
  readonly filePath: string;
  readonly fallbackConfig: unknown;

  constructor(
    message: string,
    filePath: string,
    fallbackConfig?: unknown,
    options?: { readonly cause?: Error },
  ) {
    const causeOpt = options?.cause !== undefined ? { cause: options.cause } : undefined;
    super(message, "CONFIG_PARSE_FAILED", {
      context: { filePath },
      ...causeOpt,
    });
    this.name = "ConfigParseError";
    this.filePath = filePath;
    this.fallbackConfig = fallbackConfig;
  }
}

/**
 * SandboxError — 沙箱安全违规。
 *
 * violationType 区分文件系统/网络/进程违规。
 */
export class SandboxError extends EvoAgentError {
  readonly violationType: "filesystem" | "network" | "process";

  constructor(
    message: string,
    violationType: "filesystem" | "network" | "process",
    options?: { readonly cause?: Error },
  ) {
    const causeOpt = options?.cause !== undefined ? { cause: options.cause } : undefined;
    super(message, "SANDBOX_VIOLATION", {
      context: { violationType },
      ...causeOpt,
    });
    this.name = "SandboxError";
    this.violationType = violationType;
  }
}

/**
 * LLMError — LLM 调用失败。
 *
 * 包含 model、statusCode、retryable，驱动重试/降级决策。
 */
export class LLMError extends EvoAgentError {
  readonly model: string;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    model: string,
    options?: {
      readonly statusCode?: number;
      readonly retryable?: boolean;
      readonly cause?: Error;
    },
  ) {
    const causeOpt = options?.cause !== undefined ? { cause: options.cause } : undefined;
    const statusCode = options?.statusCode;
    const contextOpt: Record<string, unknown> = {
      model,
      retryable: options?.retryable ?? false,
    };
    if (statusCode !== undefined) {
      contextOpt.statusCode = statusCode;
    }
    super(message, "LLM_INVOKE_FAILED", {
      context: contextOpt,
      ...causeOpt,
    });
    this.name = "LLMError";
    this.model = model;
    if (statusCode !== undefined) {
      this.statusCode = statusCode;
    }
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * ModelDegradationError — 模型降级事件。
 *
 * 阶段 D 使用：连续失败触发降级时抛出。
 */
export class ModelDegradationError extends EvoAgentError {
  readonly sourceError: Error;
  readonly failureStreak: number;
  readonly degradedFrom: string;
  readonly degradedTo: string;
  readonly trigger: string;

  constructor(
    message: string,
    options: {
      readonly sourceError: Error;
      readonly failureStreak: number;
      readonly degradedFrom: string;
      readonly degradedTo: string;
      readonly trigger: string;
    },
  ) {
    super(message, "MODEL_DEGRADATION", {
      context: {
        failureStreak: options.failureStreak,
        degradedFrom: options.degradedFrom,
        degradedTo: options.degradedTo,
        trigger: options.trigger,
      },
      cause: options.sourceError,
    });
    this.name = "ModelDegradationError";
    this.sourceError = options.sourceError;
    this.failureStreak = options.failureStreak;
    this.degradedFrom = options.degradedFrom;
    this.degradedTo = options.degradedTo;
    this.trigger = options.trigger;
  }
}

// ─── SafeReportError ───

/**
 * SafeReportError — 标记错误消息可安全报告给用户/模型。
 *
 * 使用 JSDoc @safeToReport 标记，确保错误消息不含敏感数据（API Key、路径等）。
 * 包装任意错误为安全报告格式。
 */
export class SafeReportError extends EvoAgentError {
  constructor(
    message: string,
    code: string,
    options?: {
      readonly context?: Readonly<Record<string, unknown>>;
      readonly cause?: Error;
    },
  ) {
    super(message, code, options);
    this.name = "SafeReportError";
  }
}

// ─── 网络错误分类（Discriminated Union） ───

export type NetworkErrorClassification =
  | { readonly category: "auth"; readonly status: number; readonly message: string }
  | { readonly category: "rate_limit"; readonly status: number; readonly message: string; readonly retryAfterMs?: number }
  | { readonly category: "timeout"; readonly message: string }
  | { readonly category: "network"; readonly message: string }
  | { readonly category: "server"; readonly status: number; readonly message: string }
  | { readonly category: "unknown"; readonly message: string };

// ─── 工具函数 ───

/**
 * isCancellation — 统一识别中止来源。
 *
 * 识别 Bun 原生 AbortError、DOMException（.name === 'AbortError'）。
 */
export function isCancellation(e: unknown): boolean {
  if (e instanceof Error) {
    if (e.name === "AbortError") return true;
    // DOMException 在 Bun 环境中可能不可用，使用类型守卫
    if (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") return true;
  }
  return false;
}

/**
 * normalizeError — 将任意值规范化为 EvoAgentError。
 *
 * 已是 EvoAgentError 直接返回；Error 子类包装为通用 EvoAgentError；
 * 非 Error 值转为字符串消息。
 */
export function normalizeError(e: unknown): EvoAgentError {
  if (e instanceof EvoAgentError) return e;
  if (e instanceof Error) {
    return new EvoAgentError(e.message, "UNKNOWN_ERROR", { cause: e });
  }
  return new EvoAgentError(String(e), "UNKNOWN_ERROR");
}

/**
 * extractErrorMessage — 从任意值中提取可读错误消息。
 *
 * 优先使用 SafeReportError 的消息（已确认安全），其次使用 Error.message，最后 String()。
 */
export function extractErrorMessage(e: unknown): string {
  if (e instanceof SafeReportError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * truncateStack — 截断堆栈跟踪到指定帧数。
 *
 * 用于工具错误结果中附带堆栈，避免浪费模型上下文 token。
 * 默认最多 3 帧。
 */
export function truncateStack(e: unknown, maxFrames: number = 3): string {
  if (!(e instanceof Error) || !e.stack) return "";
  const lines = e.stack.split("\n");
  // 保留第一行（错误消息）+ maxFrames 帧堆栈
  const header = lines[0] ?? "";
  const frames = lines.slice(1, 1 + maxFrames);
  return [header, ...frames].join("\n");
}

/**
 * isPathUnreachable — 判断错误是否为路径不可达。
 *
 * 检测 ENOENT、EACCES、ENOTDIR 等 Node.js 文件系统错误码。
 */
export function isPathUnreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const nodeError = e as Error & { readonly code?: string };
  const unreachableCodes = new Set([
    "ENOENT",
    "EACCES",
    "EISDIR",
    "ENOTDIR",
    "EPERM",
    "EROFS",
  ]);
  return nodeError.code !== undefined && unreachableCodes.has(nodeError.code);
}

/**
 * classifyNetworkError — 网络错误分类。
 *
 * 根据错误特征分类为 auth/timeout/network/server/unknown 五类。
 * 用于 LLM 适配器的重试/降级决策。
 *
 * 分类规则：
 * - auth: HTTP 401/403
 * - timeout: AbortError / 超时消息
 * - server: HTTP 5xx
 * - network: DNS 解析失败 / ECONNREFUSED / ENOTFOUND
 * - unknown: 其他
 */
export function classifyNetworkError(e: unknown): NetworkErrorClassification {
  const message = e instanceof Error ? e.message : String(e);

  if (e instanceof LLMError && e.statusCode !== undefined) {
    const status = e.statusCode;
    if (status === 401 || status === 403) {
      return { category: "auth", status, message };
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(e);
      return { category: "rate_limit", status, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    if (status >= 500 && status < 600) {
      return { category: "server", status, message };
    }
  }

  if (e instanceof Error) {
    const errorWithStatus = e as Error & { readonly status?: number };
    if (typeof errorWithStatus.status === "number") {
      const status = errorWithStatus.status;
      if (status === 401 || status === 403) {
        return { category: "auth", status, message };
      }
      if (status === 429) {
        const retryAfterMs = parseRetryAfter(e);
        return { category: "rate_limit", status, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      }
      if (status >= 500 && status < 600) {
        return { category: "server", status, message };
      }
    }
  }

  // 检查中止/超时
  if (isCancellation(e)) {
    return { category: "timeout", message };
  }
  if (
    message.toLowerCase().includes("timed out") ||
    message.toLowerCase().includes("timeout") ||
    message.toLowerCase().includes("deadline")
  ) {
    return { category: "timeout", message };
  }

  // 检查网络层错误
  const networkPatterns = [
    "ECONNREFUSED",
    "ENOTFOUND",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "fetch failed",
    "network error",
    "dns",
  ];
  const lowerMessage = message.toLowerCase();
  if (networkPatterns.some((p) => lowerMessage.includes(p.toLowerCase()))) {
    return { category: "network", message };
  }

  return { category: "unknown", message };
}

function parseRetryAfter(e: Error): number | undefined {
  const headers = (e as Error & { readonly headers?: { readonly get?: (name: string) => string | null } }).headers;
  if (headers && typeof headers.get === "function") {
    const retryAfter = headers.get("retry-after");
    if (retryAfter !== null) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }
  }
  return undefined;
}

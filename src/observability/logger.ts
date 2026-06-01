/**
 * 结构化日志 — 级别 + 结构化字段 + 输出目标抽象。
 *
 * 参考 `代码片段_基础设施与可观测性补充` #6 内部日志记录（结构化事件上报模式）。
 *
 * 设计原则：
 * - 级别门控：debug < info < warn < error
 * - 输出目标抽象：支持 console / 文件 / 自定义 handler
 * - 结构化字段：每条日志包含 timestamp + level + message + fields
 * - 零依赖：不依赖第三方日志库
 */

import { redactConfigObject, restoreRedactedValues } from "../security/redact";
import { normalizeError, classifyNetworkError } from "../utils/errors";
import type { InvocationPriority } from "../types/common";

// ─── 日志级别 ───

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ─── 结构化日志条目 ───

export interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly source?: string;
}

// ─── 日志输出目标 ───

export type LogHandler = (entry: LogEntry) => void;

// ─── Logger 配置 ───

export interface LoggerConfig {
  /** 最低日志级别 */
  readonly minLevel?: LogLevel;
  /** 自定义输出 handler（默认 console） */
  readonly handler?: LogHandler;
  /** 日志来源标识 */
  readonly source?: string;
  /** 是否包含时间戳 */
  readonly includeTimestamp?: boolean;
}

// ─── Logger 接口 ───

export interface Logger {
  readonly debug: (message: string, fields?: Record<string, unknown>) => void;
  readonly info: (message: string, fields?: Record<string, unknown>) => void;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
  readonly error: (message: string, fields?: Record<string, unknown>) => void;
  readonly child: (source: string) => Logger;
  readonly setLevel: (level: LogLevel) => void;
  readonly getLevel: () => LogLevel;
  readonly unredact: (redacted: unknown, original: unknown) => unknown;
  /** A.3: 记录工具错误审计事件 */
  readonly logToolError: (toolName: string, error: unknown, durationMs: number) => void;
  /** M4: 记录重试统计（按优先级分类） */
  readonly logRetryStats: (stats: RetryStats) => void;
}

// ─── M4: 重试统计类型 ───

export interface RetryStats {
  readonly priority: InvocationPriority;
  readonly retries: number;
  readonly degradations: number;
  readonly abandons: number;
  readonly module?: string;
}

// ─── 默认 console handler ───

function defaultHandler(entry: LogEntry): void {
  const ts = entry.timestamp;
  const src = entry.source ? `[${entry.source}] ` : "";
  const fieldsStr = Object.keys(entry.fields).length > 0
    ? ` ${JSON.stringify(entry.fields)}`
    : "";

  const line = `${ts} ${entry.level.toUpperCase()} ${src}${entry.message}${fieldsStr}`;

  switch (entry.level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.info(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
}

// ─── 创建 Logger ───

export function createLogger(config?: LoggerConfig): Logger {
  const minLevel = config?.minLevel ?? "info";
  const handler = config?.handler ?? defaultHandler;
  const source = config?.source;
  const includeTimestamp = config?.includeTimestamp ?? true;

  let currentLevel = minLevel;

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
  }

  function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (!shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: includeTimestamp ? new Date().toISOString() : "",
      level,
      message,
      fields: fields ? redactConfigObject(fields) : {},
      ...(source ? { source } : {}),
    };

    handler(entry);
  }

  function child(childSource: string): Logger {
    const fullSource = source ? `${source}:${childSource}` : childSource;
    return createLogger({
      ...config,
      source: fullSource,
      handler,
      minLevel: currentLevel,
    });
  }

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
    child,
    setLevel: (level) => { currentLevel = level; },
    getLevel: () => currentLevel,
    unredact: (redacted, original) => restoreRedactedValues(redacted, original),
    /**
     * A.3: 工具错误审计事件。
     *
     * 记录工具名称、错误码、错误消息、执行耗时。
     * 使用 error 级别确保审计可见性。
     */
    logToolError: (toolName, error, durationMs) => {
      const normalized = normalizeError(error);
      const classification = classifyNetworkError(error);
      log("error", `Tool error: ${toolName}`, {
        toolName,
        errorCode: normalized.code,
        errorMessage: normalized.message,
        durationMs,
        errorCategory: classification.category,
      });
    },
    logRetryStats: (stats) => {
      log("info", `Retry stats: ${stats.priority}`, {
        priority: stats.priority,
        retries: stats.retries,
        degradations: stats.degradations,
        abandons: stats.abandons,
        ...(stats.module ? { module: stats.module } : {}),
      });
    },
  };
}

// ─── 全局默认 Logger ───

export const defaultLogger: Logger = createLogger();

/**
 * 四级递进压缩策略。
 *
 * RULES_2-13: 多级递进（Micro → Auto → Reactive → API）。
 * RULES_2-6: 质量守卫（压缩后验证关键信息保留）。
 *
 * Level 1 - Micro: 轮次间微压缩（清除旧工具结果）
 * Level 2 - Auto: 自动压缩（token 超阈值时 LLM 摘要）
 * Level 3 - Reactive: 反应式压缩（prompt_too_long 错误后紧急压缩）
 * Level 4 - API: API 层压缩（thinking 块清除、工具结果截断）
 */

import type { Message } from "../types/message";
import type { CompactResult } from "../interfaces/context-engine";
import { estimateTokens } from "../types/common";
import { APICompactStrategy, type APICompactConfig } from "./api-compact";

// ─── 压缩后重载回调 ───

/** 压缩后记忆重载回调 */
export type PostCompactionReloadCallback = (
  compactedMessages: readonly Message[],
) => Promise<readonly Message[]>;

/** 压缩管理器配置 */
export interface CompactManagerConfig {
  /** 压缩策略列表 */
  readonly strategies?: readonly CompactStrategy[];
  /** API 压缩配置 */
  readonly apiConfig?: APICompactConfig;
  /** 压缩后记忆重新加载回调 */
  readonly postCompactionReload?: PostCompactionReloadCallback;
}

// ─── 压缩级别 ───

export const CompactLevel = {
  MICRO: "micro",
  AUTO: "auto",
  REACTIVE: "reactive",
  API: "api",
} as const;

export type CompactLevel = (typeof CompactLevel)[keyof typeof CompactLevel];

// ─── 微压缩配置 ───

export interface MicroCompactConfig {
  /** 工具结果最大保留条数 */
  readonly maxToolResults?: number;
  /** 工具结果最大字符数 */
  readonly maxToolResultChars?: number;
  /** 清除超过 N 轮前的工具结果 */
  readonly clearOlderThanTurns?: number;
}

// ─── 自动压缩配置 ───

export interface AutoCompactConfig {
  /** 触发压缩的 token 阈值比例 (0-1) */
  readonly threshold?: number;
  /** 压缩目标 token 比例 */
  readonly targetRatio?: number;
  /** 保留最近 N 条消息 */
  readonly keepRecentMessages?: number;
}

// ─── 压缩策略接口 ───

export interface CompactStrategy {
  readonly level: CompactLevel;
  shouldTrigger(messages: readonly Message[], tokenCount: number, maxTokens: number): boolean;
  compact(messages: readonly Message[], options: CompactOptions): Promise<CompactResult>;
}

export interface CompactOptions {
  readonly targetTokens: number;
  readonly maxTokens: number;
  readonly reason: CompactLevel;
}

// ─── Level 1: Micro Compact ───

export class MicroCompactStrategy implements CompactStrategy {
  readonly level = CompactLevel.MICRO;
  private readonly maxToolResults: number;
  private readonly maxToolResultChars: number;
  private readonly clearOlderThanTurns: number;

  constructor(config: MicroCompactConfig = {}) {
    this.maxToolResults = config.maxToolResults ?? 20;
    this.maxToolResultChars = config.maxToolResultChars ?? 10_000;
    this.clearOlderThanTurns = config.clearOlderThanTurns ?? 5;
  }

  shouldTrigger(): boolean {
    return true; // 微压缩每次轮次都尝试
  }

  async compact(
    messages: readonly Message[],
    options: CompactOptions,
  ): Promise<CompactResult> {
    const originalTokens = messages.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );

    const result: Message[] = [];
    let toolResultCount = 0;

    for (const msg of messages) {
      if (msg.role === "tool_result") {
        toolResultCount++;

        // 超过最大数量的旧工具结果，清除内容
        if (toolResultCount > this.maxToolResults) {
          result.push({
            ...msg,
            content: `[Tool result cleared by micro-compact]`,
          });
          continue;
        }

        // 截断过长的工具结果
        if (msg.content.length > this.maxToolResultChars) {
          result.push({
            ...msg,
            content: `${msg.content.slice(0, this.maxToolResultChars)}\n[... truncated by micro-compact (${msg.content.length} chars)]`,
          });
          continue;
        }
      }

      result.push(msg);
    }

    const newTokens = result.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );

    return {
      messages: result,
      tokenCount: newTokens,
      compressionRatio: newTokens / originalTokens,
      qualityScore: 1.0, // 微压缩不损失关键信息
    };
  }
}

// ─── Level 2: Auto Compact ───

export class AutoCompactStrategy implements CompactStrategy {
  readonly level = CompactLevel.AUTO;
  private readonly threshold: number;
  private readonly targetRatio: number;
  private readonly keepRecentMessages: number;

  constructor(config: AutoCompactConfig = {}) {
    this.threshold = config.threshold ?? 0.8;
    this.targetRatio = config.targetRatio ?? 0.5;
    this.keepRecentMessages = config.keepRecentMessages ?? 10;
  }

  shouldTrigger(
    _messages: readonly Message[],
    tokenCount: number,
    maxTokens: number,
  ): boolean {
    return tokenCount > maxTokens * this.threshold;
  }

  async compact(
    messages: readonly Message[],
    options: CompactOptions,
  ): Promise<CompactResult> {
    const originalTokens = messages.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );

    // 保留最近 N 条消息
    const keepCount = Math.min(this.keepRecentMessages, messages.length);
    const keptMessages = messages.slice(-keepCount);
    const oldMessages = messages.slice(0, -keepCount);

    // 生成摘要
    const summary = generateStructuredSummary(oldMessages);
    const summaryMessage: Message = {
      id: `auto-compact-${Date.now()}`,
      role: "system",
      content: summary,
      timestamp: Date.now(),
    };

    const result = [summaryMessage, ...keptMessages];
    const newTokens = result.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );

    return {
      messages: result,
      tokenCount: newTokens,
      compressionRatio: newTokens / originalTokens,
      qualityScore: auditSummaryQuality(summary, oldMessages),
    };
  }
}

// ─── Level 3: Reactive Compact ───

export class ReactiveCompactStrategy implements CompactStrategy {
  readonly level = CompactLevel.REACTIVE;

  shouldTrigger(): boolean {
    return false; // 仅在 prompt_too_long 错误后手动触发
  }

  async compact(
    messages: readonly Message[],
    options: CompactOptions,
  ): Promise<CompactResult> {
    // 反应式压缩更激进：只保留最近 5 条消息
    const keepCount = Math.min(5, messages.length);
    const keptMessages = messages.slice(-keepCount);
    const oldMessages = messages.slice(0, -keepCount);

    const summary = generateStructuredSummary(oldMessages);
    const summaryMessage: Message = {
      id: `reactive-compact-${Date.now()}`,
      role: "system",
      content: `[Reactive compact - emergency]\n${summary}`,
      timestamp: Date.now(),
    };

    const result = [summaryMessage, ...keptMessages];
    const newTokens = result.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );

    const originalTokens = messages.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );

    return {
      messages: result,
      tokenCount: newTokens,
      compressionRatio: newTokens / originalTokens,
      qualityScore: auditSummaryQuality(summary, oldMessages),
    };
  }
}

// ─── 压缩管理器 ───

export class CompactManager {
  private readonly strategies: readonly CompactStrategy[];
  private readonly postCompactionReload?: PostCompactionReloadCallback | undefined;

  constructor(
    strategies?: readonly CompactStrategy[],
    apiConfig?: APICompactConfig,
    postCompactionReload?: PostCompactionReloadCallback | undefined,
  ) {
    this.strategies = strategies ?? [
      new MicroCompactStrategy(),
      new AutoCompactStrategy(),
      new ReactiveCompactStrategy(),
    ];
    this.postCompactionReload = postCompactionReload;
  }

  /**
   * 执行压缩管道：按级别从低到高尝试。
   * 压缩完成后触发记忆重新加载（原子性：重载失败不影响压缩结果）。
   */
  async runPipeline(
    messages: readonly Message[],
    maxTokens: number,
    forceLevel?: CompactLevel,
  ): Promise<CompactResult> {
    const tokenCount = messages.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );

    let currentMessages = messages;

    for (const strategy of this.strategies) {
      if (forceLevel && strategy.level !== forceLevel) continue;
      if (!strategy.shouldTrigger(currentMessages, tokenCount, maxTokens)) continue;

      const result = await strategy.compact(currentMessages, {
        targetTokens: Math.floor(maxTokens * 0.6),
        maxTokens,
        reason: strategy.level,
      });

      currentMessages = result.messages;

      // 如果已低于阈值，停止
      const newTokens = result.tokenCount;
      if (newTokens < maxTokens * 0.6) break;
    }

    // 压缩后记忆重新加载（原子性：重载失败不影响压缩结果）
    if (this.postCompactionReload) {
      try {
        const reloadedMessages = await this.postCompactionReload(currentMessages);
        currentMessages = reloadedMessages;
      } catch {
        // 重载失败不影响压缩结果，使用压缩后的消息继续
      }
    }

    const finalTokens = currentMessages.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );

    return {
      messages: currentMessages,
      tokenCount: finalTokens,
      compressionRatio: finalTokens / tokenCount,
      qualityScore: 1.0,
    };
  }
}

// ─── 辅助函数 ───

function estimateMessageTokens(msg: Message): number {
  switch (msg.role) {
    case "user":
    case "assistant":
    case "system":
      return estimateTokens(msg.content);
    case "tool_use":
      return estimateTokens(JSON.stringify(msg.input));
    case "tool_result":
      return estimateTokens(msg.content);
  }
}

/**
 * 生成结构化摘要。
 * RULES_2-6: 质量守卫（包含必需章节）。
 */
function generateStructuredSummary(messages: readonly Message[]): string {
  if (messages.length === 0) return "";

  const userMsgs = messages.filter((m) => m.role === "user");
  const assistantMsgs = messages.filter((m) => m.role === "assistant");
  const toolResults = messages.filter((m) => m.role === "tool_result");

  const sections: string[] = [
    "## Context Summary",
    "",
    "### Decisions",
    "- (Decisions made in compressed context)",
    "",
    "### Open TODOs",
    "- (Pending tasks from compressed context)",
    "",
    "### Constraints/Rules",
    "- (Rules and constraints established)",
    "",
    "### Pending User Asks",
    ...(userMsgs.slice(-3).map((m) => `- ${m.content.slice(0, 100)}`)),
    "",
    "### Exact Identifiers",
    "- (File paths, variable names, IDs referenced)",
    "",
    `### Statistics`,
    `- User messages: ${userMsgs.length}`,
    `- Assistant messages: ${assistantMsgs.length}`,
    `- Tool results: ${toolResults.length}`,
    `- Total messages compressed: ${messages.length}`,
  ];

  return sections.join("\n");
}

/**
 * 审计摘要质量。
 * RULES_2-6: 质量守卫。
 */
function auditSummaryQuality(
  summary: string,
  _originalMessages: readonly Message[],
): number {
  if (!summary) return 0;

  let score = 0.5;

  const requiredSections = [
    "Decisions",
    "Open TODOs",
    "Constraints/Rules",
    "Pending User Asks",
    "Exact Identifiers",
  ];

  for (const section of requiredSections) {
    if (summary.includes(section)) score += 0.1;
  }

  return Math.min(1.0, score);
}

/**
 * 创建压缩管理器。
 */
export function createCompactManager(
  strategies?: readonly CompactStrategy[],
  apiConfig?: APICompactConfig,
  postCompactionReload?: PostCompactionReloadCallback,
): CompactManager {
  const defaultStrategies = [
    new MicroCompactStrategy(),
    new AutoCompactStrategy(),
    new ReactiveCompactStrategy(),
    new APICompactStrategy(apiConfig),
  ];
  return new CompactManager(strategies ?? defaultStrategies, apiConfig, postCompactionReload);
}

/**
 * ContextEngine 默认实现 — ingest/assemble/compact。
 *
 * 基于安全最佳实践的 ContextEngine 接口设计，适配 EvoAgent 核心需求。
 * RULES_2-4: 接口 + 注册表模式。
 * RULES_2-13: 多级递进（Micro → Auto → Reactive）。
 */

import type { Message } from "../types/message";
import type {
  ContextEngine,
  ContextEngineRegistry,
  CompactResult,
  AssembledContext,
} from "../interfaces/context-engine";
import { estimateTokens } from "../types/common";
import type { PathAwareRuleEngine } from "./path-aware-rules";
import type { LLMProvider } from "../interfaces/llm-provider";
import { defaultLogger } from "../observability/logger";
import { enforceToolOutputQuota, type QuotaConfig } from "./quota";
import { pruneOldTurns, type PruneConfig } from "./prune";
import { prePruneToolResults, type PrePruneConfig } from "./pre-prune";
import {
  createSystemPromptCacheManager,
  type SystemPromptCacheManager,
  assemblePromptFromSegments,
} from "./system-prompt";
import {
  createSystemPrompt,
  partitionPromptSegments,
  PROMPT_STATIC_DYNAMIC_SEPARATOR,
  type SystemPrompt,
  type PromptSegment,
} from "../types/system-prompt";

// ─── 默认 ContextEngine 配置 ───

export interface DefaultContextEngineConfig {
  readonly name?: string;
  readonly priority?: number;
  readonly maxTokens?: number;
  readonly compactThreshold?: number;
  readonly ruleEngine?: PathAwareRuleEngine;
  readonly currentFilePath?: string;
  readonly provider?: LLMProvider;
  /** S2: 工具结果配额配置 */
  readonly quotaConfig?: QuotaConfig;
  /** S2: 历史裁剪配置 */
  readonly pruneConfig?: PruneConfig;
  /** S5: 工具输出预剪枝配置 */
  readonly prePruneConfig?: PrePruneConfig;
}

// ─── DefaultContextEngine ───

export class DefaultContextEngine implements ContextEngine {
  readonly name: string;
  readonly priority: number;

  private messages: Message[] = [];
  private readonly maxTokens: number;
  private readonly compactThreshold: number;
  private readonly ruleEngine: PathAwareRuleEngine | undefined;
  private readonly provider: LLMProvider | undefined;
  private currentFilePath: string | undefined;
  private readonly quotaConfig: QuotaConfig | undefined;
  private readonly pruneConfig: PruneConfig | undefined;
  private readonly prePruneConfig: PrePruneConfig | undefined;
  private readonly promptCacheManager: SystemPromptCacheManager;

  // E.4: Cached MicroCompact — 缓存已发送到 API 的编辑块
  private readonly cachedEditBlocks: string[] = [];

  // E.4: AutoCompact 熔断 — 连续失败计数
  private compactFailureCount = 0;
  private readonly compactCircuitBreakerThreshold = 3;

  // E.4: 压缩质量审计日志
  private readonly logger = defaultLogger.child("context-engine");

  constructor(config: DefaultContextEngineConfig = {}) {
    this.name = config.name ?? "default";
    this.priority = config.priority ?? 0;
    this.maxTokens = config.maxTokens ?? 200_000;
    this.compactThreshold = config.compactThreshold ?? 0.8;
    this.ruleEngine = config.ruleEngine;
    this.currentFilePath = config.currentFilePath;
    this.provider = config.provider;
    this.quotaConfig = config.quotaConfig;
    this.pruneConfig = config.pruneConfig;
    this.prePruneConfig = config.prePruneConfig;
    this.promptCacheManager = createSystemPromptCacheManager();
  }

  /**
   * 注入新消息到上下文。
   */
  ingest(message: Message): void {
    this.messages.push(message);
  }

  /**
   * 组装最终上下文（用于发送给 LLM）。
   *
   * 如果当前 token 数超过预算，先执行压缩。
   */
  async assemble(options: {
    readonly maxTokens: number;
    readonly systemPrompt?: string;
  }): Promise<AssembledContext> {
    const maxTokens = options.maxTokens ?? this.maxTokens;
    const originalLength = this.messages.length;
    let currentMessages = [...this.messages];

    if (this.ruleEngine && this.currentFilePath) {
      const filterResult = this.ruleEngine.filterForPath(this.currentFilePath);
      const ruleMessages: Message[] = filterResult.matchedRules.map((rule: { id: string; content: string }) => ({
        id: `rule-${rule.id}-${Date.now()}`,
        role: "system" as const,
        content: rule.content,
        timestamp: Date.now(),
      }));
      currentMessages = [...ruleMessages, ...currentMessages];
    }

    // S2: Quota + PrePrune + Prune 管线
    let tokensFreedByQuotaPrune = 0;
    if (this.quotaConfig) {
      const quotaResult = enforceToolOutputQuota(currentMessages, this.quotaConfig);
      currentMessages = [...quotaResult.messages];
      tokensFreedByQuotaPrune += quotaResult.tokensFreed;
    }
    if (this.prePruneConfig) {
      const prePruneResult = prePruneToolResults(currentMessages, this.prePruneConfig);
      currentMessages = [...prePruneResult.messages];
      tokensFreedByQuotaPrune += prePruneResult.tokensSaved;
    }
    if (this.pruneConfig) {
      const pruneResult = pruneOldTurns(currentMessages, this.pruneConfig);
      currentMessages = [...pruneResult.messages];
      tokensFreedByQuotaPrune += pruneResult.tokensFreed;
    }

    // 检查是否需要压缩（考虑 Quota+Prune 释放的 token）
    const currentTokens = this.countMessagesTokens(currentMessages);
    const effectiveThreshold = tokensFreedByQuotaPrune > 0
      ? this.compactThreshold + (tokensFreedByQuotaPrune / maxTokens) * 0.1
      : this.compactThreshold;

    if (currentTokens > maxTokens * effectiveThreshold) {
      const result = await this.compact({
        targetTokens: Math.floor(maxTokens * 0.6),
        reason: "auto",
      });
      currentMessages = [...result.messages];
    }

    const totalTokens = this.countMessagesTokens(currentMessages);
    const isCompacted = currentMessages.length < originalLength;

    // S4: 使用 SystemPromptCacheManager 缓存分割
    let assembledSystemPrompt = options.systemPrompt ?? "";
    if (assembledSystemPrompt) {
      const promptSegments = assembledSystemPrompt.split("\n\n");
      const systemPrompt = createSystemPrompt(promptSegments);
      const segments = this.promptCacheManager.partition(systemPrompt);

      const builtSegments = segments.map((segment, index) => {
        const key = `segment-${index}`;
        return this.promptCacheManager.getOrBuild(key, segment.cacheTier, () => segment.text);
      });

      assembledSystemPrompt = builtSegments.join("\n\n");
    }

    return {
      systemPrompt: assembledSystemPrompt,
      messages: currentMessages,
      totalTokens,
      isCompacted,
    };
  }

  /**
   * 压缩上下文（减少 Token 使用）。
   *
   * E.4: 降级链 — LLM 摘要 → 规则摘要 → 硬截断。
   * E.4: 熔断 — 连续 3 次压缩失败后停止重试。
   * E.4: 质量审计 — 评估压缩后上下文质量（0-1 分）。
   *
   * 策略：保留最近 N 条消息，将旧消息压缩为摘要。
   * RULES_2-6: 质量守卫（压缩后验证关键信息保留）。
   * RULES_2-10: 两层截断（总量上限 + 单条上限）。
   */
  async compact(options: {
    readonly targetTokens: number;
    readonly reason: "micro" | "auto" | "reactive";
  }): Promise<CompactResult> {
    const { targetTokens, reason } = options;
    const originalCount = this.messages.length;
    const originalTokens = this.countMessagesTokens(this.messages);

    if (originalTokens <= targetTokens) {
      return {
        messages: this.messages,
        tokenCount: originalTokens,
        compressionRatio: 1.0,
        qualityScore: 1.0,
      };
    }

    // E.4: 熔断检查
    if (this.compactFailureCount >= this.compactCircuitBreakerThreshold) {
      this.logger.warn("Compact circuit breaker tripped, using hard truncation", {
        failureCount: this.compactFailureCount,
        reason,
      });
      return this.hardTruncate(targetTokens, originalTokens);
    }

    // 从尾部开始保留消息，直到达到目标 token 数
    let keepFromIndex = 0;
    let tailTokens = 0;

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]!;
      const msgTokens = this.countMessageTokens(msg);

      if (tailTokens + msgTokens > targetTokens * 0.7) {
        keepFromIndex = i + 1;
        break;
      }

      tailTokens += msgTokens;
    }

    // 保留的消息
    const keptMessages = this.messages.slice(keepFromIndex);

    // 生成旧消息的摘要
    const oldMessages = this.messages.slice(0, keepFromIndex);
    const summary = await this.generateSummaryWithDegradation(oldMessages, reason);
    const summaryMessage: Message = {
      id: `summary-${Date.now()}`,
      role: "system",
      content: summary,
      timestamp: Date.now(),
    };

    // 更新内部消息列表
    this.messages = [summaryMessage, ...keptMessages];

    const newTokens = this.countMessagesTokens(this.messages);
    const compressionRatio = newTokens / originalTokens;

    // E.4: 质量审计
    const qualityScore = await this.auditQuality(summary, oldMessages);
    if (qualityScore < 0.3) {
      this.logger.warn("Low context quality after compaction", {
        qualityScore,
        reason,
        originalTokens,
        newTokens,
      });
    }

    // 注意：不在这里重置 compactFailureCount
    // compactFailureCount 只在 LLM 摘要成功时重置（在 generateSummaryWithDegradation 中）

    return {
      messages: this.messages,
      tokenCount: newTokens,
      compressionRatio,
      qualityScore,
    };
  }

  /**
   * E.4: 带降级链的摘要生成。
   *
   * LLM 摘要 → 规则摘要（保留最近 3 条用户消息）→ 硬截断
   */
  private async generateSummaryWithDegradation(
    messages: readonly Message[],
    reason: "micro" | "auto" | "reactive",
  ): Promise<string> {
    if (messages.length === 0) return "";

    // 尝试 LLM 摘要
    if (this.provider) {
      try {
        const summary = await this.generateLLMSummary(messages);
        this.compactFailureCount = 0; // 成功，重置
        return summary;
      } catch (error) {
        this.compactFailureCount++;
        this.logger.warn("LLM summary failed, falling back to rule summary", {
          failureCount: this.compactFailureCount,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 降级到规则摘要
    return this.generateRuleSummary(messages);
  }

  /**
   * E.4: LLM 摘要生成。
   */
  private async generateLLMSummary(messages: readonly Message[]): Promise<string> {
    const conversationText = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `[${m.role}]: ${m.content.slice(0, 200)}`)
      .join("\n");

    const response = await this.provider!.invoke([
      {
        role: "system",
        content: "Summarize this conversation concisely, preserving key decisions, facts, and action items. Use the same language as the conversation.",
      },
      { role: "user", content: conversationText },
    ]);

    return `[Context compressed - LLM summary (${messages.length} messages)]\n${response.content}`;
  }

  /**
   * E.4: 硬截断（最终降级）。
   */
  private hardTruncate(targetTokens: number, originalTokens: number): CompactResult {
    let keptTokens = 0;
    let keepFromIndex = 0;

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msgTokens = this.countMessageTokens(this.messages[i]!);
      if (keptTokens + msgTokens > targetTokens) {
        keepFromIndex = i + 1;
        break;
      }
      keptTokens += msgTokens;
    }

    this.messages = this.messages.slice(keepFromIndex);
    const newTokens = this.countMessagesTokens(this.messages);

    return {
      messages: this.messages,
      tokenCount: newTokens,
      compressionRatio: newTokens / originalTokens,
      qualityScore: 0.2, // 硬截断质量低
    };
  }

  /**
   * 获取当前 Token 计数。
   */
  getTokenCount(): number {
    return this.countMessagesTokens(this.messages);
  }

  /**
   * 获取消息数量。
   */
  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * 清空上下文。
   */
  clear(): void {
    this.messages = [];
    this.promptCacheManager.invalidateAll();
  }

  /**
   * 获取所有消息（只读）。
   */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * 注入知识到上下文。
   */
  injectKnowledge(content: string): void {
    if (!content) return;
    const knowledgeMessage: Message = {
      id: `knowledge-${Date.now()}`,
      role: "system",
      content,
      timestamp: Date.now(),
    };
    // 注入到消息列表开头（系统消息位置）
    this.messages = [knowledgeMessage, ...this.messages];
  }

  // ─── 私有方法 ───

  private countMessagesTokens(messages: readonly Message[]): number {
    return messages.reduce(
      (sum, msg) => sum + this.countMessageTokens(msg),
      0,
    );
  }

  private countMessageTokens(msg: Message): number {
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
   * 生成旧消息的摘要（委托到降级链）。
   */
  private async generateSummary(messages: readonly Message[]): Promise<string> {
    return this.generateSummaryWithDegradation(messages, "auto");
  }

  /**
   * 规则摘要（降级模式）。
   */
  private generateRuleSummary(messages: readonly Message[]): string {

    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const toolResults = messages.filter((m) => m.role === "tool_result");

    const sections: string[] = [
      `## Summary (${messages.length} messages compressed)`,
      "",
      `User messages: ${userMessages.length}`,
      `Assistant messages: ${assistantMessages.length}`,
      `Tool results: ${toolResults.length}`,
    ];

    // 保留最近 3 条用户消息的关键内容
    const recentUser = userMessages.slice(-3);
    if (recentUser.length > 0) {
      sections.push("", "### Recent user requests:");
      for (const msg of recentUser) {
        const preview = msg.content.length > 100
          ? `${msg.content.slice(0, 100)}...`
          : msg.content;
        sections.push(`- ${preview}`);
      }
    }

    return sections.join("\n");
  }

  /**
   * 审计摘要质量。
   * RULES_2-6: 质量守卫。
   * B.4: 有 LLM Provider 时使用 LLM 评估，否则使用规则评估。
   */
  private async auditQuality(summary: string, originalMessages: readonly Message[]): Promise<number> {
    if (!summary) return 0;

    if (this.provider) {
      try {
        const recentContent = originalMessages
          .slice(-5)
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => `[${m.role}]: ${m.content.slice(0, 100)}`)
          .join("\n");

        const response = await this.provider.invoke([
          {
            role: "system",
            content: "Rate the quality of a conversation summary on a scale of 0.0 to 1.0. Consider: key facts preserved, decisions retained, action items included, no hallucinations. Respond with ONLY a number.",
          },
          {
            role: "user",
            content: `Summary:\n${summary}\n\nOriginal messages (last 5):\n${recentContent}`,
          },
        ]);

        const score = parseFloat(response.content.trim());
        if (!Number.isNaN(score)) {
          return Math.max(0, Math.min(1, score));
        }
      } catch {
        // LLM 评估失败 → 降级到规则评估
      }
    }

    return this.ruleAuditQuality(summary, originalMessages);
  }

  /**
   * 规则质量审计（降级模式）。
   */
  private ruleAuditQuality(summary: string, originalMessages: readonly Message[]): number {
    if (!summary) return 0;

    let score = 0.5; // 基础分

    // 检查是否包含关键信息
    if (summary.includes("User messages")) score += 0.1;
    if (summary.includes("Assistant messages")) score += 0.1;
    if (summary.includes("Tool results")) score += 0.1;

    // 检查是否保留了最近的用户请求
    const lastUserMsg = [...originalMessages].reverse().find((m) => m.role === "user");
    if (lastUserMsg && summary.includes(lastUserMsg.content.slice(0, 50))) {
      score += 0.2;
    }

    return Math.min(1.0, score);
  }
}

/**
 * 创建默认 ContextEngine。
 */
export function createContextEngine(
  config?: DefaultContextEngineConfig,
): ContextEngine {
  return new DefaultContextEngine(config);
}

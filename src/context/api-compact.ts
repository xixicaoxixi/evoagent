/**
 * API 级压缩策略 — Level 4 API Compact。
 *
 * 在 API 调用前对上下文进行最后一轮优化：
 * - thinking 块清除/保留策略
 * - 工具结果截断
 * - 工具调用输入清除
 *
 * 参考 `代码片段_上下文记忆与通信协议.md` 片段 #6。
 */

import type { Message } from "../types/message";
import type { CompactStrategy, CompactOptions } from "./compressor";
import { CompactLevel } from "./compressor";
import type { CompactResult } from "../interfaces/context-engine";
import { estimateTokens } from "../types/common";

// ─── API 压缩配置 ───

export interface APICompactConfig {
  /** 是否清除 thinking 块 */
  readonly clearThinking?: boolean;
  /** 保留最近 N 轮的 thinking */
  readonly keepThinkingTurns?: number;
  /** 工具结果最大字符数（0 = 清除所有） */
  readonly maxToolResultChars?: number;
  /** 工具调用输入最大字符数（0 = 清除所有） */
  readonly maxToolInputChars?: number;
  /** 触发工具清除的 token 阈值 */
  readonly triggerThreshold?: number;
  /** 工具清除目标 token 数 */
  readonly clearTarget?: number;
}

// ─── API Compact 策略 ───

export class APICompactStrategy implements CompactStrategy {
  readonly level = CompactLevel.API;

  private readonly clearThinking: boolean;
  private readonly keepThinkingTurns: number;
  private readonly maxToolResultChars: number;
  private readonly maxToolInputChars: number;
  private readonly triggerThreshold: number;
  private readonly clearTarget: number;

  constructor(config: APICompactConfig = {}) {
    this.clearThinking = config.clearThinking ?? false;
    this.keepThinkingTurns = config.keepThinkingTurns ?? 1;
    this.maxToolResultChars = config.maxToolResultChars ?? 5000;
    this.maxToolInputChars = config.maxToolInputChars ?? 2000;
    this.triggerThreshold = config.triggerThreshold ?? 180_000;
    this.clearTarget = config.clearTarget ?? 30_000;
  }

  shouldTrigger(
    _messages: readonly Message[],
    tokenCount: number,
    _maxTokens: number,
  ): boolean {
    return tokenCount > this.triggerThreshold;
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
    let thinkingTurnsKept = 0;

    for (const msg of messages) {
      // Thinking 块处理
      if (msg.role === "assistant" && msg.content.includes("<thinking>")) {
        if (this.clearThinking) {
          if (thinkingTurnsKept < this.keepThinkingTurns) {
            result.push(msg);
            thinkingTurnsKept++;
          } else {
            // 清除 thinking 块
            const cleaned = msg.content.replace(
              /<thinking>[\s\S]*?<\/thinking>/g,
              "[thinking block cleared by API compact]",
            );
            result.push({ ...msg, content: cleaned });
          }
          continue;
        }
      }

      // 工具结果截断
      if (msg.role === "tool_result") {
        if (this.maxToolResultChars === 0) {
          result.push({
            ...msg,
            content: "[tool result cleared by API compact]",
          });
        } else if (msg.content.length > this.maxToolResultChars) {
          result.push({
            ...msg,
            content: `${msg.content.slice(0, this.maxToolResultChars)}\n[... truncated by API compact (${msg.content.length} chars)]`,
          });
        } else {
          result.push(msg);
        }
        continue;
      }

      // 工具调用输入截断
      if (msg.role === "tool_use" && msg.input) {
        const inputStr = JSON.stringify(msg.input);
        if (this.maxToolInputChars > 0 && inputStr.length > this.maxToolInputChars) {
          const truncated = inputStr.slice(0, this.maxToolInputChars);
          try {
            result.push({
              ...msg,
              input: JSON.parse(truncated) as typeof msg.input,
            });
          } catch {
            result.push(msg);
          }
        } else {
          result.push(msg);
        }
        continue;
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

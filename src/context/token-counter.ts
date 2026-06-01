/**
 * Token 计数器 — CJK 感知。
 *
 * 提供精确的 Token 估算，支持消息列表和文本。
 * RULES_2-14: 水库采样（Token 统计）。
 */

import { estimateTokens } from "../types/common";
import type { Message } from "../types/message";

// ─── Token 计数结果 ───

export interface TokenCountResult {
  readonly total: number;
  readonly byRole: Readonly<Record<string, number>>;
  readonly messageCount: number;
}

// ─── TokenCounter ───

export class TokenCounter {
  /**
   * 计算单条消息的 token 数。
   */
  countMessage(msg: Message): number {
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
   * 计算消息列表的总 token 数。
   */
  countMessages(messages: readonly Message[]): TokenCountResult {
    let total = 0;
    const byRole: Record<string, number> = {};

    for (const msg of messages) {
      const count = this.countMessage(msg);
      total += count;
      byRole[msg.role] = (byRole[msg.role] ?? 0) + count;
    }

    return {
      total,
      byRole,
      messageCount: messages.length,
    };
  }

  /**
   * 计算文本的 token 数。
   */
  countText(text: string): number {
    return estimateTokens(text);
  }

  /**
   * 估算 system prompt + messages 的总 token 数。
   */
  countContext(
    systemPrompt: string,
    messages: readonly Message[],
  ): number {
    return estimateTokens(systemPrompt) + this.countMessages(messages).total;
  }
}

/**
 * 创建 Token 计数器。
 */
export function createTokenCounter(): TokenCounter {
  return new TokenCounter();
}

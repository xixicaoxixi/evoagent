/**
 * 工具结果配额 — 对超过配额的单条工具结果截断。
 *
 * 阶段 E.3: Layer 1 — O(n) 扫描，无损截断（保留头尾）。
 *
 * RULES_2-10: 两层截断（总量上限 + 单条上限）。
 */

import type { Message } from "../types/message";
import { estimateTokens } from "../types/common";

// ─── 配额配置 ───

export interface QuotaConfig {
  /** 单条工具结果最大 Token 数（默认 4096） */
  readonly maxTokensPerToolResult?: number;
  /** 保留头部比例（默认 0.6） */
  readonly headRatio?: number;
  /** 截断标记 */
  readonly truncationMarker?: string;
}

// ─── 默认值 ───

const DEFAULT_MAX_TOKENS_PER_RESULT = 4096;
const DEFAULT_HEAD_RATIO = 0.6;
const DEFAULT_TRUNCATION_MARKER = "\n\n[... truncated by quota ...]\n\n";

// ─── enforceToolOutputQuota ───

/**
 * 对工具结果消息执行配额截断。
 *
 * 扫描所有 tool_result 消息，对超过 maxTokensPerToolResult 的结果
 * 进行头尾保留截断（headRatio 保留头部，剩余保留尾部）。
 *
 * @param messages - 消息列表（不可变，返回新数组）
 * @param config - 配额配置
 * @returns 新消息列表 + 释放的 token 数
 */
export function enforceToolOutputQuota(
  messages: readonly Message[],
  config?: QuotaConfig,
): { readonly messages: readonly Message[]; readonly tokensFreed: number } {
  const maxTokens = config?.maxTokensPerToolResult ?? DEFAULT_MAX_TOKENS_PER_RESULT;
  const headRatio = config?.headRatio ?? DEFAULT_HEAD_RATIO;
  const marker = config?.truncationMarker ?? DEFAULT_TRUNCATION_MARKER;

  let totalTokensFreed = 0;
  const result: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "tool_result") {
      const tokens = estimateTokens(msg.content);
      if (tokens > maxTokens) {
        // 截断：保留头部和尾部
        const headTokens = Math.floor(maxTokens * headRatio);
        const tailTokens = maxTokens - headTokens;

        const charsPerToken = msg.content.length / tokens;
        const headChars = Math.floor(headTokens * charsPerToken);
        const tailChars = Math.floor(tailTokens * charsPerToken);

        const truncated = msg.content.slice(0, headChars)
          + marker
          + msg.content.slice(-tailChars);

        totalTokensFreed += tokens - maxTokens;
        result.push({ ...msg, content: truncated });
      } else {
        result.push(msg);
      }
    } else {
      result.push(msg);
    }
  }

  return { messages: result, tokensFreed: totalTokensFreed };
}

/**
 * 历史裁剪 — 移除较旧的对话轮次。
 *
 * 阶段 E.3: Layer 2 — O(n) 扫描，有损丢弃旧轮次。
 *
 * RULES_2-6: 质量守卫（保护最近 N 轮）。
 */

import type { Message } from "../types/message";
import { estimateTokens } from "../types/common";

// ─── 裁剪配置 ───

export interface PruneConfig {
  /** 保护最近 N 轮（一轮 = user + assistant，默认 5） */
  readonly protectRecentTurns?: number;
  /** 目标 Token 数（默认 100000） */
  readonly targetTokens?: number;
}

// ─── 默认值 ───

const DEFAULT_PROTECT_RECENT_TURNS = 5;
const DEFAULT_TARGET_TOKENS = 100_000;

// ─── pruneOldTurns ───

/**
 * 裁剪旧的对话轮次，保护最近 N 轮。
 *
 * 一轮 = 一个 user 消息 + 后续的 assistant/tool 消息。
 * 从最早的消息开始移除，直到总 token 数低于目标。
 *
 * @param messages - 消息列表（不可变，返回新数组）
 * @param config - 裁剪配置
 * @returns 新消息列表 + 释放的 token 数
 */
export function pruneOldTurns(
  messages: readonly Message[],
  config?: PruneConfig,
): { readonly messages: readonly Message[]; readonly tokensFreed: number } {
  const protectTurns = config?.protectRecentTurns ?? DEFAULT_PROTECT_RECENT_TURNS;
  const targetTokens = config?.targetTokens ?? DEFAULT_TARGET_TOKENS;

  const totalTokens = messages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg),
    0,
  );

  if (totalTokens <= targetTokens) {
    return { messages, tokensFreed: 0 };
  }

  // 识别轮次边界
  const turns = identifyTurns(messages);

  // 保护最近 N 轮
  const protectedTurnStartIndex = Math.max(0, turns.length - protectTurns);

  // 从最早的轮次开始移除
  let tokensFreed = 0;
  let pruneUpToIndex = 0;

  for (let i = 0; i < protectedTurnStartIndex; i++) {
    const turn = turns[i]!;
    const turnTokens = turn.messages.reduce(
      (sum, msg) => sum + estimateMessageTokens(msg),
      0,
    );

    const remainingTokens = totalTokens - tokensFreed - turnTokens;
    if (remainingTokens <= targetTokens) {
      break;
    }

    tokensFreed += turnTokens;
    pruneUpToIndex = turn.endIndex + 1;
  }

  if (pruneUpToIndex === 0) {
    return { messages, tokensFreed: 0 };
  }

  // 添加裁剪摘要
  const prunedMessages = messages.slice(0, pruneUpToIndex);
  const summaryMessage: Message = {
    id: `prune-summary-${Date.now()}`,
    role: "system",
    content: `[${prunedMessages.length} messages pruned to reduce context from ${totalTokens} to ~${totalTokens - tokensFreed} tokens]`,
    timestamp: Date.now(),
  };

  return {
    messages: [summaryMessage, ...messages.slice(pruneUpToIndex)],
    tokensFreed,
  };
}

// ─── 辅助函数 ───

interface Turn {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly messages: readonly Message[];
}

function identifyTurns(messages: readonly Message[]): readonly Turn[] {
  const turns: Turn[] = [];
  let turnStart = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "user") {
      if (turnStart !== -1) {
        turns.push({
          startIndex: turnStart,
          endIndex: i - 1,
          messages: messages.slice(turnStart, i),
        });
      }
      turnStart = i;
    }
  }

  // 最后一个轮次
  if (turnStart !== -1) {
    turns.push({
      startIndex: turnStart,
      endIndex: messages.length - 1,
      messages: messages.slice(turnStart),
    });
  }

  return turns;
}

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

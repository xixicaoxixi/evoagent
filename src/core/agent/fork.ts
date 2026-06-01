/**
 * Fork 机制 — 从当前 Agent 上下文 Fork 出子 Agent。
 *
 * 核心设计：所有 Fork 子 Agent 产生字节完全相同的 API 请求前缀
 * （相同的 assistant 消息 + 相同的占位符 tool_result），
 * 只有最后一个 text block（directive）因子 Agent 而异，
 * 从而最大化 prompt cache 命中率。
 *
 * 参考 `代码片段_Agent核心循环与编排.md` 片段 #9。
 */

import type { Message, AssistantMessage, ToolResultMessage } from "../../types/message";

// ─── Fork 常量 ───

const FORK_PLACEHOLDER_RESULT = "Fork started — processing in background";

// ─── Fork 消息构建 ───

export interface ForkMessageBuildResult {
  readonly messages: readonly Message[];
  readonly forkedToolUseIds: readonly string[];
}

/**
 * buildForkedMessages — 从当前 assistant 消息构建 Fork 子 Agent 的消息。
 *
 * @param directive 子 Agent 的指令（每个子 Agent 不同）
 * @param assistantMessage 当前 Agent 的 assistant 消息
 * @returns 子 Agent 的初始消息列表
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): ForkMessageBuildResult {
  // 克隆 assistant 消息
  const fullAssistantMessage: AssistantMessage = {
    ...assistantMessage,
    id: `fork-${assistantMessage.id}-${Date.now()}`,
    timestamp: Date.now(),
    content: assistantMessage.content,
    ...(assistantMessage.stopReason !== undefined ? { stopReason: assistantMessage.stopReason } : {}),
  };

  // 收集所有 tool_use 引用（从 content 中提取）
  const toolUseIds = extractToolUseIds(assistantMessage);

  if (toolUseIds.length === 0) {
    // 无 tool_use 块时直接返回 directive 消息
    return {
      messages: [
        createTextMessage(buildChildMessage(directive)),
      ],
      forkedToolUseIds: [],
    };
  }

  // 为每个 tool_use 构建占位符 tool_result
  const toolResultBlocks: readonly ToolResultMessage[] = toolUseIds.map((toolUseId) =>
    createToolResultMessage(toolUseId, FORK_PLACEHOLDER_RESULT)
  );

  // 单条 user 消息: 所有占位符 tool_results + 子 Agent 独有的 directive
  const toolResultMessage: Message = {
    id: `fork-result-${Date.now()}`,
    role: "user",
    timestamp: Date.now(),
    content: [
      ...toolResultBlocks.map((r) => `[tool_result:${r.toolUseId}] ${r.content}`),
      buildChildMessage(directive),
    ].join("\n"),
  };

  return {
    messages: [fullAssistantMessage, toolResultMessage],
    forkedToolUseIds: toolUseIds,
  };
}

/**
 * buildParallelForkMessages — 为多个并行 Fork 构建消息。
 *
 * 所有 Fork 共享相同的 assistant 消息和占位符 tool_result，
 * 只有 directive 不同，最大化 prompt cache 命中。
 */
export function buildParallelForkMessages(
  assistantMessage: AssistantMessage,
  directives: readonly string[],
): readonly ForkMessageBuildResult[] {
  return directives.map((directive) => buildForkedMessages(directive, assistantMessage));
}

// ─── 辅助函数 ───

function extractToolUseIds(message: AssistantMessage): string[] {
  // 从消息内容中提取 tool_use 引用
  // 在当前实现中，tool_use 信息存储在独立的 ToolUseMessage 中
  // 这里我们从 content 中通过正则匹配提取
  const toolUseIdPattern = /\[tool_use:(\w[\w-]*)\]/g;
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = toolUseIdPattern.exec(message.content)) !== null) {
    ids.push(match[1]!);
  }
  return ids;
}

function buildChildMessage(directive: string): string {
  return `[Fork Directive]\n${directive}\n[End Directive]`;
}

function createTextMessage(content: string): Message {
  return {
    id: `fork-text-${Date.now()}`,
    role: "user",
    timestamp: Date.now(),
    content,
  };
}

function createToolResultMessage(
  toolUseId: string,
  content: string,
): ToolResultMessage {
  return {
    id: `fork-tool-result-${toolUseId}`,
    role: "tool_result",
    timestamp: Date.now(),
    toolUseId,
    content,
    isError: false,
  };
}

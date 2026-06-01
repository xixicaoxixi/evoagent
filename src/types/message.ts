/**
 * 消息类型 — Discriminated Union。
 *
 * RULES_1-3: 多态用 Discriminated Union（role 字段区分）。
 * 支持 user / assistant / tool_use / tool_result / system 五种消息角色。
 */

// ─── MessageRole 枚举 ───

export const MessageRole = {
  USER: "user",
  ASSISTANT: "assistant",
  TOOL_USE: "tool_use",
  TOOL_RESULT: "tool_result",
  SYSTEM: "system",
} as const;

export type MessageRole =
  (typeof MessageRole)[keyof typeof MessageRole];

// ─── 基础消息接口 ───

interface MessageBase {
  readonly id: string;
  readonly role: MessageRole;
  readonly timestamp: number;
  readonly sessionId?: string;
}

// ─── User 消息 ───

export interface UserMessage extends MessageBase {
  readonly role: "user";
  readonly content: string;
}

// ─── Assistant 消息 ───

export interface AssistantMessage extends MessageBase {
  readonly role: "assistant";
  readonly content: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly tokenUsage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

// ─── Tool Use 消息（LLM 请求调用工具） ───

export interface ToolUseMessage extends MessageBase {
  readonly role: "tool_use";
  readonly toolName: string;
  readonly toolUseId: string;
  readonly input: Record<string, unknown>;
}

// ─── Tool Result 消息（工具执行结果） ───

export interface ToolResultMessage extends MessageBase {
  readonly role: "tool_result";
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

// ─── System 消息 ───

export interface SystemMessage extends MessageBase {
  readonly role: "system";
  readonly content: string;
}

// ─── 消息联合类型 ───

export type Message =
  | UserMessage
  | AssistantMessage
  | ToolUseMessage
  | ToolResultMessage
  | SystemMessage;

// ─── 类型守卫 ───

export function isUserMessage(msg: Message): msg is UserMessage {
  return msg.role === "user";
}

export function isAssistantMessage(msg: Message): msg is AssistantMessage {
  return msg.role === "assistant";
}

export function isToolUseMessage(msg: Message): msg is ToolUseMessage {
  return msg.role === "tool_use";
}

export function isToolResultMessage(msg: Message): msg is ToolResultMessage {
  return msg.role === "tool_result";
}

export function isSystemMessage(msg: Message): msg is SystemMessage {
  return msg.role === "system";
}

// ─── 穷举检查辅助（RULES_1-7: never 类型兜底） ───

export function assertNever(value: never): never {
  throw new Error(
    `Unhandled discriminated union member: ${JSON.stringify(value)}`,
  );
}

/** 根据消息角色提取文本内容 */
export function extractMessageContent(msg: Message): string {
  switch (msg.role) {
    case "user":
    case "assistant":
    case "system":
      return msg.content;
    case "tool_use":
      return `[Tool: ${msg.toolName}] ${JSON.stringify(msg.input)}`;
    case "tool_result":
      return msg.isError ? `[Error] ${msg.content}` : msg.content;
    default:
      return assertNever(msg);
  }
}

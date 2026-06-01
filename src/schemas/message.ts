/**
 * 消息 Zod Schema。
 *
 * 验证五种消息角色（user/assistant/tool_use/tool_result/system）的外部输入。
 */

import { z } from "zod";

// ─── MessageRole Schema ───

export const MessageRoleSchema = z.enum([
  "user",
  "assistant",
  "tool_use",
  "tool_result",
  "system",
]);

// ─── 基础消息 Schema ───

const MessageBaseSchema = z.object({
  id: z.string().min(1),
  role: MessageRoleSchema,
  timestamp: z.number().int().positive(),
  session_id: z.string().optional(),
});

// ─── UserMessage Schema ───

export const UserMessageSchema = MessageBaseSchema.extend({
  role: z.literal("user"),
  content: z.string().min(1),
});

// ─── AssistantMessage Schema ───

export const AssistantMessageSchema = MessageBaseSchema.extend({
  role: z.literal("assistant"),
  content: z.string(),
  model: z.string().optional(),
  stopReason: z.string().optional(),
  tokenUsage: z
    .object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
    })
    .optional(),
});

// ─── ToolUseMessage Schema ───

export const ToolUseMessageSchema = MessageBaseSchema.extend({
  role: z.literal("tool_use"),
  toolName: z.string().min(1),
  toolUseId: z.string().min(1),
  input: z.record(z.unknown()),
});

// ─── ToolResultMessage Schema ───

export const ToolResultMessageSchema = MessageBaseSchema.extend({
  role: z.literal("tool_result"),
  toolUseId: z.string().min(1),
  content: z.string(),
  isError: z.boolean(),
});

// ─── SystemMessage Schema ───

export const SystemMessageSchema = MessageBaseSchema.extend({
  role: z.literal("system"),
  content: z.string().min(1),
});

// ─── 联合消息 Schema（Discriminated Union） ───

export const MessageSchema = z.discriminatedUnion("role", [
  UserMessageSchema,
  AssistantMessageSchema,
  ToolUseMessageSchema,
  ToolResultMessageSchema,
  SystemMessageSchema,
]);

export type MessageInput = z.input<typeof MessageSchema>;
export type MessageOutput = z.infer<typeof MessageSchema>;

/**
 * 工具 Zod Schema。
 *
 * 验证工具定义、工具调用和工具结果的外部输入。
 */

import { z } from "zod";

// ─── ToolDefinition Schema ───

export const ToolDefinitionSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  inputSchema: z.record(z.unknown()),
  isReadOnly: z.boolean().default(false),
  isDestructive: z.boolean().default(false),
  isConcurrencySafe: z.boolean().default(false),
});

export type ToolDefinitionInput = z.input<typeof ToolDefinitionSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// ─── ToolUse Schema ───

export const ToolUseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.unknown()),
});

export type ToolUseInput = z.input<typeof ToolUseSchema>;
export type ToolUseParsed = z.infer<typeof ToolUseSchema>;

// ─── ToolResult Schema ───

export const ToolResultSchema = z.object({
  content: z.unknown(),
  isError: z.boolean(),
  metadata: z
    .object({
      durationMs: z.number().int().min(0).optional(),
      tokenUsage: z
        .object({
          inputTokens: z.number().int().min(0),
          outputTokens: z.number().int().min(0),
        })
        .optional(),
    })
    .optional(),
});

export type ToolResultInput = z.input<typeof ToolResultSchema>;
export type ToolResultParsed = z.infer<typeof ToolResultSchema>;

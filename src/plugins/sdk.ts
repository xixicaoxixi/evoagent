/**
 * Plugin SDK — 插件定义工厂 + 契约验证。
 *
 * RULES_2-4: 接口 + 注册表模式。
 * definePluginEntry 是唯一合法入口。
 */

import type { PluginEntry, PluginMetadata, PluginHook } from "../interfaces/plugin";
import type { Tool } from "../interfaces/tool";
import { z } from "zod";

// ─── 插件定义输入 ───

export interface PluginDefinitionInput {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author?: string;
  readonly source?: PluginEntry["metadata"]["source"];
  readonly tools?: readonly Tool[];
  readonly hooks?: readonly PluginHookInput[];
  readonly activationCondition?: string;
  readonly activate?: () => Promise<void>;
  readonly deactivate?: () => Promise<void>;
}

export interface PluginHookInput {
  readonly event: string;
  readonly handler: (...args: readonly unknown[]) => Promise<unknown>;
  readonly priority?: number;
}

// ─── 插件契约 Schema ───

export const PluginContractSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  description: z.string().min(1).max(500),
  author: z.string().max(100).optional(),
  source: z.enum(["builtin", "user", "community", "mcp", "remote"]).optional(),
});

export type PluginContract = z.infer<typeof PluginContractSchema>;

// ─── 插件契约验证结果 ───

export interface PluginValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

// ─── 契约验证 ───

export function validatePluginContract(
  input: unknown,
): PluginValidationResult {
  const result = PluginContractSchema.safeParse(input);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}

// ─── definePluginEntry 工厂函数 ───

export function definePluginEntry(
  input: PluginDefinitionInput,
): PluginEntry {
  // 验证契约
  const validation = validatePluginContract(input);
  if (!validation.valid) {
    throw new Error(
      `Invalid plugin contract: ${validation.errors.join("; ")}`,
    );
  }

  // 转换 hooks 格式
  const hooks: readonly PluginHook[] | undefined =
    input.hooks !== undefined
      ? input.hooks.map((h) => ({
          event: h.event,
          handler: h.handler,
          ...(h.priority !== undefined ? { priority: h.priority } : {}),
        }))
      : undefined;

  // 构建元数据
  const metadata: PluginMetadata = {
    name: input.name,
    version: input.version,
    description: input.description,
    ...(input.author !== undefined ? { author: input.author } : {}),
    source: input.source ?? "user",
  };

  return {
    metadata,
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(input.activationCondition !== undefined
      ? { activationCondition: input.activationCondition }
      : {}),
    ...(input.activate !== undefined ? { activate: input.activate } : {}),
    ...(input.deactivate !== undefined
      ? { deactivate: input.deactivate }
      : {}),
  };
}

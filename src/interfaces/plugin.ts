/**
 * PluginEntry 接口。
 *
 * 插件系统的核心接口，支持声明式插件定义。
 * RULES_2-4: 接口 + 注册表模式。
 */

import type { Tool } from "./tool";

// ─── 插件元数据 ───

export interface PluginMetadata {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author?: string;
  readonly source: "builtin" | "user" | "community" | "mcp" | "remote";
}

// ─── 插件钩子定义 ───

export interface PluginHook {
  readonly event: string;
  readonly handler: (...args: readonly unknown[]) => Promise<unknown>;
  readonly priority?: number;
}

// ─── PluginEntry 接口 ───

export interface PluginEntry {
  /** 插件元数据 */
  readonly metadata: PluginMetadata;

  /** 插件提供的工具 */
  readonly tools?: readonly Tool[];

  /** 插件注册的钩子 */
  readonly hooks?: readonly PluginHook[];

  /** 插件激活条件（可选） */
  readonly activationCondition?: string;

  /** 初始化插件 */
  activate?(): Promise<void>;

  /** 停用插件 */
  deactivate?(): Promise<void>;
}

// ─── 插件注册表接口 ───

export interface PluginRegistry {
  register(plugin: PluginEntry): void;
  unregister(name: string): boolean;
  get(name: string): PluginEntry | undefined;
  listAll(): readonly PluginEntry[];
  listBySource(source: PluginEntry["metadata"]["source"]): readonly PluginEntry[];
}

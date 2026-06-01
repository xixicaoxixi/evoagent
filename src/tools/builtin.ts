/**
 * 内置工具注册 — 创建所有内置工具并注册到 ToolRegistry。
 *
 * 基于通用 Agent 设计模式的工具注册与组装设计。
 * 工具按名称排序以保证 prompt cache 稳定性。
 */

import type { Tool } from "../interfaces/tool";
import { createToolRegistry } from "./registry";
import type { ToolRegistry } from "./registry";
import { createFileReadTool } from "./file/read";
import { createFileWriteTool, type ReadFileState } from "./file/write";
import { createFileEditTool } from "./file/edit";
import { createGlobTool } from "./file/glob";
import { createBashTool, type BashToolConfig } from "./bash/bash";
import type { BashPermissionContext } from "./bash/permission";

// ─── 内置工具配置 ───

export interface BuiltinToolsConfig {
  readonly bashPermissionContext: BashPermissionContext;
  readonly readFileState?: ReadFileState;
  readonly bashDefaultTimeout?: number;
  readonly envSanitization?: BashToolConfig["envSanitization"];
}

// ─── 工厂函数 ───

/**
 * createBuiltinTools — 创建所有内置工具。
 *
 * 工具列表：
 * - bash: Bash 命令执行（10 层安全管线）
 * - file_read: 文件读取（Read-before-Write 支持）
 * - file_write: 文件写入（原子写入 + Read-before-Write）
 * - file_edit: 文件编辑（SearchReplace + 原子写入）
 * - glob: 文件模式匹配
 *
 * @returns 按名称排序的工具数组
 */
export function createBuiltinTools(config: BuiltinToolsConfig): Tool[] {
  const tools: Tool[] = [
    createBashTool({
      permissionContext: config.bashPermissionContext,
      ...(config.readFileState !== undefined ? { readFileState: config.readFileState } : {}),
      ...(config.bashDefaultTimeout !== undefined ? { defaultTimeout: config.bashDefaultTimeout } : {}),
      ...(config.envSanitization !== undefined ? { envSanitization: config.envSanitization } : {}),
    }),
    createFileReadTool(config.readFileState),
    createFileWriteTool(config.readFileState),
    createFileEditTool(config.readFileState),
    createGlobTool(),
  ];

  // 按名称排序（保证 prompt cache 稳定性）
  tools.sort((a, b) => a.name.localeCompare(b.name));

  return tools;
}

/**
 * createBuiltinToolRegistry — 创建内置工具注册表。
 *
 * 将所有内置工具注册到 ToolRegistry 中。
 *
 * @returns ToolRegistry 实例
 */
export function createBuiltinToolRegistry(config: BuiltinToolsConfig): ToolRegistry {
  const registry = createToolRegistry();
  const tools = createBuiltinTools(config);

  for (const tool of tools) {
    registry.register(tool, { priority: 100 });
  }

  return registry;
}

/**
 * getBuiltinToolNames — 获取内置工具名称列表（排序后）。
 */
export function getBuiltinToolNames(): readonly string[] {
  return ["bash", "file_edit", "file_read", "file_write", "glob"];
}

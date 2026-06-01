/**
 * assembleToolPool — 工具池组装（排序 + 去重 + 合并）。
 *
 * 从多个来源（内置、插件、MCP）组装最终的工具池。
 * RULES_2-5: 策略模式 > 条件分支。
 */

import type { Tool } from "../interfaces/tool";

// ─── 工具来源 ───

export interface ToolSource {
  readonly name: string;
  readonly tools: ReadonlyArray<Tool>;
  readonly priority: number;
}

// ─── 组装选项 ───

export interface AssembleOptions {
  /** 是否包含只读工具 */
  readonly includeReadOnly?: boolean;

  /** 是否包含破坏性工具 */
  readonly includeDestructive?: boolean;

  /** 最大工具数量 */
  readonly maxTools?: number;

  /** 工具名过滤（白名单） */
  readonly toolNameFilter?: ReadonlySet<string>;

  /** 工具名排除（黑名单） */
  readonly toolNameExclude?: ReadonlySet<string>;
}

// ─── 组装函数 ───

/**
 * 从多个来源组装工具池。
 *
 * 1. 合并所有来源的工具
 * 2. 按名称去重（高优先级覆盖低优先级）
 * 3. 过滤（白名单/黑名单/只读/破坏性）
 * 4. 排序（按优先级降序）
 * 5. 截断（maxTools）
 */
export function assembleToolPool(
  sources: ReadonlyArray<ToolSource>,
  options?: AssembleOptions,
): Tool[] {
  const includeReadOnly = options?.includeReadOnly ?? true;
  const includeDestructive = options?.includeDestructive ?? false;
  const maxTools = options?.maxTools ?? 100;

  // 1. 合并 + 去重（高优先级覆盖低优先级）
  const toolMap = new Map<string, { tool: Tool; priority: number }>();

  // 按优先级升序处理，高优先级后覆盖低优先级
  const sortedSources = [...sources].sort((a, b) => a.priority - b.priority);

  for (const source of sortedSources) {
    for (const tool of source.tools) {
      if (!tool.isEnabled()) continue;

      const existing = toolMap.get(tool.name);
      if (!existing || source.priority > existing.priority) {
        toolMap.set(tool.name, { tool, priority: source.priority });
      }
    }
  }

  // 2. 过滤
  let filtered = Array.from(toolMap.values()).map((e) => e.tool);

  // 白名单过滤
  if (options?.toolNameFilter && options.toolNameFilter.size > 0) {
    filtered = filtered.filter((t) => options.toolNameFilter!.has(t.name));
  }

  // 黑名单过滤
  if (options?.toolNameExclude && options.toolNameExclude.size > 0) {
    filtered = filtered.filter((t) => !options.toolNameExclude!.has(t.name));
  }

  // 只读/破坏性过滤
  if (!includeReadOnly || !includeDestructive) {
    filtered = filtered.filter((t) => {
      // 检查默认行为（传入空输入）
      const isRO = t.isReadOnly({} as Record<string, unknown>);
      const isDestructive = t.isDestructive
        ? t.isDestructive({} as Record<string, unknown>)
        : false;

      if (!includeReadOnly && isRO && !isDestructive) return false;
      if (!includeDestructive && isDestructive) return false;
      return true;
    });
  }

  // 3. 按名称排序（确定性顺序，最大化 Prompt Cache 命中率）
  // 工具列表的顺序一致性直接影响 LLM API 的 prompt cache 效果
  filtered.sort((a, b) => a.name.localeCompare(b.name));

  // 4. 截断
  if (filtered.length > maxTools) {
    filtered = filtered.slice(0, maxTools);
  }

  return filtered;
}

/**
 * 生成工具描述列表（用于 Prompt 注入）。
 */
export function generateToolDescriptions(
  tools: ReadonlyArray<Tool>,
): string {
  return tools
    .map((t) => `- **${t.name}**: ${t.description}`)
    .join("\n");
}

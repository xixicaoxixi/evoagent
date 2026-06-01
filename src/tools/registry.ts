/**
 * 工具注册中心 — 注册表模式。
 *
 * RULES_2-4: 接口 + 注册表。
 * RULES_2-5: 策略模式 > 条件分支。
 */

import type { Tool } from "../interfaces/tool";
import { partitionTools, type ToolPartition } from "./tool-discovery";

// ─── 注册条目 ───

export interface ToolRegistration {
  readonly tool: Tool;
  readonly priority: number;
  readonly source: string;
}

// ─── ToolRegistry ───

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();

  /**
   * 注册工具。
   * 如果同名工具已存在，优先级更高的覆盖。
   */
  register(
    tool: Tool,
    options?: { readonly priority?: number; readonly source?: string },
  ): void {
    const existing = this.tools.get(tool.name);
    const priority = options?.priority ?? 0;
    const source = options?.source ?? "builtin";

    if (!existing || priority > existing.priority) {
      this.tools.set(tool.name, { tool, priority, source });
    }
  }

  /**
   * 注销工具。
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 按名称查找工具。
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  /**
   * 检查工具是否已注册。
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取所有已注册的工具（按优先级降序）。
   */
  listAll(): readonly Tool[] {
    return Array.from(this.tools.values())
      .sort((a, b) => b.priority - a.priority)
      .map((r) => r.tool);
  }

  /**
   * 获取所有已启用的工具。
   */
  listEnabled(): readonly Tool[] {
    return this.listAll().filter((t) => t.isEnabled());
  }

  /**
   * 按来源过滤工具。
   */
  listBySource(source: string): readonly Tool[] {
    return Array.from(this.tools.values())
      .filter((r) => r.source === source)
      .map((r) => r.tool);
  }

  /**
   * 获取工具数量。
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * E.2/M5: 获取立即加载的工具列表（lazyLoad 为 false 或未设置）。
   */
  listEager(): readonly Tool[] {
    return this.partition().eagerTools;
  }

  /**
   * E.2/M5: 获取按需加载的工具列表（lazyLoad 为 true）。
   */
  listOnDemand(): readonly Tool[] {
    return this.partition().onDemandTools;
  }

  /**
   * E.2/M5: 将工具分为 eager 和 onDemand 两组。
   */
  partition(): ToolPartition {
    return partitionTools(this.listAll());
  }
}

/**
 * 创建工具注册中心。
 */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}

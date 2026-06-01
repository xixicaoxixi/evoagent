/**
 * ContextEngine 注册表。
 *
 * RULES_2-4: 接口 + 注册表模式。
 */

import type { ContextEngine, ContextEngineRegistry } from "../interfaces/context-engine";

// ─── 注册表实现 ───

export class ContextEngineRegistryImpl implements ContextEngineRegistry {
  private readonly engines = new Map<string, ContextEngine>();
  private defaultName: string | undefined;

  /**
   * 注册 ContextEngine。
   */
  register(engine: ContextEngine): void {
    this.engines.set(engine.name, engine);
    // 第一个注册的引擎作为默认引擎
    if (!this.defaultName) {
      this.defaultName = engine.name;
    }
  }

  /**
   * 设置默认引擎。
   */
  setDefault(name: string): boolean {
    if (!this.engines.has(name)) return false;
    this.defaultName = name;
    return true;
  }

  /**
   * 按名称解析引擎。
   */
  resolve(name: string): ContextEngine | undefined {
    return this.engines.get(name);
  }

  /**
   * 获取默认引擎。
   */
  getDefault(): ContextEngine | undefined {
    if (!this.defaultName) return undefined;
    return this.engines.get(this.defaultName);
  }

  /**
   * 列出所有已注册的引擎（按优先级排序）。
   */
  listAll(): readonly ContextEngine[] {
    return Array.from(this.engines.values()).sort(
      (a, b) => a.priority - b.priority,
    );
  }

  /**
   * 注销引擎。
   */
  unregister(name: string): boolean {
    if (name === this.defaultName) {
      this.defaultName = undefined;
    }
    return this.engines.delete(name);
  }
}

/**
 * 创建 ContextEngine 注册表。
 */
export function createContextEngineRegistry(): ContextEngineRegistry {
  return new ContextEngineRegistryImpl();
}

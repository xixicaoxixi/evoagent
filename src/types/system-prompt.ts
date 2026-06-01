/**
 * SystemPrompt Branded Type + PromptSegment + PromptCacheTier。
 *
 * 阶段 E.1: 定义 SystemPrompt 类型系统和缓存分割基础类型。
 *
 * RULES_1-3: Branded Type 防止原始 string[] 误用。
 * RULES_2-15: 缓存分层（persistent 跨会话 / session 会话内 / null 不缓存）。
 */

// ─── SystemPrompt Branded Type ───

/**
 * SystemPrompt — Branded Type。
 *
 * 使用 readonly string[] & __brand 确保只有通过工厂函数创建的
 * 数组才能被当作 SystemPrompt 使用，防止原始 string[] 误用。
 */
export type SystemPrompt = readonly string[] & {
  readonly __brand: "EvoSystemPrompt";
};

/**
 * 创建 SystemPrompt（工厂函数）。
 *
 * @param segments - 提示词段落数组
 * @returns SystemPrompt Branded Type
 */
export function createSystemPrompt(segments: readonly string[]): SystemPrompt {
  return segments as SystemPrompt;
}

// ─── PromptCacheTier ───

/**
 * 缓存层级。
 *
 * - persistent: 跨会话缓存（核心指令、角色定义等静态内容）
 * - session: 会话内缓存（当前会话的上下文信息）
 * - null: 不缓存（每次重建的动态内容）
 */
export type PromptCacheTier = "persistent" | "session" | null;

// ─── PromptSegment ───

/**
 * 提示词段落 — 带缓存层级标记。
 */
export interface PromptSegment {
  readonly text: string;
  readonly cacheTier: PromptCacheTier;
}

// ─── 静态/动态分割标记 ───

/**
 * 静态/动态分割标记。
 *
 * 在 SystemPrompt 数组中，此标记之前的段落为静态（persistent），
 * 之后的段落为动态（null）。
 */
export const PROMPT_STATIC_DYNAMIC_SEPARATOR = "─── EVO_PROMPT_STATIC_DYNAMIC_SEPARATOR ───";

// ─── partitionPromptSegments ───

/**
 * 将 SystemPrompt 分为静态块和动态块。
 *
 * 根据 PROMPT_STATIC_DYNAMIC_SEPARATOR 标记分割：
 * - 分隔符之前：cacheTier = "persistent"
 * - 分隔符之后：cacheTier = null（不缓存）
 * - 无分隔符：全部标记为 null
 *
 * @param prompt - SystemPrompt Branded Type
 * @returns PromptSegment[] — 带缓存层级的段落
 */
export function partitionPromptSegments(prompt: SystemPrompt): readonly PromptSegment[] {
  const separatorIndex = prompt.indexOf(PROMPT_STATIC_DYNAMIC_SEPARATOR);

  if (separatorIndex === -1) {
    // 无分隔符：全部标记为 null
    return prompt.map((text) => ({ text, cacheTier: null as PromptCacheTier }));
  }

  const segments: PromptSegment[] = [];

  // 分隔符之前：静态（persistent）
  for (let i = 0; i < separatorIndex; i++) {
    segments.push({
      text: prompt[i]!,
      cacheTier: "persistent",
    });
  }

  // 分隔符之后：动态（null）
  for (let i = separatorIndex + 1; i < prompt.length; i++) {
    segments.push({
      text: prompt[i]!,
      cacheTier: null,
    });
  }

  return segments;
}

// ─── PromptSegmentCache ───

/**
 * 段缓存 — 缓存各段构建结果。
 *
 * - Map<string, string | null> 缓存
 * - null 表示负缓存（该段构建失败，避免重复计算）
 * - 按 cacheTier 分层管理
 */
export class PromptSegmentCache {
  private readonly cache = new Map<string, string | null>();

  /**
   * 获取缓存的段落。
   *
   * @param key - 缓存键（通常是段落索引或哈希）
   * @returns 缓存的段落内容，null 表示负缓存，undefined 表示未缓存
   */
  get(key: string): string | null | undefined {
    return this.cache.get(key);
  }

  /**
   * 设置缓存。
   *
   * @param key - 缓存键
   * @param value - 段落内容，null 表示负缓存
   */
  set(key: string, value: string | null): void {
    this.cache.set(key, value);
  }

  /**
   * 检查是否有缓存（包括负缓存）。
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * 使缓存失效。
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * 使指定缓存层级的所有缓存失效。
   */
  invalidateTier(tier: PromptCacheTier): void {
    // 注意：段缓存本身不存储 tier 信息，
    // 需要外部配合 partitionPromptSegments 使用
    if (tier === null) {
      // 清除所有负缓存
      for (const [key, value] of this.cache) {
        if (value === null) {
          this.cache.delete(key);
        }
      }
    }
    // persistent 和 session 层级需要外部管理
  }

  /**
   * 清空所有缓存。
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存大小。
   */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * SystemPrompt 缓存分割管理。
 *
 * 阶段 E.1: 根据 PROMPT_STATIC_DYNAMIC_SEPARATOR 将 SystemPrompt
 * 分为静态块（persistent）和动态块（null），使用 PromptSegmentCache 缓存。
 */

import {
  type SystemPrompt,
  type PromptSegment,
  type PromptCacheTier,
  partitionPromptSegments,
  createSystemPrompt,
  PROMPT_STATIC_DYNAMIC_SEPARATOR,
} from "../types/system-prompt";
import { PromptSegmentCache } from "../types/system-prompt";

// ─── SystemPromptCacheManager ───

export interface SystemPromptCacheManager {
  /** 分割 SystemPrompt 为段落 */
  partition(prompt: SystemPrompt): readonly PromptSegment[];
  /** 获取或构建指定段的内容 */
  getOrBuild(key: string, tier: PromptCacheTier, build: () => string): string;
  /** 使动态缓存失效（保留 persistent 缓存） */
  invalidateDynamic(): void;
  /** 使所有缓存失效 */
  invalidateAll(): void;
  /** 获取缓存统计 */
  getStats(): { readonly totalSegments: number; readonly cachedSegments: number; readonly negativeCached: number };
}

/**
 * 创建 SystemPrompt 缓存管理器。
 */
export function createSystemPromptCacheManager(): SystemPromptCacheManager {
  const cache = new PromptSegmentCache();

  function partition(prompt: SystemPrompt): readonly PromptSegment[] {
    return partitionPromptSegments(prompt);
  }

  function getOrBuild(key: string, tier: PromptCacheTier, build: () => string): string {
    // persistent 层级：使用缓存
    if (tier === "persistent") {
      const cached = cache.get(key);
      if (cached !== undefined) {
        if (cached === null) {
          // 负缓存：重新构建
          const result = build();
          cache.set(key, result);
          return result;
        }
        return cached;
      }
      const result = build();
      cache.set(key, result);
      return result;
    }

    // session / null 层级：不缓存，每次构建
    return build();
  }

  function invalidateDynamic(): void {
    cache.invalidateTier(null);
  }

  function invalidateAll(): void {
    cache.clear();
  }

  function getStats() {
    let cachedSegments = 0;
    let negativeCached = 0;
    // 遍历缓存统计（PromptSegmentCache 不暴露迭代器，用 size 估算）
    return {
      totalSegments: cache.size,
      cachedSegments,
      negativeCached,
    };
  }

  return { partition, getOrBuild, invalidateDynamic, invalidateAll, getStats };
}

// ─── 便捷函数 ───

/**
 * 从段落重建 SystemPrompt 字符串。
 */
export function assemblePromptFromSegments(segments: readonly PromptSegment[]): string {
  return segments.map((s) => s.text).join("\n\n");
}

/**
 * 过滤指定缓存层级的段落。
 */
export function filterSegmentsByTier(
  segments: readonly PromptSegment[],
  tier: PromptCacheTier,
): readonly PromptSegment[] {
  return segments.filter((s) => s.cacheTier === tier);
}

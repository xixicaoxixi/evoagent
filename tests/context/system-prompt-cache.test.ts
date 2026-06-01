/**
 * Session E.1 测试 — SystemPrompt Branded Type + 缓存分割。
 *
 * 覆盖：
 * - createSystemPrompt 创建 Branded Type
 * - partitionPromptSegments 静态/动态分割
 * - 无分隔符时全部标记为 null
 * - PromptSegmentCache 缓存/负缓存/失效
 * - SystemPromptCacheManager 完整流程
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  createSystemPrompt,
  partitionPromptSegments,
  PromptSegmentCache,
  PROMPT_STATIC_DYNAMIC_SEPARATOR,
  type SystemPrompt,
  type PromptSegment,
} from "../../src/types/system-prompt";
import {
  createSystemPromptCacheManager,
  assemblePromptFromSegments,
  filterSegmentsByTier,
} from "../../src/context/system-prompt";

// ═══════════════════════════════════════════
// createSystemPrompt
// ═══════════════════════════════════════════

describe("createSystemPrompt", () => {
  it("应创建 SystemPrompt Branded Type", () => {
    const prompt = createSystemPrompt(["hello", "world"]);
    expect(Array.isArray(prompt)).toBe(true);
    expect(prompt).toHaveLength(2);
    expect(prompt[0]).toBe("hello");
    expect(prompt[1]).toBe("world");
  });

  it("空数组也应创建成功", () => {
    const prompt = createSystemPrompt([]);
    expect(prompt).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════
// partitionPromptSegments
// ═══════════════════════════════════════════

describe("partitionPromptSegments", () => {
  it("应根据分隔符正确分割静态和动态段落", () => {
    const prompt = createSystemPrompt([
      "核心指令",
      "角色定义",
      PROMPT_STATIC_DYNAMIC_SEPARATOR,
      "当前工作目录",
      "用户上下文",
    ]);

    const segments = partitionPromptSegments(prompt);
    expect(segments).toHaveLength(4); // 不包含分隔符本身

    // 静态段落
    expect(segments[0]?.text).toBe("核心指令");
    expect(segments[0]?.cacheTier).toBe("persistent");
    expect(segments[1]?.text).toBe("角色定义");
    expect(segments[1]?.cacheTier).toBe("persistent");

    // 动态段落
    expect(segments[2]?.text).toBe("当前工作目录");
    expect(segments[2]?.cacheTier).toBeNull();
    expect(segments[3]?.text).toBe("用户上下文");
    expect(segments[3]?.cacheTier).toBeNull();
  });

  it("无分隔符时全部标记为 null", () => {
    const prompt = createSystemPrompt(["指令1", "指令2"]);
    const segments = partitionPromptSegments(prompt);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.cacheTier).toBeNull();
    expect(segments[1]?.cacheTier).toBeNull();
  });

  it("分隔符在开头时全部为动态", () => {
    const prompt = createSystemPrompt([
      PROMPT_STATIC_DYNAMIC_SEPARATOR,
      "动态内容",
    ]);
    const segments = partitionPromptSegments(prompt);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.cacheTier).toBeNull();
  });

  it("分隔符在末尾时全部为静态", () => {
    const prompt = createSystemPrompt([
      "静态内容",
      PROMPT_STATIC_DYNAMIC_SEPARATOR,
    ]);
    const segments = partitionPromptSegments(prompt);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.cacheTier).toBe("persistent");
  });

  it("多个分隔符时以第一个为准", () => {
    const prompt = createSystemPrompt([
      "静态1",
      PROMPT_STATIC_DYNAMIC_SEPARATOR,
      "动态1",
      PROMPT_STATIC_DYNAMIC_SEPARATOR,
      "动态2",
    ]);
    const segments = partitionPromptSegments(prompt);

    // 第一个分隔符之前为静态，之后全部为动态（包括第二个分隔符本身）
    expect(segments).toHaveLength(4);
    expect(segments[0]?.cacheTier).toBe("persistent");
    expect(segments[1]?.cacheTier).toBeNull();
    expect(segments[2]?.cacheTier).toBeNull();
    expect(segments[3]?.cacheTier).toBeNull();
  });

  it("空 SystemPrompt 应返回空数组", () => {
    const prompt = createSystemPrompt([]);
    const segments = partitionPromptSegments(prompt);
    expect(segments).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════
// PromptSegmentCache
// ═══════════════════════════════════════════

describe("PromptSegmentCache", () => {
  let cache: PromptSegmentCache;

  beforeEach(() => {
    cache = new PromptSegmentCache();
  });

  it("应正确存储和获取缓存", () => {
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("应支持负缓存（null）", () => {
    cache.set("key1", null);
    expect(cache.get("key1")).toBeNull();
    expect(cache.has("key1")).toBe(true);
  });

  it("未缓存的键应返回 undefined", () => {
    expect(cache.get("nonexistent")).toBeUndefined();
    expect(cache.has("nonexistent")).toBe(false);
  });

  it("invalidate 应删除指定缓存", () => {
    cache.set("key1", "value1");
    cache.set("key2", "value2");
    cache.invalidate("key1");
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBe("value2");
  });

  it("clear 应清空所有缓存", () => {
    cache.set("key1", "value1");
    cache.set("key2", null);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("key1")).toBeUndefined();
  });

  it("size 应正确反映缓存数量", () => {
    expect(cache.size).toBe(0);
    cache.set("key1", "value1");
    expect(cache.size).toBe(1);
    cache.set("key2", null);
    expect(cache.size).toBe(2);
  });
});

// ═══════════════════════════════════════════
// SystemPromptCacheManager
// ═══════════════════════════════════════════

describe("SystemPromptCacheManager", () => {
  it("partition 应委托 partitionPromptSegments", () => {
    const manager = createSystemPromptCacheManager();
    const prompt = createSystemPrompt(["静态", PROMPT_STATIC_DYNAMIC_SEPARATOR, "动态"]);
    const segments = manager.partition(prompt);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.cacheTier).toBe("persistent");
    expect(segments[1]?.cacheTier).toBeNull();
  });

  it("getOrBuild persistent 应缓存结果", () => {
    const manager = createSystemPromptCacheManager();
    let buildCount = 0;

    const result1 = manager.getOrBuild("key1", "persistent", () => {
      buildCount++;
      return "built-value";
    });
    expect(result1).toBe("built-value");
    expect(buildCount).toBe(1);

    // 第二次调用应使用缓存
    const result2 = manager.getOrBuild("key1", "persistent", () => {
      buildCount++;
      return "new-value";
    });
    expect(result2).toBe("built-value");
    expect(buildCount).toBe(1); // 未重新构建
  });

  it("getOrBuild null 应每次重新构建", () => {
    const manager = createSystemPromptCacheManager();
    let buildCount = 0;

    manager.getOrBuild("key1", null, () => {
      buildCount++;
      return "value";
    });
    manager.getOrBuild("key1", null, () => {
      buildCount++;
      return "value";
    });
    expect(buildCount).toBe(2); // 每次都重新构建
  });

  it("invalidateAll 应清除所有缓存", () => {
    const manager = createSystemPromptCacheManager();
    let buildCount = 0;

    manager.getOrBuild("key1", "persistent", () => {
      buildCount++;
      return "value1";
    });

    manager.invalidateAll();

    manager.getOrBuild("key1", "persistent", () => {
      buildCount++;
      return "value2";
    });
    expect(buildCount).toBe(2); // 重新构建
  });
});

// ═══════════════════════════════════════════
// assemblePromptFromSegments
// ═══════════════════════════════════════════

describe("assemblePromptFromSegments", () => {
  it("应将段落组装为字符串", () => {
    const segments: readonly PromptSegment[] = [
      { text: "段1", cacheTier: "persistent" },
      { text: "段2", cacheTier: null },
    ];
    const result = assemblePromptFromSegments(segments);
    expect(result).toBe("段1\n\n段2");
  });

  it("空段落应返回空字符串", () => {
    expect(assemblePromptFromSegments([])).toBe("");
  });
});

// ═══════════════════════════════════════════
// filterSegmentsByTier
// ═══════════════════════════════════════════

describe("filterSegmentsByTier", () => {
  it("应过滤指定缓存层级的段落", () => {
    const segments: readonly PromptSegment[] = [
      { text: "静态1", cacheTier: "persistent" },
      { text: "动态1", cacheTier: null },
      { text: "静态2", cacheTier: "persistent" },
    ];

    const persistent = filterSegmentsByTier(segments, "persistent");
    expect(persistent).toHaveLength(2);

    const dynamic = filterSegmentsByTier(segments, null);
    expect(dynamic).toHaveLength(1);
  });
});

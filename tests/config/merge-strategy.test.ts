/**
 * Session D.2 测试 — 多层级配置合并策略。
 *
 * 验证 Rules 叠加合并、Skills 按名称覆盖、Hooks 合并执行、MergeStrategy 枚举。
 */

import { describe, expect, it } from "vitest";
import {
  createConfigMerger,
  type ConfigMerger,
  type LayeredConfigItem,
  type MergeResult,
} from "../../src/config/merge";
import type { MergeStrategy, ConfigLayer } from "../../src/schemas/config";
import { LAYER_PRIORITY } from "../../src/schemas/config";

// ─── 辅助函数 ───

function createMerger(): ConfigMerger {
  return createConfigMerger();
}

function item<T>(
  value: T,
  layer: ConfigLayer,
  key?: string,
): LayeredConfigItem<T> {
  return { value, layer, key };
}

// ─── 测试：MergeStrategy 类型 ───

describe("MergeStrategy 类型", () => {
  it("包含三种策略", () => {
    const strategies: MergeStrategy[] = ["overlay", "stack", "merge"];
    expect(strategies).toHaveLength(3);
  });
});

// ─── 测试：ConfigLayer 类型 ───

describe("ConfigLayer 类型", () => {
  it("包含五个层级", () => {
    const layers: ConfigLayer[] = [
      "managed", "user", "project", "workspace", "builtin",
    ];
    expect(layers).toHaveLength(5);
  });

  it("LAYER_PRIORITY 优先级正确", () => {
    expect(LAYER_PRIORITY.managed).toBeLessThan(LAYER_PRIORITY.user);
    expect(LAYER_PRIORITY.user).toBeLessThan(LAYER_PRIORITY.project);
    expect(LAYER_PRIORITY.project).toBeLessThan(LAYER_PRIORITY.workspace);
    expect(LAYER_PRIORITY.workspace).toBeLessThan(LAYER_PRIORITY.builtin);
  });
});

// ─── 测试：层级优先级比较 ───

describe("compareLayerPriority", () => {
  const merger = createMerger();

  it("managed 优先于 user", () => {
    expect(merger.compareLayerPriority("managed", "user")).toBeLessThan(0);
  });

  it("user 优先于 project", () => {
    expect(merger.compareLayerPriority("user", "project")).toBeLessThan(0);
  });

  it("相同层级返回 0", () => {
    expect(merger.compareLayerPriority("user", "user")).toBe(0);
  });

  it("builtin 优先级最低", () => {
    expect(merger.compareLayerPriority("builtin", "managed")).toBeGreaterThan(0);
  });
});

// ─── 测试：Overlay 策略（Skills 按名称覆盖） ───

describe("Overlay 策略", () => {
  it("同 key 的高优先级覆盖低优先级", () => {
    const merger = createMerger();
    const items = [
      item("builtin-skill", "builtin", "code-review"),
      item("user-skill", "user", "code-review"),
      item("managed-skill", "managed", "code-review"),
    ];

    const result = merger.overlay(items);

    const values = result.value as string[];
    // managed 优先级最高，只保留 managed 版本
    expect(values).toHaveLength(1);
    expect(values[0]).toBe("managed-skill");
  });

  it("不同 key 的项全部保留", () => {
    const merger = createMerger();
    const items = [
      item("skill-a", "user", "skill-a"),
      item("skill-b", "managed", "skill-b"),
      item("skill-c", "project", "skill-c"),
    ];

    const result = merger.overlay(items);

    const values = result.value as string[];
    expect(values).toHaveLength(3);
  });

  it("无 key 的项全部保留", () => {
    const merger = createMerger();
    const items = [
      item("anonymous-1", "user"),
      item("anonymous-2", "managed"),
    ];

    const result = merger.overlay(items);

    const values = result.value as string[];
    expect(values).toHaveLength(2);
  });

  it("混合有 key 和无 key 的项", () => {
    const merger = createMerger();
    const items = [
      item("builtin-review", "builtin", "code-review"),
      item("user-review", "user", "code-review"),
      item("anonymous-skill", "project"),
    ];

    const result = merger.overlay(items);

    const values = result.value as string[];
    // user 覆盖 builtin 的 code-review + anonymous
    expect(values).toHaveLength(2);
    expect(values).toContain("user-review");
    expect(values).toContain("anonymous-skill");
  });

  it("结果记录参与合并的层级", () => {
    const merger = createMerger();
    const items = [
      item("v1", "builtin", "key"),
      item("v2", "user", "key"),
    ];

    const result = merger.overlay(items);

    // user 覆盖了 builtin，但两个层级都参与了合并
    expect(result.layers).toContain("user");
  });

  it("空输入返回空结果", () => {
    const merger = createMerger();
    const result = merger.overlay([]);

    expect(result.value).toEqual([]);
    expect(result.layers).toEqual([]);
  });

  it("结果策略标记为 overlay", () => {
    const merger = createMerger();
    const result = merger.overlay([item("v", "user", "k")]);

    expect(result.strategy).toBe("overlay");
  });
});

// ─── 测试：Stack 策略（Rules 叠加合并） ───

describe("Stack 策略", () => {
  it("所有项叠加保留", () => {
    const merger = createMerger();
    const items = [
      item("rule-1", "builtin"),
      item("rule-2", "managed"),
      item("rule-3", "user"),
    ];

    const result = merger.stack(items);

    const values = result.value as string[];
    expect(values).toHaveLength(3);
  });

  it("按优先级排序（高优先级在前）", () => {
    const merger = createMerger();
    const items = [
      item("builtin-rule", "builtin"),
      item("user-rule", "user"),
      item("managed-rule", "managed"),
    ];

    const result = merger.stack(items);

    const values = result.value as string[];
    expect(values[0]).toBe("managed-rule");
    expect(values[1]).toBe("user-rule");
    expect(values[2]).toBe("builtin-rule");
  });

  it("同层级保持原始顺序", () => {
    const merger = createMerger();
    const items = [
      item("user-a", "user"),
      item("user-b", "user"),
      item("managed-c", "managed"),
    ];

    const result = merger.stack(items);

    const values = result.value as string[];
    // managed 在前，user 保持原始顺序
    expect(values[0]).toBe("managed-c");
    expect(values[1]).toBe("user-a");
    expect(values[2]).toBe("user-b");
  });

  it("记录所有参与层级", () => {
    const merger = createMerger();
    const items = [
      item("r1", "managed"),
      item("r2", "user"),
      item("r3", "builtin"),
    ];

    const result = merger.stack(items);

    expect(result.layers).toEqual(["managed", "user", "builtin"]);
  });

  it("空输入返回空结果", () => {
    const merger = createMerger();
    const result = merger.stack([]);

    expect(result.value).toEqual([]);
    expect(result.layers).toEqual([]);
  });

  it("结果策略标记为 stack", () => {
    const merger = createMerger();
    const result = merger.stack([item("v", "user")]);

    expect(result.strategy).toBe("stack");
  });
});

// ─── 测试：Merge 策略（Hooks 合并执行） ───

describe("Merge 策略", () => {
  it("同 key 的值使用 mergeFn 合并", () => {
    const merger = createMerger();
    const items = [
      item(["hook-a1", "hook-a2"], "user", "event-x"),
      item(["hook-a3"], "managed", "event-x"),
    ];

    const result = merger.mergeByKey(items, (a, b) => [...a, ...b]);

    const values = result.value as string[][];
    expect(values).toHaveLength(1);
    // managed 的 hooks 排在前面（高优先级先处理）
    expect(values[0]).toEqual(["hook-a3", "hook-a1", "hook-a2"]);
  });

  it("不同 key 的项分别合并", () => {
    const merger = createMerger();
    const items = [
      item(["handler-1"], "user", "event-a"),
      item(["handler-2"], "managed", "event-b"),
    ];

    const result = merger.mergeByKey(items, (a, b) => [...a, ...b]);

    const values = result.value as string[][];
    expect(values).toHaveLength(2);
  });

  it("三个层级的 hooks 合并", () => {
    const merger = createMerger();
    const items = [
      item(["builtin-hook"], "builtin", "pre-commit"),
      item(["user-hook"], "user", "pre-commit"),
      item(["managed-hook"], "managed", "pre-commit"),
    ];

    const result = merger.mergeByKey(items, (a, b) => [...a, ...b]);

    const values = result.value as string[][];
    expect(values).toHaveLength(1);
    // managed > user > builtin
    expect(values[0]).toEqual(["managed-hook", "user-hook", "builtin-hook"]);
  });

  it("无 key 的项独立保留", () => {
    const merger = createMerger();
    const items = [
      item(["hook-1"], "user", "event-a"),
      item(["anonymous-hook"], "managed"),
    ];

    const result = merger.mergeByKey(items, (a, b) => [...a, ...b]);

    const values = result.value as string[][];
    expect(values).toHaveLength(2);
  });

  it("空输入返回空结果", () => {
    const merger = createMerger();
    const result = merger.mergeByKey([], (a, b) => b);

    expect(result.value).toEqual([]);
  });

  it("结果策略标记为 merge", () => {
    const merger = createMerger();
    const result = merger.mergeByKey(
      [item("v", "user", "k")],
      (a, b) => b,
    );

    expect(result.strategy).toBe("merge");
  });
});

// ─── 测试：通用 merge 方法 ───

describe("通用 merge 方法", () => {
  it("overlay 策略委托给 overlay", () => {
    const merger = createMerger();
    const items = [
      item("v1", "builtin", "k"),
      item("v2", "managed", "k"),
    ];

    const result = merger.merge(items, "overlay");
    expect(result.strategy).toBe("overlay");

    const values = result.value as string[];
    expect(values).toHaveLength(1);
    expect(values[0]).toBe("v2");
  });

  it("stack 策略委托给 stack", () => {
    const merger = createMerger();
    const items = [item("v1", "builtin"), item("v2", "managed")];

    const result = merger.merge(items, "stack");
    expect(result.strategy).toBe("stack");

    const values = result.value as string[];
    expect(values).toHaveLength(2);
  });

  it("merge 策略使用默认合并（数组拼接）", () => {
    const merger = createMerger();
    const items = [
      item(["a"], "user", "k"),
      item(["b"], "managed", "k"),
    ];

    const result = merger.merge(items, "merge");
    expect(result.strategy).toBe("merge");

    const values = result.value as string[][];
    expect(values).toHaveLength(1);
    expect(values[0]).toEqual(["b", "a"]);
  });
});

// ─── 测试：MergeResult 结构 ───

describe("MergeResult 结构", () => {
  it("包含所有必要字段", () => {
    const merger = createMerger();
    const result = merger.stack([item("v", "user")]);

    expect(result).toHaveProperty("value");
    expect(result).toHaveProperty("layers");
    expect(result).toHaveProperty("strategy");
  });

  it("layers 按优先级排序", () => {
    const merger = createMerger();
    const items = [
      item("v", "builtin"),
      item("v", "user"),
      item("v", "managed"),
      item("v", "workspace"),
    ];

    const result = merger.stack(items);

    expect(result.layers).toEqual(["managed", "user", "workspace", "builtin"]);
  });
});

// ─── 测试：LayeredConfigItem 类型 ───

describe("LayeredConfigItem 类型", () => {
  it("key 为可选字段", () => {
    const withKey: LayeredConfigItem<string> = {
      value: "test",
      layer: "user",
      key: "my-key",
    };
    expect(withKey.key).toBe("my-key");

    const withoutKey: LayeredConfigItem<string> = {
      value: "test",
      layer: "user",
    };
    expect(withoutKey.key).toBeUndefined();
  });
});

// ─── 测试：真实场景模拟 ───

describe("真实场景模拟", () => {
  it("Skills 多层级覆盖", () => {
    const merger = createMerger();
    const items: LayeredConfigItem<string>[] = [
      // builtin 提供 code-review
      item("builtin-code-review", "builtin", "code-review"),
      // user 覆盖 code-review
      item("user-code-review", "user", "code-review"),
      // managed 覆盖 code-review
      item("managed-code-review", "managed", "code-review"),
      // user 独有的 skill
      item("user-custom-skill", "user", "custom-skill"),
      // project 独有的 skill
      item("project-test-skill", "project", "test-skill"),
    ];

    const result = merger.overlay(items);
    const values = result.value as string[];

    // code-review 只保留 managed 版本
    expect(values).toContain("managed-code-review");
    expect(values).not.toContain("builtin-code-review");
    expect(values).not.toContain("user-code-review");
    // 其他 skill 保留
    expect(values).toContain("user-custom-skill");
    expect(values).toContain("project-test-skill");
    expect(values).toHaveLength(3);
  });

  it("Rules 多层级叠加", () => {
    const merger = createMerger();
    const items: LayeredConfigItem<string>[] = [
      item("Use TypeScript strict mode", "builtin"),
      item("Always validate input", "managed"),
      item("Follow project naming conventions", "project"),
      item("Write tests for new code", "user"),
    ];

    const result = merger.stack(items);
    const values = result.value as string[];

    // 所有规则都保留，按优先级排序
    expect(values).toHaveLength(4);
    expect(values[0]).toBe("Always validate input"); // managed
    expect(values[1]).toBe("Write tests for new code"); // user
    expect(values[2]).toBe("Follow project naming conventions"); // project
    expect(values[3]).toBe("Use TypeScript strict mode"); // builtin
  });

  it("Hooks 多层级合并", () => {
    const merger = createMerger();
    const items: LayeredConfigItem<string[]>[] = [
      item(["builtin-lint"], "builtin", "pre-commit"),
      item(["user-format"], "user", "pre-commit"),
      item(["managed-security-check"], "managed", "pre-commit"),
    ];

    const result = merger.mergeByKey(items, (a, b) => [...a, ...b]);
    const values = result.value as string[][];

    expect(values).toHaveLength(1);
    // 所有 hooks 合并执行，按优先级排序
    expect(values[0]).toEqual([
      "managed-security-check",
      "user-format",
      "builtin-lint",
    ]);
  });
});

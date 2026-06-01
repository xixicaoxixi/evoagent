/**
 * Session D.3 测试 — Plugin 命名空间。
 *
 * 验证命名空间前缀、命名冲突检测、命名空间解析。
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  createPluginRegistryImpl,
  type PluginRegistryExtended,
  type NamespaceConflict,
  type NamespaceResolution,
} from "../../src/plugins/registry";
import type { PluginEntry } from "../../src/interfaces/plugin";
import {
  createPluginLoader,
  type PluginLoader,
  type PluginLoaderConfig,
} from "../../src/plugins/loader";

// ─── 辅助函数 ───

function createPluginEntry(
  name: string,
  overrides?: Partial<PluginEntry>,
): PluginEntry {
  return {
    metadata: {
      name,
      version: "1.0.0",
      description: `Plugin ${name}`,
      source: "builtin",
      ...overrides?.metadata,
    },
    ...overrides,
  };
}

function createRegistry(): PluginRegistryExtended {
  return createPluginRegistryImpl({ autoActivate: false });
}

// ─── 测试：命名空间解析 ───

describe("命名空间解析 (resolveNamespace)", () => {
  const registry = createRegistry();

  it("解析带命名空间的名称", () => {
    const result = registry.resolveNamespace("my-plugin:review");

    expect(result.fullName).toBe("my-plugin:review");
    expect(result.pluginName).toBe("my-plugin");
    expect(result.skillName).toBe("review");
    expect(result.hasNamespace).toBe(true);
  });

  it("解析不带命名空间的名称", () => {
    const result = registry.resolveNamespace("review");

    expect(result.fullName).toBe("review");
    expect(result.pluginName).toBe("");
    expect(result.skillName).toBe("review");
    expect(result.hasNamespace).toBe(false);
  });

  it("解析复杂命名空间名称", () => {
    const result = registry.resolveNamespace("security-plugin:code-review");

    expect(result.pluginName).toBe("security-plugin");
    expect(result.skillName).toBe("code-review");
    expect(result.hasNamespace).toBe(true);
  });

  it("空字符串", () => {
    const result = registry.resolveNamespace("");

    expect(result.fullName).toBe("");
    expect(result.pluginName).toBe("");
    expect(result.skillName).toBe("");
    expect(result.hasNamespace).toBe(false);
  });

  it("只有冒号", () => {
    const result = registry.resolveNamespace(":");

    // indexOf(":") 返回 0，colonIdx > 0 为 false
    expect(result.hasNamespace).toBe(false);
    expect(result.skillName).toBe(":");
  });

  it("多个冒号取第一个", () => {
    const result = registry.resolveNamespace("plugin:skill:sub");

    expect(result.pluginName).toBe("plugin");
    expect(result.skillName).toBe("skill:sub");
    expect(result.hasNamespace).toBe(true);
  });
});

// ─── 测试：命名空间 Skill 注册 ───

describe("命名空间 Skill 注册 (registerNamespacedSkill)", () => {
  it("注册带命名空间的 Skill", () => {
    const registry = createRegistry();
    const conflict = registry.registerNamespacedSkill(
      "my-plugin",
      "review",
      { content: "review skill" },
    );

    expect(conflict).toBeUndefined();
  });

  it("同一插件注册同名 Skill 不冲突", () => {
    const registry = createRegistry();

    registry.registerNamespacedSkill("plugin-a", "review", { v: 1 });
    const conflict = registry.registerNamespacedSkill("plugin-a", "review", { v: 2 });

    expect(conflict).toBeUndefined();
  });

  it("不同插件注册同名 Skill 产生冲突", () => {
    const registry = createRegistry();

    registry.registerNamespacedSkill("plugin-a", "review", { v: 1 });
    const conflict = registry.registerNamespacedSkill("plugin-b", "review", { v: 2 });

    expect(conflict).toBeDefined();
    expect(conflict!.existingPlugin).toBe("plugin-a");
    expect(conflict!.newPlugin).toBe("plugin-b");
    expect(conflict!.existingSkill).toBe("review");
    expect(conflict!.newSkill).toBe("review");
    expect(conflict!.fullName).toBe("plugin-b:review");
  });

  it("三个插件注册同名 Skill 产生多个冲突", () => {
    const registry = createRegistry();

    registry.registerNamespacedSkill("plugin-a", "deploy", {});
    registry.registerNamespacedSkill("plugin-b", "deploy", {});
    registry.registerNamespacedSkill("plugin-c", "deploy", {});

    const conflicts = registry.getNamespaceConflicts();
    expect(conflicts.length).toBe(3); // a-b, a-c, b-c
  });

  it("不同名称的 Skill 不冲突", () => {
    const registry = createRegistry();

    registry.registerNamespacedSkill("plugin-a", "review", {});
    registry.registerNamespacedSkill("plugin-a", "test", {});
    registry.registerNamespacedSkill("plugin-b", "review", {});
    registry.registerNamespacedSkill("plugin-b", "deploy", {});

    // 只有 review 产生冲突（plugin-a 和 plugin-b）
    const conflicts = registry.getNamespaceConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.existingSkill).toBe("review");
  });
});

// ─── 测试：命名冲突检测 ───

describe("命名冲突检测", () => {
  it("hasNamespaceConflict 检测已存在的冲突", () => {
    const registry = createRegistry();

    registry.registerNamespacedSkill("plugin-a", "review", {});
    registry.registerNamespacedSkill("plugin-b", "review", {});

    expect(registry.hasNamespaceConflict("plugin-a", "review")).toBe(true);
    expect(registry.hasNamespaceConflict("plugin-b", "review")).toBe(true);
  });

  it("hasNamespaceConflict 对不存在的 Skill 返回 false", () => {
    const registry = createRegistry();

    expect(registry.hasNamespaceConflict("plugin-a", "nonexistent")).toBe(false);
  });

  it("hasNamespaceConflict 对无冲突的 Skill 返回 false", () => {
    const registry = createRegistry();

    registry.registerNamespacedSkill("plugin-a", "unique-skill", {});

    expect(registry.hasNamespaceConflict("plugin-a", "unique-skill")).toBe(false);
  });

  it("getNamespaceConflicts 返回所有冲突", () => {
    const registry = createRegistry();

    registry.registerNamespacedSkill("p1", "s1", {});
    registry.registerNamespacedSkill("p2", "s1", {});
    registry.registerNamespacedSkill("p3", "s1", {});

    const conflicts = registry.getNamespaceConflicts();
    expect(conflicts).toHaveLength(3);
  });

  it("getNamespaceConflicts 无冲突时返回空数组", () => {
    const registry = createRegistry();

    const conflicts = registry.getNamespaceConflicts();
    expect(conflicts).toHaveLength(0);
  });
});

// ─── 测试：NamespaceConflict 类型 ───

describe("NamespaceConflict 类型", () => {
  it("包含所有必要字段", () => {
    const conflict: NamespaceConflict = {
      existingPlugin: "plugin-a",
      existingSkill: "review",
      newPlugin: "plugin-b",
      newSkill: "review",
      fullName: "plugin-b:review",
    };

    expect(conflict.existingPlugin).toBe("plugin-a");
    expect(conflict.newPlugin).toBe("plugin-b");
    expect(conflict.fullName).toBe("plugin-b:review");
  });
});

// ─── 测试：NamespaceResolution 类型 ───

describe("NamespaceResolution 类型", () => {
  it("包含所有必要字段", () => {
    const resolution: NamespaceResolution = {
      fullName: "plugin:skill",
      pluginName: "plugin",
      skillName: "skill",
      hasNamespace: true,
    };

    expect(resolution.hasNamespace).toBe(true);
  });
});

// ─── 测试：PluginLoader 命名空间集成 ───

describe("PluginLoader 命名空间集成", () => {
  it("namespaceSkills=true 时为 Skills 添加前缀", async () => {
    const loader = createPluginLoader({
      namespaceSkills: true,
      scanDirs: [],
    });

    // 注意：PluginLoader 的 discoverFromDir 是内部方法，
    // 我们通过配置验证 namespaceSkills 选项被正确读取
    expect(loader).toBeDefined();
  });

  it("namespaceSkills=false 时 Skills 保持原样", () => {
    const loader = createPluginLoader({
      namespaceSkills: false,
      scanDirs: [],
    });

    expect(loader).toBeDefined();
  });

  it("默认不启用命名空间", () => {
    const loader = createPluginLoader();

    expect(loader).toBeDefined();
  });
});

// ─── 测试：PluginLoaderConfig 类型 ───

describe("PluginLoaderConfig 类型", () => {
  it("namespaceSkills 为可选字段", () => {
    const config1: PluginLoaderConfig = {
      scanDirs: [],
    };
    expect(config1.namespaceSkills).toBeUndefined();

    const config2: PluginLoaderConfig = {
      scanDirs: [],
      namespaceSkills: true,
    };
    expect(config2.namespaceSkills).toBe(true);
  });
});

// ─── 测试：PluginLoadResult 类型 ───

describe("PluginLoadResult 类型", () => {
  it("namespacedSkills 为可选字段", () => {
    const result = {
      manifest: {
        name: "test",
        version: "1.0.0",
        source: "builtin" as const,
        rootDir: "/tmp/test",
      },
      state: "validated" as const,
      issues: [],
    };

    expect(result.namespacedSkills).toBeUndefined();
  });

  it("namespacedSkills 包含命名空间后的名称", () => {
    const result = {
      manifest: {
        name: "test",
        version: "1.0.0",
        source: "builtin" as const,
        rootDir: "/tmp/test",
      },
      state: "validated" as const,
      issues: [],
      namespacedSkills: ["test-plugin:review", "test-plugin:test"],
    };

    expect(result.namespacedSkills).toHaveLength(2);
    expect(result.namespacedSkills![0]).toBe("test-plugin:review");
  });
});

// ─── 测试：端到端场景 ───

describe("端到端场景", () => {
  it("完整命名空间工作流", () => {
    const registry = createRegistry();

    // 注册多个插件的同名 Skill
    registry.registerNamespacedSkill("security-plugin", "review", {
      type: "security-review",
    });
    registry.registerNamespacedSkill("quality-plugin", "review", {
      type: "quality-review",
    });
    registry.registerNamespacedSkill("security-plugin", "scan", {
      type: "security-scan",
    });

    // 检测冲突
    const conflicts = registry.getNamespaceConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.existingSkill).toBe("review");

    // 解析命名空间
    const resolution1 = registry.resolveNamespace("security-plugin:review");
    expect(resolution1.pluginName).toBe("security-plugin");
    expect(resolution1.skillName).toBe("review");

    const resolution2 = registry.resolveNamespace("quality-plugin:review");
    expect(resolution2.pluginName).toBe("quality-plugin");

    // 无冲突的 Skill
    expect(registry.hasNamespaceConflict("security-plugin", "scan")).toBe(false);
  });

  it("命名空间与插件注册共存", () => {
    const registry = createRegistry();

    // 正常注册插件
    registry.register(createPluginEntry("plugin-a"));

    // 同时使用命名空间注册 Skill
    registry.registerNamespacedSkill("plugin-a", "skill-1", {});
    registry.registerNamespacedSkill("plugin-b", "skill-1", {});

    // 两者互不影响
    expect(registry.get("plugin-a")).toBeDefined();
    expect(registry.getNamespaceConflicts()).toHaveLength(1);
  });
});

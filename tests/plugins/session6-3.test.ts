/**
 * Session 6.3 测试 — Plugin SDK + PluginRegistry。
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  definePluginEntry,
  validatePluginContract,
  type PluginDefinitionInput,
} from "../../src/plugins/sdk";
import {
  createPluginRegistryImpl,
  type PluginRegistryExtended,
  type PluginRegistration,
} from "../../src/plugins/registry";

// ─── 测试辅助 ───

function makePluginInput(
  overrides: Partial<PluginDefinitionInput> = {},
): PluginDefinitionInput {
  return {
    name: "test-plugin",
    version: "1.0.0",
    description: "A test plugin",
    ...overrides,
  };
}

// ─── validatePluginContract 测试 ───

describe("validatePluginContract", () => {
  it("有效契约通过验证", () => {
    const result = validatePluginContract({
      name: "test",
      version: "1.0.0",
      description: "A test plugin",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("缺少 name 失败", () => {
    const result = validatePluginContract({
      version: "1.0.0",
      description: "A test plugin",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("空 name 失败", () => {
    const result = validatePluginContract({
      name: "",
      version: "1.0.0",
      description: "A test plugin",
    });
    expect(result.valid).toBe(false);
  });

  it("无效 source 失败", () => {
    const result = validatePluginContract({
      name: "test",
      version: "1.0.0",
      description: "A test plugin",
      source: "invalid" as "builtin",
    });
    expect(result.valid).toBe(false);
  });

  it("有效 source 通过", () => {
    for (const source of ["builtin", "user", "community", "mcp", "remote"] as const) {
      const result = validatePluginContract({
        name: "test",
        version: "1.0.0",
        description: "A test plugin",
        source,
      });
      expect(result.valid).toBe(true);
    }
  });

  it("非对象输入失败", () => {
    expect(validatePluginContract(null).valid).toBe(false);
    expect(validatePluginContract("string").valid).toBe(false);
    expect(validatePluginContract(42).valid).toBe(false);
  });
});

// ─── definePluginEntry 测试 ───

describe("definePluginEntry", () => {
  it("创建有效插件", () => {
    const plugin = definePluginEntry(makePluginInput());
    expect(plugin.metadata.name).toBe("test-plugin");
    expect(plugin.metadata.version).toBe("1.0.0");
    expect(plugin.metadata.description).toBe("A test plugin");
    expect(plugin.metadata.source).toBe("user");
  });

  it("无效输入抛出错误", () => {
    expect(() => definePluginEntry({ name: "", version: "", description: "" })).toThrow();
  });

  it("包含工具", () => {
    const mockTool = {
      name: "test-tool",
      description: "A test tool",
      inputSchema: {} as unknown,
      call: async () => ({ content: "", isError: false }),
      checkPermissions: async () => ({ behavior: "allow" }),
      isEnabled: () => true,
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
    };

    const plugin = definePluginEntry(makePluginInput({ tools: [mockTool] }));
    expect(plugin.tools).toHaveLength(1);
    expect(plugin.tools![0]!.name).toBe("test-tool");
  });

  it("包含钩子", () => {
    const plugin = definePluginEntry(
      makePluginInput({
        hooks: [
          {
            event: "tool:after_call",
            handler: async () => {},
            priority: 50,
          },
        ],
      }),
    );
    expect(plugin.hooks).toHaveLength(1);
    expect(plugin.hooks![0]!.event).toBe("tool:after_call");
    expect(plugin.hooks![0]!.priority).toBe(50);
  });

  it("钩子无 priority 时省略", () => {
    const plugin = definePluginEntry(
      makePluginInput({
        hooks: [{ event: "test", handler: async () => {} }],
      }),
    );
    expect(plugin.hooks![0]!.priority).toBeUndefined();
  });

  it("默认 source 为 user", () => {
    const plugin = definePluginEntry(makePluginInput());
    expect(plugin.metadata.source).toBe("user");
  });

  it("自定义 source", () => {
    const plugin = definePluginEntry(
      makePluginInput({ source: "builtin" }),
    );
    expect(plugin.metadata.source).toBe("builtin");
  });

  it("包含激活条件", () => {
    const plugin = definePluginEntry(
      makePluginInput({ activationCondition: "file:*.ts" }),
    );
    expect(plugin.activationCondition).toBe("file:*.ts");
  });

  it("包含 activate/deactivate", async () => {
    let activated = false;
    let deactivated = false;

    const plugin = definePluginEntry(
      makePluginInput({
        activate: async () => { activated = true; },
        deactivate: async () => { deactivated = true; },
      }),
    );

    await plugin.activate!();
    expect(activated).toBe(true);

    await plugin.deactivate!();
    expect(deactivated).toBe(true);
  });
});

// ─── PluginRegistry 测试 ───

describe("PluginRegistry", () => {
  let registry: PluginRegistryExtended;

  beforeEach(() => {
    registry = createPluginRegistryImpl({ autoActivate: false });
  });

  it("注册和获取插件", () => {
    const plugin = definePluginEntry(makePluginInput({ name: "p1" }));
    registry.register(plugin);
    expect(registry.get("p1")).toBe(plugin);
  });

  it("重复注册抛出错误", () => {
    const plugin = definePluginEntry(makePluginInput({ name: "p1" }));
    registry.register(plugin);
    expect(() => registry.register(plugin)).toThrow("already registered");
  });

  it("无效插件注册抛出错误", () => {
    const badPlugin = definePluginEntry(makePluginInput({ name: "bad" }));
    // 手动创建一个无效插件
    const invalidPlugin = {
      ...badPlugin,
      metadata: { ...badPlugin.metadata, name: "" },
    };
    expect(() => registry.register(invalidPlugin)).toThrow();
  });

  it("插件上限检查", () => {
    const reg = createPluginRegistryImpl({ maxPlugins: 2, autoActivate: false });
    reg.register(definePluginEntry(makePluginInput({ name: "p1" })));
    reg.register(definePluginEntry(makePluginInput({ name: "p2" })));
    expect(() =>
      reg.register(definePluginEntry(makePluginInput({ name: "p3" }))),
    ).toThrow("Plugin limit reached");
  });

  it("注销插件", () => {
    const plugin = definePluginEntry(makePluginInput({ name: "p1" }));
    registry.register(plugin);
    expect(registry.unregister("p1")).toBe(true);
    expect(registry.get("p1")).toBeUndefined();
  });

  it("注销不存在的插件返回 false", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("注销时调用 deactivate", async () => {
    let deactivated = false;
    const plugin = definePluginEntry(
      makePluginInput({
        name: "p1",
        deactivate: async () => { deactivated = true; },
      }),
    );

    registry.register(plugin);
    registry.activatePlugin("p1");
    registry.unregister("p1");
    expect(deactivated).toBe(true);
  });

  it("listAll 返回所有插件", () => {
    registry.register(definePluginEntry(makePluginInput({ name: "p1" })));
    registry.register(definePluginEntry(makePluginInput({ name: "p2" })));
    expect(registry.listAll()).toHaveLength(2);
  });

  it("listBySource 按来源筛选", () => {
    registry.register(
      definePluginEntry(makePluginInput({ name: "p1", source: "builtin" })),
    );
    registry.register(
      definePluginEntry(makePluginInput({ name: "p2", source: "user" })),
    );
    registry.register(
      definePluginEntry(makePluginInput({ name: "p3", source: "builtin" })),
    );

    const builtin = registry.listBySource("builtin");
    expect(builtin).toHaveLength(2);
  });

  it("count 返回数量", () => {
    registry.register(definePluginEntry(makePluginInput({ name: "p1" })));
    registry.register(definePluginEntry(makePluginInput({ name: "p2" })));
    expect(registry.count()).toBe(2);
  });
});

describe("PluginRegistry > 生命周期", () => {
  let registry: PluginRegistryExtended;

  beforeEach(() => {
    registry = createPluginRegistryImpl({ autoActivate: false });
  });

  it("初始状态为 registered", () => {
    registry.register(definePluginEntry(makePluginInput({ name: "p1" })));
    expect(registry.getState("p1")).toBe("registered");
  });

  it("activatePlugin 激活插件", () => {
    registry.register(definePluginEntry(makePluginInput({ name: "p1" })));
    expect(registry.activatePlugin("p1")).toBe(true);
    expect(registry.getState("p1")).toBe("activated");
  });

  it("activatePlugin 不存在的插件返回 false", () => {
    expect(registry.activatePlugin("nonexistent")).toBe(false);
  });

  it("已激活的插件再次激活返回 true", () => {
    registry.register(definePluginEntry(makePluginInput({ name: "p1" })));
    registry.activatePlugin("p1");
    expect(registry.activatePlugin("p1")).toBe(true);
  });

  it("无 activate 方法的插件直接标记为 activated", () => {
    registry.register(definePluginEntry(makePluginInput({ name: "p1" })));
    registry.activatePlugin("p1");
    expect(registry.getState("p1")).toBe("activated");
  });

  it("activate 异步成功后状态变为 activated", async () => {
    const plugin = definePluginEntry(
      makePluginInput({
        name: "p1",
        activate: async () => {
          await new Promise((r) => setTimeout(r, 10));
        },
      }),
    );

    registry.register(plugin);
    registry.activatePlugin("p1");

    // 等待异步激活完成
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.getState("p1")).toBe("activated");
  });

  it("activate 异步失败后状态变为 error", async () => {
    const plugin = definePluginEntry(
      makePluginInput({
        name: "p1",
        activate: async () => {
          await new Promise((r) => setTimeout(r, 10));
          throw new Error("activation failed");
        },
      }),
    );

    registry.register(plugin);
    registry.activatePlugin("p1");

    // 等待异步激活完成
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.getState("p1")).toBe("error");
    const reg = registry.getRegistration("p1");
    expect(reg!.error).toContain("activation failed");
  });

  it("autoActivate 配置", () => {
    const autoReg = createPluginRegistryImpl({ autoActivate: true });
    autoReg.register(definePluginEntry(makePluginInput({ name: "p1" })));
    // 无 activate 方法的插件直接标记为 activated
    expect(autoReg.getState("p1")).toBe("activated");
  });
});

describe("PluginRegistry > getRegistration", () => {
  let registry: PluginRegistryExtended;

  beforeEach(() => {
    registry = createPluginRegistryImpl({ autoActivate: false });
  });

  it("返回完整注册信息", () => {
    registry.register(definePluginEntry(makePluginInput({ name: "p1" })));
    const reg = registry.getRegistration("p1");
    expect(reg).toBeDefined();
    expect(reg!.state).toBe("registered");
    expect(reg!.registeredAt).toBeGreaterThan(0);
  });

  it("不存在的插件返回 undefined", () => {
    expect(registry.getRegistration("nonexistent")).toBeUndefined();
  });
});

describe("PluginRegistry > clearAll", () => {
  it("清除所有插件并调用 deactivate", async () => {
    let deactivated = false;
    const registry = createPluginRegistryImpl({ autoActivate: false });
    registry.register(
      definePluginEntry(
        makePluginInput({
          name: "p1",
          deactivate: async () => { deactivated = true; },
        }),
      ),
    );
    registry.activatePlugin("p1");

    await registry.clearAll();
    expect(registry.count()).toBe(0);
    expect(deactivated).toBe(true);
  });
});

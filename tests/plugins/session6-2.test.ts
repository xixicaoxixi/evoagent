/**
 * Session 6.2 测试 — 钩子注册表 + 钩子引擎。
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createHookRegistry,
  HOOK_SOURCE_POLICIES,
  type HookDefinition,
  type HookRegistry,
  type HookSource,
} from "../../src/plugins/hooks/registry";
import {
  createHookEngine,
  type HookEngine,
} from "../../src/plugins/hooks/engine";
import {
  createEventEmitter,
  type EventEmitter,
} from "../../src/plugins/event-emitter";
import {
  createToolEvent,
  createPluginEvent,
  type SystemEvent,
} from "../../src/plugins/events";

// ─── 测试辅助 ───

function makeHook(
  overrides: Partial<HookDefinition> & Pick<HookDefinition, "id">,
): HookDefinition {
  return {
    event: "test",
    handler: async () => {},
    source: "builtin",
    priority: 100,
    enabled: true,
    ...overrides,
  };
}

// ─── HookRegistry 测试 ───

describe("HookRegistry > 基础功能", () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = createHookRegistry();
  });

  it("注册和获取钩子", () => {
    const hook = makeHook({ id: "hook-1", event: "agent" });
    expect(registry.register(hook)).toBe(true);
    expect(registry.get("hook-1")).toBe(hook);
  });

  it("重复注册返回 false", () => {
    const hook = makeHook({ id: "hook-1" });
    expect(registry.register(hook)).toBe(true);
    expect(registry.register(hook)).toBe(false);
  });

  it("注销钩子", () => {
    registry.register(makeHook({ id: "hook-1" }));
    expect(registry.unregister("hook-1")).toBe(true);
    expect(registry.get("hook-1")).toBeUndefined();
  });

  it("注销不存在的钩子返回 false", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("按事件查询", () => {
    registry.register(makeHook({ id: "h1", event: "agent" }));
    registry.register(makeHook({ id: "h2", event: "agent" }));
    registry.register(makeHook({ id: "h3", event: "tool" }));

    const agentHooks = registry.getByEvent("agent");
    expect(agentHooks).toHaveLength(2);
  });

  it("按事件+动作查询", () => {
    registry.register(makeHook({ id: "h1", event: "agent", action: "created" }));
    registry.register(makeHook({ id: "h2", event: "agent", action: "started" }));
    registry.register(makeHook({ id: "h3", event: "agent" }));

    const createdHooks = registry.getByEventAction("agent", "created");
    expect(createdHooks).toHaveLength(1);
    expect(createdHooks[0]!.id).toBe("h1");
  });

  it("按来源查询", () => {
    registry.register(makeHook({ id: "h1", source: "builtin" }));
    registry.register(makeHook({ id: "h2", source: "plugin" }));
    registry.register(makeHook({ id: "h3", source: "builtin" }));

    const builtinHooks = registry.getBySource("builtin");
    expect(builtinHooks).toHaveLength(2);
  });

  it("启用/禁用钩子", () => {
    registry.register(makeHook({ id: "h1", enabled: true }));
    expect(registry.setEnabled("h1", false)).toBe(true);

    const hook = registry.get("h1");
    expect(hook!.enabled).toBe(false);

    // 禁用的钩子不出现在查询结果中
    expect(registry.getByEvent("test")).toHaveLength(0);
  });

  it("启用不存在的钩子返回 false", () => {
    expect(registry.setEnabled("nonexistent", true)).toBe(false);
  });

  it("listAll 和 count", () => {
    registry.register(makeHook({ id: "h1" }));
    registry.register(makeHook({ id: "h2" }));
    expect(registry.count()).toBe(2);
    expect(registry.listAll()).toHaveLength(2);
  });

  it("clear 清除所有", () => {
    registry.register(makeHook({ id: "h1" }));
    registry.register(makeHook({ id: "h2" }));
    registry.clear();
    expect(registry.count()).toBe(0);
  });
});

describe("HookRegistry > 优先级排序", () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = createHookRegistry();
  });

  it("按来源优先级排序（precedence 高的先执行）", () => {
    registry.register(makeHook({ id: "builtin-h", source: "builtin", priority: 10 }));
    registry.register(makeHook({ id: "plugin-h", source: "plugin", priority: 10 }));
    registry.register(makeHook({ id: "workspace-h", source: "workspace", priority: 10 }));

    const hooks = registry.getByEvent("test");
    expect(hooks).toHaveLength(3);
    // workspace(50) > plugin(20) > builtin(10)
    expect(hooks[0]!.source).toBe("workspace");
    expect(hooks[1]!.source).toBe("plugin");
    expect(hooks[2]!.source).toBe("builtin");
  });

  it("同来源按钩子优先级排序（数值小的先执行）", () => {
    registry.register(makeHook({ id: "h1", source: "builtin", priority: 30 }));
    registry.register(makeHook({ id: "h2", source: "builtin", priority: 10 }));
    registry.register(makeHook({ id: "h3", source: "builtin", priority: 20 }));

    const hooks = registry.getByEvent("test");
    expect(hooks[0]!.id).toBe("h2");
    expect(hooks[1]!.id).toBe("h3");
    expect(hooks[2]!.id).toBe("h1");
  });
});

describe("HookRegistry > 覆盖策略", () => {
  let registry: HookRegistry;
  beforeEach(() => { registry = createHookRegistry(); });

  it("canOverride 检查覆盖关系", () => {
    // plugin 可以覆盖 builtin
    expect(registry.canOverride("plugin", "builtin")).toBe(true);
    // builtin 不能覆盖 plugin
    expect(registry.canOverride("builtin", "plugin")).toBe(false);
    // managed 可以覆盖 builtin 和 plugin
    expect(registry.canOverride("managed", "builtin")).toBe(true);
    expect(registry.canOverride("managed", "plugin")).toBe(true);
    // workspace 只能覆盖 workspace
    expect(registry.canOverride("workspace", "workspace")).toBe(true);
    expect(registry.canOverride("workspace", "builtin")).toBe(false);
    // builtin 只能覆盖 builtin
    expect(registry.canOverride("builtin", "builtin")).toBe(true);
    expect(registry.canOverride("builtin", "plugin")).toBe(false);
  });

  it("五级来源策略常量完整性", () => {
    const sources: HookSource[] = ["builtin", "plugin", "managed", "user", "workspace"];
    for (const source of sources) {
      expect(HOOK_SOURCE_POLICIES[source]).toBeDefined();
      expect(HOOK_SOURCE_POLICIES[source]!.precedence).toBeGreaterThan(0);
      expect(HOOK_SOURCE_POLICIES[source]!.canOverride.length).toBeGreaterThan(0);
    }
  });

  it("workspace 默认 explicit-opt-in", () => {
    expect(HOOK_SOURCE_POLICIES.workspace.defaultEnableMode).toBe("explicit-opt-in");
  });

  it("其他来源默认 default-on", () => {
    expect(HOOK_SOURCE_POLICIES.builtin.defaultEnableMode).toBe("default-on");
    expect(HOOK_SOURCE_POLICIES.plugin.defaultEnableMode).toBe("default-on");
    expect(HOOK_SOURCE_POLICIES.managed.defaultEnableMode).toBe("default-on");
    expect(HOOK_SOURCE_POLICIES.user.defaultEnableMode).toBe("default-on");
  });
});

// ─── HookEngine 测试 ───

describe("HookEngine > 基础触发", () => {
  let registry: HookRegistry;
  let emitter: EventEmitter<SystemEvent>;
  let engine: HookEngine;

  beforeEach(() => {
    registry = createHookRegistry();
    emitter = createEventEmitter<SystemEvent>();
    engine = createHookEngine(registry, emitter);
  });

  it("触发 type 级别钩子", async () => {
    const results: string[] = [];
    registry.register(
      makeHook({
        id: "h1",
        event: "tool",
        handler: async (...args) => {
          results.push(`tool:${String(args[0])}`);
        },
      }),
    );

    const result = await engine.trigger("tool", undefined, ["arg1"]);
    expect(result.executedCount).toBe(1);
    expect(results).toEqual(["tool:arg1"]);
  });

  it("触发 type:action 级别钩子", async () => {
    const results: string[] = [];
    registry.register(
      makeHook({
        id: "h1",
        event: "tool",
        action: "after_call",
        handler: async () => {
          results.push("after_call");
        },
      }),
    );

    const result = await engine.trigger("tool", "after_call", []);
    expect(result.executedCount).toBe(1);
    expect(results).toEqual(["after_call"]);
  });

  it("两级分发（type + type:action）", async () => {
    const results: string[] = [];
    registry.register(
      makeHook({
        id: "h-type",
        event: "tool",
        handler: async () => { results.push("type"); },
      }),
    );
    registry.register(
      makeHook({
        id: "h-action",
        event: "tool",
        action: "after_call",
        handler: async () => { results.push("action"); },
      }),
    );

    const result = await engine.trigger("tool", "after_call", []);
    expect(result.totalHooks).toBe(2);
    expect(result.executedCount).toBe(2);
    expect(results).toEqual(["type", "action"]);
  });

  it("去重（同 ID 不重复执行）", async () => {
    let count = 0;
    registry.register(
      makeHook({
        id: "h1",
        event: "tool",
        handler: async () => { count++; },
      }),
    );

    const result = await engine.trigger("tool", undefined, []);
    expect(result.totalHooks).toBe(1);
    expect(count).toBe(1);
  });
});

describe("HookEngine > 错误隔离", () => {
  let registry: HookRegistry;
  let emitter: EventEmitter<SystemEvent>;
  let engine: HookEngine;

  beforeEach(() => {
    registry = createHookRegistry();
    emitter = createEventEmitter<SystemEvent>();
    engine = createHookEngine(registry, emitter);
  });

  it("单个钩子错误不影响后续钩子", async () => {
    const results: string[] = [];
    registry.register(
      makeHook({
        id: "h1",
        event: "test",
        handler: async () => { results.push("before"); },
      }),
    );
    registry.register(
      makeHook({
        id: "h2",
        event: "test",
        handler: async () => { throw new Error("hook error"); },
      }),
    );
    registry.register(
      makeHook({
        id: "h3",
        event: "test",
        handler: async () => { results.push("after"); },
      }),
    );

    const result = await engine.trigger("test", undefined, []);
    expect(results).toEqual(["before", "after"]);
    expect(result.executedCount).toBe(2);
    expect(result.errorCount).toBe(1);
    expect(result.results[1]!.success).toBe(false);
    expect(result.results[1]!.error).toBeInstanceOf(Error);
  });

  it("执行结果包含完整信息", async () => {
    registry.register(
      makeHook({
        id: "h1",
        event: "test",
        source: "plugin",
        handler: async () => {},
      }),
    );

    const result = await engine.trigger("test", undefined, []);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.hookId).toBe("h1");
    expect(result.results[0]!.source).toBe("plugin");
    expect(result.results[0]!.success).toBe(true);
    expect(result.results[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("HookEngine > 启用/禁用", () => {
  let registry: HookRegistry;
  let emitter: EventEmitter<SystemEvent>;
  let engine: HookEngine;

  beforeEach(() => {
    registry = createHookRegistry();
    emitter = createEventEmitter<SystemEvent>();
    engine = createHookEngine(registry, emitter);
  });

  it("禁用时触发返回空结果", async () => {
    registry.register(
      makeHook({
        id: "h1",
        event: "test",
        handler: async () => { throw new Error("should not run"); },
      }),
    );

    engine.setEnabled(false);
    const result = await engine.trigger("test", undefined, []);
    expect(result.totalHooks).toBe(0);
  });

  it("禁用时 emitEvent 返回空结果", async () => {
    engine.setEnabled(false);
    const result = await engine.emitEvent(createToolEvent("after_call", "bash"));
    expect(result.totalHandlers).toBe(0);
  });

  it("重新启用后正常触发", async () => {
    let count = 0;
    registry.register(
      makeHook({
        id: "h1",
        event: "test",
        handler: async () => { count++; },
      }),
    );

    engine.setEnabled(false);
    await engine.trigger("test", undefined, []);
    expect(count).toBe(0);

    engine.setEnabled(true);
    await engine.trigger("test", undefined, []);
    expect(count).toBe(1);
  });
});

describe("HookEngine > 优先级执行顺序", () => {
  let registry: HookRegistry;
  let emitter: EventEmitter<SystemEvent>;
  let engine: HookEngine;

  beforeEach(() => {
    registry = createHookRegistry();
    emitter = createEventEmitter<SystemEvent>();
    engine = createHookEngine(registry, emitter);
  });

  it("按来源优先级 + 钩子优先级排序执行", async () => {
    const order: string[] = [];

    registry.register(
      makeHook({
        id: "builtin-low",
        source: "builtin",
        priority: 100,
        event: "test",
        handler: async () => { order.push("builtin-100"); },
      }),
    );
    registry.register(
      makeHook({
        id: "plugin-high",
        source: "plugin",
        priority: 10,
        event: "test",
        handler: async () => { order.push("plugin-10"); },
      }),
    );
    registry.register(
      makeHook({
        id: "workspace-mid",
        source: "workspace",
        priority: 50,
        event: "test",
        handler: async () => { order.push("workspace-50"); },
      }),
    );

    await engine.trigger("test", undefined, []);
    // workspace(50) > plugin(20) > builtin(10) 来源优先级
    // 同来源内按钩子 priority 升序
    expect(order).toEqual(["workspace-50", "plugin-10", "builtin-100"]);
  });
});

describe("HookEngine > 超时保护", () => {
  let registry: HookRegistry;
  let emitter: EventEmitter<SystemEvent>;
  let engine: HookEngine;

  beforeEach(() => {
    registry = createHookRegistry();
    emitter = createEventEmitter<SystemEvent>();
    engine = createHookEngine(registry, emitter, {
      maxExecutionTimeMs: 50,
    });
  });

  it("超时后跳过剩余钩子", async () => {
    const order: string[] = [];

    registry.register(
      makeHook({
        id: "h1",
        event: "test",
        handler: async () => {
          order.push("h1");
          // 模拟耗时操作（超过超时时间）
          await new Promise((r) => setTimeout(r, 100));
        },
      }),
    );
    registry.register(
      makeHook({
        id: "h2",
        event: "test",
        handler: async () => {
          order.push("h2");
        },
      }),
    );

    const result = await engine.trigger("test", undefined, []);
    // h1 执行完毕但超时，h2 被跳过
    expect(order).toEqual(["h1"]);
    expect(result.executedCount).toBe(1);
    expect(result.skippedCount).toBeGreaterThanOrEqual(1);
  });
});

describe("HookEngine > emitEvent 集成", () => {
  let registry: HookRegistry;
  let emitter: EventEmitter<SystemEvent>;
  let engine: HookEngine;

  beforeEach(() => {
    registry = createHookRegistry();
    emitter = createEventEmitter<SystemEvent>();
    engine = createHookEngine(registry, emitter);
  });

  it("emitEvent 通过 EventEmitter 分发", async () => {
    const received: string[] = [];
    emitter.on("tool", (e) => {
      if (e.type === "tool") {
        received.push(e.toolName);
      }
    });

    await engine.emitEvent(createToolEvent("after_call", "bash", { success: true }));
    expect(received).toEqual(["bash"]);
  });

  it("emitEvent 两级分发", async () => {
    const received: string[] = [];
    emitter.on("plugin", () => { received.push("type"); });
    emitter.on("plugin:activated", () => { received.push("specific"); });

    await engine.emitEvent(createPluginEvent("activated", "my-plugin"));
    expect(received).toEqual(["type", "specific"]);
  });
});

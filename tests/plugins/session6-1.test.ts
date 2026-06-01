/**
 * Session 6.1 测试 — 事件系统核心。
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createEventEmitter,
  type EventEmitter,
  type BaseEvent,
  type EventEmitResult,
} from "../../src/plugins/event-emitter";
import {
  createAgentEvent,
  createToolEvent,
  createPluginEvent,
  type SystemEvent,
} from "../../src/plugins/events";

describe("EventEmitter > 基础功能", () => {
  let emitter: EventEmitter<BaseEvent>;

  beforeEach(() => {
    emitter = createEventEmitter<BaseEvent>();
  });

  it("on 注册处理器并触发", async () => {
    const received: BaseEvent[] = [];
    emitter.on("test", (e) => {
      received.push(e);
    });

    const event: BaseEvent = { type: "test", timestamp: 1 };
    await emitter.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("test");
  });

  it("off 移除处理器", async () => {
    let count = 0;
    const handler = () => {
      count++;
    };
    emitter.on("test", handler);
    emitter.off("test", handler);

    await emitter.emit({ type: "test", timestamp: 1 });
    expect(count).toBe(0);
  });

  it("off 返回是否成功移除", () => {
    const handler = () => {};
    emitter.on("test", handler);
    expect(emitter.off("test", handler)).toBe(true);
    expect(emitter.off("test", handler)).toBe(false);
  });

  it("on 返回取消注册函数", async () => {
    let count = 0;
    const unsub = emitter.on("test", () => {
      count++;
    });

    await emitter.emit({ type: "test", timestamp: 1 });
    expect(count).toBe(1);

    unsub();
    await emitter.emit({ type: "test", timestamp: 2 });
    expect(count).toBe(1);
  });

  it("clear 清除所有处理器", async () => {
    let count = 0;
    emitter.on("a", () => { count++; });
    emitter.on("b", () => { count++; });

    emitter.clear();

    await emitter.emit({ type: "a", timestamp: 1 });
    await emitter.emit({ type: "b", timestamp: 2 });
    expect(count).toBe(0);
  });
});

describe("EventEmitter > 一次性处理器", () => {
  let emitter: EventEmitter<BaseEvent>;
  beforeEach(() => { emitter = createEventEmitter<BaseEvent>(); });

  it("once 处理器只触发一次", async () => {
    let count = 0;
    emitter.once("test", () => {
      count++;
    });

    await emitter.emit({ type: "test", timestamp: 1 });
    await emitter.emit({ type: "test", timestamp: 2 });
    expect(count).toBe(1);
  });

  it("once 取消注册后不再触发", async () => {
    let count = 0;
    const unsub = emitter.once("test", () => {
      count++;
    });

    unsub();
    await emitter.emit({ type: "test", timestamp: 1 });
    expect(count).toBe(0);
  });
});

describe("EventEmitter > 优先级排序", () => {
  let emitter: EventEmitter<BaseEvent>;
  beforeEach(() => { emitter = createEventEmitter<BaseEvent>(); });

  it("数值越小优先级越高", async () => {
    const order: number[] = [];
    emitter.on("test", () => { order.push(3); }, { priority: 30 });
    emitter.on("test", () => { order.push(1); }, { priority: 10 });
    emitter.on("test", () => { order.push(2); }, { priority: 20 });

    await emitter.emit({ type: "test", timestamp: 1 });
    expect(order).toEqual([1, 2, 3]);
  });

  it("默认优先级为 100", async () => {
    const order: number[] = [];
    emitter.on("test", () => { order.push(2); }); // 默认 100
    emitter.on("test", () => { order.push(1); }, { priority: 50 });

    await emitter.emit({ type: "test", timestamp: 1 });
    expect(order).toEqual([1, 2]);
  });
});

describe("EventEmitter > 两级分发", () => {
  let emitter: EventEmitter<BaseEvent>;
  beforeEach(() => { emitter = createEventEmitter<BaseEvent>(); });

  it("type 级别匹配", async () => {
    const received: string[] = [];
    emitter.on("agent", (e) => {
      received.push(`type:${e.type}`);
    });

    await emitter.emit(createAgentEvent("created", "agent-1"));
    expect(received).toEqual(["type:agent"]);
  });

  it("type:action 级别匹配", async () => {
    const received: string[] = [];
    emitter.on("agent:created", (e) => {
      received.push(`specific:${e.type}`);
    });

    await emitter.emit(createAgentEvent("created", "agent-1"));
    expect(received).toEqual(["specific:agent"]);
  });

  it("两级同时匹配（去重）", async () => {
    const received: string[] = [];
    const handler = (e: BaseEvent) => {
      received.push(e.type);
    };

    emitter.on("agent", handler);
    emitter.on("agent:created", handler);

    await emitter.emit(createAgentEvent("created", "agent-1"));
    // 同一个 handler 只触发一次
    expect(received).toEqual(["agent"]);
  });

  it("不同 handler 同时匹配两级", async () => {
    const received: string[] = [];
    emitter.on("agent", () => { received.push("type"); });
    emitter.on("agent:created", () => { received.push("specific"); });

    await emitter.emit(createAgentEvent("created", "agent-1"));
    expect(received).toEqual(["type", "specific"]);
  });

  it("无 action 的事件只匹配 type 级别", async () => {
    const received: string[] = [];
    emitter.on("custom", () => { received.push("type"); });
    emitter.on("custom:action", () => { received.push("specific"); });

    await emitter.emit({ type: "custom", timestamp: 1 });
    expect(received).toEqual(["type"]);
  });
});

describe("EventEmitter > 错误隔离", () => {
  let emitter: EventEmitter<BaseEvent>;
  beforeEach(() => { emitter = createEventEmitter<BaseEvent>(); });

  it("单个处理器错误不影响其他处理器", async () => {
    const results: string[] = [];

    emitter.on("test", () => {
      results.push("before");
    });
    emitter.on("test", () => {
      throw new Error("handler error");
    });
    emitter.on("test", () => {
      results.push("after");
    });

    const result = await emitter.emit({ type: "test", timestamp: 1 });

    expect(results).toEqual(["before", "after"]);
    expect(result.totalHandlers).toBe(3);
    expect(result.invokedCount).toBe(3);
    expect(result.errorCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toBeInstanceOf(Error);
  });

  it("emit 结果包含完整错误信息", async () => {
    emitter.on("test", () => {
      throw new Error("test error");
    }, { source: "plugin-a" });

    const result = await emitter.emit({ type: "test", timestamp: 1 });

    expect(result.errors[0]!.eventKey).toBe("test");
    expect(result.errors[0]!.source).toBe("plugin-a");
  });
});

describe("EventEmitter > 查询功能", () => {
  let emitter: EventEmitter<BaseEvent>;
  beforeEach(() => { emitter = createEventEmitter<BaseEvent>(); });

  it("hasListeners 正确判断", () => {
    expect(emitter.hasListeners("test")).toBe(false);
    emitter.on("test", () => {});
    expect(emitter.hasListeners("test")).toBe(true);
  });

  it("listenerCount 正确计数", () => {
    expect(emitter.listenerCount("test")).toBe(0);
    emitter.on("test", () => {});
    emitter.on("test", () => {});
    expect(emitter.listenerCount("test")).toBe(2);
  });

  it("eventKeys 返回所有事件键", () => {
    emitter.on("a", () => {});
    emitter.on("b", () => {});
    emitter.on("c", () => {});

    const keys = emitter.eventKeys();
    expect(keys).toHaveLength(3);
    expect([...keys]).toContain("a");
    expect([...keys]).toContain("b");
    expect([...keys]).toContain("c");
  });
});

describe("EventEmitter > offBySource", () => {
  let emitter: EventEmitter<BaseEvent>;
  beforeEach(() => { emitter = createEventEmitter<BaseEvent>(); });

  it("移除指定来源的所有处理器", async () => {
    let countA = 0;
    let countB = 0;
    emitter.on("test", () => { countA++; }, { source: "plugin-a" });
    emitter.on("test", () => { countA++; }, { source: "plugin-a" });
    emitter.on("test", () => { countB++; }, { source: "plugin-b" });

    const removed = emitter.offBySource("plugin-a");
    expect(removed).toBe(2);

    await emitter.emit({ type: "test", timestamp: 1 });
    expect(countA).toBe(0);
    expect(countB).toBe(1);
  });
});

describe("EventEmitter > 异步处理器", () => {
  let emitter: EventEmitter<BaseEvent>;
  beforeEach(() => { emitter = createEventEmitter<BaseEvent>(); });

  it("支持 async handler", async () => {
    const results: string[] = [];
    emitter.on("test", async () => {
      results.push("async-start");
      await Promise.resolve();
      results.push("async-end");
    });

    await emitter.emit({ type: "test", timestamp: 1 });
    expect(results).toEqual(["async-start", "async-end"]);
  });

  it("按序等待异步处理器", async () => {
    const order: number[] = [];
    emitter.on("test", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 10));
      order.push(2);
    });
    emitter.on("test", async () => {
      order.push(3);
    });

    await emitter.emit({ type: "test", timestamp: 1 });
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("EventEmitter > 系统事件", () => {
  let emitter: EventEmitter<SystemEvent>;

  beforeEach(() => {
    emitter = createEventEmitter<SystemEvent>();
  });

  it("Agent 事件两级分发", async () => {
    const received: string[] = [];
    emitter.on("agent", () => { received.push("type"); });
    emitter.on("agent:created", () => { received.push("specific"); });

    await emitter.emit(createAgentEvent("created", "agent-1"));
    expect(received).toEqual(["type", "specific"]);
  });

  it("Tool 事件携带完整数据", async () => {
    let captured: SystemEvent | undefined;
    emitter.on("tool:after_call", (e) => {
      captured = e;
    });

    const event = createToolEvent("after_call", "bash", {
      sessionId: "sess-1",
      durationMs: 150,
      success: true,
    });
    await emitter.emit(event);

    expect(captured).toBeDefined();
    expect(captured!.type).toBe("tool");
    if (captured!.type === "tool") {
      expect(captured!.toolName).toBe("bash");
      expect(captured!.sessionId).toBe("sess-1");
      expect(captured!.durationMs).toBe(150);
      expect(captured!.success).toBe(true);
    }
  });

  it("Plugin 事件", async () => {
    const received: string[] = [];
    emitter.on("plugin:activated", (e) => {
      if (e.type === "plugin") {
        received.push(e.pluginName);
      }
    });

    await emitter.emit(createPluginEvent("activated", "my-plugin", { source: "user" }));
    expect(received).toEqual(["my-plugin"]);
  });
});

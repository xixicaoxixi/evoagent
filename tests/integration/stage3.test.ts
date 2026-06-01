/**
 * 阶段 3 集成测试 — 上下文管理与记忆系统。
 */

import { describe, test, expect } from "vitest";

// ─── ContextEngine 测试 ───

import { createContextEngine } from "../../src/context/engine";
import { createContextEngineRegistry } from "../../src/context/registry";
import type { Message } from "../../src/types/message";

// ─── 压缩策略测试 ───

import {
  MicroCompactStrategy,
  AutoCompactStrategy,
  ReactiveCompactStrategy,
  CompactLevel,
  createCompactManager,
} from "../../src/context/compressor";

// ─── SessionMemory 测试 ───

import {
  createSessionMemory,
  createMemoryEntry,
  MemoryType,
} from "../../src/context/session-memory";

// ─── TokenCounter 测试 ───

import { createTokenCounter } from "../../src/context/token-counter";

// ─── 辅助函数 ───

function createMessage(
  role: Message["role"],
  content: string,
  overrides?: Partial<Message>,
): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    content,
    timestamp: Date.now(),
    ...overrides,
  };
}

function createManyMessages(count: number, contentLength: number = 100): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 3 === 0) {
      messages.push(createMessage("user", `x`.repeat(contentLength)));
    } else if (i % 3 === 1) {
      messages.push(createMessage("assistant", `y`.repeat(contentLength)));
    } else {
      messages.push(createMessage("tool_result", `z`.repeat(contentLength), {
        toolUseId: `tool-${i}`,
        isError: false,
      }));
    }
  }
  return messages;
}

// ═══════════════════════════════════════════════
// 1. ContextEngine
// ═══════════════════════════════════════════════

describe("ContextEngine", () => {
  test("ingest 和 getTokenCount", () => {
    const engine = createContextEngine();
    expect(engine.getMessageCount()).toBe(0);

    engine.ingest(createMessage("user", "Hello"));
    engine.ingest(createMessage("assistant", "Hi there"));
    expect(engine.getMessageCount()).toBe(2);
    expect(engine.getTokenCount()).toBeGreaterThan(0);
  });

  test("assemble 基本功能", async () => {
    const engine = createContextEngine();
    engine.ingest(createMessage("user", "Hello"));

    const result = await engine.assemble({ maxTokens: 100000 });
    expect(result.messages).toHaveLength(1);
    expect(result.isCompacted).toBe(false);
  });

  test("assemble 触发自动压缩", async () => {
    const engine = createContextEngine({ compactThreshold: 0.3 });
    const messages = createManyMessages(100, 500);
    for (const msg of messages) {
      engine.ingest(msg);
    }

    const result = await engine.assemble({ maxTokens: 5000 });
    expect(result.isCompacted).toBe(true);
    expect(result.messages.length).toBeLessThan(100);
  });

  test("compact 手动调用", async () => {
    const engine = createContextEngine();
    for (const msg of createManyMessages(20, 100)) {
      engine.ingest(msg);
    }

    const result = await engine.compact({
      targetTokens: 100,
      reason: "auto",
    });

    expect(result.compressionRatio).toBeLessThan(1);
    expect(result.qualityScore).toBeGreaterThan(0);
  });

  test("clear 清空上下文", () => {
    const engine = createContextEngine();
    engine.ingest(createMessage("user", "test"));
    engine.clear();
    expect(engine.getMessageCount()).toBe(0);
    expect(engine.getTokenCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// 2. ContextEngineRegistry
// ═══════════════════════════════════════════════

describe("ContextEngineRegistry", () => {
  test("注册和解析", () => {
    const registry = createContextEngineRegistry();
    const engine1 = createContextEngine({ name: "engine-1", priority: 10 });
    const engine2 = createContextEngine({ name: "engine-2", priority: 5 });

    registry.register(engine1);
    registry.register(engine2);

    expect(registry.resolve("engine-1")).toBe(engine1);
    expect(registry.resolve("engine-2")).toBe(engine2);
    expect(registry.getDefault()).toBe(engine1); // 第一个注册的
  });

  test("listAll 按优先级排序", () => {
    const registry = createContextEngineRegistry();
    registry.register(createContextEngine({ name: "low", priority: 10 }));
    registry.register(createContextEngine({ name: "high", priority: 1 }));

    const all = registry.listAll();
    expect(all[0]?.name).toBe("high");
    expect(all[1]?.name).toBe("low");
  });

  test("setDefault 和 unregister", () => {
    const registry = createContextEngineRegistry();
    registry.register(createContextEngine({ name: "a" }));
    registry.register(createContextEngine({ name: "b" }));

    expect(registry.setDefault("b")).toBe(true);
    expect(registry.getDefault()?.name).toBe("b");

    expect(registry.unregister("a")).toBe(true);
    expect(registry.resolve("a")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════
// 3. MicroCompactStrategy
// ═══════════════════════════════════════════════

describe("MicroCompactStrategy", () => {
  test("截断过长工具结果", async () => {
    const strategy = new MicroCompactStrategy({ maxToolResultChars: 50 });
    const messages: Message[] = [
      createMessage("user", "test"),
      createMessage("tool_result", "x".repeat(200), { toolUseId: "t1", isError: false }),
      createMessage("assistant", "done"),
    ];

    const result = await strategy.compact(messages, {
      targetTokens: 1000,
      maxTokens: 10000,
      reason: "micro",
    });

    expect(result.messages).toHaveLength(3);
    const toolResult = result.messages[1]!;
    expect(toolResult.content).toContain("truncated");
    expect(result.qualityScore).toBe(1.0);
  });

  test("清除超过最大数量的工具结果", async () => {
    const strategy = new MicroCompactStrategy({ maxToolResults: 2 });
    const messages: Message[] = [
      createMessage("tool_result", "result 1", { toolUseId: "t1", isError: false }),
      createMessage("tool_result", "result 2", { toolUseId: "t2", isError: false }),
      createMessage("tool_result", "result 3", { toolUseId: "t3", isError: false }),
    ];

    const result = await strategy.compact(messages, {
      targetTokens: 1000,
      maxTokens: 10000,
      reason: "micro",
    });

    expect(result.messages[2]!.content).toContain("cleared");
  });
});

// ═══════════════════════════════════════════════
// 4. AutoCompactStrategy
// ═══════════════════════════════════════════════

describe("AutoCompactStrategy", () => {
  test("shouldTrigger 在阈值以上触发", () => {
    const strategy = new AutoCompactStrategy({ threshold: 0.5 });
    expect(strategy.shouldTrigger([], 600, 1000)).toBe(true);
    expect(strategy.shouldTrigger([], 400, 1000)).toBe(false);
  });

  test("compact 保留最近消息并生成摘要", async () => {
    const strategy = new AutoCompactStrategy({ keepRecentMessages: 3 });
    const messages = createManyMessages(30, 200);

    const result = await strategy.compact(messages, {
      targetTokens: 500,
      maxTokens: 1000,
      reason: "auto",
    });

    // 1 条摘要 + 3 条保留 = 4
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]!.role).toBe("system");
    // 摘要可能比原文短也可能长，取决于内容
    expect(result.compressionRatio).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════
// 5. CompactManager
// ═══════════════════════════════════════════════

describe("CompactManager", () => {
  test("runPipeline 执行压缩管道", async () => {
    const manager = createCompactManager();
    const messages = createManyMessages(50, 200);

    const result = await manager.runPipeline(messages, 1000);
    expect(result.messages.length).toBeLessThan(50);
    expect(result.compressionRatio).toBeLessThan(1);
  });

  test("forceLevel 强制指定级别", async () => {
    const manager = createCompactManager();
    const messages = createManyMessages(5, 50);

    const result = await manager.runPipeline(messages, 100000, "micro");
    // 微压缩不会减少消息数量，但可能截断内容
    expect(result.messages).toHaveLength(5);
  });
});

// ═══════════════════════════════════════════════
// 6. SessionMemory
// ═══════════════════════════════════════════════

describe("SessionMemory", () => {
  test("添加和获取记忆", () => {
    const memory = createSessionMemory();
    const entry = createMemoryEntry(MemoryType.FACT, "User prefers TypeScript");

    memory.add(entry);
    expect(memory.size).toBe(1);
    expect(memory.get(entry.id)?.content).toBe("User prefers TypeScript");
  });

  test("按类型查询", () => {
    const memory = createSessionMemory();
    memory.add(createMemoryEntry(MemoryType.FACT, "fact 1"));
    memory.add(createMemoryEntry(MemoryType.PREFERENCE, "pref 1"));
    memory.add(createMemoryEntry(MemoryType.FACT, "fact 2"));

    const facts = memory.getByType(MemoryType.FACT);
    expect(facts).toHaveLength(2);
  });

  test("按标签查询", () => {
    const memory = createSessionMemory();
    memory.add(createMemoryEntry(MemoryType.PATTERN, "pattern 1", { tags: ["coding", "typescript"] }));
    memory.add(createMemoryEntry(MemoryType.PATTERN, "pattern 2", { tags: ["coding", "python"] }));

    const coding = memory.getByTag("coding");
    expect(coding).toHaveLength(2);

    const python = memory.getByTag("python");
    expect(python).toHaveLength(1);
  });

  test("搜索记忆", () => {
    const memory = createSessionMemory();
    memory.add(createMemoryEntry(MemoryType.FACT, "User works at Google"));
    memory.add(createMemoryEntry(MemoryType.PREFERENCE, "Prefers dark mode"));

    const results = memory.search("Google");
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("Google");
  });

  test("删除记忆", () => {
    const memory = createSessionMemory();
    const entry = createMemoryEntry(MemoryType.FACT, "to delete");
    memory.add(entry);

    expect(memory.remove(entry.id)).toBe(true);
    expect(memory.size).toBe(0);
  });

  test("容量限制淘汰最弱记忆", () => {
    const memory = createSessionMemory({ maxMemories: 3 });
    memory.add(createMemoryEntry(MemoryType.FACT, "old 1", { confidence: 0.3 }));
    memory.add(createMemoryEntry(MemoryType.FACT, "old 2", { confidence: 0.3 }));
    memory.add(createMemoryEntry(MemoryType.FACT, "old 3", { confidence: 0.3 }));

    // 添加第 4 个，应淘汰最弱的
    memory.add(createMemoryEntry(MemoryType.FACT, "new 1", { confidence: 0.9 }));
    expect(memory.size).toBe(3);
  });

  test("generateMemorySummary 生成摘要", () => {
    const memory = createSessionMemory();
    memory.add(createMemoryEntry(MemoryType.FACT, "User is a developer"));
    memory.add(createMemoryEntry(MemoryType.PREFERENCE, "Prefers TypeScript"));

    const summary = memory.generateMemorySummary();
    expect(summary).toContain("Session Memories");
    expect(summary).toContain("Fact");
    expect(summary).toContain("Preference");
  });

  test("estimateMemoryTokens 估算 token", () => {
    const memory = createSessionMemory();
    memory.add(createMemoryEntry(MemoryType.FACT, "Test fact"));

    const tokens = memory.estimateMemoryTokens();
    expect(tokens).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════
// 7. TokenCounter
// ═══════════════════════════════════════════════

describe("TokenCounter", () => {
  test("countMessage 计算消息 token", () => {
    const counter = createTokenCounter();

    expect(counter.countMessage(createMessage("user", "Hello world"))).toBeGreaterThan(0);
    expect(counter.countMessage(createMessage("tool_use", "", {
      toolName: "bash",
      toolUseId: "t1",
      input: { cmd: "ls" },
    }))).toBeGreaterThan(0);
  });

  test("countMessages 统计消息列表", () => {
    const counter = createTokenCounter();
    const messages = [
      createMessage("user", "Hello"),
      createMessage("assistant", "Hi"),
      createMessage("user", "How are you?"),
    ];

    const result = counter.countMessages(messages);
    expect(result.total).toBeGreaterThan(0);
    expect(result.messageCount).toBe(3);
    expect(result.byRole["user"]).toBeGreaterThan(0);
    expect(result.byRole["assistant"]).toBeGreaterThan(0);
  });

  test("countContext 计算上下文 token", () => {
    const counter = createTokenCounter();
    const total = counter.countContext("You are helpful.", [
      createMessage("user", "Hello"),
    ]);
    expect(total).toBeGreaterThan(0);
  });
});

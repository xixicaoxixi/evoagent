/**
 * Session B.4 测试 — 上下文压缩后记忆重新加载。
 *
 * 验证压缩后重载触发、持久化指令恢复、压缩-重载原子性。
 */

import { describe, expect, it } from "vitest";
import {
  CompactManager,
  MicroCompactStrategy,
  AutoCompactStrategy,
  createCompactManager,
  type PostCompactionReloadCallback,
} from "../../src/context/compressor";
import type { Message } from "../../src/types/message";

// ─── 辅助函数 ───

function createMessage(role: Message["role"], content: string, id: string): Message {
  return {
    id,
    role,
    content,
    timestamp: Date.now(),
  };
}

function createLongMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) =>
    createMessage("user", `Message ${i} with some content. `.repeat(100), `msg-${i}`),
  );
}

// ─── 测试 ───

describe("CompactManager 压缩后记忆重载", () => {
  it("压缩后触发重载回调", async () => {
    let reloadCalled = false;
    let receivedMessages: readonly Message[] = [];

    const reloadCallback: PostCompactionReloadCallback = async (messages) => {
      reloadCalled = true;
      receivedMessages = messages;
      // 添加一条记忆恢复消息
      const memoryMessage: Message = createMessage("system", "[Memory Reloaded] Project rules restored.", "memory-reload");
      return [...messages, memoryMessage];
    };

    const manager = new CompactManager(
      [new MicroCompactStrategy()],
      undefined,
      reloadCallback,
    );

    const messages = createLongMessages(5);
    const result = await manager.runPipeline(messages, 100);

    expect(reloadCalled).toBe(true);
    expect(receivedMessages.length).toBeGreaterThan(0);
    // 重载后应包含恢复的记忆消息
    expect(result.messages.some((m) => m.id === "memory-reload")).toBe(true);
  });

  it("无回调时不触发重载", async () => {
    const manager = new CompactManager([new MicroCompactStrategy()]);
    const messages = createLongMessages(5);
    const result = await manager.runPipeline(messages, 100);
    // 无回调时消息数应与输入相同（MicroCompact 不删除消息，只截断工具结果）
    expect(result.messages.length).toBe(messages.length);
  });

  it("重载失败不影响压缩结果（原子性）", async () => {
    const errorCallback: PostCompactionReloadCallback = async () => {
      throw new Error("Reload failed");
    };

    const manager = new CompactManager(
      [new MicroCompactStrategy()],
      undefined,
      errorCallback,
    );

    const messages = createLongMessages(5);
    // 不应抛出异常
    const result = await manager.runPipeline(messages, 100);
    // 压缩结果应正常返回
    expect(result.messages.length).toBe(messages.length);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  it("重载回调返回空数组时使用空消息列表", async () => {
    const emptyCallback: PostCompactionReloadCallback = async () => [];

    const manager = new CompactManager(
      [new MicroCompactStrategy()],
      undefined,
      emptyCallback,
    );

    const messages = createLongMessages(5);
    const result = await manager.runPipeline(messages, 100);
    expect(result.messages).toHaveLength(0);
  });
});

describe("createCompactManager 压缩后重载", () => {
  it("通过工厂函数传入重载回调", async () => {
    let reloadCalled = false;

    const manager = createCompactManager(
      undefined,
      undefined,
      async () => {
        reloadCalled = true;
        return [];
      },
    );

    const messages = createLongMessages(5);
    await manager.runPipeline(messages, 100);
    expect(reloadCalled).toBe(true);
  });

  it("不传回调时正常工作", async () => {
    const manager = createCompactManager();
    const messages = createLongMessages(5);
    const result = await manager.runPipeline(messages, 100);
    expect(result.messages.length).toBeGreaterThan(0);
  });
});

describe("压缩-重载原子性", () => {
  it("压缩成功但重载失败时保留压缩结果", async () => {
    const messages = [
      createMessage("user", "Hello", "msg-1"),
      createMessage("assistant", "Hi there", "msg-2"),
      createMessage("user", "How are you?", "msg-3"),
    ];

    const failingCallback: PostCompactionReloadCallback = async () => {
      throw new Error("Disk read failed");
    };

    const manager = new CompactManager(
      [new MicroCompactStrategy()],
      undefined,
      failingCallback,
    );

    const result = await manager.runPipeline(messages, 100_000);
    // 压缩结果应保留（MicroCompact 不改变普通消息）
    expect(result.messages.length).toBe(3);
  });

  it("重载成功时消息列表包含恢复内容", async () => {
    const messages = [
      createMessage("user", "Hello", "msg-1"),
      createMessage("assistant", "Hi", "msg-2"),
    ];

    const reloadCallback: PostCompactionReloadCallback = async (msgs) => {
      const reloadMsg: Message = createMessage("system", "[Restored rules from disk]", "rules-restored");
      return [...msgs, reloadMsg];
    };

    const manager = new CompactManager(
      [new MicroCompactStrategy()],
      undefined,
      reloadCallback,
    );

    const result = await manager.runPipeline(messages, 100_000);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[2]?.id).toBe("rules-restored");
    expect(result.messages[2]?.content).toContain("Restored rules");
  });

  it("多次压缩-重载循环保持一致性", async () => {
    let reloadCount = 0;

    const reloadCallback: PostCompactionReloadCallback = async (msgs) => {
      reloadCount++;
      const reloadMsg: Message = createMessage("system", `[Reload #${reloadCount}]`, `reload-${reloadCount}`);
      return [...msgs, reloadMsg];
    };

    const manager = new CompactManager(
      [new MicroCompactStrategy()],
      undefined,
      reloadCallback,
    );

    const messages = createLongMessages(3);

    // 第一次压缩
    const result1 = await manager.runPipeline(messages, 100_000);
    expect(result1.messages.some((m) => m.id === "reload-1")).toBe(true);

    // 第二次压缩（使用第一次的结果）
    const result2 = await manager.runPipeline(result1.messages, 100_000);
    expect(result2.messages.some((m) => m.id === "reload-2")).toBe(true);
    expect(reloadCount).toBe(2);
  });
});

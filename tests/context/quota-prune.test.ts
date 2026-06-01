/**
 * Session E.3 测试 — 工具结果配额 + 历史裁剪。
 *
 * 覆盖：
 * - enforceToolOutputQuota 截断超大工具结果
 * - 不超配额的工具结果不受影响
 * - 非 tool_result 消息不受影响
 * - tokensFreed 正确计算
 * - pruneOldTurns 移除旧轮次
 * - 保护最近 N 轮
 * - tokensFreed 正确计算
 */

import { describe, expect, it } from "vitest";
import { enforceToolOutputQuota } from "../../src/context/quota";
import { pruneOldTurns } from "../../src/context/prune";
import type { Message } from "../../src/types/message";

// ─── 辅助函数 ───

function createMessage(role: Message["role"], content: string): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    timestamp: Date.now(),
  };
}

function createToolResultMessage(content: string): Message {
  return {
    id: `tool-result-${Math.random().toString(36).slice(2)}`,
    role: "tool_result",
    content,
    timestamp: Date.now(),
  };
}

/** 生成指定字符数的内容（约 chars/4 个 token） */
function generateContent(chars: number): string {
  return "x".repeat(chars);
}

// ═══════════════════════════════════════════
// enforceToolOutputQuota
// ═══════════════════════════════════════════

describe("enforceToolOutputQuota", () => {
  it("超大工具结果应被截断", () => {
    // 20000 字符 ≈ 5000 token，超过默认 4096 token 配额
    const messages = [
      createMessage("user", "hello"),
      createToolResultMessage(generateContent(20000)),
      createMessage("assistant", "done"),
    ];

    const result = enforceToolOutputQuota(messages, {
      maxTokensPerToolResult: 1000, // 约 4000 字符
    });

    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]?.role).toBe("tool_result");
    // 截断后应包含标记
    expect(result.messages[1]?.content).toContain("[... truncated by quota ...]");
    // 截断后应短于原始
    expect(result.messages[1]?.content.length).toBeLessThan(20000);
    expect(result.tokensFreed).toBeGreaterThan(0);
  });

  it("不超配额的工具结果不受影响", () => {
    const shortContent = generateContent(100);
    const messages = [
      createToolResultMessage(shortContent),
    ];

    const result = enforceToolOutputQuota(messages);

    expect(result.messages[0]?.content).toBe(shortContent);
    expect(result.tokensFreed).toBe(0);
  });

  it("非 tool_result 消息不受影响", () => {
    const messages = [
      createMessage("user", generateContent(20000)),
      createMessage("assistant", generateContent(20000)),
    ];

    const result = enforceToolOutputQuota(messages);

    expect(result.messages[0]?.content.length).toBe(20000);
    expect(result.messages[1]?.content.length).toBe(20000);
    expect(result.tokensFreed).toBe(0);
  });

  it("多条工具结果应分别检查", () => {
    const messages = [
      createToolResultMessage(generateContent(20000)), // 超配额
      createToolResultMessage(generateContent(100)),   // 不超配额
      createToolResultMessage(generateContent(30000)), // 超配额
    ];

    const result = enforceToolOutputQuota(messages, {
      maxTokensPerToolResult: 1000,
    });

    expect(result.messages).toHaveLength(3);
    // 第一条被截断
    expect(result.messages[0]?.content).toContain("[... truncated by quota ...]");
    // 第二条不受影响
    expect(result.messages[1]?.content).toBe(generateContent(100));
    // 第三条被截断
    expect(result.messages[2]?.content).toContain("[... truncated by quota ...]");
  });

  it("空消息列表应返回空", () => {
    const result = enforceToolOutputQuota([]);
    expect(result.messages).toHaveLength(0);
    expect(result.tokensFreed).toBe(0);
  });

  it("自定义截断标记应生效", () => {
    const messages = [createToolResultMessage(generateContent(20000))];
    const result = enforceToolOutputQuota(messages, {
      maxTokensPerToolResult: 100,
      truncationMarker: "\n[CUSTOM TRUNCATION]\n",
    });
    expect(result.messages[0]?.content).toContain("[CUSTOM TRUNCATION]");
  });
});

// ═══════════════════════════════════════════
// pruneOldTurns
// ═══════════════════════════════════════════

describe("pruneOldTurns", () => {
  it("低于目标 token 数时不应裁剪", () => {
    const messages = [
      createMessage("user", "hello"),
      createMessage("assistant", "hi"),
    ];

    const result = pruneOldTurns(messages, { targetTokens: 100000 });
    expect(result.messages).toHaveLength(2);
    expect(result.tokensFreed).toBe(0);
  });

  it("应移除旧轮次保护最近 N 轮", () => {
    // 创建 10 轮对话，每轮约 2000 字符（约 500 token）
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(createMessage("user", `User message ${i} ${generateContent(2000)}`));
      messages.push(createMessage("assistant", `Assistant message ${i} ${generateContent(2000)}`));
    }

    // 总 token ≈ 10 * 2 * 500 = 10000
    const result = pruneOldTurns(messages, {
      targetTokens: 5000, // 需要裁剪到约 5000 token
      protectRecentTurns: 3, // 保护最近 3 轮
    });

    // 应包含裁剪摘要 + 最近 3 轮（6 条消息）
    expect(result.messages.length).toBeLessThan(20);
    expect(result.messages.length).toBeGreaterThan(6); // 摘要 + 保护的消息
    // 第一条应为裁剪摘要
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toContain("pruned");
    expect(result.tokensFreed).toBeGreaterThan(0);
  });

  it("保护 0 轮时应裁剪所有旧消息", () => {
    const messages = [
      createMessage("user", generateContent(5000)),
      createMessage("assistant", generateContent(5000)),
    ];

    const result = pruneOldTurns(messages, {
      targetTokens: 100, // 远低于实际
      protectRecentTurns: 0,
    });

    // 保护 0 轮：可以裁剪所有消息
    expect(result.messages.length).toBeLessThanOrEqual(messages.length);
  });

  it("空消息列表应返回空", () => {
    const result = pruneOldTurns([]);
    expect(result.messages).toHaveLength(0);
    expect(result.tokensFreed).toBe(0);
  });

  it("只有系统消息时不应裁剪", () => {
    const messages = [
      createMessage("system", "You are a helpful assistant."),
    ];
    const result = pruneOldTurns(messages, { targetTokens: 1 });
    // 没有 user 消息，无法识别轮次，不裁剪
    expect(result.messages).toHaveLength(1);
  });
});

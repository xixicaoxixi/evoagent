/**
 * D.1 进度追踪测试。
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createProgressTracker,
  updateProgressFromMessage,
  getProgressUpdate,
  getTokenCountFromTracker,
  type ProgressTrackerData,
} from "../../src/observability/progress";

describe("D.1 > ProgressTracker", () => {
  let tracker: ProgressTrackerData;

  beforeEach(() => {
    tracker = createProgressTracker();
  });

  it("初始状态为零", () => {
    expect(tracker.toolUseCount).toBe(0);
    expect(tracker.latestInputTokens).toBe(0);
    expect(tracker.cumulativeOutputTokens).toBe(0);
    expect(tracker.recentActivities).toHaveLength(0);
  });

  it("Token 双轨统计", () => {
    // 第一轮
    updateProgressFromMessage(tracker, {
      type: "assistant",
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 200,
      },
    });

    // input_tokens 是累计值，保留最新
    expect(tracker.latestInputTokens).toBe(1250); // 1000 + 50 + 200
    // output_tokens 逐轮累加
    expect(tracker.cumulativeOutputTokens).toBe(100);

    // 第二轮（input_tokens 累计值增加）
    updateProgressFromMessage(tracker, {
      type: "assistant",
      usage: {
        input_tokens: 2000,
        output_tokens: 200,
      },
    });

    expect(tracker.latestInputTokens).toBe(2000); // 保留最新累计值
    expect(tracker.cumulativeOutputTokens).toBe(300); // 100 + 200
  });

  it("工具使用计数", () => {
    updateProgressFromMessage(tracker, {
      type: "assistant",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [
        { type: "tool_use", name: "file_read", input: { path: "/test" } },
        { type: "tool_use", name: "bash", input: { command: "ls" } },
      ],
    });

    expect(tracker.toolUseCount).toBe(2);
  });

  it("活动列表 FIFO 淘汰（MAX=5）", () => {
    for (let i = 0; i < 8; i++) {
      updateProgressFromMessage(tracker, {
        type: "assistant",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [
          { type: "tool_use", name: `tool_${i}`, input: { idx: i } },
        ],
      });
    }

    // 最多保留 5 条
    expect(tracker.recentActivities).toHaveLength(5);
    // 最旧的被淘汰
    expect(tracker.recentActivities[0]!.toolName).toBe("tool_3");
    expect(tracker.recentActivities[4]!.toolName).toBe("tool_7");
  });

  it("非 assistant 消息忽略", () => {
    updateProgressFromMessage(tracker, {
      type: "user",
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    expect(tracker.latestInputTokens).toBe(0);
    expect(tracker.cumulativeOutputTokens).toBe(0);
  });

  it("getProgressUpdate 返回快照", () => {
    updateProgressFromMessage(tracker, {
      type: "assistant",
      usage: { input_tokens: 500, output_tokens: 100 },
      content: [
        { type: "tool_use", name: "read", input: { path: "/a" } },
      ],
    });

    const progress = getProgressUpdate(tracker);
    expect(progress.toolUseCount).toBe(1);
    expect(progress.tokenCount).toBe(600);
    expect(progress.lastActivity).toBeDefined();
    expect(progress.lastActivity!.toolName).toBe("read");
    expect(progress.recentActivities).toHaveLength(1);
  });

  it("getProgressUpdate 返回活动列表的浅拷贝", () => {
    updateProgressFromMessage(tracker, {
      type: "assistant",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [
        { type: "tool_use", name: "tool_a", input: {} },
      ],
    });

    const progress1 = getProgressUpdate(tracker);
    const progress2 = getProgressUpdate(tracker);
    expect(progress1.recentActivities).not.toBe(progress2.recentActivities);
  });

  it("getTokenCountFromTracker 计算 token 总数", () => {
    tracker.latestInputTokens = 1000;
    tracker.cumulativeOutputTokens = 500;
    expect(getTokenCountFromTracker(tracker)).toBe(1500);
  });

  it("活动描述解析器", () => {
    const resolver = (name: string, input: Record<string, unknown>) => {
      if (name === "read" && typeof input.path === "string") {
        return `Reading ${input.path}`;
      }
      return undefined;
    };

    updateProgressFromMessage(tracker, {
      type: "assistant",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [
        { type: "tool_use", name: "read", input: { path: "/src/main.ts" } },
      ],
    }, resolver);

    expect(tracker.recentActivities[0]!.activityDescription).toBe("Reading /src/main.ts");
  });
});

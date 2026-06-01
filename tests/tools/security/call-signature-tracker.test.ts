/**
 * Step 4 测试 — 工具调用签名去重（Shadow Mode）。
 *
 * 覆盖：
 * - CallSignatureTracker 基本功能
 * - mutating 工具重复调用触发 Warn
 * - 幂等/只读工具重复调用不触发
 * - 不同参数的调用不触发
 * - reset 后重新追踪
 * - 自定义 isMutatingFn
 * - DEFAULT_MUTATING_TOOLS 覆盖
 * - DuplicateCheckResult 类型判定
 */

import { describe, expect, it } from "vitest";
import {
  CallSignatureTracker,
  hashToolCall,
  type DuplicateCheckResult,
  type DuplicateCallWarning,
  type NoDuplicate,
} from "../../../src/tools/security/loop-detector";

// ═══════════════════════════════════════════
// hashToolCall 一致性
// ═══════════════════════════════════════════

describe("hashToolCall — 签名一致性", () => {
  it("相同工具名+参数应产生相同哈希", () => {
    const h1 = hashToolCall("write_file", { path: "/a.txt", content: "hello" });
    const h2 = hashToolCall("write_file", { path: "/a.txt", content: "hello" });
    expect(h1).toBe(h2);
  });

  it("不同参数应产生不同哈希", () => {
    const h1 = hashToolCall("write_file", { path: "/a.txt", content: "hello" });
    const h2 = hashToolCall("write_file", { path: "/b.txt", content: "hello" });
    expect(h1).not.toBe(h2);
  });

  it("不同工具名应产生不同哈希", () => {
    const h1 = hashToolCall("write_file", { path: "/a.txt" });
    const h2 = hashToolCall("edit_file", { path: "/a.txt" });
    expect(h1).not.toBe(h2);
  });
});

// ═══════════════════════════════════════════
// CallSignatureTracker — mutating 工具重复
// ═══════════════════════════════════════════

describe("CallSignatureTracker — mutating 工具重复", () => {
  it("重复的 write_file 应触发 Warn", () => {
    const tracker = new CallSignatureTracker();
    const input = { path: "/test.txt", content: "hello" };

    const first = tracker.checkAndRecord("write_file", input, false);
    expect(first.isDuplicate).toBe(false);

    const second = tracker.checkAndRecord("write_file", input, false);
    expect(second.isDuplicate).toBe(true);
    if (second.isDuplicate) {
      expect(second.toolName).toBe("write_file");
      expect(second.message).toContain("DUPLICATE CALL WARNING");
      expect(second.previousCallIndex).toBe(0);
    }
  });

  it("重复的 bash 命令应触发 Warn", () => {
    const tracker = new CallSignatureTracker();
    const input = { command: "npm install" };

    tracker.checkAndRecord("bash", input, false);
    const second = tracker.checkAndRecord("bash", input, false);
    expect(second.isDuplicate).toBe(true);
  });

  it("重复的 edit_file 应触发 Warn", () => {
    const tracker = new CallSignatureTracker();
    const input = { path: "/test.txt", old: "a", new: "b" };

    tracker.checkAndRecord("edit_file", input, false);
    const second = tracker.checkAndRecord("edit_file", input, false);
    expect(second.isDuplicate).toBe(true);
  });

  it("第三次重复调用也应触发 Warn", () => {
    const tracker = new CallSignatureTracker();
    const input = { path: "/test.txt", content: "hello" };

    tracker.checkAndRecord("write_file", input, false);
    tracker.checkAndRecord("write_file", input, false);
    const third = tracker.checkAndRecord("write_file", input, false);
    expect(third.isDuplicate).toBe(true);
    if (third.isDuplicate) {
      expect(third.previousCallIndex).toBe(1);
    }
  });
});

// ═══════════════════════════════════════════
// CallSignatureTracker — 只读/幂等工具不触发
// ═══════════════════════════════════════════

describe("CallSignatureTracker — 只读工具不触发", () => {
  it("重复的 read_file（isReadOnly=true）不应触发 Warn", () => {
    const tracker = new CallSignatureTracker();
    const input = { path: "/test.txt" };

    tracker.checkAndRecord("read_file", input, true);
    const second = tracker.checkAndRecord("read_file", input, true);
    expect(second.isDuplicate).toBe(false);
  });

  it("重复的 glob（isReadOnly=true）不应触发 Warn", () => {
    const tracker = new CallSignatureTracker();
    const input = { pattern: "**/*.ts" };

    tracker.checkAndRecord("glob", input, true);
    const second = tracker.checkAndRecord("glob", input, true);
    expect(second.isDuplicate).toBe(false);
  });

  it("重复的 grep（isReadOnly=true）不应触发 Warn", () => {
    const tracker = new CallSignatureTracker();
    const input = { pattern: "TODO", path: "/src" };

    tracker.checkAndRecord("grep", input, true);
    const second = tracker.checkAndRecord("grep", input, true);
    expect(second.isDuplicate).toBe(false);
  });
});

// ═══════════════════════════════════════════
// CallSignatureTracker — 不同参数不触发
// ═══════════════════════════════════════════

describe("CallSignatureTracker — 不同参数不触发", () => {
  it("不同路径的 write_file 不应触发 Warn", () => {
    const tracker = new CallSignatureTracker();

    tracker.checkAndRecord("write_file", { path: "/a.txt", content: "hello" }, false);
    const second = tracker.checkAndRecord("write_file", { path: "/b.txt", content: "hello" }, false);
    expect(second.isDuplicate).toBe(false);
  });

  it("不同内容的 write_file 不应触发 Warn", () => {
    const tracker = new CallSignatureTracker();

    tracker.checkAndRecord("write_file", { path: "/a.txt", content: "hello" }, false);
    const second = tracker.checkAndRecord("write_file", { path: "/a.txt", content: "world" }, false);
    expect(second.isDuplicate).toBe(false);
  });

  it("不同命令的 bash 不应触发 Warn", () => {
    const tracker = new CallSignatureTracker();

    tracker.checkAndRecord("bash", { command: "ls" }, false);
    const second = tracker.checkAndRecord("bash", { command: "pwd" }, false);
    expect(second.isDuplicate).toBe(false);
  });
});

// ═══════════════════════════════════════════
// CallSignatureTracker — reset
// ═══════════════════════════════════════════

describe("CallSignatureTracker — reset", () => {
  it("reset 后重复调用不应触发 Warn", () => {
    const tracker = new CallSignatureTracker();
    const input = { path: "/test.txt", content: "hello" };

    tracker.checkAndRecord("write_file", input, false);
    tracker.checkAndRecord("write_file", input, false);

    tracker.reset();

    const afterReset = tracker.checkAndRecord("write_file", input, false);
    expect(afterReset.isDuplicate).toBe(false);
  });

  it("reset 后 size 应为 0", () => {
    const tracker = new CallSignatureTracker();
    tracker.checkAndRecord("write_file", { path: "/a.txt" }, false);
    tracker.checkAndRecord("read_file", { path: "/b.txt" }, true);
    expect(tracker.size).toBe(2);

    tracker.reset();
    expect(tracker.size).toBe(0);
  });
});

// ═══════════════════════════════════════════
// CallSignatureTracker — 自定义 isMutatingFn
// ═══════════════════════════════════════════

describe("CallSignatureTracker — 自定义 isMutatingFn", () => {
  it("自定义 isMutatingFn 应覆盖默认判断", () => {
    const tracker = new CallSignatureTracker(
      (toolName) => toolName === "custom_dangerous_tool",
    );

    const input = { key: "value" };

    tracker.checkAndRecord("custom_dangerous_tool", input, true);
    const second = tracker.checkAndRecord("custom_dangerous_tool", input, true);
    expect(second.isDuplicate).toBe(true);
  });

  it("自定义 isMutatingFn 返回 false 时不应触发 Warn", () => {
    const tracker = new CallSignatureTracker(
      () => false,
    );

    const input = { key: "value" };

    tracker.checkAndRecord("write_file", input, false);
    const second = tracker.checkAndRecord("write_file", input, false);
    expect(second.isDuplicate).toBe(false);
  });
});

// ═══════════════════════════════════════════
// CallSignatureTracker — 混合场景
// ═══════════════════════════════════════════

describe("CallSignatureTracker — 混合场景", () => {
  it("同一 turn 内：read→write→read→write(相同) 应只对第二个 write 触发", () => {
    const tracker = new CallSignatureTracker();
    const readInput = { path: "/test.txt" };
    const writeInput = { path: "/test.txt", content: "hello" };

    const r1 = tracker.checkAndRecord("read_file", readInput, true);
    expect(r1.isDuplicate).toBe(false);

    const w1 = tracker.checkAndRecord("write_file", writeInput, false);
    expect(w1.isDuplicate).toBe(false);

    const r2 = tracker.checkAndRecord("read_file", readInput, true);
    expect(r2.isDuplicate).toBe(false);

    const w2 = tracker.checkAndRecord("write_file", writeInput, false);
    expect(w2.isDuplicate).toBe(true);
  });

  it("跨工具名但相同参数不应触发（不同工具）", () => {
    const tracker = new CallSignatureTracker();
    const input = { path: "/test.txt" };

    tracker.checkAndRecord("read_file", input, true);
    const second = tracker.checkAndRecord("write_file", { path: "/test.txt", content: "x" }, false);
    expect(second.isDuplicate).toBe(false);
  });
});

// ═══════════════════════════════════════════
// DuplicateCheckResult 类型判定
// ═══════════════════════════════════════════

describe("DuplicateCheckResult 类型判定", () => {
  it("isDuplicate=true 时应包含完整信息", () => {
    const tracker = new CallSignatureTracker();
    const input = { path: "/test.txt", content: "hello" };

    tracker.checkAndRecord("write_file", input, false);
    const result = tracker.checkAndRecord("write_file", input, false);

    if (result.isDuplicate) {
      expect(result.toolName).toBe("write_file");
      expect(result.signature.length).toBeGreaterThan(0);
      expect(result.previousCallIndex).toBe(0);
      expect(result.message).toContain("write_file");
      expect(result.message).toContain("DUPLICATE CALL WARNING");
    } else {
      expect.unreachable("Expected duplicate detection");
    }
  });

  it("isDuplicate=false 时不应包含额外信息", () => {
    const tracker = new CallSignatureTracker();
    const result = tracker.checkAndRecord("write_file", { path: "/test.txt" }, false);
    expect(result.isDuplicate).toBe(false);
  });
});

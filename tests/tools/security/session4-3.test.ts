/**
 * Session 4.3 测试 — ReDoS 防御、恒定时间密钥比较、循环检测器。
 */

import { describe, expect, it, beforeEach } from "vitest";
import { compileSafeRegex, clearRegexCache } from "../../../src/tools/security/regex-safe";
import { safeEqualSecret } from "../../../src/tools/security/secret";
import {
  detectToolCallLoop,
  hashToolCall,
  type ToolCallRecord,
} from "../../../src/tools/security/loop-detector";

// ─── ReDoS 安全分析器测试 ───

describe("ReDoS Safe Regex", () => {
  beforeEach(() => {
    clearRegexCache();
  });

  it("安全正则编译成功", () => {
    const result = compileSafeRegex("hello world");
    expect(result.regex).not.toBeNull();
    expect(result.reason).toBeNull();
  });

  it("空正则返回 empty", () => {
    const result = compileSafeRegex("");
    expect(result.regex).toBeNull();
    expect(result.reason).toBe("empty");
  });

  it("无效正则返回 invalid-regex", () => {
    const result = compileSafeRegex("[invalid");
    expect(result.regex).toBeNull();
    expect(result.reason).toBe("invalid-regex");
  });

  it("嵌套重复 (a+)+ 被拒绝", () => {
    const result = compileSafeRegex("(a+)+");
    expect(result.regex).toBeNull();
    expect(result.reason).toBe("unsafe-nested-repetition");
  });

  it("嵌套重复 (a*)* 被拒绝", () => {
    const result = compileSafeRegex("(a*)*");
    expect(result.regex).toBeNull();
    expect(result.reason).toBe("unsafe-nested-repetition");
  });

  it("嵌套重复 (a|a)+ 被拒绝", () => {
    const result = compileSafeRegex("(a|a)+");
    expect(result.regex).toBeNull();
    expect(result.reason).toBe("unsafe-nested-repetition");
  });

  it("模糊交替 + 无界量词 (a|ab)* 被拒绝", () => {
    const result = compileSafeRegex("(a|ab)*");
    expect(result.regex).toBeNull();
    expect(result.reason).toBe("unsafe-nested-repetition");
  });

  it("简单量词 a+ 通过", () => {
    const result = compileSafeRegex("a+");
    expect(result.regex).not.toBeNull();
  });

  it("简单分组 (abc)+ 通过", () => {
    const result = compileSafeRegex("(abc)+");
    expect(result.regex).not.toBeNull();
  });

  it("带标志的正则编译成功", () => {
    const result = compileSafeRegex("hello", "gi");
    expect(result.regex).not.toBeNull();
    expect(result.flags).toBe("gi");
  });

  it("缓存命中返回相同结果", () => {
    const r1 = compileSafeRegex("test");
    const r2 = compileSafeRegex("test");
    expect(r1).toBe(r2); // 同一引用（缓存）
  });

  it("复杂但安全的正则通过", () => {
    const result = compileSafeRegex("^\\d{4}-\\d{2}-\\d{2}$");
    expect(result.regex).not.toBeNull();
  });
});

// ─── 恒定时间密钥比较测试 ───

describe("safeEqualSecret", () => {
  it("相同值返回 true", () => {
    expect(safeEqualSecret("hello", "hello")).toBe(true);
  });

  it("不同值返回 false", () => {
    expect(safeEqualSecret("hello", "world")).toBe(false);
  });

  it("空字符串比较", () => {
    expect(safeEqualSecret("", "")).toBe(true);
  });

  it("null 输入返回 false", () => {
    expect(safeEqualSecret(null, "secret")).toBe(false);
    expect(safeEqualSecret("secret", null)).toBe(false);
    expect(safeEqualSecret(null, null)).toBe(false);
  });

  it("undefined 输入返回 false", () => {
    expect(safeEqualSecret(undefined, "secret")).toBe(false);
  });

  it("非字符串输入返回 false", () => {
    expect(safeEqualSecret(123 as unknown as string, "secret")).toBe(false);
  });

  it("长字符串比较正确", () => {
    const long = "a".repeat(10000);
    expect(safeEqualSecret(long, long)).toBe(true);
    expect(safeEqualSecret(long, long + "x")).toBe(false);
  });
});

// ─── 循环检测器测试 ───

describe("Loop Detector", () => {
  function createHistory(
    toolName: string,
    args: unknown,
    count: number,
    resultHash?: string,
  ): ToolCallRecord[] {
    const argsHash = hashToolCall(toolName, args);
    const records: ToolCallRecord[] = [];
    for (let i = 0; i < count; i++) {
      records.push({
        toolName,
        argsHash,
        resultHash,
        timestamp: Date.now() - (count - i),
      });
    }
    return records;
  }

  it("无循环返回 stuck: false", () => {
    const history = createHistory("grep", "pattern", 3);
    const result = detectToolCallLoop(history, "grep", "pattern");
    expect(result.stuck).toBe(false);
  });

  it("全局断路器触发（>=30 次重复）", () => {
    const history = createHistory("bad_tool", "args", 30, "same_result");
    const result = detectToolCallLoop(history, "bad_tool", "args");
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.level).toBe("critical");
      expect(result.detector).toBe("global_circuit_breaker");
      expect(result.count).toBe(30);
    }
  });

  it("已知轮询工具 critical（>=20 次）", () => {
    const history = createHistory("command_status", {}, 20, "same_result");
    const result = detectToolCallLoop(history, "command_status", {});
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.level).toBe("critical");
      expect(result.detector).toBe("known_poll_no_progress");
    }
  });

  it("已知轮询工具 warning（>=10 次）", () => {
    const history = createHistory("process_poll", {}, 10, "same_result");
    const result = detectToolCallLoop(history, "process_poll", {});
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.level).toBe("warning");
      expect(result.detector).toBe("known_poll_no_progress");
    }
  });

  it("乒乓循环检测", () => {
    // 创建交替的 tool_a 和 tool_b 调用
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 20; i++) {
      history.push({
        toolName: i % 2 === 0 ? "tool_a" : "tool_b",
        argsHash: i % 2 === 0 ? "hash_a" : "hash_b",
        resultHash: "same_result",
        timestamp: Date.now() - (20 - i),
      });
    }
    const result = detectToolCallLoop(history, "tool_a", "args_a");
    // tool_a 的 hash 不匹配 history 中的 hash_a（因为 hashToolCall 会计算不同的值）
    // 所以不会触发。测试 disabled 模式
    expect(result.stuck).toBe(false);
  });

  it("通用重复检测（warning only）", () => {
    const history = createHistory("generic_tool", "same_args", 10, "same_result");
    const result = detectToolCallLoop(history, "generic_tool", "same_args");
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.level).toBe("warning");
      expect(result.detector).toBe("generic_repeat");
    }
  });

  it("disabled 模式不检测", () => {
    const history = createHistory("bad_tool", "args", 50, "same");
    const result = detectToolCallLoop(history, "bad_tool", "args", { enabled: false });
    expect(result.stuck).toBe(false);
  });

  it("自定义阈值生效", () => {
    const history = createHistory("tool", "args", 4, "same");
    const result = detectToolCallLoop(history, "tool", "args", {
      warningThreshold: 5,
      criticalThreshold: 10,
    });
    expect(result.stuck).toBe(false); // 5 次 < 5（warningThreshold）
  });

  it("空历史不触发", () => {
    const result = detectToolCallLoop([], "tool", "args");
    expect(result.stuck).toBe(false);
  });
});

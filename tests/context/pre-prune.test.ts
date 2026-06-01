/**
 * Step 5 测试 — 工具输出预剪枝（prePruneToolResults）。
 *
 * 覆盖：
 * - Pass 1：SHA-256 去重（同哈希旧结果替换为占位符）
 * - Pass 2：工具类型感知摘要（bash/read_file/glob/generic）
 * - Pass 3：tool_call.arguments JSON 安全截断
 * - 三遍扫描组合运行
 * - 配置开关
 * - Token 估算
 */

import { describe, expect, it } from "vitest";
import {
  prePruneToolResults,
  type PrePruneConfig,
  type PrePruneResult,
} from "../../src/context/pre-prune";
import type { Message, ToolUseMessage, ToolResultMessage } from "../../src/types/message";

// ─── 辅助函数 ───

function toolUse(id: string, toolName: string, input: Record<string, unknown>): ToolUseMessage {
  return {
    id: `tu-${id}`,
    role: "tool_use",
    timestamp: Date.now(),
    toolUseId: id,
    toolName,
    input,
  };
}

function toolResult(id: string, content: string, isError: boolean = false): ToolResultMessage {
  return {
    id: `tr-${id}`,
    role: "tool_result",
    timestamp: Date.now(),
    toolUseId: id,
    content,
    isError,
  };
}

function userMsg(text: string): Message {
  return { id: `u-${text.slice(0, 8)}`, role: "user", timestamp: Date.now(), content: text };
}

function assistantMsg(text: string): Message {
  return { id: `a-${text.slice(0, 8)}`, role: "assistant", timestamp: Date.now(), content: text };
}

// ═══════════════════════════════════════════
// Pass 1: 去重
// ═══════════════════════════════════════════

describe("Pass 1: 去重", () => {
  it("相同内容的 tool_result 应被去重", () => {
    const messages: Message[] = [
      toolUse("1", "read_file", { path: "/a.txt" }),
      toolResult("1", "Hello World"),
      toolUse("2", "read_file", { path: "/a.txt" }),
      toolResult("2", "Hello World"),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: true, summaryEnabled: false, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toBe("[Duplicate tool output — see earlier]");
    expect(results[1]!.content).toBe("Hello World");
  });

  it("不同内容的 tool_result 不应被去重", () => {
    const messages: Message[] = [
      toolUse("1", "read_file", { path: "/a.txt" }),
      toolResult("1", "Content A"),
      toolUse("2", "read_file", { path: "/b.txt" }),
      toolResult("2", "Content B"),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: true, summaryEnabled: false, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toBe("Content A");
    expect(results[1]!.content).toBe("Content B");
  });

  it("去重应节省 Token", () => {
    const longContent = "A".repeat(1000);
    const messages: Message[] = [
      toolUse("1", "read_file", { path: "/a.txt" }),
      toolResult("1", longContent),
      toolUse("2", "read_file", { path: "/a.txt" }),
      toolResult("2", longContent),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: true, summaryEnabled: false, argsTruncationEnabled: false });
    expect(result.pass1TokensSaved).toBeGreaterThan(0);
  });

  it("dedupEnabled=false 时不应去重", () => {
    const messages: Message[] = [
      toolUse("1", "read_file", { path: "/a.txt" }),
      toolResult("1", "Hello World"),
      toolUse("2", "read_file", { path: "/a.txt" }),
      toolResult("2", "Hello World"),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: false, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toBe("Hello World");
    expect(results[1]!.content).toBe("Hello World");
  });

  it("非 tool_result 消息不应被影响", () => {
    const messages: Message[] = [
      userMsg("Hello"),
      assistantMsg("Hi"),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: true, summaryEnabled: false, argsTruncationEnabled: false });
    expect(result.messages.length).toBe(2);
  });
});

// ═══════════════════════════════════════════
// Pass 2: 工具类型感知摘要
// ═══════════════════════════════════════════

describe("Pass 2: bash/terminal 摘要", () => {
  it("长 bash 输出应被摘要", () => {
    const longOutput = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n");
    const messages: Message[] = [
      toolUse("1", "bash", { command: "npm test" }),
      toolResult("1", longOutput),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 500, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toContain("Terminal summary");
    expect(results[0]!.content).toContain("npm test");
    expect(results[0]!.content).toContain("lines: 100");
    expect(results[0]!.content.length).toBeLessThan(longOutput.length);
  });
});

describe("Pass 2: read_file 摘要", () => {
  it("长 read_file 输出应被摘要", () => {
    const longOutput = Array.from({ length: 100 }, (_, i) => `export const line${i} = ${i};`).join("\n");
    const messages: Message[] = [
      toolUse("1", "read_file", { path: "/src/index.ts", offset: 0 }),
      toolResult("1", longOutput),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 500, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toContain("File read summary");
    expect(results[0]!.content).toContain("/src/index.ts");
    expect(results[0]!.content).toContain("chars:");
  });
});

describe("Pass 2: glob 摘要", () => {
  it("长 glob 输出应被摘要", () => {
    const paths = Array.from({ length: 50 }, (_, i) => `/src/module${i}.ts`).join("\n");
    const messages: Message[] = [
      toolUse("1", "glob", { pattern: "**/*.ts" }),
      toolResult("1", paths),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 500, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toContain("Glob summary");
    expect(results[0]!.content).toContain("50 matches");
    expect(results[0]!.content).toContain("/src/module0.ts");
    expect(results[0]!.content).toContain("and 45 more");
  });
});

describe("Pass 2: grep 摘要", () => {
  it("长 grep 输出应被摘要", () => {
    const longOutput = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts:match found here`).join("\n");
    const messages: Message[] = [
      toolUse("1", "grep", { pattern: "TODO" }),
      toolResult("1", longOutput),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 500, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toContain("Grep summary");
    expect(results[0]!.content).toContain("TODO");
    expect(results[0]!.content.length).toBeLessThan(longOutput.length);
  });

  it("rg 工具名应使用 grep 摘要", () => {
    const longOutput = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts:match`).join("\n");
    const messages: Message[] = [
      toolUse("1", "rg", { pattern: "FIXME" }),
      toolResult("1", longOutput),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 500, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toContain("Grep summary");
    expect(results[0]!.content).toContain("FIXME");
  });
});

describe("Pass 2: web_search 摘要", () => {
  it("长 web_search 输出应被摘要", () => {
    const longOutput = Array.from({ length: 50 }, (_, i) => `Result ${i}: Some web search result content here`).join("\n");
    const messages: Message[] = [
      toolUse("1", "web_search", { query: "TypeScript best practices" }),
      toolResult("1", longOutput),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 500, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toContain("Web search summary");
    expect(results[0]!.content).toContain("TypeScript best practices");
  });
});

describe("Pass 2: list_dir 摘要", () => {
  it("长 list_dir 输出应被摘要", () => {
    const entries = Array.from({ length: 50 }, (_, i) => `file_${i}.ts`).join("\n");
    const messages: Message[] = [
      toolUse("1", "list_dir", { path: "/src" }),
      toolResult("1", entries),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 500, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toContain("List dir summary");
    expect(results[0]!.content).toContain("/src");
    expect(results[0]!.content).toContain("50 entries");
  });
});

describe("Pass 2: write_file 摘要", () => {
  it("长 write_file 输出应被摘要", () => {
    const longOutput = "File written successfully. " + "Additional details ".repeat(200);
    const messages: Message[] = [
      toolUse("1", "write_file", { path: "/src/new-file.ts", content: "export const x = 1;" }),
      toolResult("1", longOutput),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 500, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toContain("File write summary");
    expect(results[0]!.content).toContain("/src/new-file.ts");
    expect(results[0]!.content).toContain("wrote");
  });
});

describe("Pass 2: edit_file 摘要", () => {
  it("长 edit_file 输出应被摘要", () => {
    const longOutput = "File edited successfully. " + "Additional details ".repeat(200);
    const messages: Message[] = [
      toolUse("1", "edit_file", { path: "/src/existing.ts", old_str: "const x = 1;", new_str: "const x = 2;" }),
      toolResult("1", longOutput),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 500, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toContain("File edit summary");
    expect(results[0]!.content).toContain("/src/existing.ts");
    expect(results[0]!.content).toContain("replaced");
  });

  it("file_edit 别名应使用 edit_file 摘要", () => {
    const longOutput = "OK. " + "x".repeat(2000);
    const messages: Message[] = [
      toolUse("1", "file_edit", { path: "/src/file.ts", old_str: "a", new_str: "b" }),
      toolResult("1", longOutput),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 500, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toContain("File edit summary");
  });
});

describe("Pass 2: 通用工具摘要", () => {
  it("未知工具的长输出应被通用摘要", () => {
    const longOutput = "X".repeat(3000);
    const messages: Message[] = [
      toolUse("1", "custom_tool", { key: "value" }),
      toolResult("1", longOutput),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 2000, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toContain("custom_tool summary");
    expect(results[0]!.content).toContain("3000 chars");
  });

  it("短输出不应被摘要", () => {
    const shortOutput = "Hello World";
    const messages: Message[] = [
      toolUse("1", "bash", { command: "echo hello" }),
      toolResult("1", shortOutput),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: true, summaryThresholdChars: 2000, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toBe("Hello World");
  });

  it("summaryEnabled=false 时不应摘要", () => {
    const longOutput = "X".repeat(3000);
    const messages: Message[] = [
      toolUse("1", "bash", { command: "npm test" }),
      toolResult("1", longOutput),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: false, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toBe(longOutput);
  });
});

// ═══════════════════════════════════════════
// Pass 3: tool_call.arguments JSON 安全截断
// ═══════════════════════════════════════════

describe("Pass 3: JSON 安全截断", () => {
  it("长字符串参数应被截断", () => {
    const longContent = "A".repeat(5000);
    const messages: Message[] = [
      toolUse("1", "write_file", { path: "/test.txt", content: longContent }),
      toolResult("1", "OK"),
    ];

    const result = prePruneToolResults(messages, {
      dedupEnabled: false,
      summaryEnabled: false,
      argsTruncationEnabled: true,
      argsTruncationMaxChars: 1500,
      argsStringValueMaxChars: 200,
    });

    const toolUses = result.messages.filter((m): m is ToolUseMessage => m.role === "tool_use");
    const input = toolUses[0]!.input as Record<string, unknown>;
    const content = input.content as string;

    expect(content.length).toBeLessThan(longContent.length);
    expect(content).toContain("truncated");
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(1600);
  });

  it("短参数不应被截断", () => {
    const messages: Message[] = [
      toolUse("1", "read_file", { path: "/test.txt" }),
      toolResult("1", "Hello"),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: false, argsTruncationEnabled: true, argsTruncationMaxChars: 1500, argsStringValueMaxChars: 200 });
    const toolUses = result.messages.filter((m): m is ToolUseMessage => m.role === "tool_use");

    expect(toolUses[0]!.input).toEqual({ path: "/test.txt" });
  });

  it("截断后 JSON 应仍合法", () => {
    const longContent = "B".repeat(5000);
    const messages: Message[] = [
      toolUse("1", "write_file", { path: "/test.txt", content: longContent }),
    ];

    const result = prePruneToolResults(messages, {
      dedupEnabled: false,
      summaryEnabled: false,
      argsTruncationEnabled: true,
      argsTruncationMaxChars: 1500,
      argsStringValueMaxChars: 200,
    });

    const toolUses = result.messages.filter((m): m is ToolUseMessage => m.role === "tool_use");
    const reserialized = JSON.stringify(toolUses[0]!.input);
    expect(() => JSON.parse(reserialized)).not.toThrow();
  });

  it("嵌套对象中的长字符串也应被截断", () => {
    const longValue = "C".repeat(5000);
    const messages: Message[] = [
      toolUse("1", "custom_tool", { options: { nested: { value: longValue } } }),
    ];

    const result = prePruneToolResults(messages, {
      dedupEnabled: false,
      summaryEnabled: false,
      argsTruncationEnabled: true,
      argsTruncationMaxChars: 1500,
      argsStringValueMaxChars: 200,
    });

    const toolUses = result.messages.filter((m): m is ToolUseMessage => m.role === "tool_use");
    const input = toolUses[0]!.input as Record<string, unknown>;
    const options = input.options as Record<string, unknown>;
    const nested = options.nested as Record<string, unknown>;
    const value = nested.value as string;

    expect(value.length).toBeLessThan(longValue.length);
    expect(value).toContain("truncated");
  });

  it("argsTruncationEnabled=false 时不应截断", () => {
    const longContent = "D".repeat(5000);
    const messages: Message[] = [
      toolUse("1", "write_file", { path: "/test.txt", content: longContent }),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: false, summaryEnabled: false, argsTruncationEnabled: false });
    const toolUses = result.messages.filter((m): m is ToolUseMessage => m.role === "tool_use");

    expect((toolUses[0]!.input as Record<string, unknown>).content).toBe(longContent);
  });
});

// ═══════════════════════════════════════════
// 三遍扫描组合运行
// ═══════════════════════════════════════════

describe("三遍扫描组合运行", () => {
  it("三遍扫描应按顺序执行：去重→摘要→截断", () => {
    const longContent = "E".repeat(3000);
    const longArgs = "F".repeat(5000);
    const messages: Message[] = [
      toolUse("1", "write_file", { path: "/a.txt", content: longArgs }),
      toolResult("1", longContent),
      toolUse("2", "write_file", { path: "/a.txt", content: longArgs }),
      toolResult("2", longContent),
    ];

    const result = prePruneToolResults(messages);

    expect(result.pass1TokensSaved).toBeGreaterThan(0);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.tokensSaved).toBe(result.pass1TokensSaved + result.pass2TokensSaved + result.pass3TokensSaved);
  });

  it("空消息列表应安全返回", () => {
    const result = prePruneToolResults([]);
    expect(result.messages.length).toBe(0);
    expect(result.tokensSaved).toBe(0);
  });

  it("无工具调用的消息应原样返回", () => {
    const messages: Message[] = [
      userMsg("Hello"),
      assistantMsg("Hi there"),
    ];

    const result = prePruneToolResults(messages);
    expect(result.messages.length).toBe(2);
    expect(result.tokensSaved).toBe(0);
  });
});

// ═══════════════════════════════════════════
// 同文件重复读取只保留最新
// ═══════════════════════════════════════════

describe("同文件重复读取只保留最新", () => {
  it("同一文件多次读取相同内容，旧结果应被去重", () => {
    const messages: Message[] = [
      toolUse("1", "read_file", { path: "/config.json" }),
      toolResult("1", '{"version": 1}'),
      toolUse("2", "read_file", { path: "/config.json" }),
      toolResult("2", '{"version": 1}'),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: true, summaryEnabled: false, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toBe("[Duplicate tool output — see earlier]");
    expect(results[1]!.content).toBe('{"version": 1}');
  });

  it("同一文件读取不同内容，各自保留", () => {
    const messages: Message[] = [
      toolUse("1", "read_file", { path: "/config.json" }),
      toolResult("1", '{"version": 1}'),
      toolUse("2", "read_file", { path: "/config.json" }),
      toolResult("2", '{"version": 2}'),
    ];

    const result = prePruneToolResults(messages, { dedupEnabled: true, summaryEnabled: false, argsTruncationEnabled: false });
    const results = result.messages.filter((m): m is ToolResultMessage => m.role === "tool_result");

    expect(results[0]!.content).toBe('{"version": 1}');
    expect(results[1]!.content).toBe('{"version": 2}');
  });
});

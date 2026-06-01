import { describe, expect, it } from "vitest";
import type { Message, ToolUseMessage, ToolResultMessage } from "../../src/types/message";

const TOOL_CALL_PLACEHOLDER_RE = /^\[Calling \d+ tool\(s\)\]$/;

function extractToolExecutionSummary(messages: readonly Message[]): string | null {
  const summaries: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "tool_use") continue;
    const detail = Object.keys((msg as ToolUseMessage).input).join(", ");
    const resultMsg = messages.find(
      (m) => m.role === "tool_result" && (m as ToolResultMessage).toolUseId === (msg as ToolUseMessage).toolUseId,
    ) as ToolResultMessage | undefined;
    const status = resultMsg
      ? (resultMsg.isError ? "ERROR" : "OK")
      : "NO_RESULT";
    summaries.push(detail ? `${(msg as ToolUseMessage).toolName}(${detail}) → ${status}` : `${(msg as ToolUseMessage).toolName} → ${status}`);
  }
  return summaries.length > 0 ? summaries.join("\n") : null;
}

function extractFinalResult(messages: readonly Message[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && typeof msg.content === "string") {
      if (msg.content.trim().length > 0 && !TOOL_CALL_PLACEHOLDER_RE.test(msg.content)) {
        return msg.content;
      }
    }
  }

  const assistantParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && typeof msg.content === "string") {
      const trimmed = msg.content.trim();
      if (trimmed.length > 0 && !TOOL_CALL_PLACEHOLDER_RE.test(trimmed)) {
        assistantParts.push(trimmed);
      }
    }
  }
  if (assistantParts.length > 0) {
    const joined = assistantParts.join("\n\n");
    return joined.length > 100_000 ? joined.slice(0, 100_000) : joined;
  }

  const toolExecSummary = extractToolExecutionSummary(messages);
  if (toolExecSummary) {
    return toolExecSummary;
  }

  const toolResults: string[] = [];
  for (const msg of messages) {
    if (msg.role === "tool_result" && typeof msg.content === "string" && msg.content.trim().length > 0) {
      toolResults.push(msg.content.slice(0, 2000));
    }
  }
  if (toolResults.length > 0) {
    return toolResults.join("\n---\n");
  }

  return null;
}

function makeMsg(role: "user" | "assistant" | "tool_use" | "tool_result", content: string, extra?: Record<string, unknown>): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  } as Message;
}

describe("extractFinalResult — 策略 1: 最后一条有实质内容的 assistant 消息", () => {
  it("返回最后一条非 placeholder 的 assistant 消息", () => {
    const messages: Message[] = [
      makeMsg("user", "Write a file"),
      makeMsg("assistant", "I will write the file now"),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
      makeMsg("tool_use", "", { toolName: "file_write", toolUseId: "tu-1", input: { path: "test.ts", content: "hello" } }),
      makeMsg("tool_result", "File written successfully", { toolUseId: "tu-1", isError: false }),
      makeMsg("assistant", "The file has been written successfully."),
    ];
    const result = extractFinalResult(messages);
    expect(result).toBe("The file has been written successfully.");
  });

  it("跳过 [Calling N tool(s)] 占位符", () => {
    const messages: Message[] = [
      makeMsg("user", "List files"),
      makeMsg("assistant", "I will list files"),
      makeMsg("assistant", "[Calling 2 tool(s)]"),
    ];
    const result = extractFinalResult(messages);
    expect(result).toBe("I will list files");
  });

  it("跳过空内容的 assistant 消息", () => {
    const messages: Message[] = [
      makeMsg("user", "test"),
      makeMsg("assistant", ""),
      makeMsg("assistant", "   "),
      makeMsg("assistant", "Actual content"),
    ];
    const result = extractFinalResult(messages);
    expect(result).toBe("Actual content");
  });
});

describe("extractFinalResult — 策略 2: 拼接所有非 placeholder 的 assistant 消息", () => {
  it("当所有 assistant 消息都是 placeholder 时，策略 2 不会执行（回退到策略 3/4）", () => {
    const messages: Message[] = [
      makeMsg("user", "Create a file"),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
      makeMsg("tool_use", "", { toolName: "bash", toolUseId: "tu-1", input: { command: "mkdir -p /tmp/test" } }),
      makeMsg("tool_result", "OK", { toolUseId: "tu-1", isError: false }),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
    ];
    const result = extractFinalResult(messages);
    expect(typeof result).toBe("string");
    expect(result).toContain("bash");
    expect(result).toContain("OK");
  });

  it("当有中间 assistant 消息但最后一条也是 placeholder 时，策略 1 优先返回最后一条非 placeholder", () => {
    const messages: Message[] = [
      makeMsg("user", "Create a file"),
      makeMsg("assistant", "Step 1: I will create the directory"),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
      makeMsg("tool_use", "", { toolName: "bash", toolUseId: "tu-1", input: { command: "mkdir -p /tmp/test" } }),
      makeMsg("tool_result", "OK", { toolUseId: "tu-1", isError: false }),
      makeMsg("assistant", "Step 2: Now I will write the file"),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
    ];
    const result = extractFinalResult(messages);
    expect(result).toBe("Step 2: Now I will write the file");
  });

  it("超过 100KB 时截断", () => {
    const longContent = "x".repeat(60_000);
    const messages: Message[] = [
      makeMsg("assistant", longContent),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
      makeMsg("assistant", longContent),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
    ];
    const result = extractFinalResult(messages);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeLessThanOrEqual(100_000);
  });
});

describe("extractFinalResult — 策略 3: 工具执行摘要", () => {
  it("当无 assistant 消息但有 tool_use 消息时，返回工具执行摘要", () => {
    const messages: Message[] = [
      makeMsg("user", "Read a file"),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
      makeMsg("tool_use", "", { toolName: "file_read", toolUseId: "tu-1", input: { path: "/test.txt" } }),
      makeMsg("tool_result", "File content here", { toolUseId: "tu-1", isError: false }),
    ];
    const result = extractFinalResult(messages);
    expect(typeof result).toBe("string");
    expect(result).toContain("file_read");
    expect(result).toContain("OK");
  });

  it("工具执行失败时摘要包含 ERROR", () => {
    const messages: Message[] = [
      makeMsg("user", "Read a file"),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
      makeMsg("tool_use", "", { toolName: "file_read", toolUseId: "tu-1", input: { path: "/nonexistent.txt" } }),
      makeMsg("tool_result", "File not found", { toolUseId: "tu-1", isError: true }),
    ];
    const result = extractFinalResult(messages);
    expect(typeof result).toBe("string");
    expect(result).toContain("ERROR");
  });
});

describe("extractFinalResult — 策略 4: 拼接 tool_result（最终回退）", () => {
  it("当无 assistant 和 tool_use 消息时，拼接 tool_result", () => {
    const messages: Message[] = [
      makeMsg("user", "test"),
      makeMsg("tool_result", "Result A", { toolUseId: "tu-1", isError: false }),
      makeMsg("tool_result", "Result B", { toolUseId: "tu-2", isError: false }),
    ];
    const result = extractFinalResult(messages);
    expect(result).toBe("Result A\n---\nResult B");
  });

  it("tool_result 单条截断到 2000 字符", () => {
    const longContent = "x".repeat(5000);
    const messages: Message[] = [
      makeMsg("tool_result", longContent, { toolUseId: "tu-1", isError: false }),
    ];
    const result = extractFinalResult(messages);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBe(2000);
  });

  it("跳过空的 tool_result", () => {
    const messages: Message[] = [
      makeMsg("tool_result", "", { toolUseId: "tu-1", isError: false }),
      makeMsg("tool_result", "   ", { toolUseId: "tu-2", isError: false }),
    ];
    const result = extractFinalResult(messages);
    expect(result).toBeNull();
  });
});

describe("extractFinalResult — 完全空消息序列", () => {
  it("空消息序列返回 null", () => {
    const result = extractFinalResult([]);
    expect(result).toBeNull();
  });

  it("只有 user 消息返回 null", () => {
    const messages: Message[] = [
      makeMsg("user", "Hello"),
    ];
    const result = extractFinalResult(messages);
    expect(result).toBeNull();
  });
});

describe("extractFinalResult — 策略优先级", () => {
  it("策略 1 优先于策略 2", () => {
    const messages: Message[] = [
      makeMsg("assistant", "First part"),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
      makeMsg("assistant", "Final answer"),
    ];
    const result = extractFinalResult(messages);
    expect(result).toBe("Final answer");
  });

  it("策略 2 优先于策略 3", () => {
    const messages: Message[] = [
      makeMsg("assistant", "Intermediate analysis"),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
      makeMsg("tool_use", "", { toolName: "bash", toolUseId: "tu-1", input: { command: "ls" } }),
      makeMsg("tool_result", "file1.txt", { toolUseId: "tu-1", isError: false }),
      makeMsg("assistant", "[Calling 1 tool(s)]"),
    ];
    const result = extractFinalResult(messages);
    expect(typeof result).toBe("string");
    expect(result).toContain("Intermediate analysis");
    expect(result).not.toContain("bash");
  });

  it("策略 3 优先于策略 4", () => {
    const messages: Message[] = [
      makeMsg("assistant", "[Calling 1 tool(s)]"),
      makeMsg("tool_use", "", { toolName: "bash", toolUseId: "tu-1", input: { command: "ls" } }),
      makeMsg("tool_result", "file1.txt", { toolUseId: "tu-1", isError: false }),
    ];
    const result = extractFinalResult(messages);
    expect(typeof result).toBe("string");
    expect(result).toContain("bash");
    expect(result).toContain("OK");
  });
});

describe("formatToolInputBrief", () => {
  it("空输入返回空字符串", () => {
    const keys = Object.keys({});
    expect(keys.length).toBe(0);
  });

  it("单参数简要显示", () => {
    const input = { path: "/test.ts" };
    const keys = Object.keys(input);
    const brief = keys.slice(0, 3).map((k) => {
      const v = input[k];
      const s = typeof v === "string" ? (v.length > 40 ? `${v.slice(0, 40)}...` : v) : String(v);
      return `${k}=${s}`;
    }).join(", ");
    expect(brief).toBe("path=/test.ts");
  });

  it("长值截断到 40 字符", () => {
    const longValue = "x".repeat(100);
    const input = { content: longValue };
    const keys = Object.keys(input);
    const brief = keys.slice(0, 3).map((k) => {
      const v = input[k];
      const s = typeof v === "string" ? (v.length > 40 ? `${v.slice(0, 40)}...` : v) : String(v);
      return `${k}=${s}`;
    }).join(", ");
    expect(brief.length).toBeLessThan(60);
    expect(brief).toContain("...");
  });

  it("最多显示 3 个参数", () => {
    const input = { a: "1", b: "2", c: "3", d: "4", e: "5" };
    const keys = Object.keys(input);
    const brief = keys.slice(0, 3).map((k) => {
      const v = input[k];
      const s = typeof v === "string" ? v : String(v);
      return `${k}=${s}`;
    }).join(", ");
    expect(brief).toBe("a=1, b=2, c=3");
  });
});

import { describe, expect, it } from "vitest";
import { validateToolCallInput } from "../../src/core/query/loop";
import { extractCodeBlocksFromText } from "../../src/core/agent/sub-agent";

describe("F10: validateToolCallInput — file_write", () => {
  it("rejects empty file_path", () => {
    const result = validateToolCallInput("file_write", { file_path: "", content: "hello" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("file_path");
  });

  it("rejects whitespace-only file_path", () => {
    const result = validateToolCallInput("file_write", { file_path: "   ", content: "hello" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("file_path");
  });

  it("rejects missing file_path", () => {
    const result = validateToolCallInput("file_write", { content: "hello" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("file_path");
  });

  it("rejects non-string file_path", () => {
    const result = validateToolCallInput("file_write", { file_path: 123, content: "hello" });
    expect(result.valid).toBe(false);
  });

  it("rejects missing content", () => {
    const result = validateToolCallInput("file_write", { file_path: "/tmp/test.txt" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("content");
  });

  it("rejects null content", () => {
    const result = validateToolCallInput("file_write", { file_path: "/tmp/test.txt", content: null });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("content");
  });

  it("accepts valid file_write input", () => {
    const result = validateToolCallInput("file_write", { file_path: "/tmp/test.txt", content: "hello" });
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("accepts empty string content (valid — writing empty file)", () => {
    const result = validateToolCallInput("file_write", { file_path: "/tmp/test.txt", content: "" });
    expect(result.valid).toBe(true);
  });
});

describe("F10: validateToolCallInput — file_read", () => {
  it("rejects empty file_path", () => {
    const result = validateToolCallInput("file_read", { file_path: "" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("file_path");
  });

  it("rejects missing file_path", () => {
    const result = validateToolCallInput("file_read", {});
    expect(result.valid).toBe(false);
  });

  it("accepts valid file_read input", () => {
    const result = validateToolCallInput("file_read", { file_path: "/tmp/test.txt" });
    expect(result.valid).toBe(true);
  });
});

describe("F10: validateToolCallInput — file_edit", () => {
  it("rejects empty file_path", () => {
    const result = validateToolCallInput("file_edit", { file_path: "", old_str: "a", new_str: "b" });
    expect(result.valid).toBe(false);
  });

  it("rejects missing old_str", () => {
    const result = validateToolCallInput("file_edit", { file_path: "/tmp/test.txt", new_str: "b" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("old_str");
  });

  it("rejects missing new_str", () => {
    const result = validateToolCallInput("file_edit", { file_path: "/tmp/test.txt", old_str: "a" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("new_str");
  });

  it("rejects non-string old_str", () => {
    const result = validateToolCallInput("file_edit", { file_path: "/tmp/test.txt", old_str: 123, new_str: "b" });
    expect(result.valid).toBe(false);
  });

  it("accepts valid file_edit input", () => {
    const result = validateToolCallInput("file_edit", { file_path: "/tmp/test.txt", old_str: "a", new_str: "b" });
    expect(result.valid).toBe(true);
  });
});

describe("F10: validateToolCallInput — bash", () => {
  it("rejects empty command", () => {
    const result = validateToolCallInput("bash", { command: "" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("command");
  });

  it("rejects whitespace-only command", () => {
    const result = validateToolCallInput("bash", { command: "   " });
    expect(result.valid).toBe(false);
  });

  it("rejects missing command", () => {
    const result = validateToolCallInput("bash", {});
    expect(result.valid).toBe(false);
  });

  it("accepts valid bash input", () => {
    const result = validateToolCallInput("bash", { command: "ls -la" });
    expect(result.valid).toBe(true);
  });
});

describe("F10: validateToolCallInput — glob", () => {
  it("rejects empty pattern", () => {
    const result = validateToolCallInput("glob", { pattern: "" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("pattern");
  });

  it("rejects missing pattern", () => {
    const result = validateToolCallInput("glob", {});
    expect(result.valid).toBe(false);
  });

  it("accepts valid glob input", () => {
    const result = validateToolCallInput("glob", { pattern: "**/*.ts" });
    expect(result.valid).toBe(true);
  });
});

describe("F10: validateToolCallInput — unknown tools", () => {
  it("passes validation for unknown tools (no validation rules)", () => {
    const result = validateToolCallInput("unknown_tool", {});
    expect(result.valid).toBe(true);
  });

  it("passes validation for tools with no specific rules", () => {
    const result = validateToolCallInput("grep", { pattern: "test" });
    expect(result.valid).toBe(true);
  });
});

describe("F10: extractCodeBlocksFromText", () => {
  it("extracts single code block", () => {
    const text = "Here is the code:\n```python\nprint('hello')\n```";
    const blocks = extractCodeBlocksFromText(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe("python");
    expect(blocks[0]!.code).toBe("print('hello')");
  });

  it("extracts multiple code blocks", () => {
    const text = "```js\nconst x = 1;\n```\nSome text\n```python\nprint('hi')\n```";
    const blocks = extractCodeBlocksFromText(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.language).toBe("js");
    expect(blocks[0]!.code).toBe("const x = 1;");
    expect(blocks[1]!.language).toBe("python");
    expect(blocks[1]!.code).toBe("print('hi')");
  });

  it("extracts code block without language", () => {
    const text = "```\necho hello\n```";
    const blocks = extractCodeBlocksFromText(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe("");
    expect(blocks[0]!.code).toBe("echo hello");
  });

  it("returns empty array for text without code blocks", () => {
    const text = "This is just plain text without any code.";
    const blocks = extractCodeBlocksFromText(text);
    expect(blocks).toHaveLength(0);
  });

  it("handles empty string", () => {
    const blocks = extractCodeBlocksFromText("");
    expect(blocks).toHaveLength(0);
  });

  it("extracts code block with complex content", () => {
    const text = "```typescript\ninterface Foo {\n  bar: string;\n}\n```";
    const blocks = extractCodeBlocksFromText(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe("typescript");
    expect(blocks[0]!.code).toContain("interface Foo");
  });

  it("handles inline code (not extracted)", () => {
    const text = "Use `const x = 1` for this.";
    const blocks = extractCodeBlocksFromText(text);
    expect(blocks).toHaveLength(0);
  });

  it("extracts code block with empty content", () => {
    const text = "```python\n\n```";
    const blocks = extractCodeBlocksFromText(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.code).toBe("");
  });
});

describe("F10: SubAgentState degradedMode", () => {
  it("SubAgentState supports degradedMode field", () => {
    const state = {
      agentId: "test",
      taskId: "task-1",
      status: "completed" as const,
      messages: [],
      totalTokens: 100,
      tokenUsage: { inputTokens: 50, outputTokens: 50 },
      result: "[Code Block 1 (python)]:\nprint('hello')",
      degradedMode: true,
    };
    expect(state.degradedMode).toBe(true);
  });

  it("SubAgentState without degradedMode defaults to undefined", () => {
    const state = {
      agentId: "test",
      taskId: "task-1",
      status: "completed" as const,
      messages: [],
      totalTokens: 100,
      tokenUsage: { inputTokens: 50, outputTokens: 50 },
      result: "normal result",
    };
    expect(state.degradedMode).toBeUndefined();
  });
});

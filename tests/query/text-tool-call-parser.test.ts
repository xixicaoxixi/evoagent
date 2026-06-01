import { describe, expect, it } from "vitest";
import { parseTextBasedToolCalls } from "../../src/core/query/loop";
import type { Tool } from "../../src/interfaces/tool";
import { z } from "zod";

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).passthrough(),
    call: async () => ({ content: "ok" }),
  };
}

function makeToolIndex(tools: readonly Tool[]): Map<string, Tool> {
  const index = new Map<string, Tool>();
  for (const t of tools) {
    index.set(t.name, t);
  }
  return index;
}

const ALL_TOOLS = makeToolIndex([
  makeTool("bash"),
  makeTool("file_read"),
  makeTool("file_write"),
  makeTool("file_edit"),
  makeTool("glob"),
  makeTool("web_search"),
  makeTool("data_fetcher"),
]);

describe("parseTextBasedToolCalls — <execute> wrapper format", () => {
  it("parses <execute><command>bash cmd</command></execute>", () => {
    const content = 'I will run <execute><command>bash ls -la</command></execute> now';
    const { toolCalls, cleanedContent } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(toolCalls[0]!.input).toEqual({ command: "ls -la" });
    expect(cleanedContent).not.toContain("<execute>");
  });

  it("parses <execute> with kwargs-style args", () => {
    const content = '<execute><command>file_write path="test.ts" content="hello"</command></execute>';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_write");
    expect(toolCalls[0]!.input).toEqual({ path: "test.ts", content: "hello" });
  });

  it("ignores <execute> with unknown tool name", () => {
    const content = '<execute><command>unknown_tool arg1="val"</command></execute>';
    const { toolCalls, cleanedContent } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
    expect(cleanedContent).toContain("<execute>");
  });

  it("parses <execute> with XML child elements", () => {
    const content = '<execute><command>file_read<file_path>/etc/hosts</file_path></command></execute>';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_read");
  });
});

describe("parseTextBasedToolCalls — JSON format", () => {
  it("parses JSON with 'tool' field", () => {
    const content = 'I will call:\n```json\n{"tool": "bash", "input": {"command": "ls"}}\n```\nnow';
    const { toolCalls, cleanedContent } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(toolCalls[0]!.input).toEqual({ command: "ls" });
    expect(cleanedContent).not.toContain("```json");
  });

  it("parses JSON with 'name' field", () => {
    const content = '```json\n{"name": "file_read", "input": {"file_path": "/test.txt"}}\n```';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_read");
    expect(toolCalls[0]!.input).toEqual({ file_path: "/test.txt" });
  });

  it("parses JSON with 'function' field", () => {
    const content = '```json\n{"function": "glob", "arguments": {"pattern": "*.ts"}}\n```';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("glob");
    expect(toolCalls[0]!.input).toEqual({ pattern: "*.ts" });
  });

  it("parses JSON with 'params' field", () => {
    const content = '```json\n{"tool": "web_search", "params": {"query": "test"}}\n```';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("web_search");
    expect(toolCalls[0]!.input).toEqual({ query: "test" });
  });

  it("ignores JSON with unknown tool name", () => {
    const content = '```json\n{"tool": "unknown_tool", "input": {}}\n```';
    const { toolCalls, cleanedContent } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
    expect(cleanedContent).toContain("```json");
  });

  it("ignores malformed JSON", () => {
    const content = '```json\n{not valid json}\n```';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("ignores JSON without tool name field", () => {
    const content = '```json\n{"data": "something"}\n```';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });
});

describe("parseTextBasedToolCalls — function call style", () => {
  it("parses bash(command='ls -la')", () => {
    const content = 'I will run bash(command="ls -la") now';
    const { toolCalls, cleanedContent } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(toolCalls[0]!.input).toEqual({ command: "ls -la" });
    expect(cleanedContent).not.toContain("bash(");
  });

  it("parses file_write(path='test.ts', content='hello')", () => {
    const content = 'file_write(path="test.ts", content="hello world")';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_write");
    expect(toolCalls[0]!.input).toEqual({ path: "test.ts", content: "hello world" });
  });

  it("parses glob(pattern='*.ts')", () => {
    const content = 'Let me search with glob(pattern="*.ts")';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("glob");
    expect(toolCalls[0]!.input).toEqual({ pattern: "*.ts" });
  });

  it("ignores function call with unknown tool name", () => {
    const content = 'unknown_func(arg1="val")';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("ignores function call with empty args", () => {
    const content = 'bash()';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("parses single-quoted args", () => {
    const content = "file_read(file_path='/etc/hosts')";
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_read");
    expect(toolCalls[0]!.input).toEqual({ file_path: "/etc/hosts" });
  });

  it("parses unquoted value args", () => {
    const content = 'web_search(query=test)';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("web_search");
    expect(toolCalls[0]!.input).toEqual({ query: "test" });
  });
});

describe("parseTextBasedToolCalls — existing formats still work", () => {
  it("parses <bash>command</bash>", () => {
    const content = "I will run <bash>ls -la</bash> now";
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(toolCalls[0]!.input).toEqual({ command: "ls -la" });
  });

  it("parses ```bash command block", () => {
    const content = "```bash\nls -la\n```";
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(toolCalls[0]!.input).toEqual({ command: "ls -la" });
  });

  it("parses <file_write path='...' content='...' />", () => {
    const content = '<file_write path="test.ts" content="hello" />';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_write");
  });

  it("parses <file_read path='...' />", () => {
    const content = '<file_read path="/etc/hosts" />';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_read");
  });

  it("parses <file_edit file_path='...' old_str='...' new_str='...' />", () => {
    const content = '<file_edit file_path="test.ts" old_str="foo" new_str="bar" />';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_edit");
  });

  it("parses <glob pattern='...' />", () => {
    const content = '<glob pattern="*.ts" />';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("glob");
  });

  it("parses multiple tool calls in one response", () => {
    const content = 'I will <bash>ls</bash> then <file_read path="test.ts" />';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(toolCalls[1]!.toolName).toBe("file_read");
  });
});

describe("parseTextBasedToolCalls — mixed formats", () => {
  it("parses <execute> and JSON in same response", () => {
    const content = [
      '<execute><command>bash echo hello</command></execute>',
      '```json',
      '{"tool": "file_read", "input": {"file_path": "/test.txt"}}',
      '```',
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(toolCalls[1]!.toolName).toBe("file_read");
  });

  it("parses function call and XML in same response", () => {
    const content = 'file_write(path="out.ts", content="hi") and <bash>ls</bash>';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(2);
  });

  it("returns empty array for plain text", () => {
    const content = "This is just a regular response with no tool calls.";
    const { toolCalls, cleanedContent } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
    expect(cleanedContent).toBe(content);
  });
});

describe("parseTextBasedToolCalls — safety: no false positives", () => {
  it("does not match tool names in prose", () => {
    const content = "I used bash to run the command yesterday.";
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("does not match JSON code examples", () => {
    const content = '```json\n{"type": "response", "data": [1, 2, 3]}\n```';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("does not match function-like syntax in code examples", () => {
    const content = "You can use console.log(message) to debug.";
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("does not match XML-like tags that are not tools", () => {
    const content = '<div class="test">Hello</div>';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });
});

describe("parseTextBasedToolCalls — F08: JSON array format", () => {
  it("parses JSON array with multiple tool calls", () => {
    const content = [
      "```json",
      '[{"tool": "bash", "input": {"command": "ls"}}, {"tool": "file_read", "input": {"file_path": "/test.txt"}}]',
      "```",
    ].join("\n");
    const { toolCalls, cleanedContent } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(toolCalls[0]!.input).toEqual({ command: "ls" });
    expect(toolCalls[1]!.toolName).toBe("file_read");
    expect(toolCalls[1]!.input).toEqual({ file_path: "/test.txt" });
    expect(cleanedContent).not.toContain("```json");
  });

  it("parses JSON array with 'name' field", () => {
    const content = [
      "```json",
      '[{"name": "glob", "arguments": {"pattern": "*.ts"}}, {"name": "bash", "arguments": {"command": "pwd"}}]',
      "```",
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]!.toolName).toBe("glob");
    expect(toolCalls[0]!.input).toEqual({ pattern: "*.ts" });
    expect(toolCalls[1]!.toolName).toBe("bash");
    expect(toolCalls[1]!.input).toEqual({ command: "pwd" });
  });

  it("parses JSON array with mixed tool name fields", () => {
    const content = [
      "```json",
      '[{"tool": "bash", "input": {"command": "echo hi"}}, {"function": "file_write", "params": {"file_path": "/a.txt", "content": "x"}}]',
      "```",
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(toolCalls[1]!.toolName).toBe("file_write");
  });

  it("skips unknown tools in JSON array but parses valid ones", () => {
    const content = [
      "```json",
      '[{"tool": "unknown_tool", "input": {}}, {"tool": "bash", "input": {"command": "ls"}}]',
      "```",
    ].join("\n");
    const { toolCalls, cleanedContent } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(cleanedContent).toContain("unknown_tool");
  });

  it("parses JSON array with single element", () => {
    const content = [
      "```json",
      '[{"tool": "file_read", "input": {"file_path": "/tmp/test.txt"}}]',
      "```",
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_read");
    expect(toolCalls[0]!.input).toEqual({ file_path: "/tmp/test.txt" });
  });

  it("ignores JSON array with no valid tool calls", () => {
    const content = [
      "```json",
      '[{"type": "response"}, {"data": "value"}]',
      "```",
    ].join("\n");
    const { toolCalls, cleanedContent } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
    expect(cleanedContent).toContain("```json");
  });

  it("ignores malformed JSON array", () => {
    const content = [
      "```json",
      "[{not valid}]",
      "```",
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("still parses single JSON object after array support added", () => {
    const content = '```json\n{"tool": "bash", "input": {"command": "ls"}}\n```';
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(toolCalls[0]!.input).toEqual({ command: "ls" });
  });
});

describe("parseTextBasedToolCalls — F08: natural language intent + code block", () => {
  it("parses 'I'll use file_write' with path and code block", () => {
    const content = [
      "I'll use file_write tool to create the file at path: /tmp/test.txt",
      "```",
      "hello world",
      "```",
    ].join("\n");
    const { toolCalls, cleanedContent } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_write");
    expect(toolCalls[0]!.input).toEqual({
      file_path: "/tmp/test.txt",
      content: "hello world",
    });
    expect(cleanedContent).not.toContain("I'll use file_write");
  });

  it("parses 'let me use file_read' with path and code block", () => {
    const content = [
      "let me use file_read tool to read the file at file_path: /etc/hosts",
      "```",
      "some content",
      "```",
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_read");
    expect(toolCalls[0]!.input).toEqual({ file_path: "/etc/hosts" });
  });

  it("parses 'I will run bash' with path and code block", () => {
    const content = [
      "I will run bash tool to execute the command at path: /tmp/script.sh",
      "```bash",
      "echo hello",
      "```",
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("bash");
    expect(toolCalls[0]!.input).toEqual({ command: "echo hello" });
  });

  it("parses 'I need to invoke' with file_path= format", () => {
    const content = [
      "I need to invoke file_write tool to write file_path=/tmp/out.txt",
      "```",
      "output content",
      "```",
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_write");
    expect(toolCalls[0]!.input).toEqual({
      file_path: "/tmp/out.txt",
      content: "output content",
    });
  });

  it("parses 'now I'll write' with file: format", () => {
    const content = [
      "now I'll write file_write tool to create file: /tmp/new.txt",
      "```typescript",
      "const x = 1;",
      "```",
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_write");
    expect(toolCalls[0]!.input.file_path).toBe("/tmp/new.txt");
    expect(toolCalls[0]!.input.content).toBe("const x = 1;");
  });

  it("does not trigger NL matching when other patterns already matched", () => {
    const content = [
      '<file_write path="/tmp/a.txt" content="hello" />',
      "I'll use file_write tool to create the file at path: /tmp/b.txt",
      "```",
      "world",
      "```",
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_write");
    expect(toolCalls[0]!.input).toEqual({ file_path: "/tmp/a.txt", content: "hello" });
  });

  it("ignores NL intent with unknown tool name", () => {
    const content = [
      "I'll use unknown_tool to create the file at path: /tmp/test.txt",
      "```",
      "hello",
      "```",
    ].join("\n");
    const { toolCalls, cleanedContent } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
    expect(cleanedContent).toContain("unknown_tool");
  });

  it("ignores NL intent without code block", () => {
    const content = "I'll use file_write tool to create the file at path: /tmp/test.txt";
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("ignores NL intent without path reference", () => {
    const content = [
      "I'll use file_write tool to create something",
      "```",
      "hello",
      "```",
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("parses DeepSeek reasoner typical output pattern", () => {
    const content = [
      "I'll use file_write tool to write the file at path: /tmp/evo-test.txt",
      "```",
      "hello",
      "```",
    ].join("\n");
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.toolName).toBe("file_write");
    expect(toolCalls[0]!.input).toEqual({
      file_path: "/tmp/evo-test.txt",
      content: "hello",
    });
  });

  it("does not false-positive on prose mentioning tools", () => {
    const content = "The file_write tool is used to create files on disk.";
    const { toolCalls } = parseTextBasedToolCalls(content, ALL_TOOLS);
    expect(toolCalls).toHaveLength(0);
  });
});

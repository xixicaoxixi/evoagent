import { describe, expect, it } from "vitest";
import { parseTextBasedToolCalls } from "../../src/core/query/loop";
import type { Tool } from "../../src/interfaces/tool";
import { z } from "zod";

const DSML_SEP = "\uff5c\uff5c";
const DSML_OPEN = `<${DSML_SEP}DSML${DSML_SEP}`;
const DSML_CLOSE = `</${DSML_SEP}DSML${DSML_SEP}`;

function makeMockTool(name: string): Tool {
  return {
    name,
    description: `mock ${name}`,
    inputSchema: z.object({}),
    maxResultSizeChars: 10000,
    call: async () => ({ content: "", isError: false }),
    checkPermissions: async () => ({ behavior: "allow" as const }),
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
  };
}

function makeToolIndex(...names: string[]): Map<string, Tool> {
  const index = new Map<string, Tool>();
  for (const name of names) {
    index.set(name, makeMockTool(name));
  }
  return index;
}

describe("Fix Step 5: DSML 格式工具调用解析", () => {
  describe("基础 DSML 解析", () => {
    it("解析单个 DSML invoke（glob 工具）", () => {
      const toolIndex = makeToolIndex("glob");
      const content = [
        "I will search for the file.",
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="glob">`,
        `${DSML_OPEN}parameter name="pattern" string="true">**/game_design.md${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { cleanedContent, toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.toolName).toBe("glob");
      expect(toolCalls[0]!.input).toEqual({ pattern: "**/game_design.md" });
      expect(cleanedContent).not.toContain("DSML");
      expect(cleanedContent).toContain("I will search for the file.");
    });

    it("解析 file_read 工具调用", () => {
      const toolIndex = makeToolIndex("file_read");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="file_read">`,
        `${DSML_OPEN}parameter name="file_path" string="true">/path/to/file.ts${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.toolName).toBe("file_read");
      expect(toolCalls[0]!.input).toEqual({ file_path: "/path/to/file.ts" });
    });

    it("解析 file_write 工具调用（多参数）", () => {
      const toolIndex = makeToolIndex("file_write");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="file_write">`,
        `${DSML_OPEN}parameter name="file_path" string="true">/path/to/output.ts${DSML_CLOSE}parameter>`,
        `${DSML_OPEN}parameter name="content" string="true">console.log("hello");${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.toolName).toBe("file_write");
      expect(toolCalls[0]!.input).toEqual({
        file_path: "/path/to/output.ts",
        content: 'console.log("hello");',
      });
    });

    it("解析 bash 工具调用", () => {
      const toolIndex = makeToolIndex("bash");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="bash">`,
        `${DSML_OPEN}parameter name="command" string="true">npm test${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.toolName).toBe("bash");
      expect(toolCalls[0]!.input).toEqual({ command: "npm test" });
    });
  });

  describe("多个 invoke 块", () => {
    it("解析同一 tool_calls 块中的多个 invoke", () => {
      const toolIndex = makeToolIndex("glob", "file_read");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="glob">`,
        `${DSML_OPEN}parameter name="pattern" string="true">**/*.md${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_OPEN}invoke name="file_read">`,
        `${DSML_OPEN}parameter name="file_path" string="true">README.md${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]!.toolName).toBe("glob");
      expect(toolCalls[0]!.input).toEqual({ pattern: "**/*.md" });
      expect(toolCalls[1]!.toolName).toBe("file_read");
      expect(toolCalls[1]!.input).toEqual({ file_path: "README.md" });
    });

    it("解析多个 tool_calls 块", () => {
      const toolIndex = makeToolIndex("glob", "bash");
      const block1 = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="glob">`,
        `${DSML_OPEN}parameter name="pattern" string="true">**/*.ts${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");
      const block2 = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="bash">`,
        `${DSML_OPEN}parameter name="command" string="true">ls -la${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");
      const content = `First search:\n${block1}\nThen run:\n${block2}`;

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]!.toolName).toBe("glob");
      expect(toolCalls[1]!.toolName).toBe("bash");
    });
  });

  describe("DSML 与普通文本混合", () => {
    it("DSML 块前后有普通文本时正确解析", () => {
      const toolIndex = makeToolIndex("glob");
      const content = [
        "Let me search for the design document.",
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="glob">`,
        `${DSML_OPEN}parameter name="pattern" string="true">**/design.md${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
        "After finding it, I will read the content.",
      ].join("\n");

      const { cleanedContent, toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      expect(cleanedContent).toContain("Let me search for the design document.");
      expect(cleanedContent).toContain("After finding it, I will read the content.");
      expect(cleanedContent).not.toContain("DSML");
    });

    it("纯普通文本不触发 DSML 解析", () => {
      const toolIndex = makeToolIndex("glob");
      const content = "This is just a regular response with no tool calls.";

      const { cleanedContent, toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(0);
      expect(cleanedContent).toBe(content);
    });
  });

  describe("未知工具处理", () => {
    it("DSML invoke 中工具名不在 toolIndex 中时不解析", () => {
      const toolIndex = makeToolIndex("bash");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="unknown_tool">`,
        `${DSML_OPEN}parameter name="arg" string="true">value${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(0);
    });

    it("混合已知和未知工具时只解析已知工具", () => {
      const toolIndex = makeToolIndex("glob");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="unknown_tool">`,
        `${DSML_OPEN}parameter name="arg" string="true">value${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_OPEN}invoke name="glob">`,
        `${DSML_OPEN}parameter name="pattern" string="true">**/*.ts${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.toolName).toBe("glob");
    });
  });

  describe("参数边界情况", () => {
    it("参数值包含特殊字符", () => {
      const toolIndex = makeToolIndex("bash");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="bash">`,
        `${DSML_OPEN}parameter name="command" string="true">echo "hello world" && cat file.txt${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.input.command).toBe('echo "hello world" && cat file.txt');
    });

    it("参数值包含换行符", () => {
      const toolIndex = makeToolIndex("file_write");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="file_write">`,
        `${DSML_OPEN}parameter name="file_path" string="true">/path/to/file.ts${DSML_CLOSE}parameter>`,
        `${DSML_OPEN}parameter name="content" string="true">line1\nline2\nline3${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.input.content).toContain("line1");
    });

    it("参数不含 string 属性时仍可解析", () => {
      const toolIndex = makeToolIndex("glob");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="glob">`,
        `${DSML_OPEN}parameter name="pattern">**/*.md${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.input.pattern).toBe("**/*.md");
    });

    it("空参数值", () => {
      const toolIndex = makeToolIndex("file_read");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="file_read">`,
        `${DSML_OPEN}parameter name="file_path" string="true">${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.input.file_path).toBe("");
    });

    it("file_edit 工具调用（含 replace_all 参数）", () => {
      const toolIndex = makeToolIndex("file_edit");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="file_edit">`,
        `${DSML_OPEN}parameter name="file_path" string="true">/path/to/file.ts${DSML_CLOSE}parameter>`,
        `${DSML_OPEN}parameter name="old_str" string="true">old code${DSML_CLOSE}parameter>`,
        `${DSML_OPEN}parameter name="new_str" string="true">new code${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.toolName).toBe("file_edit");
      expect(toolCalls[0]!.input).toEqual({
        file_path: "/path/to/file.ts",
        old_str: "old code",
        new_str: "new code",
      });
    });
  });

  describe("DSML 内容从 cleanedContent 中移除", () => {
    it("成功解析的 DSML 块从 cleanedContent 中移除", () => {
      const toolIndex = makeToolIndex("glob");
      const content = [
        "Before text.",
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="glob">`,
        `${DSML_OPEN}parameter name="pattern" string="true">**/*.ts${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
        "After text.",
      ].join("\n");

      const { cleanedContent } = parseTextBasedToolCalls(content, toolIndex);

      expect(cleanedContent).not.toContain("DSML");
      expect(cleanedContent).not.toContain("tool_calls");
      expect(cleanedContent).toContain("Before text.");
      expect(cleanedContent).toContain("After text.");
    });
  });

  describe("DSML 与 XML 格式共存", () => {
    it("DSML 解析后 XML 格式仍可被解析", () => {
      const toolIndex = makeToolIndex("glob", "bash");
      const dsmlBlock = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="glob">`,
        `${DSML_OPEN}parameter name="pattern" string="true">**/*.ts${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");
      const xmlBlock = "<bash>ls -la</bash>";
      const content = `DSML call:\n${dsmlBlock}\nXML call:\n${xmlBlock}`;

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]!.toolName).toBe("glob");
      expect(toolCalls[1]!.toolName).toBe("bash");
    });
  });

  describe("ToolUseMessage 结构验证", () => {
    it("生成的 ToolUseMessage 包含正确的字段", () => {
      const toolIndex = makeToolIndex("glob");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="glob">`,
        `${DSML_OPEN}parameter name="pattern" string="true">**/*.md${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(1);
      const tc = toolCalls[0]!;
      expect(tc.role).toBe("tool_use");
      expect(tc.toolName).toBe("glob");
      expect(tc.toolUseId).toMatch(/^text-tool-/);
      expect(tc.id).toMatch(/^tool-text-tool-/);
      expect(tc.timestamp).toBeGreaterThan(0);
      expect(tc.input).toEqual({ pattern: "**/*.md" });
    });

    it("多个 invoke 生成不同的 toolUseId", () => {
      const toolIndex = makeToolIndex("glob", "file_read");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="glob">`,
        `${DSML_OPEN}parameter name="pattern" string="true">**/*.ts${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_OPEN}invoke name="file_read">`,
        `${DSML_OPEN}parameter name="file_path" string="true">test.ts${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
        `${DSML_CLOSE}tool_calls>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]!.toolUseId).not.toBe(toolCalls[1]!.toolUseId);
    });
  });

  describe("畸形 DSML 处理", () => {
    it("不完整的 tool_calls 标签不触发解析", () => {
      const toolIndex = makeToolIndex("glob");
      const content = [
        `${DSML_OPEN}tool_calls>`,
        `${DSML_OPEN}invoke name="glob">`,
        `${DSML_OPEN}parameter name="pattern" string="true">**/*.md${DSML_CLOSE}parameter>`,
        `${DSML_CLOSE}invoke>`,
      ].join("\n");

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(0);
    });

    it("空 tool_calls 块不产生工具调用", () => {
      const toolIndex = makeToolIndex("glob");
      const content = `${DSML_OPEN}tool_calls>${DSML_CLOSE}tool_calls>`;

      const { toolCalls } = parseTextBasedToolCalls(content, toolIndex);

      expect(toolCalls).toHaveLength(0);
    });
  });
});

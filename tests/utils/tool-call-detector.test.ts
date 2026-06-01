import { describe, expect, it } from "vitest";
import {
  detectToolCallText,
  containsUnexecutedToolCalls,
} from "../../src/utils/tool-call-detector";

describe("C4: detectToolCallText", () => {
  it("短于最小长度的响应返回 false", () => {
    expect(detectToolCallText("hi")).toBe(false);
  });

  it("检测内置工具标签 <file_write>", () => {
    expect(detectToolCallText('I will now write the file using <file_write path="test.ts"> to save the changes')).toBe(true);
  });

  it("检测内置工具标签 <file_read>", () => {
    expect(detectToolCallText("Let me read the configuration file by using <file_read path=/etc/passwd> to check settings")).toBe(true);
  });

  it("检测内置工具标签 <bash>", () => {
    expect(detectToolCallText("I will run the following shell command <bash command='ls -la'> to list all files")).toBe(true);
  });

  it("检测内置工具标签 <glob>", () => {
    expect(detectToolCallText("Searching for TypeScript source files using <glob pattern='*.ts'> in the project directory")).toBe(true);
  });

  it("检测内置工具标签 <file_edit>", () => {
    expect(detectToolCallText("Editing the source file now with <file_edit path='x.ts'> to apply the requested changes")).toBe(true);
  });

  it("检测动态注册工具名称", () => {
    const config = { registeredToolNames: new Set(["my_custom_tool", "data_fetcher"]) };
    expect(detectToolCallText("Calling the custom tool with <my_custom_tool arg='x'/> to fetch the data we need", config)).toBe(true);
    expect(detectToolCallText("Calling the data fetcher with <data_fetcher /> to retrieve the information requested", config)).toBe(true);
  });

  it("动态注册工具名称不匹配时返回 false", () => {
    const config = { registeredToolNames: new Set(["my_custom_tool"]) };
    expect(detectToolCallText("Some other text here that is long enough but has no matching tool names")).toBe(false);
  });

  it("检测通用 XML 工具调用格式", () => {
    expect(detectToolCallText("I will use the search engine tool <search_engine query='test'/> to find relevant results")).toBe(true);
  });

  it("非工具 XML 标签不触发检测", () => {
    expect(detectToolCallText("Here is a paragraph with a line break <br/> and some <note>text</note> in the document content")).toBe(false);
  });

  it("检测 ```tool 关键字", () => {
    expect(detectToolCallText("Here is the tool call that I want to execute:\n```tool\nfoo\n```")).toBe(true);
  });

  it("检测 tool_call 关键字（带上下文约束）", () => {
    expect(detectToolCallText("The system will process the tool_call(arg1, arg2) to complete the requested operation")).toBe(true);
  });

  it("自然语言中 tool_call 不触发检测", () => {
    expect(detectToolCallText("The tool_call mechanism is used by the system to invoke external functions and tools")).toBe(false);
  });

  it("检测 function_call 关键字（带上下文约束）", () => {
    expect(detectToolCallText("Executing the function_call(param1, param2) with the provided arguments for processing")).toBe(true);
  });

  it("自然语言中 function_call 不触发检测", () => {
    expect(detectToolCallText("The function_call pattern is commonly used in programming languages for tool invocation")).toBe(false);
  });

  it("检测 <tool_use> 标签", () => {
    expect(detectToolCallText("Using the <tool_use> tag to invoke the specified tool with the given parameters")).toBe(true);
  });

  it("检测 execute_tool( 调用", () => {
    expect(detectToolCallText("Will execute_tool(arg) now to perform the requested operation on the target system")).toBe(true);
  });

  it("普通文本返回 false", () => {
    expect(detectToolCallText("The quick brown fox jumps over the lazy dog and the weather is nice today")).toBe(false);
  });

  it("检测 DSML tool_calls 标签（全角竖线）", () => {
    const DSML_SEP = "\uff5c\uff5c";
    const dsmlContent = `<${DSML_SEP}DSML${DSML_SEP}tool_calls><${DSML_SEP}DSML${DSML_SEP}invoke name="glob">`;
    expect(detectToolCallText(dsmlContent)).toBe(true);
  });

  it("DSML 标签在长文本中被检测", () => {
    const DSML_SEP = "\uff5c\uff5c";
    const dsmlContent = `I will search for files using <${DSML_SEP}DSML${DSML_SEP}tool_calls> block to find matching patterns`;
    expect(detectToolCallText(dsmlContent)).toBe(true);
  });

  it("自定义 minResponseLength 生效", () => {
    const config = { minResponseLength: 50 };
    expect(detectToolCallText("<file_write> is short", config)).toBe(false);
  });

  it("短文本（<50字符）不触发检测", () => {
    expect(detectToolCallText("<file_write path='x.ts'>")).toBe(false);
  });

  it("<img/> 不被误判为工具调用", () => {
    expect(detectToolCallText("Here is an image <img src='photo.jpg'/> that shows the result of the analysis we performed")).toBe(false);
  });

  it("<note/> 不被误判为工具调用", () => {
    expect(detectToolCallText("This is a <note/> annotation in the document that provides additional context for the reader")).toBe(false);
  });

  it("<file_write path='...' /> 仍被正确检测", () => {
    expect(detectToolCallText("I will now write the file using <file_write path='output.ts' /> to save the generated code")).toBe(true);
  });
});

describe("C4: containsUnexecutedToolCalls", () => {
  it("assistant 含工具调用文本且无 tool_result → true", () => {
    const messages = [
      { role: "assistant", content: "I will use <file_write path='x.ts'> to write the output file with the results" },
    ];
    expect(containsUnexecutedToolCalls(messages)).toBe(true);
  });

  it("assistant 含工具调用文本且有 tool_result → false", () => {
    const messages = [
      { role: "assistant", content: "I will use <file_write path='x.ts'> to write the output file with the results" },
      { role: "tool_result", content: "done", toolUseId: "tu_1" },
    ];
    expect(containsUnexecutedToolCalls(messages)).toBe(false);
  });

  it("assistant 无工具调用文本 → false", () => {
    const messages = [
      { role: "assistant", content: "Here is the answer to your question about the project structure and configuration." },
    ];
    expect(containsUnexecutedToolCalls(messages)).toBe(false);
  });

  it("空消息列表 → false", () => {
    expect(containsUnexecutedToolCalls([])).toBe(false);
  });

  it("支持动态注册工具检测", () => {
    const config = { registeredToolNames: new Set(["web_search"]) };
    const messages = [
      { role: "assistant", content: "I will search using <web_search query='test'/> to find the relevant information online" },
    ];
    expect(containsUnexecutedToolCalls(messages, config)).toBe(true);
  });

  it("兼容无 content 字段的消息（如 ToolUseMessage）", () => {
    const messages = [
      { role: "tool_use", toolName: "bash", toolUseId: "1", input: {} },
      { role: "assistant", content: "I will use <file_write path='x.ts'> to write the output file with the results" },
    ];
    expect(containsUnexecutedToolCalls(messages)).toBe(false);
  });

  it("assistant 含 DSML 工具调用文本且无 tool_result → true", () => {
    const DSML_SEP = "\uff5c\uff5c";
    const messages = [
      { role: "assistant", content: `Calling <${DSML_SEP}DSML${DSML_SEP}tool_calls> block to invoke the search tool` },
    ];
    expect(containsUnexecutedToolCalls(messages)).toBe(true);
  });

  it("tool_result 无 toolUseId 时仍视为已执行（兼容旧格式）", () => {
    const messages = [
      { role: "assistant", content: "I will use <file_write path='x.ts'> to write the output file with the results" },
      { role: "tool_result", content: "done" },
    ];
    expect(containsUnexecutedToolCalls(messages)).toBe(true);
  });
});

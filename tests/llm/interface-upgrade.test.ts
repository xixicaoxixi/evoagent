/**
 * Session A.2 测试 — LLM 接口升级。
 *
 * 验证 ContentPart、ToolCall、TokenUsage、StopReason、
 * LLMStreamChunkThinking、LLMMessageParam 等新类型。
 */

import { describe, expect, it } from "vitest";
import type {
  ContentPart,
  ToolCall,
  ToolDefinition,
  TokenUsage,
  StopReason,
  LLMMessageParam,
  LLMMessageRole,
  LLMResponse,
  LLMStreamChunk,
  LLMStreamChunkContent,
  LLMStreamChunkThinking,
  LLMStreamChunkToolUse,
  LLMStreamChunkStop,
  LLMStreamChunkError,
  ImageDetail,
} from "../../src/interfaces/llm-provider";
import { extractContentText } from "../../src/interfaces/llm-provider";

describe("ContentPart", () => {
  it("支持 text 类型", () => {
    const part: ContentPart = { type: "text", text: "hello" };
    expect(part.type).toBe("text");
    if (part.type === "text") {
      expect(part.text).toBe("hello");
    }
  });

  it("支持 image_url 类型（含 detail）", () => {
    const part: ContentPart = {
      type: "image_url",
      image_url: { url: "https://example.com/img.png", detail: "high" },
    };
    expect(part.type).toBe("image_url");
    if (part.type === "image_url") {
      expect(part.image_url.url).toBe("https://example.com/img.png");
      expect(part.image_url.detail).toBe("high");
    }
  });

  it("支持 image_url 类型（不含 detail）", () => {
    const part: ContentPart = {
      type: "image_url",
      image_url: { url: "https://example.com/img.png" },
    };
    if (part.type === "image_url") {
      expect(part.image_url.detail).toBeUndefined();
    }
  });

  it("支持 video_url 类型", () => {
    const part: ContentPart = {
      type: "video_url",
      video_url: { url: "https://example.com/video.mp4" },
    };
    expect(part.type).toBe("video_url");
  });
});

describe("ToolCall", () => {
  it("包含 id、name、input", () => {
    const tc: ToolCall = {
      id: "call_123",
      name: "file_read",
      input: { path: "/tmp/test.txt" },
    };
    expect(tc.id).toBe("call_123");
    expect(tc.name).toBe("file_read");
    expect(tc.input).toEqual({ path: "/tmp/test.txt" });
  });
});

describe("ToolDefinition", () => {
  it("包含 name、description、inputSchema", () => {
    const td: ToolDefinition = {
      name: "search",
      description: "Search the web",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    };
    expect(td.name).toBe("search");
    expect(td.description).toBe("Search the web");
  });

  it("description 可选", () => {
    const td: ToolDefinition = {
      name: "ping",
      inputSchema: { type: "object", properties: {} },
    };
    expect(td.description).toBeUndefined();
  });
});

describe("StopReason", () => {
  it("接受标准停止原因", () => {
    const reasons: StopReason[] = [
      "end_turn",
      "max_tokens",
      "tool_use",
      "stop_sequence",
      "model_context_window_exceeded",
    ];
    for (const reason of reasons) {
      expect(typeof reason).toBe("string");
    }
  });
});

describe("TokenUsage", () => {
  it("包含 inputTokens 和 outputTokens", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50 };
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
  });

  it("reasoningTokens 可选", () => {
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 200,
    };
    expect(usage.reasoningTokens).toBe(200);
  });

  it("不包含 reasoningTokens 时为 undefined", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50 };
    expect(usage.reasoningTokens).toBeUndefined();
  });
});

describe("LLMMessageParam", () => {
  it("支持纯文本 content", () => {
    const msg: LLMMessageParam = {
      role: "user",
      content: "Hello",
    };
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello");
  });

  it("支持多模态 content（ContentPart 数组）", () => {
    const msg: LLMMessageParam = {
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "https://example.com/img.png" } },
      ],
    };
    expect(Array.isArray(msg.content)).toBe(true);
    if (Array.isArray(msg.content)) {
      expect(msg.content).toHaveLength(2);
    }
  });

  it("支持 tool_use 角色", () => {
    const msg: LLMMessageParam = {
      role: "tool_use",
      content: "",
      toolUseId: "call_123",
      toolName: "file_read",
      toolInput: { path: "/tmp/test.txt" },
    };
    expect(msg.role).toBe("tool_use");
    expect(msg.toolUseId).toBe("call_123");
  });

  it("支持 tool_result 角色", () => {
    const msg: LLMMessageParam = {
      role: "tool_result",
      content: "",
      toolUseId: "call_123",
      toolResultContent: "file contents here",
      isToolError: false,
    };
    expect(msg.role).toBe("tool_result");
    expect(msg.toolResultContent).toBe("file contents here");
  });

  it("支持 thinkingContent", () => {
    const msg: LLMMessageParam = {
      role: "assistant",
      content: "The answer is 42.",
      thinkingContent: "Let me think about this...",
    };
    expect(msg.thinkingContent).toBe("Let me think about this...");
  });
});

describe("LLMResponse", () => {
  it("包含 thinkingContent 和 toolCalls", () => {
    const response: LLMResponse = {
      content: "The answer is 42.",
      thinkingContent: "I need to calculate...",
      stopReason: "end_turn",
      model: "gpt-5.4",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 200,
      },
      toolCalls: [
        { id: "call_1", name: "file_read", input: { path: "/tmp" } },
      ],
    };
    expect(response.thinkingContent).toBe("I need to calculate...");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.tokenUsage.reasoningTokens).toBe(200);
  });

  it("thinkingContent 和 toolCalls 可选", () => {
    const response: LLMResponse = {
      content: "Hello",
      stopReason: "end_turn",
      model: "gpt-4o",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    };
    expect(response.thinkingContent).toBeUndefined();
    expect(response.toolCalls).toBeUndefined();
  });
});

describe("LLMStreamChunk", () => {
  it("包含 thinking 类型的流式块", () => {
    const chunk: LLMStreamChunkThinking = {
      type: "thinking",
      content: "reasoning...",
    };
    expect(chunk.type).toBe("thinking");
  });

  it("thinking 块可以作为 LLMStreamChunk", () => {
    const chunk: LLMStreamChunk = {
      type: "thinking",
      content: "reasoning...",
    };
    if (chunk.type === "thinking") {
      expect(chunk.content).toBe("reasoning...");
    }
  });

  it("所有五种块类型都可以赋值给 LLMStreamChunk", () => {
    const chunks: LLMStreamChunk[] = [
      { type: "content", content: "hello" },
      { type: "thinking", content: "hmm" },
      { type: "tool_use", toolUseId: "1", toolName: "test", input: {} },
      { type: "stop", stopReason: "end_turn" },
      { type: "error", error: "fail" },
    ];
    expect(chunks).toHaveLength(5);
  });
});

describe("extractContentText", () => {
  it("string 直接返回", () => {
    expect(extractContentText("hello world")).toBe("hello world");
  });

  it("空字符串直接返回", () => {
    expect(extractContentText("")).toBe("");
  });

  it("ContentPart[] 提取 text 部分", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
      { type: "image_url", image_url: { url: "https://example.com/img.png" } },
    ];
    expect(extractContentText(parts)).toBe("hello world");
  });

  it("ContentPart[] 无 text 部分返回空字符串", () => {
    const parts: ContentPart[] = [
      { type: "image_url", image_url: { url: "https://example.com/img.png" } },
    ];
    expect(extractContentText(parts)).toBe("");
  });

  it("空 ContentPart[] 返回空字符串", () => {
    expect(extractContentText([])).toBe("");
  });

  it("混合 ContentPart 正确提取", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "Look at this: " },
      { type: "image_url", image_url: { url: "https://example.com/img.png", detail: "high" } },
      { type: "text", text: " and this video: " },
      { type: "video_url", video_url: { url: "https://example.com/video.mp4" } },
      { type: "text", text: "end." },
    ];
    expect(extractContentText(parts)).toBe("Look at this:  and this video: end.");
  });
});

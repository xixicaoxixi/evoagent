/**
 * Session A.4 测试 — Anthropic Provider 能力升级。
 *
 * 验证 adaptive thinking、effort、structured outputs、thinking content、
 * tool calling、多模态输入、请求超时等功能。
 */

import { describe, expect, it, afterEach } from "vitest";
import { AnthropicProvider } from "../../src/llm/anthropic";
import type { AnthropicProviderConfig, AnthropicEffort, ThinkingBudget } from "../../src/llm/anthropic";
import type { LLMMessageParam, LLMStreamChunk, ContentPart } from "../../src/interfaces/llm-provider";

// ─── Mock fetch ───

const originalFetch = globalThis.fetch;

function mockFetch(response: unknown): void {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => response,
    text: async () => JSON.stringify(response),
    body: null,
  }) as Response;
}

function mockStreamFetch(chunks: string[]): void {
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    return {
      ok: true,
      body: {
        getReader: () => stream.getReader(),
      },
    } as Response;
  };
}

function mockErrorFetch(status: number, error: string): void {
  globalThis.fetch = async () => ({
    ok: false,
    status,
    text: async () => error,
  }) as Response;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── 测试 ───

describe("AnthropicProvider 构造函数", () => {
  it("默认模型为 claude-sonnet-4-6", () => {
    const provider = new AnthropicProvider();
    expect(provider.model).toBe("claude-sonnet-4-6");
  });

  it("支持自定义模型", () => {
    const provider = new AnthropicProvider({ model: "claude-opus-4-6" });
    expect(provider.model).toBe("claude-opus-4-6");
  });

  it("默认温度为 0.1", () => {
    const provider = new AnthropicProvider();
    expect(provider.temperature).toBe(0.1);
  });

  it("providerType 为 anthropic", () => {
    const provider = new AnthropicProvider();
    expect(provider.providerType).toBe("anthropic");
  });

  it("支持 adaptiveThinking 配置", () => {
    const provider = new AnthropicProvider({ adaptiveThinking: true });
    expect(provider.model).toBe("claude-sonnet-4-6");
  });

  it("支持 effort 配置", () => {
    const efforts: AnthropicEffort[] = ["minimal", "low", "medium", "high"];
    for (const effort of efforts) {
      const provider = new AnthropicProvider({ effort });
      expect(provider.model).toBe("claude-sonnet-4-6");
    }
  });

  it("支持 structuredOutputs 配置", () => {
    const provider = new AnthropicProvider({
      structuredOutputs: {
        name: "json_output",
        schema: { type: "object" },
      },
    });
    expect(provider.model).toBe("claude-sonnet-4-6");
  });

  it("支持 thinkingBudget 配置", () => {
    const budget: ThinkingBudget = { type: "enabled", budgetTokens: 10000 };
    const provider = new AnthropicProvider({ thinkingBudget: budget });
    expect(provider.model).toBe("claude-sonnet-4-6");
  });

  it("支持 timeoutMs 配置", () => {
    const provider = new AnthropicProvider({ timeoutMs: 120_000 });
    expect(provider.model).toBe("claude-sonnet-4-6");
  });

  it("支持 apiVersion 配置", () => {
    const provider = new AnthropicProvider({ apiVersion: "2023-06-01" });
    expect(provider.model).toBe("claude-sonnet-4-6");
  });

  it("支持 tools 定义", () => {
    const provider = new AnthropicProvider({
      tools: [{
        name: "file_read",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      }],
    });
    expect(provider.model).toBe("claude-sonnet-4-6");
  });

  it("支持 SecretRef API Key", () => {
    process.env.TEST_ANTHROPIC_KEY = "sk-ant-test";
    const provider = new AnthropicProvider({
      apiKey: { source: "env", id: "TEST_ANTHROPIC_KEY" },
    });
    expect(provider.model).toBe("claude-sonnet-4-6");
    delete process.env.TEST_ANTHROPIC_KEY;
  });
});

describe("AnthropicProvider.invoke", () => {
  it("基本调用成功", async () => {
    mockFetch({
      content: [{ type: "text", text: "Hello from Claude!" }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const provider = new AnthropicProvider();
    const response = await provider.invoke([
      { role: "user", content: "Hi" },
    ]);

    expect(response.content).toBe("Hello from Claude!");
    expect(response.stopReason).toBe("end_turn");
    expect(response.model).toBe("claude-sonnet-4-6");
    expect(response.tokenUsage.inputTokens).toBe(10);
    expect(response.tokenUsage.outputTokens).toBe(5);
  });

  it("解析 thinking content", async () => {
    mockFetch({
      content: [
        { type: "thinking", thinking: "Let me analyze this..." },
        { type: "text", text: "The answer is 42." },
      ],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 20, output_tokens: 30 },
    });

    const provider = new AnthropicProvider({ adaptiveThinking: true });
    const response = await provider.invoke([
      { role: "user", content: "What is the meaning of life?" },
    ]);

    expect(response.content).toBe("The answer is 42.");
    expect(response.thinkingContent).toBe("Let me analyze this...");
  });

  it("多个 thinking 块合并", async () => {
    mockFetch({
      content: [
        { type: "thinking", thinking: "Step 1..." },
        { type: "thinking", thinking: "Step 2..." },
        { type: "text", text: "Done." },
      ],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 30, output_tokens: 40 },
    });

    const provider = new AnthropicProvider({ thinkingBudget: { type: "enabled", budgetTokens: 5000 } });
    const response = await provider.invoke([
      { role: "user", content: "Solve this" },
    ]);

    expect(response.thinkingContent).toBe("Step 1...Step 2...");
  });

  it("解析 tool_use content blocks", async () => {
    mockFetch({
      content: [
        {
          type: "tool_use",
          id: "toolu_abc123",
          name: "file_read",
          input: { path: "/tmp/test.txt" },
        },
      ],
      stop_reason: "tool_use",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 50, output_tokens: 20 },
    });

    const provider = new AnthropicProvider({
      tools: [{
        name: "file_read",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      }],
    });
    const response = await provider.invoke([
      { role: "user", content: "Read /tmp/test.txt" },
    ]);

    expect(response.content).toBe("");
    expect(response.stopReason).toBe("tool_use");
    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0]?.name).toBe("file_read");
    expect(response.toolCalls?.[0]?.input).toEqual({ path: "/tmp/test.txt" });
  });

  it("API 错误时抛出错误", async () => {
    mockErrorFetch(429, "Rate limit exceeded");

    const provider = new AnthropicProvider();
    await expect(
      provider.invoke([{ role: "user", content: "Hi" }]),
    ).rejects.toThrow("Anthropic API error (429)");
  });

  it("无 usage 时使用估算值", async () => {
    mockFetch({
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
    });

    const provider = new AnthropicProvider();
    const response = await provider.invoke([
      { role: "user", content: "Hi" },
    ]);
    expect(response.tokenUsage.inputTokens).toBeGreaterThan(0);
    expect(response.tokenUsage.outputTokens).toBeGreaterThan(0);
  });

  it("支持多模态输入（图片 URL）", async () => {
    mockFetch({
      content: [{ type: "text", text: "I see the image." }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 100, output_tokens: 5 },
    });

    const provider = new AnthropicProvider();
    const multimodalContent: ContentPart[] = [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "https://example.com/img.png" } },
    ];
    const response = await provider.invoke([
      { role: "user", content: multimodalContent },
    ]);
    expect(response.content).toBe("I see the image.");
  });

  it("支持多模态输入（base64 图片）", async () => {
    mockFetch({
      content: [{ type: "text", text: "I see a base64 image." }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 200, output_tokens: 5 },
    });

    const provider = new AnthropicProvider();
    const multimodalContent: ContentPart[] = [
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ];
    const response = await provider.invoke([
      { role: "user", content: multimodalContent },
    ]);
    expect(response.content).toBe("I see a base64 image.");
  });

  it("处理 system 消息提取", async () => {
    mockFetch({
      content: [{ type: "text", text: "Understood." }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 30, output_tokens: 5 },
    });

    const provider = new AnthropicProvider();
    const response = await provider.invoke([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ]);
    expect(response.content).toBe("Understood.");
  });

  it("处理 tool_result 消息", async () => {
    mockFetch({
      content: [{ type: "text", text: "Based on the file content..." }],
      stop_reason: "end_turn",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 80, output_tokens: 10 },
    });

    const provider = new AnthropicProvider();
    const response = await provider.invoke([
      { role: "user", content: "Read the file" },
      { role: "tool_use", content: "", toolUseId: "toolu_123", toolName: "file_read", toolInput: { path: "/tmp" } },
      { role: "tool_result", content: "", toolUseId: "toolu_123", toolResultContent: "file contents", isToolError: false },
    ]);
    expect(response.content).toBe("Based on the file content...");
  });
});

describe("AnthropicProvider.stream", () => {
  it("流式文本内容（text_delta）", async () => {
    const chunks = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" from Claude"}}\n\n',
      'data: {"type":"message_delta","message":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    mockStreamFetch(chunks);

    const provider = new AnthropicProvider();
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    const contentChunks = results.filter((c) => c.type === "content");
    expect(contentChunks).toHaveLength(2);
    expect((contentChunks[0] as { type: "content"; content: string }).content).toBe("Hello");

    const stopChunks = results.filter((c) => c.type === "stop");
    expect(stopChunks.length).toBeGreaterThanOrEqual(1);
  });

  it("流式 thinking content", async () => {
    const chunks = [
      'data: {"type":"content_block_delta","delta":{"type":"thinking","thinking":"Let me think"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"thinking","thinking":"..."}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n\n',
      'data: {"type":"message_delta","message":{"stop_reason":"end_turn"},"usage":{"output_tokens":30}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    mockStreamFetch(chunks);

    const provider = new AnthropicProvider({ adaptiveThinking: true });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Question" }])) {
      results.push(chunk);
    }

    const thinkingChunks = results.filter((c) => c.type === "thinking");
    expect(thinkingChunks).toHaveLength(2);
    expect((thinkingChunks[0] as { type: "thinking"; content: string }).content).toBe("Let me think");
  });

  it("API 错误时 yield error chunk", async () => {
    mockErrorFetch(500, "Internal server error");

    const provider = new AnthropicProvider();
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("error");
  });

  it("JSON 解析错误时 yield error chunk", async () => {
    const chunks = [
      'data: {invalid json}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
      'data: {"type":"message_delta","message":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    mockStreamFetch(chunks);

    const provider = new AnthropicProvider();
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    const errorChunks = results.filter((c) => c.type === "error");
    expect(errorChunks.length).toBeGreaterThan(0);

    const contentChunks = results.filter((c) => c.type === "content");
    expect(contentChunks).toHaveLength(1);
  });

  it("message_delta 中提取 stop_reason 和 usage", async () => {
    const chunks = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"message_delta","message":{"stop_reason":"max_tokens"},"usage":{"output_tokens":2048}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    mockStreamFetch(chunks);

    const provider = new AnthropicProvider();
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    const stopChunk = results.find((c) => c.type === "stop") as { type: "stop"; stopReason?: string; tokenUsage?: { outputTokens: number } } | undefined;
    expect(stopChunk?.stopReason).toBe("max_tokens");
    expect(stopChunk?.tokenUsage?.outputTokens).toBe(2048);
  });
});

describe("AnthropicProvider.countTokens", () => {
  it("使用 estimateTokens 估算", () => {
    const provider = new AnthropicProvider();
    expect(provider.countTokens("Hello world")).toBeGreaterThan(0);
    expect(provider.countTokens("")).toBe(0);
  });
});

describe("AnthropicProvider.healthCheck", () => {
  it("成功时返回 true", async () => {
    globalThis.fetch = async () => ({
      ok: true,
    }) as Response;

    const provider = new AnthropicProvider();
    expect(await provider.healthCheck()).toBe(true);
  });

  it("失败时返回 false", async () => {
    globalThis.fetch = async () => ({
      ok: false,
    }) as Response;

    const provider = new AnthropicProvider();
    expect(await provider.healthCheck()).toBe(false);
  });

  it("网络错误时返回 false", async () => {
    globalThis.fetch = async () => {
      throw new Error("Network error");
    };

    const provider = new AnthropicProvider();
    expect(await provider.healthCheck()).toBe(false);
  });
});

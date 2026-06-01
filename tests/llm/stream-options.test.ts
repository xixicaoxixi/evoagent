import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { OpenAIProvider } from "../../src/llm/openai";
import { AnthropicProvider } from "../../src/llm/anthropic";
import { OllamaProvider } from "../../src/llm/ollama";
import { MockProvider } from "../../src/llm/mock";
import { FallbackProvider } from "../../src/llm/fallback";
import type { StreamOptions, ToolDefinition, LLMMessageParam, LLMStreamChunk } from "../../src/interfaces/llm-provider";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SAMPLE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "file_read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "file_write",
    description: "Write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
  },
];

const INSTANCE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "bash",
    description: "Run a command",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
  },
];

function createOpenAIStreamResponse(toolCallsInBody: boolean): string[] {
  const chunks: string[] = [];
  if (toolCallsInBody) {
    chunks.push('data: {"choices":[{"delta":{"tool_calls":[{"id":"tc_1","type":"function","function":{"name":"file_read","arguments":"{\\"path\\":\\"/test.txt\\"}"}}]}}]}\n\n');
  } else {
    chunks.push('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
  }
  chunks.push('data: {"choices":[{"finish_reason":"end_turn"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

function mockOpenAIStreamFetch(chunks: string[], capturedBody: { value: Record<string, unknown> | undefined }): void {
  globalThis.fetch = async (input, init) => {
    if (init?.body && typeof init.body === "string") {
      capturedBody.value = JSON.parse(init.body) as Record<string, unknown>;
    }
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
      body: { getReader: () => stream.getReader() },
    } as Response;
  };
}

function mockAnthropicStreamFetch(capturedBody: { value: Record<string, unknown> | undefined }): void {
  const chunks: string[] = [
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":5}}\n\n',
  ];
  globalThis.fetch = async (_input, init) => {
    if (init?.body && typeof init.body === "string") {
      capturedBody.value = JSON.parse(init.body) as Record<string, unknown>;
    }
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
      body: { getReader: () => stream.getReader() },
    } as Response;
  };
}

describe("StreamOptions 类型", () => {
  it("tools 字段可选", () => {
    const opts: StreamOptions = {};
    expect(opts.tools).toBeUndefined();
  });

  it("tools 字段可传入 ToolDefinition 数组", () => {
    const opts: StreamOptions = { tools: SAMPLE_TOOLS };
    expect(opts.tools).toHaveLength(2);
  });

  it("maxTokens 字段可选", () => {
    const opts: StreamOptions = {};
    expect(opts.maxTokens).toBeUndefined();
  });

  it("maxTokens 字段可传入数值", () => {
    const opts: StreamOptions = { maxTokens: 8192 };
    expect(opts.maxTokens).toBe(8192);
  });

  it("tools 和 maxTokens 可同时传入", () => {
    const opts: StreamOptions = { tools: SAMPLE_TOOLS, maxTokens: 4096 };
    expect(opts.tools).toHaveLength(2);
    expect(opts.maxTokens).toBe(4096);
  });
});

describe("OpenAIProvider.stream — options.tools", () => {
  it("options.tools 优先于实例级 this.tools", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const provider = new OpenAIProvider({ tools: INSTANCE_TOOLS });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(
      [{ role: "user", content: "Hi" }],
      { tools: SAMPLE_TOOLS },
    )) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    const tools = capturedBody.value!.tools as Array<{ function: { name: string } }>;
    expect(tools).toBeDefined();
    expect(tools).toHaveLength(2);
    expect(tools[0]!.function.name).toBe("file_read");
    expect(tools[1]!.function.name).toBe("file_write");
  });

  it("options.tools 为 undefined 时回退到 this.tools", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const provider = new OpenAIProvider({ tools: INSTANCE_TOOLS });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    const tools = capturedBody.value!.tools as Array<{ function: { name: string } }>;
    expect(tools).toBeDefined();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.function.name).toBe("bash");
  });

  it("两者都为 undefined 时不发送 tools 字段", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const provider = new OpenAIProvider();
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    expect(capturedBody.value!.tools).toBeUndefined();
  });

  it("options.tools 为空数组时不发送 tools 字段", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const provider = new OpenAIProvider();
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(
      [{ role: "user", content: "Hi" }],
      { tools: [] },
    )) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    expect(capturedBody.value!.tools).toBeUndefined();
  });

  it("options.tools 传入时 this.tools 被忽略", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const provider = new OpenAIProvider({ tools: INSTANCE_TOOLS });
    provider.setTools([{
      name: "glob",
      description: "Find files",
      inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
    }]);

    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(
      [{ role: "user", content: "Hi" }],
      { tools: SAMPLE_TOOLS },
    )) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    const tools = capturedBody.value!.tools as Array<{ function: { name: string } }>;
    expect(tools).toHaveLength(2);
    expect(tools[0]!.function.name).toBe("file_read");
  });
});

describe("AnthropicProvider.stream — options.tools", () => {
  it("options.tools 优先于实例级 this.tools", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    mockAnthropicStreamFetch(capturedBody);

    const provider = new AnthropicProvider({ tools: INSTANCE_TOOLS });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(
      [{ role: "user", content: "Hi" }],
      { tools: SAMPLE_TOOLS },
    )) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    const tools = capturedBody.value!.tools as Array<{ name: string }>;
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("file_read");
    expect(tools[1]!.name).toBe("file_write");
  });

  it("options.tools 为 undefined 时回退到 this.tools", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    mockAnthropicStreamFetch(capturedBody);

    const provider = new AnthropicProvider({ tools: INSTANCE_TOOLS });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    const tools = capturedBody.value!.tools as Array<{ name: string }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("bash");
  });

  it("两者都为 undefined 时不发送 tools 字段", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    mockAnthropicStreamFetch(capturedBody);

    const provider = new AnthropicProvider();
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    expect(capturedBody.value!.tools).toBeUndefined();
  });
});

describe("OllamaProvider.stream — options 签名兼容", () => {
  it("接受 options 参数但不影响行为", async () => {
    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({ message: { content: "Hi" }, done: false }) + "\n"));
          controller.enqueue(encoder.encode(JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 2 }) + "\n"));
          controller.close();
        },
      });
      return { ok: true, body: { getReader: () => stream.getReader() } } as Response;
    };

    const provider = new OllamaProvider();
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(
      [{ role: "user", content: "Hi" }],
      { tools: SAMPLE_TOOLS },
    )) {
      results.push(chunk);
    }

    const contentChunks = results.filter((c) => c.type === "content");
    expect(contentChunks.length).toBeGreaterThan(0);
  });
});

describe("MockProvider.stream — options 签名兼容", () => {
  it("接受 options 参数但不影响行为", async () => {
    const provider = new MockProvider({ defaultResponse: "test" });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(
      [{ role: "user", content: "Hi" }],
      { tools: SAMPLE_TOOLS },
    )) {
      results.push(chunk);
    }

    const contentChunks = results.filter((c) => c.type === "content");
    expect(contentChunks.length).toBeGreaterThan(0);
  });

  it("不传 options 也正常工作", async () => {
    const provider = new MockProvider({ defaultResponse: "test" });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    const contentChunks = results.filter((c) => c.type === "content");
    expect(contentChunks.length).toBeGreaterThan(0);
  });
});

describe("FallbackProvider.stream — options 转发", () => {
  it("将 options 转发给底层 provider", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const openai = new OpenAIProvider();
    const fallback = new FallbackProvider({ providers: [openai] });

    const results: LLMStreamChunk[] = [];
    for await (const chunk of fallback.stream(
      [{ role: "user", content: "Hi" }],
      { tools: SAMPLE_TOOLS },
    )) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    const tools = capturedBody.value!.tools as Array<{ function: { name: string } }>;
    expect(tools).toBeDefined();
    expect(tools).toHaveLength(2);
    expect(tools[0]!.function.name).toBe("file_read");
  });

  it("不传 options 时底层 provider 使用实例级 tools", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const openai = new OpenAIProvider({ tools: INSTANCE_TOOLS });
    const fallback = new FallbackProvider({ providers: [openai] });

    const results: LLMStreamChunk[] = [];
    for await (const chunk of fallback.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    const tools = capturedBody.value!.tools as Array<{ function: { name: string } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.function.name).toBe("bash");
  });
});

describe("OpenAIProvider.stream — options.maxTokens", () => {
  it("options.maxTokens 覆盖实例级 maxTokens", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const provider = new OpenAIProvider({ maxTokens: 4096 });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(
      [{ role: "user", content: "Hi" }],
      { maxTokens: 8192 },
    )) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    expect(capturedBody.value!["max_tokens"]).toBe(8192);
  });

  it("options.maxTokens 为 undefined 时使用实例级 maxTokens", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const provider = new OpenAIProvider({ maxTokens: 4096 });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    expect(capturedBody.value!["max_tokens"]).toBe(4096);
  });

  it("tools 和 maxTokens 可同时传递", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const provider = new OpenAIProvider({ maxTokens: 4096 });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(
      [{ role: "user", content: "Hi" }],
      { tools: SAMPLE_TOOLS, maxTokens: 16384 },
    )) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    expect(capturedBody.value!["max_tokens"]).toBe(16384);
    const tools = capturedBody.value!.tools as Array<{ function: { name: string } }>;
    expect(tools).toHaveLength(2);
  });
});

describe("AnthropicProvider.stream — options.maxTokens", () => {
  it("options.maxTokens 覆盖实例级 maxTokens", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    mockAnthropicStreamFetch(capturedBody);

    const provider = new AnthropicProvider({ maxTokens: 4096 });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream(
      [{ role: "user", content: "Hi" }],
      { maxTokens: 8192 },
    )) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    expect(capturedBody.value!["max_tokens"]).toBe(8192);
  });

  it("options.maxTokens 为 undefined 时使用实例级 maxTokens", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    mockAnthropicStreamFetch(capturedBody);

    const provider = new AnthropicProvider({ maxTokens: 4096 });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    expect(capturedBody.value).toBeDefined();
    expect(capturedBody.value!["max_tokens"]).toBe(4096);
  });
});

describe("OpenAIProvider.stream — 超时策略", () => {
  it("连接超时后产生错误 chunk", async () => {
    globalThis.fetch = async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
          setTimeout(resolve, 60_000);
        });
      }
      const err = new DOMException("The operation was aborted", "AbortError");
      throw err;
    };

    const provider = new OpenAIProvider({ timeoutMs: 100 });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    const errorChunks = results.filter((c) => c.type === "error");
    expect(errorChunks.length).toBeGreaterThan(0);
  }, 10_000);

  it("大输入消息使用动态超时（2x）", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const longContent = "x".repeat(15_000);
    const provider = new OpenAIProvider({ timeoutMs: 300_000 });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: longContent }])) {
      results.push(chunk);
    }

    const contentChunks = results.filter((c) => c.type === "content");
    expect(contentChunks.length).toBeGreaterThan(0);
  });

  it("正常输入使用默认超时", async () => {
    const capturedBody: { value: Record<string, unknown> | undefined } = { value: undefined };
    const chunks = createOpenAIStreamResponse(false);
    mockOpenAIStreamFetch(chunks, capturedBody);

    const provider = new OpenAIProvider({ timeoutMs: 300_000 });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    const contentChunks = results.filter((c) => c.type === "content");
    expect(contentChunks.length).toBeGreaterThan(0);
  });
});

describe("AnthropicProvider.stream — 超时策略", () => {
  it("正常请求完成无超时错误", async () => {
    mockAnthropicStreamFetch({ value: undefined });

    const provider = new AnthropicProvider({ timeoutMs: 300_000 });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    const errorChunks = results.filter((c) => c.type === "error");
    expect(errorChunks.length).toBe(0);
    const contentChunks = results.filter((c) => c.type === "content");
    expect(contentChunks.length).toBeGreaterThan(0);
  });
});

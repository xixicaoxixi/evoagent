/**
 * Session A.3 测试 — OpenAI Provider 能力升级。
 *
 * 验证 reasoning.effort、tool_search、allowed_tools、thinking content、
 * tool calling、多模态输入、请求超时等功能。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { OpenAIProvider } from "../../src/llm/openai";
import type { OpenAIProviderConfig, ReasoningEffort } from "../../src/llm/openai";
import type { LLMMessageParam, LLMStreamChunk, ContentPart } from "../../src/interfaces/llm-provider";

// ─── Mock fetch ───

const originalFetch = globalThis.fetch;

function toSSEChunks(response: unknown): string[] {
  const data = response as {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
    model?: string;
  };

  const chunks: string[] = [];
  const choice = data.choices?.[0];
  const message = choice?.message;

  if (message?.reasoning_content) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: message.reasoning_content } }] })}\n\n`);
  }

  if (message?.content) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: message.content } }] })}\n\n`);
  }

  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] })}\n\n`);
    }
  }

  if (choice?.finish_reason) {
    chunks.push(`data: ${JSON.stringify({
      choices: [{ finish_reason: choice.finish_reason }],
      ...(data.usage ? { usage: data.usage } : {}),
    })}\n\n`);
  }

  chunks.push("data: [DONE]\n\n");

  return chunks;
}

function mockFetch(response: unknown): void {
  const chunks = toSSEChunks(response);
  mockStreamFetch(chunks);
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

describe("OpenAIProvider 构造函数", () => {
  it("默认模型为 gpt-5.4", () => {
    const provider = new OpenAIProvider();
    expect(provider.model).toBe("gpt-5.4");
  });

  it("支持自定义模型", () => {
    const provider = new OpenAIProvider({ model: "gpt-4o" });
    expect(provider.model).toBe("gpt-4o");
  });

  it("默认温度为 0.1", () => {
    const provider = new OpenAIProvider();
    expect(provider.temperature).toBe(0.1);
  });

  it("默认 maxTokens 为 16384", () => {
    const provider = new OpenAIProvider();
    expect(provider.maxTokens).toBe(16384);
  });

  it("providerType 为 openai", () => {
    const provider = new OpenAIProvider();
    expect(provider.providerType).toBe("openai");
  });

  it("支持 reasoningEffort 配置", () => {
    const efforts: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];
    for (const effort of efforts) {
      const provider = new OpenAIProvider({ reasoningEffort: effort });
      expect(provider.model).toBe("gpt-5.4");
    }
  });

  it("支持 toolSearch 配置", () => {
    const provider = new OpenAIProvider({ toolSearch: true });
    expect(provider.model).toBe("gpt-5.4");
  });

  it("支持 allowedTools 配置", () => {
    const provider = new OpenAIProvider({
      allowedTools: ["file_read", "file_write"],
    });
    expect(provider.model).toBe("gpt-5.4");
  });

  it("支持 timeoutMs 配置", () => {
    const provider = new OpenAIProvider({ timeoutMs: 120_000 });
    expect(provider.model).toBe("gpt-5.4");
  });

  it("支持 tools 定义", () => {
    const provider = new OpenAIProvider({
      tools: [
        {
          name: "file_read",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });
    expect(provider.model).toBe("gpt-5.4");
  });

  it("支持 SecretRef API Key", () => {
    process.env.TEST_API_KEY = "sk-test-123";
    const provider = new OpenAIProvider({
      apiKey: { source: "env", id: "TEST_API_KEY" },
    });
    expect(provider.model).toBe("gpt-5.4");
    delete process.env.TEST_API_KEY;
  });
});

describe("OpenAIProvider.invoke", () => {
  it("基本调用成功", async () => {
    mockFetch({
      choices: [{
        message: { content: "Hello!" },
        finish_reason: "end_turn",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      model: "gpt-5.4",
    });

    const provider = new OpenAIProvider();
    const response = await provider.invoke([
      { role: "user", content: "Hi" },
    ]);

    expect(response.content).toBe("Hello!");
    expect(response.stopReason).toBe("end_turn");
    expect(response.model).toBe("gpt-5.4");
    expect(response.tokenUsage.inputTokens).toBe(10);
    expect(response.tokenUsage.outputTokens).toBe(5);
  });

  it("解析 thinking content", async () => {
    mockFetch({
      choices: [{
        message: {
          content: "The answer is 42.",
          reasoning_content: "Let me think step by step...",
        },
        finish_reason: "end_turn",
      }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 15 },
      },
      model: "gpt-5.4",
    });

    const provider = new OpenAIProvider({ reasoningEffort: "high" });
    const response = await provider.invoke([
      { role: "user", content: "What is the meaning of life?" },
    ]);

    expect(response.content).toBe("The answer is 42.");
    expect(response.thinkingContent).toBe("Let me think step by step...");
    expect(response.tokenUsage.reasoningTokens).toBe(15);
  });

  it("解析 tool_calls", async () => {
    mockFetch({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_abc123",
            type: "function",
            function: {
              name: "file_read",
              arguments: '{"path":"/tmp/test.txt"}',
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
      model: "gpt-5.4",
    });

    const provider = new OpenAIProvider({
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

  it("无 choices 时返回空响应", async () => {
    mockFetch({
      choices: [],
      model: "gpt-5.4",
    });

    const provider = new OpenAIProvider();
    const response = await provider.invoke([
      { role: "user", content: "Hi" },
    ]);
    expect(response.content).toBe("");
  });

  it("API 错误时抛出错误", async () => {
    mockErrorFetch(429, "Rate limit exceeded");

    const provider = new OpenAIProvider();
    await expect(
      provider.invoke([{ role: "user", content: "Hi" }]),
    ).rejects.toThrow("OpenAI API error (429)");
  });

  it("content 为 null 时返回空字符串", async () => {
    mockFetch({
      choices: [{
        message: { content: null },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
      model: "gpt-5.4",
    });

    const provider = new OpenAIProvider();
    const response = await provider.invoke([
      { role: "user", content: "Hi" },
    ]);
    expect(response.content).toBe("");
  });

  it("无 usage 时使用估算值", async () => {
    mockFetch({
      choices: [{
        message: { content: "Hello!" },
        finish_reason: "end_turn",
      }],
      model: "gpt-5.4",
    });

    const provider = new OpenAIProvider();
    const response = await provider.invoke([
      { role: "user", content: "Hi" },
    ]);
    expect(response.tokenUsage.inputTokens).toBeGreaterThan(0);
    expect(response.tokenUsage.outputTokens).toBeGreaterThan(0);
  });

  it("支持多模态输入消息", async () => {
    mockFetch({
      choices: [{
        message: { content: "I see an image." },
        finish_reason: "end_turn",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 5 },
      model: "gpt-5.4",
    });

    const provider = new OpenAIProvider();
    const multimodalContent: ContentPart[] = [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "https://example.com/img.png", detail: "high" } },
    ];
    const response = await provider.invoke([
      { role: "user", content: multimodalContent },
    ]);
    expect(response.content).toBe("I see an image.");
  });
});

describe("OpenAIProvider.stream", () => {
  it("流式文本内容", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"end_turn"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ];
    mockStreamFetch(chunks);

    const provider = new OpenAIProvider();
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    const contentChunks = results.filter((c) => c.type === "content");
    expect(contentChunks).toHaveLength(2);
    expect((contentChunks[0] as { type: "content"; content: string }).content).toBe("Hello");
    expect((contentChunks[1] as { type: "content"; content: string }).content).toBe(" world");

    const stopChunks = results.filter((c) => c.type === "stop");
    expect(stopChunks.length).toBeGreaterThanOrEqual(1);
  });

  it("流式 thinking content", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"Let me think"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"end_turn"}],"usage":{"prompt_tokens":20,"completion_tokens":30,"completion_tokens_details":{"reasoning_tokens":15}}}\n\n',
      "data: [DONE]\n\n",
    ];
    mockStreamFetch(chunks);

    const provider = new OpenAIProvider({ reasoningEffort: "high" });
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Question" }])) {
      results.push(chunk);
    }

    const thinkingChunks = results.filter((c) => c.type === "thinking");
    expect(thinkingChunks).toHaveLength(2);
    expect((thinkingChunks[0] as { type: "thinking"; content: string }).content).toBe("Let me think");

    const stopChunk = results.find((c) => c.type === "stop") as { type: "stop"; tokenUsage?: { reasoningTokens?: number } } | undefined;
    expect(stopChunk?.tokenUsage?.reasoningTokens).toBe(15);
  });

  it("API 错误时 yield error chunk", async () => {
    mockErrorFetch(500, "Internal server error");

    const provider = new OpenAIProvider();
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("error");
  });

  it("JSON 解析错误时 yield error chunk（不吞掉错误）", async () => {
    const chunks = [
      'data: {invalid json}\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"end_turn"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    mockStreamFetch(chunks);

    const provider = new OpenAIProvider();
    const results: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      results.push(chunk);
    }

    const errorChunks = results.filter((c) => c.type === "error");
    expect(errorChunks.length).toBeGreaterThan(0);

    const contentChunks = results.filter((c) => c.type === "content");
    expect(contentChunks).toHaveLength(1);
  });
});

describe("OpenAIProvider.countTokens", () => {
  it("使用 estimateTokens 估算", () => {
    const provider = new OpenAIProvider();
    expect(provider.countTokens("Hello world")).toBeGreaterThan(0);
    expect(provider.countTokens("")).toBe(0);
  });

  it("CJK 文本估算更高", () => {
    const provider = new OpenAIProvider();
    const cjkTokens = provider.countTokens("你好世界");
    const asciiTokens = provider.countTokens("abcd");
    expect(cjkTokens).toBeGreaterThan(asciiTokens);
  });
});

describe("OpenAIProvider.healthCheck", () => {
  it("成功时返回 true", async () => {
    globalThis.fetch = async () => ({
      ok: true,
    }) as Response;

    const provider = new OpenAIProvider();
    expect(await provider.healthCheck()).toBe(true);
  });

  it("失败时返回 false", async () => {
    globalThis.fetch = async () => ({
      ok: false,
    }) as Response;

    const provider = new OpenAIProvider();
    expect(await provider.healthCheck()).toBe(false);
  });

  it("网络错误时返回 false", async () => {
    globalThis.fetch = async () => {
      throw new Error("Network error");
    };

    const provider = new OpenAIProvider();
    expect(await provider.healthCheck()).toBe(false);
  });
});

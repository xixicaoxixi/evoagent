import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "../../src/llm/openai";

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
    };
    model?: string;
  };

  const chunks: string[] = [];
  const choice = data.choices?.[0];
  const message = choice?.message;

  if (message?.reasoning_content) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: message.reasoning_content } }] })}\n`);
  }

  if (message?.content) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: message.content } }] })}\n`);
  }

  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] })}\n`);
    }
  }

  if (choice?.finish_reason) {
    chunks.push(`data: ${JSON.stringify({
      choices: [{ finish_reason: choice.finish_reason }],
      ...(data.usage ? { usage: data.usage } : {}),
    })}\n`);
  }

  chunks.push("data: [DONE]\n");

  return chunks;
}

describe("provider smoke compatibility", () => {
  it("Kimi 非流式 smoke 使用 moonshot baseUrl 与 chat/completions", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(toSSEChunks({
        model: "kimi-k2.6",
        choices: [{
          message: {
            content: "pong",
            reasoning_content: "reasoning",
          },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 7,
        },
      }).join(""), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const provider = new OpenAIProvider({
        apiKey: "sk-kimi",
        model: "kimi-k2.6",
      });
      const result = await provider.invoke([{ role: "user", content: "reply only pong" }]);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://api.moonshot.cn/v1/chat/completions");
      expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-kimi");
      expect(result.content).toBe("pong");
      expect(result.thinkingContent).toBe("reasoning");
      expect(result.model).toBe("kimi-k2.6");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("DeepSeek 非流式 smoke 使用 deepseek baseUrl 与 chat/completions", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(toSSEChunks({
        model: "deepseek-v4-pro",
        choices: [{
          message: {
            content: "pong",
            reasoning_content: "analysis",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "echo",
                arguments: JSON.stringify({ value: "pong" }),
              },
            }],
          },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 6,
          completion_tokens: 8,
        },
      }).join(""), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const provider = new OpenAIProvider({
        apiKey: "sk-deepseek",
        model: "deepseek-v4-pro",
      });
      const result = await provider.invoke([{ role: "user", content: "reply only pong" }]);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://api.deepseek.com/chat/completions");
      expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-deepseek");
      expect(result.content).toBe("pong");
      expect(result.thinkingContent).toBe("analysis");
      expect(result.toolCalls).toEqual([
        {
          id: "call_1",
          name: "echo",
          input: { value: "pong" },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Kimi 流式 smoke 能解析 content 和 stop 事件", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response([
      'data: {"choices":[{"delta":{"content":"po"}}]}\n',
      'data: {"choices":[{"delta":{"content":"ng"}}]}\n',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n',
      "data: [DONE]\n",
    ].join(""), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })) as typeof fetch;

    try {
      const provider = new OpenAIProvider({
        apiKey: "sk-kimi",
        model: "kimi-k2.6",
      });
      const chunks = [];
      for await (const chunk of provider.stream([{ role: "user", content: "reply only pong" }])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { type: "content", content: "po" },
        { type: "content", content: "ng" },
        { type: "stop", tokenUsage: { inputTokens: 3, outputTokens: 2 } },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("DeepSeek 流式 smoke 能解析 reasoning_content 与 tool_calls", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"step"}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"echo","arguments":"{\\"value\\":\\"pong\\"}"}}]}}]}\n',
      'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n',
    ].join(""), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })) as typeof fetch;

    try {
      const provider = new OpenAIProvider({
        apiKey: "sk-deepseek",
        model: "deepseek-v4-pro",
      });
      const chunks = [];
      for await (const chunk of provider.stream([{ role: "user", content: "reply only pong" }])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { type: "thinking", content: "step" },
        { type: "content", content: "pong" },
        { type: "tool_use", toolUseId: "call_1", toolName: "echo", input: { value: "pong" } },
        { type: "stop", stopReason: "end_turn", tokenUsage: { inputTokens: 4, outputTokens: 1 } },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse, RouteEntry, StreamHttpResponse } from "../../src/server";
import { registerChatRoutes } from "../../src/server/routes/chat";

function createRequest(method: HttpRequest["method"], body: unknown): HttpRequest {
  return {
    method,
    url: "/api/v1/chat",
    body,
    params: {},
    query: new URLSearchParams(),
    headers: new Headers(),
    remoteAddress: "127.0.0.1",
    context: {},
  };
}

function findRoute(routes: readonly RouteEntry[], pattern: string, method: RouteEntry["method"]): RouteEntry {
  const route = routes.find((candidate) => candidate.pattern === pattern && candidate.method === method);
  expect(route).toBeDefined();
  return route as RouteEntry;
}

function assertJsonResponse(response: HttpResponse | StreamHttpResponse): HttpResponse {
  expect(response.body).not.toBeInstanceOf(ReadableStream);
  return response as HttpResponse;
}

async function readStreamBody(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

describe("chat observability", () => {
  it("POST /chat 返回 requestId 与 diagnostic", async () => {
    const routes = registerChatRoutes({
      getContext: () => ({
        provider: {
          providerType: "openai",
          model: "gpt-test",
          baseUrl: "https://api.example.com/v1",
        },
        chat: async () => ({
          response: "pong",
          terminal: { reason: "completed" },
          tokensUsed: { inputTokens: 3, outputTokens: 5 },
          agentCount: 1,
          evolutionTriggered: false,
          durationMs: 42,
          diagnostic: {
            requestId: "chat_ctx_1",
            phase: "context_chat",
            provider: {
              providerType: "openai",
              model: "gpt-test",
              baseUrl: "https://api.example.com/v1",
            },
            message: {
              length: 11,
              preview: "你好，请只回复 pong",
            },
            terminal: {
              reason: "completed",
              durationMs: 42,
              tokensUsed: { inputTokens: 3, outputTokens: 5 },
            },
          },
        }),
      }) as never,
      getEngine: () => null,
      createEngine: async () => null,
    });

    const route = findRoute(routes, "/chat", "POST");
    const response = assertJsonResponse(await route.handler(createRequest("POST", { message: "你好，请只回复 pong" })));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      requestId: expect.stringMatching(/^http_chat_/),
      content: "pong",
      reason: "completed",
      tokensUsed: { inputTokens: 3, outputTokens: 5 },
      durationMs: 42,
      diagnostic: {
        requestId: expect.stringMatching(/^http_chat_/),
        phase: "context_chat",
        provider: {
          providerType: "openai",
          model: "gpt-test",
          baseUrl: "https://api.example.com/v1",
        },
        terminal: {
          reason: "completed",
          durationMs: 42,
          tokensUsed: { inputTokens: 3, outputTokens: 5 },
        },
      },
    });
  });

  it("POST /chat 在缺少 message 时返回 request 级诊断", async () => {
    const routes = registerChatRoutes({
      getContext: () => undefined,
      getEngine: () => null,
      createEngine: async () => null,
    });

    const route = findRoute(routes, "/chat", "POST");
    const response = assertJsonResponse(await route.handler(createRequest("POST", {})));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: "Missing 'message' field",
      diagnostic: {
        requestId: expect.stringMatching(/^http_chat_/),
        phase: "http_chat",
        error: {
          category: "request",
          message: "Missing 'message' field",
        },
      },
    });
  });

  it("POST /chat 透传 provider 诊断与状态码", async () => {
    const routes = registerChatRoutes({
      getContext: () => ({
        provider: {
          providerType: "kimi",
          model: "kimi-k2.6",
          baseUrl: "https://api.moonshot.cn/v1",
        },
        chat: async () => {
          throw new Error(JSON.stringify({
            type: "provider_error",
            diagnostic: {
              category: "auth",
              message: "OpenAI API error (401): Invalid Authentication",
              statusCode: 401,
              retriable: false,
            },
          }));
        },
      }) as never,
      getEngine: () => null,
      createEngine: async () => null,
    });

    const route = findRoute(routes, "/chat", "POST");
    const response = assertJsonResponse(await route.handler(createRequest("POST", { message: "ping" })));

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: "OpenAI API error (401): Invalid Authentication",
      diagnostic: {
        phase: "http_chat",
        provider: {
          providerType: "kimi",
          model: "kimi-k2.6",
        },
        error: {
          category: "auth",
          message: "OpenAI API error (401): Invalid Authentication",
          statusCode: 401,
          retriable: false,
        },
      },
    });
  });

  it("POST /chat/stream 在 provider 错误时发送结构化 error 事件", async () => {
    const routes = registerChatRoutes({
      getContext: () => ({
        provider: {
          providerType: "deepseek",
          model: "deepseek-v4-pro",
          baseUrl: "https://api.deepseek.com",
        },
        getEngine: () => ({
          resetContext() {},
          async *submitMessage(): AsyncGenerator<unknown, { reason: string }, void> {
            throw new Error(JSON.stringify({
              type: "provider_error",
              diagnostic: {
                category: "auth",
                message: "OpenAI API error (401): Invalid Authentication",
                statusCode: 401,
                retriable: false,
              },
            }));
          },
        }),
      }) as never,
      getEngine: () => null,
      createEngine: async () => null,
    });

    const route = findRoute(routes, "/chat/stream", "POST");
    const response = await route.handler(createRequest("POST", { message: "ping" }));
    expect(response.body).toBeInstanceOf(ReadableStream);
    const payload = await readStreamBody((response as StreamHttpResponse).body as ReadableStream<Uint8Array>);

    expect(payload).toContain("event: error");
    expect(payload).toContain('"category":"auth"');
    expect(payload).toContain('"statusCode":401');
    expect(payload).toContain('"retriable":false');
    expect(payload).toContain('"message":"OpenAI API error (401): Invalid Authentication"');
  });
});

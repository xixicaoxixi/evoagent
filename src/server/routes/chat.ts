import type { RouteEntry, HttpRequest, HttpResponse, StreamHttpResponse } from "../../server";
import type { EvoAgentContext } from "../../integration/context";
import { createRequestId, createProviderSummary, type ChatDiagnosticSummary } from "../../observability/chat-diagnostics";
import type { StreamEvent } from "../../core/query/types";

export interface ChatRoutesDeps {
  readonly getContext: () => EvoAgentContext | null;
  readonly getEngine: () => { submitMessage(message: string): AsyncGenerator<StreamEvent, { reason: string }, void>; resetContext(): void } | null;
  readonly createEngine: (providerType: string, apiKey: string, model?: string) => Promise<unknown>;
}

interface RouteDiagnosticError {
  readonly category: NonNullable<ChatDiagnosticSummary["error"]>["category"];
  readonly message: string;
  readonly statusCode?: number;
  readonly retriable?: boolean;
}

function jsonResponse(body: unknown, status: number = 200): HttpResponse {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body,
  };
}

function errorResponse(message: string, status: number, diagnostic?: ChatDiagnosticSummary): HttpResponse {
  return jsonResponse({
    error: message,
    ...(diagnostic ? { diagnostic } : {}),
  }, status);
}

function parseRouteDiagnosticError(error: unknown): RouteDiagnosticError {
  const fallbackMessage = error instanceof Error ? error.message : String(error);

  try {
    const parsed = JSON.parse(fallbackMessage) as {
      readonly type?: string;
      readonly diagnostic?: {
        readonly category?: RouteDiagnosticError["category"];
        readonly message?: string;
        readonly statusCode?: number;
        readonly retriable?: boolean;
      };
    };

    if (parsed.type === "provider_error" && parsed.diagnostic) {
      return {
        category: parsed.diagnostic.category ?? "provider",
        message: parsed.diagnostic.message ?? fallbackMessage,
        ...(parsed.diagnostic.statusCode !== undefined ? { statusCode: parsed.diagnostic.statusCode } : {}),
        ...(parsed.diagnostic.retriable !== undefined ? { retriable: parsed.diagnostic.retriable } : {}),
      };
    }
  } catch {
  }

  return {
    category: "runtime",
    message: fallbackMessage,
  };
}

function getHttpStatusForDiagnostic(error: RouteDiagnosticError): number {
  if (error.statusCode !== undefined) {
    return error.statusCode;
  }

  switch (error.category) {
    case "auth":
      return 401;
    case "rate_limit":
      return 429;
    case "server":
      return 502;
    case "network":
      return 503;
    case "client":
      return 400;
    case "provider":
      return 502;
    case "request":
      return 400;
    default:
      return 500;
  }
}

export function registerChatRoutes(deps: ChatRoutesDeps): readonly RouteEntry[] {
  return [
    {
      method: "POST",
      pattern: "/chat",
      handler: async (req: HttpRequest): Promise<HttpResponse | StreamHttpResponse> => {
        const body = req.body as Record<string, unknown> | null;
        const requestId = createRequestId("http_chat");
        if (!body || typeof body.message !== "string") {
          return errorResponse("Missing 'message' field", 400, {
            requestId,
            phase: "http_chat",
            provider: createProviderSummary({ providerType: "unconfigured", model: "unconfigured" }),
            message: { length: 0, preview: "" },
            error: { category: "request", message: "Missing 'message' field" },
          });
        }

        const ctx = deps.getContext();
        if (!ctx) {
          return errorResponse("No LLM provider configured", 503, {
            requestId,
            phase: "http_chat",
            provider: createProviderSummary({ providerType: "unconfigured", model: "unconfigured" }),
            message: { length: body.message.length, preview: body.message.slice(0, 120) },
            error: { category: "provider", message: "No LLM provider configured" },
          });
        }

        try {
          const result = await ctx.chat(body.message as string);
          return jsonResponse({
            requestId,
            content: result.response,
            reason: result.terminal.reason,
            tokensUsed: result.tokensUsed,
            durationMs: result.durationMs,
            diagnostic: {
              ...result.diagnostic,
              requestId,
            },
          });
        } catch (err) {
          const parsedError = parseRouteDiagnosticError(err);
          return errorResponse(
            parsedError.message,
            getHttpStatusForDiagnostic(parsedError),
            {
              requestId,
              phase: "http_chat",
              provider: createProviderSummary({
                providerType: ctx.provider.providerType,
                model: ctx.provider.model,
              }),
              message: { length: body.message.length, preview: body.message.slice(0, 120) },
              error: parsedError,
            },
          );
        }
      },
    },
    {
      method: "POST",
      pattern: "/chat/stream",
      handler: async (req: HttpRequest): Promise<HttpResponse | StreamHttpResponse> => {
        const body = req.body as Record<string, unknown> | null;
        if (!body || typeof body.message !== "string") {
          return errorResponse("Missing 'message' field", 400, {
            requestId: createRequestId("http_chat_stream"),
            phase: "http_chat_stream",
            provider: createProviderSummary({ providerType: "unconfigured", model: "unconfigured" }),
            message: { length: 0, preview: "" },
            error: { category: "request", message: "Missing 'message' field" },
          });
        }

        const ctx = deps.getContext();
        if (!ctx) {
          return errorResponse("No LLM provider configured", 503, {
            requestId: createRequestId("http_chat_stream"),
            phase: "http_chat_stream",
            provider: createProviderSummary({ providerType: "unconfigured", model: "unconfigured" }),
            message: { length: body.message.length, preview: body.message.slice(0, 120) },
            error: { category: "provider", message: "No LLM provider configured" },
          });
        }

        return {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
          body: createChatStream(ctx, body.message as string),
        };
      },
    },
    {
      method: "POST",
      pattern: "/chat/complex",
      handler: async (req: HttpRequest): Promise<HttpResponse | StreamHttpResponse> => {
        const body = req.body as Record<string, unknown> | null;
        const requestId = createRequestId("http_chat_complex");
        if (!body || typeof body.message !== "string") {
          return errorResponse("Missing 'message' field", 400, {
            requestId,
            phase: "http_chat_complex",
            provider: createProviderSummary({ providerType: "unconfigured", model: "unconfigured" }),
            message: { length: 0, preview: "" },
            error: { category: "request", message: "Missing 'message' field" },
          });
        }

        const ctx = deps.getContext();
        if (!ctx) {
          return errorResponse("No LLM provider configured", 503, {
            requestId,
            phase: "http_chat_complex",
            provider: createProviderSummary({ providerType: "unconfigured", model: "unconfigured" }),
            message: { length: body.message.length, preview: body.message.slice(0, 120) },
            error: { category: "provider", message: "No LLM provider configured" },
          });
        }

        const subTasks = Array.isArray(body.sub_tasks)
          ? body.sub_tasks as string[]
          : [];

        try {
          const result = await ctx.chatComplex(body.message as string, subTasks);
          return {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: {
              requestId,
              content: result.response,
              reason: result.terminal.reason,
              agentCount: result.agentCount,
              evolutionTriggered: result.evolutionTriggered,
              durationMs: result.durationMs,
              diagnostic: {
                ...result.diagnostic,
                requestId,
              },
              planDiagnostics: result.planDiagnostics,
              plan: {
                planId: result.plan.planId,
                createdAt: result.plan.createdAt,
                totalTokenBudget: result.plan.totalTokenBudget,
                subTaskCount: result.plan.subTasks.length,
              },
            },
          };
        } catch (err) {
          const parsedError = parseRouteDiagnosticError(err);
          return errorResponse(
            parsedError.message,
            getHttpStatusForDiagnostic(parsedError),
            {
              requestId,
              phase: "http_chat_complex",
              provider: createProviderSummary({
                providerType: ctx.provider.providerType,
                model: ctx.provider.model,
              }),
              message: { length: body.message.length, preview: body.message.slice(0, 120) },
              error: parsedError,
            },
          );
        }
      },
    },
  ];
}

function createChatStream(ctx: EvoAgentContext, message: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const requestId = createRequestId("http_chat_stream");
  const diagnostic: ChatDiagnosticSummary = {
    requestId,
    phase: "http_chat_stream",
    provider: createProviderSummary({
      providerType: ctx.provider.providerType,
      model: ctx.provider.model,
    }),
    message: { length: message.length, preview: message.slice(0, 120) },
    stream: {
      events: 0,
      contentEvents: 0,
      toolStartEvents: 0,
      toolResultEvents: 0,
      turnEndEvents: 0,
    },
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendEvent = (event: string, data: unknown) => {
        const streamSummary = diagnostic.stream;
        if (streamSummary) {
          streamSummary.events += 1;
          if (event === "content") streamSummary.contentEvents += 1;
          if (event === "tool_start") streamSummary.toolStartEvents += 1;
          if (event === "tool_result") streamSummary.toolResultEvents += 1;
          if (event === "turn_end") streamSummary.turnEndEvents += 1;
        }
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      try {
        const engine = ctx.getEngine();
        engine.resetContext();
        const gen = engine.submitMessage(message);
        let result = await gen.next();
        let inputTokens = 0;
        let outputTokens = 0;
        const start = Date.now();

        while (!result.done) {
          const event = result.value as StreamEvent;

          switch (event.type) {
            case "content":
              sendEvent("content", { content: event.content });
              break;
            case "tool_start":
              sendEvent("tool_start", {
                toolName: event.toolName,
                toolUseId: event.toolUseId,
              });
              break;
            case "tool_result":
              sendEvent("tool_result", {
                toolUseId: event.toolUseId,
                content: event.content.slice(0, 500),
                isError: event.isError,
              });
              break;
            case "turn_end":
              if (event.tokenUsage) {
                inputTokens += event.tokenUsage.inputTokens;
                outputTokens += event.tokenUsage.outputTokens;
              }
              sendEvent("turn_end", {
                turnCount: event.turnCount,
                tokenUsage: event.tokenUsage,
              });
              break;
          }

          result = await gen.next();
        }

        const terminal = result.value;
        diagnostic.terminal = {
          reason: terminal.reason,
          durationMs: Date.now() - start,
          tokensUsed: { inputTokens, outputTokens },
        };
        sendEvent("done", {
          requestId,
          reason: terminal.reason,
          tokensUsed: { inputTokens, outputTokens },
          durationMs: diagnostic.terminal.durationMs,
          diagnostic,
        });
      } catch (err) {
        const parsedError = parseRouteDiagnosticError(err);
        diagnostic.error = parsedError;
        sendEvent("error", {
          requestId,
          message: parsedError.message,
          diagnostic,
        });
      } finally {
        controller.close();
      }
    },
  });
}

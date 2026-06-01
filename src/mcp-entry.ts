import { createMCPServer, type MCPServer } from "./mcp/server";
import { createLinkedTransportPair, StdioTransport, type JSONRPCMessage, type Transport } from "./mcp/transport";
import { createRequestLimiter, type RequestLimiter } from "./mcp/request-limiter";
import { createBuiltinTools, getBuiltinToolNames } from "./tools/builtin";
import { createMemoryReadFileState } from "./tools/file/write";
import { createProviderConfigStore, type ProviderConfigSnapshot } from "./core/provider-config";
import { bootstrapAutoDetectedProvider } from "./core/provider-bootstrap";
import { createServer, jsonResponse, type StreamHttpResponse } from "./server";
import type { EvoAgentServer, HttpRequest, RouteEntry } from "./server";
import { performDeepHealthCheck, type HealthCheckResult } from "./server/routes/health";
import type { PermissionRule } from "./tools/bash/permission";
import type { EvoAgentContext } from "./integration/context";
import { recordToolCall } from "./observability/progress";
import { detectToolCallText } from "./utils/tool-call-detector";
import { zodToJsonSchema, EMPTY_OBJECT_SCHEMA } from "./utils/zod-json-schema";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";

export type MCPTransportType = "stdio" | "http";

export interface MCPEntryConfig {
  readonly transport?: MCPTransportType;
  readonly port?: number;
  readonly hostname?: string;
  readonly providerType?: string;
  readonly externalHttp?: boolean;
}

export interface MCPArgs {
  readonly transport: MCPTransportType;
  readonly port: number;
  readonly hostname: string;
  readonly provider?: string | undefined;
}

export interface MCPToolManifest {
  readonly builtin: readonly string[];
  readonly providerScoped: readonly string[];
  readonly all: readonly string[];
}

export interface MCPEntryState {
  readonly transport: MCPTransportType;
  readonly running: boolean;
  readonly startTime?: number;
  readonly connections: number;
  readonly providerConfig: ProviderConfigSnapshot;
  readonly tools: MCPToolManifest;
  readonly endpoints: {
    readonly health?: string;
    readonly mcp?: string;
  };
}

export interface MCPEntry {
  start(): Promise<void>;
  stop(): Promise<void>;
  gracefulShutdown(timeoutMs?: number): Promise<void>;
  getState(): MCPEntryState;
  getProviderSnapshot(): ProviderConfigSnapshot;
  getToolManifest(): MCPToolManifest;
  getRoutes(): readonly RouteEntry[];
}

const PROVIDER_SCOPED_TOOL_NAMES = ["chat", "chat_complex", "task_status", "evolution_status", "observability_status", "community_status"] as const;

export interface SubTaskProgress {
  taskId: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string | undefined;
}

export interface ExecutionState {
  executionId: string;
  status: "in_progress" | "completed" | "failed" | "timed_out";
  startedAt: number;
  completedAt?: number;
  subTasks: SubTaskProgress[];
}

const EXECUTION_STATE_TTL_MS = 30 * 60 * 1000;
const EXECUTION_MAX_IN_PROGRESS_MS = 900_000;

export function createExecutionState(executionId: string, subTaskIds: readonly string[]): ExecutionState {
  return {
    executionId,
    status: "in_progress",
    startedAt: Date.now(),
    subTasks: subTaskIds.map((taskId) => ({
      taskId,
      status: "pending" as const,
    })),
  };
}

export function updateSubTaskProgress(
  state: ExecutionState,
  taskId: string,
  status: "started" | "completed" | "failed",
  details?: { result?: unknown; error?: string },
): ExecutionState {
  const now = Date.now();
  const subTasks = state.subTasks.map((st) => {
    if (st.taskId !== taskId) return st;
    switch (status) {
      case "started":
        return { ...st, status: "in_progress" as const, startedAt: now };
      case "completed":
        return { ...st, status: "completed" as const, completedAt: now, result: details?.result };
      case "failed":
        return { ...st, status: "failed" as const, completedAt: now, error: details?.error };
    }
  });

  const allDone = subTasks.every(
    (st) => st.status === "completed" || st.status === "failed",
  );

  return {
    ...state,
    subTasks,
    ...(allDone ? {
      status: subTasks.some((st) => st.status === "completed") ? "completed" : "failed",
      completedAt: now,
    } : {}),
  };
}

function createPlaceholderTransport(): Transport {
  const [clientTransport] = createLinkedTransportPair();
  return clientTransport;
}

function createAllowAllRules(): readonly PermissionRule[] {
  return [{ pattern: ".*", behavior: "allow" }];
}

function buildToolManifest(providerAvailable: boolean): MCPToolManifest {
  const builtin = getBuiltinToolNames();
  const providerScoped = providerAvailable ? [...PROVIDER_SCOPED_TOOL_NAMES] : [];
  return {
    builtin,
    providerScoped,
    all: [...builtin, ...providerScoped],
  };
}

async function readJsonBody(req: HttpRequest): Promise<JSONRPCMessage> {
  if (!req.body || typeof req.body !== "object") {
    const bodyType = req.body === null ? "null" : req.body === undefined ? "undefined" : typeof req.body;
    throw new Error(`Invalid JSON-RPC message body: expected object, got ${bodyType}`);
  }
  if ("_parseError" in req.body && typeof req.body._parseError === "string") {
    throw new Error(`Invalid JSON-RPC message body: ${req.body._parseError}`);
  }
  return req.body as JSONRPCMessage;
}

export function parseMCPArgs(argv: readonly string[]): MCPArgs {
  let transport: MCPTransportType = "stdio";
  let port = 3001;
  let hostname = "127.0.0.1";
  let provider: string | undefined;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--transport=")) {
      const value = arg.slice("--transport=".length);
      transport = value === "http" ? "http" : "stdio";
      continue;
    }
    if (arg.startsWith("--port=")) {
      const parsed = Number.parseInt(arg.slice("--port=".length), 10);
      if (Number.isFinite(parsed)) {
        port = parsed;
      }
      continue;
    }
    if (arg.startsWith("--host=")) {
      hostname = arg.slice("--host=".length) || hostname;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length).trim().toLowerCase() || undefined;
    }
  }

  return {
    transport,
    port,
    hostname,
    ...(provider !== undefined ? { provider } : {}),
  };
}

export function createMCPEntry(config: MCPEntryConfig = {}): MCPEntry {
  const transport = config.transport ?? "stdio";
  const port = config.port ?? 3001;
  const hostname = config.hostname ?? "127.0.0.1";
  const baseUrl = `http://${hostname}:${port}`;

  const configStore = createProviderConfigStore();
  let server: MCPServer | undefined;
  let httpServer: EvoAgentServer | undefined;
  let running = false;
  let startTime: number | undefined;
  let connections = 0;
  let toolManifest = buildToolManifest(false);
  const activeOperations = new Set<Promise<unknown>>();
  let shuttingDown = false;
  const chatLimiter = createRequestLimiter(3);
  const complexLimiter = createRequestLimiter(2);
  const executionStates = new Map<string, ExecutionState>();

  const sessionContext = new AsyncLocalStorage<string | undefined>();

  interface SessionOps {
    ops: Set<Promise<unknown>>;
    controllers: Set<AbortController>;
  }
  const sessionActiveOps = new Map<string, SessionOps>();

  function getSessionOps(sid: string): SessionOps {
    let ops = sessionActiveOps.get(sid);
    if (!ops) {
      ops = { ops: new Set(), controllers: new Set() };
      sessionActiveOps.set(sid, ops);
    }
    return ops;
  }

  const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };

  interface SessionState {
    lastActivity: number;
  }

  const sessions = new Map<string, SessionState>();
  const SESSION_TIMEOUT_MS = 1_800_000;
  const MAX_SESSIONS = 100;

  function isSessionValid(sid: string): boolean {
    const state = sessions.get(sid);
    if (!state) return false;
    return Date.now() - state.lastActivity <= SESSION_TIMEOUT_MS;
  }

  function touchSession(sid: string): void {
    const state = sessions.get(sid);
    if (state) state.lastActivity = Date.now();
  }

  function clearSession(sid: string): void {
    sessions.delete(sid);
    const ops = sessionActiveOps.get(sid);
    if (ops) {
      for (const controller of ops.controllers) {
        controller.abort();
      }
      ops.ops.clear();
      ops.controllers.clear();
      sessionActiveOps.delete(sid);
    }
  }

  function clearAllSessions(): void {
    for (const [, ops] of sessionActiveOps) {
      for (const controller of ops.controllers) {
        controller.abort();
      }
      ops.ops.clear();
      ops.controllers.clear();
    }
    sessionActiveOps.clear();
    sessions.clear();
  }

  function pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [sid, state] of sessions) {
      if (now - state.lastActivity > SESSION_TIMEOUT_MS) {
        sessions.delete(sid);
        const ops = sessionActiveOps.get(sid);
        if (ops) {
          for (const controller of ops.controllers) {
            controller.abort();
          }
          ops.ops.clear();
          ops.controllers.clear();
          sessionActiveOps.delete(sid);
        }
      }
    }
  }

  function generateSessionId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  const sessionPruneTimer = setInterval(pruneExpiredSessions, 5 * 60 * 1000);
  sessionPruneTimer.unref();

  const executionCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, state] of executionStates) {
      if (state.completedAt && now - state.completedAt > EXECUTION_STATE_TTL_MS) {
        executionStates.delete(id);
      } else if (!state.completedAt && now - state.startedAt > EXECUTION_STATE_TTL_MS * 2) {
        executionStates.set(id, { ...state, status: "timed_out", completedAt: now });
      }
    }
  }, 5 * 60 * 1000);
  executionCleanupTimer.unref();

  function isInitializeRequest(msg: JSONRPCMessage): boolean {
    return msg.method === "initialize" && msg.id !== undefined;
  }

  function isNotificationOrResponse(msg: JSONRPCMessage): boolean {
    return msg.id === undefined || msg.method === undefined;
  }

  function hasRequests(msg: JSONRPCMessage): boolean {
    if (Array.isArray(msg)) {
      return (msg as readonly JSONRPCMessage[]).some((m) => m.id !== undefined && m.method !== undefined);
    }
    return msg.id !== undefined && msg.method !== undefined;
  }

  function sseResponse(data: string, activeSessionId?: string): StreamHttpResponse {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        controller.close();
      },
    });
    return {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        ...(activeSessionId !== undefined ? { "Mcp-Session-Id": activeSessionId } : {}),
      },
      body: stream,
    };
  }

  function corsJsonResponse(data: unknown, status: number = 200, activeSessionId?: string) {
    return jsonResponse(data, status, {
      ...CORS_HEADERS,
      ...(activeSessionId !== undefined ? { "Mcp-Session-Id": activeSessionId } : {}),
    });
  }

  const routes: RouteEntry[] = [
    {
      method: "GET",
      pattern: "/health",
      handler: async () => {
        const ctx = configStore.getContext();
        if (!ctx || !startTime) {
          return jsonResponse({
            status: "degraded",
            checks: {
              ruleStore: { status: "unhealthy", detail: "No EvoAgentContext available" },
              knowledgeManager: { status: "unhealthy", detail: "No EvoAgentContext available" },
              llmProvider: { status: "unhealthy", detail: "No EvoAgentContext available" },
            },
            uptime: 0,
            timestamp: Date.now(),
            transport,
            running,
            tools: toolManifest,
          } satisfies HealthCheckResult & { readonly transport: string; readonly running: boolean; readonly tools: MCPToolManifest }, 503);
        }

        const result = await performDeepHealthCheck(ctx, startTime);
        const httpStatus = result.status === "ok" ? 200 : result.status === "degraded" ? 200 : 503;
        return jsonResponse({
          ...result,
          transport,
          running,
          tools: toolManifest,
        }, httpStatus);
      },
    },
    {
      method: "OPTIONS",
      pattern: "/mcp",
      handler: async () => {
        return {
          status: 204,
          headers: CORS_HEADERS,
          body: "",
        };
      },
    },
    {
      method: "GET",
      pattern: "/mcp",
      handler: async (req) => {
        const accept = req.headers.get("accept") ?? "";
        if (!accept.includes("text/event-stream")) {
          return corsJsonResponse({ error: "Method Not Allowed" }, 405);
        }
        return corsJsonResponse({ error: "Method Not Allowed" }, 405);
      },
    },
    {
      method: "DELETE",
      pattern: "/mcp",
      handler: async (req) => {
        const clientSessionId = req.headers.get("mcp-session-id");
        if (!clientSessionId) {
          return corsJsonResponse({ error: "Mcp-Session-Id header required for DELETE" }, 400);
        }
        clearSession(clientSessionId);
        return corsJsonResponse({}, 200);
      },
    },
    {
      method: "POST",
      pattern: "/mcp",
      handler: async (req) => {
        if (!server) {
          return corsJsonResponse({ error: "MCP server is not running" }, 503);
        }

        const clientSessionId = req.headers.get("mcp-session-id");
        const body = await readJsonBody(req);

        let activeSessionId: string | undefined;

        if (isInitializeRequest(body)) {
          if (sessions.size >= MAX_SESSIONS) {
            pruneExpiredSessions();
            if (sessions.size >= MAX_SESSIONS) {
              return corsJsonResponse(
                { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Too many active sessions" } },
                503,
              );
            }
          }
          const newSid = generateSessionId();
          sessions.set(newSid, { lastActivity: Date.now() });
          activeSessionId = newSid;
        } else if (clientSessionId) {
          if (!isSessionValid(clientSessionId)) {
            return corsJsonResponse(
              { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session expired or invalid. Please re-initialize." } },
              408,
            );
          }
          touchSession(clientSessionId);
          activeSessionId = clientSessionId;
        }

        const response = await sessionContext.run(activeSessionId, () => server!.handleMessage(body));

        if (isNotificationOrResponse(body) && !hasRequests(body)) {
          return { status: 202, headers: CORS_HEADERS, body: "" };
        }

        const accept = req.headers.get("accept") ?? "";
        const preferSse = accept.includes("text/event-stream");

        const responseBody = response ?? { jsonrpc: "2.0", id: (body as JSONRPCMessage).id ?? null, result: {} };

        if (preferSse) {
          return sseResponse(JSON.stringify(responseBody), activeSessionId);
        }

        return corsJsonResponse(responseBody, 200, activeSessionId);
      },
    },
  ];

  async function startHttpTransport(): Promise<void> {
    const entryServer = createServer({
      port,
      hostname,
      prefix: "",
    });
    for (const route of routes) {
      entryServer.registerRoute(route);
    }
    await entryServer.start();
    httpServer = entryServer;
  }

  return {
    async start(): Promise<void> {
      if (running) {
        return;
      }

      await bootstrapAutoDetectedProvider(configStore, {
        sourceDetail: "Auto-detected from environment variables during MCP startup.",
        ...(config.providerType !== undefined ? { providerType: config.providerType } : {}),
      });

      const tools = createBuiltinTools({
        bashPermissionContext: {
          sandboxed: true,
          rules: createAllowAllRules(),
        },
        readFileState: createMemoryReadFileState(),
      });
      const mcpServer = createMCPServer({
        serverName: `evoagent-mcp-${transport}`,
        serverVersion: transport === "http" ? `${hostname}:${port}` : "stdio",
      });

      mcpServer.connect(transport === "stdio" ? new StdioTransport() : createPlaceholderTransport());

      const ctx = configStore.getContext();
      registerBuiltinTools(mcpServer, tools, ctx);

      if (ctx) {
        registerChatTools(mcpServer, ctx, activeOperations, sessionActiveOps, sessionContext, chatLimiter, complexLimiter, executionStates);
        registerEvolutionTools(mcpServer, ctx);
        registerObservabilityTools(mcpServer, ctx);
        registerCommunicationTools(mcpServer, ctx);
      }

      registerBuiltinResources(mcpServer, configStore, () => ({
        transport,
        running,
        ...(startTime !== undefined ? { startTime } : {}),
        connections,
        tools: toolManifest,
      }));

      toolManifest = buildToolManifest(ctx !== undefined);
      server = mcpServer;
      if (transport === "http" && !config.externalHttp) {
        await startHttpTransport();
      }
      running = true;
      startTime = Date.now();
      connections = 0;
    },

    async stop(): Promise<void> {
      if (!running || !server) {
        return;
      }

      shuttingDown = true;

      if (activeOperations.size > 0) {
        await Promise.race([
          Promise.allSettled([...activeOperations]),
          new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
        ]);
      }

      const ctx = configStore.getContext();
      if (ctx) {
        try {
          await ctx.gracefulShutdown(10_000);
        } catch (err) {
          console.warn(`[MCP-ENTRY] Graceful shutdown error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (httpServer) {
        await httpServer.stop();
        httpServer = undefined;
      }
      server.disconnect();
      running = false;
      shuttingDown = false;
      server = undefined;
      startTime = undefined;
      connections = 0;
      clearAllSessions();
      clearInterval(sessionPruneTimer);
      clearInterval(executionCleanupTimer);
      toolManifest = buildToolManifest(configStore.getContext() !== undefined);
    },

    async gracefulShutdown(timeoutMs: number = 30_000): Promise<void> {
      await this.stop();
    },

    getState(): MCPEntryState {
      return {
        transport,
        running,
        ...(startTime !== undefined ? { startTime } : {}),
        connections,
        providerConfig: configStore.getSnapshot(),
        tools: toolManifest,
        endpoints: transport === "http"
          ? {
              health: `${baseUrl}/health`,
              mcp: `${baseUrl}/mcp`,
            }
          : {
              health: `${baseUrl}/health`,
            },
      };
    },

    getProviderSnapshot(): ProviderConfigSnapshot {
      return configStore.getSnapshot();
    },

    getToolManifest(): MCPToolManifest {
      return toolManifest;
    },

    getRoutes(): readonly RouteEntry[] {
      return routes;
    },
  };
}

const CONNECTION_ERROR_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /EPIPE/i,
  /ETIMEDOUT/i,
  /socket\s*hang\s*up/i,
  /connection\s*(error|reset|refused|closed|lost)/i,
  /MCP.*connection/i,
  /Cannot read file/i,
  /read\s*ECONN/i,
];

function isConnectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return CONNECTION_ERROR_PATTERNS.some((p) => p.test(message));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 2,
  baseDelayMs: number = 500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !isConnectionError(err)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export function registerBuiltinTools(mcpServer: MCPServer, tools: ReturnType<typeof createBuiltinTools>, ctx?: EvoAgentContext): void {
  for (const tool of tools) {
    mcpServer.registerTool(
      {
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.inputSchema),
      },
      async (args) => {
        const parsed = tool.inputSchema.safeParse(args);
        if (!parsed.success) {
          return {
            content: [{ type: "text" as const, text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }],
            isError: true,
          };
        }
        try {
          const result = await withRetry(() =>
            tool.call(
              parsed.data,
              {
                cwd: process.cwd(),
                getAppState: () => ({}),
              },
              () => true,
            ),
          );
          if (ctx && !result.isError) {
            recordToolCall(ctx.getProgressTracker(), tool.name, parsed.data as Record<string, unknown>);
          }
          return result;
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    );
  }
}

const ChatInputSchema = z.object({
  message: z.string().min(1, "Message is required"),
  timeout: z.number().int().min(1000).max(1_800_000).optional(),
  maxTokens: z.number().int().min(1).max(128_000).optional(),
});

const SubTaskSchema = z.union([
  z.string(),
  z.object({ task: z.string(), description: z.string().optional() }),
]);

const ChatComplexInputSchema = z.object({
  message: z.string().min(1, "Message is required"),
  sub_tasks: z.array(SubTaskSchema).optional(),
  timeout: z.number().int().min(30_000).max(3_600_000).optional(),
});

export function registerChatTools(
  mcpServer: MCPServer,
  ctx: EvoAgentContext,
  activeOps: Set<Promise<unknown>>,
  sessionActiveOps: Map<string, { ops: Set<Promise<unknown>>; controllers: Set<AbortController> }>,
  sessionContext: AsyncLocalStorage<string | undefined>,
  chatLimiter: RequestLimiter,
  complexLimiter: RequestLimiter,
  executionStates: Map<string, ExecutionState>,
): void {
  mcpServer.registerTool(
    {
      name: "chat",
      description: "Chat with the configured LLM provider using the EvoAgent query engine. This is a simple single-turn chat interface. For tasks requiring tool execution, multi-step reasoning, or sub-agent orchestration, use chat_complex instead.",
      inputSchema: zodToJsonSchema(ChatInputSchema),
    },
    async (args) => {
      const parsed = ChatInputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text" as const, text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }],
          isError: true,
        };
      }
      const { message, timeout, maxTokens } = parsed.data;

      const release = chatLimiter.tryAcquire();
      if (!release) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Server busy: too many concurrent LLM requests", retryAfterMs: 5000, hint: "Wait a moment and retry, or reduce concurrent requests" }) }],
          isError: true,
        };
      }

      const chatTimeoutMs = timeout ?? 600_000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), chatTimeoutMs);

      const sid = sessionContext.getStore();
      if (sid) {
        const sessionOps = sessionActiveOps.get(sid);
        if (sessionOps) sessionOps.controllers.add(controller);
      }

      const chatMessage = message;
      const op = withRetry(() => ctx.chat(chatMessage, controller.signal, maxTokens != null ? { maxTokens } : undefined));
      activeOps.add(op);
      if (sid) {
        const sessionOps = sessionActiveOps.get(sid);
        if (sessionOps) sessionOps.ops.add(op);
      }
      try {
        const result = await op;
        clearTimeout(timeoutId);
        const toolCallHint = detectToolCallText(result.response)
          ? "\n\n[Hint: The response contains tool-call-like text that was NOT actually executed. For actual tool execution, use the chat_complex tool instead.]"
          : "";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            response: result.response,
            reason: result.terminal.reason,
            tokensUsed: result.tokensUsed,
            durationMs: result.durationMs,
            ...(result.partial ? { partial: true, partialReason: result.partialReason } : {}),
            ...(toolCallHint ? { hint: toolCallHint.trim() } : {}),
          }) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      } finally {
        release();
        clearTimeout(timeoutId);
        activeOps.delete(op);
        if (sid) {
          const sessionOps = sessionActiveOps.get(sid);
          if (sessionOps) {
            sessionOps.ops.delete(op);
            sessionOps.controllers.delete(controller);
          }
        }
      }
    },
  );

  mcpServer.registerTool(
    {
      name: "chat_complex",
      description: "Run a complex multi-turn chat request with the configured LLM provider. sub_tasks accepts either strings or objects with { task: string, description?: string }.",
      inputSchema: zodToJsonSchema(ChatComplexInputSchema),
    },
    async (args) => {
      const parsed = ChatComplexInputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text" as const, text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }],
          isError: true,
        };
      }
      const { message, sub_tasks, timeout } = parsed.data;

      const release = complexLimiter.tryAcquire();
      if (!release) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Server busy: too many concurrent LLM requests", retryAfterMs: 5000, hint: "Wait a moment and retry, or reduce concurrent requests" }) }],
          isError: true,
        };
      }

      const complexTimeoutMs = timeout ?? 900_000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), complexTimeoutMs);

      const sid = sessionContext.getStore();
      if (sid) {
        const sessionOps = sessionActiveOps.get(sid);
        if (sessionOps) sessionOps.controllers.add(controller);
      }

      const subTaskStrings = sub_tasks !== undefined && sub_tasks.length > 0
        ? sub_tasks.map((st) => typeof st === "string" ? st : st.description ?? st.task)
        : [];

      const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const subTaskIds = subTaskStrings.length > 0
        ? subTaskStrings.map((_, i) => `task_${String(i + 1).padStart(3, "0")}`)
        : [];
      const initialExecState = createExecutionState(executionId, subTaskIds);
      executionStates.set(executionId, initialExecState);

      const onProgress: import("./core/agent/orchestrator").SubTaskProgressCallback = (taskId, status, details) => {
        const current = executionStates.get(executionId);
        if (!current) return;
        executionStates.set(executionId, updateSubTaskProgress(current, taskId, status, details));
      };

      const op = withRetry(() => ctx.chatComplex(message, subTaskStrings, controller.signal, onProgress));
      activeOps.add(op);
      if (sid) {
        const sessionOps = sessionActiveOps.get(sid);
        if (sessionOps) sessionOps.ops.add(op);
      }
      try {
        const result = await Promise.race([
          op,
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () =>
              reject(new Error(`chat_complex timed out after ${complexTimeoutMs}ms`)),
            );
          }),
        ]);
        clearTimeout(timeoutId);

        const current = executionStates.get(executionId);
        if (current) {
          const allDone = current.subTasks.every(
            (st) => st.status === "completed" || st.status === "failed",
          );
          executionStates.set(executionId, {
            ...current,
            status: allDone
              ? (current.subTasks.length === 0 || current.subTasks.some((st) => st.status === "completed") ? "completed" : "failed")
              : "completed",
            completedAt: Date.now(),
          });
        }

        const agentDiagnostics = result.agentStates.map((s) => ({
          agentId: s.agentId,
          taskId: s.taskId,
          status: s.status,
          outputTokens: s.tokenUsage.outputTokens,
          ...(s.error ? { errorReason: s.error.reason, errorDetails: s.error.details } : {}),
          ...(s.toolCallSummary ? { toolCallSummary: s.toolCallSummary } : {}),
        }));
        let effectiveResponse = result.response;
        if (!effectiveResponse || effectiveResponse.trim().length === 0 || /^\[Calling \d+ tool\(s\)\]$/.test(effectiveResponse.trim())) {
          const fallbackParts: string[] = [];
          for (const s of result.agentStates) {
            if (s.status !== "completed") continue;
            if (s.result !== null && s.result !== undefined) {
              const resultText = typeof s.result === "string" ? s.result : JSON.stringify(s.result);
              if (resultText.trim().length > 0 && !/^\[Calling \d+ tool\(s\)\]$/.test(resultText.trim())) {
                fallbackParts.push(resultText);
                continue;
              }
            }
            if (s.toolCallSummary) {
              fallbackParts.push(`[Tool calls: ${s.toolCallSummary}]`);
            }
          }
          if (fallbackParts.length > 0) {
            effectiveResponse = fallbackParts.join("\n\n");
          }
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            executionId,
            response: effectiveResponse,
            terminal: result.terminal,
            plan: {
              planId: result.plan.planId,
              createdAt: result.plan.createdAt,
              totalTokenBudget: result.plan.totalTokenBudget,
              subTaskCount: result.plan.subTasks.length,
            },
            planDiagnostics: result.planDiagnostics,
            tokensUsed: result.tokensUsed,
            durationMs: result.durationMs,
            agentCount: result.agentCount,
            successCount: result.successCount,
            agentStates: result.agentStates,
            agentDiagnostics,
            evolutionTriggered: result.evolutionTriggered,
          }) }],
        };
      } catch (err) {
        const current = executionStates.get(executionId);
        if (current) {
          executionStates.set(executionId, {
            ...current,
            status: err instanceof Error && err.message.includes("timed out") ? "timed_out" : "failed",
            completedAt: Date.now(),
          });
        }
        return {
          content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      } finally {
        release();
        clearTimeout(timeoutId);
        activeOps.delete(op);

        const finalState = executionStates.get(executionId);
        if (finalState && finalState.status === "in_progress") {
          executionStates.set(executionId, {
            ...finalState,
            status: "failed",
            completedAt: Date.now(),
          });
        }

        if (sid) {
          const sessionOps = sessionActiveOps.get(sid);
          if (sessionOps) {
            sessionOps.ops.delete(op);
            sessionOps.controllers.delete(controller);
          }
        }
      }
    },
  );

  mcpServer.registerTool(
    {
      name: "task_status",
      description: "Query the current execution status of a chat_complex request by its execution_id.",
      inputSchema: zodToJsonSchema(z.object({
        execution_id: z.string().describe("The execution_id returned by a chat_complex call"),
      })),
    },
    async (args: unknown) => {
      const argsMap = args as Record<string, unknown> | null | undefined;
      const execId = argsMap?.["execution_id"];
      if (typeof execId !== "string" || execId.length === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "execution_id is required" }) }],
          isError: true,
        };
      }

      const state = executionStates.get(execId);
      if (!state) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Execution ${execId} not found` }) }],
          isError: true,
        };
      }

      const now = Date.now();

      if (state.status === "in_progress" && now - state.startedAt > EXECUTION_MAX_IN_PROGRESS_MS) {
        const expired = { ...state, status: "timed_out" as const, completedAt: now };
        executionStates.set(execId, expired);
        return { content: [{ type: "text" as const, text: JSON.stringify(expired) }] };
      }

      if (state.completedAt && now - state.completedAt > EXECUTION_STATE_TTL_MS) {
        const expiredInfo = {
          executionId: execId,
          status: "expired",
          reason: "Execution state expired after TTL",
          originalStatus: state.status,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
        };
        executionStates.delete(execId);
        return { content: [{ type: "text" as const, text: JSON.stringify(expiredInfo) }] };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(state) }],
      };
    },
  );

  const now = Date.now();
  for (const [key, state] of executionStates) {
    if (state.completedAt && now - state.completedAt > EXECUTION_STATE_TTL_MS) {
      executionStates.delete(key);
    }
  }
}

export function registerEvolutionTools(mcpServer: MCPServer, ctx: EvoAgentContext): void {
  mcpServer.registerTool(
    {
      name: "evolution_status",
      description: "Get the current evolution status for the agent runtime.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
    },
    async () => {
      const rules = await ctx.getRuleStore().getAll();
      const data = {
        ...ctx.getEvolutionState(),
        activeRules: rules.filter((rule) => String((rule as { readonly status?: unknown }).status).toUpperCase() === "ACTIVE"),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    },
  );
}

export function registerObservabilityTools(mcpServer: MCPServer, ctx: EvoAgentContext): void {
  mcpServer.registerTool(
    {
      name: "observability_status",
      description: "Get runtime observability metrics and health summary.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
    },
    async () => {
      const statsStore = ctx.getStatsStore();
      const costTracker = ctx.getCostTracker();
      const data = {
        progress: ctx.getProgress(),
        totalCost: costTracker.getTotalCost(),
        metrics: statsStore.getAll(),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    },
  );
}

export function registerCommunicationTools(mcpServer: MCPServer, ctx: EvoAgentContext): void {
  mcpServer.registerTool(
    {
      name: "community_status",
      description: "Get communication and community integration status.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
    },
    async () => {
      const community = ctx.getCommunity() as { readonly getProposalStats?: () => unknown; readonly getOpenProposals?: () => unknown };
      let data: unknown;
      if (typeof community.getProposalStats === "function") {
        data = community.getProposalStats();
      } else {
        data = {
          proposals: typeof community.getOpenProposals === "function" ? community.getOpenProposals() : [],
          analytics: ctx.getAnalytics().getSummary(),
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    },
  );
}

interface ResourceStatusSnapshot {
  readonly transport: MCPTransportType;
  readonly running: boolean;
  readonly startTime?: number;
  readonly connections: number;
  readonly tools: MCPToolManifest;
}

export function registerBuiltinResources(
  mcpServer: MCPServer,
  configStore: ReturnType<typeof createProviderConfigStore>,
  getStatus: () => ResourceStatusSnapshot,
): void {
  mcpServer.registerResource(
    {
      uri: "evoagent://config",
      name: "EvoAgent Configuration",
      description: "Current provider configuration and model settings",
      mimeType: "application/json",
    },
    async () => {
      const snapshot = configStore.getSnapshot();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(snapshot, null, 2) }],
      };
    },
  );

  mcpServer.registerResource(
    {
      uri: "evoagent://status",
      name: "EvoAgent Status",
      description: "Current runtime status including transport, uptime, and tool manifest",
      mimeType: "application/json",
    },
    async () => {
      const status = getStatus();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
      };
    },
  );
}

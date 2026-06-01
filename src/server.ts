/**
 * EvoAgent HTTP 服务器 — 基于 Bun 原生 HTTP 的轻量级 API 服务器。
 *
 * 设计原则：
 * - 零外部依赖（使用 Bun 原生 HTTP，不引入 Fastify/Express）
 * - 中间件管线（洋葱模型）
 * - 路由注册表（前缀树匹配）
 * - 统一错误处理 + 请求日志
 * - 优雅关闭（graceful shutdown）
 *
 * 参考 SYSTEM_DESIGN 第 7 节 API 定义。
 */

// ─── HTTP 工具类型 ───

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly remoteAddress: string;
  /** 请求上下文（认证信息等，由中间件注入） */
  readonly context: Record<string, unknown>;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface StreamHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: ReadableStream<Uint8Array>;
}

export function isStreamResponse(response: HttpResponse | StreamHttpResponse): response is StreamHttpResponse {
  return response.body instanceof ReadableStream;
}

export interface RouteHandler {
  (req: HttpRequest): HttpResponse | StreamHttpResponse | Promise<HttpResponse | StreamHttpResponse>;
}

export interface Middleware {
  (req: HttpRequest, next: () => HttpResponse | StreamHttpResponse | Promise<HttpResponse | StreamHttpResponse>): HttpResponse | StreamHttpResponse | Promise<HttpResponse | StreamHttpResponse>;
}

export interface RouteEntry {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly handler: RouteHandler;
  /** 是否需要认证（默认 false） */
  readonly auth?: boolean;
}

// ─── 服务器配置 ───

export interface ServerConfig {
  /** 监听端口 */
  readonly port?: number;
  /** 监听主机 */
  readonly hostname?: string;
  /** API 前缀（默认 /api/v1） */
  readonly prefix?: string;
  /** 请求超时（毫秒，默认 30000） */
  readonly requestTimeoutMs?: number;
  /** 最大请求体大小（字节，默认 1MB） */
  readonly maxBodySize?: number;
}

// ─── 服务器统计 ───

export interface ServerStats {
  readonly totalRequests: number;
  readonly activeConnections: number;
  readonly errors: number;
  readonly startTime: number;
}

// ─── 服务器接口 ───

export interface EvoAgentServer {
  /** 注册路由 */
  registerRoute(route: RouteEntry): void;
  /** 注册中间件（按注册顺序执行） */
  use(middleware: Middleware): void;
  /** 启动服务器 */
  start(): Promise<void>;
  /** 停止服务器 */
  stop(): Promise<void>;
  /** 获取统计 */
  getStats(): ServerStats;
  /** 获取配置 */
  getConfig(): Readonly<ServerConfig>;
}

// ─── 路径匹配 ───

interface PathSegment {
  readonly type: "literal" | "param";
  readonly value: string;
}

function parsePathPattern(pattern: string): PathSegment[] {
  return pattern.split("/").filter(Boolean).map((seg) => {
    if (seg.startsWith(":")) {
      return { type: "param", value: seg.slice(1) };
    }
    return { type: "literal", value: seg };
  });
}

function matchPath(requestPath: string, patternSegments: PathSegment[]): Record<string, string> | null {
  const reqSegments = requestPath.split("/").filter(Boolean);

  if (reqSegments.length !== patternSegments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const seg = patternSegments[i]!;
    const req = reqSegments[i]!;
    if (seg.type === "literal") {
      if (seg.value !== req) return null;
    } else {
      params[seg.value] = req;
    }
  }
  return params;
}

// ─── 响应构建器 ───

export function jsonResponse(data: unknown, status: number = 200, extraHeaders?: Record<string, string>): HttpResponse {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
    body: data,
  };
}

export function errorResponse(message: string, status: number = 500): HttpResponse {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: { error: message, status },
  };
}

export function notFoundResponse(): HttpResponse {
  return errorResponse("Not Found", 404);
}

export function methodNotAllowedResponse(): HttpResponse {
  return errorResponse("Method Not Allowed", 405);
}

export function unauthorizedResponse(message: string = "Unauthorized"): HttpResponse {
  return errorResponse(message, 401);
}

export function rateLimitResponse(retryAfterMs: number): HttpResponse {
  return {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
    },
    body: { error: "Too Many Requests", retryAfterMs },
  };
}

// ─── 创建服务器 ───

export function createServer(config?: ServerConfig): EvoAgentServer {
  const port = config?.port ?? parseInt(process.env.EVOAGENT_PORT ?? "3000", 10);
  const hostname = config?.hostname ?? "0.0.0.0";
  const prefix = config?.prefix ?? "/api/v1";
  const requestTimeoutMs = config?.requestTimeoutMs ?? 30_000;
  const maxBodySize = config?.maxBodySize ?? 1_048_576;

  const routes: Array<RouteEntry & { parsedSegments: PathSegment[] }> = [];
  const middlewares: Middleware[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  let activeConnections = 0;
  let totalRequests = 0;
  let errors = 0;
  const startTime = Date.now();

  function registerRoute(route: RouteEntry): void {
    routes.push({
      ...route,
      parsedSegments: parsePathPattern(route.pattern),
    });
  }

  function use(middleware: Middleware): void {
    middlewares.push(middleware);
  }

  async function runMiddlewareChain(
    req: HttpRequest,
    index: number,
    finalHandler: () => HttpResponse | StreamHttpResponse | Promise<HttpResponse | StreamHttpResponse>,
  ): Promise<HttpResponse | StreamHttpResponse> {
    if (index >= middlewares.length) {
      return finalHandler();
    }
    const middleware = middlewares[index]!;
    return middleware(req, () => runMiddlewareChain(req, index + 1, finalHandler));
  }

  function findRoute(method: HttpMethod, path: string): { route: RouteEntry; params: Record<string, string> } | undefined {
    let cleanPath = path;
    if (prefix && cleanPath.startsWith(prefix)) {
      cleanPath = cleanPath.slice(prefix.length) || "/";
    }

    for (const entry of routes) {
      if (entry.method !== method) continue;
      const params = matchPath(cleanPath, entry.parsedSegments);
      if (params !== null) {
        return { route: entry, params };
      }
    }
    return undefined;
  }

  function parseBody(contentType: string | null, rawBody: string | null): unknown {
    if (!rawBody) return null;
    if (contentType?.includes("application/json")) {
      try {
        return JSON.parse(rawBody);
      } catch (err) {
        return { _parseError: `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return rawBody;
  }

  async function handleRequest(
    method: string,
    url: string,
    headers: Headers,
    rawBody: string | null,
    remoteAddress: string,
  ): Promise<Response> {
    totalRequests++;
    activeConnections++;

    try {
      const parsedUrl = new URL(url, `http://${hostname}`);
      const httpMethod = method.toUpperCase() as HttpMethod;

      if (parsedUrl.pathname === "/favicon.ico") {
        return new Response("", {
          status: 204,
          headers: { "Content-Type": "image/x-icon" },
        });
      }

      if (parsedUrl.pathname === "/" || parsedUrl.pathname === "") {
        const { getWebUIHtml } = await import("./server/web-ui");
        const html = getWebUIHtml(prefix);
        return new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const matched = findRoute(httpMethod, parsedUrl.pathname);

      const req: HttpRequest = {
        method: httpMethod,
        url: parsedUrl.pathname,
        headers,
        body: parseBody(headers.get("content-type"), rawBody),
        params: matched?.params ?? {},
        query: parsedUrl.searchParams,
        remoteAddress,
        context: {},
      };

      const response = await runMiddlewareChain(req, 0, () => {
        if (!matched) {
          return notFoundResponse();
        }
        return matched.route.handler(req);
      });

      if (isStreamResponse(response)) {
        return new Response(response.body, {
          status: response.status,
          headers: response.headers,
        });
      }

      const bodyStr = response.body !== undefined && response.body !== null
        ? typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body)
        : "";

      return new Response(bodyStr, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : "Internal Server Error";
      const bodyStr = JSON.stringify({ error: message, status: 500 });
      return new Response(bodyStr, {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    } finally {
      activeConnections--;
    }
  }

  async function start(): Promise<void> {
    const { securityAudit } = await import("./security/dangerous-flags");
    const audit = securityAudit();
    if (!audit.secure) {
      console.warn("[SECURITY AUDIT] Issues detected:");
      for (const warning of audit.warnings) {
        console.warn(`  ${warning}`);
      }
    }

    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[SECURITY] Server is running in production mode without HTTPS. " +
        "API keys and sensitive data may be transmitted in plaintext. " +
        "Consider using a reverse proxy (nginx/caddy) with TLS termination.",
      );
    }

    server = Bun.serve({
      port,
      hostname,
      idleTimeout: 255,
      async fetch(req, server) {
        const remoteAddress = server.requestIP(req)?.address ?? "unknown";
        const body = req.method !== "GET" && req.method !== "HEAD"
          ? new TextDecoder("utf-8").decode(await req.arrayBuffer())
          : null;
        return handleRequest(req.method, req.url, req.headers, body, remoteAddress);
      },
    });
  }

  async function stop(): Promise<void> {
    if (server) {
      server.stop();
      server = undefined;
    }
  }

  function getStats(): ServerStats {
    return {
      totalRequests,
      activeConnections,
      errors,
      startTime,
    };
  }

  function getConfig(): Readonly<ServerConfig> {
    return {
      port,
      hostname,
      prefix,
      requestTimeoutMs,
      maxBodySize,
    };
  }

  return { registerRoute, use, start, stop, getStats, getConfig };
}

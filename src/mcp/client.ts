/**
 * MCP Client — MCP 客户端接口定义。
 *
 * 提供与 MCP 服务器通信的客户端抽象。
 * 修复 A.2-3: 实现 JSON-RPC 请求-响应关联（id 匹配 + Promise 回调）。
 * Step 6: 集成 per-endpoint 断路器，对不可达服务器提供熔断保护。
 */

import type { Transport, JSONRPCMessage } from "./transport";
import {
  createCircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreaker,
} from "./circuit-breaker";
import { defaultLogger } from "../observability/logger";

// ─── MCP 客户端配置 ───

export interface MCPClientConfig {
  readonly name: string;
  readonly version: string;
  readonly transport: Transport;
  readonly requestTimeout?: number;
  readonly circuitBreaker?: CircuitBreakerConfig;
}

// ─── MCP 工具定义 ───

export interface MCPToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

// ─── MCP 资源定义 ───

export interface MCPResource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

// ─── MCP 客户端接口 ───

export interface MCPClient {
  readonly name: string;
  readonly connected: boolean;

  /** 连接到服务器 */
  connect(): Promise<void>;

  /** 断开连接 */
  disconnect(): Promise<void>;

  /** 列出可用工具 */
  listTools(): Promise<readonly MCPToolDefinition[]>;

  /** 调用工具 */
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;

  /** 列出可用资源 */
  listResources(): Promise<readonly MCPResource[]>;

  /** 读取资源 */
  readResource(uri: string): Promise<string>;
}

// ─── JSON-RPC 响应类型 ───

interface JSONRPCResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

// ─── 内部构建函数 ───

function buildClientCore(config: MCPClientConfig): {
  readonly client: MCPClient;
  readonly breaker: CircuitBreaker;
} {
  let connected = false;
  let nextRequestId = 1;

  const logger = defaultLogger.child(`mcp-client:${config.name}`);
  const cooldownMs = config.circuitBreaker?.cooldownMs ?? 60_000;

  const breaker = createCircuitBreaker(config.circuitBreaker, {
    onStateChange: (from, to, reason, context) => {
      if (to === "OPEN") {
        logger.warn("Circuit breaker OPEN", {
          from,
          to,
          reason,
          ...context,
          client: config.name,
        });
      } else if (to === "HALF_OPEN") {
        logger.info("Circuit breaker HALF_OPEN", {
          from,
          to,
          reason,
          client: config.name,
        });
      } else if (to === "CLOSED" && from !== "CLOSED") {
        logger.info("Circuit breaker recovered to CLOSED", {
          from,
          to,
          reason,
          client: config.name,
        });
      }
    },
  });

  const pendingRequests = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const requestTimeout = config.requestTimeout ?? 30_000;

  function setupMessageListener(): void {
    config.transport.onmessage = (message: JSONRPCMessage) => {
      if (
        message.id === undefined ||
        message.method !== undefined
      ) {
        return;
      }

      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = pendingRequests.get(id);
      if (pending === undefined) return;

      clearTimeout(pending.timer);
      pendingRequests.delete(id);

      const response = message as JSONRPCResponse;
      if (response.error !== undefined) {
        breaker.recordFailure();
        pending.reject(
          new Error(
            `MCP error ${response.error.code}: ${response.error.message}`,
          ),
        );
        return;
      }

      breaker.recordSuccess();
      pending.resolve(response.result);
    };
  }

  function clearMessageListener(): void {
    config.transport.onmessage = (() => {}) as (message: JSONRPCMessage) => void;
  }

  function sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!connected) {
      return Promise.reject(new Error("Client is not connected"));
    }

    if (!breaker.canExecute()) {
      const remaining = Math.ceil(
        (cooldownMs - (Date.now() - breaker.openedAt)) / 1000,
      );
      return Promise.reject(
        new Error(
          `MCP circuit breaker OPEN for '${config.name}': ${breaker.consecutiveFailures} consecutive failures, cooldown remaining ~${remaining}s`,
        ),
      );
    }

    const id = nextRequestId++;
    const request: JSONRPCMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        breaker.recordFailure();
        reject(new Error(`MCP request '${method}' timed out after ${requestTimeout}ms`));
      }, requestTimeout);

      pendingRequests.set(id, { resolve, reject, timer });

      config.transport.send(request).catch((error: unknown) => {
        clearTimeout(timer);
        pendingRequests.delete(id);
        breaker.recordFailure();
        reject(new Error(`MCP transport error: ${error instanceof Error ? error.message : String(error)}`));
      });
    });
  }

  async function connect(): Promise<void> {
    setupMessageListener();
    await config.transport.start();
    connected = true;
  }

  async function disconnect(): Promise<void> {
    connected = false;
    clearMessageListener();
    breaker.reset();

    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Client disconnected"));
      pendingRequests.delete(id);
    }

    await config.transport.close();
  }

  async function listTools(): Promise<readonly MCPToolDefinition[]> {
    const result = await sendRequest("tools/list", {});
    if (result === null || result === undefined) return [];
    const parsed = result as { tools?: readonly unknown[] };
    if (!Array.isArray(parsed.tools)) return [];
    return parsed.tools.map((t) => {
      const tool = t as Record<string, unknown>;
      const base: MCPToolDefinition = {
        name: String(tool.name ?? ""),
      };
      const record = base as unknown as Record<string, unknown>;
      if (tool.description !== undefined) {
        record.description = String(tool.description);
      }
      if (tool.inputSchema !== undefined) {
        record.inputSchema = tool.inputSchema as Record<string, unknown>;
      }
      return base;
    });
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await sendRequest("tools/call", { name, arguments: args });
    return result;
  }

  async function listResources(): Promise<readonly MCPResource[]> {
    const result = await sendRequest("resources/list", {});
    if (result === null || result === undefined) return [];
    const parsed = result as { resources?: readonly unknown[] };
    if (!Array.isArray(parsed.resources)) return [];
    return parsed.resources.map((r) => {
      const resource = r as Record<string, unknown>;
      const base: MCPResource = {
        uri: String(resource.uri ?? ""),
        name: String(resource.name ?? ""),
      };
      const record = base as unknown as Record<string, unknown>;
      if (resource.description !== undefined) {
        record.description = String(resource.description);
      }
      if (resource.mimeType !== undefined) {
        record.mimeType = String(resource.mimeType);
      }
      return base;
    });
  }

  async function readResource(uri: string): Promise<string> {
    const result = await sendRequest("resources/read", { uri });
    if (result === null || result === undefined) return "";
    const parsed = result as { contents?: readonly unknown[] };
    if (!Array.isArray(parsed.contents) || parsed.contents.length === 0) return "";
    const first = parsed.contents[0] as Record<string, unknown>;
    return String(first.text ?? "");
  }

  const client: MCPClient = {
    get name() {
      return config.name;
    },
    get connected() {
      return connected;
    },
    connect,
    disconnect,
    listTools,
    callTool,
    listResources,
    readResource,
  };

  return { client, breaker };
}

// ─── 创建 MCP 客户端 ───

export function createMCPClient(
  config: MCPClientConfig,
): MCPClient {
  return buildClientCore(config).client;
}

// ─── 创建带断路器访问的 MCP 客户端（仅供测试使用） ───

export function createMCPClientWithBreaker(
  config: MCPClientConfig,
): MCPClient & { readonly breaker: CircuitBreaker } {
  const { client, breaker } = buildClientCore(config);
  return {
    get name() {
      return client.name;
    },
    get connected() {
      return client.connected;
    },
    connect: client.connect,
    disconnect: client.disconnect,
    listTools: client.listTools,
    callTool: client.callTool,
    listResources: client.listResources,
    readResource: client.readResource,
    breaker,
  };
}

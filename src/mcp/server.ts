/**
 * MCP Server — JSON-RPC 2.0 服务端。
 *
 * 参考 `代码片段_上下文记忆与通信协议` #35 createLinkedTransportPair()。
 * 提供 JSON-RPC 2.0 请求/响应处理、工具注册、资源管理。
 *
 * 设计原则：
 * - JSON-RPC 2.0 规范兼容
 * - 工具注册表（名称 → handler 映射）
 * - 资源注册表（URI → handler 映射）
 * - 错误码标准化
 */

import type { JSONRPCMessage, Transport } from "./transport";
import { sanitizeToolNameForAnalytics } from "../security/truncate";
import { deepNormalizeUnicode } from "../security/external-content";

interface MCPTextContent {
  readonly type: "text";
  readonly text: string;
}

interface CallToolResult {
  readonly content: readonly MCPTextContent[];
  readonly isError?: boolean;
}

function isCallToolResult(raw: unknown): raw is CallToolResult {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return false;
  if (obj.content.length === 0) return false;
  const first = obj.content[0] as Record<string, unknown> | undefined;
  return first !== undefined && first.type === "text" && typeof first.text === "string";
}

function toCallToolResult(raw: unknown): CallToolResult {
  if (isCallToolResult(raw)) return raw;

  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if ("content" in obj && "isError" in obj) {
      const isError = obj.isError === true;
      const text = typeof obj.content === "string"
        ? obj.content
        : JSON.stringify(obj.content);
      return {
        content: [{ type: "text", text }],
        ...(isError ? { isError: true } : {}),
      };
    }
  }

  const isError = raw !== null
    && typeof raw === "object"
    && "error" in (raw as Record<string, unknown>);
  return {
    content: [{ type: "text", text: JSON.stringify(raw) }],
    ...(isError ? { isError: true } : {}),
  };
}

// ─── JSON-RPC 错误码 ───

export const JSONRPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: "Parse error" },
  INVALID_REQUEST: { code: -32600, message: "Invalid Request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR: { code: -32603, message: "Internal error" },
} as const;

// ─── 工具定义 ───

export interface MCPToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

// ─── 工具处理器 ───

export type ToolHandler = (params: unknown) => Promise<unknown>;

// ─── 资源定义 ───

export interface MCPResource {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

// ─── 资源处理器 ───

export type ResourceHandler = (uri: string) => Promise<unknown>;

// ─── Server 配置 ───

export interface MCPServerConfig {
  readonly serverName?: string;
  readonly serverVersion?: string;
}

// ─── Server 接口 ───

export interface MCPServer {
  /** 注册工具 */
  registerTool(definition: MCPToolDefinition, handler: ToolHandler): void;
  /** 注销工具 */
  unregisterTool(name: string): boolean;
  /** 注册资源 */
  registerResource(resource: MCPResource, handler: ResourceHandler): void;
  /** 注销资源 */
  unregisterResource(uri: string): boolean;
  /** 处理 JSON-RPC 消息 */
  handleMessage(message: JSONRPCMessage): Promise<JSONRPCMessage | undefined>;
  /** 连接传输通道 */
  connect(transport: Transport): void;
  /** 断开连接 */
  disconnect(): void;
  /** 获取已注册工具列表 */
  listTools(): readonly MCPToolDefinition[];
  /** 获取已注册资源列表 */
  listResources(): readonly MCPResource[];
  /** 获取统计信息 */
  getStats(): MCPServerStats;
}

// ─── Server 统计 ───

export interface MCPServerStats {
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly toolsRegistered: number;
  readonly resourcesRegistered: number;
}

// ─── 创建 MCP Server ───

export function createMCPServer(config?: MCPServerConfig): MCPServer {
  const serverName = config?.serverName ?? "evoagent-mcp-server";
  const serverVersion = config?.serverVersion ?? "1.0.0";

  const tools = new Map<string, { definition: MCPToolDefinition; handler: ToolHandler }>();
  const resources = new Map<string, { resource: MCPResource; handler: ResourceHandler }>();
  let transport: Transport | undefined;
  let totalRequests = 0;
  let successfulRequests = 0;
  let failedRequests = 0;

  function registerTool(definition: MCPToolDefinition, handler: ToolHandler): void {
    const sanitizedDef: MCPToolDefinition = {
      ...definition,
      name: sanitizeToolNameForAnalytics(definition.name),
    };
    tools.set(sanitizedDef.name, { definition: sanitizedDef, handler });
  }

  function unregisterTool(name: string): boolean {
    return tools.delete(name);
  }

  function registerResource(resource: MCPResource, handler: ResourceHandler): void {
    resources.set(resource.uri, { resource, handler });
  }

  function unregisterResource(uri: string): boolean {
    return resources.delete(uri);
  }

  async function handleMessage(message: JSONRPCMessage): Promise<JSONRPCMessage | undefined> {
    // 仅处理请求（有 method + id）
    if (!message.method || message.id === undefined) return undefined;

    totalRequests++;

    try {
      let result: unknown;

      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: { listChanged: true },
              resources: { subscribe: false, listChanged: true },
            },
            serverInfo: { name: serverName, version: serverVersion },
          };
          break;

        case "tools/list":
          result = {
            tools: [...tools.values()].map((t) => ({
              name: t.definition.name,
              description: t.definition.description,
              inputSchema: t.definition.inputSchema,
            })),
          };
          break;

        case "tools/call": {
          const params = message.params as { name: string; arguments?: unknown } | undefined;
          if (!params?.name) {
            failedRequests++;
            return makeError(message.id, JSONRPC_ERRORS.INVALID_PARAMS, "Missing tool name");
          }
          const tool = tools.get(params.name);
          if (!tool) {
            failedRequests++;
            return makeError(message.id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Unknown tool: ${params.name}`);
          }
          const sanitizedArgs = params.arguments !== undefined
            ? deepNormalizeUnicode(params.arguments)
            : undefined;
          const rawResult = await tool.handler(sanitizedArgs);
          result = toCallToolResult(rawResult);
          break;
        }

        case "resources/list":
          result = {
            resources: [...resources.values()].map((r) => ({
              uri: r.resource.uri,
              name: r.resource.name,
              description: r.resource.description,
              mimeType: r.resource.mimeType,
            })),
          };
          break;

        case "resources/read": {
          const params = message.params as { uri: string } | undefined;
          if (!params?.uri) {
            failedRequests++;
            return makeError(message.id, JSONRPC_ERRORS.INVALID_PARAMS, "Missing resource URI");
          }
          const res = resources.get(params.uri);
          if (!res) {
            failedRequests++;
            return makeError(message.id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Unknown resource: ${params.uri}`);
          }
          const rawResourceResult = await res.handler(params.uri);
          if (rawResourceResult && typeof rawResourceResult === "object" && "content" in (rawResourceResult as Record<string, unknown>)) {
            const contentArr = (rawResourceResult as { readonly content: readonly unknown[] }).content;
            result = {
              contents: contentArr.map((c: unknown) => {
                const item = c as { readonly type?: string; readonly text?: string };
                return {
                  uri: params.uri,
                  mimeType: res.resource.mimeType,
                  ...(item.text !== undefined ? { text: item.text } : {}),
                };
              }),
            };
          } else {
            result = rawResourceResult;
          }
          break;
        }

        case "ping":
          result = {};
          break;

        default:
          failedRequests++;
          return makeError(message.id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${message.method}`);
      }

      successfulRequests++;
      return {
        jsonrpc: "2.0",
        id: message.id,
        result,
      };
    } catch (error) {
      failedRequests++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      return makeError(message.id, JSONRPC_ERRORS.INTERNAL_ERROR, errorMsg);
    }
  }

  function makeError(
    id: string | number | undefined,
    error: { readonly code: number; readonly message: string },
    data?: unknown,
  ): JSONRPCMessage {
    return {
      jsonrpc: "2.0",
      ...(id !== undefined ? { id } : {}),
      error: { code: error.code, message: error.message, data },
    };
  }

  function connect(transportInstance: Transport): void {
    disconnect();
    transport = transportInstance;
    transport.onmessage = async (msg) => {
      const response = await handleMessage(msg);
      if (response && transport) {
        const t = transport as unknown as { isClosed: boolean };
        if (!t.isClosed) {
          await transport.send(response).catch(() => {});
        }
      }
    };
    transport.start().catch((err: unknown) => {
      const t = transport as unknown as { onerror?: (error: Error) => void };
      t.onerror?.(err instanceof Error ? err : new Error(String(err)));
    });
  }

  function disconnect(): void {
    if (transport) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (transport as any).onmessage = undefined;
      transport = undefined;
    }
  }

  function listTools(): readonly MCPToolDefinition[] {
    return [...tools.values()].map((t) => t.definition);
  }

  function listResources(): readonly MCPResource[] {
    return [...resources.values()].map((r) => r.resource);
  }

  function getStats(): MCPServerStats {
    return {
      totalRequests,
      successfulRequests,
      failedRequests,
      toolsRegistered: tools.size,
      resourcesRegistered: resources.size,
    };
  }

  return {
    registerTool,
    unregisterTool,
    registerResource,
    unregisterResource,
    handleMessage,
    connect,
    disconnect,
    listTools,
    listResources,
    getStats,
  };
}

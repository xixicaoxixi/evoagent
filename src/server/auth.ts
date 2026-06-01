/**
 * API Key 认证中间件 — X-API-Key header 认证。
 *
 * 修复 DC-09：所有 API 无认证机制。
 *
 * 设计原则：
 * - API Key 从环境变量 EVOAGENT_API_KEYS 加载（逗号分隔）
 * - X-API-Key header 验证
 * - API Key 前缀 "evo_" 标识
 * - 写操作（POST/PUT/DELETE/PATCH）默认需要认证
 * - 读操作（GET/HEAD/OPTIONS）默认不需要认证
 * - 路由级 auth 标志可覆盖默认行为
 * - 回环地址豁免（开发模式）
 */

import { createHash } from "node:crypto";
import type { HttpRequest, HttpResponse, Middleware } from "../server";

// ─── 认证配置 ───

export interface AuthConfig {
  /** API Keys 列表（从环境变量加载） */
  readonly apiKeys?: ReadonlyArray<string>;
  /** 回环地址是否豁免认证（默认 true） */
  readonly loopbackExempt?: boolean;
  /** API Key 前缀（默认 "evo_"） */
  readonly keyPrefix?: string;
  /** 认证 header 名称（默认 "x-api-key"） */
  readonly headerName?: string;
}

// ─── 认证结果 ───

export interface AuthResult {
  readonly authenticated: boolean;
  /** API Key 指纹（前 8 位 + SHA-256 后 8 位），非完整密钥 */
  readonly apiKey?: string;
  readonly error?: string;
}

// ─── 认证器接口 ───

export interface Authenticator {
  /** 验证 API Key */
  validate(apiKey: string): AuthResult;
  /** 检查请求是否需要认证 */
  requiresAuth(req: HttpRequest): boolean;
  /** 获取所有已注册的 API Key 前缀（脱敏） */
  getKeyPrefixes(): ReadonlyArray<string>;
}

// ─── 判断是否为回环地址 ───

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "localhost" || address === "unknown";
}

// ─── 判断是否为写操作 ───

function isWriteMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";
}

// ─── SEC-01 修复：SHA-256 哈希（替代 32 位整数哈希） ───

/**
 * 对 API Key 计算 SHA-256 哈希。
 * 输出为 64 字符小写 hex 字符串。
 */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * 生成 API Key 指纹 — 用于 context 注入和日志记录。
 * 格式：前 8 位 + "..." + SHA-256 后 8 位
 * 不暴露完整密钥，但可用于调试和审计。
 */
export function keyFingerprint(key: string): string {
  const hash = hashKey(key);
  const prefix = key.length > 8 ? key.slice(0, 8) : key;
  return `${prefix}...${hash.slice(0, 8)}`;
}

// ─── 创建认证器 ───

export function createAuthenticator(config?: AuthConfig): Authenticator {
  const rawKeys = config?.apiKeys ?? loadApiKeysFromEnv();
  const loopbackExempt = config?.loopbackExempt ?? true;
  const keyPrefix = config?.keyPrefix ?? "evo_";
  const headerName = config?.headerName ?? "x-api-key";

  // 存储 API Key 的 SHA-256 哈希（不存储明文）
  const keyHashes = new Set<string>();
  const keyPrefixes = new Set<string>();

  for (const key of rawKeys) {
    if (typeof key === "string" && key.length > 0) {
      keyHashes.add(hashKey(key));
      if (key.startsWith(keyPrefix)) {
        keyPrefixes.add(key.slice(0, keyPrefix.length + 4) + "...");
      }
    }
  }

  function validate(apiKey: string): AuthResult {
    if (!apiKey || typeof apiKey !== "string") {
      return { authenticated: false, error: "Missing API key" };
    }

    if (!apiKey.startsWith(keyPrefix)) {
      return { authenticated: false, error: "Invalid API key prefix" };
    }

    if (keyHashes.has(hashKey(apiKey))) {
      // SEC-05 修复：返回指纹而非完整 API Key
      return { authenticated: true, apiKey: keyFingerprint(apiKey) };
    }

    return { authenticated: false, error: "Invalid API key" };
  }

  function requiresAuth(req: HttpRequest): boolean {
    // 回环地址豁免
    if (loopbackExempt && isLoopback(req.remoteAddress)) {
      return false;
    }

    // 无 API Key 配置时不需要认证（开发模式）
    if (keyHashes.size === 0) {
      return false;
    }

    // 写操作需要认证
    return isWriteMethod(req.method);
  }

  function getKeyPrefixes(): ReadonlyArray<string> {
    return [...keyPrefixes];
  }

  return { validate, requiresAuth, getKeyPrefixes };
}

// ─── 从环境变量加载 API Keys ───

function loadApiKeysFromEnv(): string[] {
  const envValue = process.env.EVOAGENT_API_KEYS;
  if (!envValue) return [];
  return envValue.split(",").map((k) => k.trim()).filter(Boolean);
}

// ─── 创建认证中间件 ───

export function createAuthMiddleware(authenticator: Authenticator): Middleware {
  const headerName = "x-api-key";

  return (req: HttpRequest, next: () => HttpResponse | Promise<HttpResponse>): HttpResponse | Promise<HttpResponse> => {
    // 检查是否需要认证
    if (!authenticator.requiresAuth(req)) {
      // 不需要认证，但如果有 API Key 仍然验证并注入上下文
      const apiKey = req.headers.get(headerName);
      if (apiKey) {
        const result = authenticator.validate(apiKey);
        if (result.authenticated) {
          (req as { context: Record<string, unknown> }).context.authenticated = true;
          (req as { context: Record<string, unknown> }).context.apiKey = result.apiKey;
        }
      }
      return next();
    }

    // 需要认证
    const apiKey = req.headers.get(headerName);
    if (!apiKey) {
      return {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: { error: "API key required", status: 401 },
      };
    }

    const result = authenticator.validate(apiKey);
    if (!result.authenticated) {
      return {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: { error: result.error ?? "Unauthorized", status: 401 },
      };
    }

    // 注入认证信息到上下文
    (req as { context: Record<string, unknown> }).context.authenticated = true;
    (req as { context: Record<string, unknown> }).context.apiKey = result.apiKey;

    return next();
  };
}

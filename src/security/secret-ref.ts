/**
 * SecretRef 类型系统 — SEC-03 修复。
 *
 * 支持从多种来源安全获取密钥：
 * - env: 从环境变量读取
 * - file: 从文件读取（限制大小 + 拒绝符号链接）
 * - exec: 从命令输出读取
 *
 * 基于安全最佳实践的 SecretRef 类型系统设计。
 */

import { readFileSync, lstatSync } from "node:fs";
import { resolve, sep, delimiter } from "node:path";

// ─── SecretRef 来源类型 ───

export type SecretRefSource = "env" | "file" | "exec";

// ─── SecretRef 类型 ───

/**
 * 密钥引用的稳定标识符。
 *
 * 示例：
 * - env source: provider "default", id "OPENAI_API_KEY"
 * - file source: provider "mounted-json", id "/providers/openai/apiKey"
 * - exec source: provider "vault", id "openai/api-key"
 */
export type SecretRef = {
  readonly source: SecretRefSource;
  readonly provider: string;
  readonly id: string;
};

// ─── SecretInput 联合类型 ───

export type SecretInput = string | SecretRef;

// ─── 常量 ───

export const DEFAULT_SECRET_PROVIDER_ALIAS = "default";

/** 环境变量名正则：大写字母开头，大写字母/数字/下划线，最长 128 字符 */
export const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

/** 环境变量模板正则：${VAR_NAME} */
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;

/** 密钥文件最大读取字节数 */
export const MAX_SECRET_FILE_BYTES = 64 * 1024; // 64KB

const DEFAULT_SECRET_DIR_PREFIXES: ReadonlyArray<string> = [
  resolve(process.cwd()),
  "/run/secrets",
];

function isAllowedSecretPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  const envDirs = process.env.EVOAGENT_SECRET_DIRS;
  const allPrefixes = envDirs
    ? [...DEFAULT_SECRET_DIR_PREFIXES, ...envDirs.split(delimiter).filter(Boolean)]
    : DEFAULT_SECRET_DIR_PREFIXES;
  return allPrefixes.some((prefix) => {
    const normalizedPrefix = prefix.endsWith(sep) ? prefix : prefix + sep;
    return resolved.startsWith(normalizedPrefix) || resolved === prefix;
  });
}

// ─── 类型守卫 ───

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 判断值是否为有效的 SecretRef。
 */
export function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3) return false;
  return (
    (value.source === "env" || value.source === "file" || value.source === "exec") &&
    typeof value.provider === "string" &&
    value.provider.trim().length > 0 &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

/**
 * 判断环境变量名是否为有效的 SecretRef ID。
 */
export function isValidEnvSecretRefId(value: string): boolean {
  return ENV_SECRET_REF_ID_RE.test(value);
}

// ─── 解析函数 ───

/**
 * 解析环境变量模板为 SecretRef。
 *
 * "${OPENAI_API_KEY}" → { source: "env", provider: "default", id: "OPENAI_API_KEY" }
 *
 * @returns SecretRef 或 null（不匹配模板时）
 */
export function parseEnvTemplateSecretRef(
  value: unknown,
  provider: string = DEFAULT_SECRET_PROVIDER_ALIAS,
): SecretRef | null {
  if (typeof value !== "string") return null;
  const match = ENV_SECRET_TEMPLATE_RE.exec(value.trim());
  if (!match?.[1]) return null;
  return {
    source: "env",
    provider: provider.trim() || DEFAULT_SECRET_PROVIDER_ALIAS,
    id: match[1],
  };
}

/**
 * 强制转换值为 SecretRef。
 *
 * 优先级：
 * 1. 已经是 SecretRef → 直接返回
 * 2. 匹配环境变量模板 → 解析为 SecretRef
 * 3. 其他 → 返回 null
 */
export function coerceSecretRef(
  value: unknown,
  defaults?: { readonly env?: string; readonly file?: string; readonly exec?: string },
): SecretRef | null {
  if (isSecretRef(value)) return value;
  const envTemplate = parseEnvTemplateSecretRef(value, defaults?.env);
  if (envTemplate) return envTemplate;
  return null;
}

// ─── 密钥解析 ───

/**
 * 从 SecretInput 解析出实际密钥值。
 *
 * - string → 直接返回
 * - SecretRef (env) → 从环境变量读取
 * - SecretRef (file) → 从文件读取（限制大小 + 拒绝符号链接）
 * - SecretRef (exec) → 暂不支持，返回空字符串
 */
export function resolveSecret(input: SecretInput): string {
  if (typeof input === "string") return input;

  switch (input.source) {
    case "env": {
      const value = process.env[input.id];
      if (!value) {
        throw new Error(`SecretRef env source: environment variable "${input.id}" is not set (provider: "${input.provider}")`);
      }
      return value;
    }
    case "file":
      return readSecretFromFile(input.id, `secret-ref:${input.provider}`);
    case "exec":
      throw new Error(`SecretRef exec source is not supported (provider: "${input.provider}", id: "${input.id}")`);
  }
}

// ─── 密钥文件读取 ───

/**
 * 安全读取密钥文件。
 *
 * 安全措施：
 * - 拒绝符号链接（防止路径遍历攻击）
 * - 限制文件大小（防止内存耗尽）
 *
 * 基于安全最佳实践的密钥文件安全读取方案。
 */
export function readSecretFromFile(filePath: string, label: string): string {
  if (!isAllowedSecretPath(filePath)) {
    throw new Error(`Secret file "${label}": path "${filePath}" is outside allowed directories`);
  }

  let stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    throw new Error(`Secret file "${label}": file not found or inaccessible: "${filePath}"`);
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Secret file "${label}": symbolic links are not allowed`);
  }

  if (stats.size > MAX_SECRET_FILE_BYTES) {
    throw new Error(
      `Secret file "${label}": file size ${stats.size} exceeds maximum ${MAX_SECRET_FILE_BYTES} bytes`,
    );
  }

  try {
    return readFileSync(filePath, { encoding: "utf-8" }).trim();
  } catch (error) {
    throw new Error(
      `Secret file "${label}": failed to read "${filePath}" — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

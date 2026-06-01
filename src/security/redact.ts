/**
 * 配置快照脱敏 — SEC-10 修复。
 *
 * 深度遍历配置对象，将敏感路径上的字符串值替换为哨兵值。
 * 支持往返恢复（round-trip）：写入时从原始值恢复脱敏值。
 *
 * 基于安全最佳实践的配置快照脱敏方案。
 */

// ─── 常量 ───

/** 脱敏哨兵值 */
export const REDACTED_SENTINEL = "__EVOAGENT_REDACTED__";

/** 环境变量占位符正则 */
const ENV_VAR_PLACEHOLDER_RE = /^\$\{[A-Z][A-Z0-9_]{0,127}\}$/;

// ─── 敏感路径白名单 ───

/**
 * 非敏感字段名后缀白名单。
 * 这些字段名虽然匹配敏感模式，但实际不是敏感数据。
 */
const SENSITIVE_KEY_WHITELIST_SUFFIXES: ReadonlyArray<string> = [
  "maxtokens",
  "maxoutputtokens",
  "maxinputtokens",
  "maxcompletiontokens",
  "contexttokens",
  "totaltokens",
  "tokencount",
  "tokenlimit",
  "tokenbudget",
  "passwordfile",
];

const NORMALIZED_WHITELIST = SENSITIVE_KEY_WHITELIST_SUFFIXES.map((s) => s.toLowerCase());

// ─── 敏感模式 ───

const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /token$/i,
  /password/i,
  /secret/i,
  /api.?key/i,
  /encrypt.?key/i,
  /private.?key/i,
  /serviceaccount(?:ref)?$/i,
  /hmac.?key/i,
];

// ─── 敏感路径检测 ───

function normalizePath(path: string): string {
  return path.toLowerCase().replace(/\[\d+\]/g, "[]");
}

function isWhitelisted(path: string): boolean {
  const lower = normalizePath(path);
  return NORMALIZED_WHITELIST.some((suffix) => lower.endsWith(suffix));
}

function matchesSensitivePattern(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * 检测配置路径是否敏感。
 *
 * 白名单排除 maxTokens 等非敏感字段。
 *
 * @param path - 点分隔的配置路径，如 "llm.api_key"
 */
export function isSensitiveConfigPath(path: string): boolean {
  return !isWhitelisted(path) && matchesSensitivePattern(path);
}

// ─── 环境变量占位符检测 ───

function isEnvVarPlaceholder(value: string): boolean {
  return ENV_VAR_PLACEHOLDER_RE.test(value.trim());
}

// ─── 深度脱敏 ───

/**
 * 深度遍历对象，将敏感路径上的字符串值替换为哨兵值。
 *
 * @param value - 要脱敏的值
 * @param currentPath - 当前路径（递归使用）
 * @param maxDepth - 最大递归深度（防止栈溢出）
 */
export function redactConfigObject<T>(
  value: T,
  currentPath: string = "",
  maxDepth: number = 20,
): T {
  if (maxDepth <= 0) return value;

  if (typeof value === "string") {
    if (currentPath && isSensitiveConfigPath(currentPath) && !isEnvVarPlaceholder(value)) {
      return REDACTED_SENTINEL as unknown as T;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactConfigObject(item, `${currentPath}[${index}]`, maxDepth - 1),
    ) as unknown as T;
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const newPath = currentPath ? `${currentPath}.${key}` : key;
      result[key] = redactConfigObject(val, newPath, maxDepth - 1);
    }
    return result as unknown as T;
  }

  return value;
}

// ─── 脱敏值恢复 ───

/**
 * 深度遍历 incoming 对象，将 REDACTED_SENTINEL 值替换为 original 中对应的值。
 *
 * 用于写入时恢复脱敏值，确保 round-trip 不丢失凭证。
 *
 * @param incoming - 包含脱敏哨兵值的对象（如 API 请求体）
 * @param original - 原始完整配置
 */
export function restoreRedactedValues(
  incoming: unknown,
  original: unknown,
): unknown {
  if (incoming === REDACTED_SENTINEL) {
    // 如果原始值也是哨兵值（即原始配置中该字段就是脱敏的），保持哨兵值
    if (original === REDACTED_SENTINEL || original === undefined || original === null) {
      return REDACTED_SENTINEL;
    }
    return original;
  }

  if (Array.isArray(incoming)) {
    if (!Array.isArray(original)) return incoming;
    return incoming.map((item, index) =>
      restoreRedactedValues(item, original[index]),
    );
  }

  if (incoming !== null && typeof incoming === "object") {
    if (original === null || typeof original !== "object") return incoming;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(incoming)) {
      const origObj = original as Record<string, unknown>;
      result[key] = restoreRedactedValues(val, origObj[key]);
    }
    return result;
  }

  return incoming;
}

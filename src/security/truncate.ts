/**
 * 工具输入截断 — SEC-12 修复。
 *
 * 为遥测事件序列化工具输入参数时进行截断，保持输出有界同时保留取证有用字段。
 *
 * 基于通用 Agent 设计模式的工具输入截断方案。
 */

// ─── 截断常量 ───

/** 字符串截断阈值 */
const TOOL_INPUT_STRING_TRUNCATE_AT = 512;
/** 字符串截断后保留长度 */
const TOOL_INPUT_STRING_TRUNCATE_TO = 128;
/** 最终 JSON 最大字符数 */
const TOOL_INPUT_MAX_JSON_CHARS = 4 * 1024;
/** 集合最大项数 */
const TOOL_INPUT_MAX_COLLECTION_ITEMS = 20;
/** 最大递归深度 */
const TOOL_INPUT_MAX_DEPTH = 2;

/**
 * 递归截断工具输入值。
 *
 * 截断策略：
 * - 字符串：超过 512 字符截断为前 128 字符 + 长度标记
 * - 深度限制：最大深度 2 层，超出显示 `<nested>`
 * - 集合限制：数组/对象最多 20 项，超出显示省略标记
 * - 内部标记：过滤以 `_` 开头的内部键
 *
 * @param value - 要截断的值
 * @param depth - 当前递归深度
 */
export function sanitizeToolInputForLogging(value: unknown, depth: number = 0): unknown {
  if (typeof value === "string") {
    if (value.length > TOOL_INPUT_STRING_TRUNCATE_AT) {
      return `${value.slice(0, TOOL_INPUT_STRING_TRUNCATE_TO)}…[${value.length} chars]`;
    }
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }

  if (depth >= TOOL_INPUT_MAX_DEPTH) {
    return "<nested>";
  }

  if (Array.isArray(value)) {
    const mapped = value
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map((v) => sanitizeToolInputForLogging(v, depth + 1));
    if (value.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(`…[${value.length} items]`);
    }
    return mapped;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // 跳过内部标记键，防止泄露到遥测
      .filter(([k]) => !k.startsWith("_"));
    const mapped = entries
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map(([k, v]) => [k, sanitizeToolInputForLogging(v, depth + 1)] as const);
    if (entries.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(["…", `${entries.length} keys`]);
    }
    return Object.fromEntries(mapped);
  }

  return String(value);
}

/**
 * 提取工具输入用于遥测。
 *
 * 截断后序列化为 JSON，超过 4KB 时进一步截断。
 *
 * @param input - 工具输入
 * @returns 截断后的 JSON 字符串
 */
export function extractToolInputForTelemetry(input: unknown): string {
  const truncated = sanitizeToolInputForLogging(input);
  let json = JSON.stringify(truncated);
  if (json.length > TOOL_INPUT_MAX_JSON_CHARS) {
    json = json.slice(0, TOOL_INPUT_MAX_JSON_CHARS) + "…[truncated]";
  }
  return json;
}

/**
 * MCP 工具名脱敏。
 *
 * MCP 工具名格式为 `mcp__<server>__<tool>`，
 * 可能暴露用户特定的服务器配置（PII-medium）。
 *
 * @param toolName - 工具名
 * @returns 脱敏后的工具名
 */
export function sanitizeToolNameForAnalytics(toolName: string): string {
  if (toolName.startsWith("mcp__")) {
    return "mcp_tool";
  }
  return toolName;
}

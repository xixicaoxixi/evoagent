/**
 * LLM 出站净化管线 — 5 层净化流水线。
 *
 * 将发送给远程 LLM 提供商的消息经过以下 5 层处理：
 *
 *   原始消息
 *     → 1. PII 净化（邮箱/手机/API Key/身份证）
 *     → 2. 路径脱敏（/workspace/... → <path>）
 *     → 3. 架构关键词过滤（内部模块名/函数名）
 *     → 4. 文件内容截断（tool_result 超过 8000 字符截断）
 *     → 5. Unicode 净化（零宽字符/方向控制符）
 *     → 净化后消息
 *
 * 本地模型（ollama / mock）跳过全部净化步骤。
 * 远程模型（openai / anthropic / deepseek / kimi / glm）执行完整净化。
 * 无法识别的模型按 Fail-Closed 原则视为远程模型。
 */

import { createPIISanitizer } from "../observability/pii";
import { normalizeUnicodeForSafety } from "./external-content";
import { inferProviderType, ProviderType } from "../types/common";

// ─── 公共类型 ───

/**
 * LLM 净化选项。
 *
 * 每一层都可以通过对应字段独立跳过。
 */
export interface LLMSanitizeOptions {
  /** 跳过第 1 层 PII 净化 */
  readonly skipPII?: boolean;
  /** 跳过第 2 层路径脱敏 */
  readonly skipPathRedaction?: boolean;
  /** 跳过第 3 层架构关键词过滤 */
  readonly skipKeywordFilter?: boolean;
  /** 跳过第 4 层文件内容截断 */
  readonly skipTruncation?: boolean;
  /** 跳过第 5 层 Unicode 净化 */
  readonly skipUnicode?: boolean;
  /** 第 4 层截断最大长度（默认 8000） */
  readonly maxLength?: number;
}

/**
 * LLM 净化统计信息。
 */
export interface LLMSanitizeStats {
  /** PII 脱敏命中数 */
  readonly piiRedacted: number;
  /** 路径脱敏命中数 */
  readonly pathsRedacted: number;
  /** 架构关键词过滤命中数 */
  readonly keywordsFiltered: number;
  /** 是否发生了截断 */
  readonly wasTruncated: boolean;
  /** 原始文本长度 */
  readonly originalLength: number;
  /** 净化后文本长度 */
  readonly sanitizedLength: number;
}

/**
 * LLM 净化结果。
 */
export interface LLMSanitizationResult {
  /** 净化后的文本 */
  readonly sanitized: string;
  /** 实际执行的净化层名称列表 */
  readonly layersApplied: readonly string[];
  /** 净化统计信息 */
  readonly stats: LLMSanitizeStats;
}

// ─── 常量 ───

/** 默认截断长度 */
const DEFAULT_TRUNCATE_LENGTH = 8000;

/** 本地提供商类型集合 — 这些提供商的数据不离开本机，无需净化 */
const LOCAL_PROVIDER_TYPES: ReadonlySet<string> = new Set<string>([
  ProviderType.OLLAMA,
  ProviderType.MOCK,
]);

// ─── 第 1 层：PII 净化 ───

/** 预创建的 PII 脱敏器实例（使用默认模式） */
const piiSanitizer = createPIISanitizer();

/**
 * 对文本执行 PII 脱敏。
 *
 * 检测并处理以下 PII 类型：
 * - 电子邮箱
 * - 手机号码（国际 + 中国）
 * - API Key / Secret / Token
 * - 身份证号
 * - JWT Token
 * - 信用卡号
 * - AWS Access Key
 * - IP 地址
 *
 * @param text - 待净化的原始文本
 * @returns 脱敏后的文本及命中数量
 */
function sanitizePII(text: string): { readonly text: string; readonly count: number } {
  const result = piiSanitizer.sanitize(text);
  return { text: result.sanitized, count: result.redactionCount };
}

// ─── 第 2 层：路径脱敏 ───

/**
 * Unix 文件系统路径正则模式。
 *
 * 匹配常见敏感目录前缀：
 * - /home/... — 用户主目录
 * - /workspace/... — 工作空间
 * - /tmp/... — 临时目录
 * - /var/... — 系统变量目录
 * - /etc/... — 系统配置目录
 * - /root/... — root 用户主目录
 * - /opt/... — 可选软件目录
 * - /usr/... — 系统程序目录
 */
const UNIX_PATH_SOURCES: ReadonlyArray<string> = [
  /\/home\/[^\s"'`,\])}\]>]+/.source,
  /\/workspace\/[^\s"'`,\])}\]>]+/.source,
  /\/tmp\/[^\s"'`,\])}\]>]+/.source,
  /\/var\/[^\s"'`,\])}\]>]+/.source,
  /\/etc\/[^\s"'`,\])}\]>]+/.source,
  /\/root\/[^\s"'`,\])}\]>]+/.source,
  /\/opt\/[^\s"'`,\])}\]>]+/.source,
  /\/usr\/[^\s"'`,\])}\]>]+/.source,
];

/**
 * Windows 文件系统路径正则模式。
 *
 * 匹配 Windows 盘符路径：
 * - C:\Users\... — 用户目录
 * - D:\... — 其他盘符
 */
const WINDOWS_PATH_SOURCES: ReadonlyArray<string> = [
  /[A-Za-z]:\\Users\\[^\s"'`,\])}\]>]+/.source,
  /[A-Za-z]:\\[^\s"'`,\])}\]>]+/.source,
];

/**
 * 路径脱敏 — 将文件系统路径替换为 `<path>`。
 *
 * 支持 Unix 风格路径（/home/...、/workspace/... 等）和
 * Windows 风格路径（C:\Users\...、D:\... 等）。
 *
 * @param text - 可能包含文件路径的文本
 * @returns 路径被替换为 `<path>` 的文本
 */
export function sanitizePath(text: string): string {
  let result = text;
  let redactionCount = 0;

  for (const source of UNIX_PATH_SOURCES) {
    const pattern = new RegExp(source, "g");
    const matches = result.match(pattern);
    if (matches !== null && matches.length > 0) {
      redactionCount += matches.length;
      result = result.replace(new RegExp(source, "g"), "<path>");
    }
  }

  for (const source of WINDOWS_PATH_SOURCES) {
    const pattern = new RegExp(source, "g");
    const matches = result.match(pattern);
    if (matches !== null && matches.length > 0) {
      redactionCount += matches.length;
      result = result.replace(new RegExp(source, "g"), "<path>");
    }
  }

  return result;
}

/**
 * 路径脱敏（带计数版本，供管线内部使用）。
 */
function sanitizePathWithCount(text: string): { readonly text: string; readonly count: number } {
  const before = text;
  const after = sanitizePath(text);
  let count = 0;
  const allSources = [...UNIX_PATH_SOURCES, ...WINDOWS_PATH_SOURCES];
  for (const source of allSources) {
    const pattern = new RegExp(source, "g");
    const matches = before.match(pattern);
    if (matches !== null) {
      count += matches.length;
    }
  }
  return { text: after, count };
}

// ─── 第 3 层：架构关键词过滤 ───

/**
 * 架构关键词替换规则。
 *
 * 每条规则包含：
 * - `keyword`: 需要过滤的内部标识符
 * - `replacement`: 替换后的通用占位符
 * - `category`: 关键词分类（用于日志/调试）
 *
 * 使用单词边界 `\b` 避免误替换（例如不会把 "intelligent agent" 中的 "agent" 替换掉）。
 * 对于包含特殊字符的标识符（如 `BASH_PATH_PATTERNS`），使用转义后的精确匹配。
 */
interface KeywordRule {
  readonly keyword: string;
  readonly replacement: string;
  readonly category: "module" | "function" | "constant" | "type";
}

const ARCHITECTURE_KEYWORDS: ReadonlyArray<KeywordRule> = [
  // ── 模块名 ──
  { keyword: "EvoAgent", replacement: "<module>", category: "module" },
  { keyword: "QueryEngine", replacement: "<module>", category: "module" },
  { keyword: "CredentialStore", replacement: "<module>", category: "module" },
  { keyword: "FileCredentialStore", replacement: "<module>", category: "module" },
  { keyword: "PIISanitizer", replacement: "<module>", category: "module" },

  // ── 函数名 ──
  { keyword: "agentQueryLoop", replacement: "<function>", category: "function" },
  { keyword: "createToolDefinition", replacement: "<function>", category: "function" },
  { keyword: "analyzeBashAstForSecurity", replacement: "<function>", category: "function" },
  { keyword: "checkBashPermission", replacement: "<function>", category: "function" },
  { keyword: "analyzeBashSemantics", replacement: "<function>", category: "function" },
  { keyword: "sanitizeToolInputForLogging", replacement: "<function>", category: "function" },
  { keyword: "normalizeUnicodeForSafety", replacement: "<function>", category: "function" },
  { keyword: "markExternalContent", replacement: "<function>", category: "function" },
  { keyword: "createChainedCredentialStore", replacement: "<function>", category: "function" },
  { keyword: "createPIISanitizer", replacement: "<function>", category: "function" },
  { keyword: "redactConfigObject", replacement: "<function>", category: "function" },
  { keyword: "detectPromptInjection", replacement: "<function>", category: "function" },
  { keyword: "deepNormalizeUnicode", replacement: "<function>", category: "function" },
  { keyword: "extractToolInputForTelemetry", replacement: "<function>", category: "function" },
  { keyword: "sanitizeToolNameForAnalytics", replacement: "<function>", category: "function" },

  // ── 常量名 ──
  { keyword: "BASH_PATH_PATTERNS", replacement: "<constant>", category: "constant" },
  { keyword: "PROMOTION_IMPROVEMENT_MIN", replacement: "<constant>", category: "constant" },
  { keyword: "DEPRECATION_RATE_MIN", replacement: "<constant>", category: "constant" },
  { keyword: "EVOLUTION_SANDBOX_MIN_SUCCESS_RATE", replacement: "<constant>", category: "constant" },
  { keyword: "ENGINE_SELF_OPT_MIN_TASKS", replacement: "<constant>", category: "constant" },
  { keyword: "TOOL_GEN_MIN_TASKS", replacement: "<constant>", category: "constant" },
  { keyword: "TOOL_GEN_INTERVAL", replacement: "<constant>", category: "constant" },
  { keyword: "TOOL_GEN_MAX_TOOLS", replacement: "<constant>", category: "constant" },

  // ── 类型名 ──
  { keyword: "EvolutionAction", replacement: "<type>", category: "type" },
  { keyword: "RuleStatus", replacement: "<type>", category: "type" },
  { keyword: "MessageType", replacement: "<type>", category: "type" },
] as const;

/**
 * 预编译的关键词正则表达式列表。
 *
 * 对每个关键词构建带单词边界的正则：
 * - 普通标识符：`\bkeyword\b`（全局匹配）
 * - 包含下划线的标识符：直接使用 `\b` 即可，因为 `_` 不是单词字符
 *
 * 按关键词长度降序排列，确保长关键词优先匹配（避免短关键词先匹配导致长关键词被部分替换）。
 */
const KEYWORD_RULES: ReadonlyArray<{
  readonly source: string;
  readonly replacement: string;
}> = ARCHITECTURE_KEYWORDS
  .slice()
  .sort((a, b) => b.keyword.length - a.keyword.length)
  .map((rule) => ({
    source: `\\b${escapeRegex(rule.keyword)}\\b`,
    replacement: rule.replacement,
  }));

const GROUPED_KEYWORD_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replacement: string;
}> = (() => {
  const groups = new Map<string, string[]>();
  for (const rule of KEYWORD_RULES) {
    const list = groups.get(rule.replacement) ?? [];
    list.push(rule.source);
    groups.set(rule.replacement, list);
  }

  return [...groups.entries()].map(([replacement, sources]) => ({
    pattern: new RegExp(sources.join("|"), "g"),
    replacement,
  }));
})();

/**
 * 转义正则特殊字符。
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 架构关键词过滤 — 将内部模块名/函数名/常量名替换为通用占位符。
 *
 * 替换规则：
 * - 模块名 → `<module>`
 * - 函数名 → `<function>`
 * - 常量名 → `<constant>`
 * - 类型名 → `<type>`
 *
 * 使用单词边界匹配，避免误替换子串。
 * 例如 "intelligent agent" 中的 "agent" 不会被替换，
 * 但独立的 "EvoAgent" 会被替换为 `<module>`。
 *
 * @param text - 可能包含内部关键词的文本
 * @returns 关键词被替换为占位符的文本
 */
export function filterArchitectureKeywords(text: string): string {
  let result = text;
  for (const { pattern, replacement } of GROUPED_KEYWORD_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * 架构关键词过滤（带计数版本，供管线内部使用）。
 */
function filterKeywordsWithCount(text: string): { readonly text: string; readonly count: number } {
  let result = text;
  let count = 0;
  for (const { pattern, replacement } of GROUPED_KEYWORD_PATTERNS) {
    const matches = result.match(pattern);
    if (matches !== null && matches.length > 0) {
      count += matches.length;
      result = result.replace(pattern, replacement);
    }
  }
  return { text: result, count };
}

// ─── 第 4 层：文件内容截断 ───

/**
 * 文件内容截断 — 将超长文本截断到指定长度。
 *
 * 当文本长度超过 `maxLength` 时，截断到该长度并追加截断标记。
 * 截断标记格式：`...[truncated: N chars]`，其中 N 为被截断的字符数。
 *
 * @param text - 待截断的文本
 * @param maxLength - 最大保留长度（默认 8000）
 * @returns 截断后的文本（未超长则原样返回）
 */
export function truncateForLLM(text: string, maxLength: number = DEFAULT_TRUNCATE_LENGTH): string {
  if (text.length <= maxLength) {
    return text;
  }
  const truncatedCount = text.length - maxLength;
  return `${text.slice(0, maxLength)}...[truncated: ${truncatedCount} chars]`;
}

// ─── 第 5 层：Unicode 净化 ───

/**
 * Unicode 净化 — 移除零宽字符、方向控制符等危险 Unicode 序列。
 *
 * 委托给 `normalizeUnicodeForSafety`（来自 `./external-content`），
 * 该函数执行：
 * - NFKC 规范化
 * - 格式控制符 (Cf) 移除
 * - 私有使用区 (Co/Cn) 移除
 * - 零宽字符 (U+200B-U+200F) 移除
 * - 方向控制字符 (U+202A-U+202E) 移除
 * - 方向隔离符 (U+2066-U+2069) 移除
 * - BOM (U+FEFF) 移除
 * - BMP 私有使用区 (U+E000-U+F8FF) 移除
 * - 补充私有使用区-A Tag 字符 (U+E0000-U+E0FFF) 移除
 *
 * @param text - 可能包含危险 Unicode 的文本
 * @returns 净化后的安全文本
 */
function sanitizeUnicode(text: string): string {
  return normalizeUnicodeForSafety(text);
}

// ─── 本地/远程提供商判断 ───

/**
 * 判断模型是否为本地提供商。
 *
 * 本地提供商（数据不离开本机）：
 * - `ollama` — 本地 Ollama 模型
 * - `mock` — 测试用模拟提供商
 *
 * 远程提供商（需要完整净化）：
 * - `openai`、`anthropic`、`deepseek`、`kimi`、`glm`
 *
 * 如果 `inferProviderType` 返回 `undefined`（模型名未在映射表中），
 * 按 Fail-Closed 原则视为远程提供商，执行完整净化。
 *
 * @param model - 模型名称（如 "gpt-4o"、"claude-3-5-sonnet-20241022"）
 * @returns `true` 表示本地模型（跳过净化），`false` 表示远程模型（完整净化）
 */
export function isLocalProvider(model: string): boolean {
  const providerType = inferProviderType(model);
  if (providerType === undefined) {
    // Fail-Closed: 无法识别的模型视为远程，需要净化
    return false;
  }
  return LOCAL_PROVIDER_TYPES.has(providerType);
}

/**
 * 判断是否需要对指定模型执行 LLM 净化。
 *
 * 本质上是 `isLocalProvider` 的取反：
 * - 本地模型 → `false`（跳过净化）
 * - 远程模型 → `true`（完整净化）
 * - 未知模型 → `true`（Fail-Closed，执行净化）
 *
 * @param model - 模型名称
 * @returns `true` 表示需要执行净化
 */
export function shouldSanitizeForLLM(model: string): boolean {
  return !isLocalProvider(model);
}

// ─── 主入口：5 层净化管线 ───

/**
 * LLM 出站净化 — 主入口函数。
 *
 * 对文本依次执行 5 层净化处理，返回净化结果及统计信息。
 *
 * 管线执行顺序：
 * 1. **PII 净化** — 检测并脱敏邮箱、手机号、API Key、身份证等敏感信息
 * 2. **路径脱敏** — 将文件系统路径替换为 `<path>`
 * 3. **架构关键词过滤** — 将内部模块名/函数名/常量名替换为通用占位符
 * 4. **文件内容截断** — 超过 maxLength（默认 8000）的文本截断并标记
 * 5. **Unicode 净化** — 移除零宽字符、方向控制符等危险 Unicode 序列
 *
 * 每一层都可以通过 `options` 中对应的 `skip*` 字段独立跳过。
 *
 * @param text - 待净化的原始文本
 * @param options - 净化选项（可选）
 * @returns 净化结果，包含净化后文本、执行的层列表和统计信息
 *
 * @example
 * ```typescript
 * const result = sanitizeForLLM(rawMessage, { maxLength: 4000 });
 * console.log(result.sanitized);
 * console.log(result.layersApplied); // ["pii", "path", "keyword", "truncation", "unicode"]
 * console.log(result.stats.piiRedacted); // 3
 * ```
 */
export function sanitizeForLLM(
  text: string,
  options: LLMSanitizeOptions = {},
): LLMSanitizationResult {
  const originalLength = text.length;
  const layersApplied: string[] = [];
  let current = text;

  let piiRedacted = 0;
  let pathsRedacted = 0;
  let keywordsFiltered = 0;
  let wasTruncated = false;

  // ── 第 1 层：PII 净化 ──
  if (!options.skipPII) {
    const piiResult = sanitizePII(current);
    if (piiResult.count > 0) {
      current = piiResult.text;
      piiRedacted = piiResult.count;
      layersApplied.push("pii");
    }
  }

  // ── 第 2 层：路径脱敏 ──
  if (!options.skipPathRedaction) {
    const pathResult = sanitizePathWithCount(current);
    if (pathResult.count > 0) {
      current = pathResult.text;
      pathsRedacted = pathResult.count;
      layersApplied.push("path");
    }
  }

  // ── 第 3 层：架构关键词过滤 ──
  if (!options.skipKeywordFilter) {
    const keywordResult = filterKeywordsWithCount(current);
    if (keywordResult.count > 0) {
      current = keywordResult.text;
      keywordsFiltered = keywordResult.count;
      layersApplied.push("keyword");
    }
  }

  // ── 第 4 层：文件内容截断 ──
  if (!options.skipTruncation) {
    const maxLength = options.maxLength ?? DEFAULT_TRUNCATE_LENGTH;
    if (current.length > maxLength) {
      current = truncateForLLM(current, maxLength);
      wasTruncated = true;
      layersApplied.push("truncation");
    }
  }

  // ── 第 5 层：Unicode 净化 ──
  if (!options.skipUnicode) {
    const beforeUnicode = current;
    current = sanitizeUnicode(current);
    if (current !== beforeUnicode) {
      layersApplied.push("unicode");
    }
  }

  return {
    sanitized: current,
    layersApplied,
    stats: {
      piiRedacted,
      pathsRedacted,
      keywordsFiltered,
      wasTruncated,
      originalLength,
      sanitizedLength: current.length,
    },
  };
}

/**
 * PII 脱敏 — 敏感信息自动脱敏。
 *
 * 参考 `代码片段_上下文记忆与通信协议` #55 PII 脱敏策略。
 *
 * 设计原则：
 * - 正则模式匹配常见 PII 类型
 * - 可配置的脱敏策略（mask/redact/hash）
 * - MCP 工具名脱敏（mcp__<server>__<tool> → mcp_tool）
 */

// ─── 脱敏策略 ───

export type RedactionStrategy = "mask" | "redact" | "hash";

// ─── PII 模式配置 ───

export interface PIIPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly strategy: RedactionStrategy;
  readonly maskChar?: string;
  readonly maskKeepStart?: number;
  readonly maskKeepEnd?: number;
}

// ─── 默认 PII 模式 ───

const DEFAULT_PII_PATTERNS: ReadonlyArray<PIIPattern> = [
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    strategy: "mask",
    maskChar: "*",
    maskKeepStart: 2,
    maskKeepEnd: 0,
  },
  {
    name: "phone",
    pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    strategy: "mask",
    maskChar: "*",
    maskKeepStart: 3,
    maskKeepEnd: 2,
  },
  {
    name: "ipv4",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    strategy: "mask",
    maskChar: "*",
    maskKeepStart: 4,
    maskKeepEnd: 0,
  },
  {
    name: "ipv6",
    pattern: /(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    strategy: "mask",
    maskChar: "*",
    maskKeepStart: 4,
    maskKeepEnd: 0,
  },
  {
    name: "api_key",
    pattern: /\b(?:sk|pk|api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?([^\s"',}]{8,})["']?/gi,
    strategy: "redact",
  },
  {
    name: "x_api_key_header",
    pattern: /x-api-key\s*[:=]\s*["']?([^\s"',}]{8,})["']?/gi,
    strategy: "redact",
  },
  {
    name: "authorization_header",
    pattern: /authorization\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+[^\s"',}]{8,}["']?/gi,
    strategy: "redact",
  },
  {
    name: "hmac_key",
    pattern: /\bhmac[_-]?(?:key|secret)\s*[:=]\s*["']?([^\s"',}]{8,})["']?/gi,
    strategy: "redact",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    strategy: "mask",
    maskChar: "*",
    maskKeepStart: 7,
    maskKeepEnd: 4,
  },
  {
    name: "credit_card",
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    strategy: "mask",
    maskChar: "*",
    maskKeepStart: 0,
    maskKeepEnd: 4,
  },
  {
    name: "aws_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    strategy: "redact",
  },
  {
    name: "chinese_phone",
    pattern: /1[3-9]\d{9}\b/g,
    strategy: "mask",
    maskChar: "*",
    maskKeepStart: 3,
    maskKeepEnd: 2,
  },
  {
    name: "chinese_id",
    pattern: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
    strategy: "mask",
    maskChar: "*",
    maskKeepStart: 3,
    maskKeepEnd: 2,
  },
];

// ─── PII 脱敏器配置 ───

export interface PIISanitizerConfig {
  /** 自定义 PII 模式（追加到默认模式） */
  readonly customPatterns?: ReadonlyArray<PIIPattern>;
  /** 是否使用默认模式 */
  readonly useDefaults?: boolean;
}

// ─── PII 脱敏结果 ───

export interface PIISanitizationResult {
  readonly sanitized: string;
  readonly redactionCount: number;
  readonly redactedTypes: ReadonlyArray<string>;
}

// ─── 脱敏函数 ───

function applyStrategy(
  match: string,
  pattern: PIIPattern,
): string {
  switch (pattern.strategy) {
    case "redact":
      return "[REDACTED]";
    case "hash": {
      // 简单哈希（非加密用途）
      let hash = 0;
      for (let i = 0; i < match.length; i++) {
        const char = match.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // 32-bit int
      }
      return `[HASH:${Math.abs(hash).toString(16)}]`;
    }
    case "mask": {
      const keepStart = pattern.maskKeepStart ?? 0;
      const keepEnd = pattern.maskKeepEnd ?? 0;
      const maskChar = pattern.maskChar ?? "*";

      if (match.length <= keepStart + keepEnd) {
        return match;
      }

      const start = match.slice(0, keepStart);
      const end = match.slice(-keepEnd);
      const maskedLen = match.length - keepStart - keepEnd;
      return `${start}${maskChar.repeat(maskedLen)}${end}`;
    }
  }
}

// ─── 创建 PII 脱敏器 ───

export function createPIISanitizer(config?: PIISanitizerConfig) {
  const useDefaults = config?.useDefaults ?? true;
  const customPatterns = config?.customPatterns ?? [];
  const patterns = useDefaults
    ? [...DEFAULT_PII_PATTERNS, ...customPatterns]
    : [...customPatterns];

  function sanitize(text: string): PIISanitizationResult {
    let result = text;
    let redactionCount = 0;
    const redactedTypes: string[] = [];

    for (const pii of patterns) {
      // 重置 lastIndex（全局正则）
      pii.pattern.lastIndex = 0;

      const matches = result.match(pii.pattern);
      if (matches && matches.length > 0) {
        redactionCount += matches.length;
        if (!redactedTypes.includes(pii.name)) {
          redactedTypes.push(pii.name);
        }
        result = result.replace(pii.pattern, (match) => applyStrategy(match, pii));
      }
    }

    return { sanitized: result, redactionCount, redactedTypes };
  }

  /** MCP 工具名脱敏 */
  function sanitizeToolName(toolName: string): string {
    if (toolName.startsWith("mcp__")) {
      return "mcp_tool";
    }
    return toolName;
  }

  return { sanitize, sanitizeToolName, patterns };
}

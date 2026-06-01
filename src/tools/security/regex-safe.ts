/**
 * ReDoS 安全分析器 — 防御正则表达式拒绝服务。
 *
 * 基于安全最佳实践的 ReDoS 防御设计。
 * 核心算法：词法分析 + 嵌套重复检测。
 *
 * 安全策略：检测到嵌套重复或模糊交替 + 无界量词 → 拒绝编译。
 */

// ─── 类型定义 ───

export interface SafeRegexCompileResult {
  readonly regex: RegExp | null;
  readonly source: string;
  readonly flags: string;
  readonly reason: string | null;
}

// ─── 常量 ───

const SAFE_REGEX_CACHE_MAX = 256;

// ─── LRU 缓存 ───

const safeRegexCache = new Map<string, SafeRegexCompileResult>();

// ─── 词法分析 ───

/** Token 类型 */
const TokenType = {
  SIMPLE: "simple",
  GROUP_OPEN: "group_open",
  GROUP_CLOSE: "group_close",
  ALTERNATION: "alternation",
  QUANTIFIER: "quantifier",
} as const;

type TokenType = (typeof TokenType)[keyof typeof TokenType];

interface PatternToken {
  kind: TokenType;
  minLength: number;
  maxLength: number;
  containsRepetition: boolean;
  hasAmbiguousAlternation: boolean;
  quantifier?: {
    minRepeat: number;
    maxRepeat: number | null; // null = unbounded
  };
}

interface ParseFrame {
  lastToken: PatternToken | null;
  containsRepetition: boolean;
  hasAmbiguousAlternation: boolean;
}

function createParseFrame(): ParseFrame {
  return {
    lastToken: null,
    containsRepetition: false,
    hasAmbiguousAlternation: false,
  };
}

function multiplyLength(length: number, factor: number): number {
  if (factor === 0) return 0;
  if (length >= 1000 || factor >= 1000) return Number.POSITIVE_INFINITY;
  return length * factor;
}

// ─── 词法分析器 ───

/**
 * tokenizePattern — 将正则表达式拆分为 token 流。
 */
function tokenizePattern(source: string): PatternToken[] {
  const tokens: PatternToken[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i] ?? "";

    // 转义字符 → simple token
    if (ch === "\\") {
      i += 2; // 跳过转义序列
      tokens.push({
        kind: TokenType.SIMPLE,
        minLength: 1,
        maxLength: 1,
        containsRepetition: false,
        hasAmbiguousAlternation: false,
      });
      continue;
    }

    // 量词
    if (ch === "*" || ch === "+" || ch === "?") {
      const prev = tokens[tokens.length - 1];
      if (prev !== undefined) {
        const minRepeat = ch === "+" ? 1 : 0;
        const maxRepeat = ch === "?" ? 1 : null;
        tokens.push({
          kind: TokenType.QUANTIFIER,
          minLength: 0,
          maxLength: Number.POSITIVE_INFINITY,
          containsRepetition: true,
          hasAmbiguousAlternation: false,
          quantifier: { minRepeat, maxRepeat },
        });
      }
      i++;
      continue;
    }

    // 花括号量词 {n,m}
    if (ch === "{") {
      const closeIndex = source.indexOf("}", i);
      if (closeIndex !== -1) {
        const prev = tokens[tokens.length - 1];
        if (prev !== undefined) {
          const rangeStr = source.slice(i + 1, closeIndex);
          const parts = rangeStr.split(",");
          const minRepeat = parseInt(parts[0] ?? "0", 10) || 0;
          const maxRepeat = parts[1] !== undefined
            ? (parseInt(parts[1], 10) || 0)
            : null;
          tokens.push({
            kind: TokenType.QUANTIFIER,
            minLength: 0,
            maxLength: Number.POSITIVE_INFINITY,
            containsRepetition: true,
            hasAmbiguousAlternation: false,
            quantifier: { minRepeat, maxRepeat },
          });
        }
        i = closeIndex + 1;
        continue;
      }
    }

    // 分组开始
    if (ch === "(") {
      // 跳过非捕获组前缀 (?:
      if (source[i + 1] === "?" && source[i + 2] === ":") {
        i += 3;
      } else {
        i++;
      }
      tokens.push({
        kind: TokenType.GROUP_OPEN,
        minLength: 0,
        maxLength: Number.POSITIVE_INFINITY,
        containsRepetition: false,
        hasAmbiguousAlternation: false,
      });
      continue;
    }

    // 分组结束
    if (ch === ")") {
      tokens.push({
        kind: TokenType.GROUP_CLOSE,
        minLength: 0,
        maxLength: Number.POSITIVE_INFINITY,
        containsRepetition: false,
        hasAmbiguousAlternation: false,
      });
      i++;
      continue;
    }

    // 交替
    if (ch === "|") {
      tokens.push({
        kind: TokenType.ALTERNATION,
        minLength: 0,
        maxLength: Number.POSITIVE_INFINITY,
        containsRepetition: false,
        hasAmbiguousAlternation: true,
      });
      i++;
      continue;
    }

    // 简单字符
    tokens.push({
      kind: TokenType.SIMPLE,
      minLength: 1,
      maxLength: 1,
      containsRepetition: false,
      hasAmbiguousAlternation: false,
    });
    i++;
  }

  return tokens;
}

// ─── 嵌套重复检测 ───

/**
 * analyzeTokensForNestedRepetition — 检测嵌套重复模式。
 *
 * 使用栈式帧分析，跟踪每个 token 的最小/最大长度和是否包含重复。
 * 当重复的 token/group 再次被重复时（如 (a+)+），返回 true。
 */
function analyzeTokensForNestedRepetition(tokens: PatternToken[]): boolean {
  const frames: ParseFrame[] = [createParseFrame()];

  for (const token of tokens) {
    if (token.kind === TokenType.QUANTIFIER) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) continue;

      const previousToken = frame.lastToken;
      if (previousToken === null) continue;

      // UNSAFE: 被重复的 token 本身包含重复（如 (a+)+）
      if (previousToken.containsRepetition) return true;

      // UNSAFE: 模糊交替 + 无界量词（如 (a|ab)*）
      if (
        previousToken.hasAmbiguousAlternation &&
        token.quantifier?.maxRepeat === null
      ) {
        return true;
      }

      // 更新长度跟踪
      if (token.quantifier === undefined) continue;
      previousToken.minLength = multiplyLength(
        previousToken.minLength,
        token.quantifier.minRepeat,
      );
      previousToken.maxLength =
        token.quantifier.maxRepeat === null
          ? Number.POSITIVE_INFINITY
          : multiplyLength(previousToken.maxLength, token.quantifier.maxRepeat);
      previousToken.containsRepetition = true;
      frame.containsRepetition = true;
    } else if (token.kind === TokenType.GROUP_OPEN) {
      frames.push(createParseFrame());
    } else if (token.kind === TokenType.GROUP_CLOSE) {
      if (frames.length > 1) {
        const closedFrame = frames.pop();
        const parentFrame = frames[frames.length - 1];
        if (parentFrame !== undefined && closedFrame !== undefined) {
          parentFrame.lastToken = {
            kind: TokenType.SIMPLE,
            minLength: closedFrame.containsRepetition ? 0 : 0,
            maxLength: Number.POSITIVE_INFINITY,
            containsRepetition: closedFrame.containsRepetition,
            hasAmbiguousAlternation: closedFrame.hasAmbiguousAlternation,
          };
        }
      }
    } else if (token.kind === TokenType.ALTERNATION) {
      const frame = frames[frames.length - 1];
      if (frame !== undefined) {
        frame.hasAmbiguousAlternation = true;
      }
    } else {
      // SIMPLE token
      const frame = frames[frames.length - 1];
      if (frame !== undefined) {
        frame.lastToken = token;
      }
    }
  }

  return false;
}

/**
 * hasNestedRepetition — 快速检查正则是否包含嵌套重复。
 */
function hasNestedRepetition(source: string): boolean {
  const tokens = tokenizePattern(source);
  return analyzeTokensForNestedRepetition(tokens);
}

// ─── 主函数 ───

/**
 * compileSafeRegex — 安全编译正则表达式。
 *
 * 先检查嵌套重复（ReDoS 防御），通过后再编译为 RegExp。
 * 结果带 LRU 缓存（最多 256 条）。
 *
 * @param source - 正则表达式源码
 * @param flags - 正则标志
 * @returns SafeRegexCompileResult — regex 为 null 表示不安全
 */
export function compileSafeRegex(
  source: string,
  flags = "",
): SafeRegexCompileResult {
  const trimmed = source.trim();
  if (!trimmed) {
    return { regex: null, source: trimmed, flags, reason: "empty" };
  }

  const cacheKey = `${flags}::${trimmed}`;
  const cached = safeRegexCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: SafeRegexCompileResult;

  if (hasNestedRepetition(trimmed)) {
    result = {
      regex: null,
      source: trimmed,
      flags,
      reason: "unsafe-nested-repetition",
    };
  } else {
    try {
      result = {
        regex: new RegExp(trimmed, flags),
        source: trimmed,
        flags,
        reason: null,
      };
    } catch {
      result = {
        regex: null,
        source: trimmed,
        flags,
        reason: "invalid-regex",
      };
    }
  }

  safeRegexCache.set(cacheKey, result);

  // LRU 淘汰
  if (safeRegexCache.size > SAFE_REGEX_CACHE_MAX) {
    const oldestKey = safeRegexCache.keys().next().value;
    if (oldestKey !== undefined) {
      safeRegexCache.delete(oldestKey);
    }
  }

  return result;
}

/**
 * clearRegexCache — 清除正则缓存（用于测试）。
 */
export function clearRegexCache(): void {
  safeRegexCache.clear();
}

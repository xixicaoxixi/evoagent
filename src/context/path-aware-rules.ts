/**
 * 路径感知规则加载引擎。
 *
 * 根据当前处理的文件路径动态选择加载哪些规则/skills，
 * 而非全量加载，显著节省上下文窗口。
 *
 * 设计原则：
 * - 全局规则（无 scope）始终加载
 * - 有 scope 的规则仅在匹配当前文件路径时加载
 * - 记录路径感知加载节省的 token 数量
 * - 支持 glob 模式匹配（**、*、?）
 */

import { estimateTokens } from "../types/common";

// ─── 规则定义 ───

/** 单条规则的定义 */
export interface ScopedRule {
  /** 规则唯一标识 */
  readonly id: string;
  /** 规则内容（注入到上下文的文本） */
  readonly content: string;
  /**
   * 路径范围（glob 模式）。
   *
   * - undefined 或空数组：全局规则，始终加载
   * - 非空数组：仅在匹配任一模式时加载
   *
   * 示例：["src/security/**", "src/auth/**"]
   */
  readonly scope?: readonly string[];
  /** 规则优先级（数字越小优先级越高） */
  readonly priority?: number;
  /** 规则来源（用于调试和审计） */
  readonly source?: string;
}

// ─── 过滤结果 ───

export interface RuleFilterResult {
  /** 匹配的规则列表（按优先级排序） */
  readonly matchedRules: readonly ScopedRule[];
  /** 被过滤掉的规则数量 */
  readonly filteredCount: number;
  /** 匹配的规则数量 */
  readonly matchedCount: number;
  /** 总规则数量 */
  readonly totalCount: number;
  /** 估算节省的 token 数量 */
  readonly savedTokens: number;
  /** 匹配的规则总 token 数 */
  readonly matchedTokens: number;
}

// ─── 引擎统计 ───

export interface PathAwareStats {
  /** 总规则数 */
  readonly totalRules: number;
  /** 全局规则数 */
  readonly globalRules: number;
  /** 有 scope 的规则数 */
  readonly scopedRules: number;
  /** 累计节省的 token 数 */
  readonly totalSavedTokens: number;
  /** 累计过滤次数 */
  readonly filterCount: number;
}

// ─── 路径感知规则引擎 ───

export interface PathAwareRuleEngine {
  /** 注册规则 */
  addRule(rule: ScopedRule): void;
  /** 批量注册规则 */
  addRules(rules: readonly ScopedRule[]): void;
  /** 移除规则 */
  removeRule(id: string): boolean;
  /** 获取所有规则 */
  getAllRules(): readonly ScopedRule[];
  /** 根据文件路径过滤规则 */
  filterForPath(filePath: string): RuleFilterResult;
  /** 根据多个文件路径过滤规则（任一匹配即可） */
  filterForPaths(filePaths: readonly string[]): RuleFilterResult;
  /** 获取统计信息 */
  getStats(): PathAwareStats;
  /** 重置统计 */
  resetStats(): void;
  /** 清空所有规则 */
  clear(): void;
}

// ─── 创建路径感知规则引擎 ───

export function createPathAwareRuleEngine(): PathAwareRuleEngine {
  const rules = new Map<string, ScopedRule>();
  let totalSavedTokens = 0;
  let filterCount = 0;

  function addRule(rule: ScopedRule): void {
    rules.set(rule.id, rule);
  }

  function addRules(newRules: readonly ScopedRule[]): void {
    for (const rule of newRules) {
      rules.set(rule.id, rule);
    }
  }

  function removeRule(id: string): boolean {
    return rules.delete(id);
  }

  function getAllRules(): readonly ScopedRule[] {
    return [...rules.values()];
  }

  function filterForPath(filePath: string): RuleFilterResult {
    return filterForPaths([filePath]);
  }

  function filterForPaths(filePaths: readonly string[]): RuleFilterResult {
    filterCount++;

    const allRules = [...rules.values()];
    const matched: ScopedRule[] = [];
    let filteredTokens = 0;
    let matchedTokens = 0;

    for (const rule of allRules) {
      const ruleTokens = estimateTokens(rule.content);

      if (rule.scope === undefined || rule.scope.length === 0) {
        // 全局规则 — 始终匹配
        matched.push(rule);
        matchedTokens += ruleTokens;
      } else if (matchesAnyPath(filePaths, rule.scope)) {
        // 有 scope 且匹配
        matched.push(rule);
        matchedTokens += ruleTokens;
      } else {
        // 有 scope 但不匹配 — 过滤掉
        filteredTokens += ruleTokens;
      }
    }

    // 按优先级排序（数字越小越靠前）
    matched.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    totalSavedTokens += filteredTokens;

    return {
      matchedRules: matched,
      filteredCount: allRules.length - matched.length,
      matchedCount: matched.length,
      totalCount: allRules.length,
      savedTokens: filteredTokens,
      matchedTokens,
    };
  }

  function getStats(): PathAwareStats {
    const allRules = [...rules.values()];
    let globalRules = 0;
    let scopedRules = 0;

    for (const rule of allRules) {
      if (rule.scope === undefined || rule.scope.length === 0) {
        globalRules++;
      } else {
        scopedRules++;
      }
    }

    return {
      totalRules: allRules.length,
      globalRules,
      scopedRules,
      totalSavedTokens,
      filterCount,
    };
  }

  function resetStats(): void {
    totalSavedTokens = 0;
    filterCount = 0;
  }

  function clear(): void {
    rules.clear();
    totalSavedTokens = 0;
    filterCount = 0;
  }

  return {
    addRule,
    addRules,
    removeRule,
    getAllRules,
    filterForPath,
    filterForPaths,
    getStats,
    resetStats,
    clear,
  };
}

// ─── 路径匹配 ───

/**
 * 检查文件路径是否匹配任一 glob 模式。
 */
function matchesAnyPath(
  filePaths: readonly string[],
  patterns: readonly string[],
): boolean {
  for (const filePath of filePaths) {
    for (const pattern of patterns) {
      if (matchGlob(filePath, pattern)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 简易 glob 匹配。
 *
 * 支持：
 * - `**` 匹配任意多级目录
 * - `*` 匹配单级内任意字符（不含 /）
 * - `?` 匹配单个字符
 * - 前缀匹配（`src/security` 匹配 `src/security/auth.ts`）
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // 规范化路径分隔符
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  // 转换 glob 模式为正则表达式
  const regexStr = globToRegex(normalizedPattern);

  try {
    const regex = new RegExp(regexStr);
    return regex.test(normalizedPath);
  } catch {
    return false;
  }
}

/**
 * 将 glob 模式转换为正则表达式字符串。
 *
 * 使用占位符避免替换顺序冲突。
 */
function globToRegex(pattern: string): string {
  const GLOBSTAR = "\x00GLOBSTAR\x00";
  const SINGLESTAR = "\x00SINGLESTAR\x00";

  // 转义正则特殊字符（保留 * 和 ?）
  let result = "";
  for (const char of pattern) {
    switch (char) {
      case ".":
      case "+":
      case "(":
      case ")":
      case "[":
      case "]":
      case "{":
      case "}":
      case "^":
      case "$":
      case "|":
      case "\\":
        result += `\\${char}`;
        break;
      case "*":
        result += char;
        break;
      case "?":
        result += "[^/]";
        break;
      default:
        result += char;
    }
  }

  // 先用占位符替换 ** 和 *，避免后续替换冲突
  result = result.replace(/\*\*/g, GLOBSTAR);
  result = result.replace(/\*/g, SINGLESTAR);

  // **/ → 匹配零或多级目录前缀
  result = result.replace(new RegExp(GLOBSTAR.replace(/\x00/g, "\\x00"), "g"), ".*");

  // * → 匹配单级内任意字符（不含 /）
  result = result.replace(new RegExp(SINGLESTAR.replace(/\x00/g, "\\x00"), "g"), "[^/]*");

  // 确保匹配完整路径或路径前缀
  return `(^|/)${result}(/|$)`;
}

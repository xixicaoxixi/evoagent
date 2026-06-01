/**
 * sed 命令安全验证器 — 白名单/黑名单双层策略。
 *
 * 基于安全最佳实践的 sed 命令验证设计。
 * 白名单：仅允许行打印和替换命令。
 * 黑名单：检测写文件、执行命令、Unicode 同形字攻击等。
 *
 * 安全策略：不在白名单中的命令一律拒绝（Fail-Closed）。
 */

// ─── sed 表达式提取 ───

/**
 * extractSedExpressions — 从 sed 命令中提取表达式。
 *
 * 处理 -e 'expr' 和直接 'expr' 两种形式。
 */
function extractSedExpressions(command: string): string[] {
  const expressions: string[] = [];
  const args = command.split(/\s+/);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    // 跳过命令名（第一个参数）
    if (i === 0) continue;

    if (arg === "-e") {
      const expr = args[i + 1];
      if (expr !== undefined) {
        expressions.push(stripQuotes(expr));
        i++;
      }
      continue;
    }

    // 跳过标志和文件参数
    if (arg.startsWith("-") || arg === "--") {
      continue;
    }

    // 第一个非标志参数可能是表达式（去除引号后再检查）
    if (expressions.length === 0 && looksLikeSedExpression(stripQuotes(arg))) {
      expressions.push(stripQuotes(arg));
    }
  }

  return expressions;
}

/**
 * 去除字符串两端的引号（单引号或双引号）。
 */
function stripQuotes(s: string): string {
  if (s.length >= 2) {
    if (
      (s[0] === "'" && s[s.length - 1] === "'") ||
      (s[0] === '"' && s[s.length - 1] === '"')
    ) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * 判断字符串是否看起来像 sed 表达式。
 */
function looksLikeSedExpression(s: string): boolean {
  // s/pattern/replacement/flags
  if (/^s[^\\\n]/.test(s)) return true;
  // Np（行打印）
  if (/^\d+p$/.test(s)) return true;
  // -n 配合 p
  if (/^-n/.test(s)) return true;
  return false;
}

// ─── 白名单检查 ───

/**
 * isLinePrintingCommand — 检查是否是行打印命令。
 *
 * 仅允许: sed -n 'Np' 形式（打印第 N 行）。
 */
function isLinePrintingCommand(
  command: string,
  expressions: readonly string[],
): boolean {
  if (!command.includes("-n")) return false;

  for (const expr of expressions) {
    // 仅允许数字 + p（如 5p, 10p, $p）
    if (/^\d+p$/.test(expr) || /^\$p$/.test(expr)) {
      return true;
    }
  }

  return false;
}

/** 允许的替换标志 */
const ALLOWED_SUBSTITUTION_FLAGS = new Set([
  "g", "p", "i", "I", "m", "M",
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);

/**
 * isSubstitutionCommand — 检查是否是安全的替换命令。
 *
 * 仅允许: sed 's/pattern/replacement/flags' 形式。
 * 标志严格限制为 g, p, i, I, m, M, 1-9。
 */
function isSubstitutionCommand(
  command: string,
  expressions: readonly string[],
  options?: { allowFileWrites?: boolean },
): boolean {
  for (const expr of expressions) {
    if (!expr.startsWith("s")) continue;

    // 提取分隔符
    const delimiter = expr[1];
    if (delimiter === undefined || /[\n\\]/.test(delimiter)) return false;

    // 找到各部分
    const parts = splitSedExpression(expr, delimiter);
    if (parts === null) return false;
    const [, , flags] = parts;

    // 验证标志
    if (flags !== undefined && flags !== "") {
      for (const flag of flags) {
        if (!ALLOWED_SUBSTITUTION_FLAGS.has(flag)) {
          return false;
        }
        // w 标志不允许（写文件）
        if (flag === "w" || flag === "W") return false;
      }
    }
  }

  return true;
}

/**
 * 分割 sed 表达式为 [pattern, replacement, flags]。
 */
function splitSedExpression(
  expr: string,
  delimiter: string,
): readonly [string, string, string] | null {
  const parts: string[] = [];
  let current = "";
  let escaped = false;

  // 跳过开头的 s 和分隔符
  for (let i = 2; i < expr.length; i++) {
    const ch = expr[i] ?? "";

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === delimiter) {
      parts.push(current);
      current = "";
      if (parts.length === 3) {
        // 剩余部分是标志
        parts.push(expr.slice(i + 1));
        break;
      }
      continue;
    }

    current += ch;
  }

  if (parts.length < 2) return null;
  // 补齐缺失的部分
  while (parts.length < 3) {
    parts.push("");
  }

  return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""];
}

// ─── 黑名单检查 ───

/**
 * containsDangerousOperations — 检测危险操作。
 *
 * 黑名单检测：
 * - 非 ASCII 字符（Unicode 同形字攻击）
 * - 花括号块
 * - 换行符
 * - 注释
 * - 否定操作符
 * - 危险写命令 (w/W)
 * - 危险执行命令 (e/E)
 */
function containsDangerousOperations(expression: string): boolean {
  const cmd = expression.trim();
  if (!cmd) return false;

  // 拒绝非 ASCII（Unicode 同形字攻击）
  if (/[^\x01-\x7F]/.test(cmd)) return true;

  // 拒绝花括号（块）
  if (cmd.includes("{") || cmd.includes("}")) return true;

  // 拒绝换行
  if (cmd.includes("\n")) return true;

  // 拒绝注释（# 不紧跟在 s 后面）
  const hashIndex = cmd.indexOf("#");
  if (hashIndex !== -1 && !(hashIndex > 0 && cmd[hashIndex - 1] === "s")) {
    return true;
  }

  // 拒绝否定操作符
  if (/^!/.test(cmd) || /[/\d$]!/.test(cmd)) return true;

  // 拒绝危险写命令 (w/W)
  if (/^[wW]\s*\S+/.test(cmd)) return true;
  if (/^\d+\s*[wW]\s*\S+/.test(cmd)) return true;

  // 拒绝危险执行命令 (e/E)
  if (/^e\b/.test(cmd)) return true;
  if (/^\d+\s*e\b/.test(cmd)) return true;

  // 检查替换命令中的危险标志
  const substitutionMatch = cmd.match(/s([^\\\n]).*?\1.*?\1(.*?)$/);
  if (substitutionMatch !== null) {
    const flags = substitutionMatch[2] ?? "";
    if (flags.includes("w") || flags.includes("W")) return true;
    if (flags.includes("e") || flags.includes("E")) return true;
  }

  return false;
}

// ─── 主验证函数 ───

/**
 * sedCommandIsAllowed — sed 命令安全验证入口。
 *
 * 双层策略：
 * 1. 白名单检查：仅允许行打印和替换命令
 * 2. 黑名单检查：即使白名单通过，仍检查危险操作
 *
 * @param command - 完整的 sed 命令字符串
 * @param options - 配置选项
 * @returns true 表示命令安全，false 表示拒绝
 */
export function sedCommandIsAllowed(
  command: string,
  options?: { allowFileWrites?: boolean },
): boolean {
  let expressions: string[];
  try {
    expressions = extractSedExpressions(command);
  } catch {
    return false;
  }

  if (expressions.length === 0) return false;

  const isPattern1 = isLinePrintingCommand(command, expressions);
  const isPattern2 = isSubstitutionCommand(command, expressions, options);

  if (!isPattern1 && !isPattern2) return false;

  // Pattern 2 不允许分号（命令分隔符）
  for (const expr of expressions) {
    if (isPattern2 && expr.includes(";")) return false;
  }

  // 纵深防御：即使白名单通过，仍检查黑名单
  for (const expr of expressions) {
    if (containsDangerousOperations(expr)) return false;
  }

  return true;
}

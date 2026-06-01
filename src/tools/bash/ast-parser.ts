/**
 * AST 安全解析器 — Bash 命令的静态安全分析。
 *
 * 基于安全最佳实践的 AST 安全解析设计。
 * 不依赖 tree-sitter（避免 native 依赖），使用正则+状态机实现轻量级解析。
 *
 * 安全策略：无法静态分析的命令一律返回 too-complex → ask_user（Fail-Closed）。
 */

// ─── 解析结果类型 ───

/** 简单命令（叶子节点） */
export interface SimpleCommand {
  readonly text: string;
  readonly args: readonly string[];
  readonly redirects: readonly string[];
}

/** AST 解析结果 — Discriminated Union */
export type ParseForSecurityResult =
  | { readonly kind: "simple"; readonly commands: readonly SimpleCommand[] }
  | { readonly kind: "too-complex"; readonly reason: string };

// ─── 预检查正则 ───

/** 控制字符（0x00-0x1F 除 \t\n） */
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

/** Unicode 空白（非标准空白字符） */
const UNICODE_WHITESPACE_RE = /[\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/** 反斜杠转义空白 */
const BACKSLASH_WHITESPACE_RE = /\\\s/;

/** zsh ~[ 动态目录语法 */
const ZSH_TILDE_BRACKET_RE = /~\[/;

/** zsh =cmd 等号展开 */
const ZSH_EQUALS_EXPANSION_RE = /(?:^|\s)=(?=\S)/;

/** 花括号+引号（展开混淆） */
const BRACE_WITH_QUOTE_RE = /\{[^}]*['"][^}]*\}/;

/** 危险语义关键词 */
const DANGEROUS_SEMANTICS_RE =
  /\b(?:eval|exec|source|\.\s|bash\s+-c|sh\s+-c|zsh\s+-c|ksh\s+-c)\b/i;

/** 命令替换 $(...) 或反引号 */
const COMMAND_SUBSTITUTION_RE = /\$\(|`[^`]*`/;

/** 进程替换 <(...) 或 >(...) */
const PROCESS_SUBSTITUTION_RE = /[<>]\(/;

/** Here-string <<< */
const HERE_STRING_RE = /<<</;

/** Here-document << */
const HERE_DOC_RE = /<<-?\s*['"]?\w+['"]?/;

/** 算术展开 $((...)) 或 $[...] */
const ARITH_EXPANSION_RE = /\$\(\(|\$\[/;

// ─── 预检查函数 ───

/**
 * 执行 AST 前预检查。
 * 检测 tree-sitter 和 bash 对词边界理解不一致的情况。
 * 任何预检查失败 → too-complex（Fail-Closed）。
 */
function runPreChecks(cmd: string): ParseForSecurityResult | null {
  if (CONTROL_CHAR_RE.test(cmd)) {
    return { kind: "too-complex", reason: "Contains control characters" };
  }
  if (UNICODE_WHITESPACE_RE.test(cmd)) {
    return { kind: "too-complex", reason: "Contains Unicode whitespace" };
  }
  if (BACKSLASH_WHITESPACE_RE.test(cmd)) {
    return {
      kind: "too-complex",
      reason: "Contains backslash-escaped whitespace",
    };
  }
  if (ZSH_TILDE_BRACKET_RE.test(cmd)) {
    return {
      kind: "too-complex",
      reason: "Contains zsh ~[ dynamic directory syntax",
    };
  }
  if (ZSH_EQUALS_EXPANSION_RE.test(cmd)) {
    return {
      kind: "too-complex",
      reason: "Contains zsh =cmd equals expansion",
    };
  }
  if (BRACE_WITH_QUOTE_RE.test(cmd)) {
    return {
      kind: "too-complex",
      reason: "Contains brace with quote character (expansion obfuscation)",
    };
  }
  return null;
}

// ─── 轻量级命令解析器 ───

/**
 * Shell 元字符集合。
 * 这些字符在 shell 中有特殊含义，用于分割命令和参数。
 */
const SHELL_META_CHARS = new Set([
  " ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">", "$", "`", "\\", '"', "'",
]);

/**
 * 检查字符是否是 shell 元字符。
 */
function isMetaChar(ch: string): boolean {
  return SHELL_META_CHARS.has(ch);
}

/**
 * 简单的 shell 词分割。
 * 处理单引号、双引号、转义字符。
 * 不处理变量展开、命令替换等（这些在预检查阶段已被拒绝）。
 */
function splitShellWords(cmd: string): string[] {
  const words: string[] = [];
  let current = "";
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (i < cmd.length) {
    const ch = cmd[i] ?? "";

    if (inSingleQuote) {
      if (ch === "'") {
        inSingleQuote = false;
      } else {
        current += ch;
      }
      i++;
      continue;
    }

    if (inDoubleQuote) {
      if (ch === '"') {
        inDoubleQuote = false;
      } else if (ch === "\\" && i + 1 < cmd.length) {
        current += cmd[i + 1] ?? "";
        i += 2;
        continue;
      } else {
        current += ch;
      }
      i++;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      i++;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < cmd.length) {
      current += cmd[i + 1] ?? "";
      i += 2;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n") {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      i++;
      continue;
    }

    // 注释字符（未引用的 #）
    if (ch === "#" && current.length === 0) {
      break;
    }

    current += ch;
    i++;
  }

  if (current.length > 0) {
    words.push(current);
  }

  return words;
}

/**
 * 按操作符分割命令链。
 * 支持 ; && || | 分割，返回独立的命令字符串。
 */
function splitCommandChain(cmd: string): string[] {
  const commands: string[] = [];
  let current = "";
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (i < cmd.length) {
    const ch = cmd[i] ?? "";

    if (inSingleQuote) {
      current += ch;
      if (ch === "'") {
        inSingleQuote = false;
      }
      i++;
      continue;
    }

    if (inDoubleQuote) {
      current += ch;
      if (ch === '"') {
        inDoubleQuote = false;
      } else if (ch === "\\" && i + 1 < cmd.length) {
        current += cmd[i + 1] ?? "";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "'") {
      current += ch;
      inSingleQuote = true;
      i++;
      continue;
    }

    if (ch === '"') {
      current += ch;
      inDoubleQuote = true;
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < cmd.length) {
      current += cmd[i + 1] ?? "";
      i += 2;
      continue;
    }

    // 检测操作符
    if (ch === ";" || ch === "|" || ch === "&") {
      const next = cmd[i + 1] ?? "";
      if ((ch === "|" && next === "|") || (ch === "&" && next === "&")) {
        // || 或 && 操作符
        if (current.trim().length > 0) {
          commands.push(current.trim());
          current = "";
        }
        i += 2;
        continue;
      }
      // 单个 ; | &
      if (current.trim().length > 0) {
        commands.push(current.trim());
        current = "";
      }
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.trim().length > 0) {
    commands.push(current.trim());
  }

  return commands;
}

/**
 * 提取重定向目标。
 */
function extractRedirects(words: readonly string[]): string[] {
  const redirects: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;
    if (word === ">" || word === ">>" || word === "2>" || word === "2>>" || word === "&>") {
      const target = words[i + 1];
      if (target !== undefined) {
        redirects.push(target);
      }
    }
    // 处理 n>file 形式
    if (/^\d+>$/.test(word) || /^\d+>>$/.test(word)) {
      const target = words[i + 1];
      if (target !== undefined) {
        redirects.push(target);
      }
    }
  }
  return redirects;
}

/**
 * 从单个命令字符串构建 SimpleCommand。
 */
function buildSimpleCommand(cmdStr: string): SimpleCommand {
  const words = splitShellWords(cmdStr);
  const redirects = extractRedirects(words);
  // 过滤掉重定向操作符及其目标，保留实际命令参数
  const filteredArgs: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;
    if (
      word === ">" || word === ">>" || word === "2>" || word === "2>>" ||
      word === "&>" || /^\d+>$/.test(word) || /^\d+>>$/.test(word)
    ) {
      i++; // 跳过重定向目标
      continue;
    }
    filteredArgs.push(word);
  }
  return {
    text: cmdStr,
    args: filteredArgs,
    redirects,
  };
}

// ─── 主解析函数 ───

/**
 * analyzeBashAstForSecurity — Bash 命令安全解析。
 *
 * 不依赖 tree-sitter，使用正则+状态机实现轻量级解析。
 * 安全策略：无法静态分析的命令一律返回 too-complex → ask_user。
 *
 * @param cmd - 要解析的 Bash 命令字符串
 * @returns ParseForSecurityResult — simple（干净命令列表）或 too-complex
 */
export function analyzeBashAstForSecurity(
  cmd: string,
): ParseForSecurityResult {
  // 1. 预检查（控制字符、Unicode、zsh 特殊语法等）
  const preCheckResult = runPreChecks(cmd);
  if (preCheckResult !== null) {
    return preCheckResult;
  }

  const trimmed = cmd.trim();
  if (trimmed === "") {
    return { kind: "simple", commands: [] };
  }

  // 2. 检测危险 shell 特性（命令替换、进程替换、here-doc 等）
  // 注意：$(( 算术展开必须在 $( 命令替换之前检测
  if (ARITH_EXPANSION_RE.test(trimmed)) {
    return {
      kind: "too-complex",
      reason: "Contains arithmetic expansion $(() or $[",
    };
  }
  if (COMMAND_SUBSTITUTION_RE.test(trimmed)) {
    return {
      kind: "too-complex",
      reason: "Contains command substitution $(...) or backticks",
    };
  }
  if (PROCESS_SUBSTITUTION_RE.test(trimmed)) {
    return {
      kind: "too-complex",
      reason: "Contains process substitution <(...) or >(...)",
    };
  }
  if (HERE_STRING_RE.test(trimmed)) {
    return {
      kind: "too-complex",
      reason: "Contains here-string <<<",
    };
  }
  if (HERE_DOC_RE.test(trimmed)) {
    return {
      kind: "too-complex",
      reason: "Contains here-document <<",
    };
  }

  // 3. 按操作符分割命令链
  const commandStrs = splitCommandChain(trimmed);

  // 4. 构建简单命令列表
  const commands: SimpleCommand[] = commandStrs.map(buildSimpleCommand);

  return { kind: "simple", commands };
}

/**
 * analyzeBashSemantics — 语义级危险检查。
 *
 * 检测 eval、exec、source 等语义级危险操作。
 * 这些操作可以绕过 AST 级别的安全检查。
 */
export function analyzeBashSemantics(
  commands: readonly SimpleCommand[],
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  for (const cmd of commands) {
    const fullText = cmd.text;
    if (DANGEROUS_SEMANTICS_RE.test(fullText)) {
      return {
        ok: false,
        reason: `Command contains dangerous semantic pattern: ${fullText}`,
      };
    }
  }
  return { ok: true };
}

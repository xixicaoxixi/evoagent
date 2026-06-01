/**
 * 退出码语义解释 — 将非零退出码映射为语义化标注。
 *
 * Bash 工具将所有非零退出码视为错误，但部分退出码具有语义含义：
 * - grep=1 表示"未找到匹配"，不是错误
 * - diff=1 表示"文件有差异"，不是错误
 * - test=1 表示"条件不满足"，不是错误
 * - which/type=1 表示"未找到命令"，不是错误
 * - 通用码 2/126/127/130 也有明确语义
 *
 * 标注后模型可更准确判断是否需要重试。
 *
 * 规则 2-2: Fail-Closed 默认值。
 */

// ─── 语义退出码类型 ───

export type SemanticExitCode =
  | "no_match"
  | "has_diff"
  | "test_fail"
  | "not_found"
  | "misuse"
  | "interrupted"
  | "error";

// ─── 解释结果 ───

export interface ExitCodeInterpretation {
  readonly code: SemanticExitCode;
  readonly description: string;
  readonly isError: boolean;
}

// ─── 命令级非错误退出码映射 ───

function cmdEntry(
  cmd: string,
  entries: ReadonlyArray<readonly [number, ExitCodeInterpretation]>,
): readonly [string, ReadonlyMap<number, ExitCodeInterpretation>] {
  return [cmd, new Map(entries)] as const;
}

const COMMAND_SEMANTIC_CODES = new Map<string, ReadonlyMap<number, ExitCodeInterpretation>>([
  cmdEntry("grep", [
    [1, { code: "no_match", description: "grep found no matching lines", isError: false }],
  ]),
  cmdEntry("rg", [
    [1, { code: "no_match", description: "ripgrep found no matching lines", isError: false }],
  ]),
  cmdEntry("diff", [
    [1, { code: "has_diff", description: "diff found differences between files", isError: false }],
  ]),
  cmdEntry("test", [
    [1, { code: "test_fail", description: "test condition evaluated to false", isError: false }],
  ]),
  cmdEntry("[", [
    [1, { code: "test_fail", description: "test condition evaluated to false", isError: false }],
  ]),
  cmdEntry("type", [
    [1, { code: "not_found", description: "type: command not found", isError: false }],
  ]),
  cmdEntry("which", [
    [1, { code: "not_found", description: "which: no command found", isError: false }],
  ]),
  cmdEntry("command", [
    [1, { code: "not_found", description: "command not found", isError: false }],
  ]),
  cmdEntry("find", [
    [1, { code: "no_match", description: "find: no paths matched", isError: false }],
  ]),
  cmdEntry("fd", [
    [1, { code: "no_match", description: "fd: no paths matched", isError: false }],
  ]),
]);

// ─── 通用语义退出码（适用于所有命令） ───

const UNIVERSAL_SEMANTIC_CODES = new Map<number, ExitCodeInterpretation>([
  [2, { code: "misuse", description: "command misuse or syntax error", isError: true }],
  [126, { code: "misuse", description: "command not executable (permission denied)", isError: true }],
  [127, { code: "not_found", description: "command not found", isError: true }],
  [130, { code: "interrupted", description: "process interrupted by SIGINT (Ctrl+C)", isError: false }],
]);

// ─── 命令名提取 ───

const SKIP_PREFIXES = ["sudo", "time", "nice", "ionice", "strace", "ltrace", "nohup", "xargs"];

function skipPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && SKIP_PREFIXES.includes(tokens[i]!)) {
    i++;
  }
  return tokens.slice(i);
}

export function extractCommandName(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "";

  let tokens = trimmed.split(/\s+/);

  tokens = skipPrefixes(tokens);

  if (tokens.length > 0 && tokens[0] === "env") {
    let i = 1;
    while (i < tokens.length && tokens[i]!.includes("=")) {
      i++;
    }
    tokens = tokens.slice(i);
  }

  const firstToken = tokens[0] ?? "";
  const basename = firstToken.split("/").pop() ?? firstToken;

  if (basename.startsWith("-")) return "";

  return basename;
}

// ─── 主解释函数 ───

export function interpretExitCode(
  command: string,
  exitCode: number,
): ExitCodeInterpretation {
  if (exitCode === 0) {
    return { code: "error", description: "", isError: false };
  }

  if (exitCode < 0) {
    return { code: "error", description: "tool-level error (permission denied or timeout)", isError: true };
  }

  const commandName = extractCommandName(command);

  const commandMap = COMMAND_SEMANTIC_CODES.get(commandName);
  if (commandMap !== undefined) {
    const interpretation = commandMap.get(exitCode);
    if (interpretation !== undefined) {
      return interpretation;
    }
  }

  const universalInterpretation = UNIVERSAL_SEMANTIC_CODES.get(exitCode);
  if (universalInterpretation !== undefined) {
    return universalInterpretation;
  }

  return { code: "error", description: `exit code ${exitCode}`, isError: true };
}

export function isSemanticError(interpretation: ExitCodeInterpretation): boolean {
  return interpretation.isError;
}

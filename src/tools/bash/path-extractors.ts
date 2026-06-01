/**
 * 路径提取器 — 为 30+ 种命令定义路径提取逻辑。
 *
 * 基于安全最佳实践的路径提取器设计。
 * 每个提取器负责从命令参数中识别文件系统路径。
 *
 * 安全关键：filterOutFlags 正确处理 POSIX -- 分隔符，
 * 防止攻击者利用 `rm -- -/../.config` 绕过验证。
 */

import type { SimpleCommand } from "./ast-parser";

// ─── 路径命令类型 ───

/** 支持路径提取的命令名称 */
export type PathCommand =
  | "cd" | "ls" | "find" | "mkdir" | "touch" | "rm" | "rmdir"
  | "mv" | "cp" | "cat" | "head" | "tail" | "less" | "more"
  | "grep" | "rg" | "sed" | "awk" | "jq"
  | "git" | "docker" | "npm" | "bun" | "node"
  | "python" | "python3" | "sh" | "bash" | "zsh"
  | "chmod" | "chown" | "chgrp" | "ln" | "stat" | "file"
  | "wc" | "diff" | "patch" | "tar" | "zip" | "unzip"
  | "curl" | "wget";

/** 路径提取结果 */
export interface PathExtractionResult {
  readonly paths: readonly string[];
  readonly command: string;
}

// ─── 辅助函数 ───

/**
 * filterOutFlags — 安全过滤命令行标志。
 *
 * 正确处理 POSIX -- 分隔符：-- 之后的所有参数都被视为路径。
 * 防止攻击者利用 `rm -- -evil-file` 绕过验证。
 */
export function filterOutFlags(args: readonly string[]): string[] {
  const paths: string[] = [];
  let pastDoubleDash = false;

  for (const arg of args) {
    if (pastDoubleDash) {
      paths.push(arg);
      continue;
    }
    if (arg === "--") {
      pastDoubleDash = true;
      continue;
    }
    // 跳过标志（以 - 开头但不是路径）
    if (arg.startsWith("-")) {
      continue;
    }
    paths.push(arg);
  }

  return paths;
}

/**
 * parsePatternCommand — 处理 pattern + 路径结构的命令。
 *
 * 用于 grep/rg/jq 等命令，其中第一个非标志参数是 pattern，
 * 后续非标志参数是路径。
 */
function parsePatternCommand(
  args: readonly string[],
  flagSet: ReadonlySet<string>,
  defaultPath?: string[],
): string[] {
  const paths: string[] = [];
  let pastDoubleDash = false;
  let foundPattern = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (pastDoubleDash) {
      if (!foundPattern) {
        foundPattern = true;
        continue; // 第一个 -- 后的参数是 pattern
      }
      paths.push(arg);
      continue;
    }

    if (arg === "--") {
      pastDoubleDash = true;
      continue;
    }

    if (arg.startsWith("-")) {
      // 检查是否是带值的标志（如 -e pattern）
      if (flagSet.has(arg) && i + 1 < args.length) {
        i++; // 跳过标志值
      }
      continue;
    }

    if (!foundPattern) {
      foundPattern = true;
      continue; // 第一个非标志参数是 pattern
    }

    paths.push(arg);
  }

  if (paths.length === 0 && defaultPath !== undefined) {
    return [...defaultPath];
  }

  return paths;
}

// ─── 路径提取器映射 ───

/**
 * BASH_PATH_PATTERNS — 为每种命令定义路径提取逻辑。
 *
 * SECURITY: filterOutFlags 正确处理 -- 分隔符。
 * SECURITY: find 命令的 -- 处理防止标志注入。
 */
const BASH_PATH_PATTERNS: Record<string, (args: readonly string[]) => string[]> = {
  cd: (args) => args.length === 0 ? ["~"] : [args.join(" ")],
  ls: (args) => {
    const paths = filterOutFlags(args);
    return paths.length > 0 ? paths : ["."];
  },
  find: (args) => {
    // SECURITY: find -- -path makes -path a starting point (not a predicate)
    const paths: string[] = [];
    const pathFlags = new Set([
      "-newer", "-anewer", "-cnewer", "-mnewer",
      "-samefile", "-path", "-wholename",
      "-ilname", "-lname", "-ipath", "-iwholename",
      "-name", "-iname",
    ]);
    let pastDoubleDash = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;

      if (pastDoubleDash) {
        paths.push(arg);
        continue;
      }
      if (arg === "--") {
        pastDoubleDash = true;
        continue;
      }
      if (arg.startsWith("-")) {
        if (pathFlags.has(arg) && i + 1 < args.length) {
          i++; // 跳过路径标志的值
        }
        continue;
      }
      paths.push(arg);
    }

    return paths.length > 0 ? paths : ["."];
  },
  mkdir: filterOutFlags,
  touch: filterOutFlags,
  rm: filterOutFlags,
  rmdir: filterOutFlags,
  mv: (args) => filterOutFlags(args).slice(0, 2),
  cp: (args) => filterOutFlags(args).slice(0, 2),
  cat: filterOutFlags,
  head: filterOutFlags,
  tail: filterOutFlags,
  less: filterOutFlags,
  more: filterOutFlags,
  chmod: filterOutFlags,
  chown: filterOutFlags,
  chgrp: filterOutFlags,
  ln: (args) => filterOutFlags(args).slice(0, 2),
  stat: filterOutFlags,
  file: filterOutFlags,
  wc: filterOutFlags,
  diff: (args) => filterOutFlags(args).slice(0, 2),
  patch: filterOutFlags,
  tar: filterOutFlags,
  zip: filterOutFlags,
  unzip: filterOutFlags,
  grep: (args) => {
    const flags = new Set([
      "-e", "--regexp", "-f", "--file",
      "--exclude", "--include", "--exclude-dir", "--include-dir",
      "-m", "--max-count", "-A", "--after-context",
      "-B", "--before-context", "-C", "--context",
    ]);
    const paths = parsePatternCommand(args, flags);
    if (paths.length === 0 && args.some((a) => ["-r", "-R", "--recursive"].includes(a))) {
      return ["."];
    }
    return paths;
  },
  rg: (args) => {
    const flags = new Set([
      "-e", "--regexp", "-f", "--file",
      "-t", "--type", "-T", "--type-not",
      "-g", "--glob", "-m", "--max-count",
      "--max-depth", "-r", "--replace",
      "-A", "--after-context", "-B", "--before-context",
      "-C", "--context",
    ]);
    return parsePatternCommand(args, flags, ["."]);
  },
  sed: (args) => {
    // sed -e script -f scriptfile file...
    const paths: string[] = [];
    let pastDoubleDash = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;

      if (pastDoubleDash) {
        paths.push(arg);
        continue;
      }
      if (arg === "--") {
        pastDoubleDash = true;
        continue;
      }
      if (arg === "-e" || arg === "-f") {
        i++; // 跳过脚本参数
        continue;
      }
      if (arg === "-i" || arg.startsWith("-i")) {
        continue; // -in-place 标志
      }
      if (arg.startsWith("-")) {
        continue;
      }
      // 第一个非标志参数可能是脚本，后续是文件
      if (paths.length === 0 && arg.includes("/")) {
        // 看起来像文件路径（包含 /）
        paths.push(arg);
      } else if (paths.length > 0) {
        paths.push(arg);
      }
    }

    return paths;
  },
  awk: (args) => {
    const paths: string[] = [];
    let pastDoubleDash = false;
    let foundProgram = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;

      if (pastDoubleDash) {
        paths.push(arg);
        continue;
      }
      if (arg === "--") {
        pastDoubleDash = true;
        continue;
      }
      if (arg === "-f") {
        i++; // 跳过程序文件
        continue;
      }
      if (arg.startsWith("-")) {
        continue;
      }
      if (!foundProgram) {
        foundProgram = true;
        continue; // 第一个非标志参数是程序
      }
      paths.push(arg);
    }

    return paths;
  },
  jq: (args) => {
    const flags = new Set(["-f", "--file", "-L", "--indent", "--tab", "--raw-output"]);
    return parsePatternCommand(args, flags);
  },
  git: (args) => {
    // 仅 git diff --no-index 需要路径验证
    if (args.length >= 1 && args[0] === "diff") {
      if (args.includes("--no-index")) {
        const filePaths = filterOutFlags(args.slice(1));
        return filePaths.slice(0, 2);
      }
    }
    return [];
  },
  docker: filterOutFlags,
  npm: filterOutFlags,
  bun: filterOutFlags,
  node: filterOutFlags,
  python: filterOutFlags,
  python3: filterOutFlags,
  sh: filterOutFlags,
  bash: filterOutFlags,
  zsh: filterOutFlags,
  curl: filterOutFlags,
  wget: filterOutFlags,
};

// ─── 主提取函数 ───

/**
 * extractPathsFromCommand — 从简单命令中提取文件系统路径。
 *
 * @param command - AST 解析后的简单命令
 * @returns 路径提取结果
 */
export function extractPathsFromCommand(
  command: SimpleCommand,
): PathExtractionResult {
  const commandName = command.args[0] ?? "";
  const baseName = commandName.split("/").pop() ?? "";
  const extractor = BASH_PATH_PATTERNS[baseName];

  if (extractor === undefined) {
    return { paths: [], command: command.text };
  }

  const args = command.args.slice(1);
  const paths = extractor(args);

  return { paths, command: command.text };
}

/**
 * extractAllPaths — 从多个命令中提取所有路径。
 */
export function extractAllPaths(
  commands: readonly SimpleCommand[],
): readonly string[] {
  const allPaths: string[] = [];

  for (const cmd of commands) {
    const result = extractPathsFromCommand(cmd);
    allPaths.push(...result.paths);
  }

  // 同时提取重定向目标
  for (const cmd of commands) {
    for (const redirect of cmd.redirects) {
      if (redirect.startsWith("/") || redirect.startsWith("./") || redirect.startsWith("../")) {
        allPaths.push(redirect);
      }
    }
  }

  return allPaths;
}

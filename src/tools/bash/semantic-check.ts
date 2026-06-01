/**
 * Bash 语义检查器 — 23 种命令替换模式检测。
 *
 * 基于安全最佳实践的语义检查设计。
 * 在 AST 解析之后执行，检测语义级别的危险模式。
 *
 * 安全策略：检测到任何危险模式 → ask_user（Fail-Closed）。
 */

import type { SimpleCommand } from "./ast-parser";

// ─── 危险命令模式 ───

/** 危险内建命令（可直接执行任意代码） */
const DANGEROUS_BUILTINS = new Set([
  "eval", "exec", "source", "builtin", "command",
]);

/** 危险命令前缀模式（可执行任意代码） */
const DANGEROUS_PREFIXES = [
  /^bash\s+-[ce]/i,
  /^sh\s+-[ce]/i,
  /^zsh\s+-[ce]/i,
  /^ksh\s+-[ce]/i,
  /^dash\s+-[ce]/i,
  /^fish\s+-[ce]/i,
  /^\.\s/,           // source 的简写形式
  /^source\s/i,
];

/** 危险重定向模式 */
const DANGEROUS_REDIRECT_PATTERNS = [
  />>\s*\/dev\/sd/,
  />\s*\/dev\/sd/,
  />\s*\/proc\//,
  />\s*\/sys\//,
  />\s*\/boot\//,
  />\s*\/etc\/shadow/,
  />\s*\/etc\/passwd/,
  />\s*\/etc\/sudoers/,
];

/** 危险文件操作模式 */
const DANGEROUS_FILE_PATTERNS = [
  /\brm\s+(-[rfRF]+\s+)?\/(?:\s|$)/,           // rm -rf /
  /\brm\s+(-[rfRF]+\s+)?\/?\*/,           // rm -rf / 或 rm -rf *
  /\bdd\s+.*of=\/dev\/sd/,               // dd 写入块设备
  /\bmkfs\b/,                            // 格式化文件系统
  /\bfdisk\b/,                           // 磁盘分区
  /\bparted\b/,                          // 磁盘分区
  /\bmount\b.*-o\s+remount/,             // 重新挂载
  /\bumount\b/,                          // 卸载文件系统
  /\bshutdown\b/,                        // 关机
  /\breboot\b/,                          // 重启
  /\binit\s+\d/,                         // 切换运行级别
  /\bsystemctl\s+(stop|disable|mask)/,   // 停止系统服务
  /\bkill\s+(-9\s+)?1\b/,               // kill init 进程
  /\bpkill\s+(-9\s+)?init/,             // pkill init
  /\bchmod\s+(-R\s+)?777\s+\/?/,        // chmod 777 /
  /\bchown\s+(-R\s+)?/,                 // chown 递归
];

/** 网络隧道/反弹 shell 模式 */
const DANGEROUS_NETWORK_PATTERNS = [
  /\bnc\s+.*-[elp]/,                    // netcat 监听/反弹
  /\bncat\s+.*-[elp]/,                  // ncat 监听/反弹
  /\bsocat\s/,                          // socat 隧道
  /\bssh\s+.*-[RDLN]/,                  // SSH 隧道/转发
  /\bcurl\s+.*\|\s*(ba)?sh/,            // curl 管道到 shell
  /\bwget\s+.*-O\s*-\s*\|\s*(ba)?sh/,   // wget 管道到 shell
];

/** 权限提升模式 */
const DANGEROUS_PRIVILEGE_PATTERNS = [
  /\bsudo\s+su\b/,
  /\bsudo\s+-i\b/,
  /\bsudo\s+-s\b/,
  /\bsu\s+-\b/,
  /\bsudo\s+chmod\s+[0-7]{3,4}\s+\/?/,
  /\bsudo\s+chown\b/,
];

/** 编码/混淆模式（可能隐藏恶意命令） */
const DANGEROUS_OBFUSCATION_PATTERNS = [
  /\bbase64\s+(-d|--decode)\b/,         // base64 解码
  /\bxxd\s+(-r|-revert)\b/,             // xxd 反编译
  /\bperl\s+.*-e\b/,                    // perl 一行代码
  /\bpython3?\s+.*-c\b/,                // python 一行代码
  /\bruby\s+.*-e\b/,                    // ruby 一行代码
  /\bgcc\b|\bg\+\+\b/,                  // 编译器
];

const NODE_E_DANGEROUS_PATTERNS = [
  /\brequire\s*\(\s*['"]child_process['"]\s*\)/,
  /\brequire\s*\(\s*['"]fs['"]\s*\)/,
  /\brequire\s*\(\s*['"]net['"]\s*\)/,
  /\brequire\s*\(\s*['"]http['"]\s*\)/,
  /\brequire\s*\(\s*['"]https['"]\s*\)/,
  /\brequire\s*\(\s*['"]crypto['"]\s*\)/,
  /\bprocess\.exit\b/,
  /\bprocess\.kill\b/,
  /\bprocess\.setuid\b/,
  /\bprocess\.setgid\b/,
  /\bchild_process\b/,
  /\bfs\.\s*(open|readFile|writeFile|appendFile|unlink|mkdir|rmdir|rename|chmod|chown)\b/,
  /\bnet\.\s*createServer\b/,
  /\bhttp\.\s*createServer\b/,
  /\bhttps\.\s*createServer\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
];

// ─── 语义检查结果 ───

export interface SemanticCheckOk {
  readonly ok: true;
}

export interface SemanticCheckError {
  readonly ok: false;
  readonly reason: string;
  readonly category: SemanticCheckCategory;
}

export type SemanticCheckResult = SemanticCheckOk | SemanticCheckError;

/** 语义检查危险类别 */
export const SemanticCheckCategory = {
  /** 危险内建命令（eval/exec/source） */
  DANGEROUS_BUILTIN: "dangerous_builtin",
  /** 危险命令前缀（bash -c 等） */
  DANGEROUS_PREFIX: "dangerous_prefix",
  /** 危险重定向 */
  DANGEROUS_REDIRECT: "dangerous_redirect",
  /** 危险文件操作 */
  DANGEROUS_FILE_OP: "dangerous_file_op",
  /** 危险网络操作 */
  DANGEROUS_NETWORK: "dangerous_network",
  /** 权限提升 */
  PRIVILEGE_ESCALATION: "privilege_escalation",
  /** 编码/混淆 */
  OBFUSCATION: "obfuscation",
} as const;

export type SemanticCheckCategory =
  (typeof SemanticCheckCategory)[keyof typeof SemanticCheckCategory];

// ─── 检查函数 ───

/**
 * 检查单个命令是否匹配危险模式列表。
 */
function matchesAnyPattern(
  text: string,
  patterns: readonly RegExp[],
): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * 检查命令名称是否是危险内建。
 */
function isDangerousBuiltin(commandName: string): boolean {
  return DANGEROUS_BUILTINS.has(commandName);
}

/**
 * checkSemanticsDetailed — 详细的语义级安全检查。
 *
 * 对每个简单命令执行 23 种危险模式检测，返回具体的危险类别。
 * 安全策略：检测到任何危险模式 → ask_user（Fail-Closed）。
 *
 * @param commands - AST 解析后的简单命令列表
 * @returns SemanticCheckResult — ok 或包含类别和原因的错误
 */
export function checkSemanticsDetailed(
  commands: readonly SimpleCommand[],
): SemanticCheckResult {
  for (const cmd of commands) {
    const fullText = cmd.text;
    const commandName = cmd.args[0] ?? "";

    // 1. 危险内建命令检查
    if (isDangerousBuiltin(commandName)) {
      return {
        ok: false,
        reason: `Dangerous builtin command: ${commandName}`,
        category: SemanticCheckCategory.DANGEROUS_BUILTIN,
      };
    }

    // 2. 危险命令前缀检查
    if (matchesAnyPattern(fullText, DANGEROUS_PREFIXES)) {
      return {
        ok: false,
        reason: `Dangerous command prefix: ${fullText}`,
        category: SemanticCheckCategory.DANGEROUS_PREFIX,
      };
    }

    // 3. 危险重定向检查
    if (matchesAnyPattern(fullText, DANGEROUS_REDIRECT_PATTERNS)) {
      return {
        ok: false,
        reason: `Dangerous redirect: ${fullText}`,
        category: SemanticCheckCategory.DANGEROUS_REDIRECT,
      };
    }

    // 4. 危险文件操作检查
    if (matchesAnyPattern(fullText, DANGEROUS_FILE_PATTERNS)) {
      return {
        ok: false,
        reason: `Dangerous file operation: ${fullText}`,
        category: SemanticCheckCategory.DANGEROUS_FILE_OP,
      };
    }

    // 5. 危险网络操作检查
    if (matchesAnyPattern(fullText, DANGEROUS_NETWORK_PATTERNS)) {
      return {
        ok: false,
        reason: `Dangerous network operation: ${fullText}`,
        category: SemanticCheckCategory.DANGEROUS_NETWORK,
      };
    }

    // 6. 权限提升检查
    if (matchesAnyPattern(fullText, DANGEROUS_PRIVILEGE_PATTERNS)) {
      return {
        ok: false,
        reason: `Privilege escalation attempt: ${fullText}`,
        category: SemanticCheckCategory.PRIVILEGE_ESCALATION,
      };
    }

    // 7. 编码/混淆检查
    if (matchesAnyPattern(fullText, DANGEROUS_OBFUSCATION_PATTERNS)) {
      return {
        ok: false,
        reason: `Potential obfuscation: ${fullText}`,
        category: SemanticCheckCategory.OBFUSCATION,
      };
    }

    // 8. node -e 细粒度检查
    if (/\bnode\s+.*-e\b/.test(fullText)) {
      if (matchesAnyPattern(fullText, NODE_E_DANGEROUS_PATTERNS)) {
        return {
          ok: false,
          reason: `Dangerous node -e command: ${fullText}`,
          category: SemanticCheckCategory.OBFUSCATION,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * 获取所有危险模式的总数（用于测试验证）。
 */
export function getDangerousPatternCount(): number {
  return (
    DANGEROUS_BUILTINS.size +
    DANGEROUS_PREFIXES.length +
    DANGEROUS_REDIRECT_PATTERNS.length +
    DANGEROUS_FILE_PATTERNS.length +
    DANGEROUS_NETWORK_PATTERNS.length +
    DANGEROUS_PRIVILEGE_PATTERNS.length +
    DANGEROUS_OBFUSCATION_PATTERNS.length
  );
}

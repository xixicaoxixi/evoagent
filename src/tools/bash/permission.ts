/**
 * Bash 权限检查管线 — 10 层安全检查。
 *
 * 基于安全最佳实践的多层权限检查管线设计。
 * 安全策略：不确定时一律 ask_user（Fail-Closed）。
 *
 * 管线流程：
 * 1. AST 安全解析
 * 2. 语义检查（23 种危险模式）
 * 3. 精确匹配规则
 * 4. 命令操作符检查（管道/重定向/逻辑）
 * 5. 路径约束检查
 * 6. sed 约束检查
 * 7. 只读约束检查
 * 8. 模式验证
 * 9. 沙箱自动放行
 * 10. 最终决策
 */

import type { PermissionResult } from "../../types/permission";
import { denyPermission, askUserPermission, allowPermission } from "../../types/permission";
import type { ToolUseContext } from "../../interfaces/tool";
import {
  analyzeBashAstForSecurity,
  analyzeBashSemantics,
  type SimpleCommand,
  type ParseForSecurityResult,
} from "./ast-parser";
import { checkSemanticsDetailed, type SemanticCheckCategory } from "./semantic-check";

// ─── 权限规则类型 ───

/** 权限规则行为 */
export const PermissionRuleBehavior = {
  ALLOW: "allow",
  DENY: "deny",
  ASK: "ask",
} as const;

export type PermissionRuleBehavior =
  (typeof PermissionRuleBehavior)[keyof typeof PermissionRuleBehavior];

/** 权限规则 */
export interface PermissionRule {
  readonly pattern: string;
  readonly behavior: PermissionRuleBehavior;
  readonly reason?: string;
}

/** 权限上下文（从 ToolUseContext 中提取的 Bash 相关信息） */
export interface BashPermissionContext {
  readonly rules: readonly PermissionRule[];
  readonly workingDirectory?: string;
  readonly sandboxed?: boolean;
  readonly readOnlyMode?: boolean;
  readonly allowedDirectories?: readonly string[];
}

// ─── 只读命令白名单 ───

/** 只读模式下允许的命令 */
const READONLY_COMMAND_ALLOWLIST = new Set([
  "ls", "cat", "head", "tail", "wc", "file", "stat", "du",
  "df", "mount", "env", "printenv", "echo", "printf",
  "pwd", "whoami", "id", "date", "cal", "uname",
  "which", "type", "command", "help",
  "git", "gh", "npm", "bun", "node",
  "grep", "rg", "find", "fd", "fzf",
  "jq", "yq", "tomlq",
  "curl", "wget",
  "dig", "nslookup", "ping", "traceroute",
  "ps", "top", "htop",
  "diff", "cmp",
]);

/** 只读模式下允许的安全标志 */
const READONLY_SAFE_FLAGS = new Set([
  "-l", "-la", "-lh", "-1", "-R",
  "-n", "-c", "-w", "-b",
  "--version", "--help",
  "-E", "-F", "-P", "-e",
  "-i", "-v", "-c", "-n", "-w",
  "--color", "--no-color",
  "-type", "-name", "-path", "-max-depth",
  "-e", "-f", "--file",
]);

// ─── 管线辅助函数 ───

/**
 * 检查精确匹配规则。
 * 按优先级：deny > ask > allow。
 */
function checkExactMatchRules(
  commandText: string,
  rules: readonly PermissionRule[],
): PermissionResult | null {
  let hasAllow = false;
  let hasAsk = false;

  for (const rule of rules) {
    if (commandText.includes(rule.pattern) || rule.pattern === commandText) {
      switch (rule.behavior) {
        case PermissionRuleBehavior.DENY:
          return denyPermission(rule.reason ?? `Denied by rule: ${rule.pattern}`);
        case PermissionRuleBehavior.ASK:
          hasAsk = true;
          break;
        case PermissionRuleBehavior.ALLOW:
          hasAllow = true;
          break;
      }
    }
  }

  // deny 优先，然后 ask，最后 allow
  if (hasAsk) {
    return askUserPermission("Matched ask permission rule");
  }
  if (hasAllow) {
    return allowPermission();
  }

  return null;
}

/**
 * 检查命令操作符（管道、重定向、逻辑操作符）。
 * 对管道和逻辑操作符的每段独立检查。
 */
const SAFE_PIPE_LEFT = new Set([
  "ls", "cat", "head", "tail", "echo", "printf",
  "find", "fd", "grep", "rg", "ps", "env", "printenv",
  "git", "npm", "bun", "node",
]);

const SAFE_PIPE_RIGHT = new Set([
  "grep", "rg", "head", "tail", "wc", "sort", "uniq",
  "awk", "sed", "cut", "tr", "tee", "less", "more",
  "jq", "yq", "xargs",
]);

function isPipeSafe(commands: readonly SimpleCommand[]): boolean {
  if (commands.length < 2) return false;
  const first = commands[0]!;
  const firstName = first.args[0] ?? "";
  if (!SAFE_PIPE_LEFT.has(firstName)) return false;
  return commands.slice(1).every((cmd) => SAFE_PIPE_RIGHT.has(cmd.args[0] ?? ""));
}

function checkCommandOperators(
  commands: readonly SimpleCommand[],
): PermissionResult | null {
  if (commands.length <= 1) {
    return null;
  }

  if (isPipeSafe(commands)) {
    return null;
  }

  for (const cmd of commands) {
    const commandName = cmd.args[0] ?? "";
    if (cmd.redirects.length > 0) {
      for (const redirect of cmd.redirects) {
        if (redirect.startsWith("/")) {
          return askUserPermission(
            `Pipeline contains write redirect to: ${redirect}`,
          );
        }
      }
    }
  }

  return null;
}

/**
 * 检查路径约束。
 * 验证命令中涉及的路径是否在允许的工作目录内。
 */
function checkPathConstraints(
  commands: readonly SimpleCommand[],
  allowedDirectories: readonly string[],
  workingDirectory: string,
): PermissionResult | null {
  if (allowedDirectories.length === 0) {
    return null;
  }

  const resolvedAllowed = allowedDirectories.map((d) =>
    d.startsWith("/") ? d : `${workingDirectory}/${d}`,
  );

  for (const cmd of commands) {
    // 检查重定向目标路径
    for (const redirect of cmd.redirects) {
      if (redirect.startsWith("/")) {
        const isAllowed = resolvedAllowed.some((dir) =>
          redirect.startsWith(dir),
        );
        if (!isAllowed) {
          return denyPermission(
            `Path outside allowed directories: ${redirect}`,
          );
        }
      }
    }

    // 检查 cd 命令
    const commandName = cmd.args[0] ?? "";
    if (commandName === "cd" && cmd.args.length > 1) {
      const target = cmd.args[1];
      if (target !== undefined && target.startsWith("/")) {
        const isAllowed = resolvedAllowed.some((dir) =>
          target.startsWith(dir) || target === dir,
        );
        if (!isAllowed) {
          return denyPermission(
            `cd target outside allowed directories: ${target}`,
          );
        }
      }
    }
  }

  return null;
}

/**
 * 检查只读约束。
 * 在只读模式下，仅允许白名单中的命令和安全标志。
 */
function checkReadOnlyConstraints(
  commands: readonly SimpleCommand[],
): PermissionResult | null {
  for (const cmd of commands) {
    const commandName = cmd.args[0] ?? "";
    const baseName = commandName.split("/").pop() ?? "";

    if (!READONLY_COMMAND_ALLOWLIST.has(baseName)) {
      return denyPermission(
        `Command not allowed in read-only mode: ${commandName}`,
      );
    }

    // 检查标志安全性
    for (const arg of cmd.args.slice(1)) {
      // 跳过非标志参数（不以 - 开头）
      if (!arg.startsWith("-")) continue;
      // 跳过带值的标志（如 -n 10 中的 10）
      if (READONLY_SAFE_FLAGS.has(arg)) continue;
      // 带值的标志，检查下一个参数是否是值
      // 简化处理：未知标志在只读模式下拒绝
      return denyPermission(
        `Flag not allowed in read-only mode: ${arg}`,
      );
    }

    // 检查重定向（只读模式不允许写重定向）
    if (cmd.redirects.length > 0) {
      return denyPermission(
        "Write redirects not allowed in read-only mode",
      );
    }
  }

  return null;
}

// ─── 主管线函数 ───

/**
 * checkBashPermission — Bash 工具权限检查管线。
 *
 * 10 层安全检查，安全策略：不确定时一律 ask_user（Fail-Closed）。
 *
 * @param command - 要执行的 Bash 命令
 * @param context - 工具调用上下文
 * @param permissionContext - Bash 权限上下文（规则、目录约束等）
 * @returns PermissionResult — allow / deny / ask_user
 */
export async function checkBashPermission(
  command: string,
  context: ToolUseContext,
  permissionContext: BashPermissionContext,
): Promise<PermissionResult> {
  const {
    rules,
    workingDirectory = context.cwd ?? "/tmp",
    sandboxed = false,
    readOnlyMode = false,
    allowedDirectories = [],
  } = permissionContext;

  // ─── 第 1 层：AST 安全解析 ───
  const astResult: ParseForSecurityResult = analyzeBashAstForSecurity(command);

  if (astResult.kind === "too-complex") {
    // 无法静态分析 → 检查精确匹配规则
    const earlyExit = checkExactMatchRules(command, rules);
    if (earlyExit !== null && earlyExit.behavior === "deny") {
      return earlyExit;
    }
    return askUserPermission(
      `Command too complex for static analysis: ${astResult.reason}`,
    );
  }

  // ─── 第 2 层：语义检查（23 种危险模式） ───
  const semanticResult = analyzeBashSemantics(astResult.commands);
  if (!semanticResult.ok) {
    const earlyExit = checkExactMatchRules(command, rules);
    if (earlyExit !== null && earlyExit.behavior === "deny") {
      return earlyExit;
    }
    return askUserPermission(semanticResult.reason);
  }

  // 详细语义检查（带类别）
  const detailedResult = checkSemanticsDetailed(astResult.commands);
  if (!detailedResult.ok) {
    const earlyExit = checkExactMatchRules(command, rules);
    if (earlyExit !== null && earlyExit.behavior === "deny") {
      return earlyExit;
    }
    return askUserPermission(
      `Semantic check failed [${detailedResult.category}]: ${detailedResult.reason}`,
    );
  }

  // ─── 第 3 层：只读约束检查（在精确匹配之前，只读是硬约束） ───
  if (readOnlyMode) {
    const readOnlyResult = checkReadOnlyConstraints(astResult.commands);
    if (readOnlyResult !== null) {
      return readOnlyResult;
    }
  }

  // ─── 第 4 层：精确匹配规则 ───
  const ruleResult = checkExactMatchRules(command, rules);
  if (ruleResult !== null) {
    return ruleResult;
  }

  // ─── 第 5 层：命令操作符检查 ───
  const operatorResult = checkCommandOperators(astResult.commands);
  if (operatorResult !== null) {
    return operatorResult;
  }

  // ─── 第 6 层：路径约束检查 ───
  const pathResult = checkPathConstraints(
    astResult.commands,
    allowedDirectories,
    workingDirectory,
  );
  if (pathResult !== null) {
    return pathResult;
  }

  // ─── 第 7 层：sed 约束检查（在 Session 4.2 中实现） ───
  // 占位：对 sed 命令进行基本检查
  for (const cmd of astResult.commands) {
    const commandName = cmd.args[0] ?? "";
    if (commandName === "sed") {
      // 基本安全检查：不允许 -e 执行、-w 写入
      for (const arg of cmd.args) {
        if (arg === "-e" || arg === "-w" || arg === "-W") {
          return askUserPermission(
            `sed flag not allowed without full validation: ${arg}`,
          );
        }
      }
    }
  }

  // ─── 第 8 层：模式验证 ───
  // readOnlyMode 已在上面处理
  // 其他模式（bypassPermissions 等）在更上层处理

  // ─── 第 9 层：沙箱自动放行 ───
  if (sandboxed) {
    // 沙箱内命令自动放行（但仍尊重显式 deny 规则）
    return allowPermission();
  }

  // ─── 第 10 层：最终决策（默认 ask_user） ───
  return askUserPermission(
    "No matching permission rule found. Please confirm execution.",
  );
}

// ─── 工厂函数 ───

/**
 * 创建默认的 Bash 权限上下文。
 */
export function createBashPermissionContext(
  overrides?: Partial<BashPermissionContext>,
): BashPermissionContext {
  return {
    rules: [],
    workingDirectory: "/tmp",
    sandboxed: false,
    readOnlyMode: false,
    allowedDirectories: [],
    ...overrides,
  };
}

/**
 * BashTool — 完整的 Bash 命令执行工具。
 *
 * 基于通用 Agent 设计模式的 BashTool 设计。
 * 安全特性：
 * - 10 层权限检查管线
 * - 环境变量净化
 * - 超时控制
 * - 输出大小限制
 * - 双层 AbortController
 */

import { z } from "zod";
import { createToolDefinition } from "../builder";
import type { Tool } from "../../interfaces/tool";
import { createToolResult } from "../../types/tool";
import { checkBashPermission, type BashPermissionContext } from "./permission";
import { sanitizeEnvVars } from "./env-sanitizer";
import type { ReadFileState } from "../file/write";
import { interpretExitCode, type SemanticExitCode } from "./exit-code-semantics";

// ─── 输入 Schema ───

export const BashInputSchema = z.object({
  command: z.string().min(1, "Command is required"),
  timeout: z.number().int().min(1000).max(120_000).optional()
    .describe("Command timeout in ms, default 10000"),
  cwd: z.string().optional(),
});

export type BashInput = z.infer<typeof BashInputSchema>;

// ─── 输出类型 ───

export interface BashOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly semanticExitCode?: SemanticExitCode;
  readonly semanticDescription?: string;
}

// ─── 常量 ───

const DEFAULT_TIMEOUT = 10_000;
const MAX_OUTPUT_SIZE = 30_000; // 30KB
const MAX_OUTPUT_TRUNCATION = 10_000; // 截断后保留 10KB

// ─── 配置 ───

export interface BashToolConfig {
  readonly permissionContext: BashPermissionContext;
  readonly readFileState?: ReadFileState;
  readonly defaultTimeout?: number;
  readonly maxOutputSize?: number;
  readonly envSanitization?: {
    readonly strictMode?: boolean;
    readonly customBlockedPatterns?: ReadonlyArray<RegExp>;
    readonly customAllowedPatterns?: ReadonlyArray<RegExp>;
  };
}

// ─── 工具定义 ───

/**
 * createBashTool — 创建 Bash 命令执行工具。
 *
 * 安全特性：
 * - 10 层权限检查管线
 * - 环境变量净化（阻止 API 密钥等）
 * - 超时控制（默认 2 分钟）
 * - 输出大小限制（30KB）
 * - 双层 AbortController（全局 + 超时）
 */
export function createBashTool(config: BashToolConfig): Tool {
  const {
    permissionContext,
    defaultTimeout = DEFAULT_TIMEOUT,
    maxOutputSize = MAX_OUTPUT_SIZE,
  } = config;

  return createToolDefinition({
    name: "bash",
    description:
      "Execute Bash commands. Commands are subject to a 10-layer security pipeline. " +
      "Default timeout: 10 seconds. Output truncated at 30KB. " +
      "On Windows, delayed expansion is enabled automatically (use !VAR! for variables set in the same command chain). " +
      "On Windows, shell redirection (> or |) may hang — use file_write tool for writing files instead.",
    inputSchema: BashInputSchema,

    async call(input, context) {
      const parsed = BashInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid input: ${parsed.error.message}`);
      }
      const { command, timeout, cwd } = parsed.data;

      if (process.platform === "win32" && (command.includes("|") || command.includes(">"))) {
        if (!isWindowsReadOnlyPipe(command) && !SET_COMMAND_RE.test(command)) {
          return createToolResult(
            {
              stdout: "",
              stderr: "Warning: Shell redirection (> or |) on Windows may hang. Use the file_write tool for writing files instead.",
              exitCode: -1,
              timedOut: false,
            },
            true,
          );
        }
      }

      const effectiveCommand = process.platform === "win32"
        ? adaptWindowsCommand(command)
        : command;

      // 1. 权限检查
      const permissionResult = await checkBashPermission(
        command,
        context,
        permissionContext,
      );

      if (permissionResult.behavior === "deny") {
        return createToolResult(
          {
            stdout: "",
            stderr: `Permission denied: ${permissionResult.reason ?? "Command not allowed"}`,
            exitCode: -1,
            timedOut: false,
          },
          true,
        );
      }

      if (permissionResult.behavior === "ask_user") {
        return createToolResult(
          {
            stdout: "",
            stderr: `Permission required: ${permissionResult.reason ?? "Please confirm execution"}`,
            exitCode: -1,
            timedOut: false,
          },
          true,
        );
      }

      // 2. 环境变量净化
      const envResult = sanitizeEnvVars(process.env, config.envSanitization);

      // 3. 执行命令
      const effectiveTimeout = timeout ?? defaultTimeout;
      const effectiveCwd = cwd ?? context.cwd ?? process.cwd();

      // 创建 AbortController
      const combinedAbort = new AbortController();
      const timeoutAbort = new AbortController();

      const timeoutId = setTimeout(() => {
        timeoutAbort.abort();
        combinedAbort.abort();
      }, effectiveTimeout);

      try {
        const { exec } = await import("node:child_process");

        const result = await new Promise<BashOutput>((resolve) => {
          exec(
            effectiveCommand,
            {
              cwd: effectiveCwd,
              env: envResult.allowed,
              timeout: effectiveTimeout,
              maxBuffer: maxOutputSize * 2,
              signal: combinedAbort.signal,
            },
            (error, stdout, stderr) => {
              if (timeoutAbort.signal.aborted) {
                resolve({
                  stdout: truncateOutput(stdout ?? ""),
                  stderr: `Command timed out after ${effectiveTimeout}ms`,
                  exitCode: -1,
                  timedOut: true,
                });
                return;
              }

              const exitCode = error?.code as number ?? 0;
              const semantics = interpretExitCode(command, exitCode);

              resolve({
                stdout: truncateOutput(stdout ?? ""),
                stderr: truncateOutput(stderr ?? ""),
                exitCode,
                timedOut: false,
                ...(semantics.code !== "error" || semantics.description !== ""
                  ? { semanticExitCode: semantics.code, semanticDescription: semantics.description }
                  : {}),
              });
            },
          );
        });

        const semantics = interpretExitCode(command, result.exitCode);
        return createToolResult(result, semantics.isError);
      } finally {
        clearTimeout(timeoutId);
      }
    },

    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  });
}

// ─── 辅助函数 ───

/**
 * truncateOutput — 截断过长的输出。
 */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_SIZE) {
    return output;
  }

  const head = output.slice(0, MAX_OUTPUT_TRUNCATION);
  const tail = output.slice(-MAX_OUTPUT_TRUNCATION);
  const truncated = output.length - MAX_OUTPUT_TRUNCATION * 2;

  return (
    head +
    `\n\n... [${truncated} characters truncated] ...\n\n` +
    tail
  );
}

const SET_COMMAND_RE = /\bset\s+[a-zA-Z_][a-zA-Z0-9_]*=/i;
const ECHO_REDIRECT_RE = /^echo\s+/;
const REDIRECT_RE = />\s*"?([^"&|>\s]+)"?/;

const WINDOWS_READONLY_PIPE_COMMANDS = [
  "dir", "type", "findstr", "find", "more", "sort", "where",
] as const;

function isWindowsReadOnlyPipe(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  return WINDOWS_READONLY_PIPE_COMMANDS.some(
    (cmd) => trimmed.startsWith(cmd + " ") || trimmed.startsWith(cmd + "|"),
  );
}

export function adaptWindowsCommand(command: string): string {
  if (SET_COMMAND_RE.test(command)) {
    return `setlocal enabledelayedexpansion && ${command}`;
  }

  if (ECHO_REDIRECT_RE.test(command) && REDIRECT_RE.test(command)) {
    return command
      .replace(/^echo\s+"(.*)"\s*>/, "echo $1 >")
      .replace(/^echo\s+'(.*)'\s*>/, "echo $1 >");
  }

  if (REDIRECT_RE.test(command)) {
    let result = command.replace(/\s*>>\s*/g, " >> ");
    result = result.replace(/(?<!>)\s*>\s*(?!>)/g, " > ");
    return result;
  }

  return command;
}

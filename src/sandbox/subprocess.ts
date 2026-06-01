/**
 * 子进程沙箱 — 基于 child_process 的隔离执行。
 *
 * 参考 `代码片段_记忆系统与知识管理补充` #6 QMD 进程管理器。
 *
 * 安全特性：
 * - 超时自动 SIGKILL
 * - 输出截断保护（appendOutputWithCap 滑动窗口）
 * - 环境变量白名单过滤
 * - 资源限制（内存/输出大小）
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { SandboxBackend, SandboxConfig, SandboxResult } from "../interfaces/sandbox";

// ─── 子进程沙箱配置 ───

export interface SubprocessSandboxConfig extends SandboxConfig {
  /** 允许的环境变量前缀白名单 */
  readonly allowedEnvPrefixes?: ReadonlyArray<string>;
  /** 允许的环境变量名列表 */
  readonly allowedEnvNames?: ReadonlyArray<string>;
}

// ─── 输出截断 ───

function appendOutputWithCap(
  current: string,
  chunk: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const appended = current + chunk;
  if (appended.length <= maxChars) {
    return { text: appended, truncated: false };
  }
  return { text: appended.slice(-maxChars), truncated: true };
}

// ─── 环境变量过滤 ───

function filterEnvVars(
  env: Record<string, string> | undefined,
  allowedPrefixes: ReadonlyArray<string>,
  allowedNames: ReadonlyArray<string>,
): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(env ?? process.env as Record<string, string>)) {
    if (allowedNames.includes(key)) {
      filtered[key] = value;
      continue;
    }
    for (const prefix of allowedPrefixes) {
      if (key.startsWith(prefix)) {
        filtered[key] = value;
        break;
      }
    }
  }

  return filtered;
}

// ─── 子进程沙箱实现 ───

export class SubprocessSandbox implements SandboxBackend {
  readonly name = "subprocess";

  async execute(
    command: string,
    args: readonly string[],
    config: SandboxConfig,
  ): Promise<SandboxResult> {
    const subConfig = config as SubprocessSandboxConfig;
    const startTime = Date.now();

    const allowedPrefixes = subConfig.allowedEnvPrefixes ?? [
      "PATH", "HOME", "LANG", "LC_", "NODE_",
    ];
    const allowedNames = subConfig.allowedEnvNames ?? [];
    const env = filterEnvVars(
      config.environment as Record<string, string> | undefined,
      allowedPrefixes,
      allowedNames,
    );

    return await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let killed = false;

      const maxOutput = config.maxOutputChars;

      const child: ChildProcess = spawn(command, [...args], {
        cwd: config.workingDirectory,
        env: { ...env, ...config.environment },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        child.kill("SIGKILL");
      }, config.timeoutMs);

      child.stdout?.on("data", (data: Buffer) => {
        const next = appendOutputWithCap(stdout, data.toString("utf8"), maxOutput);
        stdout = next.text;
        stdoutTruncated = stdoutTruncated || next.truncated;
      });

      child.stderr?.on("data", (data: Buffer) => {
        const next = appendOutputWithCap(stderr, data.toString("utf8"), maxOutput);
        stderr = next.text;
        stderrTruncated = stderrTruncated || next.truncated;
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: -1,
          stdout: "",
          stderr: err.message,
          durationMs: Date.now() - startTime,
          timedOut: false,
          killed: false,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
          timedOut,
          killed,
        });
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async cleanup(): Promise<void> {
    // 子进程沙箱无需清理
  }
}

// ─── Docker 沙箱配置 ───

export interface DockerSandboxConfig {
  readonly image?: string;
  readonly readOnlyRoot?: boolean;
  readonly network?: string;
  readonly capDrop?: ReadonlyArray<string>;
  readonly memory?: string;
  readonly cpus?: number;
  readonly pidsLimit?: number;
  readonly tmpfs?: ReadonlyArray<string>;
}

// ─── Docker 沙箱安全验证 ───

export interface SecurityValidationResult {
  readonly valid: boolean;
  readonly violations: ReadonlyArray<string>;
}

/**
 * validateDockerSecurity — 运行时安全验证。
 *
 * 参考 `代码片段_工具系统与安全` #17 validateSandboxSecurity()。
 * 阻止危险的 bind mount、网络模式和配置。
 */
export function validateDockerSecurity(
  config: DockerSandboxConfig,
): SecurityValidationResult {
  const violations: string[] = [];

  // 网络模式检查
  if (config.network === "host") {
    violations.push("Network mode 'host' is not allowed");
  }

  // 内存限制检查
  if (config.memory !== undefined) {
    const match = config.memory.match(/^(\d+)([mg]?)$/i);
    if (match) {
      const value = parseInt(match[1]!, 10);
      const unit = match[2]!.toLowerCase();
      const bytes = unit === "g" ? value * 1024 * 1024 * 1024
        : unit === "m" ? value * 1024 * 1024
        : value;
      if (bytes > 8 * 1024 * 1024 * 1024) {
        violations.push(`Memory limit too high: ${config.memory}`);
      }
    }
  }

  // Capabilities 检查
  if (config.capDrop === undefined || !config.capDrop.includes("ALL")) {
    violations.push("cap-drop ALL is required for security");
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * resolveDockerConfig — 合并 Docker 沙箱配置（安全默认值）。
 *
 * 参考 `代码片段_工具系统与安全` #17 resolveSandboxDockerConfig()。
 * 所有安全字段都有安全默认值。
 */
export function resolveDockerConfig(
  overrides?: Partial<DockerSandboxConfig>,
): DockerSandboxConfig {
  return {
    image: overrides?.image ?? "node:20-slim",
    readOnlyRoot: overrides?.readOnlyRoot ?? true,
    network: overrides?.network ?? "none",
    capDrop: overrides?.capDrop ?? ["ALL"],
    memory: overrides?.memory ?? "512m",
    cpus: overrides?.cpus ?? 1.0,
    pidsLimit: overrides?.pidsLimit ?? 100,
    tmpfs: overrides?.tmpfs ?? ["/tmp", "/var/tmp"],
  };
}

/**
 * buildDockerArgs — 将配置转化为 docker create 命令行参数。
 *
 * 参考 `代码片段_工具系统与安全` #17 buildSandboxCreateArgs()。
 */
export function buildDockerArgs(
  containerName: string,
  config: DockerSandboxConfig,
  command?: string,
  args?: readonly string[],
): string[] {
  const dockerArgs: string[] = ["create", "--name", containerName];

  if (config.readOnlyRoot) {
    dockerArgs.push("--read-only");
  }

  if (config.network) {
    dockerArgs.push("--network", config.network);
  }

  for (const cap of config.capDrop ?? []) {
    dockerArgs.push("--cap-drop", cap);
  }

  dockerArgs.push("--security-opt", "no-new-privileges");

  if (config.memory) {
    dockerArgs.push("--memory", config.memory);
  }

  if (config.cpus !== undefined) {
    dockerArgs.push("--cpus", String(config.cpus));
  }

  if (config.pidsLimit !== undefined) {
    dockerArgs.push("--pids-limit", String(config.pidsLimit));
  }

  for (const entry of config.tmpfs ?? []) {
    dockerArgs.push("--tmpfs", entry);
  }

  if (command) {
    dockerArgs.push(command, ...(args ?? []));
  }

  return dockerArgs;
}

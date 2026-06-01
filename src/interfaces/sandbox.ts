/**
 * SandboxBackend 接口。
 *
 * 沙箱后端抽象，支持子进程和 Docker 两种隔离方式。
 * RULES_2-4: 接口 + 注册表模式。
 * RULES_2-18: Copy-on-Write（沙箱隔离）。
 */

// ─── 沙箱执行配置 ───

export interface SandboxConfig {
  readonly timeoutMs: number;
  readonly maxMemoryMB: number;
  readonly maxOutputChars: number;
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

// ─── 沙箱执行结果 ───

export interface SandboxResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly killed: boolean;
}

// ─── SandboxBackend 接口 ───

export interface SandboxBackend {
  /** 后端名称 */
  readonly name: string;

  /** 执行命令 */
  execute(
    command: string,
    args: readonly string[],
    config: SandboxConfig,
  ): Promise<SandboxResult>;

  /** 检查后端是否可用 */
  isAvailable(): Promise<boolean>;

  /** 清理资源 */
  cleanup(): Promise<void>;
}

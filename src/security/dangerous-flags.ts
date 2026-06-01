/**
 * 危险配置检测 + HTTPS 警告 — SEC-06 + SEC-11 修复。
 *
 * - 检测已启用的不安全或危险配置标志
 * - 定义危险工具黑名单
 * - 服务器启动时安全审计
 *
 * 基于安全最佳实践的危险配置检测与 HTTPS 警告方案。
 */

// ─── 危险工具黑名单 ───

/**
 * 通过 HTTP API 默认拒绝的工具列表。
 * 这些工具高风险因为它们支持命令执行或文件操作。
 */
export const DANGEROUS_TOOLS: ReadonlyArray<string> = [
  "exec",
  "spawn",
  "shell",
  "fs_write",
  "fs_delete",
  "fs_move",
  "apply_patch",
  "sessions_spawn",
  "sessions_send",
  "cron",
  "gateway",
  "nodes",
  "eval",
  "function_call",
] as const;

/**
 * 检查工具名是否在危险工具黑名单中。
 */
export function isDangerousTool(toolName: string): boolean {
  return (DANGEROUS_TOOLS as readonly string[]).includes(toolName);
}

// ─── 危险配置标志检测 ───

/**
 * 不安全配置标志定义。
 */
interface DangerousFlag {
  readonly path: string;
  readonly description: string;
  readonly check: (config: Record<string, unknown>) => boolean;
}

const DANGEROUS_FLAGS: ReadonlyArray<DangerousFlag> = [
  {
    path: "server.authDisabled",
    description: "Server authentication is disabled",
    check: (cfg) => cfg.server_auth_disabled === true,
  },
  {
    path: "server.allowInsecureAuth",
    description: "Server allows insecure authentication",
    check: (cfg) => cfg.server_allow_insecure_auth === true,
  },
  {
    path: "evolution.sandboxDisabled",
    description: "Evolution sandbox is disabled",
    check: (cfg) => {
      const evo = cfg.evolution as Record<string, unknown> | undefined;
      return evo?.sandbox_enabled === false;
    },
  },
  {
    path: "communication.allowUnsafeContent",
    description: "Communication allows unsafe external content",
    check: (cfg) => {
      const comm = cfg.communication as Record<string, unknown> | undefined;
      return comm?.allow_unsafe_content === true;
    },
  },
  {
    path: "tools.exec.workspaceOnlyDisabled",
    description: "Exec tool workspace restriction is disabled",
    check: (cfg) => cfg.tools_exec_workspace_only === false,
  },
  {
    path: "security.disableUnicodeSanitization",
    description: "Unicode sanitization is disabled",
    check: (cfg) => cfg.security_disable_unicode_sanitization === true,
  },
  {
    path: "security.disablePromptInjectionDetection",
    description: "Prompt injection detection is disabled",
    check: (cfg) => cfg.security_disable_prompt_injection_detection === true,
  },
];

/**
 * 收集已启用的不安全或危险配置标志。
 *
 * @param config - 配置对象
 * @returns 已启用的危险标志路径列表
 */
export function collectEnabledInsecureOrDangerousFlags(
  config: Record<string, unknown>,
): ReadonlyArray<string> {
  const enabledFlags: string[] = [];

  for (const flag of DANGEROUS_FLAGS) {
    if (flag.check(config)) {
      enabledFlags.push(flag.path);
    }
  }

  return enabledFlags;
}

/**
 * 获取所有危险标志的描述信息。
 */
export function getDangerousFlagDescriptions(): ReadonlyArray<{
  readonly path: string;
  readonly description: string;
}> {
  return DANGEROUS_FLAGS.map((f) => ({ path: f.path, description: f.description }));
}

// ─── 安全审计 ───

export interface SecurityAuditResult {
  readonly secure: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly dangerousFlags: ReadonlyArray<string>;
  readonly timestamp: number;
}

/**
 * 执行安全审计。
 *
 * 检查项：
 * 1. 危险配置标志
 * 2. HTTPS/生产环境检查
 * 3. API Key 配置检查
 *
 * @param config - 配置对象
 */
export function securityAudit(config?: Record<string, unknown>): SecurityAuditResult {
  const warnings: string[] = [];
  const cfg = config ?? {};

  // 1. 危险配置标志
  const dangerousFlags = collectEnabledInsecureOrDangerousFlags(cfg);
  for (const flag of dangerousFlags) {
    warnings.push(`[DANGEROUS] ${flag} is enabled`);
  }

  // 2. HTTPS/生产环境检查
  if (process.env.NODE_ENV === "production") {
    const serverCfg = cfg.server as Record<string, unknown> | undefined;
    const protocol = serverCfg?.protocol as string | undefined;
    if (protocol !== "https" && protocol !== "tls") {
      warnings.push(
        "[WARNING] Running in production without HTTPS. " +
        "API keys and sensitive data may be transmitted in plaintext.",
      );
    }
  }

  // 3. API Key 配置检查
  const apiKeys = process.env.EVOAGENT_API_KEYS;
  if (!apiKeys && process.env.NODE_ENV === "production") {
    warnings.push(
      "[WARNING] EVOAGENT_API_KEYS is not set in production. " +
      "Server has no authentication.",
    );
  }

  return {
    secure: warnings.length === 0,
    warnings,
    dangerousFlags,
    timestamp: Date.now(),
  };
}

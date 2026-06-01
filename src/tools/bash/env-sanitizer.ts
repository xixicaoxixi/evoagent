/**
 * 环境变量过滤器 — 黑名单+白名单双层策略。
 *
 * 基于安全最佳实践的环境变量过滤设计。
 * 阻止 API 密钥、令牌、密码等敏感环境变量传递给子进程。
 */

// ─── 黑名单模式 ───

/** 阻止的环境变量名模式（API 密钥、令牌、密码等） */
const BLOCKED_ENV_VAR_PATTERNS: ReadonlyArray<RegExp> = [
  /^ANTHROPIC_API_KEY$/i,
  /^OPENAI_API_KEY$/i,
  /^GEMINI_API_KEY$/i,
  /^OPENROUTER_API_KEY$/i,
  /^AWS_(SECRET_ACCESS_KEY|SECRET_KEY|SESSION_TOKEN)$/i,
  /^(GH|GITHUB)_TOKEN$/i,
  /^(AZURE|COHERE|AI_GATEWAY|OPENROUTER)_API_KEY$/i,
  /_?(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$/i,
];

// ─── 白名单模式 ───

/** 严格模式下仅允许的环境变量 */
const ALLOWED_ENV_VAR_PATTERNS: ReadonlyArray<RegExp> = [
  /^LANG$/i,
  /^LC_.*$/i,
  /^PATH$/i,
  /^HOME$/i,
  /^USER$/i,
  /^SHELL$/i,
  /^TERM$/i,
  /^TZ$/i,
  /^NODE_ENV$/i,
];

// ─── 类型定义 ───

export interface EnvSanitizationOptions {
  readonly strictMode?: boolean;
  readonly customBlockedPatterns?: ReadonlyArray<RegExp>;
  readonly customAllowedPatterns?: ReadonlyArray<RegExp>;
}

export interface EnvVarSanitizationResult {
  readonly allowed: Readonly<Record<string, string>>;
  readonly blocked: readonly string[];
  readonly warnings: readonly string[];
}

// ─── 辅助函数 ───

function matchesAnyPattern(key: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((re) => re.test(key));
}

function validateEnvVarValue(value: string): string | null {
  // 检测 null 字节（阻止）
  if (value.includes("\x00")) {
    return "Contains null bytes";
  }
  // 检测超长值（>32768 字节警告）
  if (value.length > 32768) {
    return `Value exceeds 32KB (${value.length} bytes)`;
  }
  return null;
}

// ─── 主函数 ───

/**
 * sanitizeEnvVars — 环境变量净化。
 *
 * 双层策略：
 * 1. 黑名单：阻止 API 密钥、令牌、密码等
 * 2. 白名单（严格模式）：仅允许已知安全的变量
 *
 * @param envVars - 原始环境变量
 * @param options - 净化选项
 * @returns 净化结果（allowed/blocked/warnings）
 */
export function sanitizeEnvVars(
  envVars: Readonly<Record<string, string | undefined>>,
  options: EnvSanitizationOptions = {},
): EnvVarSanitizationResult {
  const allowed: Record<string, string> = {};
  const blocked: string[] = [];
  const warnings: string[] = [];

  const blockedPatterns = [
    ...BLOCKED_ENV_VAR_PATTERNS,
    ...(options.customBlockedPatterns ?? []),
  ];
  const allowedPatterns = [
    ...ALLOWED_ENV_VAR_PATTERNS,
    ...(options.customAllowedPatterns ?? []),
  ];

  for (const [rawKey, value] of Object.entries(envVars)) {
    const key = rawKey.trim();
    if (!key || value === undefined) continue;

    // 黑名单检查
    if (matchesAnyPattern(key, blockedPatterns)) {
      blocked.push(key);
      continue;
    }

    // 白名单检查（严格模式）
    if (options.strictMode && !matchesAnyPattern(key, allowedPatterns)) {
      blocked.push(key);
      continue;
    }

    // 值验证
    const warning = validateEnvVarValue(value);
    if (warning !== null) {
      if (warning === "Contains null bytes") {
        blocked.push(key);
        continue;
      }
      warnings.push(`${key}: ${warning}`);
    }

    allowed[key] = value;
  }

  return { allowed, blocked, warnings };
}

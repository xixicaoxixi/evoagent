/**
 * 安全模块导出 — 统一入口。
 */

export type { CredentialStore, CredentialStoreData, FileCredentialStoreConfig } from "./storage";
export { createFileCredentialStore } from "./storage";
export { createChainedCredentialStore } from "./fallback-storage";
export type { SecretRef, SecretRefSource, SecretInput } from "./secret-ref";
export {
  isSecretRef,
  isValidEnvSecretRefId,
  parseEnvTemplateSecretRef,
  coerceSecretRef,
  resolveSecret,
  readSecretFromFile,
  DEFAULT_SECRET_PROVIDER_ALIAS,
  MAX_SECRET_FILE_BYTES,
} from "./secret-ref";
export {
  REDACTED_SENTINEL,
  isSensitiveConfigPath,
  redactConfigObject,
  restoreRedactedValues,
} from "./redact";
export type { ExternalContentSource, WrapExternalContentOptions } from "./external-content";
export {
  markExternalContent,
  normalizeUnicodeForSafety,
  deepNormalizeUnicode,
  detectPromptInjection,
} from "./external-content";
export {
  sanitizeToolInputForLogging,
  extractToolInputForTelemetry,
  sanitizeToolNameForAnalytics,
} from "./truncate";
export {
  DANGEROUS_TOOLS,
  isDangerousTool,
  collectEnabledInsecureOrDangerousFlags,
  getDangerousFlagDescriptions,
  securityAudit,
} from "./dangerous-flags";
export type { SecurityAuditResult } from "./dangerous-flags";
export {
  sanitizeForLLM,
  sanitizePath,
  filterArchitectureKeywords,
  truncateForLLM,
  isLocalProvider,
  shouldSanitizeForLLM,
} from "./llm-sanitize";
export type { LLMSanitizeOptions, LLMSanitizeStats, LLMSanitizationResult } from "./llm-sanitize";
export type { HardlinePattern, HardlineBlockResult, HardlinePassResult, HardlineCheckResult } from "./hardline";
export {
  HARDLINE_PATTERNS,
  checkHardline,
  isHardlineBlocked,
} from "./hardline";

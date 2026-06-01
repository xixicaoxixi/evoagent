/**
 * 配置 Zod Schema。
 *
 * RULES_2-21: 配置管线 — 加载 → 验证 → 物化 → 快照 → 热更新。
 * Fail-Closed 默认值：所有配置项都有安全默认值。
 */

import { z } from "zod";

// ─── SecretInput Schema（SEC-03） ───

const SecretRefSchema = z.object({
  source: z.enum(["env", "file", "exec"]),
  provider: z.string().min(1),
  id: z.string().min(1),
});

/** api_key 支持 string 或 SecretRef */
const SecretInputSchema = z.union([z.string(), SecretRefSchema]);

// ─── ProviderType Schema ───

export const ProviderTypeSchema = z.enum([
  "openai",
  "anthropic",
  "ollama",
  "mock",
  "deepseek",
  "kimi",
  "glm",
]);

// ─── LLMConfig Schema ───

export const LLMConfigSchema = z.object({
  provider_type: ProviderTypeSchema.default("openai"),
  model: z.string().min(1).default("gpt-4o"),
  /** SEC-03: api_key 支持 string 或 SecretRef */
  api_key: SecretInputSchema.default(""),
  base_url: z.string().default(""),
  temperature: z.number().min(0).max(2).default(0.1),
  max_tokens: z.number().int().positive().default(2048),
});

export type LLMConfigInput = z.input<typeof LLMConfigSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;

// ─── ServerConfig Schema ───

export const ServerConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(8900),
});

export type ServerConfigInput = z.input<typeof ServerConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// ─── EvolutionConfig Schema ───

export const EvolutionConfigSchema = z.object({
  auto_evolution: z.boolean().default(true),
  approval_required: z.boolean().default(false),
  sandbox_enabled: z.boolean().default(true),
  max_rules: z.number().int().positive().default(50),
  min_active_rules: z.number().int().positive().default(1),
  deprecate_threshold: z.number().min(0).max(1).default(0.3),
  deprecate_min_activations: z.number().int().positive().default(5),
  trigger_budget_total: z.number().int().positive().default(100),
  sandbox_min_trials: z.number().int().positive().default(3),
  promotion_improvement_min: z.number().min(0).max(1).default(0.15),
  promotion_cost_max: z.number().min(0).max(1).default(0.10),
  probation_min_tasks: z.number().int().positive().default(10),
  snapshot_max_count: z.number().int().positive().default(10),
});

export type EvolutionConfigInput = z.input<typeof EvolutionConfigSchema>;
export type EvolutionConfig = z.infer<typeof EvolutionConfigSchema>;

// ─── CommunicationConfig Schema ───

export const CommunicationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(8901),
});

export type CommunicationConfigInput = z.input<typeof CommunicationConfigSchema>;
export type CommunicationConfig = z.infer<typeof CommunicationConfigSchema>;

// ─── AgentConfig Schema ───

export const AgentConfigSchema = z.object({
  /** Plan Mode: 只读规划模式，Agent 只能使用只读工具 */
  plan_mode: z.boolean().default(false),
  /** 最大并发 Agent 数 */
  max_concurrent_agents: z.number().int().positive().default(5),
  /** 单个 Agent 默认最大轮次 */
  default_max_turns: z.number().int().positive().default(50),
  /** 单个 Agent 默认 Token 预算 */
  default_token_budget: z.number().int().positive().default(100_000),
  /** Agent 超时（毫秒） */
  agent_timeout_ms: z.number().int().positive().default(300_000),
  /** LLM 适配器调用超时（毫秒），可通过 EVOAGENT_LLM_TIMEOUT_MS 环境变量覆盖 */
  llm_timeout_ms: z.number().int().positive().default(30_000),
  /** 验证闭环：最大修复轮次 */
  max_fix_rounds: z.number().int().positive().default(3),
  /** 验证步骤（按顺序执行） */
  verification_steps: z.array(z.enum(["test", "lint", "type-check"])).default(["test", "type-check"]),
});

export type AgentConfigInput = z.input<typeof AgentConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ─── AppConfig Schema（顶层配置） ───

export const AppConfigSchema = z.object({
  // 实例标识
  instance_id: z.string().default(""),
  instance_name: z.string().default(""),
  created_at: z.string().default(""),
  last_modified: z.string().default(""),

  // 子配置
  llm: LLMConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
  evolution: EvolutionConfigSchema.default({}),
  communication: CommunicationConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
});

export type AppConfigInput = z.input<typeof AppConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

// ─── 合并策略 ───

/**
 * 配置合并策略枚举。
 *
 * 不同组件类型采用不同的合并策略：
 * - overlay: 后注册的覆盖先注册的（Skills 按名称覆盖）
 * - stack: 所有层级的配置叠加合并（Rules 叠加）
 * - merge: 同名配置深度合并（Hooks 合并执行）
 */
export type MergeStrategy = "overlay" | "stack" | "merge";

/**
 * 配置来源层级（优先级从高到低）。
 *
 * managed > user > project > workspace > builtin
 */
export type ConfigLayer = "managed" | "user" | "project" | "workspace" | "builtin";

/** 配置层级优先级映射（数字越小优先级越高） */
export const LAYER_PRIORITY: Readonly<Record<ConfigLayer, number>> = {
  managed: 0,
  user: 1,
  project: 2,
  workspace: 3,
  builtin: 4,
} as const;

// ─── 默认配置 ───

export const DEFAULT_APP_CONFIG: AppConfig = AppConfigSchema.parse({});

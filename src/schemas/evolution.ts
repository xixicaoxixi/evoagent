/**
 * EvolutionRule Zod Schema。
 *
 * 完整的进化规则数据验证，包含所有字段和生命周期状态。
 */

import { z } from "zod";

// ─── RuleStatus Schema ───

export const RuleStatusSchema = z.enum([
  "PENDING_APPROVAL",
  "SANDBOX",
  "PROBATION",
  "ACTIVE",
  "DEPRECATED",
  "ROLLED_BACK",
]);

// ─── EvolutionAction Schema ───

export const EvolutionActionSchema = z.enum([
  "RETRY_WITH_HIGHER_TIMEOUT",
  "ADD_VALIDATION_STEP",
  "REDUCE_SCOPE",
  "SPLIT_SUBTASK",
  "ADD_KNOWLEDGE_RETRIEVAL",
  "ADD_ERROR_HANDLING",
  "IMPROVE_PROMPT_CLARITY",
  "ADD_FALLBACK_STRATEGY",
  "SAMPLE_BEFORE_PROCESS",
  "INCREASE_TOKEN_BUDGET",
  "DECREASE_TOKEN_BUDGET",
  "CHANGE_TOOL_SELECTION",
  "ADD_RETRY_LOGIC",
  "SKIP_OPTIONAL_STEP",
  "REORDER_EXECUTION",
  "ADVISORY_ONLY",
]);

// ─── TriggerLogEntry Schema ───

export const TriggerLogEntrySchema = z.object({
  timestamp: z.string(),
  task_id: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  tokens_used: z.number().int().min(0).default(0),
});

export type TriggerLogEntry = z.infer<typeof TriggerLogEntrySchema>;

// ─── TaskTypeStats Schema ───

export const TaskTypeStatsSchema = z.record(
  z.string(),
  z.object({
    total: z.number().int().default(0),
    success: z.number().int().default(0),
  }),
);

export type TaskTypeStats = z.infer<typeof TaskTypeStatsSchema>;

// ─── EvolutionRule Schema ───

export const EvolutionRuleSchema = z.object({
  rule_id: z.string().min(1),
  created_at: z.string(),
  source_error_id: z.string(),
  trigger_pattern: z.string().min(1),
  action: EvolutionActionSchema,
  priority: z.number().min(0).max(1).default(0.5),
  activation_count: z.number().int().min(0).default(0),
  success_count: z.number().int().min(0).default(0),
  success_rate: z.number().min(0).max(1).default(0.0),
  status: RuleStatusSchema.default("PENDING_APPROVAL"),
  anti_action: z.string().default(""),
  sandbox_trials: z.number().int().min(0).default(0),
  sandbox_successes: z.number().int().min(0).default(0),
  sandbox_success_rate: z.number().min(0).max(1).default(0.0),
  sandbox_promoted_at: z.string().default(""),
  probation_reason: z.string().default(""),
  probation_started_at: z.string().default(""),
  deprecated_reason: z.string().default(""),
  deprecated_at: z.string().default(""),
  trigger_log: z.array(TriggerLogEntrySchema).max(50).default([]),
  task_type_stats: TaskTypeStatsSchema.default({}),
  probation_task_count: z.number().int().min(0).default(0),
  probation_success_count: z.number().int().min(0).default(0),
  variance: z.number().min(0).default(0.0),
  scope_tag: z.string().default(""),
});

export type EvolutionRuleInput = z.input<typeof EvolutionRuleSchema>;
export type EvolutionRule = z.infer<typeof EvolutionRuleSchema>;

// ─── ErrorRecord Schema ───

export const ErrorRecordSchema = z.object({
  error_id: z.string().min(1),
  task_id: z.string(),
  error_type: z.string(),
  error_category: z.string(),
  error_message: z.string(),
  root_cause: z.string().default(""),
  suggested_fix: z.string().default(""),
  resolved: z.boolean().default(false),
  evolution_rule_id: z.string().default(""),
});

export type ErrorRecordInput = z.input<typeof ErrorRecordSchema>;
export type ErrorRecord = z.infer<typeof ErrorRecordSchema>;

// ─── EvolutionSnapshot Schema ───

export const EvolutionSnapshotSchema = z.object({
  snapshot_id: z.string().min(1),
  created_at: z.string(),
  reason: z.string(),
  rules: z.array(z.record(z.unknown())),
  is_auto: z.boolean().default(false),
});

export type EvolutionSnapshotInput = z.input<typeof EvolutionSnapshotSchema>;
export type EvolutionSnapshot = z.infer<typeof EvolutionSnapshotSchema>;

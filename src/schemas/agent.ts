/**
 * Agent 相关 Zod Schema。
 *
 * RULES_1-2: 所有外部输入用 Zod Schema 验证。
 */

import { z } from "zod";

// ─── AgentStatus Schema ───

export const AgentStatusSchema = z.enum([
  "CREATED",
  "INITIALIZING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "DESTROYED",
]);

// ─── TaskStatus Schema ───

export const TaskStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "PARTIAL",
]);

// ─── ProcessingResult Schema ───

export const ProcessingResultSchema = z.enum([
  "ACCEPT",
  "ACCEPT_PARTIAL",
  "REJECT",
  "ARCHIVE_AS_FLAWED",
  "CHALLENGE",
]);

// ─── TaskSpec Schema ───

export const TaskSpecSchema = z.object({
  task_id: z.string().min(1),
  type: z.string().min(1),
  description: z.string().min(1),
  input_data: z.record(z.unknown()).default({}),
  expected_output: z.string().default(""),
  tools: z.array(z.string()).default([]),
  knowledge_needed: z.array(z.string()).default([]),
  token_budget: z.number().int().positive().default(2000),
  timeout: z.number().int().positive().default(60),
  depends_on: z.array(z.string()).default([]),
});

export type TaskSpecInput = z.input<typeof TaskSpecSchema>;
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

// ─── SubAgentInfo Schema ───

export const SubAgentInfoSchema = z.object({
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
  status: AgentStatusSchema,
  created_at: z.string(),
});

export type SubAgentInfoInput = z.input<typeof SubAgentInfoSchema>;
export type SubAgentInfo = z.infer<typeof SubAgentInfoSchema>;

// ─── ExecutionPlan Schema ───

export const ExecutionPlanSchema = z.object({
  plan_id: z.string().min(1),
  goal: z.string().min(1),
  tasks: z.array(TaskSpecSchema),
});

export type ExecutionPlanInput = z.input<typeof ExecutionPlanSchema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

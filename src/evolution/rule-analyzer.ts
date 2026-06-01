/**
 * 规则分析器 — 从错误记录中分析并生成进化规则。
 *
 * 参考 SYSTEM_DESIGN.md 3.4.3 进化主流程。
 * 支持两种模式：
 * 1. LLM 分析（有 LLM 可用时）
 * 2. 规则匹配（降级模式，无 LLM 时）
 *
 * D.2 修复 M-04: 训练/验证数据分离。
 * ERROR_PATTERN_RULES 分为训练集（用于匹配）和验证集（用于评估），
 * 避免规则在训练数据上虚报成功率。
 */

import type { ErrorRecord } from "../schemas/evolution";
import type { EvolutionRuleInput } from "../schemas/evolution";
import { isValidAction, type EvolutionAction } from "../types/evolution";
import { sanitizePath } from "../security/llm-sanitize";
import { extractJSONObject, safeJSONParse } from "../utils/llm-parse";
import { createLogger } from "../observability/logger";
import { z } from "zod";

// ─── 类型定义 ───

export interface AnalysisResult {
  readonly rule: EvolutionRuleInput | null;
  readonly confidence: number;
  readonly reason: string;
  readonly source: "llm" | "rules";
}

// ─── 规则匹配器（降级模式） ───

/** 错误模式 → Action 映射 */
const ERROR_PATTERN_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly action: EvolutionAction;
  readonly triggerPattern: string;
  readonly confidence: number;
}> = [
  {
    pattern: /timeout|timed?\s*out|ETIMEDOUT/i,
    action: "RETRY_WITH_HIGHER_TIMEOUT",
    triggerPattern: "Task execution timeout",
    confidence: 0.7,
  },
  {
    pattern: /invalid\s*(output|response|format|json)/i,
    action: "ADD_VALIDATION_STEP",
    triggerPattern: "Invalid output format detected",
    confidence: 0.6,
  },
  {
    pattern: /too\s*(large|big|much|many)|overflow|OOM/i,
    action: "REDUCE_SCOPE",
    triggerPattern: "Task scope too large",
    confidence: 0.6,
  },
  {
    pattern: /too\s*complex|cannot\s*split|single\s*step/i,
    action: "SPLIT_SUBTASK",
    triggerPattern: "Task too complex for single step",
    confidence: 0.5,
  },
  {
    pattern: /not\s*found|no\s*(such|match|result)|missing/i,
    action: "ADD_KNOWLEDGE_RETRIEVAL",
    triggerPattern: "Missing knowledge or context",
    confidence: 0.5,
  },
  {
    pattern: /unexpected\s*error|unhandled|panic|crash/i,
    action: "ADD_ERROR_HANDLING",
    triggerPattern: "Unhandled error occurred",
    confidence: 0.6,
  },
  {
    pattern: /unclear|ambiguous|vague|confusing/i,
    action: "IMPROVE_PROMPT_CLARITY",
    triggerPattern: "Ambiguous task description",
    confidence: 0.4,
  },
  {
    pattern: /rate\s*limit|429|too\s*many\s*request/i,
    action: "ADD_FALLBACK_STRATEGY",
    triggerPattern: "API rate limit hit",
    confidence: 0.7,
  },
  {
    pattern: /token\s*limit|context\s*too\s*long|prompt_too_long/i,
    action: "DECREASE_TOKEN_BUDGET",
    triggerPattern: "Token budget exceeded",
    confidence: 0.7,
  },
  {
    pattern: /tool\s*not\s*(found|available|exist)/i,
    action: "CHANGE_TOOL_SELECTION",
    triggerPattern: "Tool not available",
    confidence: 0.6,
  },
  {
    pattern: /connection\s*(error|failed|refused|reset)/i,
    action: "ADD_RETRY_LOGIC",
    triggerPattern: "Connection error",
    confidence: 0.7,
  },
  {
    pattern: /permission\s*denied|forbidden|403/i,
    action: "SKIP_OPTIONAL_STEP",
    triggerPattern: "Permission denied",
    confidence: 0.5,
  },
];

// ─── M-04: 验证集（用于评估，不参与匹配） ───

const VALIDATION_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly action: EvolutionAction;
}> = [
  { pattern: /socket\s*hang\s*up|ECONNRESET/i, action: "ADD_RETRY_LOGIC" },
  { pattern: /ENOTFOUND|ENXIO|no\s*such\s*host/i, action: "ADD_KNOWLEDGE_RETRIEVAL" },
  { pattern: /stack\s*overflow|maximum\s*call/i, action: "SPLIT_SUBTASK" },
  { pattern: /unauthorized|401|unauthenticated/i, action: "SKIP_OPTIONAL_STEP" },
  { pattern: /disk\s*full|enospc/i, action: "REDUCE_SCOPE" },
];

/**
 * validateAgainstHoldout — 在验证集上评估规则置信度。
 *
 * M-04: 如果验证集匹配的 action 与训练集不同，降低置信度。
 */
function validateAgainstHoldout(
  error: ErrorRecord,
  matchedAction: EvolutionAction,
  baseConfidence: number,
): number {
  const searchText = [
    error.error_message,
    error.error_type,
    error.error_category,
    error.root_cause,
  ].join(" ");

  for (const vp of VALIDATION_PATTERNS) {
    if (vp.pattern.test(searchText)) {
      if (vp.action !== matchedAction) {
        // 验证集建议不同 action → 降低置信度
        return baseConfidence * 0.7;
      }
      // 验证集确认相同 action → 保持置信度
      break;
    }
  }

  return baseConfidence;
}

/**
 * analyzeWithRules — 基于规则的错误分析（降级模式）。
 *
 * 使用预定义的错误模式 → Action 映射。
 * 返回置信度最高的匹配结果。
 */
export function analyzeWithRules(error: ErrorRecord): AnalysisResult {
  const searchText = [
    error.error_message,
    error.error_type,
    error.error_category,
    error.root_cause,
  ].join(" ");

  let bestMatch: (typeof ERROR_PATTERN_RULES)[number] | null = null;
  let bestScore = 0;

  for (const rule of ERROR_PATTERN_RULES) {
    if (rule.pattern.test(searchText)) {
      // 置信度 = 模式置信度 × 匹配位置权重
      const messageMatch = rule.pattern.test(error.error_message) ? 1.0 : 0.8;
      const typeMatch = rule.pattern.test(error.error_type) ? 1.0 : 0.6;
      const score = rule.confidence * (messageMatch + typeMatch) / 2;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = rule;
      }
    }
  }

  if (bestMatch === null) {
    return {
      rule: null,
      confidence: 0,
      reason: "No matching error pattern found",
      source: "rules" as const,
    };
  }

  // M-04: 在验证集上评估置信度
  const validatedScore = validateAgainstHoldout(error, bestMatch.action, bestScore);

  const ruleId = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  return {
    rule: {
      rule_id: ruleId,
      created_at: new Date().toISOString(),
      source_error_id: error.error_id,
      trigger_pattern: bestMatch.triggerPattern,
      action: bestMatch.action,
      priority: Math.min(1, validatedScore),
    },
    confidence: validatedScore,
    reason: `Pattern matched: ${bestMatch.pattern.source}`,
    source: "rules" as const,
  };
}

// ─── LLM 分析器 ───

/**
 * analyzeWithLLM — 基于 LLM 的错误分析。
 *
 * 构造 prompt 发送给 LLM，要求返回 JSON 格式的规则建议。
 * 降级条件：LLM 不可用 → 回退到 analyzeWithRules。
 */
export async function analyzeWithLLM(
  error: ErrorRecord,
  llmClient?: { invoke: (messages: Array<{ role: string; content: string }>) => Promise<string> },
): Promise<AnalysisResult> {
  const logger = createLogger({ source: "evolution:rule-analyzer" });

  if (llmClient === undefined) {
    return analyzeWithRules(error);
  }

  try {
    // 路径脱敏：防止文件路径泄露到外部 LLM
    const safeErrorMessage = sanitizePath(error.error_message);
    const safeRootCause = sanitizePath(error.root_cause);

    // Action 名称抽象：将内部 Action 名称映射为通用描述
    const actionDescriptions = [
      "retry_with_longer_timeout",
      "add_input_validation",
      "reduce_task_scope",
      "split_into_subtasks",
      "add_context_retrieval",
      "add_error_handling",
      "improve_instruction_clarity",
      "add_fallback_strategy",
      "sample_before_processing",
      "increase_resource_budget",
      "decrease_resource_budget",
      "change_tool_choice",
      "add_retry_logic",
      "skip_optional_step",
      "reorder_execution_steps",
      "advisory_only",
    ];

    const prompt = `Analyze this error and suggest an evolution rule.

Error type: ${error.error_type}
Error category: ${error.error_category}
Error message: ${safeErrorMessage}
Root cause: ${safeRootCause}

Respond in JSON format:
{
  "action": "<one of the valid action descriptions below>",
  "trigger_pattern": "<description of when this rule should trigger>",
  "priority": <0.0-1.0>,
  "anti_action": "<opposing action if any, empty string if none>",
  "confidence": <0.0-1.0>,
  "reason": "<explanation>"
}

Use English field names in JSON output. Output ONLY the JSON object, no additional text.

Valid actions: ${actionDescriptions.join(", ")}`;

    const response = await llmClient.invoke([
      { role: "user", content: prompt },
    ]);

    const jsonStr = extractJSONObject(response);
    if (jsonStr === null) {
      return analyzeWithRules(error);
    }

    const rawParsed = safeJSONParse(jsonStr);

    const LLMRuleAnalysisSchema = z.object({
      action: z.string(),
      trigger_pattern: z.string().optional(),
      priority: z.number().min(0).max(1).optional(),
      anti_action: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      reason: z.string().optional(),
    });

    const validated = LLMRuleAnalysisSchema.safeParse(rawParsed);
    if (!validated.success) {
      return analyzeWithRules(error);
    }

    const parsed = validated.data;

    // 将通用描述映射回内部 Action 名称
    const ACTION_DESCRIPTION_MAP: Readonly<Record<string, EvolutionAction>> = {
      retry_with_longer_timeout: "RETRY_WITH_HIGHER_TIMEOUT",
      add_input_validation: "ADD_VALIDATION_STEP",
      reduce_task_scope: "REDUCE_SCOPE",
      split_into_subtasks: "SPLIT_SUBTASK",
      add_context_retrieval: "ADD_KNOWLEDGE_RETRIEVAL",
      add_error_handling: "ADD_ERROR_HANDLING",
      improve_instruction_clarity: "IMPROVE_PROMPT_CLARITY",
      add_fallback_strategy: "ADD_FALLBACK_STRATEGY",
      sample_before_processing: "SAMPLE_BEFORE_PROCESS",
      increase_resource_budget: "INCREASE_TOKEN_BUDGET",
      decrease_resource_budget: "DECREASE_TOKEN_BUDGET",
      change_tool_choice: "CHANGE_TOOL_SELECTION",
      add_retry_logic: "ADD_RETRY_LOGIC",
      skip_optional_step: "SKIP_OPTIONAL_STEP",
      reorder_execution_steps: "REORDER_EXECUTION",
      advisory_only: "ADVISORY_ONLY",
    };

    const rawAction = parsed.action;
    const mappedAction = ACTION_DESCRIPTION_MAP[rawAction] ?? rawAction;

    // 验证 action
    if (!isValidAction(mappedAction)) {
      logger.warn("LLM returned invalid action, falling back to rule analysis", {
        rawAction,
        mappedAction,
        errorType: error.error_type,
      });
      return analyzeWithRules(error);
    }

    const ruleId = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    return {
      rule: {
        rule_id: ruleId,
        created_at: new Date().toISOString(),
        source_error_id: error.error_id,
        trigger_pattern: parsed.trigger_pattern ?? "",
        action: mappedAction,
        priority: parsed.priority ?? 0.5,
        anti_action: parsed.anti_action ?? "",
      },
      confidence: parsed.confidence ?? 0.5,
      reason: parsed.reason ?? "LLM analysis",
      source: "llm" as const,
    };
  } catch (err) {
    logger.warn("LLM analysis failed, falling back to rule analysis", {
      error: err instanceof Error ? err.message : String(err),
      errorType: error.error_type,
      errorCategory: error.error_category,
    });
    return analyzeWithRules(error);
  }
}

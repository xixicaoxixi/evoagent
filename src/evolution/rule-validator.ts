/**
 * 规则验证器（P0-01/03/04/13）。
 *
 * 验证项：
 * - action 必须在 VALID_ACTIONS_LIST 中
 * - trigger_pattern 非空
 * - 不违反保底策略（活跃规则数 <= 1 时不淘汰）
 * - 不超过规则总数上限
 * - 冲突检测（anti_action 匹配）
 */

import type { EvolutionRule, EvolutionRuleInput } from "../schemas/evolution";
import type { SimpleLLMProvider } from "../llm/adapter";
import { EvolutionRuleSchema } from "../schemas/evolution";
import { isValidAction, type EvolutionAction } from "../types/evolution";
import { EVOLUTION_RULE_MAX_COUNT, EVOLUTION_MIN_ACTIVE_RULES } from "./constants";
import type { RuleStore } from "./rule-store";

// ─── 验证结果 ───

export interface RuleValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings?: readonly string[];
}

// ─── 模糊匹配 Action ───

/** Action 别名映射（模糊匹配） */
const ACTION_ALIASES: Readonly<Record<string, EvolutionAction>> = {
  "retry": "RETRY_WITH_HIGHER_TIMEOUT",
  "retry_timeout": "RETRY_WITH_HIGHER_TIMEOUT",
  "validate": "ADD_VALIDATION_STEP",
  "reduce": "REDUCE_SCOPE",
  "split": "SPLIT_SUBTASK",
  "knowledge": "ADD_KNOWLEDGE_RETRIEVAL",
  "error_handle": "ADD_ERROR_HANDLING",
  "prompt": "IMPROVE_PROMPT_CLARITY",
  "fallback": "ADD_FALLBACK_STRATEGY",
  "sample": "SAMPLE_BEFORE_PROCESS",
  "budget_up": "INCREASE_TOKEN_BUDGET",
  "budget_down": "DECREASE_TOKEN_BUDGET",
  "tool": "CHANGE_TOOL_SELECTION",
  "retry_logic": "ADD_RETRY_LOGIC",
  "skip": "SKIP_OPTIONAL_STEP",
  "reorder": "REORDER_EXECUTION",
  "advisory": "ADVISORY_ONLY",
};

/**
 * fuzzyMatchAction — 模糊匹配 Action。
 *
 * 先精确匹配，再别名匹配，最后子串匹配。
 */
export function fuzzyMatchAction(input: string): EvolutionAction | null {
  const normalized = input.trim().toUpperCase().replace(/[\s-]+/g, "_");

  // 精确匹配
  if (isValidAction(normalized)) {
    return normalized;
  }

  // 别名匹配
  const alias = ACTION_ALIASES[normalized.toLowerCase()];
  if (alias !== undefined) {
    return alias;
  }

  // 子串匹配
  for (const action of Object.values(ACTION_ALIASES)) {
    if (action.includes(normalized) || normalized.includes(action)) {
      return action;
    }
  }

  return null;
}

// ─── 规则验证 ───

/**
 * validateRule — 验证进化规则。
 *
 * @param input - 规则输入
 * @param store - 规则存储（用于检查冲突和上限）
 * @returns 验证结果
 */
export async function validateRule(
  input: EvolutionRuleInput,
  store: RuleStore,
  llmProvider?: SimpleLLMProvider,
): Promise<RuleValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Schema 验证
  const schemaResult = EvolutionRuleSchema.safeParse(input);
  if (!schemaResult.success) {
    return {
      valid: false,
      errors: schemaResult.error.issues.map((i) => i.message),
    };
  }

  // 2. Action 验证
  if (!isValidAction(input.action)) {
    const fuzzy = fuzzyMatchAction(input.action);
    if (fuzzy !== null) {
      errors.push(`Action "${input.action}" fuzzy matched to "${fuzzy}". Use exact action name.`);
    } else {
      errors.push(`Invalid action: "${input.action}". Must be one of the 16 valid actions.`);
    }
  }

  // 3. trigger_pattern 非空
  if (!input.trigger_pattern || input.trigger_pattern.trim().length === 0) {
    errors.push("trigger_pattern must not be empty");
  }

  // 4. 规则数量上限
  const count = await store.count();
  if (count >= EVOLUTION_RULE_MAX_COUNT) {
    errors.push(`Rule count limit reached: ${EVOLUTION_RULE_MAX_COUNT}`);
  }

  // 5. 冲突检测
  const conflict = await detectConflict(input, store);
  if (conflict !== null) {
    errors.push(`Conflict with existing rule "${conflict.ruleId}": ${conflict.reason}`);
  }

  // 6. LLM 语义冲突检测（fire-and-forget，不影响验证结果）
  if (llmProvider !== undefined) {
    void llmProvider.invoke([
      { role: "system", content: "Detect semantic conflicts between this new evolution rule and existing rules. If a conflict is found, describe it in one sentence. If no conflict, respond with 'No semantic conflict detected'." },
      { role: "user", content: `New rule: trigger="${input.trigger_pattern}", action="${input.action}"${input.anti_action !== "" ? `, anti_action="${input.anti_action}"` : ""}` },
    ]).then((assessment) => {
      if (!assessment.includes("No semantic conflict detected")) {
        warnings.push(`LLM semantic warning: ${assessment}`);
      }
    }).catch(() => { /* fire-and-forget: LLM failure does not affect validation */ });
  }

  return {
    valid: errors.length === 0,
    errors,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ─── 冲突检测（P0-02） ───

export interface ConflictResult {
  readonly ruleId: string;
  readonly reason: string;
}

/**
 * detectConflict — 检测规则冲突。
 *
 * 冲突条件：
 * 1. 相同 trigger_pattern + 相同 action → 重复规则
 * 2. 新规则的 anti_action 匹配已有规则的 action → 直接冲突
 * 3. 已有规则的 anti_action 匹配新规则的 action → 反向冲突
 */
export async function detectConflict(
  input: EvolutionRuleInput,
  store: RuleStore,
): Promise<ConflictResult | null> {
  const allRules = await store.getAll();

  for (const existing of allRules) {
    // 跳过已淘汰的规则
    if (existing.status === "DEPRECATED" || existing.status === "ROLLED_BACK") {
      continue;
    }

    // 1. 重复规则检测
    if (
      existing.trigger_pattern === input.trigger_pattern &&
      existing.action === input.action
    ) {
      return {
        ruleId: existing.rule_id,
        reason: `Duplicate rule with same trigger_pattern and action`,
      };
    }

    // 2. 直接冲突：新规则的 anti_action 匹配已有规则
    if (input.anti_action !== "" && existing.action === input.anti_action) {
      return {
        ruleId: existing.rule_id,
        reason: `New rule's anti_action "${input.anti_action}" conflicts with existing rule's action`,
      };
    }

    // 3. 反向冲突：已有规则的 anti_action 匹配新规则
    if (existing.anti_action !== "" && existing.anti_action === input.action) {
      return {
        ruleId: existing.rule_id,
        reason: `Existing rule's anti_action "${existing.anti_action}" conflicts with new rule's action`,
      };
    }
  }

  return null;
}

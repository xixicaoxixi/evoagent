/**
 * EvolutionRule 状态枚举 + Action 枚举。
 *
 * 规则生命周期: PENDING_APPROVAL → SANDBOX → PROBATION → ACTIVE → DEPRECATED | ROLLED_BACK
 * 16 种合法 Action 用于进化规则的动作执行。
 */

// ─── RuleStatus 枚举 ───

export const RuleStatus = {
  PENDING_APPROVAL: "PENDING_APPROVAL",
  SANDBOX: "SANDBOX",
  PROBATION: "PROBATION",
  ACTIVE: "ACTIVE",
  DEPRECATED: "DEPRECATED",
  ROLLED_BACK: "ROLLED_BACK",
} as const;

export type RuleStatus =
  (typeof RuleStatus)[keyof typeof RuleStatus];

// ─── 16 种合法 Action 枚举 ───

export const EvolutionAction = {
  RETRY_WITH_HIGHER_TIMEOUT: "RETRY_WITH_HIGHER_TIMEOUT",
  ADD_VALIDATION_STEP: "ADD_VALIDATION_STEP",
  REDUCE_SCOPE: "REDUCE_SCOPE",
  SPLIT_SUBTASK: "SPLIT_SUBTASK",
  ADD_KNOWLEDGE_RETRIEVAL: "ADD_KNOWLEDGE_RETRIEVAL",
  ADD_ERROR_HANDLING: "ADD_ERROR_HANDLING",
  IMPROVE_PROMPT_CLARITY: "IMPROVE_PROMPT_CLARITY",
  ADD_FALLBACK_STRATEGY: "ADD_FALLBACK_STRATEGY",
  SAMPLE_BEFORE_PROCESS: "SAMPLE_BEFORE_PROCESS",
  INCREASE_TOKEN_BUDGET: "INCREASE_TOKEN_BUDGET",
  DECREASE_TOKEN_BUDGET: "DECREASE_TOKEN_BUDGET",
  CHANGE_TOOL_SELECTION: "CHANGE_TOOL_SELECTION",
  ADD_RETRY_LOGIC: "ADD_RETRY_LOGIC",
  SKIP_OPTIONAL_STEP: "SKIP_OPTIONAL_STEP",
  REORDER_EXECUTION: "REORDER_EXECUTION",
  ADVISORY_ONLY: "ADVISORY_ONLY",
} as const;

export type EvolutionAction =
  (typeof EvolutionAction)[keyof typeof EvolutionAction];

/** 所有合法 Action 的集合（用于 O(1) 查找验证） */
export const VALID_ACTIONS: ReadonlySet<string> = new Set(
  Object.values(EvolutionAction),
);

/** 检查 action 是否为合法的进化动作 */
export function isValidAction(action: string): action is EvolutionAction {
  return VALID_ACTIONS.has(action);
}

// ─── MessageType 枚举（P2P 通信） ───

export const MessageType = {
  KNOWLEDGE_OFFER: "KNOWLEDGE_OFFER",
  KNOWLEDGE_REQUEST: "KNOWLEDGE_REQUEST",
  TASK_DELEGATION: "TASK_DELEGATION",
  FEEDBACK: "FEEDBACK",
  CHALLENGE: "CHALLENGE",
  EVOLUTION_SYNC: "EVOLUTION_SYNC",
  CODE_PROPOSAL: "CODE_PROPOSAL",
  ARCHITECTURE_PROPOSAL: "ARCHITECTURE_PROPOSAL",
  META_EVALUATION: "META_EVALUATION",
  STRATEGY_EXPLORATION: "STRATEGY_EXPLORATION",
} as const;

export type MessageType =
  (typeof MessageType)[keyof typeof MessageType];

// ─── 合法状态转换表 ───

const RULE_TRANSITIONS: Readonly<Record<RuleStatus, readonly RuleStatus[]>> = {
  PENDING_APPROVAL: ["SANDBOX", "DEPRECATED"],
  SANDBOX: ["PROBATION", "DEPRECATED", "ROLLED_BACK"],
  PROBATION: ["ACTIVE", "DEPRECATED", "ROLLED_BACK"],
  ACTIVE: ["DEPRECATED", "PROBATION"],
  DEPRECATED: [],
  ROLLED_BACK: [],
};

/** 检查规则状态转换是否合法 */
export function canRuleTransition(
  from: RuleStatus,
  to: RuleStatus,
): boolean {
  return RULE_TRANSITIONS[from]?.includes(to) ?? false;
}

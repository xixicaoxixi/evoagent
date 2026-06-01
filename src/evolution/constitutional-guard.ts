/**
 * 宪法守卫 — 确保任何修改都不触及宪法层参数。
 *
 * 参考 SYSTEM_DESIGN.md 3.5.1。
 * 三层防护：
 * 1. 宪法层参数（7 个）— 不可修改
 * 2. 可进化参数（8 个二阶参数）— 可在范围内修改
 * 3. 其他参数 — 不可修改
 */

// ─── 宪法层参数（不可修改） ───

const CONSTITUTIONAL_PARAMS: ReadonlySet<string> = new Set([
  "AB_TEST_JUDGE_WEIGHTS",
  "SYSTEM_PROMPT_CORE",
  "EVOLUTION_RULE_MAX_COUNT",
  "KNOWLEDGE_MIN_ENTRIES",
  "EVOLUTION_MIN_ACTIVE_RULES",
  "CODE_SANDBOX_TIMEOUT",
  "PROTOCOL_HMAC_KEY",
]);

// ─── 可进化参数定义 ───

export interface EvolvableParamDef {
  readonly type: "float" | "int" | "dict";
  readonly min?: number;
  readonly max?: number;
  readonly layer: "second_order";
}

const EVOLVABLE_PARAMS: Readonly<Record<string, EvolvableParamDef>> = {
  TASK_TYPE_IMPORTANCE: { type: "dict", layer: "second_order" },
  PROMOTION_IMPROVEMENT_MIN: { type: "float", min: 0.05, max: 0.5, layer: "second_order" },
  DEPRECATION_RATE_MIN: { type: "float", min: 0.05, max: 0.5, layer: "second_order" },
  EVOLUTION_SANDBOX_MIN_SUCCESS_RATE: { type: "float", min: 0.3, max: 0.9, layer: "second_order" },
  EVOLUTION_SANDBOX_MIN_TRIALS: { type: "int", min: 2, max: 10, layer: "second_order" },
  KNOWLEDGE_FORGET_MAX_UNUSED_DAYS: { type: "int", min: 7, max: 90, layer: "second_order" },
  KNOWLEDGE_COHESION_THRESHOLD: { type: "float", min: 0.3, max: 0.9, layer: "second_order" },
  KNOWLEDGE_EXPLORATION_INTERVAL: { type: "int", min: 5, max: 50, layer: "second_order" },
};

// ─── 宪法层不可变范围 ───

const IMMUTABLE_SCOPES: ReadonlySet<string> = new Set([
  "communication_protocol",
  "ppaf_loop_structure",
  "safety_constraints",
  "constitutional_immutability",
  "permission_isolation",
]);

// ─── 验证结果 ───

export interface ProposalValidation {
  readonly valid: boolean;
  readonly reason: string;
  readonly clampedValue?: unknown;
}

// ─── 宪法守卫 ───

/**
 * isConstitutional — 检查参数是否为宪法层参数。
 */
export function isConstitutional(paramName: string): boolean {
  return CONSTITUTIONAL_PARAMS.has(paramName);
}

/**
 * isEvolvable — 检查参数是否为可进化参数。
 */
export function isEvolvable(paramName: string): boolean {
  return paramName in EVOLVABLE_PARAMS;
}

/**
 * getEvolvableParamDef — 获取可进化参数定义。
 */
export function getEvolvableParamDef(
  paramName: string,
): EvolvableParamDef | undefined {
  return EVOLVABLE_PARAMS[paramName];
}

/**
 * listConstitutionalParams — 列出所有宪法层参数。
 */
export function listConstitutionalParams(): readonly string[] {
  return [...CONSTITUTIONAL_PARAMS];
}

/**
 * listEvolvableParams — 列出所有可进化参数。
 */
export function listEvolvableParams(): readonly string[] {
  return Object.keys(EVOLVABLE_PARAMS);
}

/**
 * validateProposal — 验证参数修改提案。
 *
 * @returns 验证结果（valid=true 表示提案可接受）
 */
export function validateProposal(
  paramName: string,
  proposedValue: unknown,
): ProposalValidation {
  // 1. 宪法层检查
  if (isConstitutional(paramName)) {
    return {
      valid: false,
      reason: `Parameter "${paramName}" is constitutional and cannot be modified`,
    };
  }

  // 2. 可进化参数检查
  const def = getEvolvableParamDef(paramName);
  if (def === undefined) {
    return {
      valid: false,
      reason: `Parameter "${paramName}" is not evolvable`,
    };
  }

  // 3. 类型检查
  if (def.type === "float") {
    if (typeof proposedValue !== "number") {
      return { valid: false, reason: `Expected float, got ${typeof proposedValue}` };
    }
    const clamped = clamp(proposedValue, def.min, def.max);
    if (clamped !== proposedValue) {
      return {
        valid: true,
        reason: `Value clamped from ${proposedValue} to ${clamped}`,
        clampedValue: clamped,
      };
    }
    return { valid: true, reason: "OK" };
  }

  if (def.type === "int") {
    if (typeof proposedValue !== "number") {
      return { valid: false, reason: `Expected int, got ${typeof proposedValue}` };
    }
    const clamped = clamp(Math.round(proposedValue), def.min, def.max);
    if (clamped !== proposedValue) {
      return {
        valid: true,
        reason: `Value clamped from ${proposedValue} to ${clamped}`,
        clampedValue: clamped,
      };
    }
    return { valid: true, reason: "OK" };
  }

  if (def.type === "dict") {
    if (typeof proposedValue !== "object" || proposedValue === null) {
      return { valid: false, reason: `Expected dict, got ${typeof proposedValue}` };
    }
    return { valid: true, reason: "OK" };
  }

  return { valid: false, reason: `Unknown parameter type: ${def.type}` };
}

/**
 * isImmutableScope — 检查修改范围是否在不可变范围内。
 */
export function isImmutableScope(scope: string): boolean {
  return IMMUTABLE_SCOPES.has(scope);
}

// ─── 辅助函数 ───

function clamp(value: number, min?: number, max?: number): number {
  let result = value;
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
}

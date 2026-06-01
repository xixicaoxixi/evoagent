/**
 * PermissionResult 联合类型。
 *
 * 工具权限检查的结果类型，使用 Discriminated Union 区分不同权限行为。
 * RULES_2-2: Fail-Closed 默认值 — 不确定时选更安全的默认值。
 */

// ─── PermissionBehavior 枚举 ───

export const PermissionBehavior = {
  ALLOW: "allow",
  DENY: "deny",
  ASK_USER: "ask_user",
} as const;

export type PermissionBehavior =
  (typeof PermissionBehavior)[keyof typeof PermissionBehavior];

// ─── PermissionResult 联合类型 ───

export interface PermissionAllow {
  readonly behavior: "allow";
  readonly updatedInput?: Record<string, unknown>;
}

export interface PermissionDeny {
  readonly behavior: "deny";
  readonly reason: string;
}

export interface PermissionAskUser {
  readonly behavior: "ask_user";
  readonly reason?: string;
  readonly prompt?: string;
}

export type PermissionResult =
  | PermissionAllow
  | PermissionDeny
  | PermissionAskUser;

// ─── 工厂函数（Fail-Closed 默认值） ───

export function allowPermission(
  updatedInput?: Record<string, unknown>,
): PermissionAllow {
  if (updatedInput !== undefined) {
    return { behavior: "allow", updatedInput };
  }
  return { behavior: "allow" };
}

export function denyPermission(reason: string): PermissionDeny {
  return { behavior: "deny", reason };
}

export function askUserPermission(
  reason?: string,
  prompt?: string,
): PermissionAskUser {
  return {
    behavior: "ask_user",
    ...(reason !== undefined ? { reason } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
  };
}

// ─── 类型守卫 ───

export function isAllowed(result: PermissionResult): result is PermissionAllow {
  return result.behavior === "allow";
}

export function isDenied(result: PermissionResult): result is PermissionDeny {
  return result.behavior === "deny";
}

export function isAskUser(result: PermissionResult): result is PermissionAskUser {
  return result.behavior === "ask_user";
}

// ─── ValidationResult（工具输入验证结果） ───

export interface ValidationOk {
  readonly ok: true;
}

export interface ValidationErr {
  readonly ok: false;
  readonly error: string;
}

export type ValidationResult = ValidationOk | ValidationErr;

export function validationOk(): ValidationOk {
  return { ok: true };
}

export function validationErr(error: string): ValidationErr {
  return { ok: false, error };
}

// ─── C.1: PermissionVerdict（决策原因 Discriminated Union） ───

/**
 * 权限决策原因 — 标识决策由哪个检查阶段产生。
 *
 * RULES_1-3: Discriminated Union（通过 phase 字段区分）。
 * RULES_2-2: Fail-Closed 默认值。
 *
 * Phase 0（hardline，绝对不可绕过）：
 * - hardlineBlock: Hardline 无条件阻止（灾难性命令）
 *
 * Phase 1（override-proof，不可绕过）：
 * - matchedDenyRule: Deny 规则匹配
 * - matchedAskRule: Ask 规则匹配
 * - toolSelfCheck: 工具自身 checkPermissions 判断
 * - toolDeny: 工具返回 deny
 * - requiresUserInteraction: 工具标记需要用户交互
 * - contentSafetyAsk: 内容级安全检查
 * - safetyCheck: 敏感路径安全检查
 *
 * Phase 2（可被 override 模式绕过）：
 * - overrideMode: Override 模式放行
 * - matchedAllowRule: Allow 规则匹配
 *
 * Phase 3（默认）：
 * - defaultAsk: 默认需要用户确认
 */
export type PermissionVerdict =
  | { readonly phase: "hardlineBlock"; readonly reason: string; readonly patternId?: string }
  | { readonly phase: "matchedDenyRule"; readonly reason: string; readonly ruleId?: string }
  | { readonly phase: "matchedAskRule"; readonly reason: string; readonly ruleId?: string }
  | { readonly phase: "toolSelfCheck"; readonly reason: string }
  | { readonly phase: "toolDeny"; readonly reason: string }
  | { readonly phase: "requiresUserInteraction"; readonly reason: string }
  | { readonly phase: "contentSafetyAsk"; readonly reason: string }
  | { readonly phase: "safetyCheck"; readonly reason: string }
  | { readonly phase: "overrideMode"; readonly reason: string }
  | { readonly phase: "matchedAllowRule"; readonly reason: string; readonly ruleId?: string }
  | { readonly phase: "defaultAsk"; readonly reason: string };

/** Phase 0 判定（hardline，绝对不可绕过） */
export type HardlineVerdict = Extract<
  PermissionVerdict,
  { readonly phase: "hardlineBlock" }
>;

/** Phase 0+1 判定（override-proof） */
export type OverrideProofVerdict = Extract<
  PermissionVerdict,
  { readonly phase: "hardlineBlock" | "matchedDenyRule" | "contentSafetyAsk" | "safetyCheck" }
>;

/** 判断 verdict 是否为 override-proof（不可绕过） */
export function isOverrideProof(verdict: PermissionVerdict): boolean {
  return (
    verdict.phase === "hardlineBlock" ||
    verdict.phase === "matchedDenyRule" ||
    verdict.phase === "contentSafetyAsk" ||
    verdict.phase === "safetyCheck"
  );
}

// ─── C.1: 权限规则类型 ───

export type PermissionRuleBehavior = "allow" | "deny" | "ask";

export interface PermissionRule {
  readonly id: string;
  readonly behavior: PermissionRuleBehavior;
  readonly pattern: string;
  readonly reason: string;
  /** 是否为 override-proof 规则（deny 规则默认为 override-proof） */
  readonly overrideProof?: boolean;
}

// ─── C.3: PermissionAuditEntry（审计记录） ───

export interface PermissionAuditEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly decision: "allow" | "deny" | "ask_user";
  readonly verdictPhase: string;
  readonly reason: string;
  readonly durationMs: number;
  readonly inputSnapshot?: string;
}

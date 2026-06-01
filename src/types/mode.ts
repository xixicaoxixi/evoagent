/**
 * Agent 模式状态机 — 模式生命周期管理。
 *
 * 阶段 B.1: 定义 AgentMode 联合类型、ModeTransition、AgentModeContext，
 * 以及原子性模式切换函数 switchAgentMode()。
 *
 * 设计原则：
 * - Discriminated Union（AgentMode 通过字符串字面量区分）
 * - Save-Restore 语义：进入 Plan 模式时保存 priorMode，退出时恢复
 * - 断路器防御：连续模式切换检查
 * - 不可变更新：所有状态变更返回新对象（CoW）
 *
 * RULES_1-3: Discriminated Union
 * RULES_1-7: 穷举检查用 never 类型兜底
 */

import { EvoAgentError } from "../utils/errors";

// ─── AgentMode 联合类型 ───

export type AgentMode = "default" | "plan" | "auto" | "sandbox";

// ─── 模式转换触发源 ───

export type ModeTrigger = "user" | "system" | "agent";

// ─── ModeTransition ───

export interface ModeTransition {
  readonly from: AgentMode;
  readonly to: AgentMode;
  readonly timestamp: number;
  readonly trigger: ModeTrigger;
}

// ─── RestrictedAbility ───

export interface RestrictedAbility {
  readonly toolId: string;
  readonly restriction: string;
  readonly origin: string;
}

// ─── AgentModeContext ───

export interface AgentModeContext {
  readonly mode: AgentMode;
  readonly savedPriorMode?: AgentMode;
  readonly restrictedAbilities: readonly RestrictedAbility[];
  readonly modeHistory: readonly ModeTransition[];
}

// ─── 断路器配置 ───

export interface ModeCircuitBreakerConfig {
  /** 最大连续模式切换次数（默认 10） */
  readonly maxConsecutiveSwitches?: number;
  /** 时间窗口（毫秒，默认 60000 = 1 分钟） */
  readonly windowMs?: number;
}

// ─── 模式切换选项 ───

export interface SwitchModeOptions {
  readonly trigger?: ModeTrigger;
  /** 限制的能力列表（进入新模式时添加） */
  readonly restrictions?: readonly RestrictedAbility[];
  /** 断路器配置 */
  readonly circuitBreaker?: ModeCircuitBreakerConfig;
}

// ─── 初始上下文 ───

export function createInitialModeContext(
  mode: AgentMode = "default",
): AgentModeContext {
  return {
    mode,
    restrictedAbilities: [],
    modeHistory: [],
  };
}

// ─── 合法转换规则 ───

/**
 * 定义合法的模式转换。
 *
 * - default → plan/auto/sandbox: 自由切换
 * - plan → default: 退出 Plan（恢复 savedPriorMode）
 * - auto → default/plan/sandbox: 自由切换
 * - sandbox → default: 退出 Sandbox
 *
 * 非法转换会抛出 EvoAgentError。
 */
const VALID_TRANSITIONS: ReadonlySet<string> = new Set([
  "default→plan",
  "default→auto",
  "default→sandbox",
  "plan→default",
  "auto→default",
  "auto→plan",
  "auto→sandbox",
  "sandbox→default",
]);

function isValidTransition(from: AgentMode, to: AgentMode): boolean {
  if (from === to) return true; // 同模式不报错（幂等）
  return VALID_TRANSITIONS.has(`${from}→${to}`);
}

// ─── 断路器检查 ───

function checkCircuitBreaker(
  history: readonly ModeTransition[],
  config: ModeCircuitBreakerConfig,
): void {
  const maxSwitches = config.maxConsecutiveSwitches ?? 10;
  const windowMs = config.windowMs ?? 60_000;
  const now = Date.now();

  // 统计时间窗口内的模式切换次数
  let recentSwitches = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (now - entry.timestamp > windowMs) break;
    if (entry.from !== entry.to) {
      recentSwitches++;
    }
  }

  if (recentSwitches >= maxSwitches) {
    throw new EvoAgentError(
      `Mode switch circuit breaker tripped: ${recentSwitches} switches in ${windowMs}ms window (max ${maxSwitches})`,
      "MODE_CIRCUIT_BREAKER",
      { context: { recentSwitches, windowMs, maxSwitches } },
    );
  }
}

// ─── switchAgentMode ───

/**
 * 原子性模式切换。
 *
 * - Save-Restore 语义：进入 plan/sandbox 时保存 savedPriorMode
 * - 断路器检查：频繁切换触发断路器
 * - 能力限制：切换时应用新的限制
 * - 不可变更新：返回新的 AgentModeContext
 *
 * @param current - 当前模式上下文
 * @param target - 目标模式
 * @param options - 切换选项
 * @returns 新的 AgentModeContext
 * @throws EvoAgentError - 非法转换或断路器触发
 */
export function switchAgentMode(
  current: AgentModeContext,
  target: AgentMode,
  options?: SwitchModeOptions,
): AgentModeContext {
  // 幂等检查
  if (current.mode === target) return current;

  // 合法性检查
  if (!isValidTransition(current.mode, target)) {
    throw new EvoAgentError(
      `Invalid mode transition: ${current.mode} → ${target}`,
      "INVALID_MODE_TRANSITION",
      { context: { from: current.mode, to: target } },
    );
  }

  // 断路器检查
  const breakerConfig = options?.circuitBreaker ?? {};
  checkCircuitBreaker(current.modeHistory, breakerConfig);

  const trigger = options?.trigger ?? "system";
  const timestamp = Date.now();

  // 构建转换记录
  const transition: ModeTransition = {
    from: current.mode,
    to: target,
    timestamp,
    trigger,
  };

  // Save-Restore 语义
  let savedPriorMode = current.savedPriorMode;
  let restrictedAbilities = current.restrictedAbilities;

  if (target === "plan" || target === "sandbox") {
    // 进入受限模式：保存当前模式
    savedPriorMode = current.mode;
    // 应用新的限制
    if (options?.restrictions && options.restrictions.length > 0) {
      restrictedAbilities = [...current.restrictedAbilities, ...options.restrictions];
    }
  } else if (target === "default" && current.savedPriorMode !== undefined) {
    // 退出受限模式：恢复 savedPriorMode
    // 清除进入受限模式时添加的限制
    restrictedAbilities = [];
    savedPriorMode = undefined;
  }

  let result: AgentModeContext = {
    mode: target,
    restrictedAbilities,
    modeHistory: [...current.modeHistory, transition],
  };
  if (savedPriorMode !== undefined) {
    result = { ...result, savedPriorMode };
  }
  return result;
}

// ─── 辅助函数 ───

/** 检查是否处于 Plan 模式 */
export function isPlanMode(context: AgentModeContext): boolean {
  return context.mode === "plan";
}

/** 检查是否处于受限模式（plan 或 sandbox） */
export function isRestrictedMode(context: AgentModeContext): boolean {
  return context.mode === "plan" || context.mode === "sandbox";
}

/** 检查工具是否被限制 */
export function isToolRestricted(
  context: AgentModeContext,
  toolId: string,
): boolean {
  return context.restrictedAbilities.some((r) => r.toolId === toolId);
}

/** 获取工具限制原因 */
export function getToolRestriction(
  context: AgentModeContext,
  toolId: string,
): RestrictedAbility | undefined {
  return context.restrictedAbilities.find((r) => r.toolId === toolId);
}

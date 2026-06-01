/**
 * 触发预算管理器（P1-06）。
 *
 * M7 修复：滑动窗口替代累加计数，旧触发自然过期，预算可恢复。
 * M13 修复：宽限期内不计算预算比例，避免早期极端敏感。
 * 交互风险修复：宽限期内不向窗口写入条目，避免宽限期结束后 ratio 飙升。
 *
 * 窗口内 ratio = usedInWindow / window.length。
 * 当 ratio > EVOLUTION_MAX_TRIGGER_BUDGET_RATIO → 暂停进化。
 * 宽限期（前 TRIGGER_BUDGET_GRACE_PERIOD 次任务）内始终允许进化。
 */

import {
  EVOLUTION_MAX_TRIGGER_BUDGET_RATIO,
  EVOLUTION_TRIGGER_BUDGET_WINDOW,
  TRIGGER_BUDGET_GRACE_PERIOD,
} from "./constants";

// ─── 类型定义 ───

export interface TriggerBudgetState {
  readonly totalBudget: number;
  readonly usedBudget: number;
}

export interface TriggerBudgetCheck {
  readonly canEvolve: boolean;
  readonly ratio: number;
  readonly remaining: number;
}

// ─── 预算管理器 ───

/**
 * createTriggerBudget — 创建触发预算管理器。
 *
 * 滑动窗口 + 宽限期机制：
 * - 宽限期内只计数 totalTasksSeen，不向窗口写入任何条目
 * - 宽限期结束后才开始向窗口推入任务结果
 * - 维护最近 EVOLUTION_TRIGGER_BUDGET_WINDOW 次任务的触发记录
 * - 旧记录自然滑出窗口，ratio 可恢复
 */
export function createTriggerBudget(_initialState?: TriggerBudgetState) {
  const window: boolean[] = [];
  let usedInWindow = 0;
  let totalTasksSeen = 0;

  return {
    /** 增加总预算（每完成一个任务调用） */
    incrementTotal(): void {
      totalTasksSeen++;
      if (totalTasksSeen <= TRIGGER_BUDGET_GRACE_PERIOD) return;

      window.push(false);
      if (window.length > EVOLUTION_TRIGGER_BUDGET_WINDOW) {
        if (window.shift() === true) {
          usedInWindow--;
        }
      }
    },

    /** 增加已用预算（每次触发进化调用） */
    incrementUsed(): void {
      if (window.length > 0) {
        window[window.length - 1] = true;
        usedInWindow++;
      }
    },

    /** 检查是否可以触发进化 */
    check(): TriggerBudgetCheck {
      if (totalTasksSeen <= TRIGGER_BUDGET_GRACE_PERIOD) {
        return {
          canEvolve: true,
          ratio: 0,
          remaining: TRIGGER_BUDGET_GRACE_PERIOD - totalTasksSeen,
        };
      }

      const totalBudget = window.length;
      const ratio = totalBudget > 0 ? usedInWindow / totalBudget : 0;
      const canEvolve = ratio <= EVOLUTION_MAX_TRIGGER_BUDGET_RATIO;
      const remaining = Math.max(
        0,
        Math.floor(totalBudget * EVOLUTION_MAX_TRIGGER_BUDGET_RATIO) - usedInWindow,
      );

      return { canEvolve, ratio, remaining };
    },

    /** 获取当前状态 */
    getState(): TriggerBudgetState {
      return { totalBudget: window.length, usedBudget: usedInWindow };
    },

    /** 重置预算 */
    reset(): void {
      window.length = 0;
      usedInWindow = 0;
      totalTasksSeen = 0;
    },
  };
}

export type TriggerBudget = ReturnType<typeof createTriggerBudget>;

/**
 * EMA 趋势计算器（P1-01）。
 *
 * 使用指数移动平均（EMA）检测规则性能趋势。
 * alpha = 0.1，窗口 = 10。
 * 与整体成功率对比，差异 > 0.1 判定为 improving / declining / stable。
 *
 * D.2 修复 M-06: EMA 初始值使用 baseline 预热，避免首次观测值偏差。
 */

import {
  EVOLUTION_EMA_ALPHA,
  EVOLUTION_TREND_WINDOW,
  EVOLUTION_TREND_DIFF_THRESHOLD,
} from "./constants";

// ─── 类型定义 ───

export type TrendDirection = "improving" | "declining" | "stable";

export interface EMACalculator {
  /** 更新 EMA 值（传入新的观测值） */
  update(value: number): number;
  /** 获取当前 EMA 值 */
  getCurrent(): number;
  /** 获取趋势方向 */
  getTrend(): TrendDirection;
  /** 获取历史窗口 */
  getHistory(): readonly number[];
  /** 重置计算器 */
  reset(): void;
}

// ─── EMA 计算器 ───

/**
 * createEMACalculator — 创建 EMA 趋势计算器。
 *
 * @param baseline - 基线成功率（用于对比和 EMA 初始化）
 * @param alpha - 平滑系数（默认 0.1）
 * @param window - 趋势检测窗口（默认 10）
 *
 * M-06 修复：EMA 初始值使用 baseline 而非首次观测值，
 * 避免冷启动时 EMA 被极端值拉偏。
 */
export function createEMACalculator(
  baseline: number,
  alpha: number = EVOLUTION_EMA_ALPHA,
  window: number = EVOLUTION_TREND_WINDOW,
): EMACalculator {
  // M-06: 使用 baseline 作为 EMA 初始值
  let ema: number = baseline;
  const history: number[] = [];
  let observationCount = 0;

  function update(value: number): number {
    observationCount++;
    history.push(value);

    // 保持窗口大小
    if (history.length > window) {
      history.shift();
    }

    // EMA 更新（M-06: ema 已初始化为 baseline，不再需要 null 检查）
    ema = alpha * value + (1 - alpha) * ema;

    return ema;
  }

  function getCurrent(): number {
    return ema;
  }

  function getTrend(): TrendDirection {
    const minSamples = Math.ceil(1 / alpha) * 3;
    if (observationCount < minSamples) {
      return "stable";
    }

    const diff = ema - baseline;

    if (diff > EVOLUTION_TREND_DIFF_THRESHOLD) {
      return "improving";
    }
    if (diff < -EVOLUTION_TREND_DIFF_THRESHOLD) {
      return "declining";
    }
    return "stable";
  }

  function getHistory(): readonly number[] {
    return history;
  }

  function reset(): void {
    ema = baseline;
    history.length = 0;
    observationCount = 0;
  }

  return { update, getCurrent, getTrend, getHistory, reset };
}

// ─── 方差计算 ───

/**
 * calculateVariance — 计算成功率方差。
 *
 * 使用样本方差（Bessel 校正，除以 n-1）。
 * n < 3 时返回 0（方差无意义），n = 3 时 n-1=2，为最小有效样本。
 * M15 修复：可选窗口参数，截取最近 N 个值计算方差，与 EMA 窗口对齐。
 */
export function calculateVariance(
  values: readonly number[],
  window?: number,
): number {
  const sliced = window !== undefined && window > 0
    ? values.slice(-window)
    : values;

  if (sliced.length < 3) return 0;

  const mean = sliced.reduce((sum, v) => sum + v, 0) / sliced.length;
  const squaredDiffs = sliced.map((v) => (v - mean) ** 2);
  return squaredDiffs.reduce((sum, d) => sum + d, 0) / (sliced.length - 1);
}

// ─── 综合评分（P2-01） ───

/**
 * calculateCompositeScore — 计算规则综合评分。
 *
 * 公式：成功率 × 任务重要性 × (1 - 额外成本比)
 * M9 修复：添加 Math.max(0, ...) 下界保护，extraCostRatio>1 时得分不为负。
 */
export function calculateCompositeScore(options: {
  readonly successRate: number;
  readonly taskType: string;
  readonly extraCostRatio: number;
  readonly taskTypeImportance?: Readonly<Record<string, number>>;
}): number {
  const {
    successRate,
    taskType,
    extraCostRatio,
    taskTypeImportance,
  } = options;

  const importance =
    taskTypeImportance?.[taskType] ??
    taskTypeImportance?.["default"] ??
    0.5;

  return Math.max(0, successRate * importance * (1 - extraCostRatio));
}

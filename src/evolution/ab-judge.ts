/**
 * A/B 测试裁判（P4-07）— 双副本对比评估。
 *
 * 参考 SYSTEM_DESIGN.md 3.6.2。
 * 评估维度与权重（宪法层不可修改）：
 * - success_rate: 0.40
 * - execution_time: 0.25
 * - stability: 0.20
 * - code_complexity: 0.15
 *
 * 判决逻辑：
 * - B 胜：改善率 >= 10% 且成本增长 <= 15%
 * - A 胜：diff < -0.05
 * - 平局：其他
 *
 * 修复清单：
 * - M16: scoreA=0且scoreB>0时判定B胜（非TIE）
 * - M10: 空结果集execution_time得分为0（非1.0满分）
 * - M4: 时间标准化基线使用max(valueA, valueB, 1)替代硬编码1000ms
 * - M6: 最低样本量要求，不足时返回TIE + insufficient_samples标记
 */

import {
  AB_TEST_JUDGE_WEIGHTS,
  AB_TEST_IMPROVEMENT_THRESHOLD,
  AB_TEST_COST_TOLERANCE,
  AB_TEST_A_WIN_THRESHOLD,
  AB_TEST_MIN_SAMPLE_SIZE,
} from "./constants";

// ─── 类型定义 ───

export interface TrialResult {
  readonly success: boolean;
  readonly executionTimeMs: number;
  readonly crashed: boolean;
  readonly complexityScore?: number;
}

export interface ABTestInput {
  readonly resultA: readonly TrialResult[];
  readonly resultB: readonly TrialResult[];
}

export interface ABTestVerdict {
  readonly winner: "A" | "B" | "TIE";
  readonly scoreA: number;
  readonly scoreB: number;
  readonly diff: number;
  readonly improvementRate: number;
  readonly costIncrease: number;
  readonly details: {
    readonly successRateA: number;
    readonly successRateB: number;
    readonly avgTimeA: number;
    readonly avgTimeB: number;
    readonly stabilityA: number;
    readonly stabilityB: number;
    readonly complexityA: number;
    readonly complexityB: number;
    readonly insufficient_samples?: boolean;
  };
}

// ─── 评分计算 ───

function calculateSuccessRate(results: readonly TrialResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.success).length / results.length;
}

function calculateAvgTime(results: readonly TrialResult[]): number {
  if (results.length === 0) return 0;
  return results.reduce((sum, r) => sum + r.executionTimeMs, 0) / results.length;
}

function calculateStability(results: readonly TrialResult[]): number {
  if (results.length === 0) return 0;
  const failures = results.filter((r) => !r.success || r.crashed).length;
  return 1 - failures / results.length;
}

function calculateComplexity(results: readonly TrialResult[]): number {
  if (results.length === 0) return 0;
  const scores = results.map((r) => r.complexityScore ?? 0.5);
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

/**
 * calculateDimensionScore — 计算单个维度的得分。
 *
 * 所有维度标准化到 [0, 1]，越高越好。
 * M10 修复：空结果集返回 { scoreA: 0, scoreB: 0 }（非满分）。
 * M4 修复：execution_time 基线使用 max(valueA, valueB, 1) 替代硬编码 1000ms。
 */
function calculateDimensionScore(
  valueA: number,
  valueB: number,
  hasDataA: boolean,
  hasDataB: boolean,
  dimension: "success_rate" | "execution_time" | "stability" | "code_complexity",
): { readonly scoreA: number; readonly scoreB: number } {
  // M10: 空结果集得分为0
  if (!hasDataA && !hasDataB) return { scoreA: 0, scoreB: 0 };

  switch (dimension) {
    case "success_rate":
      return { scoreA: hasDataA ? valueA : 0, scoreB: hasDataB ? valueB : 0 };

    case "execution_time": {
      // M4: 使用 max(valueA, valueB, 1) 替代硬编码 1000ms
      const baseline = Math.max(valueA, valueB, 1);
      return {
        scoreA: hasDataA ? Math.max(0, 1 - valueA / baseline) : 0,
        scoreB: hasDataB ? Math.max(0, 1 - valueB / baseline) : 0,
      };
    }

    case "stability":
      return { scoreA: hasDataA ? valueA : 0, scoreB: hasDataB ? valueB : 0 };

    case "code_complexity": {
      return {
        scoreA: hasDataA ? 1 - valueA : 0,
        scoreB: hasDataB ? 1 - valueB : 0,
      };
    }
  }
}

// ─── A/B 测试裁判 ───

/**
 * judgeABTest — A/B 测试裁判评估。
 *
 * @param input - A/B 测试输入（两组试验结果）
 * @param customWeights - 自定义权重（默认使用宪法层权重）
 * @returns ABTestVerdict
 */
export function judgeABTest(
  input: ABTestInput,
  customWeights?: Readonly<Record<string, number>>,
): ABTestVerdict {
  const weights = customWeights ?? AB_TEST_JUDGE_WEIGHTS;

  // M6: 最低样本量检查
  const totalSamples = input.resultA.length + input.resultB.length;
  const insufficientSamples = totalSamples < AB_TEST_MIN_SAMPLE_SIZE;

  // 计算原始指标
  const successRateA = calculateSuccessRate(input.resultA);
  const successRateB = calculateSuccessRate(input.resultB);
  const avgTimeA = calculateAvgTime(input.resultA);
  const avgTimeB = calculateAvgTime(input.resultB);
  const stabilityA = calculateStability(input.resultA);
  const stabilityB = calculateStability(input.resultB);
  const complexityA = calculateComplexity(input.resultA);
  const complexityB = calculateComplexity(input.resultB);

  const hasDataA = input.resultA.length > 0;
  const hasDataB = input.resultB.length > 0;

  // 计算各维度得分
  const dimensions = [
    calculateDimensionScore(successRateA, successRateB, hasDataA, hasDataB, "success_rate"),
    calculateDimensionScore(avgTimeA, avgTimeB, hasDataA, hasDataB, "execution_time"),
    calculateDimensionScore(stabilityA, stabilityB, hasDataA, hasDataB, "stability"),
    calculateDimensionScore(complexityA, complexityB, hasDataA, hasDataB, "code_complexity"),
  ];

  const dimensionNames = ["success_rate", "execution_time", "stability", "code_complexity"];

  // 加权总分
  let scoreA = 0;
  let scoreB = 0;

  for (let i = 0; i < dimensionNames.length; i++) {
    const name = dimensionNames[i]!;
    const weight = weights[name] ?? 0;
    scoreA += dimensions[i]!.scoreA * weight;
    scoreB += dimensions[i]!.scoreB * weight;
  }

  const diff = scoreB - scoreA;

  // M16: scoreA=0且scoreB>0时直接判定B胜，improvementRate=1
  let improvementRate: number;
  let winner: "A" | "B" | "TIE";

  if (scoreA === 0 && scoreB > 0) {
    improvementRate = 1;
  } else {
    improvementRate = scoreA > 0 ? diff / scoreA : 0;
  }

  const costIncrease = avgTimeA > 0 ? (avgTimeB - avgTimeA) / avgTimeA : 0;

  // M6: 样本不足时返回TIE
  if (insufficientSamples) {
    winner = "TIE";
  } else if (
    improvementRate >= AB_TEST_IMPROVEMENT_THRESHOLD &&
    costIncrease <= AB_TEST_COST_TOLERANCE
  ) {
    winner = "B";
  } else if (diff < AB_TEST_A_WIN_THRESHOLD) {
    winner = "A";
  } else {
    winner = "TIE";
  }

  return {
    winner,
    scoreA,
    scoreB,
    diff,
    improvementRate,
    costIncrease,
    details: {
      successRateA,
      successRateB,
      avgTimeA,
      avgTimeB,
      stabilityA,
      stabilityB,
      complexityA,
      complexityB,
      ...(insufficientSamples ? { insufficient_samples: true } : {}),
    },
  };
}

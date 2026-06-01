/**
 * 评估权重适配器（P4-08）— 自适应调整 A/B 测试评估权重。
 *
 * 参考 SYSTEM_DESIGN.md 3.6.3。
 * M8 修复：选择性维度调整 — 仅对胜率偏离 50% 的维度调整权重，
 * 避免归一化抵消调整意图。
 *
 * 每 50 次尝试调整一次权重。
 * 某维度 B 胜率 > 70% → 增加该维度权重
 * 某维度 B 胜率 < 30% → 降低该维度权重
 */

import {
  EVAL_WEIGHT_ADAPT_INTERVAL,
  EVAL_WEIGHT_ADAPT_STEP,
  EVAL_WEIGHT_ADAPT_MIN,
  EVAL_WEIGHT_ADAPT_MAX,
  AB_TEST_JUDGE_WEIGHTS,
} from "./constants";

// ─── 类型定义 ───

export interface WeightAdapterState {
  readonly weights: Readonly<Record<string, number>>;
  readonly totalAttempts: number;
  readonly bWinCount: number;
  readonly aWinCount: number;
  readonly tieCount: number;
}

// ─── 权重适配器 ───

/**
 * createWeightAdapter — 创建评估权重适配器。
 */
export function createWeightAdapter(
  initialWeights?: Readonly<Record<string, number>>,
) {
  const weights: Record<string, number> = {
    ...AB_TEST_JUDGE_WEIGHTS,
    ...initialWeights,
  };

  let totalAttempts = 0;
  let bWinCount = 0;
  let aWinCount = 0;
  let tieCount = 0;

  // M8: 逐维度胜率追踪
  const dimStats: Record<string, { attempts: number; bWins: number }> = {};
  for (const dim of Object.keys(weights)) {
    dimStats[dim] = { attempts: 0, bWins: 0 };
  }

  return {
    /**
     * recordVerdict — 记录 A/B 测试判决。
     *
     * M8: 支持逐维度记录，维度级 B 胜率用于选择性权重调整。
     * @param winner - 判决结果
     * @param dimension - 可选，判决对应的评估维度
     */
    recordVerdict(winner: "A" | "B" | "TIE", dimension?: string): void {
      totalAttempts++;
      if (winner === "B") bWinCount++;
      else if (winner === "A") aWinCount++;
      else tieCount++;

      if (dimension !== undefined && dimension in dimStats) {
        dimStats[dimension]!.attempts++;
        if (winner === "B") {
          dimStats[dimension]!.bWins++;
        }
      }
    },

    /**
     * shouldAdapt — 检查是否应该调整权重。
     */
    shouldAdapt(): boolean {
      return totalAttempts > 0 && totalAttempts % EVAL_WEIGHT_ADAPT_INTERVAL === 0;
    },

    /**
     * adaptWeights — 根据历史判决调整权重。
     *
     * M8 修复：选择性维度调整。
     * - 仅对逐维度 B 胜率偏离 50% 的维度调整权重
     * - 维度 B 胜率 > 70% → 增加该维度权重（区分度好）
     * - 维度 B 胜率 < 30% → 降低该维度权重（区分度差）
     * - 其余维度不动 → 归一化后相对比例真实变化
     */
    adaptWeights(): Record<string, number> {
      if (totalAttempts < EVAL_WEIGHT_ADAPT_INTERVAL) return { ...weights };

      let changed = false;

      for (const [dim, weight] of Object.entries(weights)) {
        const stats = dimStats[dim];
        if (stats === undefined || stats.attempts < 5) continue;

        const dimBWinRate = stats.bWins / stats.attempts;
        let newWeight = weight;

        if (dimBWinRate > 0.7) {
          newWeight = Math.min(
            EVAL_WEIGHT_ADAPT_MAX,
            weight + EVAL_WEIGHT_ADAPT_STEP,
          );
        } else if (dimBWinRate < 0.3) {
          newWeight = Math.max(
            EVAL_WEIGHT_ADAPT_MIN,
            weight - EVAL_WEIGHT_ADAPT_STEP,
          );
        }

        if (newWeight !== weight) {
          weights[dim] = newWeight;
          changed = true;
        }
      }

      // 归一化权重（总和 = 1）— 仅在有变化时执行
      if (changed) {
        const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
        if (total > 0) {
          for (const dim of Object.keys(weights)) {
            weights[dim] = weights[dim]! / total;
          }
        }
      }

      return { ...weights };
    },

    /**
     * getWeights — 获取当前权重。
     */
    getWeights(): Readonly<Record<string, number>> {
      return { ...weights };
    },

    /**
     * getState — 获取适配器状态。
     */
    getState(): WeightAdapterState {
      return {
        weights: { ...weights },
        totalAttempts,
        bWinCount,
        aWinCount,
        tieCount,
      };
    },

    /**
     * reset — 重置适配器。
     */
    reset(): void {
      Object.assign(weights, AB_TEST_JUDGE_WEIGHTS);
      totalAttempts = 0;
      bWinCount = 0;
      aWinCount = 0;
      tieCount = 0;
      for (const dim of Object.keys(dimStats)) {
        dimStats[dim] = { attempts: 0, bWins: 0 };
      }
    },
  };
}

export type WeightAdapter = ReturnType<typeof createWeightAdapter>;

/**
 * 策略探索器（P4-09）— 随机扰动二阶参数进行探索。
 *
 * 参考 SYSTEM_DESIGN.md 3.5.2。
 * 触发条件：启用 + 最小任务数(30) + 间隔(100) + 并发限制(1)。
 * 探索预算分配：85% 利用 / 10% 知识探索 / 5% 代码策略探索。
 */

import {
  STRATEGY_EXPLORE_MIN_TASKS,
  STRATEGY_EXPLORE_INTERVAL,
  STRATEGY_EXPLORATION_PERTURBATION,
} from "./constants";
import {
  isEvolvable,
  getEvolvableParamDef,
  validateProposal,
} from "./constitutional-guard";
import type { SimpleLLMProvider } from "../llm/adapter";
import { extractJSONObject, safeJSONParse } from "../utils/llm-parse";
import { filterArchitectureKeywords } from "../security/llm-sanitize";
import { z } from "zod";

// ─── 类型定义 ───

export interface ExplorationResult {
  readonly experimentId: string;
  readonly paramName: string;
  readonly originalValue: unknown;
  readonly perturbedValue: unknown;
  readonly perturbation: number;
}

/** 策略探索历史记录条目 */
export interface ExplorationHistoryEntry {
  readonly experimentId: string;
  readonly paramName: string;
  readonly originalValue: unknown;
  readonly perturbedValue: unknown;
  readonly perturbation: number;
  readonly improved: boolean;
  readonly metric: number;
  readonly statisticallySignificant: boolean;
  readonly timestamp: number;
}

export interface StrategyExplorerConfig {
  readonly enabled?: boolean;
  readonly minTasks?: number;
  readonly interval?: number;
  readonly perturbation?: number;
  readonly llmProvider?: SimpleLLMProvider;
}

// ─── 统计显著性检验 ───

export function isStatisticallySignificant(
  preRate: number,
  postRate: number,
  sampleSize: number,
  alpha: number = 0.05,
): boolean {
  if (sampleSize < 10) return false;
  if (preRate < 0 || preRate > 1 || postRate < 0 || postRate > 1) return false;
  const pooledRate = (preRate + postRate) / 2;
  const se = Math.sqrt(2 * pooledRate * (1 - pooledRate) / sampleSize);
  if (se === 0) return false;
  const z = Math.abs(postRate - preRate) / se;
  const zCritical = alpha <= 0.01 ? 2.576 : alpha <= 0.05 ? 1.96 : 1.645;
  return z > zCritical;
}

// ─── 策略探索器 ───

/**
 * createStrategyExplorer — 创建策略探索器。
 */
export function createStrategyExplorer(config?: StrategyExplorerConfig) {
  const enabled = config?.enabled ?? true;
  const minTasks = config?.minTasks ?? STRATEGY_EXPLORE_MIN_TASKS;
  const interval = config?.interval ?? STRATEGY_EXPLORE_INTERVAL;
  const perturbation = config?.perturbation ?? STRATEGY_EXPLORATION_PERTURBATION;
  const llmProvider = config?.llmProvider;

  // D.1: LLM 参数选择缓存
  const llmParamCache = new Map<string, { paramName: string; direction: number }>();

  function currentConfigKey(config: Readonly<Record<string, unknown>>): string {
    const entries = Object.entries(config)
      .filter(([k]) => isEvolvable(k))
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("|");
    return entries;
  }

  async function llmSelectParam(
    provider: SimpleLLMProvider,
    evolvableParams: readonly string[],
    currentConfig: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      const configSummary = evolvableParams
        .map((p) => `${filterArchitectureKeywords(p)}=${currentConfig[p]}`)
        .join(", ");

      const response = await provider.invoke([
        {
          role: "system",
          content: `You are an evolution strategy advisor. Given these evolvable parameters and their current values, suggest which ONE parameter to perturb and in which direction (-1 or +1). Respond with ONLY a JSON object: {"param": "PARAM_NAME", "direction": -1 or 1}. Choose the parameter most likely to improve system performance. Use English field names in JSON output.`,
        },
        {
          role: "user",
          content: configSummary,
        },
      ], { temperature: 0 });

      const jsonStr = extractJSONObject(response);
      if (jsonStr) {
        const rawParsed = safeJSONParse(jsonStr);

        const LLMParamSelectionSchema = z.object({
          param: z.string(),
          direction: z.union([z.literal(-1), z.literal(1)]),
        });

        const validated = LLMParamSelectionSchema.safeParse(rawParsed);
        if (validated.success && evolvableParams.includes(validated.data.param)) {
          llmParamCache.set(currentConfigKey(currentConfig), {
            paramName: validated.data.param,
            direction: validated.data.direction,
          });
        }
      }
    } catch {
      // LLM 选择失败，保持随机模式
    }
  }

  let lastExploreTask = 0;
  let isExploring = false;

  // 历史记录（固定容量，RULES_2-14 水库采样思路）
  const MAX_HISTORY_SIZE = 100;
  const history: ExplorationHistoryEntry[] = [];

  return {
    /**
     * shouldExplore — 检查是否应该触发探索。
     */
    shouldExplore(totalTasks: number): boolean {
      if (!enabled) return false;
      if (isExploring) return false;
      if (totalTasks < minTasks) return false;
      if (lastExploreTask === 0) {
        return totalTasks >= minTasks;
      }
      if (totalTasks - lastExploreTask < interval) return false;
      return true;
    },

    /**
     * generatePerturbation — 生成参数扰动。
     *
     * @param currentConfig - 当前配置
     * @param totalTasks - 当前任务总数（用于记录探索起始位置，修复 C8）
     * @returns 扰动结果（null 表示无法生成）
     */
    generatePerturbation(
      currentConfig: Readonly<Record<string, unknown>>,
      totalTasks?: number,
    ): ExplorationResult | null {
      if (isExploring) return null;

      // 选择一个可进化参数
      const evolvableParams = Object.keys(currentConfig).filter(
        (k) => isEvolvable(k) && typeof currentConfig[k] === "number",
      );

      if (evolvableParams.length === 0) return null;

      // D.1: 有 LLM Provider 时使用 LLM 选择参数和方向
      // 注意：LLM 选择是异步的，首次调用走随机路径，LLM 结果缓存后供后续使用
      let paramName: string;
      let directionHint: number | undefined;

      const cachedSelection = llmParamCache.get(currentConfigKey(currentConfig));
      if (cachedSelection) {
        paramName = cachedSelection.paramName;
        directionHint = cachedSelection.direction;
      } else {
        // 随机选择（降级模式 / 首次调用）
        paramName = evolvableParams[Math.floor(Math.random() * evolvableParams.length)]!;

        // 异步预填充 LLM 缓存
        if (llmProvider) {
          void llmSelectParam(llmProvider, evolvableParams, currentConfig);
        }
      }

      const originalValue = currentConfig[paramName] as number;
      const def = getEvolvableParamDef(paramName);

      if (def === undefined || def.type === "dict") return null;

      // 生成扰动
      let perturbedValue: number;
      if (def.type === "int") {
        const delta = Math.max(1, Math.round(originalValue * perturbation));
        const direction = directionHint !== undefined ? directionHint : (Math.random() < 0.5 ? -1 : 1);
        perturbedValue = originalValue + direction * delta;
        perturbedValue = Math.round(perturbedValue);
      } else {
        const randomFactor = directionHint !== undefined
          ? directionHint * Math.random()
          : (Math.random() * 2 - 1); // [-1, 1]
        perturbedValue = originalValue * (1 + perturbation * randomFactor);
      }

      // 验证提案
      const validation = validateProposal(paramName, perturbedValue);
      if (!validation.valid) return null;

      const finalValue = (validation.clampedValue ?? perturbedValue) as number;
      isExploring = true;
      lastExploreTask = totalTasks ?? 0;

      // 记录到历史中（占位，等 recordExperimentResult 补充结果）
      if (history.length >= MAX_HISTORY_SIZE) {
        history.shift();
      }
      history.push({
        experimentId: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        paramName,
        originalValue,
        perturbedValue: finalValue,
        perturbation: Math.abs(finalValue - originalValue) / Math.max(Math.abs(originalValue), 0.001),
        improved: false,
        metric: 0,
        statisticallySignificant: false,
        timestamp: Date.now(),
      });

      return {
        experimentId: history[history.length - 1]!.experimentId,
        paramName,
        originalValue,
        perturbedValue: finalValue,
        perturbation: Math.abs(finalValue - originalValue) / Math.max(Math.abs(originalValue), 0.001),
      };
    },

    /**
     * recordExperimentResult — 记录实验结果到历史中。
     */
    recordExperimentResult(
      experimentId: string,
      result: {
        improved: boolean;
        metric: number;
        preRate?: number;
        postRate?: number;
        sampleSize?: number;
      },
    ): { improved: boolean; statisticallySignificant: boolean } {
      isExploring = false;

      let statisticallySignificant = true;
      let effectiveImproved = result.improved;

      if (result.preRate !== undefined && result.postRate !== undefined && result.sampleSize !== undefined) {
        statisticallySignificant = isStatisticallySignificant(
          result.preRate,
          result.postRate,
          result.sampleSize,
        );
        if (!statisticallySignificant) {
          effectiveImproved = false;
        }
      }

      const entry = history.find((h) => h.experimentId === experimentId);
      if (entry !== undefined) {
        const idx = history.indexOf(entry);
        history[idx] = {
          ...entry,
          improved: effectiveImproved,
          metric: result.metric,
          statisticallySignificant,
        };
      }

      return { improved: effectiveImproved, statisticallySignificant };
    },

    /** 获取当前状态 */
    isCurrentlyExploring(): boolean {
      return isExploring;
    },

    /** 获取探索历史记录 */
    getHistory(): readonly ExplorationHistoryEntry[] {
      return history;
    },

    /** 获取历史统计 */
    getHistoryStats(): { total: number; improved: number; improvementRate: number } {
      const total = history.length;
      const improved = history.filter((h) => h.improved).length;
      return {
        total,
        improved,
        improvementRate: total > 0 ? improved / total : 0,
      };
    },
  };
}

export type StrategyExplorer = ReturnType<typeof createStrategyExplorer>;

/**
 * 梦境整理 — 三阶段记忆整理系统。
 *
 * 参考 `代码片段_记忆系统与知识管理补充.md` 片段 #3。
 * 三阶段：Light（轻度去重）→ Deep（深度整理）→ REM（模式提取）。
 */

import type { MemoryEntry, MemoryType } from "./memory-types";
import { computeStalenessScore } from "./memory-age";
import type { SimpleLLMProvider } from "../llm/adapter";
import { extractJSONArray, safeJSONParse } from "../utils/llm-parse";
import { z } from "zod";

// ─── 梦境整理配置 ───

export interface DreamingConfig {
  readonly light?: LightDreamingConfig;
  readonly deep?: DeepDreamingConfig;
  readonly rem?: REMDreamingConfig;
  readonly llmProvider?: SimpleLLMProvider;
}

export interface LightDreamingConfig {
  readonly enabled?: boolean;
  readonly dedupeSimilarity?: number;
  readonly maxAgeDays?: number;
}

export interface DeepDreamingConfig {
  readonly enabled?: boolean;
  readonly minRecallCount?: number;
  readonly minScore?: number;
  readonly maxAgeDays?: number;
  readonly recencyHalfLifeDays?: number;
}

export interface REMDreamingConfig {
  readonly enabled?: boolean;
  readonly minPatternStrength?: number;
  readonly lookbackDays?: number;
}

// ─── 整理结果 ───

export interface DreamingResult {
  readonly phase: "light" | "deep" | "rem";
  readonly processed: number;
  readonly merged: number;
  readonly deprecated: number;
  readonly promoted: number;
  readonly patterns: readonly string[];
  readonly llm_insights?: readonly string[];
  readonly llmReady?: Promise<DreamingResult> | undefined;
}

// ─── 创建梦境整理器 ───

export function createDreamingManager(config?: DreamingConfig) {
  const llmProvider = config?.llmProvider;

  const lightConfig = {
    enabled: config?.light?.enabled ?? true,
    dedupeSimilarity: config?.light?.dedupeSimilarity ?? 0.9,
    maxAgeDays: config?.light?.maxAgeDays ?? 60,
  };

  const deepConfig = {
    enabled: config?.deep?.enabled ?? false,
    minRecallCount: config?.deep?.minRecallCount ?? 3,
    minScore: config?.deep?.minScore ?? 0.8,
    maxAgeDays: config?.deep?.maxAgeDays ?? 30,
    recencyHalfLifeDays: config?.deep?.recencyHalfLifeDays ?? 14,
  };

  const remConfig = {
    enabled: config?.rem?.enabled ?? false,
    minPatternStrength: config?.rem?.minPatternStrength ?? 0.75,
    lookbackDays: config?.rem?.lookbackDays ?? 7,
  };

  // 访问计数（模拟 recall count）
  const recallCounts = new Map<string, number>();

  function recordRecall(memoryId: string): void {
    recallCounts.set(memoryId, (recallCounts.get(memoryId) ?? 0) + 1);
  }

  /**
   * runLightDreaming — 轻度整理：去重 + 清理过期记忆。
   */
  function runLightDreaming(memories: readonly MemoryEntry[]): DreamingResult {
    if (!lightConfig.enabled) {
      return { phase: "light", processed: 0, merged: 0, deprecated: 0, promoted: 0, patterns: [] };
    }

    let merged = 0;
    let deprecated = 0;
    const seen = new Map<string, MemoryEntry>();

    for (const memory of memories) {
      // 检查过期
      const staleness = computeStalenessScore(memory.mtimeMs, lightConfig.maxAgeDays);
      if (staleness >= 1.0) {
        deprecated++;
        continue;
      }

      // 简单去重（基于标题相似度）
      const key = memory.title.toLowerCase().trim();
      const existing = seen.get(key);
      if (existing) {
        // 保留更新的版本
        if (memory.updatedAt > existing.updatedAt) {
          seen.set(key, memory);
        }
        merged++;
      } else {
        seen.set(key, memory);
      }
    }

    const result: DreamingResult = {
      phase: "light",
      processed: memories.length,
      merged,
      deprecated,
      promoted: 0,
      patterns: [],
    };

    // C12/C15: LLM 语义去重 — 返回新对象而非修改原对象
    if (llmProvider && seen.size > 1) {
      const memorySummaries = Array.from(seen.values()).map(
        (m) => `[${m.type}] ${m.title}: ${m.content.slice(0, 100)}`,
      );
      const llmReady = (async (): Promise<DreamingResult> => {
        try {
          const response = await llmProvider.invoke([
            {
              role: "system",
              content: "Identify memories that are semantically identical but expressed differently. Return a JSON array of objects with 'duplicate' and 'canonical' fields containing memory titles. Use English field names in JSON output.",
            },
            { role: "user", content: memorySummaries.join("\n") },
          ], { temperature: 0 });

          const jsonStr = extractJSONArray(response);
          if (jsonStr === null) return result;

          const rawParsed = safeJSONParse(jsonStr);

          const LLMDuplicateSchema = z.object({
            duplicate: z.string(),
            canonical: z.string(),
          });

          if (Array.isArray(rawParsed)) {
            const insights = rawParsed
              .filter((item): item is Record<string, unknown> =>
                typeof item === "object" && item !== null,
              )
              .map((item) => LLMDuplicateSchema.safeParse(item))
              .filter((r) => r.success)
              .map((r) => `"${r.data.duplicate}" is semantically equivalent to "${r.data.canonical}"`);
            if (insights.length > 0) {
              return { ...result, llm_insights: insights };
            }
          }
        } catch (err) {
          console.warn(`[DREAMING] LLM semantic dedup failed in light dreaming: ${err instanceof Error ? err.message : String(err)}`);
        }
        return result;
      })();
      return { ...result, llmReady };
    }

    return result;
  }

  /**
   * runDeepDreaming — 深度整理：识别高价值记忆 + 降级低价值记忆。
   */
  function runDeepDreaming(memories: readonly MemoryEntry[]): DreamingResult {
    if (!deepConfig.enabled) {
      return { phase: "deep", processed: 0, merged: 0, deprecated: 0, promoted: 0, patterns: [] };
    }

    let promoted = 0;
    let deprecated = 0;

    for (const memory of memories) {
      const recallCount = recallCounts.get(memory.id) ?? 0;
      const staleness = computeStalenessScore(memory.mtimeMs, deepConfig.maxAgeDays);

      // 高价值：频繁召回 + 高置信度 + 新鲜
      if (recallCount >= deepConfig.minRecallCount &&
          memory.confidence >= deepConfig.minScore &&
          staleness < 0.5) {
        promoted++;
      }

      // 低价值：从未召回 + 低置信度 + 陈旧
      if (recallCount === 0 &&
          memory.confidence < 0.3 &&
          staleness > 0.7) {
        deprecated++;
      }
    }

    return {
      phase: "deep",
      processed: memories.length,
      merged: 0,
      deprecated,
      promoted,
      patterns: [],
    };
  }

  /**
   * runREMDreaming — REM 整理：跨记忆模式识别。
   */
  function runREMDreaming(memories: readonly MemoryEntry[]): DreamingResult {
    if (!remConfig.enabled) {
      return { phase: "rem", processed: 0, merged: 0, deprecated: 0, promoted: 0, patterns: [] };
    }

    const patterns: string[] = [];

    // 按类型分组统计
    const typeCounts = new Map<MemoryType, number>();
    for (const memory of memories) {
      typeCounts.set(memory.type, (typeCounts.get(memory.type) ?? 0) + 1);
    }

    // 识别模式：某类型记忆过多可能表示需要整理
    for (const [type, count] of typeCounts) {
      const ratio = count / memories.length;
      if (ratio > 0.5) {
        patterns.push(`High concentration of '${type}' memories: ${count}/${memories.length} (${(ratio * 100).toFixed(1)}%)`);
      }
    }

    // 识别标签模式
    const tagCounts = new Map<string, number>();
    for (const memory of memories) {
      for (const tag of memory.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    for (const [tag, count] of tagCounts) {
      if (count >= 3) {
        patterns.push(`Recurring tag '${tag}': ${count} memories`);
      }
    }

    const result: DreamingResult = {
      phase: "rem",
      processed: memories.length,
      merged: 0,
      deprecated: 0,
      promoted: 0,
      patterns,
    };

    // C12/C15: LLM 跨记忆模式识别 — 返回新对象而非修改原对象
    if (llmProvider && memories.length > 1) {
      const memorySummaries = memories.map(
        (m) => `[${m.type}] ${m.title}: ${m.content.slice(0, 120)}`,
      );
      const llmReady = (async (): Promise<DreamingResult> => {
        try {
          const response = await llmProvider.invoke([
            {
              role: "system",
              content: "Identify cross-memory patterns, themes, and relationships. Return a JSON array of pattern descriptions as strings. Use English field names in JSON output.",
            },
            { role: "user", content: memorySummaries.join("\n") },
          ], { temperature: 0 });

          const jsonStr = extractJSONArray(response);
          if (jsonStr === null) return result;

          const rawParsed = safeJSONParse(jsonStr);
          if (Array.isArray(rawParsed)) {
            const insights = rawParsed
              .filter((item): item is string => typeof item === "string")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            if (insights.length > 0) {
              return { ...result, llm_insights: insights };
            }
          }
        } catch (err) {
          console.warn(`[DREAMING] LLM pattern recognition failed in REM dreaming: ${err instanceof Error ? err.message : String(err)}`);
        }
        return result;
      })();
      return { ...result, llmReady };
    }

    return result;
  }

  /**
   * runAllPhases — 执行完整的三阶段整理。
   */
  function runAllPhases(memories: MemoryEntry[]): DreamingResult[] {
    const results: DreamingResult[] = [];

    const lightResult = runLightDreaming(memories);
    results.push(lightResult);

    const deepResult = runDeepDreaming(memories);
    results.push(deepResult);

    const remResult = runREMDreaming(memories);
    results.push(remResult);

    return results;
  }

  return {
    recordRecall,
    runLightDreaming,
    runDeepDreaming,
    runREMDreaming,
    runAllPhases,
  };
}

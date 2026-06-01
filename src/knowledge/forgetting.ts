/**
 * 主动遗忘 — 基于访问频率和时间衰减的记忆淘汰策略。
 *
 * 三种遗忘策略：
 * 1. LRU（最近最少使用）— 最久未被检索的记忆优先淘汰
 * 2. 时间衰减 — 超过最大年龄的记忆自动淘汰
 * 3. 低置信度 — 置信度低于阈值的记忆淘汰
 */

import type { MemoryEntry } from "./memory-types";
import { computeStalenessScore } from "./memory-age";
import type { SimpleLLMProvider } from "../llm/adapter";
import { parseLLMScore } from "../utils/llm-parse";

// ─── 遗忘策略配置 ───

export interface ForgettingConfig {
  /** 最大记忆数量（LRU 上限） */
  readonly maxMemories?: number;
  /** 最大记忆年龄（天） */
  readonly maxAgeDays?: number;
  /** 最低置信度阈值 */
  readonly minConfidence?: number;
  /** 是否启用 LRU 淘汰 */
  readonly enableLRU?: boolean;
  /** 是否启用时间衰减淘汰 */
  readonly enableTimeDecay?: boolean;
  /** 是否启用低置信度淘汰 */
  readonly enableLowConfidence?: boolean;
  /** LLM Provider，用于长期价值评估 */
  readonly llmProvider?: SimpleLLMProvider;
}

// ─── 遗忘结果 ───

export interface ForgettingResult {
  readonly forgotten: readonly MemoryEntry[];
  readonly retained: readonly MemoryEntry[];
  readonly reasons: ReadonlyMap<string, string>;
  readonly llmValueHints: ReadonlyMap<string, number>;
  readonly llmReady?: Promise<void> | undefined;
}

// ─── 记忆访问记录 ───

export interface MemoryAccessRecord {
  readonly memoryId: string;
  readonly lastAccessedAt: number;
  readonly accessCount: number;
}

// ─── 创建主动遗忘管理器 ───

export function createForgettingManager(config?: ForgettingConfig) {
  const maxMemories = config?.maxMemories ?? 1000;
  const maxAgeDays = config?.maxAgeDays ?? 90;
  const minConfidence = config?.minConfidence ?? 0.2;
  const enableLRU = config?.enableLRU ?? true;
  const enableTimeDecay = config?.enableTimeDecay ?? true;
  const enableLowConfidence = config?.enableLowConfidence ?? true;
  const llmProvider = config?.llmProvider;

  const accessRecords = new Map<string, MemoryAccessRecord>();

  function recordAccess(memoryId: string): void {
    const existing = accessRecords.get(memoryId);
    if (existing) {
      accessRecords.set(memoryId, {
        memoryId,
        lastAccessedAt: Date.now(),
        accessCount: existing.accessCount + 1,
      });
    } else {
      accessRecords.set(memoryId, {
        memoryId,
        lastAccessedAt: Date.now(),
        accessCount: 1,
      });
    }
  }

  function getAccessRecord(memoryId: string): MemoryAccessRecord | undefined {
    return accessRecords.get(memoryId);
  }

  function forget(memories: readonly MemoryEntry[]): ForgettingResult {
    const forgotten: MemoryEntry[] = [];
    const retained: MemoryEntry[] = [];
    const reasons = new Map<string, string>();

    for (const memory of memories) {
      let shouldForget = false;
      let reason = "";

      // 1. 时间衰减淘汰
      if (enableTimeDecay) {
        const staleness = computeStalenessScore(memory.mtimeMs, maxAgeDays);
        if (staleness >= 1.0) {
          shouldForget = true;
          reason = `age_exceeded:${maxAgeDays}d`;
        }
      }

      // 2. 低置信度淘汰
      if (!shouldForget && enableLowConfidence) {
        if (memory.confidence < minConfidence) {
          shouldForget = true;
          reason = `low_confidence:${memory.confidence.toFixed(2)}<${minConfidence}`;
        }
      }

      if (shouldForget) {
        forgotten.push(memory);
        reasons.set(memory.id, reason);
        accessRecords.delete(memory.id);
      } else {
        retained.push(memory);
      }
    }

    // 3. LLM 长期价值评估：对即将被淘汰的记忆进行二次评估
    // E4: LLM 只做标注（llm_value_hint），不直接修改 forgotten/retained 数组
    // C13: 不再 splice 修改 forgotten 数组
    // C11: 限制最大并发为 5
    const llmValueHints = new Map<string, number>();
    let llmReady: Promise<void> | undefined;
    if (llmProvider && forgotten.length > 0) {
      const candidatesToEvaluate = [...forgotten];
      llmReady = (async () => {
        try {
          const MAX_CONCURRENT = 5;
          const results: Array<{ memory: MemoryEntry; score: number }> = [];

          for (let i = 0; i < candidatesToEvaluate.length; i += MAX_CONCURRENT) {
            const batch = candidatesToEvaluate.slice(i, i + MAX_CONCURRENT);
            const batchResults = await Promise.all(
              batch.map(async (memory) => {
                const recallCount = accessRecords.get(memory.id)?.accessCount ?? 0;
                const response = await llmProvider.invoke([
                  {
                    role: "system",
                    content: "Evaluate the long-term value of this memory on a scale of 0.0 to 1.0. Consider: uniqueness, potential future relevance, cross-domain applicability. Respond with a JSON object: {\"score\": <number>}. Use English field names in JSON output.",
                  },
                  {
                    role: "user",
                    content: `Title: ${memory.title}, Content: ${memory.content.slice(0, 200)}, Type: ${memory.type}, Recall count: ${recallCount}`,
                  },
                ], { temperature: 0 });
                const score = parseLLMScore(response.trim());
                return { memory, score: Number.isNaN(score) ? 0 : score };
              }),
            );
            results.push(...batchResults);
          }

          for (const { memory, score } of results) {
            llmValueHints.set(memory.id, score);
          }
        } catch (err) {
          console.warn(`[FORGETTING] LLM long-term value assessment failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }

    // 4. LRU 淘汰（在时间/置信度淘汰之后）
    if (enableLRU && retained.length > maxMemories) {
      const sorted = [...retained].sort((a, b) => {
        const accessA = accessRecords.get(a.id);
        const accessB = accessRecords.get(b.id);
        const lastA = accessA?.lastAccessedAt ?? a.mtimeMs;
        const lastB = accessB?.lastAccessedAt ?? b.mtimeMs;
        return lastA - lastB; // 最旧优先淘汰
      });

      const excessCount = retained.length - maxMemories;
      for (let i = 0; i < excessCount; i++) {
        const entry = sorted[i]!;
        forgotten.push(entry);
        reasons.set(entry.id, `lru_evicted`);
        accessRecords.delete(entry.id);
      }

      const evictedIds = new Set(sorted.slice(0, excessCount).map((e) => e.id));
      const newRetained = retained.filter((m) => !evictedIds.has(m.id));
      const result: ForgettingResult = { forgotten, retained: newRetained, reasons, llmValueHints };
      (result as { llmReady?: Promise<void> | undefined }).llmReady = llmReady;
      return result;
    }

    const result: ForgettingResult = { forgotten, retained, reasons, llmValueHints };
    (result as { llmReady?: Promise<void> | undefined }).llmReady = llmReady;
    return result;
  }

  function clear(): void {
    accessRecords.clear();
  }

  return { recordAccess, getAccessRecord, forget, clear };
}

/**
 * SessionMemory — 会话级记忆管理。
 *
 * 基于通用 Agent 设计模式的记忆提取系统。
 * 四种记忆类型：fact/preference/instruction/pattern。
 * RULES_2-12: 半衰期衰减（记忆权重随时间降低）。
 */

import type { Message } from "../types/message";
import { estimateTokens } from "../types/common";

// ─── 记忆类型 ───

export const MemoryType = {
  FACT: "fact",
  PREFERENCE: "preference",
  INSTRUCTION: "instruction",
  PATTERN: "pattern",
} as const;

export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

// ─── 记忆条目 ───

export interface MemoryEntry {
  readonly id: string;
  readonly type: MemoryType;
  readonly content: string;
  readonly source: "auto" | "user" | "system";
  readonly createdAt: number;
  readonly lastAccessedAt: number;
  readonly accessCount: number;
  readonly tags: readonly string[];
  readonly confidence: number; // 0-1
}

// ─── 记忆提取结果 ───

export interface MemoryExtractionResult {
  readonly entries: readonly MemoryEntry[];
  readonly tokensUsed: number;
}

// ─── SessionMemory ───

export class SessionMemory {
  private readonly memories = new Map<string, MemoryEntry>();
  private readonly maxMemories: number;
  private readonly halfLifeMs: number;

  constructor(options?: {
    readonly maxMemories?: number;
    readonly halfLifeDays?: number;
  }) {
    this.maxMemories = options?.maxMemories ?? 200;
    this.halfLifeMs = (options?.halfLifeDays ?? 30) * 24 * 60 * 60 * 1000;
  }

  /**
   * 添加记忆。
   */
  add(entry: MemoryEntry): void {
    // 如果已存在相同 ID，更新
    if (this.memories.has(entry.id)) {
      const existing = this.memories.get(entry.id)!;
      this.memories.set(entry.id, {
        ...existing,
        ...entry,
        lastAccessedAt: Date.now(),
        accessCount: existing.accessCount + 1,
      });
      return;
    }

    // 容量检查
    if (this.memories.size >= this.maxMemories) {
      this.evictWeakest();
    }

    this.memories.set(entry.id, entry);
  }

  /**
   * 获取记忆。
   */
  get(id: string): MemoryEntry | undefined {
    const entry = this.memories.get(id);
    if (entry) {
      // 更新访问时间
      this.memories.set(id, {
        ...entry,
        lastAccessedAt: Date.now(),
        accessCount: entry.accessCount + 1,
      });
    }
    return entry;
  }

  /**
   * 按类型查询记忆。
   */
  getByType(type: MemoryType): readonly MemoryEntry[] {
    return this.getWeightedMemories()
      .filter((m) => m.type === type);
  }

  /**
   * 按标签查询记忆。
   */
  getByTag(tag: string): readonly MemoryEntry[] {
    return this.getWeightedMemories()
      .filter((m) => m.tags.includes(tag));
  }

  /**
   * 搜索记忆（关键词匹配）。
   */
  search(query: string, limit?: number): readonly MemoryEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.getWeightedMemories()
      .filter((m) =>
        m.content.toLowerCase().includes(lowerQuery) ||
        m.tags.some((t) => t.toLowerCase().includes(lowerQuery)),
      )
      .slice(0, limit ?? 20);
  }

  /**
   * 获取所有记忆（按权重排序）。
   */
  getAll(): readonly MemoryEntry[] {
    return this.getWeightedMemories();
  }

  /**
   * 删除记忆。
   */
  remove(id: string): boolean {
    return this.memories.delete(id);
  }

  /**
   * 获取记忆数量。
   */
  get size(): number {
    return this.memories.size;
  }

  /**
   * 生成记忆摘要（用于注入 system prompt）。
   */
  generateMemorySummary(): string {
    const memories = this.getWeightedMemories().slice(0, 50);
    if (memories.length === 0) return "";

    const sections: string[] = ["## Session Memories", ""];

    const byType = new Map<MemoryType, MemoryEntry[]>();
    for (const m of memories) {
      const list = byType.get(m.type) ?? [];
      list.push(m);
      byType.set(m.type, list);
    }

    for (const [type, entries] of byType) {
      if (entries.length === 0) continue;
      sections.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
      for (const entry of entries.slice(0, 10)) {
        const preview = entry.content.length > 100
          ? `${entry.content.slice(0, 100)}...`
          : entry.content;
        sections.push(`- ${preview}`);
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  /**
   * 估算记忆的 token 数。
   */
  estimateMemoryTokens(): number {
    const summary = this.generateMemorySummary();
    return estimateTokens(summary);
  }

  // ─── 半衰期衰减权重 ───

  /**
   * RULES_2-12: 半衰期衰减。
   * 权重 = confidence × (0.5 ^ (age / halfLife)) × log(accessCount + 1)
   */
  private computeWeight(entry: MemoryEntry): number {
    const age = Date.now() - entry.createdAt;
    const decayFactor = Math.pow(0.5, age / this.halfLifeMs);
    const accessFactor = Math.log2(entry.accessCount + 1);
    return entry.confidence * decayFactor * accessFactor;
  }

  /**
   * 获取按权重排序的记忆列表。
   */
  private getWeightedMemories(): MemoryEntry[] {
    return Array.from(this.memories.values())
      .map((entry) => ({ entry, weight: this.computeWeight(entry) }))
      .sort((a, b) => b.weight - a.weight)
      .map(({ entry }) => entry);
  }

  /**
   * 淘汰权重最低的记忆。
   */
  private evictWeakest(): void {
    if (this.memories.size === 0) return;

    let weakestId: string | undefined;
    let weakestWeight = Infinity;

    for (const [id, entry] of this.memories) {
      const weight = this.computeWeight(entry);
      if (weight < weakestWeight) {
        weakestWeight = weight;
        weakestId = id;
      }
    }

    if (weakestId) {
      this.memories.delete(weakestId);
    }
  }
}

/**
 * 创建 SessionMemory 实例。
 */
export function createSessionMemory(options?: {
  readonly maxMemories?: number;
  readonly halfLifeDays?: number;
}): SessionMemory {
  return new SessionMemory(options);
}

/**
 * 创建记忆条目。
 */
export function createMemoryEntry(
  type: MemoryType,
  content: string,
  options?: {
    readonly source?: MemoryEntry["source"];
    readonly tags?: readonly string[];
    readonly confidence?: number;
    readonly id?: string;
  },
): MemoryEntry {
  return {
    id: options?.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    content,
    source: options?.source ?? "auto",
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    tags: options?.tags ?? [],
    confidence: options?.confidence ?? 0.8,
  };
}

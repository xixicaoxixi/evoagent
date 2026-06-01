/**
 * 进化规则存储 — RuleStore。
 *
 * 基于 JSONL 持久化的规则存储，支持 CRUD、状态过滤、快照。
 *
 * D.2 修复：
 * - M-02: 引用计数更新导致高频 I/O → debounce 机制
 * - M-05: 规则全量加载性能问题 → 懒加载 + 索引
 * - DM-02: 读-改-写无原子性保护 → Promise 链式锁
 */

import { z } from "zod";
import {
  EvolutionRuleSchema,
  type EvolutionRule,
  type EvolutionRuleInput,
} from "../schemas/evolution";
import { RuleStatus } from "../types/evolution";
import { EVOLUTION_RULE_MAX_COUNT } from "./constants";
import { appendJSONL, readJSONL } from "../persistence/jsonl";
import { atomicWriteText } from "../persistence/atomic-write";
import { brand, type RuleId } from "../types/ids";
import { createAsyncLock, createDebouncedWrite } from "../utils/async-lock";

// ─── 存储路径 ───

let rulesFilePath = "./data/evolution/rules.jsonl";

export function setRulesFilePath(path: string): void {
  rulesFilePath = path;
}

// ─── RuleStore 接口 ───

export interface RuleStore {
  readonly getAll: () => Promise<readonly EvolutionRule[]>;
  readonly getById: (ruleId: string) => Promise<EvolutionRule | undefined>;
  readonly getByStatus: (status: RuleStatus) => Promise<readonly EvolutionRule[]>;
  readonly getActive: () => Promise<readonly EvolutionRule[]>;
  readonly add: (rule: EvolutionRuleInput) => Promise<EvolutionRule>;
  readonly update: (ruleId: string, updates: Partial<EvolutionRule>) => Promise<EvolutionRule | undefined>;
  readonly delete: (ruleId: string) => Promise<boolean>;
  readonly count: () => Promise<number>;
  readonly countByStatus: (status: RuleStatus) => Promise<number>;
  readonly flush: () => Promise<void>;
  readonly compact: () => Promise<void>;
}

// ─── 内存实现 ───

/**
 * createMemoryRuleStore — 创建内存中的规则存储（测试用）。
 */
export function createMemoryRuleStore(): RuleStore {
  const rules = new Map<string, EvolutionRule>();

  return {
    async getAll() {
      return [...rules.values()];
    },

    async getById(ruleId: string) {
      return rules.get(ruleId);
    },

    async getByStatus(status: RuleStatus) {
      return [...rules.values()].filter((r) => r.status === status);
    },

    async getActive() {
      return [...rules.values()].filter((r) => r.status === RuleStatus.ACTIVE);
    },

    async add(input: EvolutionRuleInput) {
      const parsed = EvolutionRuleSchema.parse(input);
      if (rules.size >= EVOLUTION_RULE_MAX_COUNT) {
        throw new Error(
          `Rule count limit reached: ${rules.size}/${EVOLUTION_RULE_MAX_COUNT}, cannot add new rule`,
        );
      }
      rules.set(parsed.rule_id, parsed);
      return parsed;
    },

    async update(ruleId: string, updates: Partial<EvolutionRule>) {
      const existing = rules.get(ruleId);
      if (existing === undefined) return undefined;

      const updated = { ...existing, ...updates, rule_id: existing.rule_id };
      const parsed = EvolutionRuleSchema.parse(updated);
      rules.set(ruleId, parsed);
      return parsed;
    },

    async delete(ruleId: string) {
      return rules.delete(ruleId);
    },

    async count() {
      return rules.size;
    },

    async countByStatus(status: RuleStatus) {
      return [...rules.values()].filter((r) => r.status === status).length;
    },

    async flush() {
    },

    async compact() {
    },
  };
}

// ─── JSONL 持久化实现 ───

/**
 * createJSONLRuleStore — 创建基于 JSONL 的持久化规则存储。
 *
 * D.2 修复：
 * - DM-02: Promise 链式锁保护读-改-写原子性
 * - M-02: debounce 防抖写入（默认 100ms）
 * - M-05: 懒加载 + 按状态索引
 *
 * 安全特性：
 * - 读-改-写原子性（先读取全部 → 修改 → 原子写入）
 * - Zod Schema 验证
 * - 规则数量上限检查
 */
export function createJSONLRuleStore(options?: {
  readonly debounceMs?: number;
}): RuleStore {
  const debounceMs = options?.debounceMs ?? 100;
  let cache: EvolutionRule[] | null = null;
  let dirty = false;

  // M-05: 懒加载索引（按状态）
  let statusIndex: Map<string, number[]> | null = null;

  // DM-02: Promise 链式锁
  const lock = createAsyncLock();

  function invalidateIndex(): void {
    statusIndex = null;
  }

  function buildStatusIndex(all: EvolutionRule[]): Map<string, number[]> {
    const index = new Map<string, number[]>();
    for (let i = 0; i < all.length; i++) {
      const status = all[i]!.status;
      let entries = index.get(status);
      if (!entries) {
        entries = [];
        index.set(status, entries);
      }
      entries.push(i);
    }
    return index;
  }

  async function loadAll(): Promise<EvolutionRule[]> {
    if (cache !== null && !dirty) return cache;

    try {
      const raw = await readJSONL(rulesFilePath);
      const validRules: EvolutionRule[] = [];
      let skippedCount = 0;
      for (const item of raw) {
        const result = EvolutionRuleSchema.safeParse(item);
        if (result.success) {
          validRules.push(result.data);
        } else {
          skippedCount++;
        }
      }
      if (skippedCount > 0) {
        console.warn(`[RULE-STORE] Skipped ${skippedCount} invalid rule(s) during load from ${rulesFilePath}`);
      }
      cache = validRules;
    } catch (err) {
      console.warn(`[RULE-STORE] Failed to load rules from ${rulesFilePath}: ${err instanceof Error ? err.message : String(err)}`);
      cache = [];
    }

    dirty = false;
    invalidateIndex();
    return cache;
  }

  async function saveAll(rules: EvolutionRule[]): Promise<void> {
    const lines = rules.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await atomicWriteText(rulesFilePath, lines);
    cache = rules;
    dirty = false;
    invalidateIndex();
  }

  const debouncedSave = createDebouncedWrite(saveAll, debounceMs);

  const COMPACT_DEPRECATED_RATIO = 0.3;
  const COMPACT_MAX_LINES = 1000;

  async function getAll(): Promise<readonly EvolutionRule[]> {
    return lock.locked(async () => loadAll());
  }

  async function getById(ruleId: string): Promise<EvolutionRule | undefined> {
    return lock.locked(async () => {
      const all = await loadAll();
      return all.find((r) => r.rule_id === ruleId);
    });
  }

  async function getByStatus(status: RuleStatus): Promise<readonly EvolutionRule[]> {
    return lock.locked(async () => {
      const all = await loadAll();

      // M-05: 使用索引加速
      if (statusIndex === null) {
        statusIndex = buildStatusIndex(all);
      }

      const indices = statusIndex.get(status);
      if (indices === undefined) return [];

      return indices.map((i) => all[i]!);
    });
  }

  async function getActive(): Promise<readonly EvolutionRule[]> {
    return getByStatus(RuleStatus.ACTIVE);
  }

  async function add(input: EvolutionRuleInput): Promise<EvolutionRule> {
    return lock.locked(async () => {
      const all = await loadAll();
      if (all.length >= EVOLUTION_RULE_MAX_COUNT) {
        throw new Error(
          `Rule count limit reached: ${all.length}/${EVOLUTION_RULE_MAX_COUNT}, cannot add new rule`,
        );
      }

      const parsed = EvolutionRuleSchema.parse(input);
      all.push(parsed);
      cache = all;
      dirty = false;
      invalidateIndex();
      debouncedSave.schedule(all);
      return parsed;
    });
  }

  async function update(ruleId: string, updates: Partial<EvolutionRule>): Promise<EvolutionRule | undefined> {
    return lock.locked(async () => {
      const all = await loadAll();
      const index = all.findIndex((r) => r.rule_id === ruleId);
      if (index === -1) return undefined;

      const updated = { ...all[index], ...updates, rule_id: all[index]!.rule_id };
      const parsed = EvolutionRuleSchema.parse(updated);
      all[index] = parsed;
      cache = all;
      dirty = false;
      invalidateIndex();
      debouncedSave.schedule(all);
      return parsed;
    });
  }

  async function remove(ruleId: string): Promise<boolean> {
    return lock.locked(async () => {
      const all = await loadAll();
      const index = all.findIndex((r) => r.rule_id === ruleId);
      if (index === -1) return false;

      all.splice(index, 1);
      cache = all;
      dirty = false;
      invalidateIndex();
      debouncedSave.schedule(all);
      return true;
    });
  }

  async function count(): Promise<number> {
    return lock.locked(async () => {
      const all = await loadAll();
      return all.length;
    });
  }

  async function countByStatus(status: RuleStatus): Promise<number> {
    return lock.locked(async () => {
      const all = await loadAll();
      if (statusIndex === null) {
        statusIndex = buildStatusIndex(all);
      }
      return statusIndex.get(status)?.length ?? 0;
    });
  }

  async function flush(): Promise<void> {
    await debouncedSave.flush();
  }

  async function compact(): Promise<void> {
    return lock.locked(async () => {
      const all = await loadAll();
      const deprecatedCount = all.filter(
        (r) => r.status === RuleStatus.DEPRECATED || r.status === RuleStatus.ROLLED_BACK,
      ).length;
      const deprecatedRatio = all.length > 0 ? deprecatedCount / all.length : 0;

      if (deprecatedRatio < COMPACT_DEPRECATED_RATIO && all.length < COMPACT_MAX_LINES) {
        return;
      }

      const retained = all.filter(
        (r) => r.status !== RuleStatus.DEPRECATED && r.status !== RuleStatus.ROLLED_BACK,
      );
      await saveAll(retained);
    });
  }

  return {
    getAll,
    getById,
    getByStatus,
    getActive,
    add,
    update,
    delete: remove,
    count,
    countByStatus,
    flush,
    compact,
  };
}

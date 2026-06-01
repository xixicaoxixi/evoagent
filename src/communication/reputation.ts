/**
 * Reputation System — 声誉系统。
 *
 * RULES_2-12: 半衰期衰减。
 * 综合声誉 = consensus_score * 0.4 + market_contribution * 0.3 + activity_score * 0.2 + longevity_bonus
 *
 * D5 修复：所有分项统一使用半衰期衰减（非线性0.95x）。
 * M11 修复：输入边界检查，所有分项上限 MAX_REPUTATION。
 * D4 修复：JSONL 持久化声誉数据。
 */

import { appendJSONL, readJSONL } from "../persistence/jsonl";

// ─── 声誉等级 ───

export type ReputationTier = "newcomer" | "member" | "trusted" | "elder";

// ─── 声誉数据 ───

export interface ReputationData {
  readonly instanceId: string;
  readonly reputation: number;
  readonly tier: ReputationTier;
  readonly voteWeight: number;
  readonly consensusScore: number;
  readonly marketContribution: number;
  readonly activityScore: number;
  readonly longevityDays: number;
  readonly lastActiveAt: number;
  readonly createdAt: number;
}

// ─── 声誉等级阈值 ───

const TIER_THRESHOLDS: ReadonlyArray<{
  readonly tier: ReputationTier;
  readonly minReputation: number;
  readonly voteWeight: number;
}> = [
  { tier: "newcomer", minReputation: 0, voteWeight: 1 },
  { tier: "member", minReputation: 20, voteWeight: 2 },
  { tier: "trusted", minReputation: 50, voteWeight: 3 },
  { tier: "elder", minReputation: 80, voteWeight: 5 },
];

// ─── 常量 ───

const MAX_REPUTATION = 1000;
const HALF_LIFE_DAYS = 30;
const DAYS_THRESHOLD = 30;
const DEFAULT_DATA_DIR = "./data/communication";

// ─── 声誉系统配置 ───

export interface ReputationSystemConfig {
  readonly dataDir?: string;
}

// ─── 声誉系统接口 ───

export interface ReputationSystem {
  getReputation(instanceId: string): ReputationData | null;
  updateReputation(instanceId: string, updates: {
    consensusScore?: number;
    marketContribution?: number;
    activityScore?: number;
  }): ReputationData;

  recordActivity(instanceId: string): void;
  addMarketContribution(instanceId: string, amount: number): void;
  decayReputation(): number;

  getTier(reputation: number): ReputationTier;
  getVoteWeight(tier: ReputationTier): number;
  listAll(): readonly ReputationData[];
  count(): number;
  clear(): void;
  loadFromStore(): Promise<void>;
  flush(): Promise<void>;
}

// ─── 内部状态 ───

interface InternalReputation {
  consensusScore: number;
  marketContribution: number;
  activityScore: number;
  lastActiveAt: number;
  createdAt: number;
}

// ─── 创建声誉系统 ───

export function createReputationSystem(config?: ReputationSystemConfig): ReputationSystem {
  const dataDir = config?.dataDir ?? DEFAULT_DATA_DIR;
  const store = new Map<string, InternalReputation>();

  function clampScore(value: number): number {
    return Math.max(0, Math.min(MAX_REPUTATION, value));
  }

  function calculateReputation(
    data: InternalReputation,
    instanceId: string,
  ): ReputationData {
    const now = Date.now();
    const longevityDays = Math.max(
      0,
      (now - data.createdAt) / (1000 * 60 * 60 * 24),
    );
    const longevityBonus = Math.min(longevityDays * 0.5, 10);

    const reputation = Math.min(
      MAX_REPUTATION,
      data.consensusScore * 0.4 +
        data.marketContribution * 0.3 +
        data.activityScore * 0.2 +
        longevityBonus,
    );

    const tier = getTier(reputation);

    return {
      instanceId,
      reputation: Math.round(reputation * 100) / 100,
      tier,
      voteWeight: getVoteWeight(tier),
      consensusScore: data.consensusScore,
      marketContribution: data.marketContribution,
      activityScore: data.activityScore,
      longevityDays: Math.round(longevityDays * 10) / 10,
      lastActiveAt: data.lastActiveAt,
      createdAt: data.createdAt,
    };
  }

  function getOrCreate(instanceId: string): InternalReputation {
    let data = store.get(instanceId);
    if (data === undefined) {
      data = {
        consensusScore: 0,
        marketContribution: 0,
        activityScore: 0,
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
      };
      store.set(instanceId, data);
    }
    return data;
  }

  function getReputation(instanceId: string): ReputationData | null {
    const data = store.get(instanceId);
    if (data === undefined) return null;
    return calculateReputation(data, instanceId);
  }

  function updateReputation(
    instanceId: string,
    updates: {
      consensusScore?: number;
      marketContribution?: number;
      activityScore?: number;
    },
  ): ReputationData {
    const data = getOrCreate(instanceId);

    if (updates.consensusScore !== undefined) {
      data.consensusScore = clampScore(updates.consensusScore);
    }
    if (updates.marketContribution !== undefined) {
      data.marketContribution = clampScore(updates.marketContribution);
    }
    if (updates.activityScore !== undefined) {
      data.activityScore = clampScore(updates.activityScore);
    }

    data.lastActiveAt = Date.now();
    return calculateReputation(data, instanceId);
  }

  function recordActivity(instanceId: string): void {
    const data = getOrCreate(instanceId);
    data.activityScore = Math.min(MAX_REPUTATION, data.activityScore + 0.1);
    data.lastActiveAt = Date.now();
  }

  function addMarketContribution(
    instanceId: string,
    amount: number,
  ): void {
    const data = getOrCreate(instanceId);
    data.marketContribution = Math.min(
      MAX_REPUTATION,
      data.marketContribution + amount,
    );
    data.lastActiveAt = Date.now();
  }

  function decayReputation(): number {
    const now = Date.now();
    let decayed = 0;

    for (const [, data] of store) {
      const inactiveDays =
        (now - data.lastActiveAt) / (1000 * 60 * 60 * 24);

      if (inactiveDays > DAYS_THRESHOLD) {
        const decayFactor = Math.pow(2, -inactiveDays / HALF_LIFE_DAYS);
        data.consensusScore *= decayFactor;
        data.activityScore *= decayFactor;
        data.marketContribution *= decayFactor;
        decayed++;
      }
    }

    return decayed;
  }

  function getTier(reputation: number): ReputationTier {
    for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
      if (reputation >= TIER_THRESHOLDS[i]!.minReputation) {
        return TIER_THRESHOLDS[i]!.tier;
      }
    }
    return "newcomer";
  }

  function getVoteWeight(tier: ReputationTier): number {
    const entry = TIER_THRESHOLDS.find((t) => t.tier === tier);
    return entry?.voteWeight ?? 1;
  }

  function listAll(): readonly ReputationData[] {
    return [...store.entries()].map(([id, data]) =>
      calculateReputation(data, id),
    );
  }

  function count(): number {
    return store.size;
  }

  function clear(): void {
    store.clear();
  }

  async function loadFromStore(): Promise<void> {
    const filePath = `${dataDir}/reputations.jsonl`;
    const records = await readJSONL<{ instanceId: string } & InternalReputation>(filePath);
    for (const record of records) {
      const { instanceId, ...internalData } = record;
      store.set(instanceId, {
        consensusScore: internalData.consensusScore,
        marketContribution: internalData.marketContribution,
        activityScore: internalData.activityScore,
        lastActiveAt: internalData.lastActiveAt,
        createdAt: internalData.createdAt,
      });
    }
  }

  async function flush(): Promise<void> {
    const filePath = `${dataDir}/reputations.jsonl`;
    for (const [instanceId, data] of store) {
      await appendJSONL(filePath, { instanceId, ...data });
    }
  }

  return {
    getReputation,
    updateReputation,
    recordActivity,
    addMarketContribution,
    decayReputation,
    getTier,
    getVoteWeight,
    listAll,
    count,
    clear,
    loadFromStore,
    flush,
  };
}

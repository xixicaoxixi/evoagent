/**
 * Consensus Engine — Web of Trust 共识引擎。
 *
 * 基于背书（Endorsement）的信任评分系统。
 *
 * M17/D6 修复：纯负面背书返回负值（非零）。
 * C19 修复：背书去重逻辑使用复合索引，可读性提升。
 * R3 修复：signerId+targetId 复合索引，O(1) 查找同实例背书。
 * D4 修复：JSONL 持久化背书数据。
 */

import { appendJSONL, readJSONL } from "../persistence/jsonl";

// ─── 背书类型 ───

export type EndorsementVerdict = "positive" | "negative";
export type EndorsementTargetType = "rule" | "knowledge" | "instance";

// ─── Endorsement 数据模型 ───

export interface Endorsement {
  readonly endorsementId: string;
  readonly signerId: string;
  readonly targetType: EndorsementTargetType;
  readonly targetId: string;
  readonly verdict: EndorsementVerdict;
  readonly confidence: number;
  readonly reason: string;
  readonly signature: string;
  readonly timestamp: number;
}

// ─── ConsensusScore ───

export interface ConsensusScore {
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly totalEndorsements: number;
  readonly weightedScore: number;
  readonly consensusRatio: number;
}

// ─── 共识引擎配置 ───

export interface ConsensusEngineConfig {
  readonly dataDir?: string;
}

// ─── 共识引擎接口 ───

export interface ConsensusEngine {
  createEndorsement(input: {
    signerId: string;
    targetType: EndorsementTargetType;
    targetId: string;
    verdict: EndorsementVerdict;
    confidence: number;
    reason?: string;
    signature?: string;
  }): Endorsement;

  receiveEndorsement(endorsement: Endorsement): { accepted: boolean; reason?: string };
  isTrustedByConsensus(targetId: string, options?: {
    minScore?: number;
    minEndorsements?: number;
  }): boolean;

  isFlaggedByConsensus(targetId: string, options?: {
    maxNegativeRatio?: number;
    minEndorsements?: number;
  }): boolean;

  getConsensusScore(targetId: string): ConsensusScore | null;
  getEndorsements(targetId: string): readonly Endorsement[];
  count(): number;
  clear(): void;
  loadFromStore(): Promise<void>;
  flush(): Promise<void>;
}

// ─── 常量 ───

const MAX_ENDORSEMENTS = 1000;
const DEFAULT_MIN_SCORE = 0.3;
const DEFAULT_MIN_ENDORSEMENTS = 3;
const DEFAULT_MAX_NEGATIVE_RATIO = 0.5;
const DEFAULT_FLAG_MIN_ENDORSEMENTS = 2;
const MAX_REASON_LENGTH = 2000;
const MAX_SIGNATURE_LENGTH = 10_000;
const DEFAULT_DATA_DIR = "./data/communication";

// ─── 创建共识引擎 ───

export function createConsensusEngine(config?: ConsensusEngineConfig): ConsensusEngine {
  const dataDir = config?.dataDir ?? DEFAULT_DATA_DIR;
  const endorsements = new Map<string, Endorsement>();
  const targetEndorsements = new Map<string, Endorsement[]>();
  const signerTargetIndex = new Map<string, Endorsement>();

  function signerTargetKey(signerId: string, targetId: string): string {
    return `${signerId}::${targetId}`;
  }

  function createEndorsement(input: {
    signerId: string;
    targetType: EndorsementTargetType;
    targetId: string;
    verdict: EndorsementVerdict;
    confidence: number;
    reason?: string;
    signature?: string;
  }): Endorsement {
    if (input.reason !== undefined && input.reason.length > MAX_REASON_LENGTH) {
      throw new Error(`Endorsement reason exceeds ${MAX_REASON_LENGTH} characters (got: ${input.reason.length})`);
    }
    if (input.signature !== undefined && input.signature.length > MAX_SIGNATURE_LENGTH) {
      throw new Error(`Endorsement signature exceeds ${MAX_SIGNATURE_LENGTH} characters (got: ${input.signature.length})`);
    }

    const timestamp = Date.now();
    const endorsementId = `endo_${timestamp}_${input.signerId.slice(0, 8)}`;

    return {
      endorsementId,
      signerId: input.signerId,
      targetType: input.targetType,
      targetId: input.targetId,
      verdict: input.verdict,
      confidence: Math.max(0, Math.min(1, input.confidence)),
      reason: input.reason ?? "",
      signature: input.signature ?? "",
      timestamp,
    };
  }

  function receiveEndorsement(
    endorsement: Endorsement,
  ): { accepted: boolean; reason?: string } {
    if (endorsement.reason !== undefined && endorsement.reason.length > MAX_REASON_LENGTH) {
      return { accepted: false, reason: `Endorsement reason exceeds ${MAX_REASON_LENGTH} characters` };
    }
    if (endorsement.signature !== undefined && endorsement.signature.length > MAX_SIGNATURE_LENGTH) {
      return { accepted: false, reason: `Endorsement signature exceeds ${MAX_SIGNATURE_LENGTH} characters` };
    }
    if (endorsement.confidence < 0 || endorsement.confidence > 1) {
      return { accepted: false, reason: "Invalid confidence value" };
    }

    const key = signerTargetKey(endorsement.signerId, endorsement.targetId);
    const existingEndorsement = signerTargetIndex.get(key);

    if (existingEndorsement !== undefined) {
      const targetList = targetEndorsements.get(endorsement.targetId);
      if (targetList !== undefined) {
        const idx = targetList.findIndex((e) => e.signerId === endorsement.signerId);
        if (idx >= 0) {
          targetList[idx] = endorsement;
        }
      }
      endorsements.delete(existingEndorsement.endorsementId);
      endorsements.set(endorsement.endorsementId, endorsement);
      signerTargetIndex.set(key, endorsement);
      return { accepted: true, reason: "updated existing endorsement" };
    }

    if (endorsements.size >= MAX_ENDORSEMENTS) {
      const sorted = [...endorsements.values()].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      const toRemove = sorted.slice(0, 100);
      for (const e of toRemove) {
        endorsements.delete(e.endorsementId);
        signerTargetIndex.delete(signerTargetKey(e.signerId, e.targetId));
        const list = targetEndorsements.get(e.targetId);
        if (list !== undefined) {
          const idx = list.indexOf(e);
          if (idx >= 0) list.splice(idx, 1);
        }
      }
    }

    endorsements.set(endorsement.endorsementId, endorsement);
    signerTargetIndex.set(key, endorsement);

    const targetList = targetEndorsements.get(endorsement.targetId) ?? [];
    targetList.push(endorsement);
    targetEndorsements.set(endorsement.targetId, targetList);

    return { accepted: true };
  }

  function getConsensusScore(targetId: string): ConsensusScore | null {
    const list = targetEndorsements.get(targetId);
    if (list === undefined || list.length === 0) return null;

    const positiveEndorsements = list.filter((e) => e.verdict === "positive");
    const negativeEndorsements = list.filter((e) => e.verdict === "negative");
    const positiveCount = positiveEndorsements.length;
    const negativeCount = negativeEndorsements.length;
    const total = list.length;

    const avgPositiveConfidence =
      positiveCount > 0
        ? positiveEndorsements.reduce((sum, e) => sum + e.confidence, 0) / positiveCount
        : 0;

    const avgNegativeConfidence =
      negativeCount > 0
        ? negativeEndorsements.reduce((sum, e) => sum + e.confidence, 0) / negativeCount
        : 0;

    let weightedScore: number;
    if (positiveCount === 0 && negativeCount > 0) {
      weightedScore = -(negativeCount / total) * avgNegativeConfidence;
    } else if (negativeCount === 0 && positiveCount > 0) {
      weightedScore = (positiveCount / total) * avgPositiveConfidence;
    } else {
      const positiveWeight = (positiveCount / total) * avgPositiveConfidence;
      const negativeWeight = (negativeCount / total) * avgNegativeConfidence;
      weightedScore = positiveWeight - negativeWeight;
    }

    const consensusRatio =
      Math.round(((positiveCount - negativeCount) / total) * 10000) / 10000;

    return {
      positiveCount,
      negativeCount,
      totalEndorsements: total,
      weightedScore: Math.round(Math.max(-1, Math.min(1, weightedScore)) * 10000) / 10000,
      consensusRatio: Math.max(-1, Math.min(1, consensusRatio)),
    };
  }

  function isTrustedByConsensus(
    targetId: string,
    options?: { minScore?: number; minEndorsements?: number },
  ): boolean {
    const score = getConsensusScore(targetId);
    if (score === null) return false;

    const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
    const minEndorsements = options?.minEndorsements ?? DEFAULT_MIN_ENDORSEMENTS;

    return (
      score.weightedScore >= minScore &&
      score.totalEndorsements >= minEndorsements
    );
  }

  function isFlaggedByConsensus(
    targetId: string,
    options?: { maxNegativeRatio?: number; minEndorsements?: number },
  ): boolean {
    const score = getConsensusScore(targetId);
    if (score === null) return false;

    const maxRatio = options?.maxNegativeRatio ?? DEFAULT_MAX_NEGATIVE_RATIO;
    const minEndorsements =
      options?.minEndorsements ?? DEFAULT_FLAG_MIN_ENDORSEMENTS;

    if (score.totalEndorsements < minEndorsements) return false;

    const negativeRatio =
      score.negativeCount / score.totalEndorsements;
    return negativeRatio >= maxRatio;
  }

  function getEndorsements(targetId: string): readonly Endorsement[] {
    return targetEndorsements.get(targetId) ?? [];
  }

  function count(): number {
    return endorsements.size;
  }

  function clear(): void {
    endorsements.clear();
    targetEndorsements.clear();
    signerTargetIndex.clear();
  }

  async function loadFromStore(): Promise<void> {
    const filePath = `${dataDir}/endorsements.jsonl`;
    const records = await readJSONL<Endorsement>(filePath);
    for (const record of records) {
      endorsements.set(record.endorsementId, record);

      const key = signerTargetKey(record.signerId, record.targetId);
      signerTargetIndex.set(key, record);

      const targetList = targetEndorsements.get(record.targetId) ?? [];
      targetList.push(record);
      targetEndorsements.set(record.targetId, targetList);
    }
  }

  async function flush(): Promise<void> {
    const filePath = `${dataDir}/endorsements.jsonl`;
    const allEndorsements = [...endorsements.values()];
    for (const endorsement of allEndorsements) {
      await appendJSONL(filePath, endorsement);
    }
    endorsements.clear();
    targetEndorsements.clear();
    signerTargetIndex.clear();
    await loadFromStore();
  }

  return {
    createEndorsement,
    receiveEndorsement,
    isTrustedByConsensus,
    isFlaggedByConsensus,
    getConsensusScore,
    getEndorsements,
    count,
    clear,
    loadFromStore,
    flush,
  };
}

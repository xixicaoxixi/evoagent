/**
 * Community Governance — 社区治理。
 *
 * 提案 + 加权投票 + 声誉等级联动。
 */

import type { ReputationTier } from "./reputation";
import type { SimpleLLMProvider } from "../llm/adapter";

// ─── 提案类型 ───

export type ProposalType =
  | "parameter_change"
  | "rule_promotion"
  | "network_policy"
  | "emergency";

// ─── 提案状态 ───

export type ProposalStatus = "open" | "passed" | "rejected" | "expired";

// ─── GovernanceProposal ───

export interface GovernanceProposal {
  readonly proposalId: string;
  readonly proposalType: ProposalType;
  readonly title: string;
  readonly description: string;
  readonly authorId: string;
  readonly votesFor: readonly string[];
  readonly votesAgainst: readonly string[];
  readonly voteWeights: Readonly<Record<string, number>>; // voterId -> weight
  readonly passThreshold: number;
  readonly minVoters: number;
  readonly votingHours: number;
  readonly status: ProposalStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly closedAt?: number;
}

// ─── 投票结果 ───

export interface VoteResult {
  readonly accepted: boolean;
  readonly reason: string;
}

// ─── Community 接口 ───

export interface Community {
  createProposal(input: {
    proposalType: ProposalType;
    title: string;
    description: string;
    authorId: string;
    passThreshold?: number;
    minVoters?: number;
    votingHours?: number;
  }): GovernanceProposal;

  vote(
    proposalId: string,
    voterId: string,
    support: boolean,
    voterTier: ReputationTier,
  ): VoteResult;

  closeExpiredProposals(): number;
  getProposal(proposalId: string): GovernanceProposal | null;
  getOpenProposals(): readonly GovernanceProposal[];
  getProposalStats(): {
    readonly total: number;
    readonly open: number;
    readonly passed: number;
    readonly rejected: number;
    readonly expired: number;
  };
  count(): number;
  clear(): void;
}

// ─── 投票权重映射 ───

const TIER_VOTE_WEIGHTS: Readonly<Record<ReputationTier, number>> = {
  newcomer: 1,
  member: 2,
  trusted: 3,
  elder: 5,
};

// ─── 创建 Community ───

const MAX_PROPOSAL_TITLE_LENGTH = 500;
const MAX_PROPOSAL_DESCRIPTION_LENGTH = 5000;
const MAX_PROPOSALS = 200;

// ─── Community 配置 ───

export interface CommunityConfig {
  readonly llmProvider?: SimpleLLMProvider;
}

export function createCommunity(config?: CommunityConfig): Community {
  const llmProvider = config?.llmProvider;
  const proposals = new Map<string, GovernanceProposal>();

  function createProposal(input: {
    proposalType: ProposalType;
    title: string;
    description: string;
    authorId: string;
    passThreshold?: number;
    minVoters?: number;
    votingHours?: number;
  }): GovernanceProposal {
    // C.2: title/description 长度限制
    if (input.title.length > MAX_PROPOSAL_TITLE_LENGTH) {
      throw new Error(`Proposal title exceeds ${MAX_PROPOSAL_TITLE_LENGTH} characters`);
    }
    if (input.description.length > MAX_PROPOSAL_DESCRIPTION_LENGTH) {
      throw new Error(`Proposal description exceeds ${MAX_PROPOSAL_DESCRIPTION_LENGTH} characters`);
    }

    // C.2: 提案总量限制
    if (proposals.size >= MAX_PROPOSALS) {
      throw new Error(`Maximum number of proposals (${MAX_PROPOSALS}) reached`);
    }

    const now = Date.now();
    const passThreshold = Math.max(0.5, Math.min(1, input.passThreshold ?? 0.6));
    const minVoters = Math.max(1, Math.min(20, input.minVoters ?? 3));
    const votingHours = Math.max(0, input.votingHours ?? 72);

    const proposal: GovernanceProposal = {
      proposalId: `proposal_${now}_${input.authorId.slice(0, 8)}`,
      proposalType: input.proposalType,
      title: input.title,
      description: input.description,
      authorId: input.authorId,
      votesFor: [],
      votesAgainst: [],
      voteWeights: {},
      passThreshold,
      minVoters,
      votingHours,
      status: "open",
      createdAt: now,
      expiresAt: now + votingHours * 3600_000,
    };

    proposals.set(proposal.proposalId, proposal);

    // LLM 提案质量评估（fire-and-forget，结果附加到 description）
    if (llmProvider !== undefined) {
      void llmProvider.invoke([
        { role: "system", content: "Evaluate this governance proposal for completeness and feasibility. One sentence." },
        { role: "user", content: `Title: ${input.title}, Description: ${input.description}` },
      ]).then((assessment) => {
        const trimmed = assessment.trim();
        const updated: GovernanceProposal = {
          ...proposal,
          description: `${proposal.description}\n\n[LLM Assessment] ${trimmed}`,
        };
        proposals.set(proposal.proposalId, updated);
      }).catch(() => {
        // fire-and-forget: LLM 失败时忽略
      });
    }

    return proposal;
  }

  function vote(
    proposalId: string,
    voterId: string,
    support: boolean,
    voterTier: ReputationTier,
  ): VoteResult {
    const proposal = proposals.get(proposalId);
    if (proposal === undefined) {
      return { accepted: false, reason: "Proposal not found" };
    }
    if (proposal.status !== "open") {
      return { accepted: false, reason: `Proposal is ${proposal.status}` };
    }
    if (Date.now() > proposal.expiresAt) {
      return { accepted: false, reason: "Proposal has expired" };
    }

    // 检查是否已投票
    const allVoters = [...proposal.votesFor, ...proposal.votesAgainst];
    if (allVoters.includes(voterId)) {
      return { accepted: false, reason: "Already voted" };
    }

    // 投票
    const newVotesFor = support
      ? [...proposal.votesFor, voterId]
      : proposal.votesFor;
    const newVotesAgainst = !support
      ? [...proposal.votesAgainst, voterId]
      : proposal.votesAgainst;
    const newVoteWeights = { ...proposal.voteWeights, [voterId]: TIER_VOTE_WEIGHTS[voterTier] };

    // 计算加权结果
    let totalWeightedVoters = 0;
    let weightedSupport = 0;
    for (const voter of newVotesFor) {
      const w = newVoteWeights[voter] ?? 1;
      totalWeightedVoters += w;
      weightedSupport += w;
    }
    for (const voter of newVotesAgainst) {
      const w = newVoteWeights[voter] ?? 1;
      totalWeightedVoters += w;
    }

    const weightedSupportRate =
      totalWeightedVoters > 0
        ? weightedSupport / totalWeightedVoters
        : 0;

    // 更新提案
    let updated: GovernanceProposal = {
      ...proposal,
      votesFor: newVotesFor,
      votesAgainst: newVotesAgainst,
      voteWeights: newVoteWeights,
    };

    // 检查是否通过（minVoters 基于投票人数，非权重总和）
    const totalVoters = newVotesFor.length + newVotesAgainst.length;
    if (
      totalVoters >= proposal.minVoters &&
      weightedSupportRate >= proposal.passThreshold
    ) {
      updated = { ...updated, status: "passed", closedAt: Date.now() };
      proposals.set(proposalId, updated);
      return { accepted: true, reason: "Proposal passed" };
    }

    proposals.set(proposalId, updated);
    return { accepted: true, reason: "Vote recorded" };
  }

  function closeExpiredProposals(): number {
    const now = Date.now();
    let closed = 0;

    for (const [id, proposal] of proposals) {
      if (proposal.status === "open" && now >= proposal.expiresAt) {
        proposals.set(id, {
          ...proposal,
          status: "expired",
          closedAt: now,
        });
        closed++;
      }
    }

    return closed;
  }

  function getProposal(proposalId: string): GovernanceProposal | null {
    return proposals.get(proposalId) ?? null;
  }

  function getOpenProposals(): readonly GovernanceProposal[] {
    return [...proposals.values()].filter((p) => p.status === "open");
  }

  function getProposalStats() {
    let open = 0;
    let passed = 0;
    let rejected = 0;
    let expired = 0;

    for (const p of proposals.values()) {
      switch (p.status) {
        case "open": open++; break;
        case "passed": passed++; break;
        case "rejected": rejected++; break;
        case "expired": expired++; break;
      }
    }

    return {
      total: proposals.size,
      open,
      passed,
      rejected,
      expired,
    };
  }

  function count(): number {
    return proposals.size;
  }

  function clear(): void {
    proposals.clear();
  }

  return {
    createProposal,
    vote,
    closeExpiredProposals,
    getProposal,
    getOpenProposals,
    getProposalStats,
    count,
    clear,
  };
}

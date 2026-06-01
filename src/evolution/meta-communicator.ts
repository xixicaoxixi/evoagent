/**
 * 二阶交流器（P4-10）— 跨实例分享参数修改提案。
 *
 * 参考 SYSTEM_DESIGN.md 3.5.3。
 * 5 步安全流程：
 * 1. 信任检查（source trust >= 0.7）
 * 2. 年龄检查（source age >= 30 天）
 * 3. 宪法验证（不触及宪法层）
 * 4. 数量限制（每次最多 3 个提案）
 * 5. 接受/拒绝
 */

import {
  META_COMM_MIN_TRUST,
  META_COMM_MIN_AGE_DAYS,
  META_COMM_MAX_PROPOSALS_PER_SYNC,
} from "./constants";
import { validateProposal, isConstitutional } from "./constitutional-guard";

// ─── 类型定义 ───

export interface MetaProposal {
  readonly proposalId: string;
  readonly sourcePeerId: string;
  readonly paramName: string;
  readonly proposedValue: unknown;
  readonly reason: string;
  readonly sourceTrust: number;
  readonly sourceAgeDays: number;
}

export interface ProposalFilterResult {
  readonly accepted: readonly MetaProposal[];
  readonly rejected: readonly { proposal: MetaProposal; reason: string }[];
}

// ─── 二阶交流器 ───

/**
 * createMetaCommunicator — 创建二阶交流器。
 */
export function createMetaCommunicator() {
  const acceptedProposals: MetaProposal[] = [];
  const rejectedHistory: Array<{ proposal: MetaProposal; reason: string }> = [];

  return {
    /**
     * filterProposals — 过滤收到的提案。
     *
     * 5 步安全流程：
     * 1. 信任检查
     * 2. 年龄检查
     * 3. 宪法验证
     * 4. 数量限制
     * 5. 去重
     */
    filterProposals(
      proposals: readonly MetaProposal[],
    ): ProposalFilterResult {
      const accepted: MetaProposal[] = [];
      const rejected: Array<{ proposal: MetaProposal; reason: string }> = [];
      const seenParams = new Set<string>();

      for (const proposal of proposals) {
        // 1. 信任检查
        if (proposal.sourceTrust < META_COMM_MIN_TRUST) {
          rejected.push({
            proposal,
            reason: `Source trust ${proposal.sourceTrust.toFixed(2)} < ${META_COMM_MIN_TRUST}`,
          });
          continue;
        }

        // 2. 年龄检查
        if (proposal.sourceAgeDays < META_COMM_MIN_AGE_DAYS) {
          rejected.push({
            proposal,
            reason: `Source age ${proposal.sourceAgeDays}d < ${META_COMM_MIN_AGE_DAYS}d`,
          });
          continue;
        }

        // 3. 宪法验证
        if (isConstitutional(proposal.paramName)) {
          rejected.push({
            proposal,
            reason: `Parameter "${proposal.paramName}" is constitutional`,
          });
          continue;
        }

        const validation = validateProposal(proposal.paramName, proposal.proposedValue);
        if (!validation.valid) {
          rejected.push({
            proposal,
            reason: validation.reason,
          });
          continue;
        }

        // 4. 数量限制
        if (accepted.length >= META_COMM_MAX_PROPOSALS_PER_SYNC) {
          rejected.push({
            proposal,
            reason: `Max proposals per sync reached (${META_COMM_MAX_PROPOSALS_PER_SYNC})`,
          });
          continue;
        }

        // 5. 去重
        if (seenParams.has(proposal.paramName)) {
          rejected.push({
            proposal,
            reason: `Duplicate parameter: ${proposal.paramName}`,
          });
          continue;
        }

        seenParams.add(proposal.paramName);
        accepted.push(proposal);
      }

      return { accepted, rejected };
    },

    /**
     * acceptProposal — 接受提案并应用。
     */
    acceptProposal(proposal: MetaProposal): Record<string, unknown> {
      const validation = validateProposal(proposal.paramName, proposal.proposedValue);
      if (!validation.valid) {
        throw new Error(`Cannot accept proposal: ${validation.reason}`);
      }

      const value = validation.clampedValue ?? proposal.proposedValue;
      acceptedProposals.push(proposal);
      return { [proposal.paramName]: value };
    },

    /**
     * getAcceptedProposals — 获取已接受的提案。
     */
    getAcceptedProposals(): readonly MetaProposal[] {
      return [...acceptedProposals];
    },

    /**
     * getRejectedHistory — 获取拒绝历史。
     */
    getRejectedHistory(): readonly { proposal: MetaProposal; reason: string }[] {
      return [...rejectedHistory];
    },
  };
}

export type MetaCommunicator = ReturnType<typeof createMetaCommunicator>;

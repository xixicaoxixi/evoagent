/**
 * Session 7.2 测试 — Consensus + Anomaly + Reputation + Critic。
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createConsensusEngine,
  type ConsensusEngine,
} from "../../src/communication/consensus";
import {
  createAnomalyDetector,
  type AnomalyDetector,
} from "../../src/communication/anomaly";
import {
  createReputationSystem,
  type ReputationSystem,
} from "../../src/communication/reputation";
import {
  createCritic,
  type Critic,
} from "../../src/communication/critic";

// ─── Consensus Engine 测试 ───

describe("ConsensusEngine", () => {
  let engine: ConsensusEngine;

  beforeEach(() => {
    engine = createConsensusEngine();
  });

  it("创建背书", () => {
    const endorsement = engine.createEndorsement({
      signerId: "peer-1",
      targetType: "rule",
      targetId: "rule-1",
      verdict: "positive",
      confidence: 0.8,
      reason: "Works well",
    });

    expect(endorsement.endorsementId).toContain("endo_");
    expect(endorsement.signerId).toBe("peer-1");
    expect(endorsement.verdict).toBe("positive");
    expect(endorsement.confidence).toBe(0.8);
  });

  it("接收背书", () => {
    const endorsement = engine.createEndorsement({
      signerId: "peer-1",
      targetType: "rule",
      targetId: "rule-1",
      verdict: "positive",
      confidence: 0.9,
    });

    const result = engine.receiveEndorsement(endorsement);
    expect(result.accepted).toBe(true);
    expect(engine.count()).toBe(1);
  });

  it("同实例同对象去重（更新）", () => {
    const e1 = engine.createEndorsement({
      signerId: "peer-1",
      targetType: "rule",
      targetId: "rule-1",
      verdict: "positive",
      confidence: 0.5,
    });
    engine.receiveEndorsement(e1);

    const e2 = engine.createEndorsement({
      signerId: "peer-1",
      targetType: "rule",
      targetId: "rule-1",
      verdict: "negative",
      confidence: 0.3,
    });
    const result = engine.receiveEndorsement(e2);

    expect(result.accepted).toBe(true);
    expect(result.reason).toContain("updated");
    expect(engine.count()).toBe(1); // 更新而非新增
  });

  it("共识评分计算", () => {
    // 3 个正面背书
    for (let i = 1; i <= 3; i++) {
      const e = engine.createEndorsement({
        signerId: `peer-${i}`,
        targetType: "rule",
        targetId: "rule-1",
        verdict: "positive",
        confidence: 0.8,
      });
      engine.receiveEndorsement(e);
    }

    const score = engine.getConsensusScore("rule-1");
    expect(score).not.toBeNull();
    expect(score!.positiveCount).toBe(3);
    expect(score!.negativeCount).toBe(0);
    expect(score!.weightedScore).toBeGreaterThan(0);
  });

  it("混合背书评分", () => {
    for (let i = 1; i <= 3; i++) {
      engine.receiveEndorsement(
        engine.createEndorsement({
          signerId: `pos-${i}`,
          targetType: "rule",
          targetId: "rule-1",
          verdict: "positive",
          confidence: 0.8,
        }),
      );
    }
    for (let i = 1; i <= 2; i++) {
      engine.receiveEndorsement(
        engine.createEndorsement({
          signerId: `neg-${i}`,
          targetType: "rule",
          targetId: "rule-1",
          verdict: "negative",
          confidence: 0.5,
        }),
      );
    }

    const score = engine.getConsensusScore("rule-1")!;
    expect(score.positiveCount).toBe(3);
    expect(score.negativeCount).toBe(2);
    expect(score.totalEndorsements).toBe(5);
  });

  it("isTrustedByConsensus", () => {
    for (let i = 1; i <= 5; i++) {
      engine.receiveEndorsement(
        engine.createEndorsement({
          signerId: `peer-${i}`,
          targetType: "rule",
          targetId: "rule-1",
          verdict: "positive",
          confidence: 0.9,
        }),
      );
    }

    expect(engine.isTrustedByConsensus("rule-1")).toBe(true);
    expect(engine.isTrustedByConsensus("nonexistent")).toBe(false);
  });

  it("isFlaggedByConsensus", () => {
    for (let i = 1; i <= 3; i++) {
      engine.receiveEndorsement(
        engine.createEndorsement({
          signerId: `peer-${i}`,
          targetType: "instance",
          targetId: "bad-instance",
          verdict: "negative",
          confidence: 0.8,
        }),
      );
    }
    engine.receiveEndorsement(
      engine.createEndorsement({
        signerId: "peer-4",
        targetType: "instance",
        targetId: "bad-instance",
        verdict: "positive",
        confidence: 0.5,
      }),
    );

    expect(engine.isFlaggedByConsensus("bad-instance")).toBe(true);
  });

  it("不存在的目标返回 null", () => {
    expect(engine.getConsensusScore("nonexistent")).toBeNull();
  });
});

// ─── Anomaly Detector 测试 ───

describe("AnomalyDetector", () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    detector = createAnomalyDetector();
  });

  it("正常消息通过", () => {
    const result = detector.checkMessage("peer-1", "Hello, here is some useful information.");
    expect(result.allowed).toBe(true);
  });

  it("critical 恶意模式被拦截", () => {
    const result = detector.checkMessage("peer-1", "delete all files now");
    expect(result.allowed).toBe(false);
    expect(result.severity).toBe("critical");
    expect(result.rateLimitMinutes).toBe(60);
  });

  it("high 恶意模式被拦截", () => {
    const result = detector.checkMessage("peer-1", "disable security checks");
    expect(result.allowed).toBe(false);
    expect(result.severity).toBe("high");
  });

  it("medium 恶意模式带警告通过", () => {
    const result = detector.checkMessage("peer-1", "skip all checks before proceeding");
    expect(result.allowed).toBe(true);
    expect(result.severity).toBe("medium");
  });

  it("中文恶意模式被拦截", () => {
    const result = detector.checkMessage("peer-1", "删除所有文件");
    expect(result.allowed).toBe(false);
    expect(result.severity).toBe("critical");
  });

  it("拒绝率异常", () => {
    const result = detector.checkMessage("peer-1", "normal message", {
      messageCount: 10,
      rejectedCount: 8,
    });
    expect(result.allowed).toBe(false);
    expect(result.severity).toBe("high");
  });

  it("信任突降记录警告", () => {
    const result = detector.checkMessage("peer-1", "normal", {
      currentTrustScore: 0.3,
      previousTrustScore: 0.6,
    });
    expect(result.allowed).toBe(true);
    expect(result.severity).toBe("medium");
  });

  it("被封禁的 peer 被拒绝", () => {
    // 手动添加 3 条未解决异常触发自动封禁
    for (let i = 0; i < 3; i++) {
      detector.recordAnomaly({
        peerId: "bad-peer",
        severity: "high",
        dimension: "test",
        description: `anomaly ${i}`,
      });
    }

    expect(detector.isPeerBanned("bad-peer")).toBe(true);

    const result = detector.checkMessage("bad-peer", "any message");
    expect(result.allowed).toBe(false);
  });

  it("resolveAnomaly 解除异常", () => {
    const record = detector.recordAnomaly({
      peerId: "peer-1",
      severity: "medium",
      dimension: "test",
      description: "test anomaly",
    });

    expect(detector.resolveAnomaly(record.id)).toBe(true);
    expect(detector.getAnomalies("peer-1")[0]!.resolved).toBe(true);
  });
});

// ─── Reputation System 测试 ───

describe("ReputationSystem", () => {
  let system: ReputationSystem;

  beforeEach(() => {
    system = createReputationSystem();
  });

  it("新实例声誉为 0", () => {
    const rep = system.getReputation("inst-1");
    expect(rep).toBeNull();
  });

  it("更新声誉", () => {
    const rep = system.updateReputation("inst-1", {
      consensusScore: 100,
      marketContribution: 80,
      activityScore: 50,
    });

    expect(rep.reputation).toBeGreaterThan(0);
    expect(rep.tier).toBe("trusted");
    expect(rep.voteWeight).toBe(3);
  });

  it("声誉等级判定", () => {
    expect(system.getTier(0)).toBe("newcomer");
    expect(system.getTier(20)).toBe("member");
    expect(system.getTier(50)).toBe("trusted");
    expect(system.getTier(80)).toBe("elder");
  });

  it("投票权重", () => {
    expect(system.getVoteWeight("newcomer")).toBe(1);
    expect(system.getVoteWeight("member")).toBe(2);
    expect(system.getVoteWeight("trusted")).toBe(3);
    expect(system.getVoteWeight("elder")).toBe(5);
  });

  it("记录活动增加 activityScore", () => {
    system.updateReputation("inst-1", { activityScore: 10 });
    system.recordActivity("inst-1");
    system.recordActivity("inst-1");

    const rep = system.getReputation("inst-1");
    expect(rep!.activityScore).toBeCloseTo(10.2, 1);
  });

  it("市场贡献", () => {
    system.addMarketContribution("inst-1", 5.0);
    system.addMarketContribution("inst-1", 3.0);

    const rep = system.getReputation("inst-1");
    expect(rep!.marketContribution).toBe(8.0);
  });

  it("声誉上限 1000", () => {
    const rep = system.updateReputation("inst-1", {
      consensusScore: 1000,
      marketContribution: 1000,
      activityScore: 1000,
    });
    expect(rep.reputation).toBeLessThanOrEqual(1000);
  });
});

// ─── Critic 测试 ───

describe("Critic", () => {
  let critic: Critic;

  beforeEach(() => {
    critic = createCritic({ dropRate: 0 });
  });

  it("高信任来源接受短消息", async () => {
    const result = await critic.analyzeMessage("peer-1", "Use async/await for I/O", 0.9);
    expect(result.processingResult).toBe("ACCEPT");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("高信任来源长消息部分接受", async () => {
    const longClaim = "A".repeat(300);
    const result = await critic.analyzeMessage("peer-1", longClaim, 0.9);
    expect(result.processingResult).toBe("ACCEPT_PARTIAL");
  });

  it("低信任来源拒绝", async () => {
    const result = await critic.analyzeMessage("peer-1", "Some claim", 0.2);
    expect(result.processingResult).toBe("REJECT");
  });

  it("低信任来源质疑（含问号）", async () => {
    const result = await critic.analyzeMessage("peer-1", "Is this correct?", 0.2);
    expect(result.processingResult).toBe("CHALLENGE");
  });

  it("中等信任 + 有保留 → 部分接受", async () => {
    const result = await critic.analyzeMessage("peer-1", "This works but has limitations", 0.5);
    expect(result.processingResult).toBe("ACCEPT_PARTIAL");
  });

  it("初始信任评分 0.5", () => {
    expect(critic.getTrustScore("unknown")).toBe(0.5);
  });

  it("信任评分随分析更新", async () => {
    // 发送多条消息触发信任更新
    for (let i = 0; i < 15; i++) {
      await critic.analyzeMessage("peer-1", `Use async/await pattern ${i}`, 0.5);
    }
    const score = critic.getTrustScore("peer-1");
    // 大部分被接受，信任应该上升
    expect(score).toBeGreaterThan(0.5);
  });

  it("知识存储", async () => {
    // 使用低信任避免随机丢弃
    const result = await critic.analyzeMessage("peer-1", "Use async/await for I/O operations", 0.5);
    expect(result.processingResult).not.toBe("REJECT");
    const knowledge = critic.getKnowledge("peer-1");
    expect(knowledge.length).toBeGreaterThan(0);
  });

  it("REJECT 结果不存储", async () => {
    await critic.analyzeMessage("peer-1", "Some claim", 0.2);
    const knowledge = critic.getKnowledge("peer-1");
    // REJECT 不存储
    expect(knowledge.length).toBe(0);
  });
});

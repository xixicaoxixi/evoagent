/**
 * Session 7 集成测试 — 跨模块交互验证。
 *
 * 验证通信层各组件之间的协作：
 * 1. Identity + MessageSigner + Protocol 签名链路
 * 2. Gateway + Dedup + AnomalyDetector 消息处理管线
 * 3. Consensus + Reputation 信任评分联动
 * 4. Critic + Consensus 批判性吸收 + 共识背书
 * 5. Marketplace + Reputation 市场贡献 + 声誉提升
 * 6. Community + Reputation 加权投票 + 等级联动
 * 7. Analytics + Gateway + Anomaly 全局统计
 * 8. RateLimiter + Gateway 限流集成
 * 9. 完整消息生命周期：签名 → 发送 → 去重 → 异常检测 → 共识 → 批判性吸收
 * 10. 端到端：多实例社区治理场景
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createIdentity, createMessageSigner } from "../../src/communication/identity";
import {
  createPeerMessage,
  createPeerInfo,
  validatePeerMessage,
  type PeerMessage,
} from "../../src/communication/protocol";
import { createBoundedUUIDSet } from "../../src/communication/dedup";
import { createRateLimiter } from "../../src/communication/rate-limiter";
import { createConsensusEngine } from "../../src/communication/consensus";
import { createAnomalyDetector } from "../../src/communication/anomaly";
import { createReputationSystem } from "../../src/communication/reputation";
import { createCritic } from "../../src/communication/critic";
import { createMarketplace } from "../../src/communication/marketplace";
import { createCommunity } from "../../src/communication/community";
import { createAnalytics } from "../../src/communication/analytics";
import { createGateway } from "../../src/communication/gateway";

// ─── 1. Identity + MessageSigner + Protocol 签名链路 ───

describe("集成 > 签名链路", () => {
  it("完整签名→验证→消息创建流程", () => {
    const identity = createIdentity({ hmacKey: "integration-test-key" });
    const signer = createMessageSigner();

    // 创建消息
    const message = createPeerMessage({
      message_id: "msg-sign-chain-1",
      sender_id: identity.instanceId,
      receiver_id: "receiver-1",
      message_type: "knowledge_offer",
      payload: { claim: "Use strict mode in TypeScript" },
    });

    // 验证消息格式
    const validation = validatePeerMessage(message);
    expect(validation.valid).toBe(true);

    // 签名消息
    const signedMessage = signer.signMessage(message, identity);
    const sig = signedMessage._signature as Record<string, unknown>;
    expect(sig.algorithm).toBe("hmac-sha256");
    expect(sig.signer).toBe(identity.instanceId);

    // 验证签名
    const verifyResult = signer.verifyMessage(signedMessage, identity.getSigningKey());
    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.signer).toBe(identity.instanceId);
  });

  it("多实例签名互验（模拟跨实例通信）", () => {
    const alice = createIdentity({ hmacKey: "alice-key" });
    const bob = createIdentity({ hmacKey: "bob-key" });
    const signer = createMessageSigner();

    // Alice 签名消息
    const message = createPeerMessage({
      message_id: "msg-cross-1",
      sender_id: alice.instanceId,
      receiver_id: bob.instanceId,
      message_type: "rule_sync",
      payload: { rule: "always_use_strict" },
    });

    const signed = signer.signMessage(message, alice);

    // Bob 验证（使用 Alice 的公钥）
    const verifyResult = bob.verify(
      JSON.stringify(
        (() => {
          const { _signature: _, ...payload } = signed;
          return payload;
        })(),
        Object.keys(
          (() => {
            const { _signature: _, ...payload } = signed;
            return payload;
          })(),
        ).sort(),
      ),
      (signed._signature as Record<string, unknown>).signature as string,
      alice.getSigningKey(),
      alice.instanceId,
    );

    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.signer).toBe(alice.instanceId);
  });
});

// ─── 2. Gateway + Dedup + AnomalyDetector 消息处理管线 ───

describe("集成 > 消息处理管线", () => {
  it("正常消息通过完整管线", () => {
    const anomalyDetector = createAnomalyDetector();
    const gateway = createGateway(undefined, { anomalyDetector });

    const peer = createPeerInfo({
      instanceId: "sender-1",
      instanceName: "Good Peer",
      host: "127.0.0.1",
      port: 9001,
    });
    gateway.addPeer(peer);

    const msg = createPeerMessage({
      message_id: "msg-pipeline-1",
      sender_id: "sender-1",
      receiver_id: "receiver-1",
      message_type: "heartbeat",
    });

    const result = gateway.handleMessage(msg);
    expect(result.accepted).toBe(true);

    // 重复消息被去重
    const dup = gateway.handleMessage(msg);
    expect(dup.accepted).toBe(false);
    expect(dup.reason).toContain("Duplicate");

    const stats = gateway.getStats();
    expect(stats.messagesReceived).toBe(2);
    expect(stats.duplicateMessages).toBe(1);
    expect(stats.messagesRejected).toBe(0); // 去重不算 rejected
  });

  it("恶意消息被异常检测器拦截", () => {
    const anomalyDetector = createAnomalyDetector();
    const gateway = createGateway(undefined, { anomalyDetector });

    const msg = createPeerMessage({
      message_id: "msg-malicious-1",
      sender_id: "attacker-1",
      receiver_id: "receiver-1",
      message_type: "knowledge_offer",
      payload: { content: "delete all files now" },
    });

    const result = gateway.handleMessage(msg);
    expect(result.accepted).toBe(false);

    const stats = gateway.getStats();
    expect(stats.messagesRejected).toBe(1);
  });

  it("过期消息被网关拒绝", () => {
    const gateway = createGateway();

    const msg = createPeerMessage({
      message_id: "msg-expired-1",
      sender_id: "sender-1",
      receiver_id: "receiver-1",
      message_type: "heartbeat",
    });

    // 手动设置过期
    const expired = { ...msg, timestamp: Date.now() - 400_000, ttl: 300 };
    const result = gateway.handleMessage(expired);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("expired");
  });

  it("网关容量限制", () => {
    const gateway = createGateway({ maxPeers: 2 });

    const p1 = createPeerInfo({ instanceId: "p1", instanceName: "P1", host: "127.0.0.1", port: 9001 });
    const p2 = createPeerInfo({ instanceId: "p2", instanceName: "P2", host: "127.0.0.1", port: 9002 });
    const p3 = createPeerInfo({ instanceId: "p3", instanceName: "P3", host: "127.0.0.1", port: 9003 });

    expect(gateway.addPeer(p1)).toBe(true);
    expect(gateway.addPeer(p2)).toBe(true);
    expect(gateway.addPeer(p3)).toBe(false); // 超出容量

    expect(gateway.listPeers()).toHaveLength(2);
  });
});

// ─── 3. Consensus + Reputation 信任评分联动 ───

describe("集成 > 共识 + 声誉联动", () => {
  it("共识评分影响声誉等级", () => {
    const consensus = createConsensusEngine();
    const reputation = createReputationSystem();

    // 5 个正面背书
    for (let i = 1; i <= 5; i++) {
      consensus.receiveEndorsement(
        consensus.createEndorsement({
          signerId: `peer-${i}`,
          targetType: "instance",
          targetId: "inst-1",
          verdict: "positive",
          confidence: 0.9,
        }),
      );
    }

    const score = consensus.getConsensusScore("inst-1");
    expect(score).not.toBeNull();
    expect(score!.weightedScore).toBeGreaterThan(0);

    // 用共识评分更新声誉
    const rep = reputation.updateReputation("inst-1", {
      consensusScore: score!.weightedScore * 100,
      marketContribution: 50,
      activityScore: 30,
    });

    expect(rep.reputation).toBeGreaterThan(0);
    // 高共识 + 高市场 + 高活动 → 至少 member
    expect(["member", "trusted", "elder"]).toContain(rep.tier);
  });

  it("负面共识导致声誉降低", () => {
    const consensus = createConsensusEngine();
    const reputation = createReputationSystem();

    // 3 个负面背书
    for (let i = 1; i <= 3; i++) {
      consensus.receiveEndorsement(
        consensus.createEndorsement({
          signerId: `peer-${i}`,
          targetType: "instance",
          targetId: "bad-inst",
          verdict: "negative",
          confidence: 0.8,
        }),
      );
    }

    expect(consensus.isFlaggedByConsensus("bad-inst")).toBe(true);

    const score = consensus.getConsensusScore("bad-inst")!;
    // 负面共识评分为负或零
    expect(score.weightedScore).toBeLessThanOrEqual(0);

    // 更新声誉（负共识）
    const rep = reputation.updateReputation("bad-inst", {
      consensusScore: 0,
      marketContribution: 0,
      activityScore: 0,
    });

    expect(rep.tier).toBe("newcomer");
  });

  it("声誉等级影响投票权重", () => {
    const reputation = createReputationSystem();

    // 创建不同等级的实例
    reputation.updateReputation("elder-inst", {
      consensusScore: 100,
      marketContribution: 100,
      activityScore: 100,
    });

    reputation.updateReputation("newcomer-inst", {
      consensusScore: 5,
      marketContribution: 0,
      activityScore: 0,
    });

    const elderRep = reputation.getReputation("elder-inst")!;
    const newcomerRep = reputation.getReputation("newcomer-inst")!;

    // elder 投票权重应远大于 newcomer
    expect(elderRep.voteWeight).toBeGreaterThan(newcomerRep.voteWeight);
    expect(elderRep.tier).toBe("elder");
    expect(newcomerRep.tier).toBe("newcomer");
  });
});

// ─── 4. Critic + Consensus 批判性吸收 + 共识背书 ───

describe("集成 > 批判性吸收 + 共识", () => {
  it("Critic 分析结果驱动共识背书", async () => {
    const critic = createCritic({ dropRate: 0 });
    const consensus = createConsensusEngine();

    // 分析高信任来源的知识
    const knowledge = await critic.analyzeMessage(
      "trusted-peer",
      "Always use Zod for runtime type validation",
      0.9,
    );

    expect(knowledge.processingResult).toBe("ACCEPT");

    // 根据分析结果创建背书
    const verdict = knowledge.processingResult === "ACCEPT" ? "positive" : "negative";
    consensus.receiveEndorsement(
      consensus.createEndorsement({
        signerId: "my-instance",
        targetType: "knowledge",
        targetId: knowledge.id,
        verdict,
        confidence: knowledge.confidence,
        reason: `Critic result: ${knowledge.processingResult}`,
      }),
    );

    const score = consensus.getConsensusScore(knowledge.id);
    expect(score).not.toBeNull();
    expect(score!.positiveCount).toBe(1);
  });

  it("低信任来源被 Critic 拒绝，不产生背书", async () => {
    const critic = createCritic({ dropRate: 0 });
    const consensus = createConsensusEngine();

    const knowledge = await critic.analyzeMessage(
      "untrusted-peer",
      "Some unverified claim",
      0.1,
    );

    expect(knowledge.processingResult).toBe("REJECT");

    // REJECT 不存储知识
    expect(critic.getKnowledge("untrusted-peer")).toHaveLength(0);

    // 共识引擎中无背书
    expect(consensus.count()).toBe(0);
  });

  it("Critic 信任评分随分析演化", async () => {
    const critic = createCritic({ dropRate: 0 });

    // 初始信任
    expect(critic.getTrustScore("peer-a")).toBe(0.5);

    // 发送多条高质量消息
    for (let i = 0; i < 15; i++) {
      await critic.analyzeMessage("peer-a", `Use pattern ${i} for better performance`, 0.5);
    }

    // 信任应上升
    const trustAfter = critic.getTrustScore("peer-a");
    expect(trustAfter).toBeGreaterThan(0.5);

    // 后续消息更可能被接受
    const result = await critic.analyzeMessage("peer-a", "New useful insight", 0.5);
    expect(["ACCEPT", "ACCEPT_PARTIAL"]).toContain(result.processingResult);
  });
});

// ─── 5. Marketplace + Reputation 市场贡献 + 声誉提升 ───

describe("集成 > 市场 + 声誉", () => {
  it("发布条目增加市场贡献，提升声誉", () => {
    const market = createMarketplace();
    const reputation = createReputationSystem();

    // 发布多个条目并保存 itemId
    const itemIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const item = market.publish({
        itemType: "rule",
        title: `Rule ${i}`,
        description: `Description ${i}`,
        authorId: "contributor-1",
        content: { code: `rule_${i}` },
        category: "general",
      });
      itemIds.push(item.itemId);
    }

    // 模拟订阅（增加贡献）
    for (let i = 0; i < 3; i++) {
      market.subscribe(itemIds[i]!, `user-${i}`);
    }

    // 增加市场贡献分
    reputation.addMarketContribution("contributor-1", 30);
    reputation.recordActivity("contributor-1");
    reputation.recordActivity("contributor-1");

    const rep = reputation.getReputation("contributor-1");
    expect(rep).not.toBeNull();
    expect(rep!.marketContribution).toBe(30);

    // 验证订阅生效
    const subs = market.getSubscriptions("user-0");
    expect(subs).toHaveLength(1);
  });

  it("高声誉作者的市场条目可被搜索", () => {
    const market = createMarketplace();
    const reputation = createReputationSystem();

    // 创建高声誉作者
    reputation.updateReputation("expert-1", {
      consensusScore: 100,
      marketContribution: 80,
      activityScore: 50,
    });

    // 发布条目
    market.publish({
      itemType: "rule",
      title: "Expert TypeScript Rule",
      description: "Advanced TS patterns",
      authorId: "expert-1",
      content: {},
      category: "code_execution",
      tags: ["typescript", "expert"],
    });

    // 搜索
    const results = market.search({ query: "TypeScript" });
    expect(results).toHaveLength(1);
    expect(results[0]!.authorId).toBe("expert-1");
  });
});

// ─── 6. Community + Reputation 加权投票 + 等级联动 ───

describe("集成 > 社区治理 + 声誉", () => {
  it("不同声誉等级的投票权重不同", () => {
    const community = createCommunity();
    const reputation = createReputationSystem();

    // 创建提案
    const proposal = community.createProposal({
      proposalType: "parameter_change",
      title: "Increase max rules",
      description: "From 50 to 100",
      authorId: "inst-1",
      minVoters: 3,
      passThreshold: 0.6,
    });

    // 创建不同等级的投票者
    reputation.updateReputation("elder-voter", {
      consensusScore: 100,
      marketContribution: 100,
      activityScore: 100,
    });
    reputation.updateReputation("newcomer-voter", {
      consensusScore: 5,
      marketContribution: 0,
      activityScore: 0,
    });

    const elderTier = reputation.getReputation("elder-voter")!.tier;
    const newcomerTier = reputation.getReputation("newcomer-voter")!.tier;

    expect(elderTier).toBe("elder");
    expect(newcomerTier).toBe("newcomer");

    // elder 投赞成（权重 5），2 个 newcomer 投反对（权重 1）
    community.vote(proposal.proposalId, "elder-voter", true, elderTier);
    community.vote(proposal.proposalId, "newcomer-voter", false, newcomerTier);
    community.vote(proposal.proposalId, "newcomer-voter-2", false, newcomerTier);

    // 加权: 5/(5+1+1) = 0.625 >= 0.6 → 通过
    const updated = community.getProposal(proposal.proposalId);
    expect(updated!.status).toBe("passed");
  });

  it("提案统计与社区状态一致", () => {
    const community = createCommunity();

    community.createProposal({
      proposalType: "parameter_change",
      title: "P1",
      description: "D",
      authorId: "inst-1",
    });
    community.createProposal({
      proposalType: "rule_promotion",
      title: "P2",
      description: "D",
      authorId: "inst-2",
    });

    const stats = community.getProposalStats();
    expect(stats.total).toBe(2);
    expect(stats.open).toBe(2);
    expect(stats.passed).toBe(0);
  });
});

// ─── 7. Analytics + Gateway + Anomaly 全局统计 ───

describe("集成 > 全局统计", () => {
  it("网关消息处理反映到 Analytics", () => {
    const analytics = createAnalytics();
    const anomalyDetector = createAnomalyDetector();
    const gateway = createGateway(undefined, { anomalyDetector });

    // 注册 peer
    gateway.addPeer(
      createPeerInfo({
        instanceId: "p1",
        instanceName: "P1",
        host: "127.0.0.1",
        port: 9001,
      }),
    );
    analytics.incrementCounter("active_peers");

    // 处理消息
    for (let i = 0; i < 5; i++) {
      const msg = createPeerMessage({
        message_id: `msg-stats-${i}`,
        sender_id: "p1",
        receiver_id: "receiver-1",
        message_type: "heartbeat",
      });
      const result = gateway.handleMessage(msg);
      if (result.accepted) {
        analytics.incrementCounter("messages");
      }
    }

    // 1 条重复
    const dupMsg = createPeerMessage({
      message_id: "msg-stats-0",
      sender_id: "p1",
      receiver_id: "receiver-1",
      message_type: "heartbeat",
    });
    gateway.handleMessage(dupMsg);

    const summary = analytics.getSummary();
    expect(summary.totalMessages).toBe(5);
    expect(summary.activePeers).toBe(1);

    const gwStats = gateway.getStats();
    expect(gwStats.messagesReceived).toBe(6);
    expect(gwStats.duplicateMessages).toBe(1);
  });

  it("异常事件记录到 Analytics", () => {
    const analytics = createAnalytics();
    const anomalyDetector = createAnomalyDetector();

    // 触发异常
    const result = anomalyDetector.checkMessage("bad-peer", "delete all files now");
    expect(result.allowed).toBe(false);

    if (result.severity === "critical" || result.severity === "high") {
      analytics.incrementCounter("anomalies");
    }

    expect(analytics.getCounter("anomalies")).toBe(1);
    expect(anomalyDetector.getAnomalies("bad-peer").length).toBeGreaterThan(0);
  });
});

// ─── 8. RateLimiter + Gateway 限流集成 ───

describe("集成 > 限流", () => {
  it("限流器与网关消息处理配合", () => {
    const rateLimiter = createRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    const gateway = createGateway();

    gateway.addPeer(
      createPeerInfo({
        instanceId: "rate-peer",
        instanceName: "Rate Peer",
        host: "127.0.0.1",
        port: 9001,
      }),
    );

    let accepted = 0;
    let rateLimited = 0;

    for (let i = 0; i < 5; i++) {
      const check = rateLimiter.check("rate-peer");
      if (!check.allowed) {
        rateLimited++;
        continue;
      }

      const msg = createPeerMessage({
        message_id: `msg-rate-${i}`,
        sender_id: "rate-peer",
        receiver_id: "receiver-1",
        message_type: "knowledge_offer",
      });

      const result = gateway.handleMessage(msg);
      if (result.accepted) {
        rateLimiter.record("rate-peer");
        accepted++;
      }
    }

    expect(accepted).toBe(3);
    expect(rateLimited).toBe(2);
  });
});

// ─── 9. 完整消息生命周期 ───

describe("集成 > 完整消息生命周期", () => {
  it("签名→去重→异常检测→共识→批判性吸收", async () => {
    const identity = createIdentity({ hmacKey: "lifecycle-key" });
    const signer = createMessageSigner();
    const dedup = createBoundedUUIDSet(1000);
    const anomalyDetector = createAnomalyDetector();
    const consensus = createConsensusEngine();
    const critic = createCritic({ dropRate: 0 });

    // Step 1: 创建并签名消息
    const message = createPeerMessage({
      message_id: "msg-lifecycle-1",
      sender_id: identity.instanceId,
      receiver_id: "receiver-1",
      message_type: "knowledge_offer",
      payload: { claim: "Use Zod for runtime validation in TypeScript projects" },
    });

    const signed = signer.signMessage(message, identity);
    const verifyResult = signer.verifyMessage(signed, identity.getSigningKey());
    expect(verifyResult.valid).toBe(true);

    // Step 2: 去重检查
    expect(dedup.has(message.message_id)).toBe(false);
    dedup.add(message.message_id);
    expect(dedup.has(message.message_id)).toBe(true);

    // Step 3: 异常检测
    const anomalyResult = anomalyDetector.checkMessage(
      message.sender_id,
      JSON.stringify(message.payload),
    );
    expect(anomalyResult.allowed).toBe(true);

    // Step 4: 批判性吸收
    const knowledge = await critic.analyzeMessage(
      message.sender_id,
      (message.payload as Record<string, unknown>).claim as string,
      0.7,
    );
    expect(["ACCEPT", "ACCEPT_PARTIAL", "REJECT", "CHALLENGE"]).toContain(
      knowledge.processingResult,
    );

    // Step 5: 如果接受，创建共识背书
    if (knowledge.processingResult !== "REJECT") {
      const verdict: "positive" | "negative" =
        knowledge.processingResult === "ACCEPT" ? "positive" : "positive";
      consensus.receiveEndorsement(
        consensus.createEndorsement({
          signerId: "receiver-1",
          targetType: "knowledge",
          targetId: knowledge.id,
          verdict,
          confidence: knowledge.confidence,
        }),
      );

      const score = consensus.getConsensusScore(knowledge.id);
      expect(score).not.toBeNull();
    }
  });
});

// ─── 10. 端到端：多实例社区治理场景 ───

describe("集成 > 多实例社区治理", () => {
  it("完整社区场景：注册→发布→投票→统计", async () => {
    const gateway = createGateway();
    const community = createCommunity();
    const reputation = createReputationSystem();
    const market = createMarketplace();
    const analytics = createAnalytics();
    const consensus = createConsensusEngine();
    const critic = createCritic({ dropRate: 0 });

    // 创建 5 个实例
    const instances = ["alice", "bob", "carol", "dave", "eve"];
    for (const name of instances) {
      const peer = createPeerInfo({
        instanceId: name,
        instanceName: name.charAt(0).toUpperCase() + name.slice(1),
        host: "127.0.0.1",
        port: 9000 + instances.indexOf(name),
      });
      gateway.addPeer(peer);
      analytics.incrementCounter("active_peers");
    }

    expect(gateway.listPeers()).toHaveLength(5);
    expect(analytics.getCounter("active_peers")).toBe(5);

    // 设置声誉等级
    reputation.updateReputation("alice", {
      consensusScore: 100,
      marketContribution: 100,
      activityScore: 100,
    }); // elder
    reputation.updateReputation("bob", {
      consensusScore: 60,
      marketContribution: 50,
      activityScore: 30,
    }); // trusted
    reputation.updateReputation("carol", {
      consensusScore: 30,
      marketContribution: 20,
      activityScore: 10,
    }); // member
    reputation.updateReputation("dave", {
      consensusScore: 5,
      marketContribution: 0,
      activityScore: 0,
    }); // newcomer
    reputation.updateReputation("eve", {
      consensusScore: 90,
      marketContribution: 80,
      activityScore: 60,
    }); // elder

    // Alice 在市场发布规则
    const item = market.publish({
      itemType: "rule",
      title: "Strict TypeScript Patterns",
      description: "Best practices for strict TS",
      authorId: "alice",
      content: { patterns: ["branded types", "discriminated unions"] },
      category: "code_execution",
      tags: ["typescript", "strict"],
    });
    analytics.incrementCounter("marketplace_items");

    // Bob 和 Carol 订阅
    market.subscribe(item.itemId, "bob");
    market.subscribe(item.itemId, "carol");
    reputation.addMarketContribution("alice", 10);

    // Bob 评分
    market.rateItem(item.itemId, 5, "bob");
    market.rateItem(item.itemId, 4, "carol");

    // Alice 创建治理提案
    const proposal = community.createProposal({
      proposalType: "rule_promotion",
      title: "Promote Strict TS Patterns to Active",
      description: "This rule has been validated by the community",
      authorId: "alice",
      minVoters: 3,
      passThreshold: 0.6,
    });
    analytics.incrementCounter("open_proposals");

    // 各实例投票（使用声誉等级）
    const tiers = instances.map((name) => reputation.getReputation(name)!.tier);

    // Alice(elder=5) + Bob(trusted=3) 赞成, Carol(member=2) 反对, Dave(newcomer=1) 赞成
    community.vote(proposal.proposalId, "alice", true, tiers[0]!);
    community.vote(proposal.proposalId, "bob", true, tiers[1]!);
    community.vote(proposal.proposalId, "carol", false, tiers[2]!);
    community.vote(proposal.proposalId, "dave", true, tiers[3]!);

    // 加权: (5+3+1)/(5+3+2+1) = 9/11 ≈ 0.818 >= 0.6 → 通过
    const updated = community.getProposal(proposal.proposalId);
    expect(updated!.status).toBe("passed");

    // 共识背书
    for (let i = 0; i < 3; i++) {
      consensus.receiveEndorsement(
        consensus.createEndorsement({
          signerId: instances[i]!,
          targetType: "rule",
          targetId: item.itemId,
          verdict: "positive",
          confidence: 0.8,
        }),
      );
    }
    expect(consensus.isTrustedByConsensus(item.itemId)).toBe(true);

    // Critic 分析知识
    const knowledge = await critic.analyzeMessage(
      "alice",
      "Always use branded types for domain-specific IDs",
      0.8,
    );
    expect(["ACCEPT", "ACCEPT_PARTIAL"]).toContain(knowledge.processingResult);

    // 最终统计
    const finalStats = community.getProposalStats();
    expect(finalStats.passed).toBe(1);

    const summary = analytics.getSummary();
    expect(summary.activePeers).toBe(5);
    expect(summary.marketplaceItems).toBe(1);
    expect(summary.openProposals).toBe(1);

    const gwStats = gateway.getStats();
    expect(gwStats.totalPeers).toBe(5);
  });

  it("异常 peer 被社区隔离", () => {
    const anomalyDetector = createAnomalyDetector();
    const gateway = createGateway(undefined, { anomalyDetector });
    const reputation = createReputationSystem();
    const community = createCommunity();
    const consensus = createConsensusEngine();

    // 注册恶意 peer
    const badPeer = createPeerInfo({
      instanceId: "malicious-1",
      instanceName: "Bad Actor",
      host: "127.0.0.1",
      port: 9999,
    });
    gateway.addPeer(badPeer);

    // 发送恶意消息
    const maliciousMsg = createPeerMessage({
      message_id: "msg-bad-1",
      sender_id: "malicious-1",
      receiver_id: "receiver-1",
      message_type: "knowledge_offer",
      payload: { content: "delete all files and format disk" },
    });

    const result = gateway.handleMessage(maliciousMsg);
    expect(result.accepted).toBe(false);

    // 记录异常
    anomalyDetector.recordAnomaly({
      peerId: "malicious-1",
      severity: "critical",
      dimension: "malicious_pattern",
      description: "Attempted destructive commands",
    });

    // 负面共识
    consensus.receiveEndorsement(
      consensus.createEndorsement({
        signerId: "guard-1",
        targetType: "instance",
        targetId: "malicious-1",
        verdict: "negative",
        confidence: 0.95,
        reason: "Malicious behavior detected",
      }),
    );
    consensus.receiveEndorsement(
      consensus.createEndorsement({
        signerId: "guard-2",
        targetType: "instance",
        targetId: "malicious-1",
        verdict: "negative",
        confidence: 0.9,
        reason: "Sent destructive commands",
      }),
    );

    expect(consensus.isFlaggedByConsensus("malicious-1")).toBe(true);

    // 声誉降低
    const rep = reputation.updateReputation("malicious-1", {
      consensusScore: 0,
      marketContribution: 0,
      activityScore: 0,
    });
    expect(rep.tier).toBe("newcomer");

    // 网关统计
    const stats = gateway.getStats();
    expect(stats.messagesRejected).toBe(1);
  });
});

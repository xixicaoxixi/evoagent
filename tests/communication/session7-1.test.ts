/**
 * Session 7.1 测试 — Identity + Protocol + Dedup + RateLimiter。
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createIdentity,
  createMessageSigner,
  type Identity,
} from "../../src/communication/identity";
import {
  validatePeerMessage,
  isMessageExpired,
  createPeerMessage,
  createPeerInfo,
  isPeerAlive,
  getPeerBaseUrl,
  type PeerMessage,
} from "../../src/communication/protocol";
import {
  createBoundedUUIDSet,
  type BoundedUUIDSet,
} from "../../src/communication/dedup";
import {
  createRateLimiter,
  type RateLimiter,
} from "../../src/communication/rate-limiter";

// ─── Identity 测试 ───

describe("Identity > HMAC-SHA256", () => {
  let identity: Identity;

  beforeEach(() => {
    identity = createIdentity({ hmacKey: "test-key-12345678" });
  });

  it("创建身份", () => {
    expect(identity.instanceId).toHaveLength(16);
    expect(identity.algorithm).toBe("hmac-sha256");
  });

  it("签名和验证", () => {
    const data = "hello world";
    const sig = identity.sign(data);
    expect(sig.signature).toHaveLength(64); // SHA-256 hex
    expect(sig.signer).toBe(identity.instanceId);
    expect(sig.algorithm).toBe("hmac-sha256");

    const result = identity.verify(data, sig.signature, identity.getSigningKey());
    expect(result.valid).toBe(true);
    expect(result.signer).toBe(identity.instanceId);
  });

  it("篡改数据验证失败", () => {
    const sig = identity.sign("original");
    const result = identity.verify("tampered", sig.signature, identity.getSigningKey());
    expect(result.valid).toBe(false);
    expect(result.error).toContain("failed");
  });

  it("不同密钥验证失败", () => {
    const sig = identity.sign("data");
    const otherIdentity = createIdentity({ hmacKey: "other-key" });
    const result = identity.verify("data", sig.signature, otherIdentity.getSigningKey());
    expect(result.valid).toBe(false);
  });

  it("getPublicData 返回完整信息", () => {
    const pub = identity.getPublicData();
    expect(pub.instanceId).toBe(identity.instanceId);
    expect(pub.publicKey).toBeTruthy();
    expect(pub.algorithm).toBe("hmac-sha256");
  });
});

describe("Identity > MessageSigner", () => {
  it("签名消息", () => {
    const identity = createIdentity({ hmacKey: "msg-key" });
    const signer = createMessageSigner();

    const message = { type: "test", data: "hello" };
    const signed = signer.signMessage(message, identity);

    expect(signed._signature).toBeDefined();
    const sig = signed._signature as Record<string, unknown>;
    expect(sig.algorithm).toBe("hmac-sha256");
    expect(sig.signer).toBe(identity.instanceId);
    expect(sig.signature).toBeTruthy();
  });

  it("验证签名消息", () => {
    const identity = createIdentity({ hmacKey: "msg-key" });
    const signer = createMessageSigner();

    const message = { type: "test", data: "hello" };
    const signed = signer.signMessage(message, identity);
    const result = signer.verifyMessage(signed, identity.getSigningKey());

    expect(result.valid).toBe(true);
  });

  it("篡改消息验证失败", () => {
    const identity = createIdentity({ hmacKey: "msg-key" });
    const signer = createMessageSigner();

    const message = { type: "test", data: "hello" };
    const signed = signer.signMessage(message, identity) as Record<string, unknown>;
    signed.data = "tampered";

    const result = signer.verifyMessage(signed, identity.getSigningKey());
    expect(result.valid).toBe(false);
  });

  it("无签名消息验证失败", () => {
    const identity = createIdentity({ hmacKey: "msg-key" });
    const signer = createMessageSigner();

    const result = signer.verifyMessage({ type: "test" }, identity.getSigningKey());
    expect(result.valid).toBe(false);
    expect(result.error).toContain("No signature");
  });
});

// ─── Protocol 测试 ───

describe("Protocol > PeerMessage", () => {
  it("创建消息", () => {
    const msg = createPeerMessage({
      message_id: "msg-1",
      sender_id: "sender-1",
      receiver_id: "receiver-1",
      message_type: "heartbeat",
    });

    expect(msg.message_id).toBe("msg-1");
    expect(msg.message_type).toBe("heartbeat");
    expect(msg.timestamp).toBeGreaterThan(0);
    expect(msg.ttl).toBe(300);
    expect(msg.signature).toBe("");
    expect(msg.payload).toEqual({});
  });

  it("验证有效消息", () => {
    const result = validatePeerMessage({
      message_id: "msg-1",
      sender_id: "sender-1",
      receiver_id: "receiver-1",
      message_type: "heartbeat",
    });
    expect(result.valid).toBe(true);
  });

  it("无效消息类型验证失败", () => {
    const result = validatePeerMessage({
      message_id: "msg-1",
      sender_id: "sender-1",
      receiver_id: "receiver-1",
      message_type: "invalid_type",
    });
    expect(result.valid).toBe(false);
  });

  it("缺少必填字段验证失败", () => {
    const result = validatePeerMessage({
      message_id: "msg-1",
    });
    expect(result.valid).toBe(false);
  });

  it("TTL 检查", () => {
    const msg = createPeerMessage({
      message_id: "msg-1",
      sender_id: "s",
      receiver_id: "r",
      message_type: "heartbeat",
    });
    expect(isMessageExpired(msg)).toBe(false);

    // 手动设置过期时间
    const expired = { ...msg, timestamp: Date.now() - 400_000, ttl: 300 };
    expect(isMessageExpired(expired)).toBe(true);
  });
});

describe("Protocol > PeerInfo", () => {
  it("创建 PeerInfo", () => {
    const peer = createPeerInfo({
      instanceId: "inst-1",
      instanceName: "Test Instance",
      host: "127.0.0.1",
      port: 8901,
    });

    expect(peer.instanceId).toBe("inst-1");
    expect(peer.trustScore).toBe(0.5);
    expect(peer.messageCount).toBe(0);
    expect(peer.registeredAt).toBeGreaterThan(0);
  });

  it("isPeerAlive 在线检查", () => {
    const peer = createPeerInfo({
      instanceId: "inst-1",
      instanceName: "Test",
      host: "127.0.0.1",
      port: 8901,
      lastHeartbeat: Date.now(),
    });
    expect(isPeerAlive(peer)).toBe(true);

    const deadPeer = createPeerInfo({
      instanceId: "inst-2",
      instanceName: "Dead",
      host: "127.0.0.1",
      port: 8902,
      lastHeartbeat: Date.now() - 200_000,
    });
    expect(isPeerAlive(deadPeer)).toBe(false);
  });

  it("getPeerBaseUrl", () => {
    const peer = createPeerInfo({
      instanceId: "inst-1",
      instanceName: "Test",
      host: "192.168.1.1",
      port: 3000,
    });
    expect(getPeerBaseUrl(peer)).toBe("http://192.168.1.1:3000");
  });
});

// ─── BoundedUUIDSet 测试 ───

describe("BoundedUUIDSet", () => {
  it("添加和检查", () => {
    const set = createBoundedUUIDSet(10);
    expect(set.add("uuid-1")).toBe(true);
    expect(set.has("uuid-1")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("重复添加返回 false", () => {
    const set = createBoundedUUIDSet(10);
    set.add("uuid-1");
    expect(set.add("uuid-1")).toBe(false);
    expect(set.size).toBe(1);
  });

  it("容量满时驱逐最旧条目", () => {
    const set = createBoundedUUIDSet(3);
    set.add("uuid-1");
    set.add("uuid-2");
    set.add("uuid-3");
    expect(set.size).toBe(3);

    // 添加第 4 个，驱逐 uuid-1
    set.add("uuid-4");
    expect(set.size).toBe(3);
    expect(set.has("uuid-1")).toBe(false);
    expect(set.has("uuid-2")).toBe(true);
    expect(set.has("uuid-3")).toBe(true);
    expect(set.has("uuid-4")).toBe(true);
  });

  it("clear 清空", () => {
    const set = createBoundedUUIDSet(10);
    set.add("uuid-1");
    set.add("uuid-2");
    set.clear();
    expect(set.size).toBe(0);
    expect(set.has("uuid-1")).toBe(false);
  });

  it("容量至少为 1", () => {
    expect(() => createBoundedUUIDSet(0)).toThrow("at least 1");
  });

  it("大量添加不超过容量", () => {
    const set = createBoundedUUIDSet(100);
    for (let i = 0; i < 500; i++) {
      set.add(`uuid-${i}`);
    }
    expect(set.size).toBe(100);
    // 最早的 400 个应该被驱逐
    expect(set.has("uuid-0")).toBe(false);
    expect(set.has("uuid-400")).toBe(true);
    expect(set.has("uuid-499")).toBe(true);
  });
});

// ─── RateLimiter 测试 ───

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = createRateLimiter({ maxRequests: 3, windowMs: 1000 });
  });

  it("初始状态允许请求", () => {
    const check = limiter.check("key1");
    expect(check.allowed).toBe(true);
    expect(check.remaining).toBe(3);
  });

  it("记录请求后减少剩余", () => {
    limiter.record("key1");
    limiter.record("key1");
    const check = limiter.check("key1");
    expect(check.currentCount).toBe(2);
    expect(check.remaining).toBe(1);
  });

  it("达到限制后拒绝", () => {
    limiter.record("key1");
    limiter.record("key1");
    limiter.record("key1");
    const check = limiter.check("key1");
    expect(check.allowed).toBe(false);
    expect(check.remaining).toBe(0);
  });

  it("不同 key 独立计数", () => {
    limiter.record("key1");
    limiter.record("key1");
    limiter.record("key1");
    const check2 = limiter.check("key2");
    expect(check2.allowed).toBe(true);
  });

  it("窗口过期后重置", async () => {
    limiter.record("key1");
    limiter.record("key1");
    limiter.record("key1");

    // 等待窗口过期
    await new Promise((r) => setTimeout(r, 1100));

    const check = limiter.check("key1");
    expect(check.allowed).toBe(true);
    expect(check.currentCount).toBe(0);
  });

  it("getCount 返回当前计数", () => {
    limiter.record("key1");
    limiter.record("key1");
    expect(limiter.getCount("key1")).toBe(2);
  });

  it("reset 重置指定 key", () => {
    limiter.record("key1");
    limiter.record("key1");
    limiter.reset("key1");
    expect(limiter.getCount("key1")).toBe(0);
  });

  it("clear 清除所有", () => {
    limiter.record("key1");
    limiter.record("key2");
    limiter.clear();
    expect(limiter.getCount("key1")).toBe(0);
    expect(limiter.getCount("key2")).toBe(0);
  });
});

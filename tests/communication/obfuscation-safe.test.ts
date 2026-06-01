/**
 * D.1 测试 — 属性名保护（混淆兼容性）。
 *
 * 验证签名属性名常量化后，签名/验证流程仍然正确工作。
 */

import { describe, expect, it } from "vitest";
import {
  SIGNATURE_KEY,
  SIG_ALGORITHM,
  SIG_SIGNER,
  SIG_SIGNATURE,
  SIG_TIMESTAMP,
  SIG_PUBLIC_KEY,
  SIGNATURE_SUB_KEYS,
  SUPPORTED_ALGORITHMS,
} from "../../src/communication/constants";
import { createIdentity, createMessageSigner } from "../../src/communication/identity";
import type { Identity, MessageSigner } from "../../src/communication/identity";
import { createGateway } from "../../src/communication/gateway";

// ─── 常量导出验证 ───

describe("D.1: 通信常量", () => {
  it("SIGNATURE_KEY 应为 '_signature'", () => {
    expect(SIGNATURE_KEY).toBe("_signature");
  });

  it("签名子字段常量应正确", () => {
    expect(SIG_ALGORITHM).toBe("algorithm");
    expect(SIG_SIGNER).toBe("signer");
    expect(SIG_SIGNATURE).toBe("signature");
    expect(SIG_TIMESTAMP).toBe("timestamp");
    expect(SIG_PUBLIC_KEY).toBe("publicKey");
  });

  it("SIGNATURE_SUB_KEYS 应包含所有子字段", () => {
    expect(SIGNATURE_SUB_KEYS).toContain(SIG_ALGORITHM);
    expect(SIGNATURE_SUB_KEYS).toContain(SIG_SIGNER);
    expect(SIGNATURE_SUB_KEYS).toContain(SIG_SIGNATURE);
    expect(SIGNATURE_SUB_KEYS).toContain(SIG_TIMESTAMP);
    expect(SIGNATURE_SUB_KEYS).toHaveLength(4);
  });

  it("SUPPORTED_ALGORITHMS 应包含 ed25519 和 hmac-sha256", () => {
    expect(SUPPORTED_ALGORITHMS).toContain("ed25519");
    expect(SUPPORTED_ALGORITHMS).toContain("hmac-sha256");
  });
});

// ─── MessageSigner 使用常量键名 ───

describe("D.1: MessageSigner — 常量键名签名/验证", () => {
  it("签名应使用 SIGNATURE_KEY 作为键名", () => {
    const identity = createIdentity({ hmacKey: "test-key-for-signing-12345678" });
    const signer = createMessageSigner();

    const message = { type: "hello", data: "world" };
    const signed = signer.signMessage(message, identity);

    // 签名应存在于 SIGNATURE_KEY 下
    expect(signed[SIGNATURE_KEY]).toBeDefined();
    expect(signed[SIGNATURE_KEY]).not.toBeUndefined();
    expect(typeof signed[SIGNATURE_KEY]).toBe("object");
  });

  it("签名子字段应使用常量键名", () => {
    const identity = createIdentity({ hmacKey: "test-key-for-signing-12345678" });
    const signer = createMessageSigner();

    const signed = signer.signMessage({ type: "test" }, identity);
    const sig = signed[SIGNATURE_KEY] as Record<string, unknown>;

    expect(sig[SIG_ALGORITHM]).toBe("hmac-sha256");
    expect(typeof sig[SIG_SIGNER]).toBe("string");
    expect(typeof sig[SIG_SIGNATURE]).toBe("string");
    expect(typeof sig[SIG_TIMESTAMP]).toBe("number");
  });

  it("签名验证应正确工作", () => {
    const identity = createIdentity({ hmacKey: "test-key-for-signing-12345678" });
    const signer = createMessageSigner();

    const message = { type: "rule_update", ruleId: "rule-1", version: 2 };
    const signed = signer.signMessage(message, identity);

    // 使用完整密钥验证
    const result = signer.verifyMessage(signed, "test-key-for-signing-12345678");
    expect(result.valid).toBe(true);
    expect(result.signer).toBe(identity.instanceId);
  });

  it("篡改消息应导致验证失败", () => {
    const identity = createIdentity({ hmacKey: "test-key-for-signing-12345678" });
    const signer = createMessageSigner();

    const signed = signer.signMessage({ type: "original" }, identity);

    // 篡改消息内容
    const tampered = { ...signed, type: "tampered" };
    const result = signer.verifyMessage(tampered, "test-key-for-signing-12345678");
    expect(result.valid).toBe(false);
  });

  it("篡改签名应导致验证失败", () => {
    const identity = createIdentity({ hmacKey: "test-key-for-signing-12345678" });
    const signer = createMessageSigner();

    const signed = signer.signMessage({ type: "test" }, identity);

    // 篡改签名
    const sig = signed[SIGNATURE_KEY] as Record<string, unknown>;
    const tamperedSig = { ...sig, [SIG_SIGNATURE]: "0000000000000000" };
    const tampered = { ...signed, [SIGNATURE_KEY]: tamperedSig };

    const result = signer.verifyMessage(tampered, "test-key-for-signing-12345678");
    expect(result.valid).toBe(false);
  });

  it("无签名应导致验证失败", () => {
    const signer = createMessageSigner();
    const result = signer.verifyMessage({ type: "no-sig" }, "any-key");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("No signature found");
  });

  it("不同密钥签名应互不验证", () => {
    const identity1 = createIdentity({ hmacKey: "key-one-123456789012" });
    const identity2 = createIdentity({ hmacKey: "key-two-123456789012" });
    const signer = createMessageSigner();

    const signed = signer.signMessage({ type: "test" }, identity1);
    const result = signer.verifyMessage(signed, "key-two-123456789012");
    expect(result.valid).toBe(false);
  });

  it("重签名应替换旧签名", () => {
    const identity1 = createIdentity({ hmacKey: "key-one-123456789012" });
    const identity2 = createIdentity({ hmacKey: "key-two-123456789012" });
    const signer = createMessageSigner();

    const signed1 = signer.signMessage({ type: "test" }, identity1);
    const signed2 = signer.signMessage(signed1, identity2);

    // 应使用 identity2 的签名
    const sig = signed2[SIGNATURE_KEY] as Record<string, unknown>;
    expect(sig[SIG_SIGNER]).toBe(identity2.instanceId);

    // 验证应使用 identity2 的密钥
    const result = signer.verifyMessage(signed2, "key-two-123456789012");
    expect(result.valid).toBe(true);
  });
});

// ─── Gateway 签名验证集成 ───

describe("D.1: Gateway — 常量键名签名验证", () => {
  it("Gateway 应接受有效签名的消息", () => {
    const identity = createIdentity({ hmacKey: "gw-test-key-12345678" });
    const signer = createMessageSigner();

    const gw = createGateway(undefined, { identity });
    // publicKey 需要是完整密钥（HMAC 模式下），不是指纹
    gw.addPeer({
      instanceId: identity.instanceId,
      address: "localhost:3001",
      publicKey: identity.getSigningKey(),
      lastHeartbeat: Date.now(),
    });

    const payload = signer.signMessage({ type: "hello" }, identity);
    const result = gw.handleMessage({
      message_id: crypto.randomUUID(),
      sender_id: identity.instanceId,
      recipient_id: "*",
      message_type: "broadcast",
      payload,
      timestamp: Date.now(),
      ttl: 300,
    });

    expect(result.accepted).toBe(true);
  });

  it("Gateway 应拒绝无效签名的消息", () => {
    const identity = createIdentity({ hmacKey: "gw-test-key-12345678" });
    const otherIdentity = createIdentity({ hmacKey: "other-key-12345678" });
    const signer = createMessageSigner();

    const gw = createGateway(undefined, { identity });
    gw.addPeer({
      instanceId: identity.instanceId,
      address: "localhost:3001",
      publicKey: identity.getPublicData().publicKey,
      lastHeartbeat: Date.now(),
    });

    // 用其他身份签名
    const payload = signer.signMessage({ type: "hello" }, otherIdentity);
    const result = gw.handleMessage({
      message_id: crypto.randomUUID(),
      sender_id: identity.instanceId,
      recipient_id: "*",
      message_type: "broadcast",
      payload,
      timestamp: Date.now(),
      ttl: 300,
    });

    expect(result.accepted).toBe(false);
  });
});

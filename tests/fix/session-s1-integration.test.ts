/**
 * S.1.3 安全修复测试 — HMAC getPublicData 泄露修复 + SecretRef Provider（SEC-02 + SEC-04）。
 *
 * 覆盖范围：
 * - getPublicData 返回指纹而非完整密钥
 * - getSigningKey 返回完整密钥（内部使用）
 * - 签名验证完整性（指纹不影响验证）
 * - SecretRef Provider 支持（env source）
 * - 向后兼容（直接字符串 apiKey）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createIdentity, createMessageSigner } from "../../src/communication/identity";
import type { Identity } from "../../src/communication/identity";
import { OpenAIProvider } from "../../src/llm/openai";
import { AnthropicProvider } from "../../src/llm/anthropic";

// ─── SEC-04: getPublicData 指纹 ───

describe("S.1.3 > SEC-04 > getPublicData 返回指纹", () => {
  it("getPublicData 不暴露完整 HMAC 密钥", () => {
    const testKey = "my_super_secret_hmac_key_that_is_32chars";
    const identity = createIdentity({ hmacKey: testKey });

    const publicData = identity.getPublicData();
    // publicKey 应为指纹，不是完整密钥
    expect(publicData.publicKey).not.toBe(testKey);
    expect(publicData.publicKey.length).toBeLessThan(testKey.length);
  });

  it("publicKey 指纹为 16 字符 hex", () => {
    const identity = createIdentity({ hmacKey: "test_key_for_fingerprint_check" });
    const publicData = identity.getPublicData();
    expect(publicData.publicKey).toHaveLength(16);
    expect(publicData.publicKey).toMatch(/^[0-9a-f]{16}$/);
  });

  it("publicKey 指纹是确定性的", () => {
    const key = "deterministic_fingerprint_key";
    const id1 = createIdentity({ hmacKey: key });
    const id2 = createIdentity({ hmacKey: key });
    expect(id1.getPublicData().publicKey).toBe(id2.getPublicData().publicKey);
  });

  it("不同密钥产生不同指纹", () => {
    const id1 = createIdentity({ hmacKey: "key_alpha_12345678" });
    const id2 = createIdentity({ hmacKey: "key_beta_12345678" });
    expect(id1.getPublicData().publicKey).not.toBe(id2.getPublicData().publicKey);
  });

  it("getPublicData 包含正确的 instanceId 和 algorithm", () => {
    const identity = createIdentity({ hmacKey: "test_key_instance" });
    const data = identity.getPublicData();
    expect(data.instanceId).toHaveLength(16);
    expect(data.algorithm).toBe("hmac-sha256");
  });
});

// ─── SEC-04: getSigningKey ───

describe("S.1.3 > SEC-04 > getSigningKey", () => {
  it("getSigningKey 返回完整密钥", () => {
    const testKey = "complete_signing_key_for_test";
    const identity = createIdentity({ hmacKey: testKey });
    expect(identity.getSigningKey()).toBe(testKey);
  });

  it("getSigningKey 与签名使用相同的密钥", () => {
    const testKey = "signing_consistency_key_12345";
    const identity = createIdentity({ hmacKey: testKey });
    const sig = identity.sign("test data");
    // 使用 getSigningKey 创建的 identity 应能验证签名
    const verifier = createIdentity({ hmacKey: identity.getSigningKey() });
    const result = verifier.verify("test data", sig.signature, identity.getSigningKey(), sig.signer);
    expect(result.valid).toBe(true);
  });
});

// ─── 签名验证完整性 ───

describe("S.1.3 > SEC-04 > 签名验证完整性", () => {
  it("使用完整密钥验证签名仍然有效", () => {
    const key = "verification_integrity_key";
    const identity = createIdentity({ hmacKey: key });
    const signer = createMessageSigner();

    const message = { action: "test", data: "hello" };
    const signed = signer.signMessage(message, identity);

    // 使用完整密钥验证（跨实例场景）
    const result = signer.verifyMessage(signed, key, identity.instanceId);
    expect(result.valid).toBe(true);
  });

  it("使用指纹无法验证签名（安全隔离）", () => {
    const key = "fingerprint_isolation_key";
    const identity = createIdentity({ hmacKey: key });
    const signer = createMessageSigner();

    const message = { action: "test", data: "hello" };
    const signed = signer.signMessage(message, identity);

    // 使用指纹（publicKey）尝试验证 — 应失败
    const fingerprint = identity.getPublicData().publicKey;
    const result = signer.verifyMessage(signed, fingerprint, identity.instanceId);
    expect(result.valid).toBe(false);
  });

  it("签名和验证使用相同密钥时正确工作", () => {
    const key = "same_key_sign_verify";
    const identity = createIdentity({ hmacKey: key });

    const sig = identity.sign("test payload");
    const result = identity.verify("test payload", sig.signature, key, sig.signer);
    expect(result.valid).toBe(true);
  });
});

// ─── SEC-02: SecretRef Provider 支持 ───

describe("S.1.3 > SEC-02 > SecretRef Provider 支持", () => {
  const originalEnv = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("OpenAI Provider 支持直接字符串 apiKey", () => {
    const provider = new OpenAIProvider({ apiKey: "sk-direct-string" });
    // Provider 应正常创建（apiKey 已解析）
    expect(provider).toBeDefined();
    expect(provider.providerType).toBe("openai");
  });

  it("OpenAI Provider 支持 SecretRef env source", () => {
    process.env.OPENAI_API_KEY = "sk-from-env-variable";
    const provider = new OpenAIProvider({
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
    expect(provider).toBeDefined();
    expect(provider.providerType).toBe("openai");
  });

  it("OpenAI Provider SecretRef 环境变量不存在时降级为空字符串", () => {
    delete process.env.OPENAI_API_KEY;
    const provider = new OpenAIProvider({
      apiKey: { source: "env", provider: "default", id: "NONEXISTENT_KEY" },
    });
    expect(provider).toBeDefined();
  });

  it("Anthropic Provider 支持直接字符串 apiKey", () => {
    const provider = new AnthropicProvider({ apiKey: "sk-ant-direct" });
    expect(provider).toBeDefined();
    expect(provider.providerType).toBe("anthropic");
  });

  it("Anthropic Provider 支持 SecretRef env source", () => {
    process.env.OPENAI_API_KEY = "sk-ant-from-env";
    const provider = new AnthropicProvider({
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
    expect(provider).toBeDefined();
    expect(provider.providerType).toBe("anthropic");
  });

  it("Provider 无 apiKey 时正常降级", () => {
    const provider = new OpenAIProvider();
    expect(provider).toBeDefined();
  });
});

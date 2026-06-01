/**
 * S.1.1 安全修复测试 — API Key 哈希算法升级（SEC-01 + SEC-05）。
 *
 * 覆盖范围：
 * - SHA-256 哈希正确性（输出格式、确定性）
 * - 哈希碰撞抵抗（不同 Key 产生不同哈希）
 * - 指纹格式验证（前缀 + ... + 后缀）
 * - context 注入安全（不包含完整密钥）
 * - 与 crypto 模块一致性
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { HttpRequest, HttpResponse } from "../../src/server";
import { hashKey, keyFingerprint, createAuthenticator, createAuthMiddleware } from "../../src/server/auth";

function createRequest(fullKey: string): HttpRequest {
  return {
    method: "POST",
    url: "/api/v1/test",
    headers: new Headers({ "x-api-key": fullKey }),
    body: null,
    params: {},
    query: new URLSearchParams(),
    remoteAddress: "192.168.1.1",
    context: {},
  };
}

function assertSyncResponse(response: HttpResponse | Promise<HttpResponse>): HttpResponse {
  expect(response).not.toBeInstanceOf(Promise);
  return response as HttpResponse;
}

// ─── SHA-256 哈希正确性 ───

describe("S.1.1 > SEC-01 > SHA-256 哈希正确性", () => {
  it("hashKey 输出为 64 字符小写 hex 字符串", () => {
    const result = hashKey("evo_test_key_123");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashKey 是确定性的（相同输入产生相同输出）", () => {
    const key = "evo_deterministic_test";
    const result1 = hashKey(key);
    const result2 = hashKey(key);
    expect(result1).toBe(result2);
  });

  it("hashKey 与 Node.js crypto.createHash('sha256') 输出一致", () => {
    const key = "evo_consistency_check";
    const expected = createHash("sha256").update(key).digest("hex");
    expect(hashKey(key)).toBe(expected);
  });

  it("hashKey 对不同输入产生不同哈希", () => {
    const keys = [
      "evo_key_alpha_001",
      "evo_key_alpha_002",
      "evo_key_beta_001",
      "evo_key_gamma_001",
      "evo_key_delta_001",
    ];
    const hashes = new Set(keys.map(hashKey));
    expect(hashes.size).toBe(5);
  });

  it("hashKey 对相似输入（仅 1 字符差异）产生不同哈希", () => {
    const hash1 = hashKey("evo_test_key_1");
    const hash2 = hashKey("evo_test_key_2");
    expect(hash1).not.toBe(hash2);
  });

  it("hashKey 对空字符串也能正常工作", () => {
    const result = hashKey("");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashKey 对长密钥（256+ 字符）也能正常工作", () => {
    const longKey = "evo_" + "a".repeat(256);
    const result = hashKey(longKey);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashKey 不使用旧的 32 位整数格式", () => {
    const result = hashKey("test_key");
    expect(result).not.toContain("hash:");
    expect(result).not.toMatch(/^hash:-?\d+$/);
  });
});

// ─── 哈希碰撞抵抗 ───

describe("S.1.1 > SEC-01 > 哈希碰撞抵抗", () => {
  it("100 个不同 Key 零碰撞", () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      hashes.add(hashKey(`evo_collision_test_${i.toString().padStart(3, "0")}`));
    }
    expect(hashes.size).toBe(100);
  });

  it("旧 32 位哈希的碰撞场景在新算法中不碰撞", () => {
    const key1 = "evo_very_long_key_that_would_overflow_32bit_int_aaaaaaaaaa";
    const key2 = "evo_very_long_key_that_would_overflow_32bit_int_bbbbbbbbbb";
    const hash1 = hashKey(key1);
    const hash2 = hashKey(key2);
    expect(hash1).not.toBe(hash2);
  });
});

// ─── 指纹格式 ───

describe("S.1.1 > SEC-05 > keyFingerprint 格式", () => {
  it("指纹格式为 前缀...后缀", () => {
    const fp = keyFingerprint("evo_test_key_12345");
    expect(fp).toContain("...");
    const parts = fp.split("...");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("evo_test");
    expect(parts[1]).toHaveLength(8);
    expect(parts[1]).toMatch(/^[0-9a-f]{8}$/);
  });

  it("短 Key（≤8 字符）使用完整 Key 作为前缀", () => {
    const fp = keyFingerprint("short");
    expect(fp).toContain("...");
    const parts = fp.split("...");
    expect(parts[0]).toBe("short");
  });

  it("指纹不包含完整密钥", () => {
    const secretKey = "evo_my_super_secret_api_key_xyz123";
    const fp = keyFingerprint(secretKey);
    expect(fp).not.toBe(secretKey);
    expect(fp.length).toBeLessThan(secretKey.length);
  });

  it("指纹是确定性的", () => {
    const key = "evo_fingerprint_deterministic";
    expect(keyFingerprint(key)).toBe(keyFingerprint(key));
  });

  it("不同 Key 产生不同指纹", () => {
    const fp1 = keyFingerprint("evo_key_one");
    const fp2 = keyFingerprint("evo_key_two");
    expect(fp1).not.toBe(fp2);
  });
});

// ─── context 注入安全 ───

describe("S.1.1 > SEC-05 > context 注入安全", () => {
  it("认证中间件注入指纹而非完整密钥", () => {
    const fullKey = "evo_full_secret_key_12345";
    const auth = createAuthenticator({ apiKeys: [fullKey] });
    const middleware = createAuthMiddleware(auth);
    const req = createRequest(fullKey);

    assertSyncResponse(middleware(req, () => ({ status: 200, headers: {}, body: "ok" })));
    expect(req.context.authenticated).toBe(true);
    expect(req.context.apiKey).not.toBe(fullKey);
    expect(req.context.apiKey).toContain("...");
  });

  it("validate 返回的 apiKey 字段是指纹", () => {
    const fullKey = "evo_another_secret_key_67890";
    const auth = createAuthenticator({ apiKeys: [fullKey] });
    const result = auth.validate(fullKey);
    expect(result.authenticated).toBe(true);
    expect(result.apiKey).not.toBe(fullKey);
    expect(result.apiKey).toContain("...");
  });

  it("指纹无法逆向推导完整密钥", () => {
    const fullKey = "evo_very_long_and_complex_secret_key_abcdefg";
    const fp = keyFingerprint(fullKey);
    expect(fp.length).toBeLessThan(fullKey.length);
    expect(fp).not.toContain(fullKey.slice(8));
  });
});

// ─── 认证器集成 ───

describe("S.1.1 > 认证器集成（SHA-256）", () => {
  it("使用 SHA-256 哈希后认证仍然正常工作", () => {
    const auth = createAuthenticator({
      apiKeys: ["evo_key_alpha", "evo_key_beta", "evo_key_gamma"],
    });

    expect(auth.validate("evo_key_alpha").authenticated).toBe(true);
    expect(auth.validate("evo_key_beta").authenticated).toBe(true);
    expect(auth.validate("evo_key_gamma").authenticated).toBe(true);
    expect(auth.validate("evo_key_delta").authenticated).toBe(false);
  });

  it("SHA-256 哈希的认证器拒绝前缀错误的 Key", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_correct_key"] });
    const result = auth.validate("wrong_prefix_key");
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("prefix");
  });
});

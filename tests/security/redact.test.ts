/**
 * S.2.2 安全修复测试 — 配置快照脱敏（SEC-10）。
 *
 * 覆盖范围：
 * - 敏感路径检测
 * - 白名单排除
 * - 深度脱敏
 * - 环境变量占位符保护
 * - 脱敏值恢复（round-trip）
 * - 嵌套对象和数组
 */

import { describe, it, expect } from "vitest";
import {
  REDACTED_SENTINEL,
  isSensitiveConfigPath,
  redactConfigObject,
  restoreRedactedValues,
} from "../../src/security/redact";

// ─── isSensitiveConfigPath ───

describe("S.2.2 > SEC-10 > isSensitiveConfigPath", () => {
  it("检测 api_key 路径", () => {
    expect(isSensitiveConfigPath("llm.api_key")).toBe(true);
    expect(isSensitiveConfigPath("apiKey")).toBe(true);
  });

  it("检测 password 路径", () => {
    expect(isSensitiveConfigPath("db.password")).toBe(true);
  });

  it("检测 secret 路径", () => {
    expect(isSensitiveConfigPath("hmac_secret")).toBe(true);
  });

  it("检测 private_key 路径", () => {
    expect(isSensitiveConfigPath("ssh.private_key")).toBe(true);
  });

  it("白名单排除 maxTokens", () => {
    expect(isSensitiveConfigPath("llm.max_tokens")).toBe(false);
    expect(isSensitiveConfigPath("llm.maxTokens")).toBe(false);
    expect(isSensitiveConfigPath("maxOutputTokens")).toBe(false);
  });

  it("白名单排除 tokenBudget", () => {
    expect(isSensitiveConfigPath("budget.tokenBudget")).toBe(false);
  });

  it("非敏感路径返回 false", () => {
    expect(isSensitiveConfigPath("llm.model")).toBe(false);
    expect(isSensitiveConfigPath("server.host")).toBe(false);
    expect(isSensitiveConfigPath("evolution.auto_evolution")).toBe(false);
  });

  it("空路径返回 false", () => {
    expect(isSensitiveConfigPath("")).toBe(false);
  });

  it("大小写不敏感", () => {
    expect(isSensitiveConfigPath("API_KEY")).toBe(true);
    expect(isSensitiveConfigPath("Api_Key")).toBe(true);
    expect(isSensitiveConfigPath("PASSWORD")).toBe(true);
  });
});

// ─── redactConfigObject ───

describe("S.2.2 > SEC-10 > redactConfigObject", () => {
  it("脱敏 api_key 字段", () => {
    const config = { llm: { api_key: "sk-secret-123" } };
    const redacted = redactConfigObject(config);
    expect((redacted as typeof config).llm.api_key).toBe(REDACTED_SENTINEL);
  });

  it("脱敏 password 字段", () => {
    const config = { database: { password: "my-db-password" } };
    const redacted = redactConfigObject(config);
    expect((redacted as typeof config).database.password).toBe(REDACTED_SENTINEL);
  });

  it("不脱敏 max_tokens（白名单）", () => {
    const config = { llm: { max_tokens: 2048 } };
    const redacted = redactConfigObject(config);
    expect((redacted as typeof config).llm.max_tokens).toBe(2048);
  });

  it("不脱敏非敏感字段", () => {
    const config = { llm: { model: "gpt-4o", temperature: 0.7 } };
    const redacted = redactConfigObject(config);
    expect((redacted as typeof config).llm.model).toBe("gpt-4o");
    expect((redacted as typeof config).llm.temperature).toBe(0.7);
  });

  it("保护环境变量占位符", () => {
    const config = { llm: { api_key: "${OPENAI_API_KEY}" } };
    const redacted = redactConfigObject(config);
    expect((redacted as typeof config).llm.api_key).toBe("${OPENAI_API_KEY}");
  });

  it("深度脱敏嵌套对象", () => {
    const config = {
      llm: {
        api_key: "sk-secret",
        nested: {
          deep_secret: "hidden-value",
          safe_value: "visible",
        },
      },
    };
    const redacted = redactConfigObject(config) as typeof config;
    expect(redacted.llm.api_key).toBe(REDACTED_SENTINEL);
    expect(redacted.llm.nested.deep_secret).toBe(REDACTED_SENTINEL);
    expect(redacted.llm.nested.safe_value).toBe("visible");
  });

  it("脱敏数组中的敏感字段", () => {
    const config = {
      providers: [
        { name: "openai", api_key: "sk-1" },
        { name: "anthropic", api_key: "sk-2" },
      ],
    };
    const redacted = redactConfigObject(config) as typeof config;
    expect(redacted.providers[0]?.api_key).toBe(REDACTED_SENTINEL);
    expect(redacted.providers[1]?.api_key).toBe(REDACTED_SENTINEL);
    expect(redacted.providers[0]?.name).toBe("openai");
  });

  it("保留非字符串值", () => {
    const config = { llm: { max_tokens: 2048, enabled: true, ratio: 0.5 } };
    const redacted = redactConfigObject(config);
    expect(redacted).toEqual(config);
  });

  it("处理 null 和 undefined", () => {
    const config = { llm: { api_key: null as unknown as string, model: undefined as unknown as string } };
    const redacted = redactConfigObject(config);
    expect((redacted as typeof config).llm.api_key).toBeNull();
  });
});

// ─── restoreRedactedValues ───

describe("S.2.2 > SEC-10 > restoreRedactedValues", () => {
  it("恢复脱敏值为原始值", () => {
    const original = { llm: { api_key: "sk-original", model: "gpt-4o" } };
    const redacted = { llm: { api_key: REDACTED_SENTINEL, model: "gpt-4o" } };
    const restored = restoreRedactedValues(redacted, original) as typeof original;
    expect(restored.llm.api_key).toBe("sk-original");
    expect(restored.llm.model).toBe("gpt-4o");
  });

  it("恢复嵌套对象的脱敏值", () => {
    const original = { db: { password: "secret123", host: "localhost" } };
    const redacted = { db: { password: REDACTED_SENTINEL, host: "localhost" } };
    const restored = restoreRedactedValues(redacted, original) as typeof original;
    expect(restored.db.password).toBe("secret123");
  });

  it("恢复数组中的脱敏值", () => {
    const original = { keys: ["key1", "key2", "key3"] };
    const redacted = { keys: [REDACTED_SENTINEL, "key2", REDACTED_SENTINEL] };
    const restored = restoreRedactedValues(redacted, original) as typeof original;
    expect(restored.keys).toEqual(["key1", "key2", "key3"]);
  });

  it("非脱敏值保持不变", () => {
    const original = { llm: { api_key: "sk-original" } };
    const incoming = { llm: { api_key: "sk-new-value" } };
    const restored = restoreRedactedValues(incoming, original) as typeof original;
    expect(restored.llm.api_key).toBe("sk-new-value");
  });

  it("原始值不存在时保持哨兵值", () => {
    const original = { llm: {} };
    const incoming = { llm: { api_key: REDACTED_SENTINEL } };
    const restored = restoreRedactedValues(incoming, original) as typeof original;
    expect(restored.llm.api_key).toBe(REDACTED_SENTINEL);
  });

  it("完整 round-trip 测试", () => {
    const original = {
      llm: { api_key: "sk-round-trip", model: "gpt-4o", max_tokens: 2048 },
      server: { host: "127.0.0.1", port: 8900 },
    };

    // 1. 脱敏
    const redacted = redactConfigObject(original);
    expect((redacted as typeof original).llm.api_key).toBe(REDACTED_SENTINEL);
    expect((redacted as typeof original).llm.model).toBe("gpt-4o");

    // 2. 模拟用户修改非敏感字段
    const modified = {
      ...(redacted as Record<string, unknown>),
      llm: {
        ...(redacted as typeof original).llm,
        model: "gpt-4o-mini",
      },
    };

    // 3. 恢复脱敏值
    const restored = restoreRedactedValues(modified, original) as typeof original;
    expect(restored.llm.api_key).toBe("sk-round-trip");
    expect(restored.llm.model).toBe("gpt-4o-mini");
    expect(restored.llm.max_tokens).toBe(2048);
  });
});

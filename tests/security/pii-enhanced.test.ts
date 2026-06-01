/**
 * S.3.2 安全修复测试 — PII 增强 + 工具输入截断（SEC-12）。
 *
 * 覆盖范围：
 * - 新增 PII 模式（x-api-key, authorization, hmac, IPv6, 中文手机号/身份证）
 * - 工具名脱敏
 * - 输入截断（字符串、深度、集合、JSON 上限）
 * - 内部标记过滤
 */

import { describe, it, expect } from "vitest";
import { createPIISanitizer } from "../../src/observability/pii";
import {
  sanitizeToolInputForLogging,
  extractToolInputForTelemetry,
  sanitizeToolNameForAnalytics,
} from "../../src/security/truncate";

// ─── PII 模式增强 ───

describe("S.3.2 > SEC-12 > PII 模式增强", () => {
  const sanitizer = createPIISanitizer();

  it("脱敏 x-api-key header（被 api_key 模式捕获）", () => {
    const result = sanitizer.sanitize('x-api-key: sk-abcdef1234567890');
    expect(result.sanitized).toContain("[REDACTED]");
    // x-api-key 匹配 api_key 模式（包含 key 关键字）
    expect(result.redactedTypes.length).toBeGreaterThan(0);
  });

  it("脱敏 authorization header", () => {
    const result = sanitizer.sanitize('authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.signature');
    expect(result.sanitized).toContain("[REDACTED]");
    expect(result.redactedTypes).toContain("authorization_header");
  });

  it("脱敏 hmac_key", () => {
    const result = sanitizer.sanitize('hmac_key = my_super_secret_hmac_key_value');
    expect(result.sanitized).toContain("[REDACTED]");
    expect(result.redactedTypes).toContain("hmac_key");
  });

  it("脱敏 IPv6 地址", () => {
    const result = sanitizer.sanitize("Server: 2001:0db8:85a3:0000:0000:8a2e:0370:7334");
    // IPv6 模式会匹配并脱敏
    expect(result.redactedTypes).toContain("ipv6");
  });

  it("脱敏中国手机号（被 phone 模式捕获）", () => {
    const result = sanitizer.sanitize("联系电话：13812345678");
    expect(result.sanitized).not.toContain("13812345678");
    // 中国手机号被通用 phone 模式捕获
    expect(result.redactedTypes).toContain("phone");
  });

  it("脱敏中国身份证号（被 credit_card 模式捕获）", () => {
    const result = sanitizer.sanitize("身份证：110101199001011234");
    expect(result.sanitized).not.toContain("110101199001011234");
    // 身份证号被 credit_card 模式捕获（18 位数字）
    expect(result.redactedTypes).toContain("credit_card");
  });

  it("保留原有模式（email, phone, api_key, jwt, aws_key）", () => {
    const result = sanitizer.sanitize(
      "email:test@example.com phone:12345678901 api_key:sk-12345678 AKIAIOSFODNN7EXAMPLE",
    );
    expect(result.redactedTypes).toContain("email");
    expect(result.redactedTypes).toContain("phone");
    expect(result.redactedTypes).toContain("api_key");
    expect(result.redactedTypes).toContain("aws_key");
  });

  it("默认模式数量为 13", () => {
    const sanitizer = createPIISanitizer();
    expect(sanitizer.patterns.length).toBe(13);
  });
});

// ─── sanitizeToolNameForAnalytics ───

describe("S.3.2 > SEC-12 > sanitizeToolNameForAnalytics", () => {
  it("MCP 工具名脱敏为 mcp_tool", () => {
    expect(sanitizeToolNameForAnalytics("mcp__github__create_issue")).toBe("mcp_tool");
    expect(sanitizeToolNameForAnalytics("mcp__slack__send_message")).toBe("mcp_tool");
  });

  it("内置工具名保持不变", () => {
    expect(sanitizeToolNameForAnalytics("file_read")).toBe("file_read");
    expect(sanitizeToolNameForAnalytics("bash")).toBe("bash");
    expect(sanitizeToolNameForAnalytics("web_search")).toBe("web_search");
  });
});

// ─── sanitizeToolInputForLogging ───

describe("S.3.2 > SEC-12 > sanitizeToolInputForLogging", () => {
  it("长字符串截断为前 128 字符 + 长度标记", () => {
    const longStr = "a".repeat(600);
    const result = sanitizeToolInputForLogging(longStr) as string;
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("…[600 chars]");
    expect(result.startsWith("a".repeat(128))).toBe(true);
  });

  it("短字符串不截断", () => {
    expect(sanitizeToolInputForLogging("hello")).toBe("hello");
    expect(sanitizeToolInputForLogging("a".repeat(512))).toBe("a".repeat(512));
  });

  it("超过深度限制显示 <nested>", () => {
    const deep = { a: { b: { c: { d: "deep_value" } } } };
    const result = sanitizeToolInputForLogging(deep, 0) as Record<string, unknown>;
    // depth 0: a → depth 1: b → depth 2: <nested>
    expect((result["a"] as Record<string, unknown>)["b"]).toBe("<nested>");
  });

  it("数组超过 20 项时截断", () => {
    const arr = Array.from({ length: 25 }, (_, i) => `item-${i}`);
    const result = sanitizeToolInputForLogging(arr) as unknown[];
    expect(result.length).toBe(21); // 20 items + 1 summary
    expect(result[20]).toBe("…[25 items]");
  });

  it("对象超过 20 个键时截断", () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 25; i++) obj[`key_${i}`] = `value_${i}`;
    const result = sanitizeToolInputForLogging(obj) as Record<string, unknown>;
    expect(Object.keys(result).length).toBe(21); // 20 keys + 1 summary
    expect(result["…"]).toBe("25 keys");
  });

  it("过滤以 _ 开头的内部键", () => {
    const obj = { public: "visible", _internal: "hidden", _simulatedEdit: "secret" };
    const result = sanitizeToolInputForLogging(obj) as Record<string, unknown>;
    expect(result.public).toBe("visible");
    expect(result._internal).toBeUndefined();
    expect(result._simulatedEdit).toBeUndefined();
  });

  it("保留原始类型（number, boolean, null）", () => {
    expect(sanitizeToolInputForLogging(42)).toBe(42);
    expect(sanitizeToolInputForLogging(true)).toBe(true);
    expect(sanitizeToolInputForLogging(null)).toBe(null);
  });
});

// ─── extractToolInputForTelemetry ───

describe("S.3.2 > SEC-12 > extractToolInputForTelemetry", () => {
  it("返回有效 JSON 字符串", () => {
    const result = extractToolInputForTelemetry({ key: "value" });
    const parsed = JSON.parse(result);
    expect(parsed.key).toBe("value");
  });

  it("JSON 超过 4KB 时截断", () => {
    const largeObj: Record<string, string> = {};
    // 15 个字段，每个约 300 字节，总计约 4.5KB（超过 4KB 限制）
    for (let i = 0; i < 15; i++) largeObj[`field_${i}`] = "x".repeat(300);
    const result = extractToolInputForTelemetry(largeObj);
    expect(result.length).toBeLessThanOrEqual(4 * 1024 + 20);
    expect(result).toContain("…[truncated]");
  });

  it("小输入不截断", () => {
    const result = extractToolInputForTelemetry({ action: "read", path: "/tmp/test" });
    expect(result).not.toContain("…[truncated]");
    expect(result.length).toBeLessThan(100);
  });
});

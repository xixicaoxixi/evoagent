/**
 * S.2.1 安全修复测试 — SecretRef 类型系统 + 配置支持（SEC-03）。
 *
 * 覆盖范围：
 * - SecretRef 类型守卫
 * - 环境变量模板解析
 * - coerceSecretRef 强制转换
 * - resolveSecret 密钥解析
 * - readSecretFromFile 文件读取（符号链接拒绝 + 大小限制）
 * - 配置 Schema 支持 SecretInput
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, symlinkSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isSecretRef,
  isValidEnvSecretRefId,
  parseEnvTemplateSecretRef,
  coerceSecretRef,
  resolveSecret,
  readSecretFromFile,
  DEFAULT_SECRET_PROVIDER_ALIAS,
  MAX_SECRET_FILE_BYTES,
} from "../../src/security/secret-ref";
import { LLMConfigSchema } from "../../src/schemas/config";

const isWindows = process.platform === "win32";

const TEST_DIR = join(tmpdir(), "evoagent-secret-ref-test");

function setupTestDir(): void {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.EVOAGENT_SECRET_DIRS = TEST_DIR;
}

function cleanupTestDir(): void {
  delete process.env.EVOAGENT_SECRET_DIRS;
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── isSecretRef 类型守卫 ───

describe("S.2.1 > SEC-03 > isSecretRef", () => {
  it("识别有效的 env SecretRef", () => {
    expect(isSecretRef({ source: "env", provider: "default", id: "OPENAI_API_KEY" })).toBe(true);
  });

  it("识别有效的 file SecretRef", () => {
    expect(isSecretRef({ source: "file", provider: "mounted", id: "/keys/openai" })).toBe(true);
  });

  it("识别有效的 exec SecretRef", () => {
    expect(isSecretRef({ source: "exec", provider: "vault", id: "openai/key" })).toBe(true);
  });

  it("拒绝缺少字段的对象", () => {
    expect(isSecretRef({ source: "env", provider: "default" })).toBe(false);
    expect(isSecretRef({ source: "env", id: "KEY" })).toBe(false);
    expect(isSecretRef({ provider: "default", id: "KEY" })).toBe(false);
  });

  it("拒绝无效的 source", () => {
    expect(isSecretRef({ source: "invalid", provider: "default", id: "KEY" })).toBe(false);
  });

  it("拒绝空 provider", () => {
    expect(isSecretRef({ source: "env", provider: "", id: "KEY" })).toBe(false);
  });

  it("拒绝空 id", () => {
    expect(isSecretRef({ source: "env", provider: "default", id: "" })).toBe(false);
  });

  it("拒绝非对象值", () => {
    expect(isSecretRef("string")).toBe(false);
    expect(isSecretRef(123)).toBe(false);
    expect(isSecretRef(null)).toBe(false);
    expect(isSecretRef(undefined)).toBe(false);
    expect(isSecretRef([1, 2, 3])).toBe(false);
  });

  it("拒绝多余字段的对象", () => {
    expect(isSecretRef({ source: "env", provider: "default", id: "KEY", extra: true })).toBe(false);
  });
});

// ─── isValidEnvSecretRefId ───

describe("S.2.1 > SEC-03 > isValidEnvSecretRefId", () => {
  it("接受有效的环境变量名", () => {
    expect(isValidEnvSecretRefId("OPENAI_API_KEY")).toBe(true);
    expect(isValidEnvSecretRefId("A")).toBe(true);
    expect(isValidEnvSecretRefId("A1")).toBe(true);
    expect(isValidEnvSecretRefId("MY_VAR_123")).toBe(true);
  });

  it("拒绝小写字母开头", () => {
    expect(isValidEnvSecretRefId("lowercase")).toBe(false);
    expect(isValidEnvSecretRefId("a_KEY")).toBe(false);
  });

  it("拒绝空字符串", () => {
    expect(isValidEnvSecretRefId("")).toBe(false);
  });

  it("拒绝超长名称（>128 字符）", () => {
    const longName = "A" + "_X".repeat(64);
    expect(isValidEnvSecretRefId(longName)).toBe(false);
  });
});

// ─── parseEnvTemplateSecretRef ───

describe("S.2.1 > SEC-03 > parseEnvTemplateSecretRef", () => {
  it("解析 ${VAR_NAME} 格式", () => {
    const result = parseEnvTemplateSecretRef("${OPENAI_API_KEY}");
    expect(result).not.toBeNull();
    expect(result?.source).toBe("env");
    expect(result?.id).toBe("OPENAI_API_KEY");
    expect(result?.provider).toBe(DEFAULT_SECRET_PROVIDER_ALIAS);
  });

  it("使用自定义 provider", () => {
    const result = parseEnvTemplateSecretRef("${MY_KEY}", "custom-provider");
    expect(result?.provider).toBe("custom-provider");
  });

  it("拒绝非模板字符串", () => {
    expect(parseEnvTemplateSecretRef("plain_string")).toBeNull();
    expect(parseEnvTemplateSecretRef("${lowercase}")).toBeNull();
    expect(parseEnvTemplateSecretRef("${}")).toBeNull();
    expect(parseEnvTemplateSecretRef("${123}")).toBeNull();
  });

  it("拒绝非字符串输入", () => {
    expect(parseEnvTemplateSecretRef(123)).toBeNull();
    expect(parseEnvTemplateSecretRef(null)).toBeNull();
    expect(parseEnvTemplateSecretRef(undefined)).toBeNull();
  });

  it("忽略前后空格", () => {
    const result = parseEnvTemplateSecretRef("  ${MY_KEY}  ");
    expect(result?.id).toBe("MY_KEY");
  });
});

// ─── coerceSecretRef ───

describe("S.2.1 > SEC-03 > coerceSecretRef", () => {
  it("已经是 SecretRef 直接返回", () => {
    const ref = { source: "env" as const, provider: "default", id: "KEY" };
    expect(coerceSecretRef(ref)).toEqual(ref);
  });

  it("从模板字符串解析", () => {
    const result = coerceSecretRef("${MY_KEY}");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("MY_KEY");
  });

  it("无法解析时返回 null", () => {
    expect(coerceSecretRef("plain_string")).toBeNull();
    expect(coerceSecretRef(123)).toBeNull();
  });
});

// ─── resolveSecret ───

describe("S.2.1 > SEC-03 > resolveSecret", () => {
  const originalEnv = process.env.TEST_SECRET_RESOLVE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TEST_SECRET_RESOLVE = originalEnv;
    } else {
      delete process.env.TEST_SECRET_RESOLVE;
    }
  });

  it("直接字符串原样返回", () => {
    expect(resolveSecret("my-api-key")).toBe("my-api-key");
  });

  it("env source 从环境变量读取", () => {
    process.env.TEST_SECRET_RESOLVE = "resolved-value";
    const result = resolveSecret({ source: "env", provider: "default", id: "TEST_SECRET_RESOLVE" });
    expect(result).toBe("resolved-value");
  });

  it("env source 环境变量不存在时抛出错误", () => {
    delete process.env.TEST_SECRET_RESOLVE;
    expect(() => resolveSecret({ source: "env", provider: "default", id: "NONEXISTENT_VAR" })).toThrow(/NONEXISTENT_VAR/);
  });

  it("file source 从文件读取", () => {
    setupTestDir();
    const filePath = join(TEST_DIR, "secret.txt");
    writeFileSync(filePath, "file-secret-value\n");
    const result = resolveSecret({ source: "file", provider: "default", id: filePath });
    expect(result).toBe("file-secret-value");
    cleanupTestDir();
  });

  it("exec source 抛出错误（不支持）", () => {
    expect(() => resolveSecret({ source: "exec", provider: "vault", id: "get-key" })).toThrow("not supported");
  });
});

// ─── readSecretFromFile ───

describe("S.2.1 > SEC-03 > readSecretFromFile", () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  it("读取正常文件", () => {
    const filePath = join(TEST_DIR, "normal.txt");
    writeFileSync(filePath, "my-secret-key");
    expect(readSecretFromFile(filePath, "test")).toBe("my-secret-key");
  });

  it("去除前后空白", () => {
    const filePath = join(TEST_DIR, "whitespace.txt");
    writeFileSync(filePath, "  trimmed-secret  \n");
    expect(readSecretFromFile(filePath, "test")).toBe("trimmed-secret");
  });

  it("文件不存在时抛出错误", () => {
    expect(() => readSecretFromFile(join(TEST_DIR, "nonexistent.txt"), "test")).toThrow("file not found or inaccessible");
  });

  it("拒绝符号链接", () => {
    if (isWindows) return;
    const realFile = join(TEST_DIR, "real.txt");
    const linkFile = join(TEST_DIR, "link.txt");
    writeFileSync(realFile, "real-secret");
    symlinkSync(realFile, linkFile);

    expect(() => readSecretFromFile(linkFile, "symlink-test")).toThrow("symbolic links are not allowed");
  });

  it("拒绝超大文件", () => {
    const filePath = join(TEST_DIR, "huge.txt");
    writeFileSync(filePath, "x".repeat(MAX_SECRET_FILE_BYTES + 1));
    expect(() => readSecretFromFile(filePath, "huge-test")).toThrow("exceeds maximum");
  });

  it("拒绝白名单外的路径", () => {
    expect(() => readSecretFromFile("/etc/shadow", "test")).toThrow("outside allowed directories");
  });
});

// ─── 配置 Schema 支持 ───

describe("S.2.1 > SEC-03 > 配置 Schema 支持 SecretInput", () => {
  it("api_key 接受字符串", () => {
    const result = LLMConfigSchema.parse({ api_key: "sk-direct-string" });
    expect(result.api_key).toBe("sk-direct-string");
  });

  it("api_key 接受 SecretRef", () => {
    const result = LLMConfigSchema.parse({
      api_key: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
    expect(result.api_key).toEqual({ source: "env", provider: "default", id: "OPENAI_API_KEY" });
  });

  it("api_key 默认为空字符串", () => {
    const result = LLMConfigSchema.parse({});
    expect(result.api_key).toBe("");
  });

  it("api_key 拒绝无效 SecretRef", () => {
    expect(() => LLMConfigSchema.parse({ api_key: { source: "invalid" } })).toThrow();
  });
});

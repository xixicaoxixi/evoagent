/**
 * F.1 测试 — 硬编码密钥检测。
 *
 * 自动化断言：src/ 中不应包含硬编码 API Key、密钥、令牌等敏感信息。
 * 使用 Node.js 原生 API 扫描源码，确保跨平台兼容。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const SRC_DIR = join(ROOT, "src");

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...collectTsFiles(full));
      } else if (extname(entry) === ".ts") {
        results.push(full);
      }
    }
  } catch {
    // 目录不存在时返回空
  }
  return results;
}

const SRC_FILES = collectTsFiles(SRC_DIR);

function grepSrc(pattern: string | RegExp): string {
  const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  const matches: string[] = [];
  for (const file of SRC_FILES) {
    const content = readFileSync(file, "utf-8");
    for (const line of content.split("\n")) {
      if (re.test(line)) {
        const rel = relative(ROOT, file);
        matches.push(`${rel}: ${line.trim()}`);
      }
    }
    re.lastIndex = 0;
  }
  return matches.join("\n");
}

// ─── 硬编码 API Key 检测 ───

describe("F.1: 硬编码密钥检测", () => {
  it("src/ 中不应包含 Anthropic API Key (sk-ant-api03-)", { timeout: 30_000 }, () => {
    const result = grepSrc("sk-ant-api03-");
    expect(result).toBe("");
  });

  it("src/ 中不应包含 OpenAI API Key (sk- 后跟 40+ 字符)", () => {
    const result = grepSrc(/sk-[a-zA-Z0-9]{40}/);
    expect(result).toBe("");
  });

  it("src/ 中不应包含 AWS Access Key (AKIA)", () => {
    const result = grepSrc(/AKIA[0-9A-Z]{16}/);
    expect(result).toBe("");
  });

  it("src/ 中不应包含 GitHub PAT (ghp_)", () => {
    const result = grepSrc(/ghp_[a-zA-Z0-9]{36}/);
    expect(result).toBe("");
  });

  it("src/ 中不应包含 Slack Token (xoxb-/xoxp-)", () => {
    const result = grepSrc(/xox[bp]-[a-zA-Z0-9]/);
    expect(result).toBe("");
  });

  it("src/ 中不应包含 JWT 令牌 (eyJ...)", () => {
    const result = grepSrc(/eyJ[a-zA-Z0-9_-]*\.eyJ/);
    expect(result).toBe("");
  });

  it("src/ 中不应包含 Stripe Key (sk_live_/rk_live_)", () => {
    const result = grepSrc("sk_live_|rk_live_");
    expect(result).toBe("");
  });

  it("src/ 中不应包含 Google API Key (AIza)", () => {
    const result = grepSrc(/AIza[0-9A-Z\-]{35}/);
    expect(result).toBe("");
  });
});

// ─── 外部引用残留检测 ───

describe("F.1: 外部引用残留检测", () => {
  it("src/ 中不应包含 claude-code 引用", () => {
    const result = grepSrc("claude-code");
    expect(result).toBe("");
  });

  it("src/ 中不应包含 openclaw 引用", () => {
    const result = grepSrc("openclaw");
    expect(result).toBe("");
  });

  it("src/ 中不应包含 HackerOne 引用", () => {
    const result = grepSrc("HackerOne");
    expect(result).toBe("");
  });
});

// ─── 敏感模式检测 ───

describe("F.1: 敏感模式检测", () => {
  it("src/ 中不应包含 console.log(password/secret/token)", () => {
    const result = grepSrc(/console\.log\(.*(?:password|secret|token|apiKey|api_key)/);
    expect(result).toBe("");
  });

  it("src/ 中不应包含硬编码密码字符串", () => {
    const result = grepSrc(/password\s*=\s*["'][^"']{8,}["']/);
    expect(result).toBe("");
  });

  it("src/ 中不应包含硬编码私钥", () => {
    const result = grepSrc("BEGIN.*PRIVATE.*KEY");
    expect(result).toBe("");
  });
});

// ─── 安全函数调用验证 ───

describe("F.1: 安全函数调用验证", () => {
  it("PII 净化器应在 security 模块中被使用", () => {
    const result = grepSrc("createPIISanitizer");
    expect(result).not.toBe("");
  });

  it("路径脱敏函数应在 security 模块中被使用", () => {
    const result = grepSrc("sanitizePath");
    expect(result).not.toBe("");
  });

  it("Unicode 净化函数应在 security 模块中被使用", () => {
    const result = grepSrc("normalizeUnicodeForSafety");
    expect(result).not.toBe("");
  });

  it("提示注入检测应在 security 模块中被使用", () => {
    const result = grepSrc("detectPromptInjection");
    expect(result).not.toBe("");
  });

  it("LLM 净化函数应在 loop.ts 中被使用", () => {
    const result = grepSrc("shouldSanitizeForLLM");
    expect(result).not.toBe("");
  });

  it("架构关键词过滤应在 prompt.ts 中被使用", () => {
    const result = grepSrc("filterArchitectureKeywords");
    expect(result).not.toBe("");
  });
});

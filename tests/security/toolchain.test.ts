/**
 * E.3 测试 — 安全工具链集成。
 *
 * 验证 Semgrep 规则文件、gitleaks 配置、CI 配置、
 * package.json 审计脚本、安全测试文件完整性。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

// ─── E.1: Semgrep 规则验证 ───

describe("E.1: Semgrep 规则", () => {
  const rulesPath = join(ROOT, ".semgrep/rules/evoagent-security.yaml");

  it("Semgrep 规则文件应存在", () => {
    expect(existsSync(rulesPath)).toBe(true);
  });

  it("应包含 4 条自定义规则", () => {
    const content = readFileSync(rulesPath, "utf-8");
    expect(content).toContain("evoagent-no-hardcoded-keys");
    expect(content).toContain("evoagent-no-external-reference");
    expect(content).toContain("evoagent-no-eval");
    expect(content).toContain("evoagent-no-sensitive-logging");
  });

  it("硬编码密钥规则应覆盖常见 API Key 模式", () => {
    const content = readFileSync(rulesPath, "utf-8");
    expect(content).toContain("sk-ant-");
    expect(content).toContain("ghp_");
    expect(content).toContain("AKIA");
    expect(content).toContain("xoxb-");
  });

  it("外部引用规则应覆盖已知外部项目", () => {
    const content = readFileSync(rulesPath, "utf-8");
    expect(content).toContain("claude-code");
    expect(content).toContain("openclaw");
    expect(content).toContain("HackerOne");
  });

  it("eval 规则应排除 code-sandbox.ts", () => {
    const content = readFileSync(rulesPath, "utf-8");
    expect(content).toContain("code-sandbox");
  });

  it("敏感日志规则应覆盖常见敏感字段", () => {
    const content = readFileSync(rulesPath, "utf-8");
    expect(content).toContain("password");
    expect(content).toContain("secret");
    expect(content).toContain("token");
    expect(content).toContain("apiKey");
    expect(content).toContain("privateKey");
    expect(content).toContain("credential");
  });

  it("规则应指定 TypeScript 语言", () => {
    const content = readFileSync(rulesPath, "utf-8");
    expect(content).toContain("typescript");
  });
});

// ─── E.1: CI 配置验证 ───

describe("E.1: CI 配置", () => {
  const ciPath = join(ROOT, ".github/workflows/security.yml");

  it("CI 配置文件应存在", () => {
    expect(existsSync(ciPath)).toBe(true);
  });

  it("应包含 Semgrep 作业", () => {
    const content = readFileSync(ciPath, "utf-8");
    expect(content).toContain("sast-semgrep");
    expect(content).toContain("semgrep-action");
    expect(content).toContain("evoagent-security.yaml");
  });

  it("应包含依赖审计作业", () => {
    const content = readFileSync(ciPath, "utf-8");
    expect(content).toContain("dependency-audit");
    expect(content).toContain("npm audit");
    expect(content).toContain("npm pack --dry-run");
  });

  it("应包含密钥扫描作业", () => {
    const content = readFileSync(ciPath, "utf-8");
    expect(content).toContain("secret-scan");
    expect(content).toContain("gitleaks");
  });

  it("应包含类型检查作业", () => {
    const content = readFileSync(ciPath, "utf-8");
    expect(content).toContain("type-check");
    expect(content).toContain("tsc --noEmit");
  });

  it("应包含构建审计作业", () => {
    const content = readFileSync(ciPath, "utf-8");
    expect(content).toContain("build-audit");
    expect(content).toContain("audit-pack.js");
  });

  it("应包含测试作业", () => {
    const content = readFileSync(ciPath, "utf-8");
    expect(content).toContain("bun test");
  });

  it("应配置定时扫描（每周一）", () => {
    const content = readFileSync(ciPath, "utf-8");
    expect(content).toContain("cron");
  });

  it("应在 push 和 PR 时触发", () => {
    const content = readFileSync(ciPath, "utf-8");
    expect(content).toContain("pull_request");
    expect(content).toContain("push");
  });
});

// ─── E.2: gitleaks 配置验证 ───

describe("E.2: gitleaks 配置", () => {
  const configPath = join(ROOT, ".gitleaks.toml");

  it("gitleaks 配置文件应存在", () => {
    expect(existsSync(configPath)).toBe(true);
  });

  it("应包含自定义密钥规则", () => {
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("evoagent-anthropic-key");
    expect(content).toContain("evoagent-openai-key");
    expect(content).toContain("evoagent-aws-access-key");
    expect(content).toContain("evoagent-github-pat");
    expect(content).toContain("evoagent-slack-token");
    expect(content).toContain("evoagent-jwt");
  });

  it("应配置 allowlist 排除非源码目录", () => {
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("tests/");
    expect(content).toContain("reference/");
    expect(content).toContain("docs/");
    expect(content).toContain(".semgrep/");
  });

  it("规则应包含 regex 模式", () => {
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("sk-ant-api03");
    expect(content).toContain("AKIA");
    expect(content).toContain("ghp_");
    expect(content).toContain("xox[bpas]");
    expect(content).toContain("eyJ");
  });
});

// ─── E.2: package.json 审计脚本验证 ───

describe("E.2: package.json 审计脚本", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

  it("应有 audit 脚本", () => {
    expect(pkg.scripts.audit).toBeDefined();
    expect(pkg.scripts.audit).toContain("npm audit");
  });

  it("应有 audit:pack 脚本", () => {
    expect(pkg.scripts["audit:pack"]).toBeDefined();
    expect(pkg.scripts["audit:pack"]).toContain("npm pack --dry-run");
  });

  it("应有 audit:secrets 脚本", () => {
    expect(pkg.scripts["audit:secrets"]).toBeDefined();
    expect(pkg.scripts["audit:secrets"]).toContain("sk-ant-api03");
  });

  it("应有 audit:refs 脚本", () => {
    expect(pkg.scripts["audit:refs"]).toBeDefined();
    expect(pkg.scripts["audit:refs"]).toContain("claude-code");
    expect(pkg.scripts["audit:refs"]).toContain("openclaw");
  });
});

// ─── E.3: 安全测试文件完整性 ───

describe("E.3: 安全测试文件完整性", () => {
  const testsDir = join(ROOT, "tests/security");

  it("tests/security 目录应存在", () => {
    expect(existsSync(testsDir)).toBe(true);
  });

  it("应包含 LLM 净化测试", () => {
    expect(existsSync(join(testsDir, "llm-sanitize.test.ts"))).toBe(true);
  });

  it("应包含 P2P 通信安全测试", () => {
    expect(existsSync(join(testsDir, "p2p-security.test.ts"))).toBe(true);
  });

  it("应包含 npm 打包测试", () => {
    expect(existsSync(join(testsDir, "npm-packaging.test.ts"))).toBe(true);
  });

  it("应包含引用清理测试", () => {
    expect(existsSync(join(testsDir, "reference-cleanup.test.ts"))).toBe(true);
  });

  it("应包含模块接入测试", () => {
    expect(existsSync(join(testsDir, "module-wiring.test.ts"))).toBe(true);
  });

  it("应包含内容接入测试", () => {
    expect(existsSync(join(testsDir, "content-wiring.test.ts"))).toBe(true);
  });

  it("应包含 Agentic Loop 净化测试", () => {
    expect(existsSync(join(testsDir, "loop-sanitize.test.ts"))).toBe(true);
  });

  it("应包含进化引擎净化测试", () => {
    expect(existsSync(join(testsDir, "evolution-sanitize.test.ts"))).toBe(true);
  });

  it("应包含通信+记忆净化测试", () => {
    expect(existsSync(join(testsDir, "comm-sanitize.test.ts"))).toBe(true);
  });

  it("应包含构建安全测试", () => {
    expect(existsSync(join(testsDir, "build.test.ts"))).toBe(true);
  });

  it("应包含工具链集成测试", () => {
    expect(existsSync(join(testsDir, "toolchain.test.ts"))).toBe(true);
  });

  it("应包含混淆兼容测试", () => {
    expect(existsSync(join(ROOT, "tests/communication/obfuscation-safe.test.ts"))).toBe(true);
  });

  it("安全测试文件总数应 >= 12", () => {
    const files = readdirSync(testsDir).filter((f) => f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(12);
  });
});

// ─── E.3: 源码安全基线验证 ───

function collectFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...collectFiles(full, ext));
      } else if (entry.endsWith(ext)) {
        results.push(full);
      }
    }
  } catch {
    // 目录不存在时返回空
  }
  return results;
}

function searchInFiles(files: string[], pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    if (pattern.test(content)) {
      matches.push(file);
    }
    pattern.lastIndex = 0;
  }
  return matches;
}

describe("E.3: 源码安全基线", { timeout: 30_000 }, () => {
  it("src/ 中不应包含外部项目引用", () => {
    const srcFiles = collectFiles(join(ROOT, "src"), ".ts");
    const matches = searchInFiles(srcFiles, /claude-code|openclaw|HackerOne/);
    expect(matches).toEqual([]);
  });

  it("src/ 中不应包含硬编码 API Key 模式", () => {
    const srcFiles = collectFiles(join(ROOT, "src"), ".ts");
    const matches = searchInFiles(srcFiles, /sk-ant-api03-[a-zA-Z0-9]/);
    expect(matches).toEqual([]);
  });

  it("dist/ 中不应包含 .map 文件", () => {
    const mapFiles = collectFiles(join(ROOT, "dist"), ".map");
    expect(mapFiles.length).toBe(0);
  });
});

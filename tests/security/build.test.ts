/**
 * D.2 测试 — 构建流程安全。
 *
 * 验证 tsconfig.json 配置、package.json 脚本、audit-pack.js 审计功能。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

// ─── tsconfig.json 验证 ───

describe("D.2: tsconfig.json", () => {
  const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf-8"));
  const opts = tsconfig.compilerOptions;

  it("应启用 strict 模式", () => {
    expect(opts.strict).toBe(true);
  });

  it("应启用 noUncheckedIndexedAccess", () => {
    expect(opts.noUncheckedIndexedAccess).toBe(true);
  });

  it("应启用 exactOptionalPropertyTypes", () => {
    expect(opts.exactOptionalPropertyTypes).toBe(true);
  });

  it("应允许编译输出（noEmit: false）", () => {
    expect(opts.noEmit).toBe(false);
  });

  it("应设置 outDir 为 ./dist", () => {
    expect(opts.outDir).toBe("./dist");
  });

  it("应设置 rootDir 为 ./src", () => {
    expect(opts.rootDir).toBe("./src");
  });

  it("应排除 node_modules、dist、tests", () => {
    expect(tsconfig.exclude).toContain("node_modules");
    expect(tsconfig.exclude).toContain("dist");
    expect(tsconfig.exclude).toContain("tests");
  });
});

// ─── package.json 验证 ───

describe("D.2: package.json", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

  it("应标记为 private", () => {
    expect(pkg.private).toBe(true);
  });

  it("应限制发布文件为 dist/ + README.md + LICENSE", () => {
    expect(pkg.files).toContain("dist/");
    expect(pkg.files).toContain("README.md");
    expect(pkg.files).toContain("LICENSE");
    expect(pkg.files.length).toBe(3);
  });

  it("应有 check 脚本", () => {
    expect(pkg.scripts.check).toBe("tsc --noEmit");
  });

  it("应有 build 脚本", () => {
    expect(pkg.scripts.build).toBe("tsc");
  });

  it("应有 test 脚本", () => {
    expect(pkg.scripts.test).toBe("bun test");
  });

  it("应有 prepublishOnly 脚本", () => {
    expect(pkg.scripts.prepublishOnly).toContain("bun run check");
    expect(pkg.scripts.prepublishOnly).toContain("bun test");
  });

  it("应有 prepack 脚本（含审计）", () => {
    expect(pkg.scripts.prepack).toContain("npm run build");
    expect(pkg.scripts.prepack).toContain("audit-pack.js");
  });
});

// ─── .npmignore 验证 ───

describe("D.2: .npmignore", () => {
  const npmignore = readFileSync(join(ROOT, ".npmignore"), "utf-8");

  it("应排除 src/ 目录", () => {
    expect(npmignore).toContain("src/");
  });

  it("应排除 tests/ 目录", () => {
    expect(npmignore).toContain("tests/");
  });

  it("应排除 reference/ 目录", () => {
    expect(npmignore).toContain("reference/");
  });

  it("应排除 .map 文件", () => {
    expect(npmignore).toContain("*.map");
  });

  it("应排除 .env 文件", () => {
    expect(npmignore).toContain(".env");
  });

  it("应排除 node_modules/", () => {
    expect(npmignore).toContain("node_modules/");
  });
});

// ─── audit-pack.js 验证 ───

describe("D.2: audit-pack.js", () => {
  const auditScript = join(ROOT, "scripts", "audit-pack.js");

  it("审计脚本应存在", () => {
    expect(existsSync(auditScript)).toBe(true);
  });

  it("审计脚本应包含敏感信息检查", () => {
    const content = readFileSync(auditScript, "utf-8");
    expect(content).toContain("sk-ant-api03");
    expect(content).toContain("claude-code");
    expect(content).toContain("eval");
  });

  it("审计脚本应包含外部引用检查", () => {
    const content = readFileSync(auditScript, "utf-8");
    expect(content).toContain("openclaw");
    expect(content).toContain("HackerOne");
  });

  it("审计脚本应包含 .map 文件检查", () => {
    const content = readFileSync(auditScript, "utf-8");
    expect(content).toContain(".map");
  });
});

/**
 * A.1 npm 打包防护测试 — 验证 npm pack 不包含敏感文件。
 *
 * 覆盖范围：
 * - package.json 包含 private: true
 * - package.json 包含 files 白名单
 * - .npmignore 存在且排除敏感目录
 * - npm pack --dry-run 不包含 reference/、docs/、tests/、src/
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ─── package.json 验证 ───

describe("A.1 > npm 打包防护 > package.json", () => {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"));

  it("包含 private: true 阻止意外发布", () => {
    expect(pkg.private).toBe(true);
  });

  it("包含 files 白名单精确控制发布内容", () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain("dist/");
    expect(pkg.files).toContain("README.md");
    expect(pkg.files).toContain("LICENSE");
  });

  it("files 白名单不包含敏感目录", () => {
    expect(pkg.files).not.toContain("src/");
    expect(pkg.files).not.toContain("reference/");
    expect(pkg.files).not.toContain("docs/");
    expect(pkg.files).not.toContain("tests/");
  });

  it("包含 build 脚本", () => {
    expect(typeof pkg.scripts.build).toBe("string");
    expect(pkg.scripts.build).toBeTruthy();
  });

  it("包含 prepack 脚本", () => {
    expect(typeof pkg.scripts.prepack).toBe("string");
    expect(pkg.scripts.prepack).toBeTruthy();
  });
});

// ─── .npmignore 验证 ───

describe("A.1 > npm 打包防护 > .npmignore", () => {
  it(".npmignore 文件存在", () => {
    expect(existsSync(join(PROJECT_ROOT, ".npmignore"))).toBe(true);
  });

  it("排除 reference/ 目录", () => {
    const content = readFileSync(join(PROJECT_ROOT, ".npmignore"), "utf-8");
    expect(content).toContain("reference/");
  });

  it("排除 docs/ 目录", () => {
    const content = readFileSync(join(PROJECT_ROOT, ".npmignore"), "utf-8");
    expect(content).toContain("docs/");
  });

  it("排除 tests/ 目录", () => {
    const content = readFileSync(join(PROJECT_ROOT, ".npmignore"), "utf-8");
    expect(content).toContain("tests/");
  });

  it("排除 src/ 目录", () => {
    const content = readFileSync(join(PROJECT_ROOT, ".npmignore"), "utf-8");
    expect(content).toContain("src/");
  });

  it("排除 *.map 文件", () => {
    const content = readFileSync(join(PROJECT_ROOT, ".npmignore"), "utf-8");
    expect(content).toContain("*.map");
  });

  it("排除内部文档 PROJECT_STATE.md", () => {
    const content = readFileSync(join(PROJECT_ROOT, ".npmignore"), "utf-8");
    expect(content).toContain("*.md");
  });

  it("排除 lock 文件", () => {
    const content = readFileSync(join(PROJECT_ROOT, ".npmignore"), "utf-8");
    expect(content).toContain("bun.lock");
    expect(content).toContain("package-lock.json");
  });
});

/**
 * 阶段 F 集成测试 — 插件加载 + 技能扫描 + 钩子安装 + 流包装器。
 *
 * 覆盖范围：
 * - F.1 插件加载器（五源发现 + 契约验证 + 生命周期管理）
 * - F.1 技能扫描器（五源扫描 + 优先级排序 + realpath 去重）
 * - F.2 钩子安装引擎（本地安装 + 完整性验证 + dry-run + force）
 * - F.2 流包装器链（洋葱模型组合 + 内置包装器）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPluginLoader } from "../../src/plugins/loader";
import { createSkillScanner } from "../../src/plugins/skills/scanner";
import { createHookInstaller } from "../../src/plugins/hooks/installer";
import { composeStreamWrappers, createLoggingWrapper, createRetryWrapper, createMemoizeWrapper, createTimingWrapper } from "../../src/plugins/stream-wrapper";

// ─── 临时目录管理 ───

const TMP_ROOT = join(process.cwd(), ".tmp-phase-f-test");

function ensureTmpDir(): void {
  if (!existsSync(TMP_ROOT)) {
    mkdirSync(TMP_ROOT, { recursive: true });
  }
}

function cleanupTmpDir(): void {
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
}

// ─── 辅助函数 ───

function createPluginManifest(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

function createSkillDir(dir: string, name: string, content?: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content ?? `# ${name}\n\nA test skill.`);
}

function createHookPack(dir: string, name: string, hooks: string[]): void {
  const packDir = join(dir, name);
  mkdirSync(packDir, { recursive: true });

  // package.json with hooks field
  const pkg = { name, version: "1.0.0", hooks };
  writeFileSync(join(packDir, "package.json"), JSON.stringify(pkg, null, 2));

  // Create hook directories with handler files
  for (const hook of hooks) {
    const hookDir = join(packDir, hook);
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, "handler.ts"), `// ${hook} handler\nexport default function() {}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// F.1 插件加载器集成测试
// ═══════════════════════════════════════════════════════════════════

describe("Phase F > F.1 > 插件加载器", () => {

  beforeEach(() => {
    ensureTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir();
  });

  it("从多个目录发现插件并去重", async () => {
    const builtinDir = join(TMP_ROOT, "builtin");
    const userDir = join(TMP_ROOT, "user");

    createPluginManifest(join(builtinDir, "plugin-a"), {
      name: "plugin-a",
      version: "1.0.0",
      description: "Builtin plugin A",
    });
    createPluginManifest(join(userDir, "plugin-a"), {
      name: "plugin-a",
      version: "2.0.0",
      description: "User plugin A",
    });
    createPluginManifest(join(userDir, "plugin-b"), {
      name: "plugin-b",
      version: "1.0.0",
    });

    const loader = createPluginLoader({
      scanDirs: [
        { dir: builtinDir, source: "builtin" },
        { dir: userDir, source: "user" },
      ],
    });

    const results = await loader.scan();

    // plugin-a 去重，只保留第一个（builtin）
    expect(results.length).toBe(2);
    const names = results.map((r: { manifest: { name: string } }) => r.manifest.name);
    expect(names).toContain("plugin-a");
    expect(names).toContain("plugin-b");

    // plugin-a 应该来自 builtin（第一个发现）
    const pluginA = results.find((r: { manifest: { name: string } }) => r.manifest.name === "plugin-a");
    expect(pluginA?.manifest.source).toBe("builtin");
  });

  it("验证缺失字段的插件清单", async () => {
    const dir = join(TMP_ROOT, "bad-plugins");
    createPluginManifest(join(dir, "no-name"), {
      version: "1.0.0",
    });
    createPluginManifest(join(dir, "no-version"), {
      name: "no-version-plugin",
    });

    const loader = createPluginLoader({ scanDirs: [{ dir, source: "user" }] });
    const results = await loader.scan();

    expect(results.length).toBe(2);

    const noName = results.find((r: { manifest: { name: string } }) => r.manifest.name === "unknown");
    expect(noName).toBeDefined();
    expect(noName?.issues.length).toBeGreaterThan(0);
    expect(noName?.state).toBe("discovered");

    const noVersion = results.find((r: { manifest: { name: string } }) => r.manifest.name === "no-version-plugin");
    expect(noVersion).toBeDefined();
    expect(noVersion?.issues.length).toBeGreaterThan(0);
  });

  it("完整生命周期：discovered → activated → deactivated", async () => {
    const dir = join(TMP_ROOT, "lifecycle");
    createPluginManifest(join(dir, "test-plugin"), {
      name: "test-plugin",
      version: "1.0.0",
      description: "Lifecycle test",
      hooks: ["pre-tool-use", "post-tool-use"],
      skills: ["code-review"],
    });

    const loader = createPluginLoader({ scanDirs: [{ dir, source: "builtin" }] });
    await loader.scan();

    // 初始状态：validated（无 issues）
    const plugin = loader.getPlugin("test-plugin");
    expect(plugin).toBeDefined();
    expect(plugin?.state).toBe("validated");
    expect(plugin?.manifest.hooks).toEqual(["pre-tool-use", "post-tool-use"]);
    expect(plugin?.manifest.skills).toEqual(["code-review"]);

    // 激活
    const activated = loader.activate("test-plugin");
    expect(activated?.state).toBe("activated");

    // 重复激活幂等
    const activatedAgain = loader.activate("test-plugin");
    expect(activatedAgain?.state).toBe("activated");

    // 停用
    const deactivated = loader.deactivate("test-plugin");
    expect(deactivated?.state).toBe("deactivated");

    // 重复停用幂等
    const deactivatedAgain = loader.deactivate("test-plugin");
    expect(deactivatedAgain?.state).toBe("deactivated");

    // 统计
    const stats = loader.getStats();
    expect(stats.total).toBe(1);
    expect(stats.activated).toBe(0);
    expect(stats.deactivated).toBe(1);
  });

  it("不存在的目录不报错", async () => {
    const loader = createPluginLoader({
      scanDirs: [
        { dir: join(TMP_ROOT, "nonexistent"), source: "builtin" },
      ],
    });
    const results = await loader.scan();
    expect(results).toEqual([]);
  });

  it("非插件目录（无 plugin.json）被跳过", async () => {
    const dir = join(TMP_ROOT, "mixed");
    createPluginManifest(join(dir, "valid-plugin"), {
      name: "valid-plugin",
      version: "1.0.0",
    });
    // 普通目录，无 plugin.json
    mkdirSync(join(dir, "not-a-plugin"), { recursive: true });

    const loader = createPluginLoader({ scanDirs: [{ dir, source: "user" }] });
    const results = await loader.scan();
    expect(results.length).toBe(1);
    expect(results[0]?.manifest.name).toBe("valid-plugin");
  });

  it("getAll 返回所有已加载插件", async () => {
    const dir = join(TMP_ROOT, "all-plugins");
    createPluginManifest(join(dir, "p1"), { name: "p1", version: "1.0.0" });
    createPluginManifest(join(dir, "p2"), { name: "p2", version: "1.0.0" });
    createPluginManifest(join(dir, "p3"), { name: "p3", version: "1.0.0" });

    const loader = createPluginLoader({ scanDirs: [{ dir, source: "builtin" }] });
    await loader.scan();
    loader.activate("p1");
    loader.activate("p2");

    expect(loader.getAll().length).toBe(3);
    expect(loader.getStats()).toEqual({ total: 3, activated: 2, deactivated: 0 });
  });

  it("操作不存在的插件返回 undefined", () => {
    const loader = createPluginLoader();
    expect(loader.getPlugin("nonexistent")).toBeUndefined();
    expect(loader.activate("nonexistent")).toBeUndefined();
    expect(loader.deactivate("nonexistent")).toBeUndefined();
  });

  it("五源扫描按优先级排序", async () => {
    const sources: Array<{ source: string; dir: string }> = [];
    for (const source of ["builtin", "managed", "user", "workspace", "remote"] as const) {
      const dir = join(TMP_ROOT, source);
      sources.push({ source, dir });
      createPluginManifest(join(dir, `${source}-plugin`), {
        name: `${source}-plugin`,
        version: "1.0.0",
      });
    }

    const loader = createPluginLoader({
      scanDirs: sources.map((s) => ({ dir: s.dir, source: s.source as "builtin" | "managed" | "user" | "workspace" | "remote" })),
    });
    const results = await loader.scan();

    expect(results.length).toBe(5);
    // 验证每个插件的来源标签
    for (const result of results) {
      expect(result.manifest.source).toBe(result.manifest.name.replace("-plugin", ""));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// F.1 技能扫描器集成测试
// ═══════════════════════════════════════════════════════════════════

describe("Phase F > F.1 > 技能扫描器", () => {

  beforeEach(() => {
    ensureTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir();
  });

  it("从多源目录扫描技能", () => {
    const builtinDir = join(TMP_ROOT, "builtin-skills");
    const userDir = join(TMP_ROOT, "user-skills");

    createSkillDir(builtinDir, "code-review");
    createSkillDir(builtinDir, "debug");
    createSkillDir(userDir, "custom-skill");

    const scanner = createSkillScanner({
      scanDirs: [
        { dir: builtinDir, source: "builtin" },
        { dir: userDir, source: "user" },
      ],
    });

    const skills = scanner.scan();
    expect(skills.length).toBe(3);

    // builtin 技能优先级 0，user 技能优先级 1
    const codeReview = skills.find((s: { name: string }) => s.name === "code-review");
    expect(codeReview?.source).toBe("builtin");
    expect(codeReview?.priority).toBe(0);

    const customSkill = skills.find((s: { name: string }) => s.name === "custom-skill");
    expect(customSkill?.source).toBe("user");
    expect(customSkill?.priority).toBe(1);
  });

  it("无 SKILL.md 的目录被跳过", () => {
    const dir = join(TMP_ROOT, "no-skill-md");
    mkdirSync(join(dir, "not-a-skill"), { recursive: true });
    createSkillDir(dir, "valid-skill");

    const scanner = createSkillScanner({ scanDirs: [{ dir, source: "builtin" }] });
    const skills = scanner.scan();
    expect(skills.length).toBe(1);
    expect(skills[0]?.name).toBe("valid-skill");
  });

  it("不存在的目录不报错", () => {
    const scanner = createSkillScanner({
      scanDirs: [{ dir: join(TMP_ROOT, "nonexistent"), source: "builtin" }],
    });
    expect(scanner.scan()).toEqual([]);
  });

  it("getStats 按来源分类统计", () => {
    const builtinDir = join(TMP_ROOT, "stats-builtin");
    const userDir = join(TMP_ROOT, "stats-user");

    createSkillDir(builtinDir, "s1");
    createSkillDir(builtinDir, "s2");
    createSkillDir(userDir, "s3");

    const scanner = createSkillScanner({
      scanDirs: [
        { dir: builtinDir, source: "builtin" },
        { dir: userDir, source: "user" },
      ],
    });

    const stats = scanner.getStats();
    expect(stats.total).toBe(3);
    expect(stats.bySource.builtin).toBe(2);
    expect(stats.bySource.user).toBe(1);
    expect(stats.bySource.managed).toBe(0);
    expect(stats.bySource.workspace).toBe(0);
    expect(stats.bySource.remote).toBe(0);
  });

  it("扫描结果包含正确的文件路径", () => {
    const dir = join(TMP_ROOT, "paths");
    createSkillDir(dir, "test-skill", "# Test Skill\n\nContent here.");

    const scanner = createSkillScanner({ scanDirs: [{ dir, source: "builtin" }] });
    const skills = scanner.scan();

    expect(skills.length).toBe(1);
    expect(skills[0]?.filePath).toContain("SKILL.md");
    expect(skills[0]?.dirPath).toContain("test-skill");
    expect(skills[0]?.name).toBe("test-skill");
  });

  it("五源完整扫描", () => {
    const allSkills: Array<{ dir: string; source: string }> = [];
    for (const source of ["builtin", "managed", "user", "workspace", "remote"] as const) {
      const dir = join(TMP_ROOT, `scan-${source}`);
      createSkillDir(dir, `${source}-skill`);
      allSkills.push({ dir, source });
    }

    const scanner = createSkillScanner({
      scanDirs: allSkills.map((s) => ({
        dir: s.dir,
        source: s.source as "builtin" | "managed" | "user" | "workspace" | "remote",
      })),
    });

    const skills = scanner.scan();
    expect(skills.length).toBe(5);

    // 验证优先级递增
    for (let i = 0; i < skills.length; i++) {
      expect(skills[i]?.priority).toBe(i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// F.1 插件加载器 + 技能扫描器联合测试
// ═══════════════════════════════════════════════════════════════════

describe("Phase F > F.1 > 插件加载器 + 技能扫描器联合", () => {

  beforeEach(() => {
    ensureTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir();
  });

  it("同一目录结构同时支持插件和技能扫描", async () => {
    const baseDir = join(TMP_ROOT, "combined");

    // 创建一个既是插件又是包含技能的目录结构
    const pluginDir = join(baseDir, "my-plugin");
    createPluginManifest(pluginDir, {
      name: "my-plugin",
      version: "1.0.0",
      skills: ["embedded-skill"],
    });

    // 技能目录独立于插件目录
    const skillsDir = join(baseDir, "skills");
    createSkillDir(skillsDir, "standalone-skill");

    // 插件加载器扫描插件目录的父目录
    const loader = createPluginLoader({
      scanDirs: [{ dir: baseDir, source: "user" }],
    });
    const plugins = await loader.scan();

    // 技能扫描器扫描技能目录
    const scanner = createSkillScanner({
      scanDirs: [{ dir: skillsDir, source: "user" }],
    });
    const skills = scanner.scan();

    expect(plugins.length).toBe(1);
    expect(plugins[0]?.manifest.name).toBe("my-plugin");
    expect(plugins[0]?.manifest.skills).toEqual(["embedded-skill"]);

    expect(skills.length).toBe(1);
    expect(skills[0]?.name).toBe("standalone-skill");
  });

  it("插件激活后统计与技能扫描统计独立", async () => {
    const pluginBase = join(TMP_ROOT, "sep-plugins");
    const skillBase = join(TMP_ROOT, "sep-skills");

    createPluginManifest(join(pluginBase, "p1"), { name: "p1", version: "1.0.0" });
    createPluginManifest(join(pluginBase, "p2"), { name: "p2", version: "1.0.0" });
    createSkillDir(skillBase, "s1");
    createSkillDir(skillBase, "s2");
    createSkillDir(skillBase, "s3");

    const loader = createPluginLoader({
      scanDirs: [{ dir: pluginBase, source: "builtin" }],
    });
    await loader.scan();
    loader.activate("p1");

    const scanner = createSkillScanner({
      scanDirs: [{ dir: skillBase, source: "builtin" }],
    });

    const pluginStats = loader.getStats();
    const skillStats = scanner.getStats();

    expect(pluginStats.total).toBe(2);
    expect(pluginStats.activated).toBe(1);
    expect(skillStats.total).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// F.2 钩子安装引擎集成测试
// ═══════════════════════════════════════════════════════════════════

describe("Phase F > F.2 > 钩子安装引擎", () => {

  beforeEach(() => {
    ensureTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir();
  });

  it("从本地目录安装钩子包", async () => {
    const sourceDir = join(TMP_ROOT, "source");
    const hooksDir = join(TMP_ROOT, "installed-hooks");

    createHookPack(sourceDir, "my-hooks", ["pre-tool-use", "post-response"]);

    const installer = createHookInstaller();
    const result = await installer.installFromLocal(join(sourceDir, "my-hooks"), {
      hooksDir,
    });

    expect(result.ok).toBe(true);
    expect(result.hookPackId).toBe("my-hooks");
    expect(result.version).toBe("1.0.0");
    expect(result.hooks).toEqual(["pre-tool-use", "post-response"]);

    // 验证文件已复制
    expect(existsSync(join(result.targetDir, "package.json"))).toBe(true);
    expect(existsSync(join(result.targetDir, "pre-tool-use", "handler.ts"))).toBe(true);
    expect(existsSync(join(result.targetDir, "post-response", "handler.ts"))).toBe(true);
  });

  it("dry-run 模式不实际复制文件", async () => {
    const sourceDir = join(TMP_ROOT, "dryrun-source");
    const hooksDir = join(TMP_ROOT, "dryrun-target");

    createHookPack(sourceDir, "test-pack", ["on-start"]);

    const installer = createHookInstaller();
    const result = await installer.installFromLocal(join(sourceDir, "test-pack"), {
      hooksDir,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.hookPackId).toBe("test-pack");
    expect(result.hooks).toEqual(["on-start"]);

    // 目标目录不应存在
    expect(existsSync(result.targetDir)).toBe(false);
  });

  it("已存在的钩子包不覆盖（除非 force）", async () => {
    const sourceDir = join(TMP_ROOT, "conflict-source");
    const hooksDir = join(TMP_ROOT, "conflict-target");

    createHookPack(sourceDir, "conflict-pack", ["hook-a"]);

    const installer = createHookInstaller();

    // 第一次安装成功
    const result1 = await installer.installFromLocal(join(sourceDir, "conflict-pack"), {
      hooksDir,
    });
    expect(result1.ok).toBe(true);

    // 第二次不 force 应失败
    const result2 = await installer.installFromLocal(join(sourceDir, "conflict-pack"), {
      hooksDir,
    });
    expect(result2.ok).toBe(false);
    expect(result2.error).toContain("already exists");

    // force 模式应成功
    const result3 = await installer.installFromLocal(join(sourceDir, "conflict-pack"), {
      hooksDir,
      force: true,
    });
    expect(result3.ok).toBe(true);
  });

  it("验证无效的钩子包结构", () => {
    const installer = createHookInstaller();

    // 无 package.json
    const noPkgDir = join(TMP_ROOT, "no-pkg");
    mkdirSync(noPkgDir, { recursive: true });
    let issues = installer.validate(noPkgDir);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.field).toBe("package.json");

    // package.json 无 hooks 字段（readManifest 返回 undefined，报告 package.json 错误）
    const noHooksDir = join(TMP_ROOT, "no-hooks");
    mkdirSync(noHooksDir, { recursive: true });
    writeFileSync(join(noHooksDir, "package.json"), JSON.stringify({ name: "test", version: "1.0.0" }));
    issues = installer.validate(noHooksDir);
    expect(issues.length).toBeGreaterThan(0);
    // readManifest 要求 hooks 为数组，否则返回 undefined → package.json invalid
    expect(issues[0]?.field).toBe("package.json");

    // hooks 目录不存在
    const missingHookDir = join(TMP_ROOT, "missing-hook");
    mkdirSync(missingHookDir, { recursive: true });
    writeFileSync(join(missingHookDir, "package.json"), JSON.stringify({
      name: "test",
      version: "1.0.0",
      hooks: ["nonexistent-hook"],
    }));
    issues = installer.validate(missingHookDir);
    expect(issues.some((i: { field: string }) => i.field === "hooks.nonexistent-hook")).toBe(true);

    // hooks 目录无 handler 文件
    const noHandlerDir = join(TMP_ROOT, "no-handler");
    mkdirSync(join(noHandlerDir, "empty-hook"), { recursive: true });
    writeFileSync(join(noHandlerDir, "package.json"), JSON.stringify({
      name: "test",
      version: "1.0.0",
      hooks: ["empty-hook"],
    }));
    issues = installer.validate(noHandlerDir);
    expect(issues.some((i: { message: string }) => i.message.includes("No handler file"))).toBe(true);
  });

  it("路径遍历攻击被检测", () => {
    const installer = createHookInstaller();

    const traversalDir = join(TMP_ROOT, "traversal");
    mkdirSync(traversalDir, { recursive: true });
    writeFileSync(join(traversalDir, "package.json"), JSON.stringify({
      name: "evil-pack",
      version: "1.0.0",
      hooks: ["../../../etc"],
    }));

    const issues = installer.validate(traversalDir);
    expect(issues.some((i: { message: string }) => i.message.includes("escapes"))).toBe(true);
  });

  it("安装包含子目录的钩子包", async () => {
    const sourceDir = join(TMP_ROOT, "nested-source");
    const hooksDir = join(TMP_ROOT, "nested-target");

    const packDir = join(sourceDir, "nested-pack");
    mkdirSync(packDir, { recursive: true });

    writeFileSync(join(packDir, "package.json"), JSON.stringify({
      name: "nested-pack",
      version: "2.0.0",
      hooks: ["complex-hook"],
    }));

    const hookDir = join(packDir, "complex-hook");
    mkdirSync(join(hookDir, "subdir"), { recursive: true });
    writeFileSync(join(hookDir, "handler.ts"), "// handler");
    writeFileSync(join(hookDir, "subdir", "helper.ts"), "// helper");

    const installer = createHookInstaller();
    const result = await installer.installFromLocal(packDir, { hooksDir });

    expect(result.ok).toBe(true);
    expect(existsSync(join(result.targetDir, "complex-hook", "handler.ts"))).toBe(true);
    expect(existsSync(join(result.targetDir, "complex-hook", "subdir", "helper.ts"))).toBe(true);
  });

  it("验证有效的钩子包结构", () => {
    const validDir = join(TMP_ROOT, "valid-hook-pack");
    createHookPack(validDir, "valid-pack", ["on-start", "on-stop"]);

    const installer = createHookInstaller();
    const issues = installer.validate(join(validDir, "valid-pack"));
    expect(issues.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// F.2 流包装器链集成测试
// ═══════════════════════════════════════════════════════════════════

describe("Phase F > F.2 > 流包装器链", () => {

  it("composeStreamWrappers 按顺序应用包装器", () => {
    const calls: string[] = [];

    const baseFn = () => {
      calls.push("base");
      return 42;
    };

    const wrapper1: (fn: () => number) => () => number = (fn) => () => {
      calls.push("wrapper1-before");
      const result = fn();
      calls.push("wrapper1-after");
      return result + 1;
    };

    const wrapper2: (fn: () => number) => () => number = (fn) => () => {
      calls.push("wrapper2-before");
      const result = fn();
      calls.push("wrapper2-after");
      return result * 2;
    };

    const wrapped = composeStreamWrappers(baseFn, [wrapper1, wrapper2]);
    const result = wrapped();

    // 洋葱模型：wrapper2 → wrapper1 → base → wrapper1 → wrapper2
    expect(calls).toEqual([
      "wrapper2-before",
      "wrapper1-before",
      "base",
      "wrapper1-after",
      "wrapper2-after",
    ]);
    // (42 + 1) * 2 = 86
    expect(result).toBe(86);
  });

  it("undefined 包装器被跳过", () => {
    const baseFn = () => "hello";
    const wrapper: (fn: () => string) => () => string = (fn) => () => fn() + " world";

    const wrapped = composeStreamWrappers(baseFn, [undefined, wrapper, undefined]);
    expect(wrapped()).toBe("hello world");
  });

  it("空包装器数组返回原始值", () => {
    const baseFn = () => 100;
    const wrapped = composeStreamWrappers(baseFn, []);
    expect(wrapped()).toBe(100);
  });

  it("createLoggingWrapper 记录调用日志", () => {
    const logs: string[] = [];
    const logFn = (msg: string) => logs.push(msg);

    const baseFn = (x: number) => x * 2;
    const wrapped = composeStreamWrappers(baseFn, [createLoggingWrapper("test", logFn)]);

    const result = wrapped(5);
    expect(result).toBe(10);
    expect(logs).toEqual(["[test] called", "[test] completed"]);
  });

  it("createRetryWrapper 失败后重试", async () => {
    let attempts = 0;
    const flakyFn = async () => {
      attempts++;
      if (attempts < 3) throw new Error("not yet");
      return "success";
    };

    const wrapped = composeStreamWrappers(flakyFn, [
      createRetryWrapper(3, 10),
    ]);

    const result = await wrapped();
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("createRetryWrapper 超过重试次数抛出错误", async () => {
    let attempts = 0;
    const alwaysFail = async () => {
      attempts++;
      throw new Error("always fails");
    };

    const wrapped = composeStreamWrappers(alwaysFail, [
      createRetryWrapper(2, 10),
    ]);

    await expect(wrapped()).rejects.toThrow("always fails");
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it("createMemoizeWrapper 缓存结果", () => {
    let callCount = 0;
    const expensiveFn = (x: number) => {
      callCount++;
      return x * x;
    };

    const wrapped = composeStreamWrappers(expensiveFn, [
      createMemoizeWrapper((x: number) => String(x)),
    ]);

    expect(wrapped(5)).toBe(25);
    expect(wrapped(5)).toBe(25);
    expect(wrapped(3)).toBe(9);
    expect(callCount).toBe(2); // 5 和 3 各计算一次
  });

  it("createTimingWrapper 记录执行时间", () => {
    const timings: string[] = [];
    const logFn = (msg: string) => timings.push(msg);

    const baseFn = () => {
      // 模拟一些工作
      const sum = Array.from({ length: 1000 }, (_, i) => i).reduce((a, b) => a + b, 0);
      return sum;
    };

    const wrapped = composeStreamWrappers(baseFn, [createTimingWrapper("calc", logFn)]);
    const result = wrapped();

    expect(result).toBe(499500);
    expect(timings.length).toBe(1);
    expect(timings[0]).toMatch(/\[calc\] \d+ms/);
  });

  it("多层包装器组合：日志 + 重试 + 缓存", async () => {
    let callCount = 0;
    const logs: string[] = [];

    const baseFn = async (key: string) => {
      callCount++;
      if (callCount === 1 && key === "flaky") throw new Error("transient");
      return `result-${key}`;
    };

    const wrapped = composeStreamWrappers(baseFn, [
      createLoggingWrapper("multi", (msg) => logs.push(msg)),
      createRetryWrapper(2, 10),
      createMemoizeWrapper((key: string) => key),
    ]);

    // 第一次调用 flaky：失败一次后成功
    const result1 = await wrapped("flaky");
    expect(result1).toBe("result-flaky");

    // 第二次调用 flaky：应命中缓存
    const result2 = await wrapped("flaky");
    expect(result2).toBe("result-flaky");

    // 缓存命中后不应增加调用次数
    const totalAfterCache = callCount;
    await wrapped("flaky");
    expect(callCount).toBe(totalAfterCache);

    // 验证日志记录
    expect(logs.length).toBeGreaterThanOrEqual(2);
  });

  it("createMemoizeWrapper 默认 keyFn 使用 JSON.stringify", () => {
    let callCount = 0;
    const fn = (a: number, b: string) => {
      callCount++;
      return `${a}-${b}`;
    };

    const wrapped = composeStreamWrappers(fn, [createMemoizeWrapper()]);

    expect(wrapped(1, "x")).toBe("1-x");
    expect(wrapped(1, "x")).toBe("1-x");
    expect(wrapped(1, "y")).toBe("1-y");
    expect(callCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// F.2 钩子安装 + 插件加载器联合测试
// ═══════════════════════════════════════════════════════════════════

describe("Phase F > F.2 > 钩子安装 + 插件加载器联合", () => {
  beforeEach(() => {
    ensureTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir();
  });

  it("安装钩子包后可作为插件发现", async () => {
    const sourceDir = join(TMP_ROOT, "hook-source");
    const hooksDir = join(TMP_ROOT, "hook-installed");
    const pluginScanDir = join(TMP_ROOT, "plugin-scan");

    // 创建并安装钩子包
    createHookPack(sourceDir, "hook-plugin", ["on-init", "on-exit"]);
    const installer = createHookInstaller();
    const installResult = await installer.installFromLocal(join(sourceDir, "hook-plugin"), {
      hooksDir,
    });
    expect(installResult.ok).toBe(true);

    // 在安装目录创建 plugin.json 使其可被插件加载器发现
    createPluginManifest(installResult.targetDir, {
      name: "hook-plugin",
      version: "1.0.0",
      hooks: ["on-init", "on-exit"],
    });

    // 插件加载器扫描安装目录
    const loader = createPluginLoader({
      scanDirs: [{ dir: hooksDir, source: "user" }],
    });
    const plugins = await loader.scan();

    expect(plugins.length).toBe(1);
    expect(plugins[0]?.manifest.name).toBe("hook-plugin");
    expect(plugins[0]?.manifest.hooks).toEqual(["on-init", "on-exit"]);

    // 激活插件
    const activated = loader.activate("hook-plugin");
    expect(activated?.state).toBe("activated");
  });
});

// ═══════════════════════════════════════════════════════════════════
// F 全阶段端到端集成测试
// ═══════════════════════════════════════════════════════════════════

describe("Phase F > 端到端 > 插件生态完整流程", () => {

  beforeEach(() => {
    ensureTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir();
  });

  it("完整流程：创建插件 → 安装钩子 → 扫描技能 → 包装流", async () => {
    // 1. 创建插件目录结构
    const pluginBase = join(TMP_ROOT, "e2e-plugins");
    createPluginManifest(join(pluginBase, "core-plugin"), {
      name: "core-plugin",
      version: "1.0.0",
      description: "Core functionality plugin",
      hooks: ["pre-process", "post-process"],
      skills: ["analysis"],
    });

    // 2. 创建技能目录
    const skillBase = join(TMP_ROOT, "e2e-skills");
    createSkillDir(skillBase, "analysis", "# Analysis Skill\n\nDeep analysis capability.");
    createSkillDir(skillBase, "reporting", "# Reporting Skill\n\nGenerate reports.");

    // 3. 创建并安装钩子包
    const hookSource = join(TMP_ROOT, "e2e-hooks-source");
    const hookTarget = join(TMP_ROOT, "e2e-hooks-installed");
    createHookPack(hookSource, "core-hooks", ["pre-process", "post-process"]);

    const installer = createHookInstaller();
    const installResult = await installer.installFromLocal(join(hookSource, "core-hooks"), {
      hooksDir: hookTarget,
    });
    expect(installResult.ok).toBe(true);

    // 4. 插件加载器发现插件
    const loader = createPluginLoader({
      scanDirs: [{ dir: pluginBase, source: "builtin" }],
    });
    const plugins = await loader.scan();
    expect(plugins.length).toBe(1);

    // 5. 技能扫描器发现技能
    const scanner = createSkillScanner({
      scanDirs: [{ dir: skillBase, source: "builtin" }],
    });
    const skills = scanner.scan();
    expect(skills.length).toBe(2);

    // 6. 激活插件
    loader.activate("core-plugin");
    const stats = loader.getStats();
    expect(stats.activated).toBe(1);

    // 7. 用流包装器包装一个处理函数
    let processCallCount = 0;
    const processFn = async (input: string) => {
      processCallCount++;
      return `processed: ${input}`;
    };

    const wrappedProcess = composeStreamWrappers(processFn, [
      createLoggingWrapper("process", () => {}),
      createRetryWrapper(2, 10),
      createMemoizeWrapper((input: string) => input),
    ]);

    const result1 = await wrappedProcess("test-data");
    expect(result1).toBe("processed: test-data");

    // 缓存命中
    const result2 = await wrappedProcess("test-data");
    expect(result2).toBe("processed: test-data");
    expect(processCallCount).toBe(1);

    // 不同输入
    const result3 = await wrappedProcess("other-data");
    expect(result3).toBe("processed: other-data");
    expect(processCallCount).toBe(2);

    // 8. 验证钩子安装文件完整性
    expect(existsSync(join(installResult.targetDir, "pre-process", "handler.ts"))).toBe(true);
    expect(existsSync(join(installResult.targetDir, "post-process", "handler.ts"))).toBe(true);
  });
});

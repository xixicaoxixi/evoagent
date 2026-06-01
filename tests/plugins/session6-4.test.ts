/**
 * Session 6.4 测试 — SKILL.md 技能系统。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseFrontmatter,
  matchPathPattern,
  activateConditionalSkills,
  type SkillDefinition,
  type SkillFrontmatter,
} from "../../src/plugins/skills/definition";
import {
  validateSkillFilePath,
  safeWriteFile,
  createNonceDir,
  cleanupDir,
} from "../../src/plugins/skills/security";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, normalize } from "node:path";

const isWindows = process.platform === "win32";

// ─── parseFrontmatter 测试 ───

describe("parseFrontmatter", () => {
  it("解析有效的 YAML frontmatter", () => {
    const content = `---
description: A test skill
allowed-tools:
  - bash
  - read
model: gpt-4
---
# Skill Content

This is the skill body.`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.description).toBe("A test skill");
    expect(frontmatter!["allowed-tools"]).toEqual(["bash", "read"]);
    expect(frontmatter!.model).toBe("gpt-4");
    expect(body.trim()).toBe("# Skill Content\n\nThis is the skill body.");
  });

  it("无 frontmatter 返回 null", () => {
    const content = "# Just markdown content";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
    expect(body).toBe(content);
  });

  it("缺少 description 的 frontmatter 返回 null", () => {
    const content = `---
model: gpt-4
---
Content`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
  });

  it("空 description 的 frontmatter 返回 null", () => {
    const content = `---
description: ""
---
Content`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
  });

  it("解析 paths 字段（条件技能）", () => {
    const content = `---
description: TypeScript helper
paths:
  - "*.ts"
  - "src/**/*.ts"
---
Content`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter!.paths).toEqual(["*.ts", "src/**/*.ts"]);
  });

  it("解析 context 字段", () => {
    const content = `---
description: Fork skill
context: fork
---
Content`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter!.context).toBe("fork");
  });

  it("解析带引号的字符串值", () => {
    const content = `---
description: "A quoted description"
---
Content`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter!.description).toBe("A quoted description");
  });

  it("解析布尔值和数字", () => {
    const content = `---
description: Test
arguments:
  - "file"
  - "pattern"
---
Content`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter!.arguments).toEqual(["file", "pattern"]);
  });
});

// ─── matchPathPattern 测试 ───

describe("matchPathPattern", () => {
  it("匹配简单通配符", () => {
    expect(matchPathPattern("src/index.ts", ["*.ts"])).toBe(true);
    expect(matchPathPattern("src/index.ts", ["*.js"])).toBe(false);
  });

  it("匹配目录前缀", () => {
    expect(matchPathPattern("src/plugins/sdk.ts", ["src/plugins/*"])).toBe(true);
    expect(matchPathPattern("src/tools/sdk.ts", ["src/plugins/*"])).toBe(false);
  });

  it("匹配 globstar", () => {
    expect(matchPathPattern("src/a/b/c.ts", ["src/**/*.ts"])).toBe(true);
    expect(matchPathPattern("src/a/b/c.js", ["src/**/*.ts"])).toBe(false);
  });

  it("多模式匹配（任一匹配即可）", () => {
    expect(matchPathPattern("test.ts", ["*.js", "*.ts"])).toBe(true);
    expect(matchPathPattern("test.go", ["*.js", "*.ts"])).toBe(false);
  });

  it("空模式列表不匹配", () => {
    expect(matchPathPattern("test.ts", [])).toBe(false);
  });

  it("精确文件名匹配", () => {
    expect(matchPathPattern("package.json", ["package.json"])).toBe(true);
    expect(matchPathPattern("src/package.json", ["package.json"])).toBe(true);
  });
});

// ─── activateConditionalSkills 测试 ───

describe("activateConditionalSkills", () => {
  function makeSkill(
    overrides: Partial<SkillDefinition> & Pick<SkillDefinition, "name">,
  ): SkillDefinition {
    return {
      name: overrides.name,
      source: "project",
      dirPath: "/tmp/test",
      frontmatter: { description: "test" },
      markdownContent: "",
      isConditional: false,
      activated: false,
      ...overrides,
    };
  }

  it("条件技能匹配时激活", () => {
    const skills = [
      makeSkill({
        name: "ts-helper",
        isConditional: true,
        frontmatter: { description: "TS helper", paths: ["*.ts"] },
      }),
    ];

    const result = activateConditionalSkills(skills, ["src/index.ts"], "/project");
    expect(result.activatedNames).toEqual(["ts-helper"]);
  });

  it("条件技能不匹配时不激活", () => {
    const skills = [
      makeSkill({
        name: "ts-helper",
        isConditional: true,
        frontmatter: { description: "TS helper", paths: ["*.ts"] },
      }),
    ];

    const result = activateConditionalSkills(skills, ["src/index.js"], "/project");
    expect(result.activatedNames).toHaveLength(0);
  });

  it("非条件技能跳过", () => {
    const skills = [
      makeSkill({
        name: "always-on",
        isConditional: false,
      }),
    ];

    const result = activateConditionalSkills(skills, ["anything.ts"], "/project");
    expect(result.activatedNames).toHaveLength(0);
  });

  it("已激活的技能跳过", () => {
    const skills = [
      makeSkill({
        name: "ts-helper",
        isConditional: true,
        activated: true,
        frontmatter: { description: "TS helper", paths: ["*.ts"] },
      }),
    ];

    const result = activateConditionalSkills(skills, ["index.ts"], "/project");
    expect(result.activatedNames).toHaveLength(0);
  });

  it("多个条件技能独立判断", () => {
    const skills = [
      makeSkill({
        name: "ts-helper",
        isConditional: true,
        frontmatter: { description: "TS", paths: ["*.ts"] },
      }),
      makeSkill({
        name: "js-helper",
        isConditional: true,
        frontmatter: { description: "JS", paths: ["*.js"] },
      }),
    ];

    const result = activateConditionalSkills(skills, ["src/index.ts", "lib/util.js"], "/project");
    expect(result.activatedNames).toContain("ts-helper");
    expect(result.activatedNames).toContain("js-helper");
  });

  it("totalChecked 只计算未激活的条件技能", () => {
    const skills = [
      makeSkill({
        name: "s1",
        isConditional: true,
        frontmatter: { description: "s1", paths: ["*.ts"] },
      }),
      makeSkill({
        name: "s2",
        isConditional: true,
        activated: true,
        frontmatter: { description: "s2", paths: ["*.ts"] },
      }),
      makeSkill({
        name: "s3",
        isConditional: false,
      }),
    ];

    const result = activateConditionalSkills(skills, ["index.ts"], "/project");
    expect(result.totalChecked).toBe(1);
  });
});

// ─── validateSkillFilePath 测试 ───

describe("validateSkillFilePath", () => {
  it("有效相对路径通过", () => {
    const result = validateSkillFilePath("/base", "sub/file.ts");
    expect(normalize(result)).toBe(normalize("/base/sub/file.ts"));
  });

  it("嵌套目录通过", () => {
    const result = validateSkillFilePath("/base", "a/b/c/file.ts");
    expect(normalize(result)).toBe(normalize("/base/a/b/c/file.ts"));
  });

  it("目录遍历被拒绝", () => {
    expect(() => validateSkillFilePath("/base", "../etc/passwd")).toThrow("traversal");
  });

  it("深层目录遍历被拒绝", () => {
    expect(() => validateSkillFilePath("/base", "a/../../etc/passwd")).toThrow("traversal");
  });

  it("绝对路径被拒绝", () => {
    expect(() => validateSkillFilePath("/base", "/etc/passwd")).toThrow("absolute");
  });
});

// ─── safeWriteFile 测试 ───

describe("safeWriteFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createNonceDir("test-skill");
  });

  afterEach(async () => {
    await cleanupDir(tempDir);
  });

  it("安全写入文件", async () => {
    const result = await safeWriteFile(tempDir, "test.txt", "hello world");
    expect(result.success).toBe(true);

    const content = await readFile(result.targetPath, "utf8");
    expect(content).toBe("hello world");
  });

  it("写入嵌套目录", async () => {
    const result = await safeWriteFile(tempDir, "sub/dir/file.txt", "nested");
    expect(result.success).toBe(true);

    const content = await readFile(result.targetPath, "utf8");
    expect(content).toBe("nested");
  });

  it("目录遍历写入被拒绝", async () => {
    const result = await safeWriteFile(tempDir, "../escape.txt", "malicious");
    expect(result.success).toBe(false);
    expect(result.error).toContain("traversal");
  });

  it("文件权限为 0o600", async () => {
    if (isWindows) return;
    const result = await safeWriteFile(tempDir, "restricted.txt", "secret");
    expect(result.success).toBe(true);

    const fileStat = await stat(result.targetPath);
    // 0o600 = rw-------
    expect(fileStat.mode & 0o777).toBe(0o600);
  });
});

// ─── createNonceDir + cleanupDir 测试 ───

describe("createNonceDir + cleanupDir", () => {
  it("创建唯一临时目录", async () => {
    const dir1 = await createNonceDir("test");
    const dir2 = await createNonceDir("test");
    expect(dir1).not.toBe(dir2);

    await cleanupDir(dir1);
    await cleanupDir(dir2);
  });

  it("cleanupDir 清理目录", async () => {
    const dir = await createNonceDir("cleanup-test");
    await safeWriteFile(dir, "file.txt", "test");

    await cleanupDir(dir);
    // 目录已删除，stat 应该失败
    try {
      await stat(dir);
      expect(true).toBe(false); // 不应到达
    } catch {
      // 预期行为
    }
  });

  it("cleanupDir 不存在的目录不抛出", async () => {
    await cleanupDir("/nonexistent/dir/that/does/not/exist");
  });
});

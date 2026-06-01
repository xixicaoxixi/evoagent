/**
 * Session 4.2 测试 — 路径提取器、sed 验证器、环境变量过滤器、文件工具。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  extractPathsFromCommand,
  extractAllPaths,
  filterOutFlags,
} from "../../../src/tools/bash/path-extractors";
import { sedCommandIsAllowed } from "../../../src/tools/bash/sed-validator";
import { sanitizeEnvVars } from "../../../src/tools/bash/env-sanitizer";
import {
  createFileReadTool,
  type FileReadInput,
} from "../../../src/tools/file/read";
import {
  createFileWriteTool,
  createMemoryReadFileState,
  type FileWriteInput,
} from "../../../src/tools/file/write";
import {
  createFileEditTool,
  type FileEditInput,
} from "../../../src/tools/file/edit";
import { createGlobTool, type GlobInput } from "../../../src/tools/file/glob";
import { validatePath } from "../../../src/tools/file/path-utils";
import type { ToolUseContext } from "../../../src/interfaces/tool";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── 路径提取器测试 ───

describe("Path Extractors", () => {
  it("ls 提取路径", () => {
    const result = extractPathsFromCommand({
      text: "ls -la /tmp",
      args: ["ls", "-la", "/tmp"],
      redirects: [],
    });
    expect(result.paths).toEqual(["/tmp"]);
  });

  it("ls 无参数返回当前目录", () => {
    const result = extractPathsFromCommand({
      text: "ls",
      args: ["ls"],
      redirects: [],
    });
    expect(result.paths).toEqual(["."]);
  });

  it("rm 提取路径", () => {
    const result = extractPathsFromCommand({
      text: "rm -rf /tmp/file.txt",
      args: ["rm", "-rf", "/tmp/file.txt"],
      redirects: [],
    });
    expect(result.paths).toEqual(["/tmp/file.txt"]);
  });

  it("-- 分隔符后所有参数视为路径", () => {
    const result = extractPathsFromCommand({
      text: "rm -- -evil-file",
      args: ["rm", "--", "-evil-file"],
      redirects: [],
    });
    expect(result.paths).toEqual(["-evil-file"]);
  });

  it("grep 提取路径（pattern + path 结构）", () => {
    const result = extractPathsFromCommand({
      text: "grep -r pattern /src",
      args: ["grep", "-r", "pattern", "/src"],
      redirects: [],
    });
    expect(result.paths).toEqual(["/src"]);
  });

  it("cp 提取两个路径", () => {
    const result = extractPathsFromCommand({
      text: "cp /src/file /dst/file",
      args: ["cp", "/src/file", "/dst/file"],
      redirects: [],
    });
    expect(result.paths).toEqual(["/src/file", "/dst/file"]);
  });

  it("find 提取搜索路径", () => {
    const result = extractPathsFromCommand({
      text: "find /tmp -name '*.txt'",
      args: ["find", "/tmp", "-name", "*.txt"],
      redirects: [],
    });
    expect(result.paths).toEqual(["/tmp"]);
  });

  it("未知命令返回空路径", () => {
    const result = extractPathsFromCommand({
      text: "unknown --flag value",
      args: ["unknown", "--flag", "value"],
      redirects: [],
    });
    expect(result.paths).toEqual([]);
  });

  it("extractAllPaths 包含重定向目标", () => {
    const result = extractAllPaths([
      {
        text: "cat file.txt",
        args: ["cat", "file.txt"],
        redirects: ["/tmp/output.txt"],
      },
    ]);
    expect(result).toContain("file.txt");
    expect(result).toContain("/tmp/output.txt");
  });

  it("filterOutFlags 正确过滤", () => {
    expect(filterOutFlags(["-la", "/tmp"])).toEqual(["/tmp"]);
    expect(filterOutFlags(["--", "-evil"])).toEqual(["-evil"]);
    expect(filterOutFlags(["-r", "-l", "file"])).toEqual(["file"]);
  });
});

// ─── sed 验证器测试 ───

describe("sed Validator", () => {
  it("安全替换命令通过", () => {
    expect(sedCommandIsAllowed("sed 's/old/new/' file.txt")).toBe(true);
  });

  it("全局替换通过", () => {
    expect(sedCommandIsAllowed("sed 's/old/new/g' file.txt")).toBe(true);
  });

  it("行打印命令通过", () => {
    expect(sedCommandIsAllowed("sed -n '5p' file.txt")).toBe(true);
  });

  it("不区分大小写替换通过", () => {
    expect(sedCommandIsAllowed("sed 's/old/new/i' file.txt")).toBe(true);
  });

  it("w 写文件命令拒绝", () => {
    expect(sedCommandIsAllowed("sed 'w output.txt' file.txt")).toBe(false);
  });

  it("e 执行命令拒绝", () => {
    expect(sedCommandIsAllowed("sed 'e' file.txt")).toBe(false);
  });

  it("花括号块拒绝", () => {
    expect(sedCommandIsAllowed("sed '{s/a/b/; s/c/d/}' file.txt")).toBe(false);
  });

  it("非 ASCII 字符拒绝", () => {
    expect(sedCommandIsAllowed("sed 's/old/ｎew/' file.txt")).toBe(false);
  });

  it("否定操作符拒绝", () => {
    expect(sedCommandIsAllowed("sed '/pattern/!d' file.txt")).toBe(false);
  });

  it("替换中的 w 标志拒绝", () => {
    expect(sedCommandIsAllowed("sed 's/old/new/w output.txt' file.txt")).toBe(false);
  });

  it("分号分隔符在替换模式中拒绝", () => {
    expect(sedCommandIsAllowed("sed 's/a/b/;s/c/d/' file.txt")).toBe(false);
  });

  it("空表达式拒绝", () => {
    expect(sedCommandIsAllowed("sed file.txt")).toBe(false);
  });
});

// ─── 环境变量过滤器测试 ───

describe("Env Sanitizer", () => {
  it("正常变量通过", () => {
    const result = sanitizeEnvVars({
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "en_US.UTF-8",
    });
    expect(result.blocked).toEqual([]);
    expect(Object.keys(result.allowed)).toHaveLength(3);
  });

  it("API_KEY 被阻止", () => {
    const result = sanitizeEnvVars({
      PATH: "/usr/bin",
      MY_API_KEY: "secret123",
    });
    expect(result.blocked).toContain("MY_API_KEY");
    expect(result.allowed).toHaveProperty("PATH");
  });

  it("GITHUB_TOKEN 被阻止", () => {
    const result = sanitizeEnvVars({
      GITHUB_TOKEN: "ghp_xxx",
    });
    expect(result.blocked).toContain("GITHUB_TOKEN");
  });

  it("严格模式仅允许白名单", () => {
    const result = sanitizeEnvVars(
      { PATH: "/usr/bin", CUSTOM_VAR: "value" },
      { strictMode: true },
    );
    expect(result.blocked).toContain("CUSTOM_VAR");
    expect(result.allowed).toHaveProperty("PATH");
  });

  it("null 字节值被阻止", () => {
    const result = sanitizeEnvVars({
      EVIL_VAR: "value\x00with_null",
    });
    expect(result.blocked).toContain("EVIL_VAR");
  });

  it("超长值产生警告", () => {
    const longValue = "x".repeat(40000);
    const result = sanitizeEnvVars({
      BIG_VAR: longValue,
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.allowed).toHaveProperty("BIG_VAR");
  });

  it("自定义阻止模式", () => {
    const result = sanitizeEnvVars(
      { MY_SECRET: "value", PATH: "/usr/bin" },
      { customBlockedPatterns: [/^MY_SECRET$/] },
    );
    expect(result.blocked).toContain("MY_SECRET");
    expect(result.allowed).toHaveProperty("PATH");
  });
});

// ─── 文件工具测试 ───

describe("File Tools", () => {
  let tempDir: string;
  let baseContext: ToolUseContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "evoagent-test-"));
    baseContext = {
      cwd: tempDir,
      env: {},
      getAppState: () => ({}),
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("FileReadTool", () => {
    it("读取文件内容", async () => {
      const filePath = join(tempDir, "test.txt");
      await writeFile(filePath, "hello\nworld\n");

      const tool = createFileReadTool();
      const result = await tool.call(
        { file_path: filePath } satisfies FileReadInput,
        baseContext,
      );
      const data = result.content as { content: string; totalLines: number; truncated: boolean };
      // split+join loses trailing newline
      expect(data.content).toContain("hello");
      expect(data.content).toContain("world");
      expect(data.totalLines).toBe(3);
      expect(data.truncated).toBe(false);
    });

    it("带 offset 和 limit 读取", async () => {
      const filePath = join(tempDir, "test.txt");
      await writeFile(filePath, "line1\nline2\nline3\nline4\nline5\n");

      const tool = createFileReadTool();
      const result = await tool.call(
        { file_path: filePath, offset: 1, limit: 2 } satisfies FileReadInput,
        baseContext,
      );
      const data = result.content as { content: string; lineCount: number; totalLines: number; truncated: boolean };
      expect(data.content).toContain("line2");
      expect(data.content).toContain("line3");
      expect(data.lineCount).toBe(2);
      expect(data.totalLines).toBe(6);
      expect(data.truncated).toBe(true);
    });

    it("不存在的文件返回 exists:false", async () => {
      const tool = createFileReadTool();
      const result = await tool.call(
        { file_path: "/nonexistent/file.txt" } satisfies FileReadInput,
        baseContext,
      );
      expect(result.isError).toBe(false);
      const data = result.content as { exists: boolean; content: string };
      expect(data.exists).toBe(false);
      expect(data.content).toBe("");
    });

    it("标记为只读和并发安全", () => {
      const tool = createFileReadTool();
      expect(tool.isReadOnly()).toBe(true);
      expect(tool.isConcurrencySafe()).toBe(true);
    });
  });

  describe("FileWriteTool", () => {
    it("写入新文件", async () => {
      const filePath = join(tempDir, "new.txt");
      const tool = createFileWriteTool();

      const result = await tool.call(
        { file_path: filePath, content: "hello world" } satisfies FileWriteInput,
        baseContext,
      );
      expect((result.content as { success: boolean }).success).toBe(true);
      expect((result.content as { path: string }).path).toBe(filePath);
    });

    it("Read-before-Write: 未读取时拒绝写入已存在文件", async () => {
      const filePath = join(tempDir, "existing.txt");
      await writeFile(filePath, "original content");

      const readState = createMemoryReadFileState();
      const tool = createFileWriteTool(readState);

      await expect(
        tool.call(
          { file_path: filePath, content: "new content" } satisfies FileWriteInput,
          baseContext,
        ),
      ).rejects.toThrow("has not been read");
    });

    it("Read-before-Write: 读取后允许写入", async () => {
      const filePath = join(tempDir, "existing.txt");
      await writeFile(filePath, "original content");

      const readState = createMemoryReadFileState();
      readState.markRead(filePath, false);

      const tool = createFileWriteTool(readState);
      const result = await tool.call(
        { file_path: filePath, content: "new content" } satisfies FileWriteInput,
        baseContext,
      );
      expect((result.content as { success: boolean }).success).toBe(true);
    });

    it("Read-before-Write: 部分读取拒绝写入", async () => {
      const filePath = join(tempDir, "existing.txt");
      await writeFile(filePath, "original content");

      const readState = createMemoryReadFileState();
      readState.markRead(filePath, true); // isPartialView = true

      const tool = createFileWriteTool(readState);
      await expect(
        tool.call(
          { file_path: filePath, content: "new content" } satisfies FileWriteInput,
          baseContext,
        ),
      ).rejects.toThrow("partially read");
    });

    it("标记为非只读和非并发安全", () => {
      const tool = createFileWriteTool();
      expect(tool.isReadOnly()).toBe(false);
      expect(tool.isConcurrencySafe()).toBe(false);
    });
  });

  describe("FileEditTool", () => {
    it("替换文件内容", async () => {
      const filePath = join(tempDir, "edit.txt");
      await writeFile(filePath, "hello world\nfoo bar\n");

      const readState = createMemoryReadFileState();
      readState.markRead(filePath, false);

      const tool = createFileEditTool(readState);
      const result = await tool.call(
        {
          file_path: filePath,
          old_str: "hello world",
          new_str: "hi universe",
        } satisfies FileEditInput,
        baseContext,
      );
      expect((result.content as { success: boolean }).success).toBe(true);
      expect((result.content as { replacements: number }).replacements).toBe(1);
    });

    it("搜索内容不存在时抛出错误", async () => {
      const filePath = join(tempDir, "edit.txt");
      await writeFile(filePath, "hello world\n");

      const readState = createMemoryReadFileState();
      readState.markRead(filePath, false);

      const tool = createFileEditTool(readState);
      await expect(
        tool.call(
          {
            file_path: filePath,
            old_str: "not found",
            new_str: "replacement",
          } satisfies FileEditInput,
          baseContext,
        ),
      ).rejects.toThrow("not found");
    });

    it("多次匹配且未设置 replace_all 时抛出错误", async () => {
      const filePath = join(tempDir, "edit.txt");
      await writeFile(filePath, "aaa\nbbb\naaa\n");

      const readState = createMemoryReadFileState();
      readState.markRead(filePath, false);

      const tool = createFileEditTool(readState);
      await expect(
        tool.call(
          {
            file_path: filePath,
            old_str: "aaa",
            new_str: "ccc",
          } satisfies FileEditInput,
          baseContext,
        ),
      ).rejects.toThrow("matches 2 times");
    });

    it("replace_all 替换所有匹配", async () => {
      const filePath = join(tempDir, "edit.txt");
      await writeFile(filePath, "aaa\nbbb\naaa\n");

      const readState = createMemoryReadFileState();
      readState.markRead(filePath, false);

      const tool = createFileEditTool(readState);
      const result = await tool.call(
        {
          file_path: filePath,
          old_str: "aaa",
          new_str: "ccc",
          replace_all: true,
        } satisfies FileEditInput,
        baseContext,
      );
      expect((result.content as { replacements: number }).replacements).toBe(2);
    });

    it("未读取文件时拒绝编辑", async () => {
      const filePath = join(tempDir, "edit.txt");
      await writeFile(filePath, "hello\n");

      const readState = createMemoryReadFileState();
      const tool = createFileEditTool(readState);

      await expect(
        tool.call(
          {
            file_path: filePath,
            old_str: "hello",
            new_str: "world",
          } satisfies FileEditInput,
          baseContext,
        ),
      ).rejects.toThrow("has not been read");
    });
  });

  describe("GlobTool", () => {
    it("匹配文件模式", async () => {
      await writeFile(join(tempDir, "test.ts"), "content");
      await writeFile(join(tempDir, "test.js"), "content");

      const tool = createGlobTool();
      const result = await tool.call(
        { pattern: "*.ts", path: tempDir } satisfies GlobInput,
        baseContext,
      );
      const data = result.content as { matches: string[] };
      expect(data.matches.length).toBe(1);
      expect(data.matches[0]).toContain("test.ts");
    });

    it("标记为只读和并发安全", () => {
      const tool = createGlobTool();
      expect(tool.isReadOnly()).toBe(true);
      expect(tool.isConcurrencySafe()).toBe(true);
    });
  });
});

// ─── C1: validatePath — path.resolve() 方案测试 ───

describe("C1: validatePath — path.resolve() based validation", () => {
  it("合法绝对路径通过验证", () => {
    const result = validatePath("/usr/local/bin/node");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.resolved).toContain("usr");
    }
  });

  it("合法相对路径通过验证", () => {
    const result = validatePath("./src/index.ts");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.resolved).toContain("src");
    }
  });

  it("空路径被拒绝", () => {
    const result = validatePath("");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("empty");
    }
  });

  it("纯空白路径被拒绝", () => {
    const result = validatePath("   ");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("empty");
    }
  });

  it("URL 编码路径被拒绝（%2f 绕过防护）", () => {
    const result = validatePath("/path%2f..%2f..%2fetc/passwd");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("URL-encoded");
    }
  });

  it("路径遍历 /../ 被 path.resolve() 正确处理", () => {
    const result = validatePath("/etc/../tmp/secret");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.resolved).not.toContain("..");
    }
  });

  it("多层路径遍历 /a/./../../ 被正确规范化", () => {
    const result = validatePath("/a/./../../etc/passwd");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.resolved).not.toContain("..");
    }
  });

  it("allowedRoot 模式：路径在允许目录内通过", () => {
    const result = validatePath("/workspace/src/index.ts", "/workspace");
    expect(result.valid).toBe(true);
  });

  it("allowedRoot 模式：路径逃逸允许目录被拒绝", () => {
    const result = validatePath("/etc/passwd", "/workspace");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("escapes");
    }
  });

  it("allowedRoot 模式：根目录本身通过", () => {
    const result = validatePath("/workspace", "/workspace");
    expect(result.valid).toBe(true);
  });
});

// ─── C2: ReadFileState mtime staleness 检查测试 ───

describe("C2: ReadFileState mtime staleness check", () => {
  let tempDir: string;
  let baseContext: ToolUseContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "evoagent-mtime-"));
    baseContext = {
      cwd: tempDir,
      env: {},
      getAppState: () => ({}),
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("markRead 记录 mtimeMs，wasRead 返回 mtimeMs", () => {
    const readState = createMemoryReadFileState();
    readState.markRead("/test/file.txt", false, 12345.67);
    const result = readState.wasRead("/test/file.txt");
    expect(result.read).toBe(true);
    if (result.read) {
      expect(result.mtimeMs).toBe(12345.67);
    }
  });

  it("markRead 不传 mtimeMs，wasRead 不含 mtimeMs", () => {
    const readState = createMemoryReadFileState();
    readState.markRead("/test/file.txt", false);
    const result = readState.wasRead("/test/file.txt");
    expect(result.read).toBe(true);
    if (result.read) {
      expect(result.mtimeMs).toBeUndefined();
    }
  });

  it("文件未被外部修改时写入成功", async () => {
    const filePath = join(tempDir, "stable.txt");
    await writeFile(filePath, "original");

    const readState = createMemoryReadFileState();
    const readTool = createFileReadTool(readState);
    const writeTool = createFileWriteTool(readState);

    await readTool.call({ file_path: filePath } satisfies FileReadInput, baseContext);

    const result = await writeTool.call(
      { file_path: filePath, content: "updated" } satisfies FileWriteInput,
      baseContext,
    );
    expect((result.content as { success: boolean }).success).toBe(true);
  });

  it("文件被外部修改后写入被拒绝（staleness 检查）", async () => {
    const filePath = join(tempDir, "modified.txt");
    await writeFile(filePath, "original");

    const readState = createMemoryReadFileState();
    const readTool = createFileReadTool(readState);
    const writeTool = createFileWriteTool(readState);

    await readTool.call({ file_path: filePath } satisfies FileReadInput, baseContext);

    await utimes(filePath, Date.now() / 1000 + 100, Date.now() / 1000 + 100);

    await expect(
      writeTool.call(
        { file_path: filePath, content: "updated" } satisfies FileWriteInput,
        baseContext,
      ),
    ).rejects.toThrow("modified externally");
  });

  it("手动 markRead（无 mtimeMs）时跳过 staleness 检查，写入成功", async () => {
    const filePath = join(tempDir, "manual.txt");
    await writeFile(filePath, "original");

    const readState = createMemoryReadFileState();
    readState.markRead(filePath, false);

    const writeTool = createFileWriteTool(readState);
    const result = await writeTool.call(
      { file_path: filePath, content: "updated" } satisfies FileWriteInput,
      baseContext,
    );
    expect((result.content as { success: boolean }).success).toBe(true);
  });
});

// ─── C3: Glob 深度限制测试 ───

describe("C3: Glob depth limit", () => {
  let tempDir: string;
  let baseContext: ToolUseContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "evoagent-depth-"));
    baseContext = {
      cwd: tempDir,
      env: {},
      getAppState: () => ({}),
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("默认深度限制下正常搜索", async () => {
    await writeFile(join(tempDir, "test.ts"), "content");

    const tool = createGlobTool();
    const result = await tool.call(
      { pattern: "*.ts", path: tempDir } satisfies GlobInput,
      baseContext,
    );
    const data = result.content as { matches: string[] };
    expect(data.matches.length).toBe(1);
  });

  it("maxDepth=1 只搜索顶层目录", async () => {
    const { mkdir } = await import("node:fs/promises");
    await writeFile(join(tempDir, "top.ts"), "content");
    await mkdir(join(tempDir, "sub"), { recursive: true });
    await writeFile(join(tempDir, "sub", "nested.ts"), "content");

    const tool = createGlobTool();
    const result = await tool.call(
      { pattern: "*.ts", path: tempDir, maxDepth: 1 } satisfies GlobInput,
      baseContext,
    );
    const data = result.content as { matches: string[] };
    expect(data.matches.length).toBe(1);
    expect(data.matches[0]).toContain("top.ts");
  });

  it("maxDepth=1 不进入二级子目录", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tempDir, "sub"), { recursive: true });
    await mkdir(join(tempDir, "sub", "deep"), { recursive: true });
    await writeFile(join(tempDir, "sub", "nested.ts"), "content");
    await writeFile(join(tempDir, "sub", "deep", "deep.ts"), "content");

    const tool = createGlobTool();
    const result = await tool.call(
      { pattern: "**/*.ts", path: tempDir, maxDepth: 1 } satisfies GlobInput,
      baseContext,
    );
    const data = result.content as { matches: string[] };
    expect(data.matches.length).toBe(1);
    expect(data.matches[0]).toContain("nested.ts");
  });

  it("maxDepth 参数验证：超出范围被 Zod 拒绝", async () => {
    const tool = createGlobTool();
    await expect(
      tool.call(
        { pattern: "*.ts", path: tempDir, maxDepth: 999 } satisfies GlobInput,
        baseContext,
      ),
    ).rejects.toThrow();
  });
});

/**
 * 阶段 4 集成测试 — BashTool + 内置工具注册 + 端到端安全管线。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createBuiltinTools,
  createBuiltinToolRegistry,
  getBuiltinToolNames,
  type BuiltinToolsConfig,
} from "../../src/tools/builtin";
import {
  createBashPermissionContext,
  PermissionRuleBehavior,
  type PermissionRule,
} from "../../src/tools/bash/permission";
import { createMemoryReadFileState } from "../../src/tools/file/write";
import type { ToolUseContext } from "../../src/interfaces/tool";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const isWindows = process.platform === "win32";

// ─── 内置工具注册测试 ───

describe("Builtin Tools Integration", () => {
  it("getBuiltinToolNames 返回排序后的名称", () => {
    const names = getBuiltinToolNames();
    expect(names).toEqual(["bash", "file_edit", "file_read", "file_write", "glob"]);
  });

  it("createBuiltinTools 创建 5 个工具", () => {
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
    };
    const tools = createBuiltinTools(config);
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["bash", "file_edit", "file_read", "file_write", "glob"]);
  });

  it("createBuiltinToolRegistry 创建注册表", () => {
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
    };
    const registry = createBuiltinToolRegistry(config);
    const names = getBuiltinToolNames();
    for (const name of names) {
      expect(registry.get(name)).toBeDefined();
    }
  });
});

// ─── BashTool 端到端测试 ───

describe("BashTool E2E", () => {
  let tempDir: string;
  let baseContext: ToolUseContext;
  let allowRules: PermissionRule[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "evoagent-e2e-"));
    baseContext = {
      cwd: tempDir,
      env: {},
      getAppState: () => ({}),
    };
    allowRules = [
      { pattern: "echo", behavior: PermissionRuleBehavior.ALLOW },
      { pattern: "ls", behavior: PermissionRuleBehavior.ALLOW },
      { pattern: "cat", behavior: PermissionRuleBehavior.ALLOW },
      { pattern: "mkdir", behavior: PermissionRuleBehavior.ALLOW },
      { pattern: "pwd", behavior: PermissionRuleBehavior.ALLOW },
      { pattern: "node", behavior: PermissionRuleBehavior.ALLOW },
      { pattern: "bun", behavior: PermissionRuleBehavior.ALLOW },
    ];
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("沙箱模式执行 echo 命令", async () => {
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
    };
    const tools = createBuiltinTools(config);
    const bashTool = tools.find((t) => t.name === "bash");
    expect(bashTool).toBeDefined();

    const result = await bashTool!.call({ command: "echo hello world" }, baseContext);
    expect(result.isError).toBe(false);
    const data = result.content as { stdout: string; exitCode: number };
    expect(data.stdout).toContain("hello world");
    expect(data.exitCode).toBe(0);
  });

  it("沙箱模式执行 ls 命令", async () => {
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
    };
    const tools = createBuiltinTools(config);
    const bashTool = tools.find((t) => t.name === "bash");

    const listCmd = isWindows ? "echo sandbox-test-ok" : "ls /tmp";
    const result = await bashTool!.call({ command: listCmd }, baseContext);
    expect(result.isError).toBe(false);
    const data = result.content as { stdout: string; exitCode: number };
    expect(data.exitCode).toBe(0);
  });

  it("非沙箱模式无规则时返回 ask_user", async () => {
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext(),
    };
    const tools = createBuiltinTools(config);
    const bashTool = tools.find((t) => t.name === "bash");

    const result = await bashTool!.call({ command: "echo hello" }, baseContext);
    expect(result.isError).toBe(true);
    const data = result.content as { stderr: string };
    expect(data.stderr).toContain("Permission required");
  });

  it("allow 规则允许执行", async () => {
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext({
        rules: allowRules,
      }),
    };
    const tools = createBuiltinTools(config);
    const bashTool = tools.find((t) => t.name === "bash");

    const result = await bashTool!.call({ command: "echo test" }, baseContext);
    expect(result.isError).toBe(false);
    const data = result.content as { stdout: string };
    expect(data.stdout).toContain("test");
  });

  it("deny 规则拒绝执行", async () => {
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext({
        rules: [
          { pattern: "rm", behavior: PermissionRuleBehavior.DENY, reason: "rm not allowed" },
        ],
      }),
    };
    const tools = createBuiltinTools(config);
    const bashTool = tools.find((t) => t.name === "bash");

    const result = await bashTool!.call({ command: "rm -rf /tmp/test" }, baseContext);
    expect(result.isError).toBe(true);
    const data = result.content as { stderr: string };
    expect(data.stderr).toContain("Permission denied");
  });

  it("语义危险命令被拦截", async () => {
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext(),
    };
    const tools = createBuiltinTools(config);
    const bashTool = tools.find((t) => t.name === "bash");

    const result = await bashTool!.call({ command: "eval echo hack" }, baseContext);
    expect(result.isError).toBe(true);
  });

  it("too-complex 命令被拦截", async () => {
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext(),
    };
    const tools = createBuiltinTools(config);
    const bashTool = tools.find((t) => t.name === "bash");

    const result = await bashTool!.call({ command: "echo $(whoami)" }, baseContext);
    expect(result.isError).toBe(true);
  });
});

// ─── 文件工具端到端测试 ───

describe("File Tools E2E", () => {
  let tempDir: string;
  let baseContext: ToolUseContext;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "evoagent-file-"));
    baseContext = {
      cwd: tempDir,
      env: {},
      getAppState: () => ({}),
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("Read → Edit → Read 完整流程", async () => {
    const readState = createMemoryReadFileState();
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
      readFileState: readState,
    };
    const tools = createBuiltinTools(config);

    // 1. 写入初始文件
    const filePath = join(tempDir, "test.txt");
    await writeFile(filePath, "hello world\nfoo bar\n");

    // 2. 读取文件
    const readTool = tools.find((t) => t.name === "file_read");
    const readResult = await readTool!.call({ file_path: filePath }, baseContext);
    expect(readResult.isError).toBe(false);
    const readData = readResult.content as { content: string };
    expect(readData.content).toContain("hello world");

    // 3. 标记为已读
    readState.markRead(filePath, false);

    // 4. 编辑文件
    const editTool = tools.find((t) => t.name === "file_edit");
    const editResult = await editTool!.call({
      file_path: filePath,
      old_str: "hello world",
      new_str: "hi universe",
    }, baseContext);
    expect(editResult.isError).toBe(false);

    // 5. 重新读取验证
    readState.markRead(filePath, false);
    const readResult2 = await readTool!.call({ file_path: filePath }, baseContext);
    const readData2 = readResult2.content as { content: string };
    expect(readData2.content).toContain("hi universe");
    expect(readData2.content).not.toContain("hello world");
  });

  it("未读取文件时写入被拒绝", async () => {
    const readState = createMemoryReadFileState();
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
      readFileState: readState,
    };
    const tools = createBuiltinTools(config);

    const filePath = join(tempDir, "existing.txt");
    await writeFile(filePath, "original");

    const writeTool = tools.find((t) => t.name === "file_write");
    await expect(
      writeTool!.call({
        file_path: filePath,
        content: "modified",
      }, baseContext),
    ).rejects.toThrow("has not been read");
  });

  it("新文件写入无需先读取", async () => {
    const readState = createMemoryReadFileState();
    const config: BuiltinToolsConfig = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
      readFileState: readState,
    };
    const tools = createBuiltinTools(config);

    const filePath = join(tempDir, "new.txt");
    const writeTool = tools.find((t) => t.name === "file_write");
    const result = await writeTool!.call({
      file_path: filePath,
      content: "new file content",
    }, baseContext);
    expect(result.isError).toBe(false);
  });
});

// ─── 安全管线端到端测试 ───

describe("Security Pipeline E2E", () => {
  it("环境变量净化阻止 API 密钥泄露", async () => {
    const { sanitizeEnvVars } = await import("../../src/tools/bash/env-sanitizer");
    const result = sanitizeEnvVars({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      OPENAI_API_KEY: "sk-xxx",
      HOME: "/home/user",
    });
    expect(result.allowed).toHaveProperty("PATH");
    expect(result.allowed).toHaveProperty("HOME");
    expect(result.blocked).toContain("ANTHROPIC_API_KEY");
    expect(result.blocked).toContain("OPENAI_API_KEY");
  });

  it("ReDoS 防御阻止嵌套重复", async () => {
    const { compileSafeRegex } = await import("../../src/tools/security/regex-safe");
    const safe = compileSafeRegex("^\\d{4}-\\d{2}-\\d{2}$");
    expect(safe.regex).not.toBeNull();

    const unsafe = compileSafeRegex("(a+)+b");
    expect(unsafe.regex).toBeNull();
    expect(unsafe.reason).toBe("unsafe-nested-repetition");
  });

  it("循环检测器识别重复调用", async () => {
    const loopModule = await import("../../src/tools/security/loop-detector");
    const history: Array<{ toolName: string; argsHash: string; resultHash?: string; timestamp: number }> = [];
    const argsHash = loopModule.hashToolCall("command_status", {});
    for (let i = 0; i < 20; i++) {
      history.push({
        toolName: "command_status",
        argsHash,
        resultHash: "same",
        timestamp: Date.now() - (20 - i),
      });
    }
    const result = loopModule.detectToolCallLoop(history, "command_status", {});
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.detector).toBe("known_poll_no_progress");
    }
  });
});

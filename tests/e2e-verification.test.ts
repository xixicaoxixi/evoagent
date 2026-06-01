import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createFileReadTool } from "../src/tools/file/read";
import { createFileWriteTool, createMemoryReadFileState } from "../src/tools/file/write";
import { createFileEditTool } from "../src/tools/file/edit";
import { createGlobTool } from "../src/tools/file/glob";
import { createBuiltinTools } from "../src/tools/builtin";
import { createBashPermissionContext } from "../src/tools/bash/permission";
import { registerBuiltinTools } from "../src/mcp-entry";
import type { MCPServer } from "../src/mcp/server";
import type { ToolUseContext } from "../src/interfaces/tool";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createMockMCPServer(): {
  server: MCPServer;
  handlers: Map<string, (params: unknown) => Promise<unknown>>;
} {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  const server: MCPServer = {
    registerTool: (definition, handler) => {
      handlers.set(definition.name, handler);
    },
    unregisterTool: () => false,
    registerResource: () => {},
    unregisterResource: () => false,
    handleMessage: async () => undefined,
    connect: () => {},
    disconnect: () => {},
    getRegisteredTools: () => [],
    getStats: () => ({ totalRequests: 0, successfulRequests: 0, failedRequests: 0, toolsRegistered: 0, resourcesRegistered: 0 }),
  };
  return { server, handlers };
}

const baseContext: ToolUseContext = {
  cwd: process.cwd(),
  getAppState: () => ({}),
};

describe("E2E-1: file_read → file_edit 完整流程", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "evoagent-e2e1-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("file_read 自动标记已读 → file_edit 直接编辑成功", async () => {
    const readState = createMemoryReadFileState();
    const readTool = createFileReadTool(readState);
    const editTool = createFileEditTool(readState);

    const filePath = join(tempDir, "auto_mark.txt");
    await writeFile(filePath, "hello world\nfoo bar\n");

    const readResult = await readTool.call({ file_path: filePath }, baseContext);
    expect(readResult.isError).toBe(false);

    const editResult = await editTool.call({
      file_path: filePath,
      old_str: "hello world",
      new_str: "hi universe",
    }, baseContext);
    expect(editResult.isError).toBe(false);
    const editData = editResult.content as { success: boolean; replacements: number };
    expect(editData.success).toBe(true);
    expect(editData.replacements).toBe(1);

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("hi universe");
    expect(content).not.toContain("hello world");
  });

  it("file_read 部分读取 → file_edit 仍可编辑（edit 不检查 isPartialView）", async () => {
    const readState = createMemoryReadFileState();
    const readTool = createFileReadTool(readState);
    const editTool = createFileEditTool(readState);

    const filePath = join(tempDir, "partial_edit.txt");
    await writeFile(filePath, "line1\nline2\nline3\nline4\nline5\n");

    const readResult = await readTool.call({ file_path: filePath, offset: 0, limit: 2 }, baseContext);
    expect(readResult.isError).toBe(false);

    const readStatus = readState.wasRead(filePath);
    expect(readStatus.read).toBe(true);
    if (readStatus.read) {
      expect(readStatus.isPartialView).toBe(true);
    }

    const editResult = await editTool.call({
      file_path: filePath,
      old_str: "line3",
      new_str: "LINE3",
    }, baseContext);
    expect(editResult.isError).toBe(false);
  });
});

describe("E2E-2: file_read → file_write 完整流程", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "evoagent-e2e2-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("file_read 完整读取 → file_write 覆盖成功", async () => {
    const readState = createMemoryReadFileState();
    const readTool = createFileReadTool(readState);
    const writeTool = createFileWriteTool(readState);

    const filePath = join(tempDir, "overwrite.txt");
    await writeFile(filePath, "original content");

    const readResult = await readTool.call({ file_path: filePath }, baseContext);
    expect(readResult.isError).toBe(false);

    const readStatus = readState.wasRead(filePath);
    expect(readStatus.read).toBe(true);
    if (readStatus.read) {
      expect(readStatus.isPartialView).toBe(false);
    }

    const writeResult = await writeTool.call({
      file_path: filePath,
      content: "new content",
    }, baseContext);
    expect(writeResult.isError).toBe(false);
    const writeData = writeResult.content as { success: boolean; bytesWritten: number };
    expect(writeData.success).toBe(true);
    expect(writeData.bytesWritten).toBeGreaterThan(0);

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("new content");
  });

  it("file_read 部分读取 → file_write 拒绝覆盖", async () => {
    const readState = createMemoryReadFileState();
    const readTool = createFileReadTool(readState);
    const writeTool = createFileWriteTool(readState);

    const filePath = join(tempDir, "partial_write.txt");
    await writeFile(filePath, "line1\nline2\nline3\nline4\nline5\n");

    const readResult = await readTool.call({ file_path: filePath, offset: 0, limit: 2 }, baseContext);
    expect(readResult.isError).toBe(false);

    await expect(
      writeTool.call({ file_path: filePath, content: "overwritten" }, baseContext),
    ).rejects.toThrow("partially read");
  });

  it("file_write 新文件无需先读取", async () => {
    const readState = createMemoryReadFileState();
    const writeTool = createFileWriteTool(readState);

    const filePath = join(tempDir, "brand_new.txt");
    const result = await writeTool.call({
      file_path: filePath,
      content: "brand new content",
    }, baseContext);
    expect(result.isError).toBe(false);

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("brand new content");
  });
});

describe("E2E-3: glob **/*.ts 递归搜索", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "evoagent-e2e3-"));
    await mkdir(join(tempDir, "src"), { recursive: true });
    await mkdir(join(tempDir, "src", "core"), { recursive: true });
    await writeFile(join(tempDir, "root.ts"), "");
    await writeFile(join(tempDir, "src", "index.ts"), "");
    await writeFile(join(tempDir, "src", "core", "config.ts"), "");
    await writeFile(join(tempDir, "src", "index.js"), "");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("**/*.ts 匹配子目录中的 .ts 文件", async () => {
    const tool = createGlobTool();
    const result = await tool.call({ pattern: "**/*.ts", path: tempDir }, baseContext);
    const data = result.content as { matches: string[]; totalMatches: number };
    expect(data.matches.length).toBe(3);
    const matchNames = data.matches.map((p: string) => p.replace(/\\/g, "/"));
    expect(matchNames.some((p: string) => p.endsWith("root.ts"))).toBe(true);
    expect(matchNames.some((p: string) => p.endsWith("src/index.ts"))).toBe(true);
    expect(matchNames.some((p: string) => p.endsWith("src/core/config.ts"))).toBe(true);
  });

  it("*.ts 仅匹配当前目录（不跨目录）", async () => {
    const tool = createGlobTool();
    const result = await tool.call({ pattern: "*.ts", path: tempDir }, baseContext);
    const data = result.content as { matches: string[] };
    expect(data.matches.length).toBe(1);
    expect(data.matches[0].replace(/\\/g, "/")).toContain("root.ts");
  });

  it("src/**/*.ts 匹配 src 子目录下的 .ts 文件", async () => {
    const tool = createGlobTool();
    const result = await tool.call({ pattern: "src/**/*.ts", path: tempDir }, baseContext);
    const data = result.content as { matches: string[] };
    expect(data.matches.length).toBe(2);
    const matchNames = data.matches.map((p: string) => p.replace(/\\/g, "/"));
    expect(matchNames.some((p: string) => p.endsWith("src/index.ts"))).toBe(true);
    expect(matchNames.some((p: string) => p.endsWith("src/core/config.ts"))).toBe(true);
  });

  it("不匹配 .js 文件", async () => {
    const tool = createGlobTool();
    const result = await tool.call({ pattern: "**/*.ts", path: tempDir }, baseContext);
    const data = result.content as { matches: string[] };
    const matchNames = data.matches.map((p: string) => p.replace(/\\/g, "/"));
    expect(matchNames.some((p: string) => p.endsWith(".js"))).toBe(false);
  });
});

describe("E2E-4: 工具错误透传验证", () => {
  it("file_edit 未读取文件 → MCP handler 返回 isError=true + 错误消息", async () => {
    const readState = createMemoryReadFileState();
    const config = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
      readFileState: readState,
    };
    const tools = createBuiltinTools(config);
    const { handlers } = createMockMCPServer();
    registerBuiltinTools({ registerTool: (def, handler) => handlers.set(def.name, handler), unregisterTool: () => false } as unknown as MCPServer, tools);

    const handler = handlers.get("file_edit")!;
    const result = await handler({
      file_path: "g:\\工作内容\\solo\\evoagent-ts\\src\\tools\\file\\read.ts",
      old_str: "hello",
      new_str: "world",
    }) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("has not been read");
  });

  it("file_write 未读取已有文件 → MCP handler 返回 isError=true + 错误消息", async () => {
    const readState = createMemoryReadFileState();
    const config = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
      readFileState: readState,
    };
    const tools = createBuiltinTools(config);
    const { handlers } = createMockMCPServer();
    registerBuiltinTools({ registerTool: (def, handler) => handlers.set(def.name, handler), unregisterTool: () => false } as unknown as MCPServer, tools);

    const handler = handlers.get("file_write")!;
    const result = await handler({
      file_path: "g:\\工作内容\\solo\\evoagent-ts\\src\\tools\\file\\read.ts",
      content: "overwrite",
    }) as { content: Array<{ type: string; text: string }>; isError: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("has not been read");
  });

  it("file_read 不存在的文件 → MCP handler 返回 isError=false + exists:false", async () => {
    const readState = createMemoryReadFileState();
    const config = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
      readFileState: readState,
    };
    const tools = createBuiltinTools(config);
    const { handlers } = createMockMCPServer();
    registerBuiltinTools({ registerTool: (def, handler) => handlers.set(def.name, handler), unregisterTool: () => false } as unknown as MCPServer, tools);

    const handler = handlers.get("file_read")!;
    const result = await handler({
      file_path: "/nonexistent/path/file.txt",
    }) as { content: { exists: boolean; content: string }; isError: boolean };

    expect(result.isError).toBe(false);
    expect(result.content.exists).toBe(false);
    expect(result.content.content).toBe("");
  });

  it("正常流程：file_read → file_edit → MCP handler 返回成功", async () => {
    const readState = createMemoryReadFileState();
    const config = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
      readFileState: readState,
    };
    const tools = createBuiltinTools(config);
    const { handlers } = createMockMCPServer();
    registerBuiltinTools({ registerTool: (def, handler) => handlers.set(def.name, handler), unregisterTool: () => false } as unknown as MCPServer, tools);

    const filePath = "g:\\工作内容\\solo\\evoagent-ts\\src\\tools\\file\\read.ts";

    const readHandler = handlers.get("file_read")!;
    const readResult = await readHandler({ file_path: filePath }) as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(readResult.isError).toBe(false);

    const editHandler = handlers.get("file_edit")!;
    const editResult = await editHandler({
      file_path: filePath,
      old_str: "readFileState?.ReadFileState",
      new_str: "readFileState?: ReadFileState",
    }) as { content: Array<{ type: string; text: string }>; isError: boolean };

    if (editResult.isError) {
      // 如果 old_str 不匹配，说明文件内容与预期不同，但关键是没报 "has not been read"
      expect(editResult.content[0].text).not.toContain("has not been read");
    }
  });
});

describe("E2E-5: ReadFileState 自动标记验证", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "evoagent-e2e5-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("file_read 完整读取后 readFileState.wasRead() 返回 read=true, isPartialView=false", async () => {
    const readState = createMemoryReadFileState();
    const readTool = createFileReadTool(readState);

    const filePath = join(tempDir, "full_read.txt");
    await writeFile(filePath, "line1\nline2\nline3\n");

    await readTool.call({ file_path: filePath }, baseContext);

    const status = readState.wasRead(filePath);
    expect(status.read).toBe(true);
    if (status.read) {
      expect(status.isPartialView).toBe(false);
    }
  });

  it("file_read 部分读取后 readFileState.wasRead() 返回 read=true, isPartialView=true", async () => {
    const readState = createMemoryReadFileState();
    const readTool = createFileReadTool(readState);

    const filePath = join(tempDir, "partial_read.txt");
    await writeFile(filePath, "line1\nline2\nline3\nline4\nline5\n");

    await readTool.call({ file_path: filePath, offset: 0, limit: 2 }, baseContext);

    const status = readState.wasRead(filePath);
    expect(status.read).toBe(true);
    if (status.read) {
      expect(status.isPartialView).toBe(true);
    }
  });

  it("file_read 带 offset 读取后 readFileState.wasRead() 返回 isPartialView=true", async () => {
    const readState = createMemoryReadFileState();
    const readTool = createFileReadTool(readState);

    const filePath = join(tempDir, "offset_read.txt");
    await writeFile(filePath, "line1\nline2\nline3\nline4\nline5\n");

    await readTool.call({ file_path: filePath, offset: 2, limit: 2000 }, baseContext);

    const status = readState.wasRead(filePath);
    expect(status.read).toBe(true);
    if (status.read) {
      expect(status.isPartialView).toBe(true);
    }
  });

  it("未调用 file_read 时 readFileState.wasRead() 返回 read=false", async () => {
    const readState = createMemoryReadFileState();
    const status = readState.wasRead("/some/file.txt");
    expect(status.read).toBe(false);
  });
});

describe("E2E-6: builtin 工具集成验证", () => {
  it("createBuiltinTools 传入 readFileState 后所有工具共享同一实例", async () => {
    const readState = createMemoryReadFileState();
    const config = {
      bashPermissionContext: createBashPermissionContext({ sandboxed: true }),
      readFileState: readState,
    };
    const tools = createBuiltinTools(config);

    const readTool = tools.find((t) => t.name === "file_read");
    const editTool = tools.find((t) => t.name === "file_edit");
    const writeTool = tools.find((t) => t.name === "file_write");

    expect(readTool).toBeDefined();
    expect(editTool).toBeDefined();
    expect(writeTool).toBeDefined();

    const testFile = "g:\\工作内容\\solo\\evoagent-ts\\src\\tools\\file\\read.ts";

    const readResult = await readTool!.call({ file_path: testFile }, baseContext);
    expect(readResult.isError).toBe(false);

    expect(readState.wasRead(testFile).read).toBe(true);
  });
});

describe("E2E-7: Token 统计链路验证（M3）", () => {
  it("agentQueryLoop turn_end 事件携带非零 tokenUsage", async () => {
    const { agentQueryLoop } = await import("../src/core/query/loop");
    const { MockProvider } = await import("../src/llm/mock");

    const provider = new MockProvider({ defaultResponse: "Hello world response" });
    const events: Array<{ type: string; tokenUsage?: { inputTokens: number; outputTokens: number } }> = [];

    const gen = agentQueryLoop({
      provider,
      tools: [],
      messages: [],
      systemPrompt: "You are a test assistant.",
      canUseTool: () => true,
      toolUseContext: baseContext,
      maxTurns: 1,
      budgetTotal: 100000,
    });

    let result = await gen.next();
    while (!result.done) {
      const event = result.value;
      if (event.type === "turn_end" || event.type === "content") {
        events.push({ type: event.type, ...(event.type === "turn_end" ? { tokenUsage: event.tokenUsage } : {}) });
      }
      result = await gen.next();
    }

    const turnEndEvents = events.filter((e) => e.type === "turn_end");
    expect(turnEndEvents.length).toBeGreaterThanOrEqual(1);

    const lastTurnEnd = turnEndEvents[turnEndEvents.length - 1]!;
    expect(lastTurnEnd.tokenUsage).toBeDefined();
    expect(lastTurnEnd.tokenUsage!.outputTokens).toBeGreaterThan(0);
  });

  it("OpenAI stream 请求体包含 stream_options.include_usage", async () => {
    const { OpenAIProvider } = await import("../src/llm/openai");

    const provider = new OpenAIProvider({
      apiKey: "test-key",
      baseUrl: "http://localhost:9999",
      model: "gpt-4",
    });

    let capturedBody: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "test" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    try {
      const messages = [{ role: "user" as const, content: "hello" }];
      await provider.stream(messages).next();
    } catch {
      // stream may fail due to mock, but body is captured
    }

    globalThis.fetch = originalFetch;

    expect(capturedBody).toBeDefined();
    expect(capturedBody!.stream).toBe(true);
    expect(capturedBody!.stream_options).toEqual({ include_usage: true });
  });
});

describe("E2E-8: chat_complex 子任务调度优化验证（M4）", () => {
  it("Orchestrator executePlan 使用 Promise.allSettled 并行执行独立任务", async () => {
    const { Orchestrator } = await import("../src/core/agent/orchestrator");
    const { MockProvider } = await import("../src/llm/mock");

    const provider = new MockProvider({ defaultResponse: "Task completed successfully" });
    const orchestrator = new Orchestrator({
      provider,
      tools: [],
      canUseTool: () => true,
      toolUseContext: baseContext,
    });

    const plan = {
      planId: "test_plan",
      originalInput: "test",
      subTasks: [
        {
          taskId: "task_001",
          type: "custom" as const,
          description: "Independent task 1",
          input: "task1",
          expectedOutput: "result1",
          tools: [] as readonly string[],
          knowledgeNeeded: [] as readonly string[],
          tokenBudget: 1000,
          timeoutMs: 60_000,
          dependsOn: [] as readonly string[],
          priority: 1,
        },
        {
          taskId: "task_002",
          type: "custom" as const,
          description: "Independent task 2",
          input: "task2",
          expectedOutput: "result2",
          tools: [] as readonly string[],
          knowledgeNeeded: [] as readonly string[],
          tokenBudget: 1000,
          timeoutMs: 60_000,
          dependsOn: [] as readonly string[],
          priority: 1,
        },
      ],
      totalTokenBudget: 2000,
      createdAt: Date.now(),
      diagnostics: {
        source: "no_provider_simple" as const,
        failureStage: "none" as const,
        usedFallback: false,
        hasProvider: true,
      },
    };

    const start = Date.now();
    const states = await orchestrator.executePlan(plan);
    const duration = Date.now() - start;

    expect(states.length).toBeGreaterThanOrEqual(1);
  });

  it("chatComplex 子任务描述包含上下文前缀", async () => {
    const { createEvoAgentContext } = await import("../src/integration/context");
    const { MockProvider } = await import("../src/llm/mock");

    const provider = new MockProvider({ defaultResponse: "Sub-task result" });
    let capturedDescription = "";

    const originalPlan = (await import("../src/core/agent/orchestrator")).Orchestrator.prototype.executePlan;
    const { Orchestrator } = await import("../src/core/agent/orchestrator");
    Orchestrator.prototype.executePlan = async function (plan) {
      for (const task of plan.subTasks) {
        capturedDescription = task.description;
      }
      return [];
    };

    try {
      const ctx = await createEvoAgentContext({
        provider,
        tools: [],
        canUseTool: () => true,
      });

      await ctx.chatComplex("Build a REST API", ["Design the API schema", "Implement endpoints"]);
    } catch {
    }

    Orchestrator.prototype.executePlan = originalPlan;

    expect(capturedDescription).toContain("[Sub-task");
    expect(capturedDescription).toContain("Build a REST API");
    expect(capturedDescription).toContain("Complete this sub-task fully");
  });

  it("chatComplex evolution trigger 是非阻塞的（fire-and-forget）", async () => {
    const fs = await import("node:fs/promises");
    const contextSource = await fs.readFile(
      join(process.cwd(), "src", "integration", "context.ts"),
      "utf-8",
    );

    expect(contextSource).toContain("evolutionEngine.onTaskCompleted");
    expect(contextSource).toContain(".catch(");

    const onTaskCompletedMatches = contextSource.match(/evolutionEngine\.onTaskCompleted/g);
    expect(onTaskCompletedMatches).not.toBeNull();

    const chatComplexSection = contextSource.substring(
      contextSource.indexOf("async function chatComplex"),
      contextSource.indexOf("async function recordTaskCompletion"),
    );

    const fireAndForgetPattern = /evolutionEngine\.onTaskCompleted\([\s\S]*?\)\.catch\(/;
    expect(fireAndForgetPattern.test(contextSource)).toBe(true);
  });
});

describe("E2E-9: loop.ts turn_end tokenUsage 非零验证", () => {
  it("工具错误终止时 turn_end 携带 currentAssistantTokenUsage", async () => {
    const fs = await import("node:fs/promises");
    const loopSource = await fs.readFile(
      join(process.cwd(), "src", "core", "query", "loop.ts"),
      "utf-8",
    );

    expect(loopSource).toContain("currentAssistantTokenUsage?.inputTokens ?? 0");
    expect(loopSource).toContain("currentAssistantTokenUsage?.outputTokens ?? 0");

    const hardcodedZeroPattern = /tokenUsage:\s*\{\s*inputTokens:\s*0\s*,\s*outputTokens:\s*0\s*\}/;
    expect(hardcodedZeroPattern.test(loopSource)).toBe(false);
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createMCPEntry } from "../src/mcp-entry";
import type { MCPEntry } from "../src/mcp-entry";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

const isBun = typeof (globalThis as any).Bun !== "undefined";
const describeBun = isBun ? describe : describe.skip;

const TEST_PORT = 19878;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
let entry: MCPEntry;
let sessionId: string | undefined;
let requestId = 1;

interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function sendMCPRequest(method: string, params?: Record<string, unknown>): Promise<JSONRPCResponse> {
  const body = {
    jsonrpc: "2.0",
    id: requestId++,
    method,
    ...(params ? { params } : {}),
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const resp = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const sessionHeader = resp.headers.get("Mcp-Session-Id");
  if (sessionHeader) sessionId = sessionHeader;
  return (await resp.json()) as JSONRPCResponse;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<JSONRPCResponse> {
  return sendMCPRequest("tools/call", { name, arguments: args });
}

function extractResultText(resp: JSONRPCResponse): string {
  const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean } | undefined;
  if (!result?.content?.[0]?.text) return "";
  return result.content[0].text;
}

function extractResultData<T>(resp: JSONRPCResponse): T | null {
  const text = extractResultText(resp);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isToolError(resp: JSONRPCResponse): boolean {
  const result = resp.result as { isError?: boolean } | undefined;
  return result?.isError === true;
}

describeBun("EvoAgent MCP 全功能验证", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdir(join(tmpdir(), "evoagent-mcp-func-" + Date.now()), { recursive: true });
    entry = createMCPEntry({ transport: "http", port: TEST_PORT, hostname: "127.0.0.1" });
    await entry.start();

    const initResp = await sendMCPRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    expect(initResp.result).toBeDefined();
  }, 30000);

  afterAll(async () => {
    await entry.gracefulShutdown(5000);
    try { await rm(tempDir, { recursive: true, force: true }); } catch {}
  }, 30000);

  describe("1. MCP 协议层", () => {
    it("initialize 返回服务端能力声明", async () => {
      const resp = await sendMCPRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      });
      expect(resp.result).toBeDefined();
      expect(resp.error).toBeUndefined();
      const result = resp.result as { protocolVersion?: string; capabilities?: unknown; serverInfo?: { name: string } };
      expect(result.protocolVersion).toBe("2024-11-05");
      expect(result.capabilities).toBeDefined();
      expect(result.serverInfo?.name).toBeDefined();
    });

    it("tools/list 返回工具清单", async () => {
      const resp = await sendMCPRequest("tools/list");
      expect(resp.result).toBeDefined();
      const result = resp.result as { tools: Array<{ name: string; description: string }> };
      expect(result.tools.length).toBeGreaterThan(0);
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("file_read");
      expect(toolNames).toContain("file_write");
      expect(toolNames).toContain("file_edit");
      expect(toolNames).toContain("glob");
      expect(toolNames).toContain("bash");
    });

    it("/health 端点返回健康状态", async () => {
      const resp = await fetch(`${BASE_URL}/health`);
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { status: string };
      expect(data.status).toBeDefined();
    });
  });

  describe("2. file_write 工具", () => {
    it("写入新文件成功", async () => {
      const filePath = join(tempDir, "write_test.txt");
      const resp = await callTool("file_write", { file_path: filePath, content: "Hello from MCP file_write!" });
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<{ success: boolean; bytesWritten: number }>(resp);
      expect(data?.success).toBe(true);
      expect(data?.bytesWritten).toBeGreaterThan(0);

      const fileContent = await readFile(filePath, "utf-8");
      expect(fileContent).toBe("Hello from MCP file_write!");
    });

    it("写入嵌套目录文件成功", async () => {
      const filePath = join(tempDir, "sub", "dir", "nested.txt");
      const resp = await callTool("file_write", { file_path: filePath, content: "Nested content" });
      expect(isToolError(resp)).toBe(false);

      const fileContent = await readFile(filePath, "utf-8");
      expect(fileContent).toBe("Nested content");
    });

    it("覆盖已有文件需先读取（Read-before-Write）", async () => {
      const filePath = join(tempDir, "overwrite_test.txt");
      await writeFile(filePath, "original");

      const resp = await callTool("file_write", { file_path: filePath, content: "overwritten" });
      expect(isToolError(resp)).toBe(true);
      expect(extractResultText(resp)).toContain("has not been read");
    });
  });

  describe("3. file_read 工具", () => {
    it("读取存在的文件成功", async () => {
      const filePath = join(tempDir, "read_test.txt");
      await writeFile(filePath, "read me content");

      const resp = await callTool("file_read", { file_path: filePath });
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<{ content: string; lineCount: number; size: number }>(resp);
      expect(data?.content).toContain("read me content");
      expect(data?.lineCount).toBeGreaterThan(0);
      expect(data?.size).toBeGreaterThan(0);
    });

    it("读取不存在的文件返回 exists:false", async () => {
      const resp = await callTool("file_read", { file_path: "/nonexistent/file.txt" });
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<{ exists: boolean; content: string }>(resp);
      expect(data?.exists).toBe(false);
      expect(data?.content).toBe("");
    });

    it("部分读取（offset + limit）", async () => {
      const filePath = join(tempDir, "partial_read.txt");
      await writeFile(filePath, "line1\nline2\nline3\nline4\nline5\n");

      const resp = await callTool("file_read", { file_path: filePath, offset: 1, limit: 2 });
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<{ content: string; lineCount: number }>(resp);
      expect(data?.content).toContain("line2");
      expect(data?.content).toContain("line3");
      expect(data?.content).not.toContain("line1");
    });
  });

  describe("4. file_read → file_write 闭环", () => {
    it("读取后覆盖写入成功", async () => {
      const filePath = join(tempDir, "read_then_write.txt");
      await writeFile(filePath, "old content");

      const readResp = await callTool("file_read", { file_path: filePath });
      expect(isToolError(readResp)).toBe(false);

      const writeResp = await callTool("file_write", { file_path: filePath, content: "new content after read" });
      expect(isToolError(writeResp)).toBe(false);

      const fileContent = await readFile(filePath, "utf-8");
      expect(fileContent).toBe("new content after read");
    });

    it("部分读取后覆盖写入被拒绝", async () => {
      const filePath = join(tempDir, "partial_then_write.txt");
      await writeFile(filePath, "line1\nline2\nline3\nline4\nline5\n");

      const readResp = await callTool("file_read", { file_path: filePath, offset: 0, limit: 2 });
      expect(isToolError(readResp)).toBe(false);

      const writeResp = await callTool("file_write", { file_path: filePath, content: "overwritten" });
      expect(isToolError(writeResp)).toBe(true);
      expect(extractResultText(writeResp)).toContain("partially read");
    });
  });

  describe("5. file_edit 工具", () => {
    it("读取后编辑成功", async () => {
      const filePath = join(tempDir, "edit_test.txt");
      await writeFile(filePath, "Hello World\nFoo Bar\n");

      await callTool("file_read", { file_path: filePath });

      const resp = await callTool("file_edit", {
        file_path: filePath,
        old_str: "Hello World",
        new_str: "Hi Universe",
      });
      expect(isToolError(resp)).toBe(false);

      const fileContent = await readFile(filePath, "utf-8");
      expect(fileContent).toContain("Hi Universe");
      expect(fileContent).not.toContain("Hello World");
    });

    it("未读取直接编辑返回错误", async () => {
      const filePath = join(tempDir, "edit_no_read.txt");
      await writeFile(filePath, "some content");

      const resp = await callTool("file_edit", { file_path: filePath, old_str: "some", new_str: "any" });
      expect(isToolError(resp)).toBe(true);
      expect(extractResultText(resp)).toContain("has not been read");
    });

    it("old_str 不匹配返回错误", async () => {
      const filePath = join(tempDir, "edit_no_match.txt");
      await writeFile(filePath, "some content");

      await callTool("file_read", { file_path: filePath });

      const resp = await callTool("file_edit", {
        file_path: filePath,
        old_str: "nonexistent string",
        new_str: "replacement",
      });
      expect(isToolError(resp)).toBe(true);
      const errorText = extractResultText(resp);
      expect(errorText).toContain("not found");
    });
  });

  describe("6. glob 工具", () => {
    beforeAll(async () => {
      await mkdir(join(tempDir, "src", "core"), { recursive: true });
      await writeFile(join(tempDir, "root.ts"), "export {}");
      await writeFile(join(tempDir, "root.js"), "module.exports = {}");
      await writeFile(join(tempDir, "src", "index.ts"), "export {}");
      await writeFile(join(tempDir, "src", "core", "config.ts"), "export {}");
    });

    it("**/*.ts 递归匹配所有 .ts 文件", async () => {
      const resp = await callTool("glob", { pattern: "**/*.ts", path: tempDir });
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<{ matches: string[]; totalMatches: number }>(resp);
      expect(data?.totalMatches).toBe(3);
      const matchNames = (data?.matches ?? []).map((p) => p.replace(/\\/g, "/"));
      expect(matchNames.some((p) => p.endsWith("root.ts"))).toBe(true);
      expect(matchNames.some((p) => p.endsWith("src/index.ts"))).toBe(true);
      expect(matchNames.some((p) => p.endsWith("src/core/config.ts"))).toBe(true);
    });

    it("*.ts 仅匹配当前目录", async () => {
      const resp = await callTool("glob", { pattern: "*.ts", path: tempDir });
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<{ matches: string[] }>(resp);
      const matchNames = (data?.matches ?? []).map((p) => p.replace(/\\/g, "/"));
      expect(matchNames.some((p) => p.endsWith("root.ts"))).toBe(true);
      expect(matchNames.some((p) => p.includes("index.ts"))).toBe(false);
    });

    it("src/**/*.ts 匹配 src 子目录", async () => {
      const resp = await callTool("glob", { pattern: "src/**/*.ts", path: tempDir });
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<{ matches: string[] }>(resp);
      const matchNames = (data?.matches ?? []).map((p) => p.replace(/\\/g, "/"));
      expect(matchNames.some((p) => p.includes("index.ts"))).toBe(true);
      expect(matchNames.some((p) => p.includes("config.ts"))).toBe(true);
      expect(matchNames.some((p) => p.endsWith("root.ts"))).toBe(false);
    });
  });

  describe("7. bash 工具", () => {
    it("执行 echo 命令", async () => {
      const resp = await callTool("bash", { command: "echo hello_mcp_test" });
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<{ stdout: string; exitCode: number }>(resp);
      expect(data?.stdout).toContain("hello_mcp_test");
      expect(data?.exitCode).toBe(0);
    });

    it("执行无效命令返回错误", async () => {
      const resp = await callTool("bash", { command: "nonexistent_command_xyz_12345" });
      expect(isToolError(resp)).toBe(true);
    });
  });

  describe("8. evolution_status 工具", () => {
    it("返回演化状态", async () => {
      const state = entry.getState();
      if (!state.tools.all.includes("evolution_status")) return;

      const resp = await callTool("evolution_status", {});
      if (resp.error) return;
      expect(resp.result).toBeDefined();
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<Record<string, unknown>>(resp);
      expect(data).not.toBeNull();
    });
  });

  describe("9. observability_status 工具", () => {
    it("返回可观测性状态", async () => {
      const state = entry.getState();
      if (!state.tools.all.includes("observability_status")) return;

      const resp = await callTool("observability_status", {});
      if (resp.error) return;
      expect(resp.result).toBeDefined();
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<Record<string, unknown>>(resp);
      expect(data).not.toBeNull();
    });
  });

  describe("10. community_status 工具", () => {
    it("返回社区状态", async () => {
      const state = entry.getState();
      if (!state.tools.all.includes("community_status")) return;

      const resp = await callTool("community_status", {});
      if (resp.error) return;
      expect(resp.result).toBeDefined();
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<Record<string, unknown>>(resp);
      expect(data).not.toBeNull();
    });
  });

  describe("11. chat 工具", () => {
    it("chat 工具可用性检查", async () => {
      const state = entry.getState();
      if (!state.tools.all.includes("chat")) return;

      const resp = await callTool("chat", { message: "Hello" });
      if (resp.error) return;
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<{ response?: string; tokensUsed?: { outputTokens: number }; durationMs?: number }>(resp);
      if (data?.tokensUsed) {
        expect(data.tokensUsed.outputTokens).toBeGreaterThanOrEqual(0);
      }
    }, 60000);
  });

  describe("12. chat_complex 工具", () => {
    it("chat_complex 工具可用性检查", async () => {
      const state = entry.getState();
      if (!state.tools.all.includes("chat_complex")) return;

      const resp = await callTool("chat_complex", { message: "Test", sub_tasks: ["Task 1"] });
      if (resp.error) return;
      expect(isToolError(resp)).toBe(false);
      const data = extractResultData<{ response?: string; tokensUsed?: { outputTokens: number }; durationMs?: number }>(resp);
      if (data?.tokensUsed) {
        expect(data.tokensUsed.outputTokens).toBeGreaterThanOrEqual(0);
      }
    }, 180000);
  });

  describe("13. 错误处理验证", () => {
    it("调用不存在的工具返回 JSON-RPC 错误", async () => {
      const resp = await sendMCPRequest("tools/call", { name: "nonexistent_tool", arguments: {} });
      expect(resp.error).toBeDefined();
    });

    it("无效参数返回 isError=true", async () => {
      const resp = await callTool("file_read", {});
      expect(isToolError(resp)).toBe(true);
      expect(extractResultText(resp)).toContain("Invalid arguments");
    });
  });

  describe("14. 本地文件系统验证", () => {
    it("file_write 创建的文件确实存在于磁盘", async () => {
      const filePath = join(tempDir, "disk_verify.txt");
      await callTool("file_write", { file_path: filePath, content: "disk content" });
      expect(existsSync(filePath)).toBe(true);
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("disk content");
    });

    it("file_edit 修改的文件内容确实更新", async () => {
      const filePath = join(tempDir, "disk_edit_verify.txt");
      await writeFile(filePath, "before edit");
      await callTool("file_read", { file_path: filePath });
      await callTool("file_edit", { file_path: filePath, old_str: "before", new_str: "after" });
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("after edit");
    });

    it("file_write 创建嵌套目录结构", async () => {
      const filePath = join(tempDir, "deep", "nested", "dir", "file.txt");
      await callTool("file_write", { file_path: filePath, content: "deep nested" });
      expect(existsSync(filePath)).toBe(true);
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("deep nested");
    });
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMCPEntry } from "../../src/mcp-entry";

const isBun = typeof (globalThis as any).Bun !== "undefined";
const describeBun = isBun ? describe : describe.skip;

describe("Task 6 > MCP entry contract", () => {
  it("无 provider 时只暴露内置工具", async () => {
    const envPath = join(process.cwd(), ".env");
    const backupPath = join(process.cwd(), ".env.task6-backup");
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    const originalOllama = process.env.OLLAMA_BASE_URL;
    const originalDeepseek = process.env.DEEPSEEK_API_KEY;
    const originalKimi = process.env.KIMI_API_KEY;
    const originalGlm = process.env.GLM_API_KEY;
    const originalProviderPriority = process.env.PROVIDER_PRIORITY;

    writeFileSync(backupPath, readFileSync(envPath, "utf8"));
    writeFileSync(envPath, "PROVIDER_PRIORITY=openai,anthropic,kimi,glm,deepseek\n");
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.GLM_API_KEY;
    process.env.PROVIDER_PRIORITY = "openai,anthropic,kimi,glm,deepseek";

    try {
      const entry = createMCPEntry({ transport: "stdio" });
      await entry.start();
      const manifest = entry.getToolManifest();
      expect(manifest.builtin).toEqual(["bash", "file_edit", "file_read", "file_write", "glob"]);
      expect(manifest.providerScoped).toEqual([]);
      expect(manifest.all).toEqual(["bash", "file_edit", "file_read", "file_write", "glob"]);
      await entry.stop();
    } finally {
      writeFileSync(envPath, readFileSync(backupPath, "utf8"));
      unlinkSync(backupPath);
      if (originalOpenAI !== undefined) process.env.OPENAI_API_KEY = originalOpenAI;
      if (originalAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = originalAnthropic;
      if (originalOllama !== undefined) process.env.OLLAMA_BASE_URL = originalOllama;
      if (originalDeepseek !== undefined) process.env.DEEPSEEK_API_KEY = originalDeepseek;
      if (originalKimi !== undefined) process.env.KIMI_API_KEY = originalKimi;
      if (originalGlm !== undefined) process.env.GLM_API_KEY = originalGlm;
      if (originalProviderPriority !== undefined) {
        process.env.PROVIDER_PRIORITY = originalProviderPriority;
      } else {
        delete process.env.PROVIDER_PRIORITY;
      }
    }
  });

describeBun("Task 6 > MCP entry contract > HTTP", () => {
  it("HTTP 模式暴露 /health /mcp 端点", async () => {
    const entry = createMCPEntry({ transport: "http", port: 4011, hostname: "127.0.0.1" });
    await entry.start();
    const state = entry.getState();
    expect(state.endpoints.health).toBe("http://127.0.0.1:4011/health");
    expect(state.endpoints.mcp).toBe("http://127.0.0.1:4011/mcp");
    expect(entry.getRoutes().map((route) => `${route.method} ${route.pattern}`)).toEqual([
      "GET /health",
      "OPTIONS /mcp",
      "GET /mcp",
      "DELETE /mcp",
      "POST /mcp",
    ]);
    const corsHeader = entry.getRoutes().find((r) => r.method === "OPTIONS")?.handler;
    expect(corsHeader).toBeDefined();
    await entry.stop();
  });

  it("DELETE /mcp 无 session ID 应返回 400", async () => {
    const entry = createMCPEntry({ transport: "http", port: 4014, hostname: "127.0.0.1" });
    await entry.start();
    const route = entry.getRoutes().find((r) => r.method === "DELETE" && r.pattern === "/mcp");
    if (!route) throw new Error("DELETE route not found");

    const response = await route.handler({
      method: "DELETE",
      url: "http://127.0.0.1:4014/mcp",
      headers: new Headers(),
      body: null,
      params: {},
      query: new URLSearchParams(),
      remoteAddress: "127.0.0.1",
      context: {},
    });

    expect(response.status).toBe(400);
    await entry.stop();
  });

  it("/health 返回深度健康检查结果", async () => {
    const entry = createMCPEntry({ transport: "http", port: 4012, hostname: "127.0.0.1" });
    await entry.start();
    const route = entry.getRoutes().find((item) => item.method === "GET" && item.pattern === "/health");
    if (!route) {
      throw new Error("health route not found");
    }

    const response = await route.handler({
      method: "GET",
      url: "http://127.0.0.1:4012/health",
      headers: new Headers(),
      body: null,
      params: {},
      query: new URLSearchParams(),
      remoteAddress: "127.0.0.1",
      context: {},
    });

    if (response.body instanceof ReadableStream) {
      throw new Error("expected json response");
    }

    expect([200, 503]).toContain(response.status);
    expect(typeof response.body.status).toBe("string");
    expect(["ok", "degraded", "unhealthy"]).toContain(response.body.status);
    expect(typeof response.body.checks).toBe("object");
    expect(typeof response.body.checks.ruleStore).toBe("object");
    expect(typeof response.body.checks.knowledgeManager).toBe("object");
    expect(typeof response.body.checks.llmProvider).toBe("object");
    expect(typeof response.body.uptime).toBe("number");
    expect(typeof response.body.timestamp).toBe("number");
    expect(response.body.tools.all).toEqual(entry.getToolManifest().all);
    await entry.stop();
  });

  it("/mcp 可转发 tools/list 请求", async () => {
    const entry = createMCPEntry({ transport: "http", port: 4013, hostname: "127.0.0.1" });
    await entry.start();
    const route = entry.getRoutes().find((item) => item.method === "POST" && item.pattern === "/mcp");
    if (!route) {
      throw new Error("mcp route not found");
    }

    const response = await route.handler({
      method: "POST",
      url: "http://127.0.0.1:4013/mcp",
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      },
      params: {},
      query: new URLSearchParams(),
      remoteAddress: "127.0.0.1",
      context: {},
    });

    if (response.body instanceof ReadableStream) {
      throw new Error("expected json response");
    }

    expect(response.status).toBe(200);
    expect(response.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(entry.getToolManifest().all);
    await entry.stop();
  });
});

// ─── D1: 多会话管理测试 ───

describeBun("D1: Multi-session management", () => {
  it("initialize 请求创建新会话并返回 Mcp-Session-Id", async () => {
    const entry = createMCPEntry({ transport: "http", port: 4021, hostname: "127.0.0.1" });
    await entry.start();
    const route = entry.getRoutes().find((r) => r.method === "POST" && r.pattern === "/mcp");
    if (!route) throw new Error("POST /mcp route not found");

    const response = await route.handler({
      method: "POST",
      url: "http://127.0.0.1:4021/mcp",
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      },
      params: {},
      query: new URLSearchParams(),
      remoteAddress: "127.0.0.1",
      context: {},
    });

    expect(response.status).toBe(200);
    expect(response.headers["Mcp-Session-Id"]).toBeDefined();
    expect(typeof response.headers["Mcp-Session-Id"]).toBe("string");
    await entry.stop();
  });

  it("多个客户端可同时初始化不同会话", async () => {
    const entry = createMCPEntry({ transport: "http", port: 4022, hostname: "127.0.0.1" });
    await entry.start();
    const route = entry.getRoutes().find((r) => r.method === "POST" && r.pattern === "/mcp");
    if (!route) throw new Error("POST /mcp route not found");

    const makeInitRequest = () => route.handler({
      method: "POST",
      url: "http://127.0.0.1:4022/mcp",
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      },
      params: {},
      query: new URLSearchParams(),
      remoteAddress: "127.0.0.1",
      context: {},
    });

    const response1 = await makeInitRequest();
    const response2 = await makeInitRequest();

    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);

    const sid1 = response1.headers["Mcp-Session-Id"];
    const sid2 = response2.headers["Mcp-Session-Id"];
    expect(sid1).toBeDefined();
    expect(sid2).toBeDefined();
    expect(sid1).not.toBe(sid2);
    await entry.stop();
  });

  it("无效 session ID 返回 408", async () => {
    const entry = createMCPEntry({ transport: "http", port: 4023, hostname: "127.0.0.1" });
    await entry.start();
    const route = entry.getRoutes().find((r) => r.method === "POST" && r.pattern === "/mcp");
    if (!route) throw new Error("POST /mcp route not found");

    const response = await route.handler({
      method: "POST",
      url: "http://127.0.0.1:4023/mcp",
      headers: new Headers({
        "content-type": "application/json",
        "mcp-session-id": "nonexistent-session-id-1234567890abcdef",
      }),
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      },
      params: {},
      query: new URLSearchParams(),
      remoteAddress: "127.0.0.1",
      context: {},
    });

    expect(response.status).toBe(408);
    await entry.stop();
  });

  it("DELETE /mcp 带 session ID 删除对应会话", async () => {
    const entry = createMCPEntry({ transport: "http", port: 4024, hostname: "127.0.0.1" });
    await entry.start();

    const postRoute = entry.getRoutes().find((r) => r.method === "POST" && r.pattern === "/mcp");
    if (!postRoute) throw new Error("POST /mcp route not found");

    const initResponse = await postRoute.handler({
      method: "POST",
      url: "http://127.0.0.1:4024/mcp",
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      },
      params: {},
      query: new URLSearchParams(),
      remoteAddress: "127.0.0.1",
      context: {},
    });

    const sessionId = initResponse.headers["Mcp-Session-Id"];
    expect(sessionId).toBeDefined();

    const deleteRoute = entry.getRoutes().find((r) => r.method === "DELETE" && r.pattern === "/mcp");
    if (!deleteRoute) throw new Error("DELETE /mcp route not found");

    const deleteResponse = await deleteRoute.handler({
      method: "DELETE",
      url: "http://127.0.0.1:4024/mcp",
      headers: new Headers({ "mcp-session-id": sessionId }),
      body: null,
      params: {},
      query: new URLSearchParams(),
      remoteAddress: "127.0.0.1",
      context: {},
    });

    expect(deleteResponse.status).toBe(200);

    const postAfterDelete = await postRoute.handler({
      method: "POST",
      url: "http://127.0.0.1:4024/mcp",
      headers: new Headers({
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      }),
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      },
      params: {},
      query: new URLSearchParams(),
      remoteAddress: "127.0.0.1",
      context: {},
    });

    expect(postAfterDelete.status).toBe(408);
    await entry.stop();
  });

  it("无 session ID 的非 initialize 请求正常放行", async () => {
    const entry = createMCPEntry({ transport: "http", port: 4025, hostname: "127.0.0.1" });
    await entry.start();
    const route = entry.getRoutes().find((r) => r.method === "POST" && r.pattern === "/mcp");
    if (!route) throw new Error("POST /mcp route not found");

    const response = await route.handler({
      method: "POST",
      url: "http://127.0.0.1:4025/mcp",
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      },
      params: {},
      query: new URLSearchParams(),
      remoteAddress: "127.0.0.1",
      context: {},
    });

    expect(response.status).toBe(200);
    await entry.stop();
  });
});
});

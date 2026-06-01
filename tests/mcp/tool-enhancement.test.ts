import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MockProvider } from "../../src/llm/mock";
import { registerBuiltinTools, registerEvolutionTools, registerCommunicationTools } from "../../src/mcp-entry";
import type { MCPServer } from "../../src/mcp/server";
import type { EvoAgentContext } from "../../src/integration/context";
import type { Tool, ToolResult } from "../../src/interfaces/tool";

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

const passthroughSchema = z.object({}).passthrough();

function createBashTool(exitCode: number, stderr: string): Tool<typeof passthroughSchema> {
  return {
    name: "bash",
    description: "Execute bash commands",
    inputSchema: passthroughSchema,
    maxResultSizeChars: 10_000,
    checkPermissions: async () => ({ behavior: "allow" }),
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    call: async () => ({
      content: { stdout: "", stderr, exitCode, timedOut: false },
      isError: exitCode !== 0,
    } satisfies ToolResult<unknown>),
  };
}

function createFileReadTool(totalLines: number, content: string): Tool<typeof passthroughSchema> {
  return {
    name: "file_read",
    description: "Read file contents",
    inputSchema: passthroughSchema,
    maxResultSizeChars: 10_000,
    checkPermissions: async () => ({ behavior: "allow" }),
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    call: async () => ({
      content: { content, lineCount: totalLines, totalLines, truncated: false, encoding: "utf-8", size: content.length },
      isError: false,
    } satisfies ToolResult<unknown>),
  };
}

function createFileEditTool(success: boolean, path: string): Tool<typeof passthroughSchema> {
  return {
    name: "file_edit",
    description: "Edit file contents",
    inputSchema: passthroughSchema,
    maxResultSizeChars: 10_000,
    checkPermissions: async () => ({ behavior: "allow" }),
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    call: async () => ({
      content: { success, path, replacements: 1, bytesChanged: 42 },
      isError: !success,
    } satisfies ToolResult<unknown>),
  };
}

function createMockCtx(provider: MockProvider, tools: Tool[]): EvoAgentContext {
  return {
    provider,
    tools,
    getEngine: () => ({}) as never,
    getOrchestrator: () => ({}) as never,
    getEvolutionEngine: () => ({ getState: () => ({}), getEMACalculator: () => ({ getCurrent: () => 0, getTrend: () => "stable" as const, getHistory: () => [] }), getTriggerBudget: () => ({ getState: () => ({}) }) }) as never,
    getRuleStore: () => ({ getAll: async () => [] }) as never,
    getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) as never,
    getStatsStore: () => ({ getAll: () => ({}) }) as never,
    getCostTracker: () => ({ getTotalCost: () => 0, getTotalUsage: () => 0, getUsageByModel: () => new Map() }) as never,
    getProgressTracker: () => ({}) as never,
    getGateway: () => ({ listPeers: () => [], getActivePeerCount: () => 0, getStats: () => ({}) }) as never,
    getCritic: () => ({ analyzeMessage: async () => ({ processingResult: "ACCEPT", confidence: 0.8, flawedAspects: [] }) }) as never,
    getConsensusEngine: () => ({}) as never,
    getReputationSystem: () => ({}) as never,
    getCommunity: () => ({ getOpenProposals: () => [] }) as never,
    getMarketplace: () => ({ search: () => [] }) as never,
    getAnalytics: () => ({ getSummary: () => ({}) }) as never,
    chat: async () => ({ response: "test", tokensUsed: 10, agentCount: 1, evolutionTriggered: false, durationMs: 100, terminal: { reason: "done" as const } }) as never,
    chatComplex: async () => ({ response: "test", tokensUsed: 10, agentCount: 1, evolutionTriggered: false, durationMs: 100, terminal: { reason: "done" as const } }) as never,
    recordTaskCompletion: async () => {},
    recordCost: () => {},
    getEvolutionState: () => ({}) as never,
    getProgress: () => ({}) as never,
    shutdown: () => {},
    gracefulShutdown: async () => {},
  };
}

describe("C.1 MCP 工具增强契约与当前实现一致", () => {
  it("registerBuiltinTools 直接注册传入工具，不附加历史 LLM 增强字段", async () => {
    const provider = new MockProvider();
    const { server, handlers } = createMockMCPServer();
    const tools = [
      createBashTool(1, "Permission denied: /etc/config"),
      createFileReadTool(100, "line1\n".repeat(100)),
      createFileEditTool(true, "/src/engine.ts"),
    ];
    const ctx = createMockCtx(provider, tools);

    registerBuiltinTools(server, ctx.tools as never);

    const bashResult = await handlers.get("bash")!({ command: "cat /etc/config" }) as ToolResult<Record<string, unknown>>;
    expect(bashResult.content.stderr).toBe("Permission denied: /etc/config");
    expect((bashResult.content as Record<string, unknown>).llm_diagnosis).toBeUndefined();

    const readResult = await handlers.get("file_read")!({ file_path: "/test.ts" }) as ToolResult<Record<string, unknown>>;
    expect(readResult.content.totalLines).toBe(100);
    expect((readResult.content as Record<string, unknown>).llm_summary).toBeUndefined();

    const editResult = await handlers.get("file_edit")!({ file_path: "/src/engine.ts", old_str: "a", new_str: "b" }) as ToolResult<Record<string, unknown>>;
    expect(editResult.content.success).toBe(true);
    expect((editResult.content as Record<string, unknown>).llm_impact).toBeUndefined();
    expect(provider.callHistory.length).toBe(0);
  });
});

describe("C.2 provider-scoped MCP 工具与当前实现一致", () => {
  it("registerEvolutionTools 当前只暴露 evolution_status", async () => {
    const provider = new MockProvider();
    const { server, handlers } = createMockMCPServer();
    const ctx = createMockCtx(provider, []);
    ctx.getRuleStore = () => ({
      getAll: async () => [
        { status: "ACTIVE", trigger_pattern: "timeout", action: "RETRY", priority: 0.8 },
      ],
    }) as never;

    registerEvolutionTools(server, ctx);

    expect(handlers.has("evolution_status")).toBe(true);
    expect(handlers.has("evolution_rules")).toBe(false);
    const result = await handlers.get("evolution_status")!({}) as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(Array.isArray(data.activeRules)).toBe(true);
    expect(provider.callHistory.length).toBe(0);
  });

  it("registerCommunicationTools 当前只暴露 community_status，不暴露 marketplace_search", async () => {
    const provider = new MockProvider();
    const { server, handlers } = createMockMCPServer();
    const ctx = createMockCtx(provider, []);

    registerCommunicationTools(server, ctx);

    expect(handlers.has("community_status")).toBe(true);
    expect(handlers.has("marketplace_search")).toBe(false);
    const result = await handlers.get("community_status")!({}) as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(data.proposals).toEqual([]);
    expect(data.analytics).toEqual({});
    expect(provider.callHistory.length).toBe(0);
  });
});


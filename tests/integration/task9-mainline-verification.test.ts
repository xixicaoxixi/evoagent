import { describe, expect, it } from "vitest";
import { createMCPEntry } from "../../src/mcp-entry";
import { createBuiltinTools } from "../../src/tools/builtin";
import { createQueryEngine } from "../../src/core/query/engine";
import { createOrchestrator } from "../../src/core/agent/orchestrator";
import { getModuleLedgerEntries } from "../../src/module-ledger";
import { allowPermission } from "../../src/types/permission";
import type { LLMMessageParam, LLMProvider, LLMResponse, LLMStreamChunk } from "../../src/interfaces/llm-provider";

const isBun = typeof (globalThis as any).Bun !== "undefined";

class StreamThrowingProvider implements LLMProvider {
  readonly providerType = "mock";
  readonly model = "stream-throwing";
  readonly temperature = 0;
  readonly maxTokens = 1024;

  async invoke(_messages: readonly LLMMessageParam[]): Promise<LLMResponse> {
    return {
      content: "unused",
      stopReason: "end_turn",
      model: this.model,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  }

  async *stream(_messages: readonly LLMMessageParam[]): AsyncGenerator<LLMStreamChunk> {
    throw new Error("stream exploded");
  }

  countTokens(text: string): number {
    return text.length;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function createToolUseContext() {
  return {
    cwd: process.cwd(),
    getAppState: () => ({}),
  };
}

function createTestBuiltinTools() {
  return createBuiltinTools({
    bashPermissionContext: {
      sandboxed: true,
      rules: [{ pattern: ".*", behavior: "allow" }],
    },
  });
}

async function collectTerminalReason(prompt: string, provider: LLMProvider): Promise<string> {
  const engine = createQueryEngine({
    provider,
    tools: createTestBuiltinTools(),
    canUseTool: () => allowPermission(),
    baseSystemPrompt: "You are EvoAgent.",
    toolUseContext: createToolUseContext(),
    maxTurns: 2,
    tokenBudget: 2000,
  });

  const stream = engine.submitMessage(prompt);
  let step = await stream.next();
  while (!step.done) {
    step = await stream.next();
  }

  return step.value.reason;
}

describe("Task 9 > mainline verification", () => {
  it("查询引擎在 provider stream 抛错时返回 model_error", async () => {
    const reason = await collectTerminalReason("hello", new StreamThrowingProvider());
    expect(reason).toBe("model_error");
  });

  it.skipIf(!isBun)("MCP HTTP 状态能通过入口对象暴露协议级边界信息", async () => {
    const entry = createMCPEntry({ transport: "http", hostname: "127.0.0.1", port: 3001 });
    await entry.start();
    try {
      const status = entry.getState();
      expect(status.transport).toBe("http");
      expect(status.endpoints.mcp).toBe("http://127.0.0.1:3001/mcp");
      expect(status.endpoints.health).toBe("http://127.0.0.1:3001/health");
    } finally {
      await entry.stop();
    }
  });

  it("内置工具集仍可创建并暴露工具名称", () => {
    const tools = createTestBuiltinTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((tool) => tool.name === "bash")).toBe(true);
  });

  it("主链 orchestration 仍能生成计划并写入模块账本", async () => {
    const orchestrator = createOrchestrator({
      provider: new StreamThrowingProvider(),
      tools: createTestBuiltinTools(),
      canUseTool: () => allowPermission(),
      baseSystemPrompt: "You are EvoAgent.",
      toolUseContext: createToolUseContext(),
    });

    const plan = await orchestrator.plan("verify provider propagation");
    expect(["llm_success", "llm_parse_fallback"]).toContain(plan.diagnostics.source);
    expect(plan.subTasks.length).toBeGreaterThan(0);
    expect(plan.subTasks[0]?.description).toBeDefined();

    const modules = getModuleLedgerEntries();
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.some((entry) => entry.module === "server")).toBe(true);
  });
});

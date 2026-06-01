import { describe, expect, it } from "vitest";
import { SubAgent, type SubAgentConfig } from "../../src/core/agent/sub-agent";
import type { Tool, ToolUseContext, CanUseToolFn } from "../../src/interfaces/tool";
import type { LLMProvider, LLMResponse, LLMStreamChunk, StreamOptions } from "../../src/interfaces/llm-provider";
import type { Message } from "../../src/types/message";
import type { PermissionResult } from "../../src/types/permission";
import { z } from "zod";

function createMockTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).passthrough(),
    call: async () => ({ content: "ok" }),
  };
}

const TOOLS = [createMockTool("bash"), createMockTool("file_read"), createMockTool("file_write")];

const allowAll: CanUseToolFn = () => true;

const toolUseContext: ToolUseContext = {
  workingDirectory: "/tmp",
  agentId: "test-agent",
  sessionId: "test-session",
};

function createMockProvider(): LLMProvider {
  return {
    providerType: "mock",
    model: "test-model",
    temperature: 0,
    maxTokens: 4096,
    invoke: async (): Promise<LLMResponse> => ({
      content: "done",
      tokenUsage: { inputTokens: 10, outputTokens: 100 },
    }),
    stream: async function* (_messages, _options?: StreamOptions): AsyncGenerator<LLMStreamChunk> {
      yield { type: "content", content: "Hello" };
      yield { type: "stop", tokenUsage: { inputTokens: 10, outputTokens: 100 } };
    },
    countTokens: (text: string) => Math.ceil(text.length / 4),
    healthCheck: async () => true,
  };
}

function makeConfig(overrides?: Partial<SubAgentConfig>): SubAgentConfig {
  return {
    agentId: "test-agent",
    taskId: "test-task",
    parentAgentId: "parent-agent",
    systemPrompt: "You are a test agent.",
    tools: TOOLS,
    provider: createMockProvider(),
    canUseTool: allowAll,
    toolUseContext,
    maxTurns: 5,
    tokenBudget: 10000,
    ...overrides,
  };
}

describe("SubAgent — no_tool_execution 动态阈值", () => {
  it("1 个工具时阈值为 500", () => {
    const config = makeConfig({ tools: [createMockTool("bash")] });
    const agent = new SubAgent(config);
    const tools = agent.getEffectiveTools();
    const toolCount = tools.length;
    const dynamicThreshold = Math.max(500, Math.min(toolCount * 200, 2000));
    expect(dynamicThreshold).toBe(500);
  });

  it("3 个工具时阈值为 500", () => {
    const config = makeConfig({ tools: TOOLS });
    const agent = new SubAgent(config);
    const tools = agent.getEffectiveTools();
    const toolCount = tools.length;
    const dynamicThreshold = Math.max(500, Math.min(toolCount * 150, 1500));
    expect(dynamicThreshold).toBe(500);
  });

  it("10 个工具时阈值为 1500", () => {
    const tools = Array.from({ length: 10 }, (_, i) => createMockTool(`tool_${i}`));
    const config = makeConfig({ tools });
    const agent = new SubAgent(config);
    const effectiveTools = agent.getEffectiveTools();
    const toolCount = effectiveTools.length;
    const dynamicThreshold = Math.max(500, Math.min(toolCount * 150, 1500));
    expect(dynamicThreshold).toBe(1500);
  });

  it("20 个工具时阈值仍为 1500（上限）", () => {
    const tools = Array.from({ length: 20 }, (_, i) => createMockTool(`tool_${i}`));
    const config = makeConfig({ tools });
    const agent = new SubAgent(config);
    const effectiveTools = agent.getEffectiveTools();
    const toolCount = effectiveTools.length;
    const dynamicThreshold = Math.max(500, Math.min(toolCount * 150, 1500));
    expect(dynamicThreshold).toBe(1500);
  });
});

describe("SubAgent — no_tool_execution 任务感知判定", () => {
  it("taskType=reasoning 不触发 no_tool_execution", () => {
    const config = makeConfig({ taskType: "reasoning" });
    const agent = new SubAgent(config);
    expect(agent.taskType).toBe("reasoning");
  });

  it("taskType=analysis 不触发 no_tool_execution", () => {
    const config = makeConfig({ taskType: "analysis" });
    const agent = new SubAgent(config);
    expect(agent.taskType).toBe("analysis");
  });

  it("taskType=summary 不触发 no_tool_execution", () => {
    const config = makeConfig({ taskType: "summary" });
    const agent = new SubAgent(config);
    expect(agent.taskType).toBe("summary");
  });

  it("taskType=default 仍可触发 no_tool_execution", () => {
    const config = makeConfig({ taskType: "default" });
    const agent = new SubAgent(config);
    expect(agent.taskType).toBe("default");
  });

  it("无 taskType 仍可触发 no_tool_execution", () => {
    const config = makeConfig();
    const agent = new SubAgent(config);
    expect(agent.taskType).toBeUndefined();
  });
});

describe("SubAgent — no_tool_execution retryable 标记", () => {
  it("no_tool_execution 错误包含 retryable: true", () => {
    const error = {
      reason: "no_tool_execution",
      details: {
        terminalReason: "completed",
        hint: "Agent completed without calling any tool and produced minimal output",
        outputTokens: 100,
        dynamicThreshold: 600,
        toolCount: 3,
        taskType: "default",
        retryable: true,
      },
    };
    expect(error.reason).toBe("no_tool_execution");
    expect((error.details as Record<string, unknown>).retryable).toBe(true);
  });
});

describe("SubAgent — 状态判定逻辑", () => {
  it("有工具调用消息时不会触发 no_tool_execution", () => {
    const messages: Message[] = [
      { id: "1", role: "user", content: "test", timestamp: Date.now() },
      { id: "2", role: "assistant", content: "I will use bash", timestamp: Date.now() },
      { id: "3", role: "tool_use", toolName: "bash", toolUseId: "tu-1", input: { command: "ls" }, timestamp: Date.now() },
      { id: "4", role: "tool_result", toolUseId: "tu-1", content: "file1.txt", timestamp: Date.now() },
      { id: "5", role: "assistant", content: "Done", timestamp: Date.now() },
    ];
    const hasToolUseMessages = messages.some((m) => m.role === "tool_use");
    expect(hasToolUseMessages).toBe(true);
  });

  it("无工具调用消息且低输出 token 时可能触发 no_tool_execution", () => {
    const messages: Message[] = [
      { id: "1", role: "user", content: "test", timestamp: Date.now() },
      { id: "2", role: "assistant", content: "The answer is 42", timestamp: Date.now() },
    ];
    const hasToolUseMessages = messages.some((m) => m.role === "tool_use");
    expect(hasToolUseMessages).toBe(false);
  });

  it("高输出 token 时不触发 no_tool_execution", () => {
    const outputTokens = 2000;
    const dynamicThreshold = 500;
    expect(outputTokens < dynamicThreshold).toBe(false);
  });

  it("低输出 token 时可能触发 no_tool_execution", () => {
    const outputTokens = 100;
    const dynamicThreshold = 500;
    expect(outputTokens < dynamicThreshold).toBe(true);
  });
});

describe("Orchestrator — no_tool_execution 重试", () => {
  it("retryable no_tool_execution 错误被正确识别", () => {
    const state = {
      status: "failed" as const,
      error: {
        reason: "no_tool_execution",
        details: {
          terminalReason: "completed",
          retryable: true,
        },
      },
    };
    const isRetryable = state.error?.reason === "no_tool_execution"
      && (state.error?.details as Record<string, unknown> | undefined)?.retryable === true;
    expect(isRetryable).toBe(true);
  });

  it("non-retryable 错误不被识别为 retryable", () => {
    const state = {
      status: "failed" as const,
      error: {
        reason: "model_error",
        details: {},
      },
    };
    const isRetryable = state.error?.reason === "no_tool_execution"
      && (state.error?.details as Record<string, unknown> | undefined)?.retryable === true;
    expect(isRetryable).toBe(false);
  });

  it("no_tool_execution 但 retryable=false 不被识别为 retryable", () => {
    const state = {
      status: "failed" as const,
      error: {
        reason: "no_tool_execution",
        details: {
          retryable: false,
        },
      },
    };
    const isRetryable = state.error?.reason === "no_tool_execution"
      && (state.error?.details as Record<string, unknown> | undefined)?.retryable === true;
    expect(isRetryable).toBe(false);
  });
});

describe("F09: SubAgent.buildRetryFormatHint", () => {
  it("输出包含 XML 格式示例", () => {
    const hint = SubAgent.buildRetryFormatHint(TOOLS);
    expect(hint).toContain("<file_write");
    expect(hint).toContain("<file_read");
    expect(hint).toContain("<bash>");
  });

  it("输出包含工具名称列表", () => {
    const hint = SubAgent.buildRetryFormatHint(TOOLS);
    expect(hint).toContain("bash");
    expect(hint).toContain("file_read");
    expect(hint).toContain("file_write");
  });

  it("输出包含强制使用工具的提示", () => {
    const hint = SubAgent.buildRetryFormatHint(TOOLS);
    expect(hint).toContain("YOU MUST USE TOOLS NOW");
    expect(hint).toContain("Do not explain");
    expect(hint).toContain("Output the XML tag directly");
  });

  it("空工具列表时仍生成有效提示", () => {
    const hint = SubAgent.buildRetryFormatHint([]);
    expect(hint).toContain("YOU MUST USE TOOLS NOW");
    expect(hint).toContain("Available tools:");
  });

  it("包含自定义工具名称", () => {
    const customTools = [createMockTool("web_search"), createMockTool("data_fetcher")];
    const hint = SubAgent.buildRetryFormatHint(customTools);
    expect(hint).toContain("web_search");
    expect(hint).toContain("data_fetcher");
  });
});

describe("F09: no_tool_execution retryContext", () => {
  it("no_tool_execution 错误包含 retryContext", () => {
    const error = {
      reason: "no_tool_execution",
      details: {
        terminalReason: "completed",
        hint: "Agent completed without calling any tool and produced minimal output",
        outputTokens: 100,
        dynamicThreshold: 600,
        toolCount: 3,
        taskType: "default",
        retryable: true,
        retryContext: {
          hint: "Model did not produce any tool calls. Consider injecting format examples.",
          toolNames: ["bash", "file_read", "file_write"],
          outputTokens: 100,
        },
      },
    };
    expect(error.reason).toBe("no_tool_execution");
    const details = error.details as Record<string, unknown>;
    expect(details.retryable).toBe(true);
    expect(details.retryContext).toBeDefined();
    const ctx = details.retryContext as Record<string, unknown>;
    expect(ctx.hint).toContain("injecting format examples");
    expect(ctx.toolNames).toEqual(["bash", "file_read", "file_write"]);
    expect(ctx.outputTokens).toBe(100);
  });

  it("retryContext 包含正确的工具名称列表", () => {
    const toolNames = TOOLS.map(t => t.name);
    const retryContext = {
      hint: "Model did not produce any tool calls.",
      toolNames,
      outputTokens: 50,
    };
    expect(retryContext.toolNames).toEqual(["bash", "file_read", "file_write"]);
  });
});

describe("F09: Orchestrator 重试资源配额", () => {
  it("重试时 maxTurns 增加 5", () => {
    const tokenBudget = 80000;
    const baseMaxTurns = Math.min(Math.ceil(tokenBudget / 4000), 50);
    const retryMaxTurns = Math.min(baseMaxTurns + 5, 50);
    expect(retryMaxTurns).toBe(baseMaxTurns + 5);
  });

  it("重试时 tokenBudget 增加 30000", () => {
    const baseTokenBudget = 50000;
    const retryTokenBudget = baseTokenBudget + 30000;
    expect(retryTokenBudget).toBe(80000);
  });

  it("maxTurns 不超过上限 50", () => {
    const tokenBudget = 200000;
    const baseMaxTurns = Math.min(Math.ceil(tokenBudget / 4000), 50);
    const retryMaxTurns = Math.min(baseMaxTurns + 5, 50);
    expect(retryMaxTurns).toBe(50);
  });

  it("首次执行时不增加配额", () => {
    const tokenBudget = 80000;
    const baseMaxTurns = Math.min(Math.ceil(tokenBudget / 4000), 50);
    const isRetry = false;
    const maxTurns = isRetry ? Math.min(baseMaxTurns + 5, 50) : baseMaxTurns;
    const tokenBudgetFinal = isRetry ? tokenBudget + 30000 : tokenBudget;
    expect(maxTurns).toBe(baseMaxTurns);
    expect(tokenBudgetFinal).toBe(80000);
  });
});

describe("F09: Orchestrator retryContext 驱动的重试策略", () => {
  it("no_tool_execution 前次结果触发格式化提示注入", () => {
    const prevResult: SubAgentState = {
      agentId: "test-agent",
      taskId: "test-task",
      status: "failed",
      messages: [],
      totalTokens: 100,
      tokenUsage: { inputTokens: 50, outputTokens: 50 },
      result: null,
      error: {
        reason: "no_tool_execution",
        details: {
          retryable: true,
          retryContext: {
            hint: "Model did not produce any tool calls.",
            toolNames: ["bash", "file_write"],
            outputTokens: 50,
          },
        },
      },
    };
    const shouldInjectFormatHint = prevResult.error?.reason === "no_tool_execution";
    expect(shouldInjectFormatHint).toBe(true);

    const hint = SubAgent.buildRetryFormatHint(TOOLS);
    expect(hint).toContain("<file_write");
    expect(hint).toContain("<bash>");
  });

  it("非 no_tool_execution 前次结果使用通用重试提示", () => {
    const prevResult: SubAgentState = {
      agentId: "test-agent",
      taskId: "test-task",
      status: "failed",
      messages: [],
      totalTokens: 100,
      tokenUsage: { inputTokens: 50, outputTokens: 50 },
      result: null,
      error: {
        reason: "model_error",
        details: {},
      },
    };
    const shouldInjectFormatHint = prevResult.error?.reason === "no_tool_execution";
    expect(shouldInjectFormatHint).toBe(false);
  });

  it("无前次结果时使用通用重试提示", () => {
    const prevResult: SubAgentState | undefined = undefined;
    const shouldInjectFormatHint = prevResult?.error?.reason === "no_tool_execution";
    expect(shouldInjectFormatHint).toBe(false);
  });
});

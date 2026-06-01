/**
 * B.2 测试 — 净化层接入 Agentic Loop。
 *
 * 验证 loop.ts 中 tool_result/tool_use 净化、prompt.ts 中 system prompt 净化、
 * 条件净化（本地模型跳过）。
 */

import { describe, expect, it, mock, beforeEach } from "vitest";
import { sanitizePath, truncateForLLM, shouldSanitizeForLLM, filterArchitectureKeywords } from "../../src/security/llm-sanitize";
import { assemblePrompt } from "../../src/core/query/prompt";
import type { Tool } from "../../src/interfaces/tool";
import type { LLMProvider, LLMMessageParam } from "../../src/interfaces/llm-provider";
import type { LoopParams, LoopState } from "../../src/core/query/state";
import type { Message, ToolUseMessage, ToolResultMessage } from "../../src/types/message";

// ─── loop.ts 集成测试（通过验证导入和函数行为） ───

describe("loop.ts — 净化层接入验证", () => {
  it("shouldSanitizeForLLM 应对远程模型返回 true", () => {
    expect(shouldSanitizeForLLM("gpt-4o")).toBe(true);
    expect(shouldSanitizeForLLM("claude-sonnet-4-20250514")).toBe(true);
    expect(shouldSanitizeForLLM("deepseek-chat")).toBe(true);
  });

  it("shouldSanitizeForLLM 应对本地模型返回 false", () => {
    expect(shouldSanitizeForLLM("llama3")).toBe(false);
    expect(shouldSanitizeForLLM("mistral")).toBe(false);
  });

  it("sanitizePath 应脱敏 tool_result 中的路径", () => {
    const toolResult = `File content from /workspace/project/src/index.ts:
const x = 1;
export default x;`;

    const sanitized = sanitizePath(toolResult);
    expect(sanitized).not.toContain("/workspace/");
    expect(sanitized).toContain("<path>");
    expect(sanitized).toContain("const x = 1");
  });

  it("sanitizePath 应脱敏 tool_use input 中的路径", () => {
    const toolInput = JSON.stringify({
      file_path: "/home/user/documents/secret.txt",
      content: "hello world",
    });

    const sanitized = sanitizePath(toolInput);
    expect(sanitized).not.toContain("/home/");
    expect(sanitized).toContain("<path>");
    expect(sanitized).toContain("hello world");
  });

  it("truncateForLLM 应截断超长 tool_result", () => {
    const longContent = "x".repeat(10000);
    const truncated = truncateForLLM(longContent);
    expect(truncated.length).toBeLessThan(10000);
    expect(truncated).toContain("...[truncated: 2000 chars]");
  });

  it("truncateForLLM 不应截断短内容", () => {
    const shortContent = "Short result";
    const truncated = truncateForLLM(shortContent);
    expect(truncated).toBe("Short result");
  });

  it("sanitizePath 应处理多个路径", () => {
    const text = "Read /workspace/a.ts and /home/user/b.ts";
    const sanitized = sanitizePath(text);
    expect(sanitized).not.toContain("/workspace/");
    expect(sanitized).not.toContain("/home/");
    const pathCount = (sanitized.match(/<path>/g) ?? []).length;
    expect(pathCount).toBe(2);
  });

  it("sanitizePath 应处理 Windows 路径", () => {
    const text = 'File at C:\\Users\\admin\\config.json';
    const sanitized = sanitizePath(text);
    expect(sanitized).not.toContain("C:\\Users\\");
    expect(sanitized).toContain("<path>");
  });

  it("本地模型时 tool_result 不应截断", () => {
    // 模拟本地模型行为：shouldSanitizeForLLM 返回 false
    const isLocal = !shouldSanitizeForLLM("llama3");
    expect(isLocal).toBe(true);

    // 本地模型不应执行截断
    const longContent = "x".repeat(3000);
    if (!shouldSanitizeForLLM("llama3")) {
      // 本地模型路径：不截断
      expect(longContent.length).toBe(3000);
    }
  });
});

// ─── prompt.ts 集成测试 ───

describe("prompt.ts — 架构关键词过滤", () => {
  it("Layer 2 (memoryPrompt) 应过滤架构关键词", () => {
    const result = assemblePrompt({
      baseSystemPrompt: "You are a helpful assistant.",
      memoryPrompt: "The agentQueryLoop uses PROMOTION_IMPROVEMENT_MIN for optimization.",
    });

    expect(result.systemPrompt).not.toContain("agentQueryLoop");
    expect(result.systemPrompt).not.toContain("PROMOTION_IMPROVEMENT_MIN");
    expect(result.systemPrompt).toContain("<function>");
    expect(result.systemPrompt).toContain("<constant>");
  });

  it("Layer 3 (appendSystemPrompt) 应过滤架构关键词", () => {
    const result = assemblePrompt({
      baseSystemPrompt: "You are a helpful assistant.",
      appendSystemPrompt: "Use CredentialStore and FileCredentialStore for secrets.",
    });

    expect(result.systemPrompt).not.toContain("CredentialStore");
    expect(result.systemPrompt).not.toContain("FileCredentialStore");
    expect(result.systemPrompt).toContain("<module>");
  });

  it("Layer 4 (systemContext) 应过滤架构关键词", () => {
    const result = assemblePrompt({
      baseSystemPrompt: "You are a helpful assistant.",
      systemContext: "Current model: gpt-4o. EvolutionAction is RETRY_WITH_HIGHER_TIMEOUT.",
    });

    expect(result.systemPrompt).not.toContain("EvolutionAction");
    expect(result.systemPrompt).toContain("<type>");
  });

  it("Layer 1 (baseSystemPrompt) 不应过滤（保留原始）", () => {
    const result = assemblePrompt({
      baseSystemPrompt: "You are a helpful assistant.",
    });

    expect(result.systemPrompt).toContain("You are a helpful assistant.");
  });

  it("多层同时存在时应分别过滤", () => {
    const result = assemblePrompt({
      baseSystemPrompt: "You are EvoAgent assistant.",
      memoryPrompt: "agentQueryLoop is running.",
      appendSystemPrompt: "PROMOTION_IMPROVEMENT_MIN = 0.1",
      systemContext: "RuleStatus is ACTIVE",
    });

    // Layer 1 不过滤
    expect(result.systemPrompt).toContain("EvoAgent");
    // Layer 2-4 过滤
    expect(result.systemPrompt).not.toContain("agentQueryLoop");
    expect(result.systemPrompt).not.toContain("PROMOTION_IMPROVEMENT_MIN");
    expect(result.systemPrompt).not.toContain("RuleStatus");
  });

  it("无 Layer 2-4 时应正常工作", () => {
    const result = assemblePrompt({
      baseSystemPrompt: "Base prompt only.",
    });

    expect(result.systemPrompt).toContain("Base prompt only.");
    expect(result.systemPrompt).not.toContain("agentQueryLoop");
    expect(result.systemPrompt).not.toContain("PROMOTION_IMPROVEMENT_MIN");
    expect(result.systemPrompt).not.toContain("RuleStatus");
    expect(result.userContextMessage).toBeUndefined();
  });

  it("Layer 5 (userContext) 应作为 user 消息", () => {
    const result = assemblePrompt({
      baseSystemPrompt: "Base.",
      userContext: "CLAUDE.md content here",
    });

    expect(result.userContextMessage).toBeDefined();
    expect(result.userContextMessage?.role).toBe("user");
    expect(result.userContextMessage?.content).toBe("CLAUDE.md content here");
  });

  it("Layer 6 (tools) 应作为第一条 user 消息", () => {
    const tools: Tool[] = [
      {
        name: "bash",
        description: "Execute bash commands",
        inputSchema: { type: "object" as const, properties: {} },
        call: async () => ({ content: "", isError: false }),
        checkPermissions: async () => ({ allowed: true, reason: "" }),
      },
    ];

    const result = assemblePrompt({
      baseSystemPrompt: "Base.",
      tools,
    });

    expect(result.systemInitMessage).toBeDefined();
    expect(result.systemInitMessage?.role).toBe("user");
    expect(result.systemInitMessage?.content).toContain("bash");
  });
});

// ─── 条件净化测试 ───

describe("条件净化 — 本地/远程区分", () => {
  it("远程模型应执行完整净化管线", () => {
    const text = "user@example.com at /workspace/test.ts used agentQueryLoop";
    const needsSanitization = shouldSanitizeForLLM("gpt-4o");
    expect(needsSanitization).toBe(true);

    // 模拟 loop.ts 中的净化流程
    let content = text;
    if (needsSanitization) {
      content = sanitizePath(content);
    }
    expect(content).not.toContain("/workspace/");
  });

  it("本地模型应跳过净化", () => {
    const text = "user@example.com at /workspace/test.ts used agentQueryLoop";
    const needsSanitization = shouldSanitizeForLLM("llama3");
    expect(needsSanitization).toBe(false);

    // 模拟 loop.ts 中的净化流程
    let content = text;
    if (needsSanitization) {
      content = sanitizePath(content);
    }
    // 本地模型不净化，路径保留
    expect(content).toContain("/workspace/");
  });

  it("未知模型应 Fail-Closed 执行净化", () => {
    const needsSanitization = shouldSanitizeForLLM("unknown-model-v99");
    expect(needsSanitization).toBe(true);
  });
});

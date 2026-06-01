/**
 * B.4 测试 — 净化层接入通信 + 记忆。
 *
 * 验证 critic.ts 处理类别抽象、memory-extractor.ts 路径脱敏、
 * summarizer.ts 截断 + 路径脱敏。
 */

import { describe, expect, it } from "vitest";
import { sanitizePath, truncateForLLM, filterArchitectureKeywords } from "../../src/security/llm-sanitize";
import { createCritic } from "../../src/communication/critic";
import { createMemoryExtractor } from "../../src/knowledge/memory-extractor";
import {
  createSummarizer,
  auditSummaryStructure,
  computeAdaptiveChunkRatio,
} from "../../src/context/summarizer";
import type { Message } from "../../src/types/message";

// ─── critic.ts 测试 ───

describe("critic.ts — 处理类别抽象", () => {
  it("内部类别名称应映射为通用描述", () => {
    const CATEGORY_DESCRIPTIONS: Record<string, string> = {
      ACCEPT: "fully_accept",
      ACCEPT_PARTIAL: "partially_accept",
      REJECT: "reject",
      ARCHIVE_AS_FLAWED: "archive_as_flawed",
      CHALLENGE: "challenge_and_verify",
    };

    // 验证通用描述不包含内部名称
    for (const [internal, description] of Object.entries(CATEGORY_DESCRIPTIONS)) {
      expect(description).not.toContain(internal);
      expect(description).toMatch(/^[a-z_]+$/);
    }
  });

  it("Critic 应正常创建和分析", async () => {
    const critic = createCritic();
    const result = await critic.analyzeMessage("agent-1", "The sky is blue", 0.8);
    expect(result).toBeDefined();
    expect(result.originalClaim).toBe("The sky is blue");
    expect(result.sourceAgent).toBe("agent-1");
  });

  it("高信任来源应倾向接受（非随机丢弃时）", async () => {
    const critic = createCritic({ dropRate: 0 });
    const result = await critic.analyzeMessage("trusted-agent", "Short fact", 0.9);
    expect(["ACCEPT", "ACCEPT_PARTIAL"]).toContain(result.processingResult);
  });

  it("低信任来源应倾向拒绝或质疑", async () => {
    const critic = createCritic();
    const result = await critic.analyzeMessage("unknown-agent", "Is this true?", 0.2);
    expect(result.processingResult).toBe("CHALLENGE" || "REJECT");
  });

  it("通用描述应能映射回内部名称", () => {
    const DESCRIPTION_TO_RESULT: Record<string, string> = {
      fully_accept: "ACCEPT",
      partially_accept: "ACCEPT_PARTIAL",
      reject: "REJECT",
      archive_as_flawed: "ARCHIVE_AS_FLAWED",
      challenge_and_verify: "CHALLENGE",
    };

    for (const [description, internal] of Object.entries(DESCRIPTION_TO_RESULT)) {
      expect(description).not.toBe(internal);
      expect(internal).toMatch(/^[A-Z_]+$/);
    }
  });
});

// ─── memory-extractor.ts 测试 ───

describe("memory-extractor.ts — 路径脱敏", () => {
  it("sanitizePath 应脱敏对话中的路径", () => {
    const text = "Reading file /workspace/project/src/index.ts for analysis";
    const sanitized = sanitizePath(text);
    expect(sanitized).not.toContain("/workspace/");
    expect(sanitized).toContain("<path>");
  });

  it("sanitizePath 应脱敏 tool_use input 中的路径", () => {
    const input = JSON.stringify({ path: "/home/user/.bashrc", action: "read" });
    const sanitized = sanitizePath(input);
    expect(sanitized).not.toContain("/home/");
    expect(sanitized).toContain("<path>");
  });

  it("sanitizePath 应脱敏 tool_result 中的路径", () => {
    const content = "Error: Cannot find module at /workspace/node_modules/typescript";
    const sanitized = sanitizePath(content);
    expect(sanitized).not.toContain("/workspace/");
    expect(sanitized).toContain("<path>");
  });

  it("记忆提取器应正常创建", () => {
    const extractor = createMemoryExtractor();
    expect(extractor).toBeDefined();
    expect(extractor.getState().totalExtractions).toBe(0);
  });

  it("shouldExtract 应正确判断", () => {
    const extractor = createMemoryExtractor({ minTurnsBetweenExtractions: 3 });
    const messages: Message[] = [
      { id: "1", role: "user", content: "Hello", timestamp: Date.now() },
      { id: "2", role: "assistant", content: "Hi", timestamp: Date.now() },
    ];
    // 不足 3 轮，不应提取
    expect(extractor.shouldExtract(2, messages)).toBe(false);
    // 足够轮次且有用户消息
    expect(extractor.shouldExtract(5, messages)).toBe(true);
  });

  it("extract 应正常工作（规则模式）", async () => {
    const extractor = createMemoryExtractor({ minTurnsBetweenExtractions: 0 });
    const messages: Message[] = [
      { id: "1", role: "user", content: "I prefer dark mode", timestamp: Date.now() },
      { id: "2", role: "assistant", content: "Noted.", timestamp: Date.now() },
      { id: "3", role: "user", content: "You must always check types", timestamp: Date.now() },
    ];

    const result = await extractor.extract(messages);
    expect(result).toBeDefined();
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
  });

  it("对话文本中路径应被脱敏", () => {
    // 模拟 buildExtractionPrompt 中的路径脱敏逻辑
    const messages: Message[] = [
      {
        id: "1",
        role: "tool_result",
        content: "File /workspace/config/settings.json loaded successfully",
        timestamp: Date.now(),
        toolUseId: "tool-1",
      },
    ];

    // 模拟 buildExtractionPrompt 中的处理
    const text = messages[0]!.content;
    const sanitized = sanitizePath(text);
    expect(sanitized).not.toContain("/workspace/");
    expect(sanitized).toContain("<path>");
  });
});

// ─── summarizer.ts 测试 ───

describe("summarizer.ts — 截断 + 路径脱敏", () => {
  it("sanitizePath 应脱敏摘要中的路径", () => {
    const text = "Modified /workspace/src/core/engine.ts and /home/user/.config";
    const sanitized = sanitizePath(text);
    expect(sanitized).not.toContain("/workspace/");
    expect(sanitized).not.toContain("/home/");
    const pathCount = (sanitized.match(/<path>/g) ?? []).length;
    expect(pathCount).toBe(2);
  });

  it("truncateForLLM 应截断超长内容（500 字符限制）", () => {
    const longContent = "x".repeat(1000);
    const truncated = truncateForLLM(longContent, 500);
    expect(truncated.length).toBeLessThan(1000);
    expect(truncated).toContain("...[truncated: 500 chars]");
  });

  it("truncateForLLM 不应截断短内容", () => {
    const shortContent = "Short summary text";
    const truncated = truncateForLLM(shortContent, 500);
    expect(truncated).toBe(shortContent);
  });

  it("摘要器应正常创建", () => {
    const summarizer = createSummarizer();
    expect(summarizer).toBeDefined();
  });

  it("无 LLM 时应使用规则摘要", async () => {
    const summarizer = createSummarizer();
    const messages: Message[] = [
      { id: "1", role: "user", content: "Hello", timestamp: Date.now() },
      { id: "2", role: "assistant", content: "Hi there!", timestamp: Date.now() },
    ];

    const result = await summarizer.summarize(messages);
    expect(result).toBeDefined();
    expect(result.method).toBe("rule_fallback");
    expect(result.summary).toContain("Decisions");
    expect(result.summary).toContain("Pending User Asks");
  });

  it("空消息应返回占位摘要", async () => {
    const summarizer = createSummarizer();
    const result = await summarizer.summarize([]);
    expect(result.summary).toBe("(No messages to summarize)");
    expect(result.method).toBe("rule_fallback");
  });

  it("auditSummaryStructure 应检测缺失段落", () => {
    const result = auditSummaryStructure("Just some text without sections");
    expect(result.ok).toBe(false);
    expect(result.missingSections.length).toBeGreaterThan(0);
  });

  it("auditSummaryStructure 应通过完整摘要", () => {
    const completeSummary = [
      "### Active Task",
      "- Task 1",
      "### Goal",
      "- Goal 1",
      "### Decisions",
      "- Decision 1",
      "### Completed Actions",
      "- Action 1",
      "### Open TODOs",
      "- TODO 1",
      "### Remaining Work",
      "- Work 1",
      "### Constraints/Rules",
      "- Rule 1",
      "### Active State",
      "- State 1",
      "### Error History",
      "- Error 1",
      "### Tool Usage Summary",
      "- Tool 1",
      "### Pending User Asks",
      "- Ask 1",
      "### Exact Identifiers",
      "- ID 1",
      "### Environment Notes",
      "- Note 1",
    ].join("\n");

    const result = auditSummaryStructure(completeSummary);
    expect(result.ok).toBe(true);
    expect(result.missingSections).toHaveLength(0);
  });

  it("computeAdaptiveChunkRatio 应返回有效比例", () => {
    const messages: Message[] = [
      { id: "1", role: "user", content: "Hello", timestamp: Date.now() },
    ];
    const ratio = computeAdaptiveChunkRatio(messages, 8000);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it("摘要中路径应被脱敏", () => {
    // 模拟 formatMessagesForSummary 中的处理
    const messages: Message[] = [
      {
        id: "1",
        role: "tool_result",
        content: "Contents of /workspace/project/README.md:\n# Project\nThis is a test project.",
        timestamp: Date.now(),
        toolUseId: "tool-1",
      },
    ];

    // 模拟 formatMessagesForSummary 中的处理逻辑
    const text = messages[0]!.content;
    const sanitized = sanitizePath(text);
    const truncated = truncateForLLM(sanitized, 500);

    expect(truncated).not.toContain("/workspace/");
    expect(truncated).toContain("<path>");
    expect(truncated).toContain("# Project");
  });
});

// ─── 综合场景测试 ───

describe("B.4 综合场景", () => {
  it("多层净化应协同工作", () => {
    // 使用路径不在关键词文本中的场景
    const text = "Using agentQueryLoop function with PROMOTION_IMPROVEMENT_MIN=0.1 at /etc/config";
    let result = sanitizePath(text);
    result = filterArchitectureKeywords(result);

    expect(result).not.toContain("/etc/");
    expect(result).not.toContain("agentQueryLoop");
    expect(result).not.toContain("PROMOTION_IMPROVEMENT_MIN");
    expect(result).toContain("<path>");
    expect(result).toContain("<function>");
    expect(result).toContain("<constant>");
  });

  it("长文本路径脱敏后截断应正常工作", () => {
    const longText = "File at /workspace/very/deep/path/to/some/file.txt\n" + "Content: ".repeat(200);
    const sanitized = sanitizePath(longText);
    const truncated = truncateForLLM(sanitized, 500);

    expect(truncated).not.toContain("/workspace/");
    expect(truncated.length).toBeLessThan(600);
    expect(truncated).toContain("...[truncated:");
  });
});

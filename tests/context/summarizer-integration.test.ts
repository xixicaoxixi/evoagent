import { describe, it, expect } from "vitest";
import {
  auditSummaryStructure,
  buildCompactionStructureInstructions,
  createSummarizer,
  wrapSummaryWithGuardRails,
  isSummaryWrapped,
} from "../../src/context/summarizer";
import type { Message } from "../../src/types/message";

const ALL_13_SECTIONS = [
  "### Active Task",
  "### Goal",
  "### Decisions",
  "### Completed Actions",
  "### Open TODOs",
  "### Remaining Work",
  "### Constraints/Rules",
  "### Active State",
  "### Error History",
  "### Tool Usage Summary",
  "### Pending User Asks",
  "### Exact Identifiers",
  "### Environment Notes",
];

function createMockProvider(responseContent: string) {
  return {
    model: "mock-model",
    async invoke() {
      return { content: responseContent };
    },
    async *stream() {
      yield { type: "content" as const, content: responseContent };
      yield { type: "stop" as const, tokenUsage: { inputTokens: 10, outputTokens: 5 } };
    },
    simpleProvider: {
      model: "mock-model",
      async complete() {
        return { content: responseContent, inputTokens: 10, outputTokens: 5 };
      },
    },
  };
}

function buildFullLLMSummary(activeTask: string = "Implementing login feature"): string {
  return [
    "### Active Task",
    `- ${activeTask}`,
    "",
    "### Goal",
    "- Build a complete authentication system",
    "",
    "### Decisions",
    "- Using JWT for authentication",
    "",
    "### Completed Actions",
    "- Created User model",
    "- Set up database connection",
    "",
    "### Open TODOs",
    "- Implement password reset",
    "",
    "### Remaining Work",
    "- Frontend login form",
    "- Session management",
    "",
    "### Constraints/Rules",
    "- Must use bcrypt for password hashing",
    "",
    "### Active State",
    "- User model: src/models/user.ts",
    "- Migration: pending",
    "",
    "### Error History",
    "- Port conflict resolved by using 3001",
    "",
    "### Tool Usage Summary",
    "- bash: 5 calls, all successful",
    "- file_write: 3 calls, all successful",
    "",
    "### Pending User Asks",
    "- User wants OAuth support",
    "",
    "### Exact Identifiers",
    "- src/models/user.ts",
    "- JWT_SECRET",
    "",
    "### Environment Notes",
    "- Node.js v20, PostgreSQL 15",
  ].join("\n");
}

describe("集成 — LLM 摘要 13 字段完整性", () => {
  it("LLM 返回完整 13 字段时 qualityScore=1.0", async () => {
    const provider = createMockProvider(buildFullLLMSummary());
    const summarizer = createSummarizer({ provider });

    const messages: Message[] = [
      { id: "1", role: "user", content: "Implement login", timestamp: Date.now() },
      { id: "2", role: "assistant", content: "I'll implement the login feature", timestamp: Date.now() },
    ];

    const result = await summarizer.summarize(messages);
    expect(result.method).toBe("single");
    expect(result.qualityScore).toBe(1.0);

    const audit = auditSummaryStructure(result.summary);
    expect(audit.ok).toBe(true);
    expect(audit.coverage).toBe(1.0);
  });

  it("LLM 返回部分字段时 qualityScore < 1.0", async () => {
    const partialSummary = [
      "### Active Task",
      "- Working on feature",
      "",
      "### Decisions",
      "- Some decisions",
      "",
      "### Open TODOs",
      "- Some TODOs",
    ].join("\n");

    const provider = createMockProvider(partialSummary);
    const summarizer = createSummarizer({ provider });

    const messages: Message[] = [
      { id: "1", role: "user", content: "Test", timestamp: Date.now() },
    ];

    const result = await summarizer.summarize(messages);
    expect(result.qualityScore).toBeLessThan(1.0);
    expect(result.qualityScore).toBeGreaterThan(0);
  });
});

describe("集成 — Active Task 字段保留", () => {
  it("规则摘要包含 Active Task 字段", async () => {
    const summarizer = createSummarizer();
    const messages: Message[] = [
      { id: "1", role: "user", content: "Build the API", timestamp: Date.now() },
    ];

    const result = await summarizer.summarize(messages);
    expect(result.summary).toContain("### Active Task");
  });

  it("LLM 摘要包含 Active Task 字段", async () => {
    const provider = createMockProvider(buildFullLLMSummary("Building the REST API"));
    const summarizer = createSummarizer({ provider });

    const messages: Message[] = [
      { id: "1", role: "user", content: "Build the API", timestamp: Date.now() },
    ];

    const result = await summarizer.summarize(messages);
    expect(result.summary).toContain("### Active Task");
    expect(result.summary).toContain("Building the REST API");
  });
});

describe("集成 — previousSummary 增量更新", () => {
  it("previousSummary 传递给 LLM 时保持任务连续性", async () => {
    let capturedMessages: unknown[] = [];
    const provider = {
      model: "mock-model",
      async invoke(messages: unknown[]) {
        capturedMessages = messages;
        return { content: buildFullLLMSummary("Continuing login implementation") };
      },
      async *stream() {
        yield { type: "content" as const, content: buildFullLLMSummary() };
        yield { type: "stop" as const, tokenUsage: { inputTokens: 10, outputTokens: 5 } };
      },
      simpleProvider: {
        model: "mock-model",
        async complete() {
          return { content: "test", inputTokens: 10, outputTokens: 5 };
        },
      },
    };

    const summarizer = createSummarizer({ provider });

    const previousSummary = buildFullLLMSummary("Setting up project structure");
    const messages: Message[] = [
      { id: "1", role: "user", content: "Now implement the login", timestamp: Date.now() },
    ];

    const result = await summarizer.summarize(messages, undefined, previousSummary);

    const messagesStr = JSON.stringify(capturedMessages);
    expect(messagesStr).toContain("Previous summary");
    expect(messagesStr).toContain("Setting up project structure");
  });
});

describe("集成 — 压缩后任务连续性", () => {
  it("摘要包含 Active Task 确保压缩后任务连续", async () => {
    const provider = createMockProvider(buildFullLLMSummary("Implementing user authentication"));
    const summarizer = createSummarizer({ provider });

    const messages: Message[] = [
      { id: "1", role: "user", content: "Start the auth module", timestamp: Date.now() },
      { id: "2", role: "assistant", content: "I'll start implementing the auth module", timestamp: Date.now() },
      { id: "3", role: "user", content: "Add JWT support", timestamp: Date.now() },
      { id: "4", role: "assistant", content: "Adding JWT support to the auth module", timestamp: Date.now() },
    ];

    const result = await summarizer.summarize(messages);
    const audit = auditSummaryStructure(result.summary);

    expect(audit.ok).toBe(true);
    expect(result.summary).toContain("### Active Task");
    expect(result.summary).toContain("Implementing user authentication");
  });

  it("Goal 字段保留确保目标连续", async () => {
    const provider = createMockProvider(buildFullLLMSummary());
    const summarizer = createSummarizer({ provider });

    const messages: Message[] = [
      { id: "1", role: "user", content: "Build auth system", timestamp: Date.now() },
    ];

    const result = await summarizer.summarize(messages);
    expect(result.summary).toContain("### Goal");
  });
});

describe("集成 — Error History 字段", () => {
  it("规则摘要包含 Error History 字段", async () => {
    const summarizer = createSummarizer();
    const messages: Message[] = [
      { id: "1", role: "user", content: "Test", timestamp: Date.now() },
    ];

    const result = await summarizer.summarize(messages);
    expect(result.summary).toContain("### Error History");
  });

  it("规则摘要包含错误内容（当有 tool_result 错误时）", async () => {
    const summarizer = createSummarizer();
    const messages: Message[] = [
      { id: "1", role: "user", content: "Run the test", timestamp: Date.now() },
      {
        id: "2",
        role: "tool_result",
        toolUseId: "tu-1",
        content: "Error: test failed with exit code 1",
        isError: true,
        timestamp: Date.now(),
      },
    ];

    const result = await summarizer.summarize(messages);
    expect(result.summary).toContain("### Error History");
    expect(result.summary).toContain("test failed");
  });
});

describe("集成 — 13 字段指令传递给 LLM", () => {
  it("buildCompactionStructureInstructions 包含编号的 13 字段", () => {
    const instructions = buildCompactionStructureInstructions();

    expect(instructions).toContain("1. ### Active Task");
    expect(instructions).toContain("2. ### Goal");
    expect(instructions).toContain("3. ### Decisions");
    expect(instructions).toContain("4. ### Completed Actions");
    expect(instructions).toContain("5. ### Open TODOs");
    expect(instructions).toContain("6. ### Remaining Work");
    expect(instructions).toContain("7. ### Constraints/Rules");
    expect(instructions).toContain("8. ### Active State");
    expect(instructions).toContain("9. ### Error History");
    expect(instructions).toContain("10. ### Tool Usage Summary");
    expect(instructions).toContain("11. ### Pending User Asks");
    expect(instructions).toContain("12. ### Exact Identifiers");
    expect(instructions).toContain("13. ### Environment Notes");
  });

  it("Active Task 被标记为 THE MOST IMPORTANT FIELD", () => {
    const instructions = buildCompactionStructureInstructions();
    expect(instructions).toContain("THE MOST IMPORTANT FIELD");
  });
});

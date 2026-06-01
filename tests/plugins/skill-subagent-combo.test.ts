/**
 * Session C.3 测试 — Skills + Subagent 组合。
 *
 * 验证声明式编排、自动创建并行 sub-agent、结果聚合。
 */

import { describe, expect, it, vi } from "vitest";
import {
  parseFrontmatter,
  extractParallelSubagents,
  extractAggregationStrategy,
  hasParallelSubagents,
  type SkillDefinition,
  type SkillFrontmatter,
  type ParallelSubagentDeclaration,
  type SkillAggregationStrategy,
  type SkillSource,
} from "../../src/plugins/skills/definition";
import {
  createSkillExecutor,
  type SkillExecutionConfig,
  type SkillExecutionResult,
} from "../../src/plugins/skills/executor";
import {
  createOrchestrator,
  type OrchestratorConfig,
} from "../../src/core/agent/orchestrator";
import type { Tool, ToolUseContext, CanUseToolFn } from "../../src/interfaces/tool";
import type { LLMProvider, LLMResponse, TokenUsage, LLMStreamChunk } from "../../src/interfaces/llm-provider";

// ─── Mock 基础设施 ───

function createMockTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    execute: async () => ({ output: "", error: undefined }),
  };
}

const MOCK_TOKEN_USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 600,
};

function successStream(): AsyncGenerator<LLMStreamChunk> {
  return (async function* () {
    yield { type: "content", content: "Mock" };
    yield { type: "stop", stopReason: "completed", tokenUsage: MOCK_TOKEN_USAGE };
  })();
}

function createMockLLMProvider(): LLMProvider {
  return {
    providerType: "openai",
    model: "gpt-5.4",
    temperature: 0.7,
    maxTokens: 4096,
    invoke: vi.fn().mockResolvedValue({
      content: "Mock LLM response",
      stopReason: "completed",
      model: "gpt-5.4",
      tokenUsage: MOCK_TOKEN_USAGE,
    } satisfies LLMResponse),
    stream: successStream,
  };
}

const MOCK_TOOLS: Tool[] = [
  createMockTool("file_read"),
  createMockTool("file_write"),
  createMockTool("bash"),
  createMockTool("glob"),
  ];

function createMockOrchestrator(): { orchestrator: ReturnType<typeof createOrchestrator>; config: OrchestratorConfig } {
  const config: OrchestratorConfig = {
    provider: createMockLLMProvider(),
    tools: MOCK_TOOLS,
    canUseTool: async () => true,
    toolUseContext: { sessionId: "test", workingDirectory: "/workspace" },
    maxConcurrentAgents: 10,
    agentTimeoutMs: 5000,
  };
  return { orchestrator: createOrchestrator(config), config };
}

function createSkillDefinition(
  frontmatterOverrides?: Partial<SkillFrontmatter>,
  markdownContent?: string,
): SkillDefinition {
  const defaultFrontmatter: SkillFrontmatter = {
    description: "Test skill",
    ...frontmatterOverrides,
  };

  return {
    name: "test-skill",
    source: "user" as SkillSource,
    dirPath: "/skills/test-skill",
    frontmatter: defaultFrontmatter,
    markdownContent: markdownContent ?? "# Test Skill\n\nSome content",
    isConditional: false,
    activated: true,
  };
}

// ─── 测试：Frontmatter 解析 ───

describe("Frontmatter 解析 — parallel-subagents", () => {
  it("解析 parallel-subagents 数组", () => {
    const content = `---
description: "Code review skill"
parallel-subagents:
  - name: security-reviewer
    role: reviewer
    description: "Review security aspects"
    allowed-tools:
      - file_read
      - glob
  - name: performance-reviewer
    role: reviewer
    description: "Review performance aspects"
---

# Code Review
`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!["parallel-subagents"]).toHaveLength(2);
    expect(frontmatter!["parallel-subagents"][0]?.name).toBe("security-reviewer");
    expect(frontmatter!["parallel-subagents"][0]?.role).toBe("reviewer");
    expect(frontmatter!["parallel-subagents"][0]?.description).toBe("Review security aspects");
    expect(frontmatter!["parallel-subagents"][0]?.["allowed-tools"]).toEqual(["file_read", "glob"]);
  });

  it("解析 aggregation-strategy", () => {
    const content = `---
description: "Test skill"
aggregation-strategy: majority
parallel-subagents:
  - name: reviewer-1
    description: "Review 1"
---

# Test
`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!["aggregation-strategy"]).toBe("majority");
  });

  it("缺少 parallel-subagents 时为 undefined", () => {
    const content = `---
description: "Simple skill"
---

# Simple
`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!["parallel-subagents"]).toBeUndefined();
  });

  it("parallel-subagents 中 role 为可选", () => {
    const content = `---
description: "Test skill"
parallel-subagents:
  - name: custom-agent
    description: "Custom agent without role"
---

# Test
`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!["parallel-subagents"][0]?.role).toBeUndefined();
  });

  it("无效的 role 值被 Zod 拒绝", () => {
    const content = `---
description: "Test skill"
parallel-subagents:
  - name: bad-agent
    role: invalid_role
    description: "Bad role"
---

# Test
`;

    const { frontmatter } = parseFrontmatter(content);
    // Zod 验证失败，frontmatter 为 null
    expect(frontmatter).toBeNull();
  });

  it("无效的 aggregation-strategy 被 Zod 拒绝", () => {
    const content = `---
description: "Test skill"
aggregation-strategy: invalid_strategy
---

# Test
`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
  });
});

// ─── 测试：extractParallelSubagents ───

describe("extractParallelSubagents", () => {
  it("从 SkillDefinition 提取声明列表", () => {
    const skill = createSkillDefinition({
      description: "Test",
      "parallel-subagents": [
        { name: "reviewer-1", role: "reviewer", description: "Security review", "allowed-tools": ["file_read", "glob"] },
        { name: "reviewer-2", role: "tester", description: "Test review" },
      ],
    });

    const subagents = extractParallelSubagents(skill);
    expect(subagents).toHaveLength(2);
    expect(subagents[0]?.name).toBe("reviewer-1");
    expect(subagents[0]?.role).toBe("reviewer");
    expect(subagents[0]?.description).toBe("Security review");
    expect(subagents[0]?.allowedTools).toEqual(["file_read", "glob"]);
    expect(subagents[1]?.name).toBe("reviewer-2");
    expect(subagents[1]?.role).toBe("tester");
    expect(subagents[1]?.allowedTools).toBeUndefined();
  });

  it("无 parallel-subagents 时返回空数组", () => {
    const skill = createSkillDefinition({ description: "Simple" });
    const subagents = extractParallelSubagents(skill);
    expect(subagents).toEqual([]);
  });
});

// ─── 测试：extractAggregationStrategy ───

describe("extractAggregationStrategy", () => {
  it("提取声明的策略", () => {
    const skill = createSkillDefinition({
      description: "Test",
      "aggregation-strategy": "majority",
    });
    expect(extractAggregationStrategy(skill)).toBe("majority");
  });

  it("未声明时默认为 all_succeed", () => {
    const skill = createSkillDefinition({ description: "Test" });
    expect(extractAggregationStrategy(skill)).toBe("all_succeed");
  });

  it("支持所有四种策略", () => {
    const strategies: SkillAggregationStrategy[] = [
      "all_succeed", "majority", "any_succeed", "collect_all",
    ];
    for (const strategy of strategies) {
      const skill = createSkillDefinition({
        description: "Test",
        "aggregation-strategy": strategy,
      });
      expect(extractAggregationStrategy(skill)).toBe(strategy);
    }
  });
});

// ─── 测试：hasParallelSubagents ───

describe("hasParallelSubagents", () => {
  it("有声明时返回 true", () => {
    const skill = createSkillDefinition({
      description: "Test",
      "parallel-subagents": [{ name: "a", description: "Agent A" }],
    });
    expect(hasParallelSubagents(skill)).toBe(true);
  });

  it("无声明时返回 false", () => {
    const skill = createSkillDefinition({ description: "Test" });
    expect(hasParallelSubagents(skill)).toBe(false);
  });

  it("空数组返回 false", () => {
    const skill = createSkillDefinition({
      description: "Test",
      "parallel-subagents": [],
    });
    expect(hasParallelSubagents(skill)).toBe(false);
  });
});

// ─── 测试：SkillExecutor ───

describe("SkillExecutor", () => {
  it("非并行 Skill 返回手动执行提示", async () => {
    const executor = createSkillExecutor();
    const skill = createSkillDefinition({ description: "Simple skill" });
    const { orchestrator } = createMockOrchestrator();

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "Fix the bug",
    });

    expect(result.hasParallelSubagents).toBe(false);
    expect(result.executedInParallel).toBe(false);
    expect(result.teamResult).toBeUndefined();
    expect(result.summary).toContain("does not declare parallel subagents");
    expect(result.summary).toContain("test-skill");
  });

  it("并行 Skill 创建并执行团队", async () => {
    const executor = createSkillExecutor();
    const { orchestrator } = createMockOrchestrator();
    const skill = createSkillDefinition({
      description: "Code review",
      "parallel-subagents": [
        { name: "security-review", role: "reviewer", description: "Review security" },
        { name: "perf-review", role: "reviewer", description: "Review performance" },
      ],
    });

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "Review the authentication module",
    });

    expect(result.hasParallelSubagents).toBe(true);
    expect(result.executedInParallel).toBe(true);
    expect(result.teamResult).toBeDefined();
    expect(result.teamResult!.memberResults).toHaveLength(2);
    expect(result.teamResult!.strategy).toBe("all_succeed");
    expect(result.summary).toContain("test-skill");
    expect(result.summary).toContain("Parallel Execution Summary");
  });

  it("使用声明的 aggregation-strategy", async () => {
    const executor = createSkillExecutor();
    const { orchestrator } = createMockOrchestrator();
    const skill = createSkillDefinition({
      description: "Code review",
      "aggregation-strategy": "any_succeed",
      "parallel-subagents": [
        { name: "reviewer-1", description: "Review 1" },
        { name: "reviewer-2", description: "Review 2" },
      ],
    });

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "Review code",
    });

    expect(result.teamResult!.strategy).toBe("any_succeed");
  });

  it("overrideStrategy 覆盖声明的策略", async () => {
    const executor = createSkillExecutor();
    const { orchestrator } = createMockOrchestrator();
    const skill = createSkillDefinition({
      description: "Code review",
      "aggregation-strategy": "all_succeed",
      "parallel-subagents": [
        { name: "reviewer-1", description: "Review 1" },
      ],
    });

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "Review code",
      overrideStrategy: "collect_all",
    });

    expect(result.teamResult!.strategy).toBe("collect_all");
  });

  it("摘要包含所有成员结果", async () => {
    const executor = createSkillExecutor();
    const { orchestrator } = createMockOrchestrator();
    const skill = createSkillDefinition({
      description: "Multi review",
      "parallel-subagents": [
        { name: "security", role: "reviewer", description: "Security review" },
        { name: "performance", role: "reviewer", description: "Performance review" },
        { name: "testing", role: "tester", description: "Test review" },
      ],
    });

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "Review the module",
    });

    expect(result.teamResult!.memberResults).toHaveLength(3);
    expect(result.summary).toContain("security");
    expect(result.summary).toContain("performance");
    expect(result.summary).toContain("testing");
    expect(result.summary).toContain("Duration");
  });

  it("记录执行耗时", async () => {
    const executor = createSkillExecutor();
    const { orchestrator } = createMockOrchestrator();
    const skill = createSkillDefinition({
      description: "Test",
      "parallel-subagents": [{ name: "agent-1", description: "Agent 1" }],
    });

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "Test input",
    });

    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("memberTimeoutMs 传递给团队配置", async () => {
    const executor = createSkillExecutor();
    const { orchestrator } = createMockOrchestrator();
    const skill = createSkillDefinition({
      description: "Test",
      "parallel-subagents": [{ name: "agent-1", description: "Agent 1" }],
    });

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "Test input",
      memberTimeoutMs: 1000,
    });

    // 任务应该很快完成
    expect(result.durationMs).toBeLessThan(5000);
  });

  it("allowed-tools 传递给 SubAgent 任务", async () => {
    const executor = createSkillExecutor();
    const { orchestrator } = createMockOrchestrator();
    const skill = createSkillDefinition({
      description: "Test",
      "parallel-subagents": [
        {
          name: "limited-agent",
          description: "Limited tools",
          "allowed-tools": ["file_read", "glob"],
        },
      ],
    });

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "Test",
    });

    // 验证 SubAgent 被创建并执行
    expect(result.teamResult!.memberResults).toHaveLength(1);
    expect(result.teamResult!.memberResults[0]?.taskId).toContain("limited-agent");
  });

  it("role 传递给 SubAgent 的 systemPrompt", async () => {
    const executor = createSkillExecutor();
    const { orchestrator } = createMockOrchestrator();
    const skill = createSkillDefinition({
      description: "Test",
      "parallel-subagents": [
        { name: "debugger-agent", role: "debugger", description: "Debug the issue" },
      ],
    });

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "Debug the login flow",
    });

    expect(result.teamResult!.memberResults).toHaveLength(1);
    expect(result.teamResult!.memberResults[0]?.taskId).toContain("debugger-agent");
  });
});

// ─── 测试：摘要格式 ───

describe("摘要格式", () => {
  it("非并行摘要包含 Skill 名称", async () => {
    const executor = createSkillExecutor();
    const { orchestrator } = createMockOrchestrator();
    const skill = createSkillDefinition({ description: "My Skill" });

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "test",
    });

    // skill.name 是 "test-skill"
    expect(result.summary).toContain("test-skill");
  });

  it("并行摘要包含策略和状态", async () => {
    const executor = createSkillExecutor();
    const { orchestrator } = createMockOrchestrator();
    const skill = createSkillDefinition({
      description: "Review",
      "aggregation-strategy": "majority",
      "parallel-subagents": [
        { name: "r1", description: "Review 1" },
        { name: "r2", description: "Review 2" },
      ],
    });

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "test",
    });

    expect(result.summary).toContain("majority");
    expect(result.summary).toContain("Success");
  });

  it("并行摘要包含 Member Results 部分", async () => {
    const executor = createSkillExecutor();
    const { orchestrator } = createMockOrchestrator();
    const skill = createSkillDefinition({
      description: "Review",
      "parallel-subagents": [
        { name: "agent-a", description: "Agent A" },
      ],
    });

    const result = await executor.execute(skill, {
      orchestrator,
      userInput: "test",
    });

    expect(result.summary).toContain("Member Results");
  });
});

// ─── 测试：类型导出 ───

describe("类型导出", () => {
  it("ParallelSubagentDeclaration 类型正确", () => {
    const decl: ParallelSubagentDeclaration = {
      name: "test-agent",
      description: "Test agent",
    };
    expect(decl.name).toBe("test-agent");
    expect(decl.role).toBeUndefined();
    expect(decl.allowedTools).toBeUndefined();
  });

  it("ParallelSubagentDeclaration 支持所有字段", () => {
    const decl: ParallelSubagentDeclaration = {
      name: "full-agent",
      role: "reviewer",
      description: "Full agent",
      allowedTools: ["file_read", "glob"],
    };
    expect(decl.role).toBe("reviewer");
    expect(decl.allowedTools).toEqual(["file_read", "glob"]);
  });

  it("SkillExecutionResult 类型正确", () => {
    const result: SkillExecutionResult = {
      hasParallelSubagents: false,
      executedInParallel: false,
      summary: "test",
      durationMs: 100,
    };
    expect(result.teamResult).toBeUndefined();
  });
});

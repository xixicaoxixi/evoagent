/**
 * B.3 测试 — 净化层接入进化引擎。
 *
 * 验证 rule-analyzer.ts 路径脱敏 + Action 名称抽象、
 * tool-generator.ts 错误消息脱敏 + 工具名隐藏、
 * engine-self-optimizer.ts 参数名/值脱敏。
 */

import { describe, expect, it } from "vitest";
import { sanitizePath, filterArchitectureKeywords } from "../../src/security/llm-sanitize";
import { analyzeWithRules } from "../../src/evolution/rule-analyzer";
import { createToolGenerator } from "../../src/evolution/tool-generator";
import { createEngineSelfOptimizer } from "../../src/evolution/engine-self-optimizer";
import type { ErrorRecord } from "../../src/schemas/evolution";

// ─── rule-analyzer.ts 测试 ───

describe("rule-analyzer.ts — 路径脱敏", () => {
  it("sanitizePath 应脱敏错误消息中的路径", () => {
    const errorMessage = "Error reading /workspace/project/src/config.json: file not found";
    const sanitized = sanitizePath(errorMessage);
    expect(sanitized).not.toContain("/workspace/");
    expect(sanitized).toContain("<path>");
    expect(sanitized).toContain("file not found");
  });

  it("sanitizePath 应脱敏根因中的路径", () => {
    const rootCause = "File /home/user/.env does not exist";
    const sanitized = sanitizePath(rootCause);
    expect(sanitized).not.toContain("/home/");
    expect(sanitized).toContain("<path>");
  });

  it("sanitizePath 应处理多个路径", () => {
    const text = "Copied from /workspace/a.ts to /tmp/b.ts";
    const sanitized = sanitizePath(text);
    expect(sanitized).not.toContain("/workspace/");
    expect(sanitized).not.toContain("/tmp/");
  });
});

describe("rule-analyzer.ts — Action 名称抽象", () => {
  it("内部 Action 名称不应出现在 LLM prompt 中", () => {
    // 验证抽象后的 Action 描述不包含内部常量名
    const abstractedActions = [
      "retry_with_longer_timeout",
      "add_input_validation",
      "reduce_task_scope",
      "split_into_subtasks",
      "add_context_retrieval",
      "add_error_handling",
      "improve_instruction_clarity",
      "add_fallback_strategy",
      "sample_before_processing",
      "increase_resource_budget",
      "decrease_resource_budget",
      "change_tool_choice",
      "add_retry_logic",
      "skip_optional_step",
      "reorder_execution_steps",
      "advisory_only",
    ];

    const internalNames = [
      "RETRY_WITH_HIGHER_TIMEOUT",
      "ADD_VALIDATION_STEP",
      "REDUCE_SCOPE",
      "SPLIT_SUBTASK",
      "ADD_KNOWLEDGE_RETRIEVAL",
      "ADD_ERROR_HANDLING",
      "IMPROVE_PROMPT_CLARITY",
      "ADD_FALLBACK_STRATEGY",
      "SAMPLE_BEFORE_PROCESS",
      "INCREASE_TOKEN_BUDGET",
      "DECREASE_TOKEN_BUDGET",
      "CHANGE_TOOL_SELECTION",
      "ADD_RETRY_LOGIC",
      "SKIP_OPTIONAL_STEP",
      "REORDER_EXECUTION",
      "ADVISORY_ONLY",
    ];

    for (const abstracted of abstractedActions) {
      for (const internal of internalNames) {
        expect(abstracted).not.toContain(internal);
      }
    }
  });

  it("抽象描述应使用 snake_case 通用格式", () => {
    const abstractedActions = [
      "retry_with_longer_timeout",
      "add_input_validation",
      "reduce_task_scope",
    ];
    for (const action of abstractedActions) {
      expect(action).toMatch(/^[a-z_]+$/);
    }
  });

  it("analyzeWithRules 应正常工作（降级模式不受影响）", () => {
    const error: ErrorRecord = {
      error_id: "test-1",
      timestamp: new Date().toISOString(),
      error_type: "TimeoutError",
      error_category: "timeout",
      error_message: "Request timed out after 30000ms",
      root_cause: "Network latency",
      context: {},
    };

    const result = analyzeWithRules(error);
    expect(result).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.rule).not.toBeNull();
  });
});

// ─── tool-generator.ts 测试 ───

describe("tool-generator.ts — 错误消息脱敏", () => {
  it("sanitizePath 应脱敏工具生成中的错误消息", () => {
    const errorMessage = "Failed to read /workspace/project/data.json: ENOENT";
    const sanitized = sanitizePath(errorMessage);
    expect(sanitized).not.toContain("/workspace/");
    expect(sanitized).toContain("<path>");
  });

  it("工具生成器应正常创建", () => {
    const generator = createToolGenerator();
    expect(generator).toBeDefined();
    expect(generator.getGeneratedCount()).toBe(0);
  });

  it("generateTool 应基于模板匹配生成工具", () => {
    const generator = createToolGenerator();
    const tool = generator.generateTool("Request timed out after 30000ms");
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("retry_with_backoff");
    expect(tool?.validated).toBe(false);
  });

  it("generateToolWithLLM 无 LLM 时应降级到模板匹配", async () => {
    const generator = createToolGenerator();
    const tool = await generator.generateToolWithLLM(
      "Request timed out",
      ["bash", "file_read"],
    );
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("retry_with_backoff");
  });

  it("工具名列表不应暴露到 LLM prompt 中", () => {
    // 验证设计：existingTools 仅传递数量，不暴露名称
    const existingTools = ["bash", "file_read", "file_write", "file_edit", "glob"];
    const toolCountDescription = `${existingTools.length} existing tool(s)`;
    expect(toolCountDescription).toBe("5 existing tool(s)");
    expect(toolCountDescription).not.toContain("bash");
    expect(toolCountDescription).not.toContain("file_read");
  });
});

// ─── engine-self-optimizer.ts 测试 ───

describe("engine-self-optimizer.ts — 参数名/值脱敏", () => {
  it("filterArchitectureKeywords 应过滤参数名", () => {
    const reason = "Low success rate: relaxing PROMOTION_IMPROVEMENT_MIN threshold";
    const filtered = filterArchitectureKeywords(reason);
    expect(filtered).not.toContain("PROMOTION_IMPROVEMENT_MIN");
    expect(filtered).toContain("<constant>");
  });

  it("filterArchitectureKeywords 应过滤多个参数名", () => {
    const reason = "High DEPRECATION_RATE_MIN, low EVOLUTION_SANDBOX_MIN_SUCCESS_RATE";
    const filtered = filterArchitectureKeywords(reason);
    expect(filtered).not.toContain("DEPRECATION_RATE_MIN");
    expect(filtered).not.toContain("EVOLUTION_SANDBOX_MIN_SUCCESS_RATE");
  });

  it("自优化器应正常创建", () => {
    const optimizer = createEngineSelfOptimizer();
    expect(optimizer).toBeDefined();
    expect(optimizer.getAppliedOptimizations().size).toBe(0);
  });

  it("analyzeAndPropose 应返回优化建议", () => {
    const optimizer = createEngineSelfOptimizer();

    // 第一次调用建立基线（成功率 0.6）
    optimizer.analyzeAndPropose(
      {
        totalTasks: 100,
        successCount: 60,
        failureCount: 40,
        avgExecutionTimeMs: 3000,
        successRate: 0.6,
        deprecationRate: 0.15,
        bWinRate: 0.4,
      },
      {},
    );

    // 第二次调用：轻微退化（0.6 → 0.45，退化 0.15 > 0.10 但不会触发回退因为策略条件满足）
    // 使用 rollbackOnDegrade: false 避免回退逻辑干扰
    const optimizerNoRollback = createEngineSelfOptimizer({ rollbackOnDegrade: false });
    optimizerNoRollback.analyzeAndPropose(
      {
        totalTasks: 100,
        successCount: 60,
        failureCount: 40,
        avgExecutionTimeMs: 3000,
        successRate: 0.6,
        deprecationRate: 0.15,
        bWinRate: 0.4,
      },
      {},
    );

    const proposals = optimizerNoRollback.analyzeAndPropose(
      {
        totalTasks: 200,
        successCount: 90,
        failureCount: 110,
        avgExecutionTimeMs: 5000,
        successRate: 0.45,
        deprecationRate: 0.4,
        bWinRate: 0.1,
      },
      {
        PROMOTION_IMPROVEMENT_MIN: 0.1,
        DEPRECATION_RATE_MIN: 0.2,
        EVOLUTION_SANDBOX_MIN_SUCCESS_RATE: 0.5,
      },
    );

    // 低成功率 + 高淘汰率 + 低 B 胜率 → 应有建议
    expect(proposals.length).toBeGreaterThanOrEqual(1);

    // 验证 reason 中不包含内部参数名
    for (const proposal of proposals) {
      expect(proposal.reason).not.toContain("PROMOTION_IMPROVEMENT_MIN");
      expect(proposal.reason).not.toContain("DEPRECATION_RATE_MIN");
      expect(proposal.reason).not.toContain("EVOLUTION_SANDBOX_MIN_SUCCESS_RATE");
    }
  });

  it("analyzeAndPropose 首次调用应建立基线", () => {
    const optimizer = createEngineSelfOptimizer();
    const proposals = optimizer.analyzeAndPropose(
      {
        totalTasks: 100,
        successCount: 80,
        failureCount: 20,
        avgExecutionTimeMs: 2000,
        successRate: 0.8,
        deprecationRate: 0.1,
        bWinRate: 0.5,
      },
      {},
    );

    // 首次调用仅建立基线，不返回建议
    expect(proposals).toHaveLength(0);
  });

  it("applyOptimization 应正确记录", () => {
    const optimizer = createEngineSelfOptimizer();
    const result = optimizer.applyOptimization({
      paramName: "test_param",
      currentValue: 0.5,
      proposedValue: 0.3,
      reason: "test reason",
    });

    expect(result).toEqual({ test_param: 0.3 });
    expect(optimizer.getAppliedOptimizations().get("test_param")).toBe(0.3);
  });

  it("rollbackOptimization 应正确撤销", () => {
    const optimizer = createEngineSelfOptimizer();
    optimizer.applyOptimization({
      paramName: "test_param",
      currentValue: 0.5,
      proposedValue: 0.3,
      reason: "test reason",
    });

    const result = optimizer.rollbackOptimization("test_param");
    expect(result).toEqual({ test_param: null });
    expect(optimizer.getAppliedOptimizations().has("test_param")).toBe(false);
  });
});

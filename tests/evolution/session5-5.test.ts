/**
 * Session 5.5 测试 — 工具生成器 + 二阶交流器。
 */

import { describe, expect, it, beforeEach } from "vitest";
import { createToolGenerator } from "../../src/evolution/tool-generator";
import { createMetaCommunicator } from "../../src/evolution/meta-communicator";
import type { MetaProposal } from "../../src/evolution/meta-communicator";

// ─── 工具生成器测试 ───

describe("ToolGenerator", () => {
  let generator: ReturnType<typeof createToolGenerator>;

  beforeEach(() => {
    generator = createToolGenerator();
  });

  describe("shouldGenerate", () => {
    it("任务数不足不触发", () => {
      expect(generator.shouldGenerate(5, 0)).toBe(false);
    });

    it("间隔不足不触发", () => {
      expect(generator.shouldGenerate(20, 0)).toBe(false);
    });

    it("满足条件触发", () => {
      expect(generator.shouldGenerate(50, 0)).toBe(true);
    });

    it("工具数达上限不触发", () => {
      expect(generator.shouldGenerate(50, 20)).toBe(false);
    });

    it("禁用时不触发", () => {
      const disabled = createToolGenerator({ enabled: false });
      expect(disabled.shouldGenerate(100, 0)).toBe(false);
    });
  });

  describe("generateTool", () => {
    it("timeout 错误匹配重试模板", () => {
      const tool = generator.generateTool("Task execution timed out after 30 seconds");
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("retry_with_backoff");
      expect(tool!.description).toBeTruthy();
      expect(tool!.code).toBeTruthy();
      expect(tool!.testCode).toBeTruthy();
    });

    it("invalid output 错误匹配验证模板", () => {
      const tool = generator.generateTool("Invalid output format: expected JSON");
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("validate_structure");
    });

    it("无匹配返回 null", () => {
      const tool = generator.generateTool("Everything is fine");
      expect(tool).toBeNull();
    });

    it("生成计数增加", () => {
      generator.generateTool("timeout error");
      expect(generator.getGeneratedCount()).toBe(1);
    });
  });

  describe("validateTool", () => {
    it("有效工具通过验证", async () => {
      const tool = generator.generateTool("timeout error");
      expect(tool).not.toBeNull();
      const result = await generator.validateTool(tool!);
      expect(result).toBe(true);
    });

    it("无效工具验证失败", async () => {
      const tool = generator.generateTool("timeout error");
      expect(tool).not.toBeNull();
      // 手动破坏代码
      const brokenTool = { ...tool!, code: "throw new Error('broken');" };
      const result = await generator.validateTool(brokenTool);
      expect(result).toBe(false);
    });
  });

  describe("generateToolWithLLM", () => {
    it("无 LLM 客户端降级到模板", async () => {
      const tool = await generator.generateToolWithLLM("timeout error", []);
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("retry_with_backoff");
    });

    it("LLM 调用失败降级到模板", async () => {
      const mockClient = {
        invoke: async () => { throw new Error("LLM unavailable"); },
      };
      const tool = await generator.generateToolWithLLM("timeout error", [], mockClient);
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("retry_with_backoff");
    });

    it("LLM 返回有效结果", async () => {
      const mockClient = {
        invoke: async () =>
          JSON.stringify({
            name: "custom_tool",
            description: "A custom tool",
            code: "function customTool() { return 42; }",
            test_code: "function test_tool() { if (customTool() !== 42) throw new Error(); }",
          }),
      };
      const tool = await generator.generateToolWithLLM("unknown error", [], mockClient);
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("custom_tool");
    });
  });
});

// ─── 二阶交流器测试 ───

describe("MetaCommunicator", () => {
  let communicator: ReturnType<typeof createMetaCommunicator>;

  beforeEach(() => {
    communicator = createMetaCommunicator();
  });

  function createProposal(overrides: Partial<MetaProposal> = {}): MetaProposal {
    return {
      proposalId: `prop_${Math.random().toString(36).slice(2, 6)}`,
      sourcePeerId: "peer_1",
      paramName: "PROMOTION_IMPROVEMENT_MIN",
      proposedValue: 0.2,
      reason: "Test proposal",
      sourceTrust: 0.9,
      sourceAgeDays: 60,
      ...overrides,
    };
  }

  describe("filterProposals", () => {
    it("有效提案通过过滤", () => {
      const proposals = [createProposal()];
      const result = communicator.filterProposals(proposals);
      expect(result.accepted).toHaveLength(1);
      expect(result.rejected).toHaveLength(0);
    });

    it("低信任提案被拒绝", () => {
      const proposals = [createProposal({ sourceTrust: 0.5 })];
      const result = communicator.filterProposals(proposals);
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.reason).toContain("trust");
    });

    it("年龄不足提案被拒绝", () => {
      const proposals = [createProposal({ sourceAgeDays: 10 })];
      const result = communicator.filterProposals(proposals);
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0]?.reason).toContain("age");
    });

    it("宪法层参数提案被拒绝", () => {
      const proposals = [createProposal({ paramName: "AB_TEST_JUDGE_WEIGHTS" })];
      const result = communicator.filterProposals(proposals);
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected[0]?.reason).toContain("constitutional");
    });

    it("超出范围提案被钳制但仍接受", () => {
      const proposals = [createProposal({ proposedValue: 0.01 })];
      const result = communicator.filterProposals(proposals);
      expect(result.accepted).toHaveLength(1);
    });

    it("数量限制（每次最多 3 个）", () => {
      const proposals = [
        createProposal({ paramName: "PROMOTION_IMPROVEMENT_MIN" }),
        createProposal({ paramName: "EVOLUTION_SANDBOX_MIN_SUCCESS_RATE" }),
        createProposal({ paramName: "EVOLUTION_SANDBOX_MIN_TRIALS" }),
        createProposal({ paramName: "DEPRECATION_RATE_MIN" }),
      ];
      const result = communicator.filterProposals(proposals);
      expect(result.accepted).toHaveLength(3);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.reason).toContain("Max proposals");
    });

    it("重复参数去重", () => {
      const proposals = [
        createProposal({ proposalId: "p1", paramName: "PROMOTION_IMPROVEMENT_MIN" }),
        createProposal({ proposalId: "p2", paramName: "PROMOTION_IMPROVEMENT_MIN" }),
      ];
      const result = communicator.filterProposals(proposals);
      expect(result.accepted).toHaveLength(1);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.reason).toContain("Duplicate");
    });
  });

  describe("acceptProposal", () => {
    it("接受有效提案", () => {
      const proposal = createProposal();
      const changes = communicator.acceptProposal(proposal);
      expect(changes).toEqual({ PROMOTION_IMPROVEMENT_MIN: 0.2 });
      expect(communicator.getAcceptedProposals()).toHaveLength(1);
    });

    it("接受无效提案抛出错误", () => {
      const proposal = createProposal({ paramName: "AB_TEST_JUDGE_WEIGHTS" });
      expect(() => communicator.acceptProposal(proposal)).toThrow();
    });
  });
});

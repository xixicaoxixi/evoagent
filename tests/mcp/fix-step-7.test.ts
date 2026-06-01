import { describe, expect, it, beforeEach } from "vitest";
import {
  createMemoryRuleStore,
  type RuleStore,
} from "../../src/evolution/rule-store";
import {
  autoApprovePendingRules,
  runLifecycleManagement,
} from "../../src/evolution/lifecycle";
import { RuleStatus } from "../../src/types/evolution";
import { AUTO_APPROVE_MAX_PER_CYCLE } from "../../src/evolution/constants";
import type { EvolutionRuleInput } from "../../src/schemas/evolution";

function createPendingRule(overrides: Record<string, unknown> = {}): EvolutionRuleInput {
  return {
    rule_id: `rule_${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    source_error_id: "error_1",
    trigger_pattern: "timeout error",
    action: "RETRY_WITH_HIGHER_TIMEOUT",
    status: "PENDING_APPROVAL",
    ...overrides,
  };
}

function createActiveRule(overrides: Record<string, unknown> = {}): EvolutionRuleInput {
  return {
    rule_id: `active_${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    source_error_id: "error_0",
    trigger_pattern: "active pattern",
    action: "ADD_VALIDATION_STEP",
    status: "ACTIVE",
    activation_count: 10,
    success_count: 8,
    success_rate: 0.8,
    ...overrides,
  };
}

describe("Fix Step 7: Evolution 规则自动审批管线", () => {
  let store: RuleStore;

  beforeEach(() => {
    store = createMemoryRuleStore();
  });

  describe("autoApprovePendingRules 基础功能", () => {
    it("结构完整的 PENDING 规则被审批为 SANDBOX", async () => {
      await store.add(createPendingRule({
        rule_id: "pending_1",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.ruleId).toBe("pending_1");
      expect(transitions[0]!.from).toBe(RuleStatus.PENDING_APPROVAL);
      expect(transitions[0]!.to).toBe(RuleStatus.SANDBOX);

      const rule = await store.getById("pending_1");
      expect(rule?.status).toBe(RuleStatus.SANDBOX);
    });

    it("无 PENDING 规则时返回空数组", async () => {
      const transitions = await autoApprovePendingRules(store);
      expect(transitions).toHaveLength(0);
    });

    it("多个 PENDING 规则全部被审批", async () => {
      await store.add(createPendingRule({ rule_id: "p1", trigger_pattern: "pattern_a" }));
      await store.add(createPendingRule({ rule_id: "p2", trigger_pattern: "pattern_b", action: "ADD_VALIDATION_STEP" }));
      await store.add(createPendingRule({ rule_id: "p3", trigger_pattern: "pattern_c", action: "REDUCE_SCOPE" }));

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(3);
      const ruleIds = transitions.map((t) => t.ruleId);
      expect(ruleIds).toContain("p1");
      expect(ruleIds).toContain("p2");
      expect(ruleIds).toContain("p3");
    });
  });

  describe("结构完整性验证", () => {
    it("trigger_pattern 为纯空白时不审批（Zod 允许但逻辑不允许）", async () => {
      await store.add(createPendingRule({
        rule_id: "whitespace_trigger",
        trigger_pattern: "   ",
      }));

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(0);
      const rule = await store.getById("whitespace_trigger");
      expect(rule?.status).toBe(RuleStatus.PENDING_APPROVAL);
    });

    it("Zod Schema 保证空 trigger_pattern 和无效 action 无法入库", async () => {
      await expect(store.add(createPendingRule({
        rule_id: "empty_trigger",
        trigger_pattern: "",
      }))).rejects.toThrow();

      await expect(store.add(createPendingRule({
        rule_id: "invalid_action",
        action: "INVALID_ACTION" as import("../../src/types/evolution").EvolutionAction,
      }))).rejects.toThrow();
    });
  });

  describe("冲突检测", () => {
    it("与 ACTIVE 规则 trigger_pattern + action 重复时不审批", async () => {
      await store.add(createActiveRule({
        rule_id: "active_1",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));
      await store.add(createPendingRule({
        rule_id: "pending_dup",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(0);
      const rule = await store.getById("pending_dup");
      expect(rule?.status).toBe(RuleStatus.PENDING_APPROVAL);
    });

    it("PENDING 规则的 anti_action 与 ACTIVE 规则 action 冲突时不审批", async () => {
      await store.add(createActiveRule({
        rule_id: "active_1",
        trigger_pattern: "some pattern",
        action: "ADD_VALIDATION_STEP",
      }));
      await store.add(createPendingRule({
        rule_id: "pending_anti",
        trigger_pattern: "different pattern",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
        anti_action: "ADD_VALIDATION_STEP",
      }));

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(0);
    });

    it("ACTIVE 规则的 anti_action 与 PENDING 规则 action 冲突时不审批", async () => {
      await store.add(createActiveRule({
        rule_id: "active_anti",
        trigger_pattern: "some pattern",
        action: "ADD_ERROR_HANDLING",
        anti_action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));
      await store.add(createPendingRule({
        rule_id: "pending_1",
        trigger_pattern: "different pattern",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(0);
    });

    it("与 SANDBOX 规则不冲突（只检查 ACTIVE）", async () => {
      await store.add({
        rule_id: "sandbox_1",
        created_at: new Date().toISOString(),
        source_error_id: "error_0",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
        status: "SANDBOX",
      });
      await store.add(createPendingRule({
        rule_id: "pending_1",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.ruleId).toBe("pending_1");
    });

    it("anti_action 为空时不触发 anti_action 冲突检查", async () => {
      await store.add(createActiveRule({
        rule_id: "active_1",
        trigger_pattern: "some pattern",
        action: "ADD_VALIDATION_STEP",
      }));
      await store.add(createPendingRule({
        rule_id: "pending_1",
        trigger_pattern: "different pattern",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
        anti_action: "",
      }));

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(1);
    });
  });

  describe("限流：每轮最多审批 AUTO_APPROVE_MAX_PER_CYCLE 条", () => {
    it("超过限制时只审批前 N 条", async () => {
      for (let i = 0; i < AUTO_APPROVE_MAX_PER_CYCLE + 3; i++) {
        await store.add(createPendingRule({
          rule_id: `p_${i}`,
          trigger_pattern: `pattern_${i}`,
          action: i % 2 === 0 ? "RETRY_WITH_HIGHER_TIMEOUT" : "ADD_VALIDATION_STEP",
        }));
      }

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(AUTO_APPROVE_MAX_PER_CYCLE);
      for (const t of transitions) {
        expect(t.to).toBe(RuleStatus.SANDBOX);
      }
    });

    it("第二次运行可审批剩余的 PENDING 规则", async () => {
      for (let i = 0; i < AUTO_APPROVE_MAX_PER_CYCLE + 2; i++) {
        await store.add(createPendingRule({
          rule_id: `p_${i}`,
          trigger_pattern: `pattern_${i}`,
          action: i % 2 === 0 ? "RETRY_WITH_HIGHER_TIMEOUT" : "ADD_VALIDATION_STEP",
        }));
      }

      const first = await autoApprovePendingRules(store);
      expect(first).toHaveLength(AUTO_APPROVE_MAX_PER_CYCLE);

      const second = await autoApprovePendingRules(store);
      expect(second).toHaveLength(2);
    });
  });

  describe("混合场景", () => {
    it("部分通过、部分冲突时只审批通过的", async () => {
      await store.add(createActiveRule({
        rule_id: "active_1",
        trigger_pattern: "conflict pattern",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));
      await store.add(createPendingRule({
        rule_id: "pending_conflict",
        trigger_pattern: "conflict pattern",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));
      await store.add(createPendingRule({
        rule_id: "pending_ok",
        trigger_pattern: "safe pattern",
        action: "ADD_VALIDATION_STEP",
      }));

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.ruleId).toBe("pending_ok");

      const conflictRule = await store.getById("pending_conflict");
      expect(conflictRule?.status).toBe(RuleStatus.PENDING_APPROVAL);

      const okRule = await store.getById("pending_ok");
      expect(okRule?.status).toBe(RuleStatus.SANDBOX);
    });
  });

  describe("runLifecycleManagement 集成", () => {
    it("runLifecycleManagement 包含自动审批转换", async () => {
      await store.add(createPendingRule({
        rule_id: "pending_1",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));

      const emaCalculators = new Map();
      const result = await runLifecycleManagement(store, emaCalculators, 0.5);

      const approveTransition = result.transitions.find(
        (t) => t.from === RuleStatus.PENDING_APPROVAL && t.to === RuleStatus.SANDBOX,
      );
      expect(approveTransition).toBeDefined();
      expect(approveTransition!.ruleId).toBe("pending_1");
    });

    it("自动审批在沙盒评估之前执行", async () => {
      await store.add(createPendingRule({
        rule_id: "pending_1",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));

      const emaCalculators = new Map();
      await runLifecycleManagement(store, emaCalculators, 0.5);

      const rule = await store.getById("pending_1");
      expect(rule?.status).toBe(RuleStatus.SANDBOX);
    });

    it("PENDING 规则审批后可在后续沙盒评估中被处理", async () => {
      await store.add(createPendingRule({
        rule_id: "pending_1",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));

      const emaCalculators = new Map();
      await runLifecycleManagement(store, emaCalculators, 0.5);

      const afterFirst = await store.getById("pending_1");
      expect(afterFirst?.status).toBe(RuleStatus.SANDBOX);

      await store.update("pending_1", {
        sandbox_trials: 5,
        sandbox_successes: 4,
        sandbox_success_rate: 0.8,
      });

      await runLifecycleManagement(store, emaCalculators, 0.5);

      const afterSecond = await store.getById("pending_1");
      expect(afterSecond?.status).toBe(RuleStatus.PROBATION);
    });
  });

  describe("LifecycleTransition 结构验证", () => {
    it("转换记录包含正确的字段", async () => {
      await store.add(createPendingRule({
        rule_id: "pending_1",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
      }));

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(1);
      const t = transitions[0]!;
      expect(t.ruleId).toBe("pending_1");
      expect(t.from).toBe(RuleStatus.PENDING_APPROVAL);
      expect(t.to).toBe(RuleStatus.SANDBOX);
      expect(t.reason).toContain("Auto-approved");
      expect(t.reason).toContain("structurally valid");
      expect(t.reason).toContain("no conflicts");
    });
  });

  describe("边界场景", () => {
    it("非 PENDING_APPROVAL 状态的规则不被审批", async () => {
      await store.add({
        rule_id: "sandbox_1",
        created_at: new Date().toISOString(),
        source_error_id: "error_0",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
        status: "SANDBOX",
      });

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(0);
    });

    it("DEPRECATED 规则不参与审批", async () => {
      await store.add({
        rule_id: "deprecated_1",
        created_at: new Date().toISOString(),
        source_error_id: "error_0",
        trigger_pattern: "timeout error",
        action: "RETRY_WITH_HIGHER_TIMEOUT",
        status: "DEPRECATED",
      });

      const transitions = await autoApprovePendingRules(store);

      expect(transitions).toHaveLength(0);
    });

    it("所有 16 种合法 action 均可通过审批（分批）", async () => {
      const validActions = [
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

      for (let i = 0; i < validActions.length; i++) {
        await store.add(createPendingRule({
          rule_id: `p_${i}`,
          trigger_pattern: `pattern_${i}`,
          action: validActions[i],
        }));
      }

      let totalApproved = 0;
      let remaining = validActions.length;
      while (remaining > 0) {
        const transitions = await autoApprovePendingRules(store);
        totalApproved += transitions.length;
        remaining -= transitions.length;
        if (transitions.length === 0) break;
      }

      expect(totalApproved).toBe(validActions.length);
    });
  });
});

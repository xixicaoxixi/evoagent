/**
 * Token 预算管理测试 — 阶段 E.1。
 */

import { describe, it, expect } from "vitest";
import { createBudgetManager } from "../../src/llm/budget";

describe("E.1 Token 预算管理", () => {
  describe("createBudgetManager", () => {
    it("默认配置应创建预算管理器", () => {
      const budget = createBudgetManager();
      const check = budget.checkBudget("test");

      expect(check.allowed).toBe(true);
      expect(check.remainingTokens).toBe(1_000_000);
    });

    it("自定义总预算应生效", () => {
      const budget = createBudgetManager({ totalTokenBudget: 1000 });
      const check = budget.checkBudget("test");

      expect(check.allowed).toBe(true);
      expect(check.remainingTokens).toBe(1000);
    });

    it("totalTokenBudget=0 应表示无限制", () => {
      const budget = createBudgetManager({ totalTokenBudget: 0 });
      budget.recordUsage("test", 999_999, 999_999);

      const check = budget.checkBudget("test");
      expect(check.allowed).toBe(true);
    });
  });

  describe("checkBudget", () => {
    it("预算充足时应允许调用", () => {
      const budget = createBudgetManager({ totalTokenBudget: 1000 });
      const check = budget.checkBudget("critic");

      expect(check.allowed).toBe(true);
      expect(check.remainingTokens).toBe(1000);
    });

    it("预算耗尽时应拒绝调用（reject 模式）", () => {
      const budget = createBudgetManager({ totalTokenBudget: 100 });
      budget.recordUsage("test", 60, 50);

      const check = budget.checkBudget("critic");
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("exhausted");
    });

    it("预算耗尽时应允许但记录（warn 模式）", () => {
      const budget = createBudgetManager({
        totalTokenBudget: 100,
        onBudgetExhausted: "warn",
      });
      budget.recordUsage("test", 60, 50);

      const check = budget.checkBudget("critic");
      expect(check.allowed).toBe(true);
    });

    it("单次调用超过 maxTokensPerCall 时应拒绝", () => {
      const budget = createBudgetManager({ maxTokensPerCall: 100 });
      const check = budget.checkBudget("test", 200);

      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("per-call limit");
    });

    it("模块配额耗尽时应拒绝", () => {
      const budget = createBudgetManager({ maxTokensPerModule: 100 });
      budget.recordUsage("critic", 60, 50);

      const check = budget.checkBudget("critic");
      expect(check.allowed).toBe(false);
      expect(check.moduleExhausted).toBe(true);
    });

    it("不同模块的配额应独立计算", () => {
      const budget = createBudgetManager({ maxTokensPerModule: 100 });
      budget.recordUsage("critic", 60, 50);

      const check = budget.checkBudget("evolution");
      expect(check.allowed).toBe(true);
    });
  });

  describe("recordUsage", () => {
    it("应正确累计 token 使用量", () => {
      const budget = createBudgetManager({ totalTokenBudget: 1000 });
      budget.recordUsage("critic", 100, 50);
      budget.recordUsage("evolution", 200, 100);

      const stats = budget.getStats();
      expect(stats.totalInputTokens).toBe(300);
      expect(stats.totalOutputTokens).toBe(150);
      expect(stats.totalTokensUsed).toBe(450);
      expect(stats.totalCallCount).toBe(2);
    });

    it("应正确记录模块级别统计", () => {
      const budget = createBudgetManager();
      budget.recordUsage("critic", 100, 50);
      budget.recordUsage("critic", 200, 100);
      budget.recordUsage("evolution", 300, 150);

      const stats = budget.getStats();
      const criticStats = stats.moduleStats.get("critic");
      expect(criticStats).toBeDefined();
      expect(criticStats!.callCount).toBe(2);
      expect(criticStats!.inputTokens).toBe(300);
      expect(criticStats!.outputTokens).toBe(150);
      expect(criticStats!.totalTokens).toBe(450);

      const evoStats = stats.moduleStats.get("evolution");
      expect(evoStats!.callCount).toBe(1);
    });
  });

  describe("getStats", () => {
    it("应返回完整的预算统计", () => {
      const budget = createBudgetManager({ totalTokenBudget: 5000 });
      budget.recordUsage("test", 100, 50);

      const stats = budget.getStats();
      expect(stats.totalTokenBudget).toBe(5000);
      expect(stats.totalTokensUsed).toBe(150);
      expect(stats.rejectedCalls).toBe(0);
    });

    it("应统计拒绝次数", () => {
      const budget = createBudgetManager({ totalTokenBudget: 100 });
      budget.recordUsage("test", 60, 50);
      budget.checkBudget("test"); // rejected
      budget.checkBudget("test"); // rejected

      const stats = budget.getStats();
      expect(stats.rejectedCalls).toBe(2);
    });
  });

  describe("reset", () => {
    it("应清零所有统计", () => {
      const budget = createBudgetManager({ totalTokenBudget: 1000 });
      budget.recordUsage("test", 100, 50);
      budget.checkBudget("test"); // not rejected

      budget.reset();

      const stats = budget.getStats();
      expect(stats.totalTokensUsed).toBe(0);
      expect(stats.totalCallCount).toBe(0);
      expect(stats.rejectedCalls).toBe(0);
      expect(stats.moduleStats.size).toBe(0);

      const check = budget.checkBudget("test");
      expect(check.allowed).toBe(true);
      expect(check.remainingTokens).toBe(1000);
    });
  });

  describe("isExhausted", () => {
    it("预算充足时应返回 false", () => {
      const budget = createBudgetManager({ totalTokenBudget: 1000 });
      expect(budget.isExhausted()).toBe(false);
    });

    it("预算耗尽时应返回 true", () => {
      const budget = createBudgetManager({ totalTokenBudget: 100 });
      budget.recordUsage("test", 60, 50);
      expect(budget.isExhausted()).toBe(true);
    });

    it("无限制预算时应始终返回 false", () => {
      const budget = createBudgetManager({ totalTokenBudget: 0 });
      budget.recordUsage("test", 999_999, 999_999);
      expect(budget.isExhausted()).toBe(false);
    });
  });
});

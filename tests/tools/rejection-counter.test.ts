/**
 * Session C.2 测试 — 拒绝追踪断路器。
 *
 * 覆盖：
 * - countRejection / countApproval CoW 不可变更新
 * - requiresUserFallback 双阈值判断
 * - 连续拒绝 5 次触发降级
 * - 总拒绝 30 次触发降级
 * - 1 次成功重置连续计数
 * - 自定义阈值
 * - 不可变性
 */

import { describe, expect, it } from "vitest";
import {
  countRejection,
  countApproval,
  requiresUserFallback,
  getRejectionSummary,
  INITIAL_REJECTION_COUNTER,
  REJECTION_THRESHOLDS,
  type RejectionCounter,
} from "../../src/tools/rejection-counter";

// ─── countRejection ───

describe("countRejection", () => {
  it("应递增连续拒绝和总拒绝计数", () => {
    const next = countRejection(INITIAL_REJECTION_COUNTER);
    expect(next.consecutiveRejections).toBe(1);
    expect(next.totalRejections).toBe(1);
  });

  it("多次调用应累加", () => {
    let state = INITIAL_REJECTION_COUNTER;
    state = countRejection(state);
    state = countRejection(state);
    state = countRejection(state);
    expect(state.consecutiveRejections).toBe(3);
    expect(state.totalRejections).toBe(3);
  });

  it("不应修改原始状态（CoW）", () => {
    const next = countRejection(INITIAL_REJECTION_COUNTER);
    expect(INITIAL_REJECTION_COUNTER.consecutiveRejections).toBe(0);
    expect(INITIAL_REJECTION_COUNTER.totalRejections).toBe(0);
    expect(next.consecutiveRejections).toBe(1);
  });
});

// ─── countApproval ───

describe("countApproval", () => {
  it("应重置连续拒绝计数", () => {
    let state = INITIAL_REJECTION_COUNTER;
    state = countRejection(state);
    state = countRejection(state);
    state = countRejection(state);
    expect(state.consecutiveRejections).toBe(3);

    const approved = countApproval(state);
    expect(approved.consecutiveRejections).toBe(0);
    expect(approved.totalRejections).toBe(3); // 总拒绝不变
  });

  it("不应修改原始状态", () => {
    let state = INITIAL_REJECTION_COUNTER;
    state = countRejection(state);
    const approved = countApproval(state);
    expect(state.consecutiveRejections).toBe(1); // 原始不变
    expect(approved.consecutiveRejections).toBe(0);
  });
});

// ─── requiresUserFallback ───

describe("requiresUserFallback", () => {
  it("初始状态不应触发降级", () => {
    expect(requiresUserFallback(INITIAL_REJECTION_COUNTER)).toBe(false);
  });

  it("连续拒绝 4 次不应触发降级", () => {
    let state = INITIAL_REJECTION_COUNTER;
    for (let i = 0; i < 4; i++) {
      state = countRejection(state);
    }
    expect(state.consecutiveRejections).toBe(4);
    expect(requiresUserFallback(state)).toBe(false);
  });

  it("连续拒绝 5 次应触发降级", () => {
    let state = INITIAL_REJECTION_COUNTER;
    for (let i = 0; i < 5; i++) {
      state = countRejection(state);
    }
    expect(state.consecutiveRejections).toBe(5);
    expect(requiresUserFallback(state)).toBe(true);
  });

  it("总拒绝 29 次不应触发降级", () => {
    let state: RejectionCounter = { consecutiveRejections: 0, totalRejections: 29 };
    expect(requiresUserFallback(state)).toBe(false);
  });

  it("总拒绝 30 次应触发降级", () => {
    let state: RejectionCounter = { consecutiveRejections: 0, totalRejections: 30 };
    expect(requiresUserFallback(state)).toBe(true);
  });

  it("1 次成功应重置连续计数（不再触发连续降级）", () => {
    let state = INITIAL_REJECTION_COUNTER;
    // 5 次连续拒绝 → 触发降级
    for (let i = 0; i < 5; i++) {
      state = countRejection(state);
    }
    expect(requiresUserFallback(state)).toBe(true);

    // 1 次成功 → 重置连续
    state = countApproval(state);
    expect(requiresUserFallback(state)).toBe(false);
  });

  it("1 次成功后总拒绝仍保留", () => {
    let state = INITIAL_REJECTION_COUNTER;
    for (let i = 0; i < 10; i++) {
      state = countRejection(state);
    }
    state = countApproval(state);
    expect(state.totalRejections).toBe(10);
    // 连续重置但总拒绝仍高 → 不触发（因为连续 < 5 且总 < 30）
    expect(requiresUserFallback(state)).toBe(false);
  });

  it("自定义阈值应生效", () => {
    let state = INITIAL_REJECTION_COUNTER;
    for (let i = 0; i < 3; i++) {
      state = countRejection(state);
    }
    // 默认阈值 5 → 不触发
    expect(requiresUserFallback(state)).toBe(false);
    // 自定义阈值 3 → 触发
    expect(requiresUserFallback(state, { maxConsecutive: 3 })).toBe(true);
  });

  it("自定义总拒绝阈值应生效", () => {
    const state: RejectionCounter = { consecutiveRejections: 0, totalRejections: 10 };
    expect(requiresUserFallback(state, { maxTotal: 10 })).toBe(true);
    expect(requiresUserFallback(state, { maxTotal: 11 })).toBe(false);
  });
});

// ─── getRejectionSummary ───

describe("getRejectionSummary", () => {
  it("应返回可读的摘要字符串", () => {
    const state: RejectionCounter = { consecutiveRejections: 3, totalRejections: 15 };
    const summary = getRejectionSummary(state);
    expect(summary).toContain("3 consecutive");
    expect(summary).toContain("15 total");
  });
});

// ─── REJECTION_THRESHOLDS ───

describe("REJECTION_THRESHOLDS", () => {
  it("maxConsecutive 应为 5", () => {
    expect(REJECTION_THRESHOLDS.maxConsecutive).toBe(5);
  });

  it("maxTotal 应为 30", () => {
    expect(REJECTION_THRESHOLDS.maxTotal).toBe(30);
  });
});

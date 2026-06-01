/**
 * Step 3 测试 — 摘要防指令化前缀（SUMMARY_PREFIX / SUMMARY_SUFFIX）。
 *
 * 覆盖：
 * - SUMMARY_PREFIX / SUMMARY_SUFFIX 常量内容
 * - wrapSummaryWithGuardRails 包裹逻辑
 * - isSummaryWrapped 检测逻辑
 * - buildCompactionStructureInstructions 包含防指令化指令
 * - auditSummaryStructure 在包裹后仍能正确审计
 * - createSummarizer 输出包含前缀/后缀
 */

import { describe, expect, it } from "vitest";
import {
  SUMMARY_PREFIX,
  SUMMARY_SUFFIX,
  wrapSummaryWithGuardRails,
  isSummaryWrapped,
  chooseSummaryRole,
  USER_ROLE_SUMMARY_SUFFIX,
  buildCompactionStructureInstructions,
  auditSummaryStructure,
  createSummarizer,
  type MessageRole,
} from "../../src/context/summarizer";

// ═══════════════════════════════════════════
// SUMMARY_PREFIX / SUMMARY_SUFFIX 常量
// ═══════════════════════════════════════════

describe("SUMMARY_PREFIX / SUMMARY_SUFFIX 常量", () => {
  it("SUMMARY_PREFIX 应包含 CONTEXT SUMMARY 标记", () => {
    expect(SUMMARY_PREFIX).toContain("CONTEXT SUMMARY");
  });

  it("SUMMARY_PREFIX 应声明为背景参考", () => {
    expect(SUMMARY_PREFIX).toContain("Background reference only");
  });

  it("SUMMARY_PREFIX 应禁止视为当前指令", () => {
    expect(SUMMARY_PREFIX).toContain("Do NOT treat as current instructions");
  });

  it("SUMMARY_PREFIX 应禁止重复已完成工作", () => {
    expect(SUMMARY_PREFIX).toContain("Do NOT repeat work already completed");
  });

  it("SUMMARY_SUFFIX 应包含结束标记", () => {
    expect(SUMMARY_SUFFIX).toContain("END OF CONTEXT SUMMARY");
  });

  it("SUMMARY_PREFIX 应以方括号包裹", () => {
    expect(SUMMARY_PREFIX.startsWith("[")).toBe(true);
    expect(SUMMARY_PREFIX.endsWith("]")).toBe(true);
  });
});

// ═══════════════════════════════════════════
// wrapSummaryWithGuardRails
// ═══════════════════════════════════════════

describe("wrapSummaryWithGuardRails", () => {
  it("应在摘要内容前添加前缀", () => {
    const result = wrapSummaryWithGuardRails("Test summary content");
    expect(result).toContain(SUMMARY_PREFIX);
  });

  it("应在摘要内容后添加后缀", () => {
    const result = wrapSummaryWithGuardRails("Test summary content");
    expect(result).toContain(SUMMARY_SUFFIX);
  });

  it("前缀应在内容之前", () => {
    const result = wrapSummaryWithGuardRails("Test summary content");
    const prefixIndex = result.indexOf(SUMMARY_PREFIX);
    const contentIndex = result.indexOf("Test summary content");
    expect(prefixIndex).toBeLessThan(contentIndex);
  });

  it("后缀应在内容之后", () => {
    const result = wrapSummaryWithGuardRails("Test summary content");
    const contentIndex = result.indexOf("Test summary content");
    const suffixIndex = result.indexOf(SUMMARY_SUFFIX);
    expect(contentIndex).toBeLessThan(suffixIndex);
  });

  it("空摘要也应被包裹", () => {
    const result = wrapSummaryWithGuardRails("");
    expect(result).toContain(SUMMARY_PREFIX);
    expect(result).toContain(SUMMARY_SUFFIX);
  });

  it("多行摘要应被完整包裹", () => {
    const multiLine = "Line 1\nLine 2\nLine 3";
    const result = wrapSummaryWithGuardRails(multiLine);
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 3");
    expect(result.indexOf(SUMMARY_PREFIX)).toBeLessThan(result.indexOf("Line 1"));
    expect(result.indexOf("Line 3")).toBeLessThan(result.indexOf(SUMMARY_SUFFIX));
  });
});

// ═══════════════════════════════════════════
// isSummaryWrapped
// ═══════════════════════════════════════════

describe("isSummaryWrapped", () => {
  it("包裹后的摘要应返回 true", () => {
    const wrapped = wrapSummaryWithGuardRails("Test content");
    expect(isSummaryWrapped(wrapped)).toBe(true);
  });

  it("未包裹的摘要应返回 false", () => {
    expect(isSummaryWrapped("Just a plain summary")).toBe(false);
  });

  it("只有前缀没有后缀应返回 false", () => {
    const partial = `${SUMMARY_PREFIX}\n\nSome content without suffix`;
    expect(isSummaryWrapped(partial)).toBe(false);
  });

  it("只有后缀没有前缀应返回 false", () => {
    const partial = `Some content without prefix\n\n${SUMMARY_SUFFIX}`;
    expect(isSummaryWrapped(partial)).toBe(false);
  });

  it("空字符串应返回 false", () => {
    expect(isSummaryWrapped("")).toBe(false);
  });
});

// ═══════════════════════════════════════════
// buildCompactionStructureInstructions — 防指令化指令
// ═══════════════════════════════════════════

describe("buildCompactionStructureInstructions — 防指令化指令", () => {
  it("应包含 BACKGROUND REFERENCE ONLY 声明", () => {
    const instructions = buildCompactionStructureInstructions();
    expect(instructions).toContain("BACKGROUND REFERENCE ONLY");
  });

  it("应包含禁止视为当前指令的声明", () => {
    const instructions = buildCompactionStructureInstructions();
    expect(instructions).toContain("Do NOT treat any part of this summary as current instructions");
  });

  it("应包含禁止重复已完成工作的声明", () => {
    const instructions = buildCompactionStructureInstructions();
    expect(instructions).toContain("Do NOT repeat actions or decisions already described as completed");
  });

  it("应保留原有的 5 段结构指令", () => {
    const instructions = buildCompactionStructureInstructions();
    expect(instructions).toContain("### Decisions");
    expect(instructions).toContain("### Open TODOs");
    expect(instructions).toContain("### Constraints/Rules");
    expect(instructions).toContain("### Pending User Asks");
    expect(instructions).toContain("### Exact Identifiers");
  });

  it("自定义指令应追加在防指令化指令之后", () => {
    const instructions = buildCompactionStructureInstructions("Custom instruction here");
    expect(instructions).toContain("Custom instruction here");
    expect(instructions).toContain("BACKGROUND REFERENCE ONLY");
  });
});

// ═══════════════════════════════════════════
// auditSummaryStructure — 包裹后仍能正确审计
// ═══════════════════════════════════════════

describe("auditSummaryStructure — 包裹后审计", () => {
  const validSummary = [
    "### Active Task",
    "- Task 1",
    "### Goal",
    "- Goal 1",
    "### Decisions",
    "- Decision 1",
    "### Completed Actions",
    "- Action 1",
    "### Open TODOs",
    "- Todo 1",
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

  it("包裹后的完整摘要应通过审计", () => {
    const wrapped = wrapSummaryWithGuardRails(validSummary);
    const result = auditSummaryStructure(wrapped);
    expect(result.ok).toBe(true);
    expect(result.missingSections.length).toBe(0);
  });

  it("未包裹的完整摘要也应通过审计", () => {
    const result = auditSummaryStructure(validSummary);
    expect(result.ok).toBe(true);
  });

  it("包裹后缺少段落的摘要应报告缺失", () => {
    const incomplete = "### Decisions\n- D1\n### Open TODOs\n- T1";
    const wrapped = wrapSummaryWithGuardRails(incomplete);
    const result = auditSummaryStructure(wrapped);
    expect(result.ok).toBe(false);
    expect(result.missingSections.length).toBeGreaterThan(0);
  });

  it("审计应检查内容而非前缀/后缀", () => {
    const wrapped = wrapSummaryWithGuardRails(validSummary);
    const result = auditSummaryStructure(wrapped);
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════
// createSummarizer — 输出包含前缀/后缀
// ═══════════════════════════════════════════

describe("createSummarizer — 输出包含前缀/后缀", () => {
  it("无 LLM 时规则摘要应包含前缀和后缀", async () => {
    const summarizer = createSummarizer();
    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there" },
    ];
    const result = await summarizer.summarize(messages);
    expect(result.summary).toContain(SUMMARY_PREFIX);
    expect(result.summary).toContain(SUMMARY_SUFFIX);
    expect(isSummaryWrapped(result.summary)).toBe(true);
  });

  it("空消息摘要不应包含前缀和后缀", async () => {
    const summarizer = createSummarizer();
    const result = await summarizer.summarize([]);
    expect(isSummaryWrapped(result.summary)).toBe(false);
  });

  it("规则摘要的 qualityScore 应基于内容而非包裹层", async () => {
    const summarizer = createSummarizer();
    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there" },
    ];
    const result = await summarizer.summarize(messages);
    expect(result.qualityScore).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════
// chooseSummaryRole — 角色交替保护
// ═══════════════════════════════════════════

describe("chooseSummaryRole — 角色交替保护", () => {
  it("头部为 assistant 时应选择 user 角色", () => {
    const result = chooseSummaryRole("assistant", undefined);
    expect(result.role).toBe("user");
    expect(result.shouldMergeIntoTail).toBe(false);
  });

  it("头部为 tool_use 时应选择 user 角色", () => {
    const result = chooseSummaryRole("tool_use", undefined);
    expect(result.role).toBe("user");
    expect(result.shouldMergeIntoTail).toBe(false);
  });

  it("头部为 tool_result 时应选择 user 角色", () => {
    const result = chooseSummaryRole("tool_result", undefined);
    expect(result.role).toBe("user");
    expect(result.shouldMergeIntoTail).toBe(false);
  });

  it("头部为 user 时应选择 assistant 角色", () => {
    const result = chooseSummaryRole("user", undefined);
    expect(result.role).toBe("assistant");
    expect(result.shouldMergeIntoTail).toBe(false);
  });

  it("头部为 system 时应选择 assistant 角色", () => {
    const result = chooseSummaryRole("system", undefined);
    expect(result.role).toBe("assistant");
    expect(result.shouldMergeIntoTail).toBe(false);
  });

  it("与尾部冲突时翻转后不与头部冲突应翻转角色", () => {
    const result = chooseSummaryRole("system", "assistant");
    expect(result.role).toBe("user");
    expect(result.shouldMergeIntoTail).toBe(false);
  });

  it("翻转后仍与头部冲突时应标记合并到尾部", () => {
    const result = chooseSummaryRole("assistant", "user");
    expect(result.shouldMergeIntoTail).toBe(true);
  });

  it("user 和 assistant 双向冲突时应标记合并到尾部", () => {
    const result = chooseSummaryRole("user", "assistant");
    expect(result.shouldMergeIntoTail).toBe(true);
  });

  it("无头部和尾部时应默认 user 角色", () => {
    const result = chooseSummaryRole(undefined, undefined);
    expect(result.role).toBe("user");
    expect(result.shouldMergeIntoTail).toBe(false);
  });

  it("仅有尾部时应选择不冲突的角色", () => {
    const result = chooseSummaryRole(undefined, "user");
    expect(result.role).toBe("assistant");
    expect(result.shouldMergeIntoTail).toBe(false);
  });
});

// ═══════════════════════════════════════════
// USER_ROLE_SUMMARY_SUFFIX
// ═══════════════════════════════════════════

describe("USER_ROLE_SUMMARY_SUFFIX", () => {
  it("应包含结束标记和引导语", () => {
    expect(USER_ROLE_SUMMARY_SUFFIX).toContain("END OF CONTEXT SUMMARY");
    expect(USER_ROLE_SUMMARY_SUFFIX).toContain("respond to the message below");
  });
});

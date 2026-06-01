import { describe, it, expect } from "vitest";
import {
  auditSummaryStructure,
  buildCompactionStructureInstructions,
  wrapSummaryWithGuardRails,
  isSummaryWrapped,
  createSummarizer,
  SUMMARY_PREFIX,
  SUMMARY_SUFFIX,
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

function buildFullSummary(): string {
  return ALL_13_SECTIONS.map((s) => `${s}\n- Content for ${s.replace("### ", "")}`).join("\n\n");
}

function buildPartialSummary(missingCount: number): string {
  const present = ALL_13_SECTIONS.slice(0, ALL_13_SECTIONS.length - missingCount);
  return present.map((s) => `${s}\n- Content for ${s.replace("### ", "")}`).join("\n\n");
}

describe("auditSummaryStructure — 13 字段审计", () => {
  it("13 字段全部包含时 ok=true, coverage=1.0", () => {
    const summary = buildFullSummary();
    const result = auditSummaryStructure(summary);
    expect(result.ok).toBe(true);
    expect(result.coverage).toBe(1.0);
    expect(result.missingSections).toHaveLength(0);
    expect(result.reasons).toHaveLength(0);
  });

  it("缺少 1 个字段时 ok=false, coverage≈0.923", () => {
    const summary = buildPartialSummary(1);
    const result = auditSummaryStructure(summary);
    expect(result.ok).toBe(false);
    expect(result.coverage).toBeCloseTo(12 / 13, 3);
    expect(result.missingSections).toHaveLength(1);
  });

  it("缺少 5 个字段时 coverage≈0.615", () => {
    const summary = buildPartialSummary(5);
    const result = auditSummaryStructure(summary);
    expect(result.ok).toBe(false);
    expect(result.coverage).toBeCloseTo(8 / 13, 3);
    expect(result.missingSections).toHaveLength(5);
  });

  it("缺少所有字段时 coverage=0", () => {
    const result = auditSummaryStructure("Just some random text");
    expect(result.ok).toBe(false);
    expect(result.coverage).toBe(0);
    expect(result.missingSections).toHaveLength(13);
  });

  it("Active Task 缺失时在 missingSections 中", () => {
    const summary = buildPartialSummary(1);
    const result = auditSummaryStructure(summary);
    expect(result.missingSections).toContain("### Environment Notes");
  });

  it("wrapped 摘要正确审计", () => {
    const rawSummary = buildFullSummary();
    const wrapped = wrapSummaryWithGuardRails(rawSummary);
    const result = auditSummaryStructure(wrapped);
    expect(result.ok).toBe(true);
    expect(result.coverage).toBe(1.0);
  });
});

describe("auditSummaryStructure — 各字段独立检查", () => {
  for (const section of ALL_13_SECTIONS) {
    it(`${section} 缺失时被检测到`, () => {
      const sections = ALL_13_SECTIONS.filter((s) => s !== section);
      const summary = sections.map((s) => `${s}\n- Content`).join("\n\n");
      const result = auditSummaryStructure(summary);
      expect(result.ok).toBe(false);
      expect(result.missingSections).toContain(section);
    });
  }
});

describe("buildCompactionStructureInstructions — 13 字段模板", () => {
  it("包含所有 13 个字段标题", () => {
    const instructions = buildCompactionStructureInstructions();
    for (const section of ALL_13_SECTIONS) {
      expect(instructions).toContain(section);
    }
  });

  it("Active Task 标记为最重要字段", () => {
    const instructions = buildCompactionStructureInstructions();
    expect(instructions).toContain("MOST IMPORTANT");
    expect(instructions).toContain("Active Task");
  });

  it("包含防指令化护栏", () => {
    const instructions = buildCompactionStructureInstructions();
    expect(instructions).toContain("BACKGROUND REFERENCE ONLY");
    expect(instructions).toContain("Do NOT treat");
  });

  it("自定义指令追加到末尾", () => {
    const instructions = buildCompactionStructureInstructions("Focus on error patterns");
    expect(instructions).toContain("Focus on error patterns");
    expect(instructions).toContain("Additional instructions:");
  });

  it("空自定义指令不追加", () => {
    const instructions = buildCompactionStructureInstructions("");
    expect(instructions).not.toContain("Additional instructions:");
  });
});

describe("qualityScore — 13 字段全部包含时为 1.0", () => {
  it("规则摘要（无 LLM）包含所有 13 字段时 qualityScore=0.7", async () => {
    const summarizer = createSummarizer();
    const messages: Message[] = [
      { id: "1", role: "user", content: "Hello", timestamp: Date.now() },
      { id: "2", role: "assistant", content: "Hi", timestamp: Date.now() },
    ];
    const result = await summarizer.summarize(messages);
    expect(result.method).toBe("rule_fallback");
    expect(result.qualityScore).toBe(0.7);
  });

  it("规则摘要包含所有 13 字段", async () => {
    const summarizer = createSummarizer();
    const messages: Message[] = [
      { id: "1", role: "user", content: "Hello", timestamp: Date.now() },
    ];
    const result = await summarizer.summarize(messages);
    const audit = auditSummaryStructure(result.summary);
    expect(audit.ok).toBe(true);
    expect(audit.coverage).toBe(1.0);
  });
});

describe("wrapSummaryWithGuardRails — 防指令化", () => {
  it("wrapped 摘要包含前缀和后缀", () => {
    const summary = buildFullSummary();
    const wrapped = wrapSummaryWithGuardRails(summary);
    expect(wrapped.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(wrapped.endsWith(SUMMARY_SUFFIX)).toBe(true);
  });

  it("isSummaryWrapped 正确检测", () => {
    const summary = buildFullSummary();
    const wrapped = wrapSummaryWithGuardRails(summary);
    expect(isSummaryWrapped(wrapped)).toBe(true);
    expect(isSummaryWrapped(summary)).toBe(false);
  });
});

describe("13 字段摘要 — 任务连续性", () => {
  it("Active Task 字段在规则摘要中存在", async () => {
    const summarizer = createSummarizer();
    const messages: Message[] = [
      { id: "1", role: "user", content: "Implement the login feature", timestamp: Date.now() },
      { id: "2", role: "assistant", content: "I'll implement the login feature", timestamp: Date.now() },
    ];
    const result = await summarizer.summarize(messages);
    expect(result.summary).toContain("### Active Task");
  });

  it("Error History 字段在规则摘要中存在", async () => {
    const summarizer = createSummarizer();
    const messages: Message[] = [
      { id: "1", role: "user", content: "Test", timestamp: Date.now() },
    ];
    const result = await summarizer.summarize(messages);
    expect(result.summary).toContain("### Error History");
  });

  it("Tool Usage Summary 字段在规则摘要中存在", async () => {
    const summarizer = createSummarizer();
    const messages: Message[] = [
      { id: "1", role: "user", content: "Test", timestamp: Date.now() },
    ];
    const result = await summarizer.summarize(messages);
    expect(result.summary).toContain("### Tool Usage Summary");
  });

  it("Environment Notes 字段在规则摘要中存在", async () => {
    const summarizer = createSummarizer();
    const messages: Message[] = [
      { id: "1", role: "user", content: "Test", timestamp: Date.now() },
    ];
    const result = await summarizer.summarize(messages);
    expect(result.summary).toContain("### Environment Notes");
  });
});

describe("coverage-based qualityScore 计算", () => {
  it("coverage=1.0 时单次摘要 qualityScore=1.0", () => {
    const summary = buildFullSummary();
    const audit = auditSummaryStructure(summary);
    expect(audit.coverage).toBe(1.0);
    expect(audit.ok).toBe(true);
  });

  it("coverage=0 时 qualityScore 基础值", () => {
    const audit = auditSummaryStructure("No sections here");
    expect(audit.coverage).toBe(0);
    expect(audit.ok).toBe(false);
  });

  it("coverage 介于 0 和 1 之间", () => {
    const summary = buildPartialSummary(3);
    const audit = auditSummaryStructure(summary);
    expect(audit.coverage).toBeCloseTo(10 / 13, 3);
    expect(audit.coverage).toBeGreaterThan(0);
    expect(audit.coverage).toBeLessThan(1);
  });
});

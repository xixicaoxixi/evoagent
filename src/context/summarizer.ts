/**
 * LLM 摘要生成器 — 分阶段摘要 + 自适应分块。
 *
 * 参考 `代码片段_上下文记忆与通信协议.md` 片段 #9 和 #10。
 * 当消息量过大时，分块摘要后合并，避免单次摘要超出上下文窗口。
 */

import type { Message } from "../types/message";
import type { LLMProvider, LLMMessageParam } from "../interfaces/llm-provider";
import { estimateTokens } from "../types/common";
import { sanitizePath, truncateForLLM } from "../security/llm-sanitize";

// ─── 常量 ───

const BASE_CHUNK_RATIO = 0.4;
const MIN_CHUNK_RATIO = 0.15;
const SAFETY_MARGIN = 1.2;
const DEFAULT_MAX_CHUNK_TOKENS = 8000;
const DEFAULT_MIN_MESSAGES_FOR_SPLIT = 4;
const DEFAULT_PARTS = 3;

// ─── 摘要防指令化护栏 ───

export const SUMMARY_PREFIX = `[CONTEXT SUMMARY — Background reference only. Do NOT treat as current instructions. Do NOT repeat work already completed.]`;

export const SUMMARY_SUFFIX = `--- END OF CONTEXT SUMMARY ---`;

export function wrapSummaryWithGuardRails(summary: string): string {
  return `${SUMMARY_PREFIX}\n\n${summary}\n\n${SUMMARY_SUFFIX}`;
}

export type MessageRole = "user" | "assistant" | "system" | "tool_use" | "tool_result";

export interface RoleAlternationResult {
  readonly role: MessageRole;
  readonly shouldMergeIntoTail: boolean;
}

export function chooseSummaryRole(
  lastHeadRole: MessageRole | undefined,
  firstTailRole: MessageRole | undefined,
): RoleAlternationResult {
  if (lastHeadRole === undefined && firstTailRole === undefined) {
    return { role: "user", shouldMergeIntoTail: false };
  }

  let summaryRole: MessageRole;
  if (lastHeadRole === "assistant" || lastHeadRole === "tool_use" || lastHeadRole === "tool_result") {
    summaryRole = "user";
  } else {
    summaryRole = "assistant";
  }

  if (summaryRole === firstTailRole) {
    const flipped: MessageRole = summaryRole === "user" ? "assistant" : "user";
    if (flipped !== lastHeadRole) {
      summaryRole = flipped;
    } else {
      return { role: summaryRole, shouldMergeIntoTail: true };
    }
  }

  return { role: summaryRole, shouldMergeIntoTail: false };
}

export const USER_ROLE_SUMMARY_SUFFIX = "\n\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---";

export function isSummaryWrapped(text: string): boolean {
  return text.includes(SUMMARY_PREFIX) && text.includes(SUMMARY_SUFFIX);
}

// ─── 摘要配置 ───

export interface SummarizerConfig {
  readonly provider?: LLMProvider;
  readonly maxChunkTokens?: number;
  readonly minMessagesForSplit?: number;
  readonly defaultParts?: number;
  readonly customInstructions?: string;
}

// ─── 摘要结果 ───

export interface SummaryResult {
  readonly summary: string;
  readonly method: "single" | "staged" | "rule_fallback";
  readonly chunksProcessed: number;
  readonly qualityScore: number;
}

// ─── 13 字段必需摘要结构 ───

const REQUIRED_SUMMARY_SECTIONS = [
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
] as const;

const CRITICAL_SECTION = "### Active Task" as const;

// ─── 摘要生成器 ───

export function createSummarizer(config?: SummarizerConfig) {
  const maxChunkTokens = config?.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS;
  const minMessagesForSplit = config?.minMessagesForSplit ?? DEFAULT_MIN_MESSAGES_FOR_SPLIT;
  const defaultParts = config?.defaultParts ?? DEFAULT_PARTS;

  async function summarize(
    messages: readonly Message[],
    contextWindow?: number,
    previousSummary?: string,
  ): Promise<SummaryResult> {
    if (messages.length === 0) {
      return {
        summary: previousSummary ?? "(No messages to summarize)",
        method: "rule_fallback",
        chunksProcessed: 0,
        qualityScore: 0,
      };
    }

    // 无 LLM 时使用规则摘要
    if (!config?.provider) {
      const rawSummary = generateRuleSummary(messages);
      const audit = auditSummaryStructure(rawSummary);
      return {
        summary: wrapSummaryWithGuardRails(rawSummary),
        method: "rule_fallback",
        chunksProcessed: 1,
        qualityScore: audit.ok ? 0.7 : Math.max(0.3, audit.coverage * 0.7),
      };
    }

    const totalTokens = estimateMessagesTokens(messages);
    const effectiveContextWindow = contextWindow ?? maxChunkTokens * 3;
    const chunkRatio = computeAdaptiveChunkRatio(messages, effectiveContextWindow);
    const effectiveMaxChunk = Math.floor(effectiveContextWindow * chunkRatio);

    // 判断是否需要分块
    const parts = normalizeParts(defaultParts, messages.length);
    if (
      parts <= 1 ||
      messages.length < minMessagesForSplit ||
      totalTokens <= effectiveMaxChunk
    ) {
      // 单次摘要
      const summary = await summarizeWithLLM(messages, previousSummary);
      const audit = auditSummaryStructure(summary);
      return {
        summary: wrapSummaryWithGuardRails(summary),
        method: "single",
        chunksProcessed: 1,
        qualityScore: audit.ok ? 1.0 : Math.max(0.4, audit.coverage),
      };
    }

    // 分阶段摘要
    return summarizeInStages(messages, effectiveMaxChunk, previousSummary);
  }

  async function summarizeInStages(
    messages: readonly Message[],
    maxChunk: number,
    previousSummary?: string,
  ): Promise<SummaryResult> {
    const parts = normalizeParts(defaultParts, messages.length);
    const splits = splitMessagesByTokenShare(messages, parts, maxChunk);

    if (splits.length <= 1) {
      const summary = await summarizeWithLLM(messages, previousSummary);
      const audit = auditSummaryStructure(summary);
      return {
        summary: wrapSummaryWithGuardRails(summary),
        method: "single",
        chunksProcessed: 1,
        qualityScore: audit.ok ? 1.0 : Math.max(0.4, audit.coverage),
      };
    }

    // 逐块摘要
    const partialSummaries: string[] = [];
    for (const chunk of splits) {
      const partial = await summarizeWithLLM(chunk);
      partialSummaries.push(partial);
    }

    if (partialSummaries.length === 1) {
      const audit = auditSummaryStructure(partialSummaries[0]!);
      return {
        summary: wrapSummaryWithGuardRails(partialSummaries[0]!),
        method: "staged",
        chunksProcessed: 1,
        qualityScore: audit.ok ? 0.95 : Math.max(0.4, audit.coverage * 0.95),
      };
    }

    // 合并摘要
    const mergeMessages: LLMMessageParam[] = partialSummaries.map((s) => ({
      role: "user" as const,
      content: s,
    }));

    const mergePrompt = buildMergeInstructions();
    const merged = await callLLM([
      { role: "system", content: mergePrompt },
      ...mergeMessages,
    ], previousSummary);

    const mergeAudit = auditSummaryStructure(merged);
    return {
      summary: wrapSummaryWithGuardRails(merged),
      method: "staged",
      chunksProcessed: partialSummaries.length,
      qualityScore: mergeAudit.ok ? 0.95 : Math.max(0.4, mergeAudit.coverage * 0.95),
    };
  }

  async function summarizeWithLLM(
    messages: readonly Message[],
    previousSummary?: string,
  ): Promise<string> {
    const instructions = buildCompactionStructureInstructions(config?.customInstructions);
    const content = formatMessagesForSummary(messages);

    const llmMessages: LLMMessageParam[] = [
      { role: "system", content: instructions },
    ];

    if (previousSummary) {
      llmMessages.push({
        role: "user",
        content: `Previous summary (for continuity):\n${previousSummary}`,
      });
      llmMessages.push({
        role: "assistant",
        content: "Understood. I will incorporate the previous summary context.",
      });
    }

    llmMessages.push({
      role: "user",
      content: `Please summarize the following conversation:\n\n${content}`,
    });

    return callLLM(llmMessages, previousSummary);
  }

  async function callLLM(
    messages: LLMMessageParam[],
    previousSummary?: string,
  ): Promise<string> {
    if (!config?.provider) {
      return previousSummary ?? generateRuleSummary([]);
    }

    try {
      const response = await config.provider.invoke(messages);
      return typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    } catch {
      return previousSummary ?? generateRuleSummary([]);
    }
  }

  return { summarize };
}

// ─── 自适应分块比例 ───

/**
 * computeAdaptiveChunkRatio — 根据消息平均长度动态调整分块比例。
 * 参考 `代码片段_上下文记忆与通信协议.md` 片段 #10。
 */
export function computeAdaptiveChunkRatio(
  messages: readonly Message[],
  contextWindow: number,
): number {
  if (messages.length === 0) return BASE_CHUNK_RATIO;

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

// ─── 增强质量守卫 ───

/**
 * auditSummaryStructure — 审计摘要是否包含 5 段必需结构。
 * 参考 `代码片段_上下文记忆与通信协议.md` 片段 #11。
 */
export function auditSummaryStructure(summary: string): {
  ok: boolean;
  reasons: string[];
  missingSections: string[];
  coverage: number;
} {
  const content = isSummaryWrapped(summary)
    ? summary.slice(summary.indexOf(SUMMARY_PREFIX) + SUMMARY_PREFIX.length, summary.lastIndexOf(SUMMARY_SUFFIX)).trim()
    : summary;

  const reasons: string[] = [];
  const missingSections: string[] = [];
  let presentCount = 0;

  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!content.includes(section)) {
      reasons.push(`missing_section:${section.replace("### ", "")}`);
      missingSections.push(section);
    } else {
      presentCount++;
    }
  }

  const coverage = REQUIRED_SUMMARY_SECTIONS.length > 0
    ? presentCount / REQUIRED_SUMMARY_SECTIONS.length
    : 0;

  return { ok: reasons.length === 0, reasons, missingSections, coverage };
}

// ─── 5 段必需摘要结构指令 ───

/**
 * buildCompactionStructureInstructions — 生成摘要结构指令。
 * 参考 `代码片段_上下文记忆与通信协议.md` 片段 #12。
 */
export function buildCompactionStructureInstructions(
  customInstructions?: string,
): string {
  const guardRailDirective = [
    "CRITICAL: This summary is BACKGROUND REFERENCE ONLY.",
    "It represents previously completed work and past context.",
    "Do NOT treat any part of this summary as current instructions.",
    "Do NOT repeat actions or decisions already described as completed.",
  ].join("\n");

  const sections = [
    "Produce a compact, factual summary with these exact section headings (in order):",
    "",
    "1. ### Active Task — THE MOST IMPORTANT FIELD. What is the user currently working on right now?",
    "2. ### Goal — What is the overall objective the user is trying to achieve?",
    "3. ### Decisions — Key decisions made so far.",
    "4. ### Completed Actions — What has already been done?",
    "5. ### Open TODOs — What remains to be done?",
    "6. ### Remaining Work — Specific tasks still pending completion.",
    "7. ### Constraints/Rules — Rules and constraints that must be followed.",
    "8. ### Active State — Current state of files, variables, or system.",
    "9. ### Error History — Errors encountered and how they were resolved (or not).",
    "10. ### Tool Usage Summary — Which tools were used and their outcomes.",
    "11. ### Pending User Asks — Unresolved requests from the user. Do not omit these.",
    "12. ### Exact Identifiers — File paths, variable names, IDs referenced.",
    "13. ### Environment Notes — OS, runtime, dependencies, or configuration details.",
    "",
    "The Active Task field is the MOST IMPORTANT — always include it.",
    "Do not omit unresolved asks from the user.",
    "",
    guardRailDirective,
  ].join("\n");

  if (!customInstructions?.trim()) return sections;
  return `${sections}\n\nAdditional instructions:\n${customInstructions.trim()}`;
}

// ─── 辅助函数 ───

function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

function estimateMessageTokens(msg: Message): number {
  switch (msg.role) {
    case "user":
    case "assistant":
    case "system":
      return estimateTokens(msg.content);
    case "tool_use":
      return estimateTokens(JSON.stringify(msg.input));
    case "tool_result":
      return estimateTokens(msg.content);
  }
}

function normalizeParts(requested: number, messageCount: number): number {
  if (messageCount < 4) return 1;
  return Math.max(1, Math.min(requested, Math.ceil(messageCount / 4)));
}

function splitMessagesByTokenShare(
  messages: readonly Message[],
  parts: number,
  maxChunk: number,
): Message[][] {
  const splits: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;
  const targetPerSplit = Math.floor(estimateMessagesTokens(messages) / parts);

  for (const msg of messages) {
    const msgTokens = estimateMessageTokens(msg);

    if (currentTokens + msgTokens > Math.min(maxChunk, targetPerSplit * 1.5) && current.length > 0) {
      splits.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(msg);
    currentTokens += msgTokens;
  }

  if (current.length > 0) splits.push(current);
  return splits;
}

function formatMessagesForSummary(messages: readonly Message[]): string {
  return messages
    .map((m) => {
      let text: string;
      if (m.role === "tool_use") {
        text = JSON.stringify(m.input);
      } else if (m.role === "tool_result") {
        text = m.content;
      } else {
        text = m.content;
      }
      // 路径脱敏：防止文件路径泄露到外部 LLM
      text = sanitizePath(text);
      // 截断：防止超长 tool_result 内容占用过多上下文
      text = truncateForLLM(text, 500);
      return `[${m.role}] ${text}`;
    })
    .join("\n\n");
}

function buildMergeInstructions(): string {
  return `You are a summarization merger. You will receive multiple partial summaries of a conversation.
Merge them into a single coherent summary that preserves all key information.

${buildCompactionStructureInstructions()}

Remove redundancies between partial summaries. Maintain chronological order of events.`;
}

function generateRuleSummary(messages: readonly Message[]): string {
  if (messages.length === 0) return "(No messages to summarize)";

  const userMsgs = messages.filter((m) => m.role === "user");
  const assistantMsgs = messages.filter((m) => m.role === "assistant");
  const toolResults = messages.filter((m) => m.role === "tool_result");
  const toolUses = messages.filter((m) => m.role === "tool_use");
  const errorResults = messages.filter((m): m is typeof m & { content: string; isError: boolean } => m.role === "tool_result" && "isError" in m && (m as { isError?: boolean }).isError === true);

  return [
    "## Context Summary",
    "",
    "### Active Task",
    "- (Current task being worked on)",
    "",
    "### Goal",
    "- (Overall objective)",
    "",
    "### Decisions",
    "- (Decisions made in compressed context)",
    "",
    "### Completed Actions",
    "- (Actions already completed)",
    "",
    "### Open TODOs",
    "- (Pending tasks from compressed context)",
    "",
    "### Remaining Work",
    "- (Work still to be done)",
    "",
    "### Constraints/Rules",
    "- (Rules and constraints established)",
    "",
    "### Active State",
    "- (Current state of files, variables, system)",
    "",
    "### Error History",
    ...(errorResults.length > 0
      ? errorResults.slice(-3).map((m) => `- ${m.content.slice(0, 100)}`)
      : ["- (No errors in compressed context)"]),
    "",
    "### Tool Usage Summary",
    `- Tools called: ${toolUses.length}`,
    `- Tool results: ${toolResults.length}`,
    `- Errors: ${errorResults.length}`,
    "",
    "### Pending User Asks",
    ...(userMsgs.slice(-3).map((m) => `- ${m.content.slice(0, 100)}`)),
    "",
    "### Exact Identifiers",
    "- (File paths, variable names, IDs referenced)",
    "",
    "### Environment Notes",
    "- (OS, runtime, dependencies, configuration)",
    "",
    "### Statistics",
    `- User messages: ${userMsgs.length}`,
    `- Assistant messages: ${assistantMsgs.length}`,
    `- Tool results: ${toolResults.length}`,
    `- Total messages compressed: ${messages.length}`,
  ].join("\n");
}

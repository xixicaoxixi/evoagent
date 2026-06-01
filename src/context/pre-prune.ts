/**
 * 工具输出预剪枝 — 在 pruneOldTurns 之前的三遍扫描预处理。
 *
 * Pass 1（去重）：同哈希旧结果替换为占位符
 * Pass 2（信息化摘要）：按工具类型生成摘要
 * Pass 3（参数截断）：JSON 安全截断长 tool_call.arguments
 *
 * 规则 2-2: Fail-Closed 默认值。
 * 规则 2-7: 原子写入（不修改原数组，返回新数组）。
 */

import { createHash } from "crypto";
import type { Message, ToolUseMessage, ToolResultMessage } from "../types/message";

// ─── 配置 ───

export interface PrePruneConfig {
  readonly dedupEnabled?: boolean;
  readonly summaryEnabled?: boolean;
  readonly summaryThresholdChars?: number;
  readonly argsTruncationEnabled?: boolean;
  readonly argsTruncationMaxChars?: number;
  readonly argsStringValueMaxChars?: number;
}

const DEFAULT_CONFIG: Required<PrePruneConfig> = {
  dedupEnabled: true,
  summaryEnabled: true,
  summaryThresholdChars: 1000,
  argsTruncationEnabled: true,
  argsTruncationMaxChars: 1500,
  argsStringValueMaxChars: 200,
};

// ─── 辅助函数 ───

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function isToolUse(msg: Message): msg is ToolUseMessage {
  return msg.role === "tool_use";
}

function isToolResult(msg: Message): msg is ToolResultMessage {
  return msg.role === "tool_result";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Pass 1: 去重 ───

const DEDUP_PLACEHOLDER = "[Duplicate tool output — see earlier]";

function pass1Dedup(
  messages: readonly Message[],
  enabled: boolean,
): { readonly messages: readonly Message[]; readonly tokensSaved: number } {
  if (!enabled) return { messages, tokensSaved: 0 };

  const lastOccurrence = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (isToolResult(msg)) {
      const hash = contentHash(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      lastOccurrence.set(hash, i);
    }
  }

  let tokensSaved = 0;
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (!isToolResult(msg)) {
      result.push(msg);
      continue;
    }

    const hash = contentHash(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    const lastIndex = lastOccurrence.get(hash)!;

    if (i < lastIndex) {
      const originalContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      tokensSaved += estimateTokens(originalContent) - estimateTokens(DEDUP_PLACEHOLDER);
      result.push({
        ...msg,
        content: DEDUP_PLACEHOLDER,
      });
    } else {
      result.push(msg);
    }
  }

  return { messages: result, tokensSaved };
}

// ─── Pass 2: 工具类型感知摘要 ───

function buildToolUseLookup(messages: readonly Message[]): Map<string, ToolUseMessage> {
  const lookup = new Map<string, ToolUseMessage>();
  for (const msg of messages) {
    if (isToolUse(msg)) {
      lookup.set(msg.toolUseId, msg);
    }
  }
  return lookup;
}

function summarizeBashOutput(content: string, toolUse: ToolUseMessage): string {
  const input = toolUse.input as Record<string, unknown>;
  const command = typeof input?.command === "string" ? input.command : "unknown";
  const lines = content.split("\n").length;
  const exitCodeMatch = content.match(/exit code[:\s]*(\d+)/i);
  const exitCode = exitCodeMatch ? exitCodeMatch[1] : "N/A";

  const firstLines = content.split("\n").slice(0, 5).join("\n");
  const truncated = lines > 5 ? `\n... (${lines - 5} more lines)` : "";

  return `[Terminal summary] command: ${command}\nexit: ${exitCode}, lines: ${lines}\n${firstLines}${truncated}`;
}

function summarizeReadFileOutput(content: string, toolUse: ToolUseMessage): string {
  const input = toolUse.input as Record<string, unknown>;
  const path = typeof input?.path === "string" ? input.path : "unknown";
  const offset = typeof input?.offset === "number" ? input.offset : 0;
  const charCount = content.length;

  const firstLines = content.split("\n").slice(0, 5).join("\n");
  const totalLines = content.split("\n").length;
  const truncated = totalLines > 5 ? `\n... (${totalLines - 5} more lines)` : "";

  return `[File read summary] path: ${path}, offset: ${offset}, chars: ${charCount}\n${firstLines}${truncated}`;
}

function summarizeGlobOutput(content: string): string {
  const paths = content.split("\n").filter((l) => l.trim().length > 0);
  const matchCount = paths.length;
  const first5 = paths.slice(0, 5).join("\n");
  const more = matchCount > 5 ? `\n... and ${matchCount - 5} more` : "";

  return `[Glob summary] ${matchCount} matches\n${first5}${more}`;
}

function summarizeGrepOutput(content: string, toolUse: ToolUseMessage): string {
  const input = toolUse.input as Record<string, unknown>;
  const pattern = typeof input?.pattern === "string" ? input.pattern : typeof input?.query === "string" ? input.query : "unknown";
  const lines = content.split("\n");
  const matchCount = lines.filter((l) => l.trim().length > 0).length;
  const firstLines = lines.slice(0, 5).join("\n");
  const truncated = lines.length > 5 ? `\n... (${lines.length - 5} more lines)` : "";

  return `[Grep summary] pattern: ${pattern}, ${matchCount} matches\n${firstLines}${truncated}`;
}

function summarizeWebSearchOutput(content: string, toolUse: ToolUseMessage): string {
  const input = toolUse.input as Record<string, unknown>;
  const query = typeof input?.query === "string" ? input.query : "unknown";
  const lines = content.split("\n");
  const firstLines = lines.slice(0, 5).join("\n");
  const truncated = lines.length > 5 ? `\n... (${lines.length - 5} more lines)` : "";

  return `[Web search summary] query: ${query}, ${content.length} chars\n${firstLines}${truncated}`;
}

function summarizeListDirOutput(content: string, toolUse: ToolUseMessage): string {
  const input = toolUse.input as Record<string, unknown>;
  const path = typeof input?.path === "string" ? input.path : "unknown";
  const entries = content.split("\n").filter((l) => l.trim().length > 0);
  const first5 = entries.slice(0, 5).join("\n");
  const more = entries.length > 5 ? `\n... and ${entries.length - 5} more` : "";

  return `[List dir summary] path: ${path}, ${entries.length} entries\n${first5}${more}`;
}

function summarizeWriteFileOutput(content: string, toolUse: ToolUseMessage): string {
  const input = toolUse.input as Record<string, unknown>;
  const path = typeof input?.path === "string" ? input.path : "unknown";
  const contentLen = typeof input?.content === "string" ? (input.content as string).length : 0;

  return `[File write summary] path: ${path}, wrote ${contentLen} chars → ${content.slice(0, 80)}`;
}

function summarizeEditFileOutput(content: string, toolUse: ToolUseMessage): string {
  const input = toolUse.input as Record<string, unknown>;
  const path = typeof input?.path === "string" ? input.path : "unknown";
  const oldStr = typeof input?.old_str === "string" ? (input.old_str as string).slice(0, 40) : "";
  const newStr = typeof input?.new_str === "string" ? (input.new_str as string).slice(0, 40) : "";

  return `[File edit summary] path: ${path}, replaced "${oldStr}..." → "${newStr}..." → ${content.slice(0, 80)}`;
}

function summarizeGenericOutput(content: string, toolName: string): string {
  const lines = content.split("\n");
  const firstLines = lines.slice(0, 5).join("\n");
  const truncated = lines.length > 5 ? `\n... (${lines.length - 5} more lines)` : "";

  return `[${toolName} summary] ${content.length} chars, ${lines.length} lines\n${firstLines}${truncated}`;
}

function pass2Summary(
  messages: readonly Message[],
  enabled: boolean,
  thresholdChars: number,
): { readonly messages: readonly Message[]; readonly tokensSaved: number } {
  if (!enabled) return { messages, tokensSaved: 0 };

  const toolUseLookup = buildToolUseLookup(messages);
  let tokensSaved = 0;
  const result: Message[] = [];

  for (const msg of messages) {
    if (!isToolResult(msg)) {
      result.push(msg);
      continue;
    }

    const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

    if (contentStr.length <= thresholdChars) {
      result.push(msg);
      continue;
    }

    if (contentStr === DEDUP_PLACEHOLDER) {
      result.push(msg);
      continue;
    }

    const toolUse = toolUseLookup.get(msg.toolUseId);
    let summary: string;

    if (toolUse) {
      switch (toolUse.toolName) {
        case "bash":
        case "terminal":
          summary = summarizeBashOutput(contentStr, toolUse);
          break;
        case "read_file":
        case "file_read":
          summary = summarizeReadFileOutput(contentStr, toolUse);
          break;
        case "glob":
        case "file_glob":
          summary = summarizeGlobOutput(contentStr);
          break;
        case "grep":
        case "rg":
        case "search":
          summary = summarizeGrepOutput(contentStr, toolUse);
          break;
        case "web_search":
        case "web_fetch":
          summary = summarizeWebSearchOutput(contentStr, toolUse);
          break;
        case "list_dir":
        case "ls":
          summary = summarizeListDirOutput(contentStr, toolUse);
          break;
        case "write_file":
        case "file_write":
          summary = summarizeWriteFileOutput(contentStr, toolUse);
          break;
        case "edit_file":
        case "file_edit":
          summary = summarizeEditFileOutput(contentStr, toolUse);
          break;
        default:
          summary = summarizeGenericOutput(contentStr, toolUse.toolName);
      }
    } else {
      summary = summarizeGenericOutput(contentStr, "unknown");
    }

    tokensSaved += Math.max(0, estimateTokens(contentStr) - estimateTokens(summary));
    result.push({
      ...msg,
      content: summary,
    });
  }

  return { messages: result, tokensSaved };
}

// ─── Pass 3: tool_call.arguments JSON 安全截断 ───

function truncateJsonValue(
  value: unknown,
  stringValueMaxChars: number,
): unknown {
  if (typeof value === "string") {
    if (value.length > stringValueMaxChars) {
      return value.slice(0, stringValueMaxChars) + `... [truncated, ${value.length} chars total]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => truncateJsonValue(item, stringValueMaxChars));
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = truncateJsonValue(val, stringValueMaxChars);
    }
    return result;
  }

  return value;
}

function pass3ArgsTruncation(
  messages: readonly Message[],
  enabled: boolean,
  maxChars: number,
  stringValueMaxChars: number,
): { readonly messages: readonly Message[]; readonly tokensSaved: number } {
  if (!enabled) return { messages, tokensSaved: 0 };

  let tokensSaved = 0;
  const result: Message[] = [];

  for (const msg of messages) {
    if (!isToolUse(msg)) {
      result.push(msg);
      continue;
    }

    const serialized = JSON.stringify(msg.input);
    if (serialized.length <= maxChars) {
      result.push(msg);
      continue;
    }

    try {
      const parsed = JSON.parse(serialized) as unknown;
      const truncated = truncateJsonValue(parsed, stringValueMaxChars);
      const reserialized = JSON.stringify(truncated);

      tokensSaved += estimateTokens(serialized) - estimateTokens(reserialized);
      result.push({
        ...msg,
        input: truncated as Record<string, unknown>,
      });
    } catch {
      result.push(msg);
    }
  }

  return { messages: result, tokensSaved };
}

// ─── 主函数 ───

export interface PrePruneResult {
  readonly messages: readonly Message[];
  readonly tokensSaved: number;
  readonly pass1TokensSaved: number;
  readonly pass2TokensSaved: number;
  readonly pass3TokensSaved: number;
}

export function prePruneToolResults(
  messages: readonly Message[],
  config?: PrePruneConfig,
): PrePruneResult {
  const cfg: Required<PrePruneConfig> = { ...DEFAULT_CONFIG, ...config };

  const pass1 = pass1Dedup(messages, cfg.dedupEnabled);
  const pass2 = pass2Summary(pass1.messages, cfg.summaryEnabled, cfg.summaryThresholdChars);
  const pass3 = pass3ArgsTruncation(
    pass2.messages,
    cfg.argsTruncationEnabled,
    cfg.argsTruncationMaxChars,
    cfg.argsStringValueMaxChars,
  );

  return {
    messages: pass3.messages,
    tokensSaved: pass1.tokensSaved + pass2.tokensSaved + pass3.tokensSaved,
    pass1TokensSaved: pass1.tokensSaved,
    pass2TokensSaved: pass2.tokensSaved,
    pass3TokensSaved: pass3.tokensSaved,
  };
}

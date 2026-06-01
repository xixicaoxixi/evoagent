/**
 * Continue / Terminal — Agentic Loop 循环控制类型。
 *
 * RULES_1-3: Discriminated Union（reason 字段区分）。
 * RULES_1-7: 穷举检查用 never 类型兜底。
 *
 * Continue: 循环继续的原因（上一轮为何不终止）
 * Terminal: 循环终止的原因
 */

import type { Message } from "../../types/message";
import type { TokenUsage } from "../../interfaces/llm-provider";

// ─── Continue（循环继续） ───

export interface ContinueNextTurn {
  readonly reason: "next_turn";
}

export interface ContinueReactiveCompact {
  readonly reason: "reactive_compact_retry";
}

export interface ContinueTokenBudget {
  readonly reason: "token_budget_continuation";
  readonly remainingTokens: number;
}

export interface ContinueMaxOutputRecovery {
  readonly reason: "max_output_tokens_recovery";
  readonly attempt: number;
}

export interface ContinueModelFallback {
  readonly reason: "model_fallback";
  readonly fromModel: string;
  readonly toModel: string;
}

export type Continue =
  | ContinueNextTurn
  | ContinueReactiveCompact
  | ContinueTokenBudget
  | ContinueMaxOutputRecovery
  | ContinueModelFallback;

// ─── Terminal（循环终止） ───

export interface TerminalCompleted {
  readonly reason: "completed";
  readonly messages: readonly Message[];
  readonly tokenUsage: TokenUsage;
}

export interface TerminalAborted {
  readonly reason: "aborted_streaming" | "aborted_tools" | "aborted_user" | "aborted_generation";
}

export interface TerminalMaxTurns {
  readonly reason: "max_turns";
  readonly turnCount: number;
  readonly messages: readonly Message[];
}

export interface TerminalModelError {
  readonly reason: "model_error";
  readonly error: unknown;
}

export interface TerminalPromptTooLong {
  readonly reason: "prompt_too_long";
  readonly tokenCount: number;
  readonly maxTokens: number;
}

export interface TerminalBudgetExceeded {
  readonly reason: "budget_exceeded";
  readonly totalTokens: number;
  readonly budget: number;
}

export interface TerminalToolError {
  readonly reason: "tool_error";
  readonly toolName: string;
  readonly error: string;
  readonly recoverable: boolean;
}

export interface TerminalPermissionDenied {
  readonly reason: "permission_denied";
  readonly toolName: string;
}

export interface TerminalTimeout {
  readonly reason: "timeout";
  readonly elapsedMs: number;
  readonly timeoutMs: number;
}

export interface TerminalContextOverflow {
  readonly reason: "context_overflow";
  readonly tokenCount: number;
  readonly maxTokens: number;
}

export type Terminal =
  | TerminalCompleted
  | TerminalAborted
  | TerminalMaxTurns
  | TerminalModelError
  | TerminalPromptTooLong
  | TerminalBudgetExceeded
  | TerminalToolError
  | TerminalPermissionDenied
  | TerminalTimeout
  | TerminalContextOverflow;

// ─── LoopResult（agentQueryLoop 最终返回） ───

export interface LoopResult {
  readonly terminal: Terminal;
  readonly totalTurns: number;
  readonly totalTokens: number;
  readonly messages: readonly Message[];
}

// ─── StreamEvent（循环过程中 yield 的事件） ───

export interface StreamEventContent {
  readonly type: "content";
  readonly content: string;
  readonly messageId?: string;
}

export interface StreamEventToolStart {
  readonly type: "tool_start";
  readonly toolName: string;
  readonly toolUseId: string;
  readonly input: Record<string, unknown>;
}

export interface StreamEventToolResult {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

export interface StreamEventToolProgress {
  readonly type: "tool_progress";
  readonly toolUseId: string;
  readonly progress: number;
  readonly message?: string;
}

export interface StreamEventTurnStart {
  readonly type: "turn_start";
  readonly turnCount: number;
}

export interface StreamEventTurnEnd {
  readonly type: "turn_end";
  readonly turnCount: number;
  readonly tokenUsage: TokenUsage;
}

export interface StreamEventError {
  readonly type: "error";
  readonly error: string;
  readonly recoverable: boolean;
}

export interface StreamEventToolError {
  readonly type: "tool_error";
  readonly toolName: string;
  readonly toolUseId: string;
  readonly errorCode?: string;
  readonly category: "timeout" | "cancellation" | "permission" | "validation" | "unknown";
  readonly message: string;
  readonly recoverable: boolean;
}

export interface StreamEventSteerInjected {
  readonly type: "steer_injected";
  readonly content: string;
}

export type StreamEvent =
  | StreamEventContent
  | StreamEventToolStart
  | StreamEventToolResult
  | StreamEventToolProgress
  | StreamEventToolError
  | StreamEventTurnStart
  | StreamEventTurnEnd
  | StreamEventError
  | StreamEventSteerInjected;

// ─── 工厂函数 ───

export function continueNextTurn(): Continue {
  return { reason: "next_turn" };
}

export function terminalCompleted(
  messages: readonly Message[],
  tokenUsage: TokenUsage,
): TerminalCompleted {
  return { reason: "completed", messages, tokenUsage };
}

export function terminalAborted(
  reason: TerminalAborted["reason"] = "aborted_user",
): TerminalAborted {
  return { reason };
}

export function terminalMaxTurns(
  turnCount: number,
  messages: readonly Message[],
): TerminalMaxTurns {
  return { reason: "max_turns", turnCount, messages };
}

export function terminalModelError(error: unknown): TerminalModelError {
  return { reason: "model_error", error };
}

export function terminalBudgetExceeded(
  totalTokens: number,
  budget: number,
): TerminalBudgetExceeded {
  return { reason: "budget_exceeded", totalTokens, budget };
}

export function terminalToolError(
  toolName: string,
  error: string,
  recoverable: boolean,
): TerminalToolError {
  return { reason: "tool_error", toolName, error, recoverable };
}

export function terminalPermissionDenied(toolName: string): TerminalPermissionDenied {
  return { reason: "permission_denied", toolName };
}

export function terminalTimeout(
  elapsedMs: number,
  timeoutMs: number,
): TerminalTimeout {
  return { reason: "timeout", elapsedMs, timeoutMs };
}

export function terminalContextOverflow(
  tokenCount: number,
  maxTokens: number,
): TerminalContextOverflow {
  return { reason: "context_overflow", tokenCount, maxTokens };
}

// ─── 类型守卫 ───

export function isTerminal(value: unknown): value is Terminal {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.reason === "string" && obj.reason !== "next_turn";
}

export function isCompletedTerminal(t: Terminal): t is TerminalCompleted {
  return t.reason === "completed";
}

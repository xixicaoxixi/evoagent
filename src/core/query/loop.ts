/**
 * agentQueryLoop — Agentic Loop 主循环骨架。
 *
 * RULES_1-6: 流式处理用 async function* + yield。
 * 基于通用 Agent 设计模式的 agentQueryLoop 设计（async generator + while(true)）。
 *
 * 核心流程：while(true) {
 *   1. 上下文准备（组装 system prompt + messages）
 *   2. 模型流式调用（收集 tool_use 块）
 *   3. 工具执行（并发调度 + 结果收集）
 *   4. 循环控制（maxTurns / tokenBudget / abort / completed）
 * }
 *
 * 阶段 A.2: 工具级错误隔离 — 错误即数据范式。
 * 工具错误作为 tool_result 消息加入历史，不终止循环（除超时/取消外），
 * 让模型自主决定恢复策略。
 */

import type { Message, AssistantMessage, ToolUseMessage, ToolResultMessage } from "../../types/message";
import type { Tool, ToolUseContext, CanUseToolFn } from "../../interfaces/tool";
import type { LLMProvider, LLMMessageParam, ToolDefinition } from "../../interfaces/llm-provider";
import { extractContentText } from "../../interfaces/llm-provider";
import type { LoopParams } from "./state";
import type { StreamEvent, Terminal } from "./types";
import { createLoopState, updateLoopState } from "./state";
import {
  continueNextTurn,
  terminalCompleted,
  terminalAborted,
  terminalMaxTurns,
  terminalModelError,
  terminalBudgetExceeded,
  terminalToolError,
} from "./types";
import { estimateTokens } from "../../types/common";
import { createPIISanitizer } from "../../observability/pii";
import { sanitizePath, truncateForLLM, shouldSanitizeForLLM } from "../../security/llm-sanitize";
import { classifyToolError, type ToolErrorCategory } from "../../tools/executor";
import { extractErrorMessage, truncateStack } from "../../utils/errors";
import { zodToJsonSchema, EMPTY_OBJECT_SCHEMA } from "../../utils/zod-json-schema";
import { createLogger, type Logger } from "../../observability/logger";
import { evaluateToolAccess, type PermissionChainConfig } from "../../tools/permission-chain";
import { INITIAL_REJECTION_COUNTER, type RejectionCounter } from "../../tools/rejection-counter";
import { isDenied, isAskUser } from "../../types/permission";
import { enforceToolOutputQuota } from "../../context/quota";
import { pruneOldTurns } from "../../context/prune";
import { prePruneToolResults } from "../../context/pre-prune";
import {
  partitionTools,
  createToolDiscoveryService,
  resolveEffectiveTools,
  type ToolDiscoveryService,
} from "../../tools/tool-discovery";
import { CallSignatureTracker, type DuplicateCheckResult } from "../../tools/security/loop-detector";
import { containsUnexecutedToolCalls } from "../../utils/tool-call-detector";

const piiSanitizer = createPIISanitizer();

const loopLogger: Logger = createLogger({ source: "query:loop" });

const MAX_LLM_RESPONSE_CHARS = 1_000_000;

// ─── agentQueryLoop ───

export async function* agentQueryLoop(
  params: LoopParams,
): AsyncGenerator<StreamEvent, Terminal> {
  let state = createLoopState(params);

  const { eagerTools, onDemandTools } = partitionTools(params.tools);
  const discoveryService = params.discoveryService ?? createToolDiscoveryService(onDemandTools);

  while (true) {
    const { messages, turnCount, abortSignal, budgetRemaining } = state;

    const effectiveTools = resolveEffectiveTools(eagerTools, discoveryService);

    const toolIndex = buildToolIndex(effectiveTools, discoveryService);

    if (abortSignal?.aborted) {
      return terminalAborted("aborted_user");
    }

    if (state.steerControl !== undefined && state.steerControl.generation !== state.initialGeneration) {
      return terminalAborted("aborted_generation");
    }

    yield { type: "turn_start", turnCount };

    let effectiveMessages = messages;
    if (params.quotaConfig || params.pruneConfig || params.prePruneConfig) {
      if (params.quotaConfig) {
        const quotaResult = enforceToolOutputQuota(messages, params.quotaConfig);
        effectiveMessages = quotaResult.messages;
      }
      if (params.prePruneConfig) {
        const prePruneResult = prePruneToolResults(effectiveMessages, params.prePruneConfig);
        effectiveMessages = prePruneResult.messages;
      }
      if (params.pruneConfig) {
        const pruneResult = pruneOldTurns(effectiveMessages, params.pruneConfig);
        effectiveMessages = pruneResult.messages;
      }
    }

    const llmMessages = assembleLLMMessages(
      params.systemPrompt,
      params.appendSystemPrompt,
      effectiveMessages,
      params.provider.model,
    );

    const estimatedInputTokens = estimateLLMMessagesTokens(llmMessages);
    const outputReserve = Math.min(4000, Math.max(500, Math.floor(state.budgetTotal * 0.1)));
    if (budgetRemaining < outputReserve) {
      return terminalBudgetExceeded(
        state.totalInputTokens + state.totalOutputTokens,
        state.budgetTotal,
      );
    }

    const assistantMessages: Message[] = [];
    const toolUseBlocks: ToolUseMessage[] = [];
    let currentAssistantContent = "";
    let currentThinkingContent = "";
    let currentAssistantTokenUsage: { inputTokens: number; outputTokens: number } | undefined;
    let responseTruncated = false;

    const toolDefinitions = convertToolsToDefinitions(effectiveTools);

    try {
      for await (const chunk of params.provider.stream(llmMessages, {
        tools: toolDefinitions,
        ...(params.maxTokens != null ? { maxTokens: params.maxTokens } : {}),
      })) {
        if (abortSignal?.aborted) {
          return terminalAborted("aborted_streaming");
        }

        if (chunk.type === "thinking") {
          if (!responseTruncated) {
            currentThinkingContent += chunk.content;
          }
        }

        if (chunk.type === "content") {
          if (!responseTruncated && currentAssistantContent.length + chunk.content.length <= MAX_LLM_RESPONSE_CHARS) {
            currentAssistantContent += chunk.content;
            yield { type: "content", content: chunk.content };
          } else if (!responseTruncated) {
            const remaining = MAX_LLM_RESPONSE_CHARS - currentAssistantContent.length;
            if (remaining > 0) {
              const truncated = chunk.content.slice(0, remaining);
              currentAssistantContent += truncated;
              yield { type: "content", content: truncated };
            }
            responseTruncated = true;
            yield { type: "error", error: `LLM response truncated at ${MAX_LLM_RESPONSE_CHARS} chars`, recoverable: true };
          }
        }

        if (chunk.type === "tool_use") {
          const toolUseMsg: ToolUseMessage = {
            id: `tool-${chunk.toolUseId}`,
            role: "tool_use",
            timestamp: Date.now(),
            toolName: chunk.toolName,
            toolUseId: chunk.toolUseId,
            input: chunk.input,
          };
          toolUseBlocks.push(toolUseMsg);
        }

        if (chunk.type === "stop") {
          currentAssistantTokenUsage = chunk.tokenUsage;
          if (chunk.tokenUsage) {
            state = updateLoopState(state, {
              totalInputTokens: state.totalInputTokens + (chunk.tokenUsage.inputTokens ?? 0),
              totalOutputTokens: state.totalOutputTokens + (chunk.tokenUsage.outputTokens ?? 0),
              budgetRemaining: state.budgetRemaining - (chunk.tokenUsage.outputTokens ?? 0),
            });
          }
        }

        if (chunk.type === "error") {
          const statusCode = extractStreamErrorStatusCode(chunk.error);
          const isUnrecoverable = statusCode !== undefined && (statusCode === 401 || statusCode === 403);
          if (isUnrecoverable) {
            return terminalModelError(new Error(chunk.error));
          }
          yield { type: "error", error: chunk.error, recoverable: true };
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.constructor.name : "UnknownError";
      const structuredError = {
        type: errorName,
        message: errorMessage,
        ...(error instanceof Error && error.stack ? { stack: truncateStack(error, 3) } : {}),
      };
      loopLogger.error(`Model error: ${errorMessage}`);
      return terminalModelError(structuredError);
    }

    if (!currentAssistantContent && currentThinkingContent) {
      loopLogger.info(`No regular content but thinking content found, using thinking content`, {
        thinkingContentLength: currentThinkingContent.length,
        thinkingContentPreview: currentThinkingContent.slice(0, 200),
      });
      currentAssistantContent = currentThinkingContent;
      yield { type: "content", content: currentThinkingContent };
    }

    if (toolUseBlocks.length === 0 && currentAssistantContent) {
      const { cleanedContent, toolCalls } = parseTextBasedToolCalls(currentAssistantContent, toolIndex);
      if (toolCalls.length > 0) {
        loopLogger.info(`Text-based tool call parser detected ${toolCalls.length} tool call(s)`, {
          toolNames: toolCalls.map((tc) => tc.toolName),
          contentLength: currentAssistantContent.length,
          cleanedLength: cleanedContent.length,
        });
        currentAssistantContent = cleanedContent;
        toolUseBlocks.push(...toolCalls);
      } else if (containsUnexecutedToolCalls(
        [{ role: "assistant", content: currentAssistantContent }],
        { registeredToolNames: new Set(toolIndex.keys()) },
      )) {
        loopLogger.warn("Tool call text detected but parser could not extract structured calls", {
          contentPreview: currentAssistantContent.slice(0, 500),
          registeredTools: [...toolIndex.keys()],
        });
      }
    }

    loopLogger.info(`After LLM response processing`, {
      turnCount,
      toolUseBlocksCount: toolUseBlocks.length,
      assistantContentLength: currentAssistantContent.length,
      thinkingContentLength: currentThinkingContent.length,
      assistantContentPreview: currentAssistantContent.slice(0, 200),
    });

    if (currentAssistantContent || toolUseBlocks.length > 0) {
      const assistantMsg: AssistantMessage = {
        id: `assistant-${state.turnCount}-${Date.now()}`,
        role: "assistant",
        timestamp: Date.now(),
        content: currentAssistantContent || `[Calling ${toolUseBlocks.length} tool(s)]`,
        stopReason: toolUseBlocks.length > 0 ? "tool_use" : "end_turn",
        ...(currentAssistantTokenUsage !== undefined ? { tokenUsage: currentAssistantTokenUsage } : {}),
      };
      assistantMessages.push(assistantMsg);
    }

    const completedMessages = [...messages, ...assistantMessages];

    if (toolUseBlocks.length === 0) {
      if (!currentAssistantContent && currentAssistantTokenUsage?.outputTokens === 0) {
        yield { type: "error", error: "LLM returned empty response with zero output tokens", recoverable: false };
      }
      yield {
        type: "turn_end",
        turnCount,
        tokenUsage: {
          inputTokens: currentAssistantTokenUsage?.inputTokens ?? 0,
          outputTokens: currentAssistantTokenUsage?.outputTokens ?? 0,
        },
      };
      return terminalCompleted(completedMessages, {
        inputTokens: state.totalInputTokens,
        outputTokens: state.totalOutputTokens,
      });
    }

    const toolResults: ToolResultMessage[] = [];
    let hasUnrecoverableError = false;

    const signatureTracker = new CallSignatureTracker();

    const resolvedCalls = await resolveAndCheckPermissions(
      toolUseBlocks,
      toolIndex,
      discoveryService,
      params,
      state.rejectionCounter,
    );

    loopLogger.info(`Tool resolution results`, {
      totalCalls: resolvedCalls.length,
      errors: resolvedCalls.map((rc) => ({ toolName: rc.toolUse.toolName, error: rc.error, hasTool: rc.tool !== undefined })),
    });

    let updatedRejectionCounter = state.rejectionCounter;
    for (const rc of resolvedCalls) {
      if (rc.permissionResult?.updatedRejectionCounter !== undefined) {
        updatedRejectionCounter = rc.permissionResult.updatedRejectionCounter;
      }
    }
    if (updatedRejectionCounter !== state.rejectionCounter) {
      state = updateLoopState(state, { rejectionCounter: updatedRejectionCounter });
    }

    for (const rc of resolvedCalls) {
      yield {
        type: "tool_start",
        toolName: rc.toolUse.toolName,
        toolUseId: rc.toolUse.toolUseId,
        input: rc.toolUse.input,
      };

      if (rc.error === "unknown_tool") {
        yield* handleToolError(
          rc.toolUse,
          `Unknown tool: ${rc.toolUse.toolName}`,
          "UNKNOWN_TOOL",
          "unknown",
          true,
          toolResults,
        );
        continue;
      }

      if (rc.error === "permission_denied") {
        yield* handleToolError(
          rc.toolUse,
          rc.permissionResult?.reason ?? `Permission denied: Tool use not allowed`,
          "PERMISSION_DENIED",
          "permission",
          true,
          toolResults,
        );
        continue;
      }

      const validation = validateToolCallInput(rc.toolUse.toolName, rc.toolUse.input as Record<string, unknown>);
      if (!validation.valid) {
        yield* handleToolError(
          rc.toolUse,
          `Parameter validation failed: ${validation.error}. Please correct your tool call and try again.`,
          "VALIDATION_FAILED",
          "validation",
          true,
          toolResults,
        );
        continue;
      }
    }

    const executableCalls = resolvedCalls.filter(
      (rc) => rc.error === undefined && rc.tool !== undefined,
    );

    const parallelCalls = executableCalls.filter(
      (rc) => rc.tool!.isConcurrencySafe(rc.toolUse.input),
    );
    const sequentialCalls = executableCalls.filter(
      (rc) => !rc.tool!.isConcurrencySafe(rc.toolUse.input),
    );

    if (parallelCalls.length > 0) {
      const parallelResults = await Promise.allSettled(
        parallelCalls.map((rc) => {
          const dupCheck = signatureTracker.checkAndRecord(
            rc.toolUse.toolName,
            rc.toolUse.input,
            rc.tool!.isReadOnly(rc.toolUse.input),
          );
          return executeToolCall(rc, params, dupCheck);
        }),
      );

      for (let i = 0; i < parallelCalls.length; i++) {
        const rc = parallelCalls[i]!;
        const settled = parallelResults[i]!;

        if (settled.status === "fulfilled") {
          const resultMsg = settled.value;
          toolResults.push(resultMsg);
          yield {
            type: "tool_result",
            toolUseId: rc.toolUse.toolUseId,
            content: resultMsg.content,
            isError: resultMsg.isError,
          };
        } else {
          const errorCategory = classifyToolError(settled.reason);
          const isRecoverable = errorCategory !== "timeout" && errorCategory !== "cancellation";
          const safeMessage = extractErrorMessage(settled.reason);
          const stack = truncateStack(settled.reason, 3);
          const errorContent = stack ? `${safeMessage}\n\nStack trace:\n${stack}` : safeMessage;
          const errorCode = errorCategory === "timeout" ? "TIMEOUT" : errorCategory === "cancellation" ? "CANCELLED" : "TOOL_ERROR";

          yield* handleToolError(
            rc.toolUse,
            errorContent,
            errorCode,
            errorCategory,
            isRecoverable,
            toolResults,
          );

          if (!isRecoverable) {
            hasUnrecoverableError = true;
          }
        }
      }
    }

    for (const rc of sequentialCalls) {
      if (hasUnrecoverableError) break;

      const dupCheck = signatureTracker.checkAndRecord(
        rc.toolUse.toolName,
        rc.toolUse.input,
        rc.tool!.isReadOnly(rc.toolUse.input),
      );

      try {
        const resultMsg = await executeToolCall(rc, params, dupCheck);
        toolResults.push(resultMsg);
        yield {
          type: "tool_result",
          toolUseId: rc.toolUse.toolUseId,
          content: resultMsg.content,
          isError: resultMsg.isError,
        };
      } catch (error) {
        const errorCategory = classifyToolError(error);
        const isRecoverable = errorCategory !== "timeout" && errorCategory !== "cancellation";
        const safeMessage = extractErrorMessage(error);
        const stack = truncateStack(error, 3);
        const errorContent = stack ? `${safeMessage}\n\nStack trace:\n${stack}` : safeMessage;
        const errorCode = errorCategory === "timeout" ? "TIMEOUT" : errorCategory === "cancellation" ? "CANCELLED" : "TOOL_ERROR";

        yield* handleToolError(
          rc.toolUse,
          errorContent,
          errorCode,
          errorCategory,
          isRecoverable,
          toolResults,
        );

        if (!isRecoverable) {
          hasUnrecoverableError = true;
        }
      }
    }

    if (hasUnrecoverableError) {
      yield { type: "turn_end", turnCount, tokenUsage: { inputTokens: currentAssistantTokenUsage?.inputTokens ?? 0, outputTokens: currentAssistantTokenUsage?.outputTokens ?? 0 } };
      return terminalToolError("unknown", "Unrecoverable tool error", false);
    }

    loopLogger.info(`Tool execution summary`, {
      parallelCount: parallelCalls.length,
      sequentialCount: sequentialCalls.length,
      toolResultCount: toolResults.length,
      toolResultPreviews: toolResults.map((tr) => ({
        toolUseId: tr.toolUseId,
        isError: tr.isError,
        contentLength: tr.content.length,
        contentPreview: tr.content.slice(0, 200),
      })),
    });

    const newMessages = [...messages, ...assistantMessages, ...toolResults];

    if (state.steerControl?.pendingSteer !== null && state.steerControl !== undefined) {
      const steerText = state.steerControl.pendingSteer;
      state.steerControl.pendingSteer = null;

      const steerMessage: Message = {
        id: `steer-${state.turnCount}-${Date.now()}`,
        role: "user",
        content: steerText,
        timestamp: Date.now(),
      };
      newMessages.push(steerMessage);

      yield { type: "steer_injected", content: steerText };
    }

    const nextTurnCount = turnCount + 1;

    if (params.maxTurns > 0 && nextTurnCount > params.maxTurns) {
      yield { type: "turn_end", turnCount, tokenUsage: { inputTokens: currentAssistantTokenUsage?.inputTokens ?? 0, outputTokens: currentAssistantTokenUsage?.outputTokens ?? 0 } };
      return terminalMaxTurns(turnCount, newMessages);
    }

    state = updateLoopState(state, {
      messages: newMessages,
      turnCount: nextTurnCount,
      transition: continueNextTurn(),
    });

    yield { type: "turn_end", turnCount, tokenUsage: { inputTokens: currentAssistantTokenUsage?.inputTokens ?? 0, outputTokens: currentAssistantTokenUsage?.outputTokens ?? 0 } };
  }
}

// ─── 辅助函数 ───

function* handleToolError(
  toolUse: ToolUseMessage,
  errorContent: string,
  errorCode: string,
  category: ToolErrorCategory,
  recoverable: boolean,
  toolResults: ToolResultMessage[],
): Generator<StreamEvent, void> {
  const errorMsg: ToolResultMessage = {
    id: `result-${toolUse.toolUseId}`,
    role: "tool_result",
    timestamp: Date.now(),
    toolUseId: toolUse.toolUseId,
    content: errorContent,
    isError: true,
  };
  toolResults.push(errorMsg);
  yield { type: "tool_result", toolUseId: toolUse.toolUseId, content: errorMsg.content, isError: true };
  yield {
    type: "tool_error",
    toolName: toolUse.toolName,
    toolUseId: toolUse.toolUseId,
    errorCode,
    category,
    message: errorContent,
    recoverable,
  };
}

function buildToolIndex(
  tools: ReadonlyArray<Tool>,
  discoveryService: ToolDiscoveryService,
): Map<string, Tool> {
  const index = new Map<string, Tool>();
  for (const tool of tools) {
    index.set(tool.name, tool);
  }
  for (const tool of discoveryService.getDiscoveredTools()) {
    index.set(tool.name, tool);
  }
  return index;
}

interface ResolvedToolCall {
  readonly toolUse: ToolUseMessage;
  readonly tool: Tool | undefined;
  readonly error: "unknown_tool" | "permission_denied" | undefined;
  readonly permissionResult: ToolPermissionCheckResult | undefined;
}

async function resolveAndCheckPermissions(
  toolUseBlocks: readonly ToolUseMessage[],
  toolIndex: Map<string, Tool>,
  discoveryService: ToolDiscoveryService,
  params: LoopParams,
  currentRejectionCounter: RejectionCounter | undefined,
): Promise<ResolvedToolCall[]> {
  const results: ResolvedToolCall[] = [];

  for (const toolUse of toolUseBlocks) {
    let tool = toolIndex.get(toolUse.toolName);

    if (!tool) {
      const discoveredTool = discoveryService.discover(toolUse.toolName);
      if (discoveredTool) {
        discoveryService.markDiscovered(toolUse.toolName);
        toolIndex.set(toolUse.toolName, discoveredTool);
        tool = discoveredTool;
      }
    }

    if (!tool) {
      results.push({ toolUse, tool: undefined, error: "unknown_tool", permissionResult: undefined });
      continue;
    }

    const permissionResult = await checkToolPermissionSync(
      tool,
      toolUse,
      params,
      currentRejectionCounter,
    );

    if (permissionResult.denied) {
      results.push({ toolUse, tool, error: "permission_denied", permissionResult });
      continue;
    }

    results.push({ toolUse, tool, error: undefined, permissionResult });
  }

  return results;
}

async function checkToolPermissionSync(
  tool: Tool,
  toolUse: ToolUseMessage,
  params: LoopParams,
  currentRejectionCounter: RejectionCounter | undefined,
): Promise<ToolPermissionCheckResult> {
  if (params.canUseTool) {
    const permission = await tool.checkPermissions(toolUse.input, params.toolUseContext);
    if (permission.behavior === "deny") {
      return { denied: true, reason: "Permission denied: Tool use not allowed" };
    }
    if (!params.canUseTool(permission)) {
      return { denied: true, reason: "Permission denied: Tool use not allowed" };
    }
  }

  return { denied: false };
}

export function validateToolCallInput(
  toolName: string,
  input: Record<string, unknown>,
): { valid: boolean; error?: string } {
  switch (toolName) {
    case "file_write":
      if (!input.file_path || typeof input.file_path !== "string" || input.file_path.trim() === "") {
        return { valid: false, error: "file_path is required and must be non-empty" };
      }
      if (input.content === undefined || input.content === null) {
        return { valid: false, error: "content is required for file_write" };
      }
      break;
    case "file_read":
      if (!input.file_path || typeof input.file_path !== "string" || input.file_path.trim() === "") {
        return { valid: false, error: "file_path is required and must be non-empty" };
      }
      break;
    case "file_edit":
      if (!input.file_path || typeof input.file_path !== "string" || input.file_path.trim() === "") {
        return { valid: false, error: "file_path is required and must be non-empty" };
      }
      if (!input.old_str || typeof input.old_str !== "string") {
        return { valid: false, error: "old_str is required for file_edit" };
      }
      if (!input.new_str || typeof input.new_str !== "string") {
        return { valid: false, error: "new_str is required for file_edit" };
      }
      break;
    case "bash":
      if (!input.command || typeof input.command !== "string" || input.command.trim() === "") {
        return { valid: false, error: "command is required and must be non-empty" };
      }
      break;
    case "glob":
      if (!input.pattern || typeof input.pattern !== "string" || input.pattern.trim() === "") {
        return { valid: false, error: "pattern is required and must be non-empty" };
      }
      break;
  }
  return { valid: true };
}

// ─── Tool → ToolDefinition 转换 ───

function convertToolsToDefinitions(tools: readonly Tool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: zodToJsonSchema(tool.inputSchema),
  }));
}

// ─── 文本工具调用解析 ───

function parseXmlAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const name = m[1];
    if (name) attrs[name] = m[2] ?? m[3] ?? "";
  }
  return attrs;
}

function parseXmlChildren(body: string): Record<string, string> {
  const children: Record<string, string> = {};
  const re = /<([\w-]+)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    if (name) children[name] = m[2]?.trim() ?? "";
  }
  return children;
}

const DSML_SEP = "\uff5c\uff5c";
const DSML_OPEN_PREFIX = `<${DSML_SEP}DSML${DSML_SEP}`;
const DSML_CLOSE_PREFIX = `</${DSML_SEP}DSML${DSML_SEP}`;

const DSML_TOOL_CALLS_RE = new RegExp(
  `${escapeRegExp(DSML_OPEN_PREFIX)}tool_calls>([\\s\\S]*?)${escapeRegExp(DSML_CLOSE_PREFIX)}tool_calls>`,
  "g",
);

const DSML_INVOKE_RE = new RegExp(
  `${escapeRegExp(DSML_OPEN_PREFIX)}invoke\\s+name="([^"]+)">([\\s\\S]*?)${escapeRegExp(DSML_CLOSE_PREFIX)}invoke>`,
  "g",
);

const DSML_PARAMETER_RE = new RegExp(
  `${escapeRegExp(DSML_OPEN_PREFIX)}parameter\\s+name="([^"]+)"(?:\\s+string="[^"]*")?>([\\s\\S]*?)${escapeRegExp(DSML_CLOSE_PREFIX)}parameter>`,
  "g",
);

function parseDsmlToolCalls(
  content: string,
  toolIndex: Map<string, Tool>,
  tryAdd: (name: string, input: Record<string, unknown>) => boolean,
): string {
  let cleaned = content;
  let dsmlFound = false;

  let dsmlInvokeCount = 0;

  cleaned = cleaned.replace(DSML_TOOL_CALLS_RE, (_match, blockBody: string) => {
    dsmlFound = true;
    const invokeResults: string[] = [];

    let invokeMatch: RegExpExecArray | null;
    const invokeRe = new RegExp(DSML_INVOKE_RE.source, DSML_INVOKE_RE.flags);
    while ((invokeMatch = invokeRe.exec(blockBody)) !== null) {
      const toolName = invokeMatch[1];
      const invokeBody = invokeMatch[2] ?? "";
      if (!toolName || !toolIndex.has(toolName)) {
        invokeResults.push(invokeMatch[0]);
        continue;
      }

      const params: Record<string, unknown> = {};
      let paramMatch: RegExpExecArray | null;
      const paramRe = new RegExp(DSML_PARAMETER_RE.source, DSML_PARAMETER_RE.flags);
      while ((paramMatch = paramRe.exec(invokeBody)) !== null) {
        const paramName = paramMatch[1];
        const paramValue = paramMatch[2];
        if (paramName) {
          params[paramName] = paramValue ?? "";
        }
      }

      if (tryAdd(toolName, params)) {
        dsmlInvokeCount++;
        invokeResults.push("");
      } else {
        invokeResults.push(invokeMatch[0]);
      }
    }

    return invokeResults.join("");
  });

  if (dsmlFound) {
    loopLogger.info(`DSML tool call parser detected tool calls`, {
      dsmlInvokeCount,
    });
  }

  return cleaned;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseKwargsStyle(argsStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\w+))/g;
  let m;
  while ((m = re.exec(argsStr)) !== null) {
    const name = m[1];
    if (name) {
      const value = m[2] ?? m[3] ?? m[4] ?? "";
      result[name] = value;
    }
  }
  return result;
}

export function parseTextBasedToolCalls(
  content: string,
  toolIndex: Map<string, Tool>,
): { cleanedContent: string; toolCalls: ToolUseMessage[] } {
  const toolCalls: ToolUseMessage[] = [];
  let cleaned = content;
  let callIdx = 0;

  function makeId(): string {
    return `text-tool-${Date.now()}-${callIdx++}`;
  }

  function tryAdd(name: string, input: Record<string, unknown>): boolean {
    if (!toolIndex.has(name)) return false;
    const id = makeId();
    toolCalls.push({
      id: `tool-${id}`,
      role: "tool_use",
      timestamp: Date.now(),
      toolName: name,
      toolUseId: id,
      input,
    });
    return true;
  }

  cleaned = parseDsmlToolCalls(cleaned, toolIndex, tryAdd);

  // file_write: self-closing <file_write path="..." content="..." />
  cleaned = cleaned.replace(
    /<file_write\s+([^>]*?)\s*\/>/gs,
    (match, attrs: string) => {
      const p = parseXmlAttrs(attrs);
      return tryAdd("file_write", {
        file_path: p.path ?? p.file_path ?? "",
        content: p.content ?? "",
      })
        ? ""
        : match;
    },
  );

  // file_write: with attributes + body <file_write path="..." content="...">body</file_write>
  cleaned = cleaned.replace(
    /<file_write\s+([^>]*?)>([\s\S]*?)<\/file_write>/g,
    (match, attrs: string, body: string) => {
      const p = parseXmlAttrs(attrs);
      const c = parseXmlChildren(body);
      const content = p.content ?? c.content ?? body.trim();
      return tryAdd("file_write", {
        file_path: p.path ?? p.file_path ?? c.path ?? c.file_path ?? "",
        content,
      })
        ? ""
        : match;
    },
  );

  // file_write: child elements only <file_write>...<path>...</path><content>...</content></file_write>
  cleaned = cleaned.replace(
    /<file_write>([\s\S]*?)<\/file_write>/g,
    (match, body: string) => {
      const c = parseXmlChildren(body);
      return tryAdd("file_write", {
        file_path: c.path ?? c.file_path ?? "",
        content: c.content ?? "",
      })
        ? ""
        : match;
    },
  );

  // bash: <bash>command</bash>
  cleaned = cleaned.replace(
    /<bash>([\s\S]*?)<\/bash>/g,
    (match, cmd: string) =>
      tryAdd("bash", { command: cmd.trim() }) ? "" : match,
  );

  // bash: ```bash\ncommand\n```
  cleaned = cleaned.replace(
    /```bash\s*\n([\s\S]*?)\n```/g,
    (match, cmd: string) =>
      tryAdd("bash", { command: cmd.trim() }) ? "" : match,
  );

  // file_read: self-closing <file_read path="..." />
  cleaned = cleaned.replace(
    /<file_read\s+([^>]*?)\s*\/>/gs,
    (match, attrs: string) => {
      const p = parseXmlAttrs(attrs);
      return tryAdd("file_read", {
        file_path: p.path ?? p.file_path ?? "",
      })
        ? ""
        : match;
    },
  );

  // file_read: child elements <file_read>...<path>...</path></file_read>
  cleaned = cleaned.replace(
    /<file_read>([\s\S]*?)<\/file_read>/g,
    (match, body: string) => {
      const c = parseXmlChildren(body);
      return tryAdd("file_read", {
        file_path: c.path ?? c.file_path ?? "",
      })
        ? ""
        : match;
    },
  );

  // file_edit: self-closing <file_edit file_path="..." old_str="..." new_str="..." />
  cleaned = cleaned.replace(
    /<file_edit\s+([^>]*?)\s*\/>/gs,
    (match, attrs: string) => {
      const p = parseXmlAttrs(attrs);
      return tryAdd("file_edit", {
        file_path: p.file_path ?? p.path ?? "",
        old_str: p.old_str ?? "",
        new_str: p.new_str ?? "",
        ...(p.replace_all !== undefined ? { replace_all: p.replace_all === "true" } : {}),
      })
        ? ""
        : match;
    },
  );

  // file_edit: child elements
  cleaned = cleaned.replace(
    /<file_edit>([\s\S]*?)<\/file_edit>/g,
    (match, body: string) => {
      const c = parseXmlChildren(body);
      return tryAdd("file_edit", {
        file_path: c.file_path ?? c.path ?? "",
        old_str: c.old_str ?? "",
        new_str: c.new_str ?? "",
      })
        ? ""
        : match;
    },
  );

  // glob: self-closing <glob pattern="..." path="..." />
  cleaned = cleaned.replace(
    /<glob\s+([^>]*?)\s*\/>/gs,
    (match, attrs: string) => {
      const p = parseXmlAttrs(attrs);
      return tryAdd("glob", {
        pattern: p.pattern ?? "",
        ...(p.path ? { path: p.path } : {}),
      })
        ? ""
        : match;
    },
  );

  // glob: child elements
  cleaned = cleaned.replace(
    /<glob>([\s\S]*?)<\/glob>/g,
    (match, body: string) => {
      const c = parseXmlChildren(body);
      return tryAdd("glob", {
        pattern: c.pattern ?? "",
        ...(c.path ? { path: c.path } : {}),
      })
        ? ""
        : match;
    },
  );

  // <execute> wrapper: <execute><command>tool_name args</command></execute>
  cleaned = cleaned.replace(
    /<execute>\s*<command>\s*(\w+)([\s\S]*?)<\/command>\s*<\/execute>/g,
    (match, toolName: string, argsStr: string) => {
      if (!toolIndex.has(toolName)) return match;
      const trimmedArgs = argsStr.trim();
      if (trimmedArgs.length === 0) return match;
      const p = parseXmlAttrs(trimmedArgs);
      if (Object.keys(p).length > 0) {
        return tryAdd(toolName, p) ? "" : match;
      }
      const c = parseXmlChildren(trimmedArgs);
      if (Object.keys(c).length > 0) {
        return tryAdd(toolName, c) ? "" : match;
      }
      const kwInput = parseKwargsStyle(trimmedArgs);
      if (Object.keys(kwInput).length > 0) {
        return tryAdd(toolName, kwInput) ? "" : match;
      }
      if (toolName === "bash") {
        return tryAdd("bash", { command: trimmedArgs }) ? "" : match;
      }
      return match;
    },
  );

  // JSON format tool calls in markdown code blocks (supports both objects and arrays)
  cleaned = cleaned.replace(
    /```json\s*\n([\[{][\s\S]*?[}\]])\s*\n```/g,
    (match, jsonStr: string) => {
      try {
        const parsed = JSON.parse(jsonStr) as unknown;

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          const toolName = obj.tool ?? obj.name ?? obj.function;
          if (typeof toolName === "string" && toolIndex.has(toolName)) {
            const input = (obj.input ?? obj.arguments ?? obj.params ?? {}) as Record<string, unknown>;
            return tryAdd(toolName, input) ? "" : match;
          }
        }

        if (Array.isArray(parsed)) {
          let recognizedCount = 0;
          for (const item of parsed) {
            if (item && typeof item === "object" && !Array.isArray(item)) {
              const obj = item as Record<string, unknown>;
              const toolName = obj.tool ?? obj.name ?? obj.function;
              if (typeof toolName === "string" && toolIndex.has(toolName)) {
                const input = (obj.input ?? obj.arguments ?? obj.params ?? {}) as Record<string, unknown>;
                if (tryAdd(toolName, input)) {
                  recognizedCount++;
                }
              }
            }
          }
          return recognizedCount === parsed.length && recognizedCount > 0 ? "" : match;
        }
      } catch { /* ignore parse errors */ }
      return match;
    },
  );

  // Function call style: tool_name(key="value", key2="value2")
  const knownToolNames = [...toolIndex.keys()].map(escapeRegExp).join("|");
  if (knownToolNames.length > 0) {
    const funcCallRe = new RegExp(
      `\\b(${knownToolNames})\\s*\\(\\s*([\\s\\S]*?)\\s*\\)`,
      "g",
    );
    cleaned = cleaned.replace(funcCallRe, (match, toolName: string, argsStr: string) => {
      if (!toolIndex.has(toolName)) return match;
      const input = parseKwargsStyle(argsStr);
      return Object.keys(input).length > 0 && tryAdd(toolName, input) ? "" : match;
    });
  }

  // Natural language intent + code block joint matching (fallback)
  if (toolCalls.length === 0 && knownToolNames.length > 0) {
    const nlIntentCodeBlockRe = new RegExp(
      String.raw`(?:I(?:'ll| will| need to)|let me|now I(?:'ll| will)?)\s+`
      + String.raw`(?:use|call|invoke|write|create|run|execute)\s+`
      + String.raw`(?:the\s+)?(\w+)\s+`
      + String.raw`(?:tool\s+)?(?:to\s+)?`
      + String.raw`.*?`
      + String.raw`(?:path|file_path|file|to)\s*[:=]\s*["']?([^\s"']+)["']?`
      + String.raw`.*?`
      + "`{3}(?:\\w*)\\n([\\s\\S]*?)\\n`{3}",
      "is",
    );

    cleaned = cleaned.replace(nlIntentCodeBlockRe, (fullMatch, toolName: string, filePath: string, codeContent: string) => {
      if (!toolIndex.has(toolName)) return fullMatch;
      const input: Record<string, unknown> = toolName === "file_write"
        ? { file_path: filePath, content: codeContent }
        : toolName === "file_read"
          ? { file_path: filePath }
          : toolName === "bash"
            ? { command: codeContent }
            : { file_path: filePath };
      return tryAdd(toolName, input) ? "" : fullMatch;
    });
  }

  return { cleanedContent: cleaned.trim(), toolCalls };
}

async function executeToolCall(
  rc: ResolvedToolCall,
  params: LoopParams,
  duplicateCheck: DuplicateCheckResult = { isDuplicate: false },
): Promise<ToolResultMessage> {
  const tool = rc.tool!;
  const toolUse = rc.toolUse;

  const toolPromise = tool.call(
    toolUse.input,
    params.toolUseContext,
    params.canUseTool,
  );

  const timeoutMs = params.toolTimeoutMs ?? 300_000;
  const result = await Promise.race([
    toolPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool '${toolUse.toolName}' timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);

  let content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);

  if (duplicateCheck.isDuplicate) {
    content = `${duplicateCheck.message}\n\n${content}`;
  }

  return {
    id: `result-${toolUse.toolUseId}`,
    role: "tool_result",
    timestamp: Date.now(),
    toolUseId: toolUse.toolUseId,
    content,
    isError: result.isError,
  };
}

function assembleLLMMessages(
  systemPrompt: string,
  appendSystemPrompt: string | undefined,
  messages: readonly Message[],
  model: string,
): LLMMessageParam[] {
  const result: LLMMessageParam[] = [];
  const needsSanitization = shouldSanitizeForLLM(model);

  const fullSystemPrompt = appendSystemPrompt
    ? `${systemPrompt}\n\n${appendSystemPrompt}`
    : systemPrompt;
  if (fullSystemPrompt) {
    result.push({ role: "system", content: fullSystemPrompt });
  }

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
      case "assistant": {
        const sanitized = piiSanitizer.sanitize(msg.content);
        const content = needsSanitization
          ? sanitizePath(sanitized.sanitized)
          : sanitized.sanitized;
        result.push({ role: msg.role, content });
        break;
      }
      case "tool_result": {
        const sanitized = piiSanitizer.sanitize(msg.content);
        let content = sanitized.sanitized;
        if (needsSanitization) {
          content = sanitizePath(content);
          content = truncateForLLM(content);
        }
        result.push({
          role: "tool_result",
          content: "",
          toolUseId: msg.toolUseId,
          toolResultContent: content,
          isToolError: msg.isError,
        });
        break;
      }
      case "tool_use": {
        let inputStr = JSON.stringify(msg.input);
        if (needsSanitization) {
          inputStr = sanitizePath(inputStr);
        }
        let parsedInput = msg.input;
        if (needsSanitization && inputStr !== JSON.stringify(msg.input)) {
          try {
            parsedInput = JSON.parse(inputStr) as Record<string, unknown>;
          } catch {
            parsedInput = msg.input;
          }
        }
        result.push({
          role: "tool_use",
          content: "",
          toolUseId: msg.toolUseId,
          toolName: msg.toolName,
          toolInput: parsedInput,
        });
        break;
      }
      case "system":
        result.push({ role: "system", content: msg.content });
        break;
    }
  }

  return result;
}

function estimateLLMMessagesTokens(messages: LLMMessageParam[]): number {
  return messages.reduce(
    (sum, msg) => {
      const text = extractContentText(msg.content);
      const toolText = msg.toolName
        ? `${msg.toolName} ${JSON.stringify(msg.toolInput ?? {})}`
        : "";
      const resultText = msg.toolResultContent ?? "";
      return sum + estimateTokens(text + toolText + resultText);
    },
    0,
  );
}

// ─── S1: 权限检查辅助函数 ───

const STREAM_ERROR_STATUS_RE = /\((\d{3})\)/;

function extractStreamErrorStatusCode(errorMessage: string): number | undefined {
  const match = STREAM_ERROR_STATUS_RE.exec(errorMessage);
  const digits = match?.[1];
  if (digits === undefined) return undefined;
  const code = Number.parseInt(digits, 10);
  return Number.isFinite(code) ? code : undefined;
}

interface ToolPermissionCheckResult {
  readonly denied: boolean;
  readonly reason?: string;
  readonly updatedRejectionCounter?: RejectionCounter;
}

async function checkToolPermission(
  tool: Tool,
  toolUse: ToolUseMessage,
  params: LoopParams,
  currentRejectionCounter: RejectionCounter | undefined,
): Promise<ToolPermissionCheckResult> {
  if (params.permissionChainConfig) {
    const configWithCounter: PermissionChainConfig = {
      ...params.permissionChainConfig,
      rejectionCounter: currentRejectionCounter ?? INITIAL_REJECTION_COUNTER,
    };

    const chainResult = await evaluateToolAccess(
      toolUse.toolName,
      toolUse.input as Record<string, unknown>,
      tool,
      params.toolUseContext,
      configWithCounter,
    );

    const denied = isDenied(chainResult.result) || isAskUser(chainResult.result);
    const reason = isDenied(chainResult.result)
      ? chainResult.result.reason
      : isAskUser(chainResult.result)
        ? chainResult.result.reason ?? "User confirmation required"
        : undefined;

    return {
      denied,
      ...(reason !== undefined ? { reason } : {}),
      ...(chainResult.updatedRejectionCounter !== undefined
        ? { updatedRejectionCounter: chainResult.updatedRejectionCounter }
        : {}),
    };
  }

  if (params.canUseTool) {
    const permission = await tool.checkPermissions(toolUse.input, params.toolUseContext);
    if (!params.canUseTool(permission)) {
      return { denied: true, reason: "Permission denied: Tool use not allowed" };
    }
  }

  return { denied: false };
}

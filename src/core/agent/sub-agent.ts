/**
 * SubAgent — PPAF 循环（Perceive → Plan → Act → Reflect）。
 *
 * SubAgent 是由主 Agent 通过 AgentTool 派生的子 Agent。
 * 每个 SubAgent 拥有独立的 agentQueryLoop、工具集和上下文。
 *
 * 阶段 B.4: 集成 AgentModeContext — SubAgent 接受 modeContext，
 *   在工具权限检查前先经过 Plan 模式硬权限检查。
 */

import type { Message, ToolResultMessage } from "../../types/message";
import type { Tool, ToolUseContext, CanUseToolFn } from "../../interfaces/tool";
import type { LLMProvider, TokenUsage } from "../../interfaces/llm-provider";
import type { StreamEvent, Terminal } from "../query/types";
import { isCompletedTerminal } from "../query/types";
import type { LoopParams } from "../query/state";
import { agentQueryLoop } from "../query/loop";
import { assemblePrompt, type PromptConfig } from "../query/prompt";
import { filterToolsForAgent, type AgentRole, ToolUseAuditor } from "./tool-filter";
import type { PermissionResult } from "../../types/permission";
import type { AgentModeContext } from "../../types/mode";
import { checkPlanModePermission } from "./plan-mode";
import { EvoAgentError } from "../../utils/errors";
import { createLogger } from "../../observability/logger";
import { containsUnexecutedToolCalls } from "../../utils/tool-call-detector";

// ─── SubAgent 配置 ───

export interface SubAgentConfig {
  readonly agentId: string;
  readonly taskId: string;
  readonly parentAgentId: string;

  readonly systemPrompt: string;

  readonly tools: ReadonlyArray<Tool>;

  readonly provider: LLMProvider;

  readonly canUseTool: CanUseToolFn;

  readonly toolUseContext: ToolUseContext;

  readonly role?: AgentRole;

  readonly auditor?: ToolUseAuditor;

  readonly maxTurns?: number;

  readonly tokenBudget?: number;

  readonly abortSignal?: AbortSignal;

  readonly taskType?: string;

  /** B.4: Agent 模式上下文（用于 Plan 模式硬权限检查） */
  readonly modeContext?: AgentModeContext;

  /** H1: 是否为子 Agent（子 Agent 禁止进入 Plan 模式） */
  readonly isSubAgent?: boolean;
}

// ─── SubAgent 状态 ───

export interface SubAgentState {
  readonly agentId: string;
  readonly taskId: string;
  readonly status: "created" | "running" | "completed" | "failed";
  readonly messages: readonly Message[];
  readonly totalTokens: number;
  readonly tokenUsage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly result: unknown;
  readonly error?: { readonly reason: string; readonly details?: unknown };
  readonly degradedMode?: boolean;
}

// ─── SubAgent ───

export class SubAgent {
  private readonly config: SubAgentConfig;
  private readonly effectiveTools: ReadonlyArray<Tool>;
  private readonly internalAbortController: AbortController;
  private readonly logger = createLogger({ source: "sub-agent" });
  private state: SubAgentState;

  constructor(config: SubAgentConfig) {
    this.config = config;

    this.internalAbortController = new AbortController();

    if (config.abortSignal !== undefined) {
      if (config.abortSignal.aborted) {
        this.internalAbortController.abort();
      } else {
        config.abortSignal.addEventListener("abort", () => {
          this.internalAbortController.abort();
        }, { once: true });
      }
    }

    this.effectiveTools = config.role
      ? filterToolsForAgent(config.tools, { role: config.role }).tools
      : config.tools;

    this.state = {
      agentId: config.agentId,
      taskId: config.taskId,
      status: "created",
      messages: [],
      totalTokens: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      result: undefined,
    };
  }

  /**
   * 运行 SubAgent（PPAF 循环）。
   *
   * B.4: 工具权限检查前先经过 Plan 模式硬权限检查。
   *
   * @param taskDescription - 任务描述
   * @yields StreamEvent - 流式事件
   * @returns Terminal - 循环终止原因
   */
  async *run(
    taskDescription: string,
  ): AsyncGenerator<StreamEvent, Terminal> {
    this.state = {
      ...this.state,
      status: "running",
      messages: [
        {
          id: `msg-${Date.now()}`,
          role: "user",
          content: taskDescription,
          timestamp: Date.now(),
        },
      ],
    };

    // 组装 Prompt
    const promptConfig: PromptConfig = {
      baseSystemPrompt: this.config.systemPrompt,
      tools: this.effectiveTools,
      instanceInfo: {
        model: this.config.provider.model,
        currentDate: new Date().toISOString().split("T")[0]!,
      },
    };
    const assembled = assemblePrompt(promptConfig);

    const loopParams = {
      messages: this.state.messages,
      systemPrompt: assembled.systemPrompt,
      tools: this.effectiveTools,
      provider: this.config.provider,
      canUseTool: (permission: PermissionResult) => {
        const toolName = permission.behavior === "allow"
          ? (permission as { behavior: "allow"; updatedInput?: Record<string, unknown> }).updatedInput?.toolName as string | undefined
          : undefined;
        const allowed = this.config.canUseTool(permission);
        if (toolName) {
          this.config.auditor?.record({
            agentId: this.config.agentId,
            toolName,
            timestamp: Date.now(),
            allowed,
            ...(this.config.role ? { role: this.config.role } : {}),
          });
        }
        return allowed;
      },
      toolUseContext: this.config.toolUseContext,
      maxTurns: this.config.maxTurns ?? 20,
      tokenBudget: this.config.tokenBudget ?? 50000,
      abortSignal: this.internalAbortController.signal,
    };

    const terminal = yield* agentQueryLoop(loopParams);

    const terminalTokenUsage = isCompletedTerminal(terminal)
      ? { inputTokens: terminal.tokenUsage.inputTokens, outputTokens: terminal.tokenUsage.outputTokens }
      : { inputTokens: 0, outputTokens: 0 };

    this.logger.info("SubAgent loop terminated", {
      agentId: this.config.agentId,
      taskId: this.config.taskId,
      terminalReason: terminal.reason,
      inputTokens: terminalTokenUsage.inputTokens,
      outputTokens: terminalTokenUsage.outputTokens,
      messageCount: isCompletedTerminal(terminal) ? terminal.messages.length : this.state.messages.length,
      toolCount: this.effectiveTools.length,
      tokenBudget: this.config.tokenBudget ?? 50000,
      maxTurns: this.config.maxTurns ?? 20,
    });

    const failedReasons: readonly string[] = ["model_error", "budget_exceeded", "aborted_streaming", "aborted_tools", "aborted_user", "aborted_generation", "prompt_too_long", "context_overflow", "timeout"];

    if (isCompletedTerminal(terminal)) {
      const result = extractFinalResult(terminal.messages);
      const isEmptyResult = result === null || result === undefined || (typeof result === "string" && result.trim().length === 0);
      if (containsUnexecutedToolCalls(terminal.messages, { registeredToolNames: new Set(this.effectiveTools.map(t => t.name)) })) {
        this.state = {
          ...this.state,
          status: "failed",
          messages: terminal.messages,
          result: null,
          tokenUsage: terminalTokenUsage,
          error: { reason: "tool_calls_not_executed", details: { terminalReason: "completed", hint: "LLM generated tool call text but tools were not actually invoked" } },
        };
      } else if (isEmptyResult && terminal.tokenUsage.outputTokens === 0) {
        this.state = {
          ...this.state,
          status: "failed",
          messages: terminal.messages,
          result: null,
          tokenUsage: terminalTokenUsage,
          error: { reason: "empty_output", details: { terminalReason: "completed", outputTokens: 0 } },
        };
      } else {
        const hasToolUseMessages = terminal.messages.some(
          (m) => m.role === "tool_use",
        );
        const toolCount = this.effectiveTools.length;
        const outputTokens = terminal.tokenUsage.outputTokens;
        const dynamicThreshold = Math.max(500, Math.min(toolCount * 150, 1500));

        const taskRequiresTools = this.config.taskType !== "reasoning"
          && this.config.taskType !== "analysis"
          && this.config.taskType !== "summary";

        const isLowOutput = outputTokens < dynamicThreshold;

        if (!hasToolUseMessages && isLowOutput && toolCount > 0 && taskRequiresTools) {
          const assistantText = terminal.messages
            .filter((m): m is Message & { role: "assistant"; content: string } => m.role === "assistant" && typeof m.content === "string")
            .map((m) => m.content)
            .join("\n");
          const codeBlocks = extractCodeBlocksFromText(assistantText);

          if (codeBlocks.length > 0) {
            this.state = {
              ...this.state,
              status: "completed",
              messages: terminal.messages,
              result: codeBlocks.map((b, i) => `[Code Block ${i + 1} (${b.language})]:\n${b.code}`).join("\n\n"),
              tokenUsage: terminalTokenUsage,
              degradedMode: true,
            };
          } else {
            this.state = {
              ...this.state,
              status: "failed",
              messages: terminal.messages,
              result: null,
              tokenUsage: terminalTokenUsage,
              error: {
                reason: "no_tool_execution",
                details: {
                  terminalReason: "completed",
                  hint: "Agent completed without calling any tool and produced minimal output",
                  outputTokens,
                  dynamicThreshold,
                  toolCount,
                  taskType: this.config.taskType ?? "default",
                  retryable: true,
                  retryContext: {
                    hint: "Model did not produce any tool calls. Consider injecting format examples.",
                    toolNames: this.effectiveTools.map((t) => t.name),
                    outputTokens,
                  },
                },
              },
            };
          }
        } else {
          const effectiveResult = isEmptyResult
            ? (extractToolExecutionSummary(terminal.messages) ?? result)
            : result;
          this.state = {
            ...this.state,
            status: "completed",
            messages: terminal.messages,
            result: effectiveResult,
            tokenUsage: terminalTokenUsage,
          };
        }
      }
    } else if (failedReasons.includes(terminal.reason)) {
      this.state = {
        ...this.state,
        status: "failed",
        messages: this.state.messages,
        tokenUsage: terminalTokenUsage,
        error: {
          reason: terminal.reason,
          details: terminal.reason === "model_error"
            ? extractModelErrorDetails((terminal as { readonly error?: unknown }).error)
            : terminal.reason === "budget_exceeded"
              ? { totalTokens: (terminal as { readonly totalTokens?: number }).totalTokens, budget: (terminal as { readonly budget?: number }).budget }
              : undefined,
        },
      };
    } else {
      this.state = {
        ...this.state,
        status: "failed",
        messages: this.state.messages,
        tokenUsage: terminalTokenUsage,
        error: { reason: terminal.reason },
      };
    }

    return terminal;
  }

  /**
   * B.4: 检查工具是否被 Plan 模式限制。
   *
   * 在工具执行前调用，如果被限制则返回 deny 结果。
   */
  checkModePermission(toolName: string): PermissionResult {
    if (!this.config.modeContext) {
      return { behavior: "allow" };
    }
    return checkPlanModePermission(this.config.modeContext, toolName);
  }

  /**
   * H1: 子 Agent 禁止进入 Plan 模式。
   *
   * 当子 Agent 尝试调用 activatePlanPhase 时抛出 EvoAgentError。
   * 这确保安全约束不可被绕过。
   */
  activatePlanPhase(): never {
    throw new EvoAgentError(
      "Sub-agents cannot enter Plan mode. Plan mode is restricted to the root agent only.",
      "SUBAGENT_PLAN_MODE_BLOCKED",
      {
        context: {
          agentId: this.config.agentId,
          parentAgentId: this.config.parentAgentId,
        },
      },
    );
  }

  /** H1: 检查是否为子 Agent */
  get isSubAgent(): boolean {
    return this.config.isSubAgent ?? true;
  }

  /** 获取当前状态 */
  getState(): SubAgentState {
    return this.state;
  }

  /** 获取角色 */
  getRole(): AgentRole | undefined {
    return this.config.role;
  }

  /** 获取有效工具列表 */
  getEffectiveTools(): readonly Tool[] {
    return this.effectiveTools;
  }

  /** 获取模式上下文 */
  getModeContext(): AgentModeContext | undefined {
    return this.config.modeContext;
  }

  /** 中止 SubAgent */
  abort(): void {
    this.internalAbortController.abort();
  }

  /** 获取任务类型 */
  get taskType(): string | undefined {
    return this.config.taskType;
  }

  static buildRetryFormatHint(tools: ReadonlyArray<Tool>): string {
    const toolNames = tools.map(t => t.name).join(", ");
    return `\n\n**YOU MUST USE TOOLS NOW.** Your previous attempt failed because you described tool calls instead of executing them.\n\nAvailable tools: ${toolNames}\n\nTo call a tool, output ONLY the XML tag. Example:\n<file_write file_path="/example/path.txt" content="example content" />\n<file_read file_path="/example/path.txt" />\n<bash>echo hello</bash>\n\nDo not explain. Do not describe. Output the XML tag directly.`;
  }
}

// ─── 辅助函数 ───

const TOOL_CALL_PLACEHOLDER_RE = /^\[Calling \d+ tool\(s\)\]$/;

const TOOL_INPUT_DETAIL_MAX_LEN = 120;

function formatToolInputDetail(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "file_write": {
      const p = String(input.path ?? input.file_path ?? "?");
      const c = input.content;
      const len = typeof c === "string" ? c.length : 0;
      return `path=${p}, ${len} chars`;
    }
    case "file_read": {
      const p = String(input.path ?? input.file_path ?? "?");
      return `path=${p}`;
    }
    case "file_edit": {
      const p = String(input.file_path ?? "?");
      const nLen = typeof input.new_str === "string" ? input.new_str.length : 0;
      return `path=${p}, replaced ${nLen} chars`;
    }
    case "bash": {
      const cmd = String(input.command ?? "?");
      return cmd.length > TOOL_INPUT_DETAIL_MAX_LEN
        ? `command=${cmd.slice(0, TOOL_INPUT_DETAIL_MAX_LEN)}...`
        : `command=${cmd}`;
    }
    case "glob": {
      return `pattern=${input.pattern ?? "?"}`;
    }
    default: {
      const keys = Object.keys(input);
      return keys.length > 0 ? keys.join(", ") : "";
    }
  }
}

function extractToolExecutionSummary(messages: readonly Message[]): string | null {
  const summaries: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "tool_use") continue;
    const detail = formatToolInputDetail(msg.toolName, msg.input);
    const resultMsg = messages.find(
      (m) => m.role === "tool_result" && m.toolUseId === msg.toolUseId,
    ) as ToolResultMessage | undefined;
    const status = resultMsg
      ? (resultMsg.isError ? "ERROR" : "OK")
      : "NO_RESULT";
    summaries.push(detail ? `${msg.toolName}(${detail}) → ${status}` : `${msg.toolName} → ${status}`);
  }
  return summaries.length > 0 ? summaries.join("\n") : null;
}

function extractFinalResult(messages: readonly Message[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && typeof msg.content === "string") {
      if (msg.content.trim().length > 0 && !TOOL_CALL_PLACEHOLDER_RE.test(msg.content)) {
        return msg.content;
      }
    }
  }

  const assistantParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && typeof msg.content === "string") {
      const trimmed = msg.content.trim();
      if (trimmed.length > 0 && !TOOL_CALL_PLACEHOLDER_RE.test(trimmed)) {
        assistantParts.push(trimmed);
      }
    }
  }
  if (assistantParts.length > 0) {
    const joined = assistantParts.join("\n\n");
    return joined.length > 100_000 ? joined.slice(0, 100_000) : joined;
  }

  const toolExecSummary = extractToolExecutionSummary(messages);
  if (toolExecSummary) {
    return toolExecSummary;
  }

  const toolResults: string[] = [];
  for (const msg of messages) {
    if (msg.role === "tool_result" && typeof msg.content === "string" && msg.content.trim().length > 0) {
      toolResults.push(msg.content.slice(0, 2000));
    }
  }
  if (toolResults.length > 0) {
    return toolResults.join("\n---\n");
  }

  return null;
}

function extractModelErrorDetails(error: unknown): Record<string, unknown> {
  if (error === null || error === undefined) {
    return { type: "unknown", message: "No error details available" };
  }
  if (typeof error === "object" && !Array.isArray(error)) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string" || typeof obj.type === "string") {
      return {
        type: typeof obj.type === "string" ? obj.type : "structured_error",
        message: typeof obj.message === "string" ? obj.message : JSON.stringify(error),
        ...(typeof obj.stack === "string" ? { stack: obj.stack } : {}),
        ...(typeof obj.httpStatus === "number" ? { httpStatus: obj.httpStatus } : {}),
        ...(typeof obj.errorCode === "string" ? { errorCode: obj.errorCode } : {}),
      };
    }
    try {
      return { type: "serialized", message: JSON.stringify(error) };
    } catch {
      return { type: "object", message: String(error) };
    }
  }
  if (error instanceof Error) {
    return {
      type: error.constructor.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack.split("\n").slice(0, 4).join("\n") } : {}),
    };
  }
  return { type: typeof error, message: String(error) };
}

export function extractCodeBlocksFromText(text: string): Array<{ language: string; code: string }> {
  const codeBlockRe = /```(\w*)\n([\s\S]*?)\n```/g;
  const blocks: Array<{ language: string; code: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = codeBlockRe.exec(text)) !== null) {
    blocks.push({ language: m[1] ?? "", code: m[2]! });
  }
  return blocks;
}

/**
 * 创建 SubAgent 实例。
 */
export function createSubAgent(config: SubAgentConfig): SubAgent {
  return new SubAgent(config);
}

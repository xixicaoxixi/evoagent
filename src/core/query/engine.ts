/**
 * QueryEngine — 会话级封装 + 依赖注入 + Prompt 组装。
 *
 * 基于通用 Agent 设计模式的 QueryEngine 设计。
 * 封装 agentQueryLoop，提供会话管理和消息历史。
 */

import type { Message, UserMessage } from "../../types/message";
import type { Tool, ToolUseContext, CanUseToolFn } from "../../interfaces/tool";
import type { LLMProvider, TokenUsage, LLMMessageParam } from "../../interfaces/llm-provider";
import { extractContentText } from "../../interfaces/llm-provider";
import type { StreamEvent, Terminal } from "./types";
import type { BudgetConfig } from "./budget";
import type { SteerControl } from "./state";
import { agentQueryLoop } from "./loop";
import { assemblePrompt, type PromptConfig } from "./prompt";
import { createBudgetTracker, checkBudget } from "./budget";
import { normalizeUnicodeForSafety } from "../../security/external-content";
import { filterToolsForAgent } from "../agent/tool-filter";
import type { PlanModeManager, ExecutionPlanResult } from "../agent/plan-mode";

// ─── QueryEngine 配置 ───

export interface QueryEngineConfig {
  /** 工作目录 */
  readonly cwd?: string;

  /** 可用工具 */
  readonly tools: ReadonlyArray<Tool>;

  /** LLM Provider */
  readonly provider: LLMProvider;

  /** 备用 Provider */
  readonly fallbackProvider?: LLMProvider;

  /** 权限检查回调 */
  readonly canUseTool: CanUseToolFn;

  /** 核心系统提示 */
  readonly baseSystemPrompt: string;

  /** 追加系统提示 */
  readonly appendSystemPrompt?: string;

  /** 记忆提示 */
  readonly memoryPrompt?: string;

  /** 用户上下文 */
  readonly userContext?: string;

  /** 最大轮次 */
  readonly maxTurns?: number;

  /** Token 预算 */
  readonly tokenBudget?: number;

  /** 预算配置 */
  readonly budgetConfig?: BudgetConfig;

  /** 工具调用上下文 */
  readonly toolUseContext?: ToolUseContext;

  /** AbortSignal */
  readonly abortSignal?: AbortSignal;

  readonly planMode?: boolean;

  readonly planModeManager?: PlanModeManager;

  /** Step 9: SteerControl 引用（提供时启用 steer 注入和代际检查） */
  readonly steerControl?: SteerControl;

  /** 调用级 maxTokens 覆盖（提供时传递给 provider.stream()） */
  readonly maxTokens?: number;
}

// ─── QueryEngine ───

export class QueryEngine {
  private readonly config: QueryEngineConfig;
  private messages: Message[] = [];
  private totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(config: QueryEngineConfig) {
    this.config = config;
  }

  /**
   * 提交用户消息，启动 Agentic Loop。
   *
   * @param prompt - 用户输入
   * @yields StreamEvent - 流式事件
   * @returns Terminal - 循环终止原因
   */
  async *submitMessage(
    prompt: string,
    options?: { readonly maxTokens?: number },
  ): AsyncGenerator<StreamEvent, Terminal> {
    const effectiveMaxTokens = options?.maxTokens ?? this.config.maxTokens;

    // A.4: 对用户输入进行 Unicode 净化
    const sanitizedPrompt = normalizeUnicodeForSafety(prompt);

    // 添加用户消息
    const userMessage: UserMessage = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: sanitizedPrompt,
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);

    // 组装 Prompt
    const promptConfig: PromptConfig = {
      baseSystemPrompt: this.config.baseSystemPrompt,
      ...(this.config.memoryPrompt ? { memoryPrompt: this.config.memoryPrompt } : {}),
      ...(this.config.appendSystemPrompt ? { appendSystemPrompt: this.config.appendSystemPrompt } : {}),
      ...(this.config.userContext ? { userContext: this.config.userContext } : {}),
      tools: this.config.tools,
      instanceInfo: {
        model: this.config.provider.model,
        currentDate: new Date().toISOString().split("T")[0]!,
      },
    };
    const assembled = assemblePrompt(promptConfig);

    // Plan Mode: 过滤为只读工具
    const planManager = this.config.planModeManager;
    const isPlanMode = this.config.planMode || (planManager?.isActive ?? false);
    const effectiveTools = isPlanMode
      ? planManager
        ? planManager.getReadonlyTools(this.config.tools)
        : filterToolsForAgent(this.config.tools, { planMode: true }).tools
      : this.config.tools;

    // 注入上下文消息
    const messagesWithPrompt: Message[] = [];
    if (assembled.userContextMessage) {
      messagesWithPrompt.push({
        id: `ctx-${Date.now()}`,
        role: "user",
        content: extractContentText(assembled.userContextMessage.content),
        timestamp: Date.now(),
      });
    }
    if (assembled.systemInitMessage) {
      messagesWithPrompt.push({
        id: `init-${Date.now()}`,
        role: "user",
        content: extractContentText(assembled.systemInitMessage.content),
        timestamp: Date.now(),
      });
    }
    messagesWithPrompt.push(...this.messages);

    // 预算检查
    const budgetConfig = this.config.budgetConfig ?? {
      totalBudget: this.config.tokenBudget ?? 100000,
    };
    const budget = createBudgetTracker(budgetConfig);
    const budgetCheck = checkBudget(budget, 0, budgetConfig);
    if (!budgetCheck.canProceed) {
      const { terminalBudgetExceeded } = await import("./types");
      return terminalBudgetExceeded(0, budgetConfig.totalBudget);
    }

    const loopParams = {
      messages: messagesWithPrompt,
      systemPrompt: assembled.systemPrompt,
      ...(this.config.appendSystemPrompt ? { appendSystemPrompt: this.config.appendSystemPrompt } : {}),
      tools: effectiveTools,
      provider: this.config.provider,
      canUseTool: this.config.canUseTool,
      toolUseContext: this.config.toolUseContext ?? {
        ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
        getAppState: () => ({}),
      },
      maxTurns: this.config.maxTurns ?? 50,
      tokenBudget: budgetConfig.totalBudget,
      ...(this.config.fallbackProvider?.model ? { fallbackModel: this.config.fallbackProvider.model } : {}),
      ...(this.config.abortSignal ? { abortSignal: this.config.abortSignal } : {}),
      ...(this.config.steerControl ? { steerControl: this.config.steerControl } : {}),
      ...(effectiveMaxTokens != null ? { maxTokens: effectiveMaxTokens } : {}),
    };

    // 运行 agentQueryLoop
    const terminal = yield* agentQueryLoop(loopParams);

    // 更新消息历史
    if (terminal.reason === "completed") {
      this.messages.push(...terminal.messages.slice(this.messages.length));
    }

    return terminal;
  }

  /** 获取消息历史 */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /** 获取 Token 使用统计 */
  getTotalUsage(): TokenUsage {
    return this.totalUsage;
  }

  /**
   * 清空会话。
   *
   * @deprecated Use resetContext() instead. This method will be removed in a future version.
   */
  clear(): void {
    this.messages = [];
    this.totalUsage = { inputTokens: 0, outputTokens: 0 };
  }

  /** 重置上下文（清空消息历史和 token 统计） */
  resetContext(): void {
    this.messages = [];
    this.totalUsage = { inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * 创建 QueryEngine 实例。
 */
export function createQueryEngine(
  config: QueryEngineConfig,
): QueryEngine {
  return new QueryEngine(config);
}

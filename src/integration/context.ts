/**
 * EvoAgentContext — 统一上下文容器。
 *
 * 持有所有高级模块实例，作为集成层连接：
 * - QueryEngine（单 Agent 循环）
 * - Orchestrator（多 Agent 编排）
 * - EvolutionEngine（自动进化）
 * - Communication 层（Gateway + Critic + Consensus + Reputation + Community + Marketplace + Analytics）
 * - Observability 层（Logger + StatsStore + CostTracker + ProgressTracker）
 *
 * 设计原则：
 * - 接口+注册表：先定义接口，再通过工厂函数创建实现
 * - 依赖注入：所有模块通过构造参数注入
 * - 单一职责：本文件只负责组装，不实现业务逻辑
 */

import type { LLMProvider } from "../interfaces/llm-provider";
import type { Tool, ToolUseContext, CanUseToolFn } from "../interfaces/tool";
import type { QueryEngine } from "../core/query/engine";
import type { StreamEvent, Terminal } from "../core/query/types";
import { terminalCompleted, terminalToolError, terminalAborted } from "../core/query/types";
import type { Orchestrator, SubTaskProgressCallback } from "../core/agent/orchestrator";
import type { ExecutionPlan, PlanDiagnostics, PlannedSubTask } from "../core/agent/task-planner";
import type { ExecutionTrace } from "../core/agent/orchestrator";
import type { EvolutionEngine, EvolutionEngineState, TaskCompletedInput } from "../evolution/engine";
import type { RuleStore } from "../evolution/rule-store";
import type { Gateway, MessageHandleResult, GatewayStats } from "../communication/gateway";
import type { PeerInfo, PeerMessage } from "../communication/protocol";
import type { Critic, ExternalKnowledge, ProcessingResult } from "../communication/critic";
import type { ConsensusEngine, ConsensusScore } from "../communication/consensus";
import type { ReputationSystem, ReputationData, ReputationTier } from "../communication/reputation";
import type { Community, GovernanceProposal, VoteResult } from "../communication/community";
import type { Marketplace, MarketItem, MarketItemType, MarketItemStatus, MarketSearchOptions } from "../communication/marketplace";
import type { Analytics, AnalyticsSummary, TrendDataPoint } from "../communication/analytics";
import type { Logger } from "../observability/logger";
import type { StatsStore } from "../observability/reservoir";
import type { CostTracker, ModelUsage } from "../observability/cost-tracker";
import type { ProgressTrackerData, AgentProgress } from "../observability/progress";
import { createMessageSummary, createProviderSummary, createRequestId, type ChatDiagnosticSummary } from "../observability/chat-diagnostics";
import { createLLMAdapter } from "../llm/adapter";
import { createMemoryExtractor } from "../knowledge/memory-extractor";
import type { GeneratedTool } from "../evolution/tool-generator";
import { createToolFromGenerated, canRegisterTool } from "../evolution/tool-generator";
import type { Message, ToolResultMessage, ToolUseMessage } from "../types/message";

export interface ChatResult {
  readonly response: string;
  readonly terminal: Terminal;
  readonly tokensUsed: { inputTokens: number; outputTokens: number };
  readonly agentCount: number;
  readonly evolutionTriggered: boolean;
  readonly durationMs: number;
  readonly diagnostic?: ChatDiagnosticSummary;
  readonly partial?: boolean;
  readonly partialReason?: string;
}

export interface ComplexChatResult extends ChatResult {
  readonly plan: ExecutionPlan;
  readonly planDiagnostics: PlanDiagnostics;
  readonly successCount: number;
  readonly agentStates: readonly {
    readonly agentId: string;
    readonly taskId: string;
    readonly status: "created" | "running" | "completed" | "failed";
    readonly result: unknown;
    readonly tokenUsage: { readonly inputTokens: number; readonly outputTokens: number };
    readonly error?: { readonly reason: string; readonly details?: unknown };
    readonly toolCallSummary?: string;
  }[];
  readonly executionTrace?: ExecutionTrace;
}

export type TaskComplexity = "simple" | "moderate" | "complex";

import type { KnowledgeManager } from "../knowledge/knowledge-manager";
import type { KnowledgeStore } from "../server/routes/knowledge";
import { createKnowledgeFacade } from "../knowledge/knowledge-facade";
import type { MemoryEntry } from "../knowledge/memory-types";
import type { DreamingResult } from "../knowledge/dreaming";
import type { ForgettingResult } from "../knowledge/forgetting";

export interface EvoAgentContext {
  readonly provider: LLMProvider;
  readonly tools: ReadonlyArray<Tool>;

  getEngine(): QueryEngine;
  getOrchestrator(): Orchestrator;
  getEvolutionEngine(): EvolutionEngine;
  getRuleStore(): RuleStore;
  getKnowledgeManager(): KnowledgeManager;
  getKnowledgeFacade(): KnowledgeStore;
  getLogger(): Logger;
  getStatsStore(): StatsStore;
  getCostTracker(): CostTracker;
  getProgressTracker(): ProgressTrackerData;
  getGateway(): Gateway;
  getCritic(): Critic;
  getConsensusEngine(): ConsensusEngine;
  getReputationSystem(): ReputationSystem;
  getCommunity(): Community;
  getMarketplace(): Marketplace;
  getAnalytics(): Analytics;

  chat(message: string, signal?: AbortSignal, options?: { readonly maxTokens?: number }): Promise<ChatResult>;
  chatComplex(message: string, subTasks: readonly string[], signal?: AbortSignal, onProgress?: import("../core/agent/orchestrator").SubTaskProgressCallback): Promise<ComplexChatResult>;

  recordTaskCompletion(input: TaskCompletedInput): Promise<void>;
  recordCost(model: string, usage: ModelUsage): void;
  getEvolutionState(): EvolutionEngineState;
  getProgress(): AgentProgress;
  gracefulShutdown(timeoutMs?: number): Promise<void>;
}

export interface CommunicationModules {
  readonly gateway?: Gateway;
  readonly critic?: Critic;
  readonly consensusEngine?: ConsensusEngine;
  readonly reputationSystem?: ReputationSystem;
  readonly community?: Community;
  readonly marketplace?: Marketplace;
  readonly analytics?: Analytics;
}

export interface EvoAgentContextConfig {
  readonly provider: LLMProvider;
  readonly tools: ReadonlyArray<Tool>;
  readonly canUseTool: CanUseToolFn;
  readonly toolUseContext?: ToolUseContext;
  readonly baseSystemPrompt?: string;
  readonly logger?: Logger;
  readonly communication?: CommunicationModules;
}

export async function createEvoAgentContext(
  config: EvoAgentContextConfig,
): Promise<EvoAgentContext> {

  function isWorthExtracting(text: string): boolean {
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/gu) ?? []).length;
    const cjkRatio = text.length > 0 ? cjkCount / text.length : 0;
    if (cjkRatio > 0.3) {
      return text.length > 30;
    }
    const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
    return wordCount > 8 || text.length > 200;
  }

  const criticalImports = Promise.all([
    import("../core/query/engine").then((m) => m.createQueryEngine),
    import("../core/agent/orchestrator").then((m) => m.createOrchestrator),
    import("../evolution/engine").then((m) => m.createEvolutionEngine),
    import("../evolution/rule-store").then((m) => m.createJSONLRuleStore),
    import("../observability/logger").then((m) => m.createLogger),
    import("../observability/reservoir").then((m) => m.createStatsStore),
    import("../observability/cost-tracker").then((m) => m.createCostTracker),
    import("../observability/progress").then((m) => ({ createProgressTracker: m.createProgressTracker, getProgressUpdate: m.getProgressUpdate, updateProgressFromStreamEvent: m.updateProgressFromStreamEvent, recordToolCall: m.recordToolCall })),
    import("../knowledge/knowledge-manager").then((m) => ({ createKnowledgeManager: m.createKnowledgeManager, createJSONLMemoryStore: m.createJSONLMemoryStore })),
  ]);

  const nonCriticalImports = Promise.allSettled([
    import("../communication/gateway").then((m) => m.createGateway),
    import("../communication/critic").then((m) => m.createCritic),
    import("../communication/consensus").then((m) => m.createConsensusEngine),
    import("../communication/reputation").then((m) => m.createReputationSystem),
    import("../communication/community").then((m) => m.createCommunity),
    import("../communication/marketplace").then((m) => m.createMarketplace),
    import("../communication/analytics").then((m) => m.createAnalytics),
  ]);

  const [
    [createQueryEngine, createOrchestrator, createEvolutionEngine, createJSONLRuleStore, createLogger, createStatsStore, createCostTracker, progressModule, knowledgeModule],
    nonCriticalResults,
  ] = await Promise.all([criticalImports, nonCriticalImports]);

  function getNonCritical<T>(index: number, fallback: T): T {
    const result = nonCriticalResults[index];
    if (result !== undefined && result.status === "fulfilled") {
      return result.value as T;
    }
    return fallback;
  }

  const logger = config.logger ?? createLogger({ source: "evoagent" });
  const statsStore = createStatsStore();
  const costTracker = createCostTracker();
  const progressTracker = progressModule.createProgressTracker();
  const ruleStore = createJSONLRuleStore();

  const createGatewayFn = getNonCritical<(() => Gateway) | null>(0, null);
  const createCriticFn = getNonCritical<((config?: { llmProvider?: unknown }) => Critic) | null>(1, null);
  const createConsensusEngineFn = getNonCritical<(() => ConsensusEngine) | null>(2, null);
  const createReputationSystemFn = getNonCritical<(() => ReputationSystem) | null>(3, null);
  const createCommunityFn = getNonCritical<(() => Community) | null>(4, null);
  const createMarketplaceFn = getNonCritical<(() => Marketplace) | null>(5, null);
  const createAnalyticsFn = getNonCritical<(() => Analytics) | null>(6, null);

  const gateway = config.communication?.gateway ?? (createGatewayFn ? createGatewayFn() : createNoopGateway());
  const llmAdapter = createLLMAdapter(config.provider);
  const critic = config.communication?.critic ?? (createCriticFn ? createCriticFn({ llmProvider: llmAdapter.criticProvider }) : createNoopCritic());
  const consensusEngine = config.communication?.consensusEngine ?? (createConsensusEngineFn ? createConsensusEngineFn() : createNoopConsensusEngine());
  const reputationSystem = config.communication?.reputationSystem ?? (createReputationSystemFn ? createReputationSystemFn() : createNoopReputationSystem());
  const community = config.communication?.community ?? (createCommunityFn ? createCommunityFn() : createNoopCommunity());
  const marketplace = config.communication?.marketplace ?? (createMarketplaceFn ? createMarketplaceFn() : createNoopMarketplace());
  const analytics = config.communication?.analytics ?? (createAnalyticsFn ? createAnalyticsFn() : createNoopAnalytics());

  const toolUseContext: ToolUseContext = config.toolUseContext ?? {
    cwd: process.cwd(),
    getAppState: () => ({}),
  };

  const baseSystemPrompt = config.baseSystemPrompt ??
    "You are EvoAgent, a self-evolving AI agent system. You can use tools to help users. Respond helpfully and concisely in the same language the user uses.";

  const registeredTools: Tool[] = [...config.tools];
  let autoRegisteredCount = 0;

  function onToolGenerated(generated: GeneratedTool): void {
    const check = canRegisterTool(generated, autoRegisteredCount);
    if (!check.allowed) {
      logger.warn("Auto-generated tool registration rejected", {
        toolName: generated.name,
        reason: check.reason,
      });
      return;
    }

    const tool = createToolFromGenerated(generated);
    registeredTools.push(tool);
    autoRegisteredCount++;
    logger.info("Auto-generated tool registered", {
      toolName: generated.name,
      toolId: generated.toolId,
      totalTools: registeredTools.length,
      autoRegistered: autoRegisteredCount,
    });
  }

  const engine = createQueryEngine({
    provider: config.provider,
    tools: registeredTools,
    canUseTool: config.canUseTool,
    baseSystemPrompt,
    toolUseContext,
  });

  const orchestrator = createOrchestrator({
    provider: config.provider,
    tools: registeredTools,
    canUseTool: config.canUseTool,
    toolUseContext,
  });

  const evolutionEngine = createEvolutionEngine({
    ruleStore,
    llmProvider: llmAdapter.simpleProvider,
    onToolGenerated,
  });

  const knowledgeManager = knowledgeModule.createKnowledgeManager({
    llmProvider: llmAdapter.simpleProvider,
    memoryStore: knowledgeModule.createJSONLMemoryStore(),
  });

  try {
    await knowledgeManager.loadFromStore();
  } catch (err) {
    logger.debug("Knowledge store load skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const knowledgeFacade = createKnowledgeFacade({ knowledgeManager });

  const memoryExtractor = createMemoryExtractor({ provider: config.provider });

  // 管线#9: 梦境整理 + 主动遗忘 定时触发
  const DREAMING_INTERVAL_MS = 30 * 60 * 1000;

  let dreamingManager: {
    runLightDreaming: (memories: readonly MemoryEntry[]) => DreamingResult;
  } | null = null;
  let forgettingManager: {
    forget: (memories: readonly MemoryEntry[]) => ForgettingResult;
  } | null = null;

  async function getDreamingManager(): Promise<{
    runLightDreaming: (memories: readonly MemoryEntry[]) => DreamingResult;
  }> {
    if (!dreamingManager) {
      const { createDreamingManager } = await import("../knowledge/dreaming");
      dreamingManager = createDreamingManager({
        llmProvider: llmAdapter.simpleProvider,
      });
    }
    return dreamingManager;
  }

  async function getForgettingManager(): Promise<{
    forget: (memories: readonly MemoryEntry[]) => ForgettingResult;
  }> {
    if (!forgettingManager) {
      const { createForgettingManager } = await import("../knowledge/forgetting");
      forgettingManager = createForgettingManager({
        llmProvider: llmAdapter.simpleProvider,
      });
    }
    return forgettingManager;
  }

  const dreamingTimer = setInterval(async () => {
    try {
      const dm = await getDreamingManager();
      const fm = await getForgettingManager();

      const allMemories = knowledgeManager.getAll();
      if (allMemories.length > 0) {
        const dreamResult = dm.runLightDreaming(allMemories);
        logger.info("Scheduled dreaming completed", {
          phase: dreamResult.phase,
          processed: dreamResult.processed,
          merged: dreamResult.merged,
        });

        const forgetResult = fm.forget(allMemories);
        logger.info("Scheduled forgetting completed", {
          forgotten: forgetResult.forgotten.length,
          retained: forgetResult.retained.length,
        });
      }
    } catch (err) {
      logger.warn("Scheduled dreaming/forgetting failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, DREAMING_INTERVAL_MS);
  dreamingTimer.unref();

  function _stopTimers(): void {
    clearInterval(dreamingTimer);
    dreamingManager = null;
    forgettingManager = null;
  }

  async function gracefulShutdown(timeoutMs: number = 30_000): Promise<void> {
    _stopTimers();

    const flushDeadline = Date.now() + timeoutMs;

    try {
      await Promise.race([
        Promise.all([
          ruleStore.flush(),
          ruleStore.compact(),
          knowledgeManager.flush(),
        ]),
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, flushDeadline - Date.now()))),
      ]);
    } catch (err) {
      logger.warn("Graceful shutdown flush error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info("EvoAgentContext graceful shutdown completed");
  }

  logger.info("EvoAgentContext initialized", {
    provider: config.provider.model,
    toolsCount: registeredTools.length,
  });

  async function chat(message: string, signal?: AbortSignal, options?: { readonly maxTokens?: number }): Promise<ChatResult> {
    const start = Date.now();
    let response = "";
    let terminal: Terminal;
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCalls = 0;
    let errorCount = 0;
    let lastError: string | undefined;
    let partialResult = false;

    const diagnostic: ChatDiagnosticSummary = {
      requestId: createRequestId("chat"),
      phase: "context_chat",
      provider: createProviderSummary({
        providerType: config.provider.providerType,
        model: config.provider.model,
      }),
      message: createMessageSummary(message),
    };

    statsStore.increment("chat.requests");
    statsStore.increment("chat.total_messages");

    try {
      engine.resetContext();

      if (signal?.aborted) {
        const durationMs = Date.now() - start;
        return {
          response: "",
          terminal: terminalAborted("aborted_user"),
          tokensUsed: { inputTokens: 0, outputTokens: 0 },
          agentCount: 1,
          evolutionTriggered: false,
          durationMs,
          diagnostic,
          partial: true,
          partialReason: "timeout",
        };
      }

      const gen = engine.submitMessage(message, options);
      let result = await gen.next();

      while (!result.done) {
        if (signal?.aborted) {
          partialResult = true;
          break;
        }

        const event = result.value as StreamEvent;

        switch (event.type) {
          case "content":
            response += event.content;
            break;
          case "tool_start":
            toolCalls += 1;
            statsStore.increment("chat.tool_calls");
            analytics.recordEvent("tool_call", 1);
            progressModule.updateProgressFromStreamEvent(progressTracker, event);
            break;
          case "turn_end":
            if (event.tokenUsage) {
              inputTokens += event.tokenUsage.inputTokens;
              outputTokens += event.tokenUsage.outputTokens;
            }
            progressModule.updateProgressFromStreamEvent(progressTracker, event);
            break;
          case "error":
            errorCount += 1;
            lastError = event.error;
            logger.warn("Stream error during chat", {
              requestId: diagnostic.requestId,
              error: event.error,
              recoverable: event.recoverable,
              errorCount,
            });
            break;
        }

        if (signal && !signal.aborted) {
          const nextPromise = gen.next();
          let abortHandler: (() => void) | undefined;
          const abortPromise = new Promise<undefined>((resolve) => {
            abortHandler = () => resolve(undefined);
            signal.addEventListener("abort", abortHandler, { once: true });
          });

          const raceResult = await Promise.race([nextPromise, abortPromise]);

          if (abortHandler && !signal.aborted) {
            signal.removeEventListener("abort", abortHandler);
          }

          if (raceResult === undefined || signal.aborted) {
            partialResult = true;
            break;
          }

          result = raceResult as IteratorResult<StreamEvent, Terminal>;
        } else {
          result = await gen.next();
        }
      }

      if (partialResult) {
        terminal = terminalAborted("aborted_user");
      } else {
        terminal = result.done ? result.value : terminalAborted("aborted_user");
      }

      if (lastError && !diagnostic.error) {
        diagnostic.error = parseDiagnosticError(lastError);
      }

      if (terminal.reason === "model_error") {
        statsStore.increment("chat.errors");
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      diagnostic.error = parseDiagnosticError(errorMsg);
      logger.error("Chat error", {
        requestId: diagnostic.requestId,
        provider: diagnostic.provider.providerType,
        model: diagnostic.provider.model,
        error: errorMsg,
      });
      statsStore.increment("chat.errors");
      throw err;
    }

    const durationMs = Date.now() - start;
    statsStore.observe("chat.duration_ms", durationMs);

    diagnostic.toolCalls = toolCalls;
    diagnostic.terminal = {
      reason: terminal.reason,
      durationMs,
      tokensUsed: { inputTokens, outputTokens },
    };

    const success = terminal.reason === "completed";
    statsStore.increment(success ? "chat.successes" : "chat.failures");

    costTracker.recordUsage(config.provider.model, {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
    });

    let evolutionTriggered = false;
    try {
      await evolutionEngine.onTaskCompleted({
        success,
        taskType: "chat",
        executionTimeMs: durationMs,
        tokensUsed: inputTokens + outputTokens,
        goal: message.slice(0, 200),
        ...(success ? {} : { errorMessage: terminal.reason }),
      });
      evolutionTriggered = true;
    } catch (err) {
      logger.warn("Evolution callback error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    analytics.recordEvent("message", 1);
    analytics.incrementCounter("total_messages");

    if (success && isWorthExtracting(response)) {
      try {
        const messages: readonly Message[] = [
          { id: "user-msg", role: "user", content: message, timestamp: start },
          { id: "assistant-msg", role: "assistant", content: response, timestamp: Date.now() },
        ];
        if (memoryExtractor.shouldExtract(1, messages)) {
          const result = await memoryExtractor.extract(messages);
          for (const id of result.updated) {
            const mem = memoryExtractor.getMemory(id);
            if (mem) knowledgeManager.store(mem);
          }
        }
      } catch (err) {
        logger.debug("Memory extraction failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("Chat completed", {
      requestId: diagnostic.requestId,
      provider: diagnostic.provider.providerType,
      model: diagnostic.provider.model,
      reason: diagnostic.terminal.reason,
      durationMs,
      toolCalls,
      inputTokens,
      outputTokens,
      ...(partialResult ? { partial: true, partialReason: "timeout" } : {}),
    });

    return {
      response,
      terminal,
      tokensUsed: { inputTokens, outputTokens },
      agentCount: 1,
      evolutionTriggered,
      durationMs,
      diagnostic,
      ...(partialResult ? { partial: true as const, partialReason: "timeout" as const } : {}),
    };
  }

  async function chatComplex(
    message: string,
    subTaskDescriptions: readonly string[],
    signal?: AbortSignal,
    onProgress?: SubTaskProgressCallback,
  ): Promise<ComplexChatResult> {
    const start = Date.now();
    const diagnostic: ChatDiagnosticSummary = {
      requestId: createRequestId("chat_complex"),
      phase: "context_chat_complex",
      provider: createProviderSummary({
        providerType: config.provider.providerType,
        model: config.provider.model,
      }),
      message: createMessageSummary(message),
    };
    statsStore.increment("chat.complex_requests");

    logger.info("Complex chat started", {
      requestId: diagnostic.requestId,
      provider: diagnostic.provider.providerType,
      model: diagnostic.provider.model,
      subTaskCount: subTaskDescriptions.length,
    });

    try {
      let plan: ExecutionPlan;

      if (subTaskDescriptions.length > 0) {
        const availableTools = registeredTools.map((t) => t.name);
        const subTasks: PlannedSubTask[] = subTaskDescriptions.map((desc, i) => ({
          taskId: `task_${String(i + 1).padStart(3, "0")}`,
          type: "custom" as const,
          description: buildSubTaskDescription(desc, i + 1, subTaskDescriptions.length, message, availableTools),
          input: desc,
          expectedOutput: "Complete result for this sub-task",
          tools: availableTools,
          knowledgeNeeded: [] as readonly string[],
          tokenBudget: 120000,
          timeoutMs: 300_000,
          dependsOn: i === 0
            ? ([] as readonly string[])
            : ([`task_${String(i).padStart(3, "0")}`] as readonly string[]),
          priority: subTaskDescriptions.length - i,
        }));

        plan = {
          planId: `plan_${Date.now()}`,
          originalInput: message,
          subTasks,
          totalTokenBudget: subTasks.reduce((sum, t) => sum + t.tokenBudget, 0),
          createdAt: Date.now(),
          diagnostics: {
            source: "user_provided" as const,
            failureStage: "none" as const,
            usedFallback: false,
            hasProvider: true,
          },
        };
      } else {
        plan = await orchestrator.plan(message);
        const availableTools = registeredTools.map((t) => t.name);
        plan = {
          ...plan,
          subTasks: plan.subTasks.map((task, index) => ({
            ...task,
            description: buildSubTaskDescription(task.description, index + 1, plan.subTasks.length, message, availableTools),
          })),
        };
      }

      const agentStates = await orchestrator.executePlan(plan, signal, onProgress);

      const executionTrace = orchestrator.getExecutionTrace();

      const successCount = agentStates.filter((s) => s.status === "completed").length;
      const failedCount = agentStates.filter((s) => s.status === "failed").length;
      const totalAgents = agentStates.length;
      const toolExecutionAgents = agentStates.filter(
        (s) => s.status === "completed" && s.messages.some((m) => m.role === "tool_result"),
      );
      const success = totalAgents > 0 && failedCount === 0;
      const partialSuccess = successCount > 0 && failedCount > 0;
      const noAgentsCreated = agentStates.length === 0;
      const toolExecutionSuccess = totalAgents > 0
        && toolExecutionAgents.length / totalAgents >= 0.5;

      const TOOL_CALL_PLACEHOLDER_RE = /^\[Calling \d+ tool\(s\)\]$/;

      const toolCallSummaries = new Map<string, string>();
      for (const state of agentStates) {
        const toolSummaries: string[] = [];
        for (const msg of state.messages) {
          if (msg.role === "tool_use") {
            const resultMsg = state.messages.find(
              (m) => m.role === "tool_result" && m.toolUseId === msg.toolUseId,
            ) as ToolResultMessage | undefined;
            const status = resultMsg
              ? (resultMsg.isError ? "ERROR" : "OK")
              : "NO_RESULT";
            toolSummaries.push(`${msg.toolName} → ${status}`);
          }
        }
        if (toolSummaries.length > 0) {
          toolCallSummaries.set(state.taskId, toolSummaries.join(", "));
        }
      }

      let response = "";
      for (const state of agentStates) {
        if (state.status !== "completed") continue;

        const parts: string[] = [];

        if (state.result !== null && state.result !== undefined) {
          const resultText = typeof state.result === "string" ? state.result : JSON.stringify(state.result);
          if (resultText.trim().length > 0 && !TOOL_CALL_PLACEHOLDER_RE.test(resultText.trim())) {
            parts.push(resultText);
          }
        }

        if (parts.length === 0) {
          for (let i = state.messages.length - 1; i >= 0; i--) {
            const msg = state.messages[i]!;
            if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.trim().length > 0 && !TOOL_CALL_PLACEHOLDER_RE.test(msg.content.trim())) {
              parts.push(msg.content);
              break;
            }
          }
        }

        if (parts.length === 0) {
          const toolResultParts: string[] = [];
          for (const msg of state.messages) {
            if (msg.role === "tool_result" && typeof msg.content === "string" && msg.content.trim().length > 0) {
              toolResultParts.push(msg.content);
            }
          }
          if (toolResultParts.length > 0) {
            parts.push(toolResultParts.join("\n\n"));
          }
        }

        if (parts.length === 0) {
          const successTools = state.messages
            .filter((m): m is ToolUseMessage => m.role === "tool_use")
            .map((m) => `${m.toolName}(${formatToolInputBrief(m.input)})`);
          if (successTools.length > 0) {
            parts.push(`[Task completed via tool execution: ${successTools.join(", ")}]`);
          }
        }

        const summary = toolCallSummaries.get(state.taskId);
        if (summary && !parts.some((p) => p.includes(summary))) {
          parts.push(`[Tool calls: ${summary}]`);
        }

        if (parts.length > 0) {
          response += `--- ${state.taskId} ---\n${parts.join("\n\n")}\n\n`;
        }
      }

      if (!response) {
        if (noAgentsCreated) {
          response = "No sub-agents were created. Possible causes: LLM provider error, plan parsing failure, or abort signal already active.";
          logger.error("Complex chat: no agents created", {
            agentCount: agentStates.length,
            planSource: plan.diagnostics.source,
            planFailureStage: plan.diagnostics.failureStage,
            planUsedFallback: plan.diagnostics.usedFallback,
          });
        } else {
          response = "Sub-agents executed but produced no results.";
          logger.warn("Complex chat produced no results", {
            agentCount: agentStates.length,
            statuses: agentStates.map((s) => s.status),
            planSource: plan.diagnostics.source,
          });
        }
      }

      const durationMs = Date.now() - start;
      statsStore.observe("chat.complex_duration_ms", durationMs);

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      for (const state of agentStates) {
        totalInputTokens += state.tokenUsage.inputTokens;
        totalOutputTokens += state.tokenUsage.outputTokens;
      }

      progressTracker.latestInputTokens += totalInputTokens;
      progressTracker.cumulativeOutputTokens += totalOutputTokens;
      for (const state of agentStates) {
        for (const msg of state.messages) {
          if (msg.role === "tool_use") {
            progressModule.recordToolCall(progressTracker, msg.toolName, msg.input);
          }
        }
      }

      diagnostic.toolCalls = 0;
      let overallStatus: "completed" | "partial_success" | "failed";
      if (failedCount === 0 && successCount > 0) {
        overallStatus = "completed";
      } else if (successCount > 0 && failedCount > 0) {
        overallStatus = "partial_success";
      } else {
        overallStatus = "failed";
      }
      diagnostic.terminal = {
        reason: overallStatus === "completed" ? "completed" : overallStatus === "partial_success" ? "partial_success" : "tool_error",
        durationMs,
        tokensUsed: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      };
      statsStore.increment(overallStatus === "failed" ? "chat.failures" : "chat.successes");
      statsStore.increment(toolExecutionSuccess ? "chat.tool_execution_successes" : "chat.tool_execution_failures");

      let evolutionTriggered = false;
      try {
        await evolutionEngine.onTaskCompleted({
          success: overallStatus === "completed",
          taskType: "complex_chat",
          executionTimeMs: durationMs,
          tokensUsed: totalInputTokens + totalOutputTokens,
          goal: message.slice(0, 200),
          ...(overallStatus !== "completed" ? { errorMessage: overallStatus === "partial_success" ? "Partial sub-agent execution" : "Sub-agent execution failed" } : {}),
        });
        evolutionTriggered = true;
      } catch (err) {
        logger.warn("Evolution callback error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      analytics.recordEvent("complex_message", 1);
      analytics.incrementCounter("total_messages");

      if (overallStatus !== "failed" && isWorthExtracting(response)) {
        memoryExtractor.shouldExtract(1, [
          { id: "user-msg", role: "user", content: message, timestamp: start },
          { id: "assistant-msg", role: "assistant", content: response, timestamp: Date.now() },
        ]);
        memoryExtractor.extract([
          { id: "user-msg", role: "user", content: message, timestamp: start },
          { id: "assistant-msg", role: "assistant", content: response, timestamp: Date.now() },
        ]).then((result) => {
          for (const id of result.updated) {
            const mem = memoryExtractor.getMemory(id);
            if (mem) knowledgeManager.store(mem);
          }
        }).catch((err) => {
          logger.debug("Complex chat memory extraction failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      if (overallStatus !== "failed" && subTaskDescriptions.length > 0) {
        config.provider.invoke([
          {
            role: "system",
            content: "Evaluate the quality of this task decomposition. Were the sub-tasks well-defined, non-overlapping, and comprehensive? Rate 0.0-1.0. Respond with ONLY a number.",
          },
          {
            role: "user",
            content: `Task: ${message.slice(0, 300)}\nSub-tasks: ${subTaskDescriptions.join("; ")}`,
          },
        ]).then((evalResponse) => {
          const qualityScore = parseFloat(evalResponse.content.trim());
          if (!isNaN(qualityScore) && qualityScore >= 0 && qualityScore <= 1) {
            statsStore.observe("chat.plan_quality", qualityScore);
            logger.info("Plan quality evaluation", {
              requestId: diagnostic.requestId,
              qualityScore,
              planSource: plan.diagnostics.source,
            });
          }
        }).catch((err) => {
          logger.debug("Plan quality evaluation failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      logger.info("Complex chat completed", {
        requestId: diagnostic.requestId,
        provider: diagnostic.provider.providerType,
        model: diagnostic.provider.model,
        overallStatus,
        agentCount: agentStates.length,
        successCount,
        failedCount,
        durationMs,
        evolutionTriggered,
        planSource: plan.diagnostics.source,
        planFailureStage: plan.diagnostics.failureStage,
        planUsedFallback: plan.diagnostics.usedFallback,
      });

      return {
        response,
        terminal: overallStatus === "completed"
          ? terminalCompleted([], { inputTokens: totalInputTokens, outputTokens: totalOutputTokens })
          : overallStatus === "partial_success"
            ? terminalCompleted([], { inputTokens: totalInputTokens, outputTokens: totalOutputTokens })
            : terminalToolError("orchestrator", noAgentsCreated ? "No sub-agents created" : "Sub-agent execution failed", false),
        tokensUsed: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        agentCount: agentStates.length,
        evolutionTriggered,
        durationMs,
        diagnostic,
        plan,
        planDiagnostics: plan.diagnostics,
        successCount,
        agentStates: agentStates.map((s) => ({
          agentId: s.agentId,
          taskId: s.taskId,
          status: s.status,
          result: s.status === "completed" ? s.result : undefined,
          tokenUsage: s.tokenUsage,
          ...(s.error ? { error: s.error } : {}),
          ...(toolCallSummaries.has(s.taskId) ? { toolCallSummary: toolCallSummaries.get(s.taskId) as string } : {}),
        })),
        ...(executionTrace ? { executionTrace } : {}),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      diagnostic.error = parseDiagnosticError(errorMsg);
      logger.error("Complex chat error", {
        requestId: diagnostic.requestId,
        provider: diagnostic.provider.providerType,
        model: diagnostic.provider.model,
        error: errorMsg,
      });
      statsStore.increment("chat.errors");
      throw err;
    }
  }

  async function recordTaskCompletion(input: TaskCompletedInput): Promise<void> {
    await evolutionEngine.onTaskCompleted(input);
    analytics.recordEvent(input.success ? "task_success" : "task_failure", 1);
  }

  function recordCost(model: string, usage: ModelUsage): void {
    costTracker.recordUsage(model, usage);
  }

  function getEvolutionState(): EvolutionEngineState {
    return evolutionEngine.getState();
  }

  function getProgress(): AgentProgress {
    return progressModule.getProgressUpdate(progressTracker);
  }

  function parseDiagnosticError(errorMessage: string): NonNullable<ChatDiagnosticSummary["error"]> {
    try {
      const parsed = JSON.parse(errorMessage) as {
        readonly type?: string;
        readonly diagnostic?: {
          readonly category?: string;
          readonly message?: string;
          readonly statusCode?: number;
          readonly retriable?: boolean;
        };
      };
      if (parsed.type === "provider_error" && parsed.diagnostic) {
        return {
          category: parsed.diagnostic.category ?? "provider",
          message: parsed.diagnostic.message ?? errorMessage,
          ...(parsed.diagnostic.statusCode !== undefined ? { statusCode: parsed.diagnostic.statusCode } : {}),
          ...(parsed.diagnostic.retriable !== undefined ? { retriable: parsed.diagnostic.retriable } : {}),
        };
      }
    } catch {
    }

    return {
      category: "runtime",
      message: errorMessage,
    };
  }

  return {
    provider: config.provider,
    tools: registeredTools,
    getEngine: () => engine,
    getOrchestrator: () => orchestrator,
    getEvolutionEngine: () => evolutionEngine,
    getRuleStore: () => ruleStore,
    getKnowledgeManager: () => knowledgeManager,
    getKnowledgeFacade: () => knowledgeFacade,
    getLogger: () => logger,
    getStatsStore: () => statsStore,
    getCostTracker: () => costTracker,
    getProgressTracker: () => progressTracker,
    getGateway: () => gateway,
    getCritic: () => critic,
    getConsensusEngine: () => consensusEngine,
    getReputationSystem: () => reputationSystem,
    getCommunity: () => community,
    getMarketplace: () => marketplace,
    getAnalytics: () => analytics,
    chat,
    chatComplex,
    recordTaskCompletion,
    recordCost,
    getEvolutionState,
    getProgress,
    gracefulShutdown,
  };
}

export function buildSubTaskDescription(
  taskDescription: string,
  taskIndex: number,
  totalTasks: number,
  parentMessage: string,
  availableTools: readonly string[],
): string {
  const toolList = availableTools.join(", ");
  return [
    `[Sub-task ${taskIndex}/${totalTasks} of: "${parentMessage}"]`,
    "",
    `Task: ${taskDescription}`,
    "",
    `You have access to these tools: ${toolList}.`,
    "",
    "**CRITICAL: You MUST call tools using XML tags. Example:**",
    '<file_write file_path="/path/to/file" content="file content here" />',
    "<bash>echo hello</bash>",
    "",
    "Do NOT describe what you plan to do. Do NOT output natural language about tool calls. Output the XML tag DIRECTLY.",
    "If the tool calling mechanism provided by your interface is available (native function calling), prefer that over XML format.",
    "",
    "Complete this sub-task fully. The task is done ONLY when all required files are written or commands executed.",
  ].join("\n");
}

function formatToolInputBrief(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  return keys.slice(0, 3).map((k) => {
    const v = input[k];
    const s = typeof v === "string" ? (v.length > 40 ? `${v.slice(0, 40)}...` : v) : String(v);
    return `${k}=${s}`;
  }).join(", ");
}

function createNoopGateway(): Gateway {
  return {
    addPeer: (_peer: PeerInfo) => false,
    removePeer: (_instanceId: string) => false,
    getPeer: (_instanceId: string) => null,
    listPeers: () => [],
    handleMessage: (_message: PeerMessage): MessageHandleResult => ({ accepted: true }),
    isDuplicate: (_messageId: string) => false,
    getActivePeerCount: () => 0,
    getStats: (): GatewayStats => ({
      totalPeers: 0,
      activePeers: 0,
      messagesReceived: 0,
      messagesRejected: 0,
      duplicateMessages: 0,
    }),
  };
}

function createNoopCritic(): Critic {
  return {
    analyzeMessage: async (_sourceAgent: string, claim: string, _currentTrustScore: number): Promise<ExternalKnowledge> => ({
      id: `noop_${Date.now()}`,
      sourceAgent: _sourceAgent,
      originalClaim: claim,
      processingResult: "ACCEPT" as ProcessingResult,
      analysis: {},
      confidence: 0.5,
      validAspects: [],
      flawedAspects: [],
      correctedStatement: claim,
      timestamp: Date.now(),
    }),
    getTrustScore: (_sourceAgent: string) => 0.5,
    getKnowledge: (_sourceAgent: string) => [],
    count: () => 0,
    clear: () => {},
    getCacheStats: () => ({ size: 0, maxSize: 256 }),
    clearCache: () => {},
  };
}

function createNoopConsensusEngine(): ConsensusEngine {
  return {
    createEndorsement: (input) => ({
      endorsementId: `noop_${Date.now()}`,
      signerId: input.signerId,
      targetType: input.targetType,
      targetId: input.targetId,
      verdict: input.verdict,
      confidence: input.confidence,
      reason: input.reason ?? "",
      signature: input.signature ?? "",
      timestamp: Date.now(),
    }),
    receiveEndorsement: () => ({ accepted: true }),
    isTrustedByConsensus: () => false,
    isFlaggedByConsensus: () => false,
    getConsensusScore: () => null,
    getEndorsements: () => [],
    count: () => 0,
    clear: () => {},
    loadFromStore: async () => {},
    flush: async () => {},
  };
}

function createNoopReputationSystem(): ReputationSystem {
  return {
    getReputation: () => null,
    updateReputation: (_id, updates) => ({
      instanceId: _id,
      reputation: (updates.consensusScore ?? 0) * 0.4 + (updates.marketContribution ?? 0) * 0.3 + (updates.activityScore ?? 0) * 0.2,
      tier: "newcomer" as const,
      voteWeight: 1,
      consensusScore: updates.consensusScore ?? 0,
      marketContribution: updates.marketContribution ?? 0,
      activityScore: updates.activityScore ?? 0,
      longevityDays: 0,
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    }),
    recordActivity: () => {},
    addMarketContribution: () => {},
    decayReputation: () => 0,
    getTier: () => "newcomer" as const,
    getVoteWeight: () => 1,
    listAll: () => [],
    count: () => 0,
    clear: () => {},
    loadFromStore: async () => {},
    flush: async () => {},
  };
}

function createNoopCommunity(): Community {
  return {
    createProposal: (input) => ({
      proposalId: "noop",
      proposalType: input.proposalType,
      title: input.title,
      description: input.description,
      authorId: input.authorId,
      votesFor: [],
      votesAgainst: [],
      voteWeights: {},
      passThreshold: input.passThreshold ?? 0.6,
      minVoters: input.minVoters ?? 3,
      votingHours: input.votingHours ?? 72,
      status: "open" as const,
      createdAt: Date.now(),
      expiresAt: Date.now() + (input.votingHours ?? 72) * 3600_000,
    }),
    vote: (_proposalId: string, _voterId: string, _support: boolean, _voterTier: ReputationTier): VoteResult => ({ accepted: false, reason: "noop" }),
    closeExpiredProposals: () => 0,
    getProposal: (_proposalId: string) => null,
    getOpenProposals: () => [],
    getProposalStats: () => ({ total: 0, open: 0, passed: 0, rejected: 0, expired: 0 }),
    count: () => 0,
    clear: () => {},
  };
}

function createNoopMarketplace(): Marketplace {
  return {
    publish: (input) => ({
      itemId: "noop",
      itemType: input.itemType,
      title: input.title,
      description: input.description,
      authorId: input.authorId,
      content: input.content,
      tags: input.tags ?? [],
      category: input.category,
      difficulty: input.difficulty ?? "beginner",
      downloads: 0,
      ratingSum: 0,
      ratingCount: 0,
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    search: (_options: MarketSearchOptions) => [],
    getItem: (_itemId: string) => null,
    getTrending: (_limit?: number) => [],
    rateItem: (_itemId: string, _rating: number, _userId: string) => false,
    subscribe: (_itemId: string, _userId: string) => false,
    unsubscribe: (_itemId: string, _userId: string) => false,
    getSubscriptions: (_userId: string) => [],
    getItemsByAuthor: (_authorId: string) => [],
    updateItem: (_itemId: string, _authorId: string, _updates: Partial<Pick<MarketItem, "title" | "description" | "content" | "tags" | "category" | "difficulty" | "status">>) => false,
    removeItem: (_itemId: string, _authorId: string) => false,
    count: () => 0,
    clear: () => {},
  };
}

function createNoopAnalytics(): Analytics {
  return {
    recordEvent: (_event: string, _value?: number) => {},
    getSummary: (): AnalyticsSummary => ({
      totalMessages: 0,
      totalEndorsements: 0,
      totalAnomalies: 0,
      activePeers: 0,
      marketplaceItems: 0,
      openProposals: 0,
      timestamp: Date.now(),
    }),
    getTrend: (_event: string, _limit?: number): readonly TrendDataPoint[] => [],
    incrementCounter: (_name: string, _amount?: number) => {},
    getCounter: (_name: string) => 0,
    reset: () => {},
  };
}

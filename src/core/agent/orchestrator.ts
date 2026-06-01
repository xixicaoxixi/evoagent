import type { Message } from "../../types/message";
import type { Tool, ToolUseContext, CanUseToolFn } from "../../interfaces/tool";
import type { LLMProvider } from "../../interfaces/llm-provider";
import type { StreamEvent, Terminal } from "../query/types";
import { SubAgent, type SubAgentState } from "./sub-agent";
import { createTaskPlanner, type TaskPlanner, type ExecutionPlan, type PlannedSubTask, topologicalSort, getExecutableTasks } from "./task-planner";
import { createAgentFactory, type AgentFactory } from "./agent-factory";
import { createVerificationPipeline, type VerificationPipelineConfig, type VerificationResult } from "./verification-loop";
import { ToolUseAuditor } from "./tool-filter";
import type { AgentModeContext } from "../../types/mode";
import type { ExecutionPlanResult, PlanConfirmation } from "./plan-mode";
import { createLogger, type Logger } from "../../observability/logger";

export interface OrchestratorConfig {
  readonly provider: LLMProvider;
  readonly tools: ReadonlyArray<Tool>;
  readonly canUseTool: CanUseToolFn;
  readonly toolUseContext: ToolUseContext;
  readonly maxConcurrentAgents?: number;
  readonly agentTimeoutMs?: number;
  readonly planTimeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly verificationConfig?: VerificationPipelineConfig;
  readonly auditor?: ToolUseAuditor;
  readonly modeContext?: AgentModeContext;
  readonly onPlanApproval?: (plan: ExecutionPlan) => Promise<boolean>;
}

export interface TaskDefinition {
  readonly taskId: string;
  readonly description: string;
  readonly dependsOn?: readonly string[];
  readonly tools?: readonly string[];
  readonly maxTurns?: number;
  readonly tokenBudget?: number;
  readonly systemPrompt?: string;
}

export interface TeamMemberResult {
  readonly taskId: string;
  readonly success: boolean;
  readonly result: unknown;
  readonly durationMs: number;
  readonly error?: string;
}

export type AggregationStrategy = "all_succeed" | "majority" | "any_succeed" | "collect_all";

export interface ExecutionBatch {
  readonly batchIndex: number;
  readonly taskIds: readonly string[];
  readonly startedAt: number;
  readonly completedAt: number;
}

export interface ExecutionTrace {
  readonly batches: readonly ExecutionBatch[];
  readonly totalBatches: number;
}

export interface ParallelTeamConfig {
  readonly strategy?: AggregationStrategy;
  readonly memberTimeoutMs?: number;
  readonly teamSystemPrompt?: string;
}

export interface ParallelTeamResult {
  readonly success: boolean;
  readonly memberResults: readonly TeamMemberResult[];
  readonly aggregatedResult: unknown;
  readonly totalDurationMs: number;
  readonly strategy: AggregationStrategy;
}

async function drainAgent(agent: SubAgent, taskDescription: string, logger: Logger): Promise<void> {
  const agentId = agent.getState().agentId;
  const taskId = agent.getState().taskId;
  const startMs = Date.now();
  const gen = agent.run(taskDescription);
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
  const state = agent.getState();
  const durationMs = Date.now() - startMs;
  logger.info("SubAgent completed", { agentId, taskId, status: state.status, durationMs });
}

function aggregateResults(
  results: readonly TeamMemberResult[],
  strategy: AggregationStrategy,
): unknown {
  switch (strategy) {
    case "all_succeed": {
      const allOk = results.every((r) => r.success);
      if (!allOk) return null;
      return results.map((r) => r.result);
    }
    case "majority": {
      const successCount = results.filter((r) => r.success).length;
      if (successCount <= results.length / 2) return null;
      return results.filter((r) => r.success).map((r) => r.result);
    }
    case "any_succeed": {
      const firstSuccess = results.find((r) => r.success);
      return firstSuccess?.result ?? null;
    }
    case "collect_all": {
      return results.map((r) => ({
        taskId: r.taskId,
        success: r.success,
        result: r.result,
        error: r.error,
      }));
    }
  }
}

function evaluateTeamSuccess(
  results: readonly TeamMemberResult[],
  strategy: AggregationStrategy,
): boolean {
  switch (strategy) {
    case "all_succeed":
      return results.every((r) => r.success);
    case "majority": {
      const successCount = results.filter((r) => r.success).length;
      return successCount > results.length / 2;
    }
    case "any_succeed":
      return results.some((r) => r.success);
    case "collect_all":
      return results.length > 0;
  }
}

export type SubTaskProgressStatus = "started" | "completed" | "failed";

export interface SubTaskProgressDetails {
  readonly result?: unknown;
  readonly error?: string;
}

export type SubTaskProgressCallback = (
  taskId: string,
  status: SubTaskProgressStatus,
  details?: SubTaskProgressDetails,
) => void;

export class Orchestrator {
  private readonly config: OrchestratorConfig;
  private readonly agents = new Map<string, SubAgent>();
  private readonly abortController = new AbortController();
  private readonly factory: AgentFactory;
  private readonly planner: TaskPlanner;
  private readonly logger: Logger;
  private lastExecutionTrace: ExecutionTrace | null = null;
  private planApprovalHandler?: (agentId: string, plan: ExecutionPlanResult) => Promise<PlanConfirmation>;
  private readonly pendingPlanApprovals = new Map<string, {
    readonly agentId: string;
    readonly plan: ExecutionPlanResult;
    readonly submittedAt: number;
    resolve: (confirmation: PlanConfirmation) => void;
    reject: (error: Error) => void;
  }>();

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.logger = createLogger({ source: "orchestrator" });

    if (config.abortSignal?.aborted) {
      this.abortController.abort();
    }

    this.factory = createAgentFactory({
      provider: config.provider,
      tools: config.tools,
      canUseTool: config.canUseTool,
      toolUseContext: config.toolUseContext,
      ...(config.maxConcurrentAgents !== undefined ? { maxConcurrentAgents: config.maxConcurrentAgents } : {}),
      abortSignal: this.abortController.signal,
    });

    this.planner = createTaskPlanner({ provider: config.provider });
  }

  async plan(userInput: string): Promise<ExecutionPlan> {
    return this.planner.plan(userInput);
  }

  async executePlan(plan: ExecutionPlan, signal?: AbortSignal, onProgress?: SubTaskProgressCallback): Promise<readonly SubAgentState[]> {
    if (signal?.aborted) {
      return [];
    }

    if (this.config.onPlanApproval !== undefined) {
      const approved = await this.config.onPlanApproval(plan);
      if (!approved) {
        return [];
      }
    }

    const defaultTimeout = Math.max(300_000, plan.subTasks.length * 120_000);
    const planTimeoutMs = this.config.planTimeoutMs ?? defaultTimeout;
    const planAbortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const onSignalAbort = () => {
      planAbortController.abort();
      for (const agent of this.agents.values()) {
        agent.abort();
      }
    };

    if (signal !== undefined && !signal.aborted) {
      signal.addEventListener("abort", onSignalAbort, { once: true });
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        planAbortController.abort();
        reject(new Error(`Plan execution timed out after ${planTimeoutMs}ms`));
      }, planTimeoutMs);
    });

    const taskMap = new Map(plan.subTasks.map((t) => [t.taskId, t]));
    const completedTaskIds = new Set<string>();
    const results: SubAgentState[] = [];
    const executionBatches: ExecutionBatch[] = [];
    let batchIndex = 0;
    const MAX_RETRY_COUNT = 1;
    const maxConcurrent = this.config.maxConcurrentAgents ?? 5;
    const taskResults = new Map<string, string>();
    const failedTaskIds = new Set<string>();

    try {
      const executionPromise = (async (): Promise<void> => {
        while (completedTaskIds.size < plan.subTasks.length) {
          if (planAbortController.signal.aborted) break;

          const readyTasks = getExecutableTasks(plan.subTasks, completedTaskIds)
            .filter((t) => !completedTaskIds.has(t.taskId))
            .filter((t) => !t.dependsOn.some((dep) => failedTaskIds.has(dep)));

          if (readyTasks.length === 0) break;

          for (let sliceStart = 0; sliceStart < readyTasks.length; sliceStart += maxConcurrent) {
            if (planAbortController.signal.aborted) break;

            const slice = readyTasks.slice(sliceStart, sliceStart + maxConcurrent);

            const batchStartedAt = Date.now();
            const batchTaskIds = slice.map((t) => t.taskId);

            const batchResults = await Promise.allSettled(
              slice.map(async (task) => {
                return this.executeSingleTask(task, taskResults, "", onProgress);
              }),
            );

            executionBatches.push({
              batchIndex,
              taskIds: batchTaskIds,
              startedAt: batchStartedAt,
              completedAt: Date.now(),
            });
            batchIndex++;

            const retryQueue: typeof readyTasks = [];
            const prevResults = new Map<string, SubAgentState>();

            for (let i = 0; i < batchResults.length; i++) {
              const settled = batchResults[i]!;
              const task = slice[i]!;

              if (settled.status === "fulfilled") {
                results.push(settled.value);
                if (settled.value.status === "completed") {
                  completedTaskIds.add(task.taskId);
                  if (settled.value.result != null) {
                    const resultText = typeof settled.value.result === "string"
                      ? settled.value.result
                      : JSON.stringify(settled.value.result);
                    taskResults.set(task.taskId, resultText.slice(0, 4000));
                  }
                } else {
                  const isRetryable = settled.value.error?.reason === "no_tool_execution"
                    && (settled.value.error?.details as Record<string, unknown> | undefined)?.retryable === true;
                  if (isRetryable) {
                    this.logger.warn("SubAgent failed with retryable no_tool_execution, will retry", { taskId: task.taskId, agentId: settled.value.agentId });
                    retryQueue.push(task);
                    prevResults.set(task.taskId, settled.value);
                  } else {
                    this.logger.error("SubAgent failed", { taskId: task.taskId, agentId: settled.value.agentId });
                    retryQueue.push(task);
                    prevResults.set(task.taskId, settled.value);
                  }
                }
              } else {
                this.logger.error("Task error", { taskId: task.taskId, error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) });
                retryQueue.push(task);
              }
            }

            if (retryQueue.length > 0) {
              const retryStartedAt = Date.now();
              const retryTaskIds = retryQueue.map((t) => t.taskId);

              const retryResults = await Promise.allSettled(
                retryQueue.map(async (task) => {
                  const prev = prevResults.get(task.taskId);
                  return this.executeSingleTask(task, taskResults, "[Retry]", onProgress, true, prev);
                }),
              );

              executionBatches.push({
                batchIndex,
                taskIds: retryTaskIds,
                startedAt: retryStartedAt,
                completedAt: Date.now(),
              });
              batchIndex++;

              for (let i = 0; i < retryResults.length; i++) {
                const settled = retryResults[i]!;
                const task = retryQueue[i]!;

                if (settled.status === "fulfilled") {
                  const existingIdx = results.findIndex((r) => r.taskId === task.taskId);
                  if (existingIdx !== -1) {
                    results[existingIdx] = settled.value;
                  } else {
                    results.push(settled.value);
                  }
                  if (settled.value.status === "completed") {
                    completedTaskIds.add(task.taskId);
                    if (settled.value.result != null) {
                      const resultText = typeof settled.value.result === "string"
                        ? settled.value.result
                        : JSON.stringify(settled.value.result);
                      taskResults.set(task.taskId, resultText.slice(0, 4000));
                    }
                    this.logger.info("Retry succeeded", { taskId: task.taskId, agentId: settled.value.agentId });
                  } else {
                    failedTaskIds.add(task.taskId);
                    this.logger.error("Retry still failed", { taskId: task.taskId, agentId: settled.value.agentId });
                  }
                } else {
                  failedTaskIds.add(task.taskId);
                  this.logger.error("Retry error", { taskId: task.taskId, error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) });
                }
              }

              for (const task of retryQueue) {
                if (!completedTaskIds.has(task.taskId)) {
                  completedTaskIds.add(task.taskId);
                  failedTaskIds.add(task.taskId);
                }
              }
            }
          }
        }
      })();

      await Promise.race([executionPromise, timeoutPromise]);
    } catch (error) {
      for (const agent of this.agents.values()) {
        agent.abort();
      }
      this.logger.error("Plan execution error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      if (signal !== undefined && !signal.aborted) {
        signal.removeEventListener("abort", onSignalAbort);
      }
      for (const agent of this.agents.values()) {
        this.factory.destroyAgent(agent.getState().agentId);
      }
      this.agents.clear();
    }

    this.lastExecutionTrace = {
      batches: executionBatches,
      totalBatches: executionBatches.length,
    };

    return results;
  }

  private buildDependencyContext(
    task: PlannedSubTask,
    taskResults: Map<string, string>,
  ): string {
    if (!task.dependsOn || task.dependsOn.length === 0) {
      return "";
    }

    return task.dependsOn
      .map((depId) => {
        const r = taskResults.get(depId);
        return r ? { depId, result: r } : null;
      })
      .filter((entry): entry is { depId: string; result: string } => entry !== null)
      .map((entry) => `[Previous task ${entry.depId} output]:\n${entry.result}`)
      .join("\n\n");
  }

  private async executeSingleTask(
    task: PlannedSubTask,
    taskResults: Map<string, string>,
    descriptionPrefix: string,
    onProgress?: SubTaskProgressCallback,
    isRetry?: boolean,
    prevResult?: SubAgentState,
  ): Promise<SubAgentState> {
    const depsContext = this.buildDependencyContext(task, taskResults);

    const baseDescription = descriptionPrefix
      ? `${descriptionPrefix} ${task.description}`
      : task.description;

    let retryHint = "";
    if (isRetry && prevResult?.error?.reason === "no_tool_execution") {
      retryHint = SubAgent.buildRetryFormatHint(this.config.tools);
    } else if (isRetry) {
      retryHint = "\n\n**IMPORTANT**: You MUST use the available tools to complete this task. Do not just provide a text answer — call the relevant tools and report their results.";
    }

    const enrichedDescription = depsContext
      ? `${baseDescription}${retryHint}\n\n## Context from dependencies:\n${depsContext}`
      : `${baseDescription}${retryHint}`;

    const baseMaxTurns = Math.min(Math.ceil(task.tokenBudget / 4000), 50);
    const baseTokenBudget = task.tokenBudget;

    const agent = this.spawnSubAgent({
      taskId: task.taskId,
      description: enrichedDescription,
      ...(task.tools.length > 0 ? { tools: task.tools } : {}),
      maxTurns: isRetry ? Math.min(baseMaxTurns + 5, 50) : baseMaxTurns,
      tokenBudget: isRetry ? baseTokenBudget + 30000 : baseTokenBudget,
    });

    onProgress?.(task.taskId, "started");

    await drainAgent(agent, enrichedDescription, this.logger);
    const state = agent.getState();
    this.factory.destroyAgent(state.agentId);
    this.agents.delete(state.agentId);

    if (state.status === "completed") {
      onProgress?.(task.taskId, "completed", {
        result: state.result,
      });
    } else {
      onProgress?.(task.taskId, "failed", {
        error: state.error?.reason ?? "Sub-agent failed",
      });
    }

    return state;
  }

  spawnSubAgent(task: TaskDefinition): SubAgent {
    const taskType = `task_${task.taskId}`;

    const agent = this.factory.createAgent({
      taskId: task.taskId,
      taskType,
      description: task.description,
      ...(task.tools !== undefined ? { tools: task.tools } : {}),
      ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
      ...(task.tokenBudget !== undefined ? { tokenBudget: task.tokenBudget } : {}),
    });

    const state = agent.getState();
    this.agents.set(state.agentId, agent);
    this.logger.info("SubAgent created", { agentId: state.agentId, taskId: task.taskId, taskType });
    return agent;
  }

  getAgent(agentId: string): SubAgent | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): readonly SubAgent[] {
    return Array.from(this.agents.values());
  }

  getAgentStates(): readonly SubAgentState[] {
    return Array.from(this.agents.values()).map((agent) => agent.getState());
  }

  getExecutionTrace(): ExecutionTrace | null {
    return this.lastExecutionTrace;
  }

  get activeAgentCount(): number {
    return this.agents.size;
  }

  abortAll(): void {
    this.abortController.abort();
    for (const agent of this.agents.values()) {
      agent.abort();
    }
    this.factory.destroyAllAgents();
    this.agents.clear();
  }

  async runTask(task: TaskDefinition): Promise<SubAgentState> {
    const agent = this.spawnSubAgent(task);
    try {
      await drainAgent(agent, task.description, this.logger);
      return agent.getState();
    } finally {
      this.factory.destroyAgent(agent.getState().agentId);
      this.agents.delete(agent.getState().agentId);
    }
  }

  async runTasksParallel(tasks: readonly TaskDefinition[]): Promise<readonly SubAgentState[]> {
    const promises = tasks.map((task) => this.runTask(task));
    return Promise.all(promises);
  }

  async launchParallelTeam(
    tasks: readonly TaskDefinition[],
    config?: ParallelTeamConfig,
  ): Promise<ParallelTeamResult> {
    const startTime = Date.now();
    const strategy = config?.strategy ?? "all_succeed";
    const memberTimeoutMs = config?.memberTimeoutMs ?? this.config.agentTimeoutMs ?? 60_000;

    const memberPromises = tasks.map(async (task): Promise<TeamMemberResult> => {
      const memberStart = Date.now();
      try {
        const state = await Promise.race([
          this.runTask(task),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Task ${task.taskId} timed out after ${memberTimeoutMs}ms`)), memberTimeoutMs),
          ),
        ]);

        return {
          taskId: task.taskId,
          success: state.status === "completed",
          result: state.result,
          durationMs: Date.now() - memberStart,
        };
      } catch (error) {
        return {
          taskId: task.taskId,
          success: false,
          result: null,
          durationMs: Date.now() - memberStart,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const memberResults = await Promise.all(memberPromises);
    const success = evaluateTeamSuccess(memberResults, strategy);
    const aggregatedResult = aggregateResults(memberResults, strategy);

    return {
      success,
      memberResults,
      aggregatedResult,
      totalDurationMs: Date.now() - startTime,
      strategy,
    };
  }

  async verifyResult(
    _originalTask: string,
    _result: string,
    _criteria?: readonly string[],
  ): Promise<VerificationResult> {
    const pipeline = createVerificationPipeline(this.config.verificationConfig ?? { steps: [] });
    return pipeline.run();
  }

  getPlanner(): TaskPlanner {
    return this.planner;
  }

  setPlanApprovalHandler(
    handler: (agentId: string, plan: ExecutionPlanResult) => Promise<PlanConfirmation>,
  ): void {
    this.planApprovalHandler = handler;
  }

  submitPlanForApproval(agentId: string, plan: ExecutionPlanResult): Promise<PlanConfirmation> {
    if (this.planApprovalHandler) {
      return this.planApprovalHandler(agentId, plan);
    }

    return new Promise((resolve, reject) => {
      const planId = `plan-${agentId}-${Date.now()}`;
      this.pendingPlanApprovals.set(planId, {
        agentId,
        plan,
        submittedAt: Date.now(),
        resolve,
        reject,
      });
    });
  }

  cleanupStalePlanApprovals(maxAgeMs: number = 30 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [planId, entry] of this.pendingPlanApprovals) {
      if (now - entry.submittedAt > maxAgeMs) {
        entry.reject(new Error(`Plan approval timeout: ${planId}`));
        this.pendingPlanApprovals.delete(planId);
        cleaned++;
      }
    }

    return cleaned;
  }

  getPendingPlanApprovals(): readonly {
    readonly planId: string;
    readonly agentId: string;
    readonly plan: ExecutionPlanResult;
    readonly submittedAt: number;
  }[] {
    return Array.from(this.pendingPlanApprovals.entries()).map(([planId, entry]) => ({
      planId,
      agentId: entry.agentId,
      plan: entry.plan,
      submittedAt: entry.submittedAt,
    }));
  }

  resolvePlanApproval(planId: string, confirmation: PlanConfirmation): boolean {
    const entry = this.pendingPlanApprovals.get(planId);
    if (!entry) {
      return false;
    }

    this.pendingPlanApprovals.delete(planId);
    entry.resolve(confirmation);
    return true;
  }

  rejectPlanApproval(planId: string, reason: string): boolean {
    const entry = this.pendingPlanApprovals.get(planId);
    if (!entry) {
      return false;
    }

    this.pendingPlanApprovals.delete(planId);
    entry.reject(new Error(reason));
    return true;
  }
}

export function createOrchestrator(config: OrchestratorConfig): Orchestrator {
  return new Orchestrator(config);
}

export async function runOrchestratedTask(
  orchestrator: Orchestrator,
  userInput: string,
): Promise<readonly SubAgentState[]> {
  const plan = await orchestrator.plan(userInput);
  return orchestrator.executePlan(plan);
}

export async function* streamOrchestratedTask(
  orchestrator: Orchestrator,
  userInput: string,
): AsyncGenerator<StreamEvent, Terminal, void> {
  const states = await runOrchestratedTask(orchestrator, userInput);
  const content = states.map((s) => JSON.stringify(s.result)).join("\n");
  yield { type: "content", content };
  return {
    reason: "completed",
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
    },
  };
}

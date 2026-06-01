/**
 * 任务路由 — 连接真实 Orchestrator。
 *
 * POST /tasks — 创建并执行任务（支持多 Agent 编排）
 * GET /tasks — 列出任务
 * GET /tasks/:id — 获取任务详情
 * DELETE /tasks/:id — 删除任务
 * POST /tasks/plan — 规划任务（不执行）
 * POST /tasks/execute — 执行已规划的任务
 */

import type { RouteEntry, HttpRequest } from "../../server";
import { jsonResponse, errorResponse } from "../../server";
import type { EvoAgentContext } from "../../integration/context";
import type { SubAgentState } from "../../core/agent/sub-agent";
import type { PlanDiagnostics } from "../../core/agent/task-planner";

export interface TaskExecutionStatus {
  readonly stage: "created" | "running" | "chat_completed" | "chat_terminated" | "chat_failed";
  readonly degraded: boolean;
  readonly terminalReason?: string;
}

export interface Task {
  readonly id: string;
  readonly description: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "aborted";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly result?: unknown;
  readonly error?: string;
  readonly agentStates?: readonly SubAgentState[];
  readonly execution?: TaskExecutionStatus;
}

export interface TaskStore {
  create(description: string): Task;
  get(id: string): Task | undefined;
  list(): readonly Task[];
  update(id: string, updates: Partial<Pick<Task, "status" | "result" | "error" | "agentStates" | "execution">>): Task | undefined;
  remove(id: string): boolean;
}

export function createMemoryTaskStore(): TaskStore {
  const tasks = new Map<string, Task>();
  let nextId = 1;

  function create(description: string): Task {
    const now = Date.now();
    const task: Task = {
      id: String(nextId++),
      description,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      execution: {
        stage: "created",
        degraded: false,
      },
    };
    tasks.set(task.id, task);
    return task;
  }

  function get(id: string): Task | undefined {
    return tasks.get(id);
  }

  function list(): readonly Task[] {
    return [...tasks.values()];
  }

  function update(id: string, updates: Partial<Pick<Task, "status" | "result" | "error" | "agentStates" | "execution">>): Task | undefined {
    const task = tasks.get(id);
    if (!task) return undefined;

    const updated: Task = {
      ...task,
      ...updates,
      updatedAt: Date.now(),
    };
    tasks.set(id, updated);
    return updated;
  }

  function remove(id: string): boolean {
    return tasks.delete(id);
  }

  return { create, get, list, update, remove };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TaskRouteDeps {
  store: TaskStore;
  getContext: () => EvoAgentContext | undefined;
}

function getPlanDiagnosticsSummary(diagnostics: PlanDiagnostics): {
  readonly source: PlanDiagnostics["source"];
  readonly failureStage: PlanDiagnostics["failureStage"];
  readonly usedFallback: boolean;
  readonly hasProvider: boolean;
  readonly errorSummary?: string;
} {
  return {
    source: diagnostics.source,
    failureStage: diagnostics.failureStage,
    usedFallback: diagnostics.usedFallback,
    hasProvider: diagnostics.hasProvider,
    ...(diagnostics.errorSummary !== undefined ? { errorSummary: diagnostics.errorSummary } : {}),
  };
}

export function registerTaskRoutes(deps: TaskRouteDeps): RouteEntry[] {
  return [
    {
      method: "POST",
      pattern: "/tasks",
      auth: true,
      handler: async (req: HttpRequest) => {
        const body = req.body as Record<string, unknown> | null;
        if (!body || typeof body.description !== "string") {
          return errorResponse("Missing 'description' field", 400);
        }

        const task = deps.store.create(body.description);
        const ctx = deps.getContext();
        if (!ctx) {
          return jsonResponse(task, 201);
        }

        deps.store.update(task.id, {
          status: "running",
          execution: {
            stage: "running",
            degraded: false,
          },
        });

        try {
          const result = await ctx.chat(task.description);
          deps.store.update(task.id, {
            status: result.terminal.reason === "completed" ? "completed" : "failed",
            result: result.response,
            ...(result.terminal.reason !== "completed"
              ? { error: `task execution terminated: ${result.terminal.reason}` }
              : {}),
            execution: {
              stage: result.terminal.reason === "completed" ? "chat_completed" : "chat_terminated",
              degraded: result.terminal.reason !== "completed",
              terminalReason: result.terminal.reason,
            },
          });
        } catch (err) {
          deps.store.update(task.id, {
            status: "failed",
            error: `task execution failed: ${getErrorMessage(err)}`,
            execution: {
              stage: "chat_failed",
              degraded: true,
            },
          });
        }

        const updatedTask = deps.store.get(task.id);
        return jsonResponse(updatedTask ?? task, 201);
      },
    },
    {
      method: "GET",
      pattern: "/tasks",
      handler: () => {
        return jsonResponse(deps.store.list());
      },
    },
    {
      method: "GET",
      pattern: "/tasks/:id",
      handler: (req: HttpRequest) => {
        const id = req.params["id"];
        if (!id) return errorResponse("Missing task ID", 400);
        const task = deps.store.get(id);
        if (!task) return errorResponse("Task not found", 404);
        return jsonResponse(task);
      },
    },
    {
      method: "DELETE",
      pattern: "/tasks/:id",
      auth: true,
      handler: (req: HttpRequest) => {
        const id = req.params["id"];
        if (!id) return errorResponse("Missing task ID", 400);
        const removed = deps.store.remove(id);
        if (!removed) return errorResponse("Task not found", 404);
        return jsonResponse({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/tasks/plan",
      auth: true,
      handler: async (req: HttpRequest) => {
        const body = req.body as Record<string, unknown> | null;
        if (!body || typeof body.description !== "string") {
          return errorResponse("Missing 'description' field", 400);
        }

        const ctx = deps.getContext();
        if (!ctx) return errorResponse("Not configured", 503);

        try {
          const plan = await ctx.getOrchestrator().plan(body.description as string);
          return jsonResponse(plan);
        } catch (err) {
          return errorResponse(
            `Planning failed: ${getErrorMessage(err)}`,
            500,
          );
        }
      },
    },
    {
      method: "POST",
      pattern: "/tasks/execute",
      auth: true,
      handler: async (req: HttpRequest) => {
        const body = req.body as Record<string, unknown> | null;
        if (!body || typeof body.description !== "string") {
          return errorResponse("Missing 'description' field", 400);
        }

        const ctx = deps.getContext();
        if (!ctx) return errorResponse("Not configured", 503);

        try {
          const result = await ctx.chatComplex(body.description as string, []);
          return jsonResponse({
            success: result.terminal.reason === "completed",
            stage: result.terminal.reason === "completed" ? "completed" : "terminated",
            degraded: result.planDiagnostics.usedFallback,
            terminalReason: result.terminal.reason,
            agentCount: result.agentCount,
            result: result.response,
            durationMs: result.durationMs,
            planDiagnostics: getPlanDiagnosticsSummary(result.planDiagnostics),
          });
        } catch (err) {
          return errorResponse(
            `Execution failed: ${getErrorMessage(err)}`,
            500,
          );
        }
      },
    },
  ];
}

/**
 * TaskPlanner — LLM 任务分解 + 依赖图拓扑排序 + 优先级调度。
 *
 * 参考 SYSTEM_DESIGN.md 3.3.1 TaskPlanner 设计。
 * 支持 LLM 规划和简单降级规划两种模式。
 */

import type { LLMProvider, LLMMessageParam } from "../../interfaces/llm-provider";
import { extractJSONObject, safeJSONParse } from "../../utils/llm-parse";
import { z } from "zod";

const MAX_PLAN_STEPS = 10;
const MIN_PLAN_STEPS = 2;
const DEFAULT_TOKEN_BUDGET = 120000;
const DEFAULT_TIMEOUT_MS = 300_000;

export interface PlannedSubTask {
  readonly taskId: string;
  readonly type: "research" | "coding" | "generation" | "analysis" | "testing" | "custom";
  readonly description: string;
  readonly input: string;
  readonly expectedOutput: string;
  readonly tools: readonly string[];
  readonly knowledgeNeeded: readonly string[];
  readonly tokenBudget: number;
  readonly timeoutMs: number;
  readonly dependsOn: readonly string[];
  readonly priority: number;
}

export type PlanSource = "llm_success" | "llm_call_fallback" | "llm_parse_fallback" | "no_provider_simple" | "user_provided";
export type PlanFailureStage = "provider_invoke" | "response_parse" | "none";

export interface PlanDiagnostics {
  readonly source: PlanSource;
  readonly failureStage: PlanFailureStage;
  readonly usedFallback: boolean;
  readonly hasProvider: boolean;
  readonly errorSummary?: string;
}

export interface ExecutionPlan {
  readonly planId: string;
  readonly originalInput: string;
  readonly subTasks: readonly PlannedSubTask[];
  readonly totalTokenBudget: number;
  readonly createdAt: number;
  readonly diagnostics: PlanDiagnostics;
}

export interface TaskPlannerConfig {
  readonly provider?: LLMProvider;
  readonly maxSteps?: number;
  readonly defaultTokenBudget?: number;
  readonly defaultTimeoutMs?: number;
}

export interface TaskPlanner {
  plan(userInput: string): Promise<ExecutionPlan>;
}

export function createTaskPlanner(
  config?: TaskPlannerConfig,
): TaskPlanner {
  const maxSteps = config?.maxSteps ?? MAX_PLAN_STEPS;
  const defaultTokenBudget = config?.defaultTokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const defaultTimeoutMs = config?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function plan(userInput: string): Promise<ExecutionPlan> {
    if (config?.provider) {
      return planWithLLM(userInput, config.provider);
    }

    return planSimple(userInput, {
      source: "no_provider_simple",
      failureStage: "none",
      usedFallback: false,
      hasProvider: false,
    });
  }

  async function planWithLLM(
    userInput: string,
    provider: LLMProvider,
  ): Promise<ExecutionPlan> {
    const systemPrompt = `You are a task planner. Break down the user's request into 2-${maxSteps} sub-tasks.
For each sub-task, provide:
- type: one of "research", "coding", "generation", "analysis", "testing"
- description: what this sub-task does
- input: what data/input this sub-task needs
- expectedOutput: what this sub-task produces
- tools: array of tool names needed (e.g., ["bash", "file_read"])
- dependsOn: array of task IDs this depends on (empty for first tasks)

Respond in JSON format:
{
  "tasks": [
    {
      "type": "research",
      "description": "...",
      "input": "...",
      "expectedOutput": "...",
      "tools": ["bash", "file_read"],
      "dependsOn": []
    }
  ]
}

Use English field names in JSON output. Output ONLY the JSON object, no additional text.`;

    const messages: LLMMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInput },
    ];

    try {
      const response = await provider.invoke(messages);
      const content = typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

      try {
        let jsonStr = extractJSONObject(content);

        if (!jsonStr) {
          const stripped = content
            .replace(/```(?:json)?\s*\n?/gi, "")
            .replace(/\n?```\s*/g, "");
          jsonStr = extractJSONObject(stripped);
        }

        if (!jsonStr) {
          try {
            const rawParsed = safeJSONParse(content);
            if (typeof rawParsed === "object" && rawParsed !== null) {
              jsonStr = content;
            }
          } catch {
            void 0;
          }
        }

        if (!jsonStr) {
          return planSimple(userInput, {
            source: "llm_parse_fallback",
            failureStage: "response_parse",
            usedFallback: true,
            hasProvider: true,
            errorSummary: "LLM response did not contain a JSON object.",
          });
        }

        const rawParsed = safeJSONParse(jsonStr);

        const LLMPlanSchema = z.object({
          tasks: z.array(z.record(z.unknown())).optional(),
        });

        const validated = LLMPlanSchema.safeParse(rawParsed);
        if (!validated.success || !Array.isArray(validated.data.tasks) || validated.data.tasks.length === 0) {
          return planSimple(userInput, {
            source: "llm_parse_fallback",
            failureStage: "response_parse",
            usedFallback: true,
            hasProvider: true,
            errorSummary: "LLM response JSON did not contain a non-empty tasks array.",
          });
        }

        const subTasks = validated.data.tasks.slice(0, maxSteps).map((t, i) => {
          const task = t as Record<string, unknown>;
          return {
            taskId: `task_${String(i + 1).padStart(3, "0")}`,
            type: validateTaskType(task.type),
            description: String(task.description ?? `Sub-task ${i + 1}`),
            input: String(task.input ?? ""),
            expectedOutput: String(task.expected_output ?? task.expectedOutput ?? ""),
            tools: Array.isArray(task.tools) ? task.tools.map(String) : [],
            knowledgeNeeded: Array.isArray(task.knowledge_needed) ? task.knowledge_needed.map(String) : [],
            tokenBudget: typeof task.token_budget === "number" ? task.token_budget : defaultTokenBudget,
            timeoutMs: typeof task.timeout === "number" ? task.timeout : defaultTimeoutMs,
            dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
            priority: Math.max(MIN_PLAN_STEPS, maxSteps - i),
          } satisfies PlannedSubTask;
        });

        return buildExecutionPlan(userInput, subTasks, {
          source: "llm_success",
          failureStage: "none",
          usedFallback: false,
          hasProvider: true,
        });
      } catch (err) {
        return planSimple(userInput, {
          source: "llm_parse_fallback",
          failureStage: "response_parse",
          usedFallback: true,
          hasProvider: true,
          errorSummary: summarizeError(err),
        });
      }
    } catch (err) {
      return planSimple(userInput, {
        source: "llm_call_fallback",
        failureStage: "provider_invoke",
        usedFallback: true,
        hasProvider: true,
        errorSummary: summarizeError(err),
      });
    }
  }

  function planSimple(userInput: string, diagnostics: PlanDiagnostics): ExecutionPlan {
    const subTasks: PlannedSubTask[] = [
      {
        taskId: "task_001",
        type: "analysis",
        description: `Analyze the request: ${userInput}`,
        input: userInput,
        expectedOutput: "Analysis report with key findings",
        tools: ["file_read", "glob"],
        knowledgeNeeded: [],
        tokenBudget: defaultTokenBudget,
        timeoutMs: defaultTimeoutMs,
        dependsOn: [],
        priority: 2,
      },
      {
        taskId: "task_002",
        type: "generation",
        description: "Generate solution based on analysis",
        input: "$task_001.output",
        expectedOutput: "Implementation or solution",
        tools: ["bash", "file_write", "file_edit"],
        knowledgeNeeded: [],
        tokenBudget: defaultTokenBudget * 2,
        timeoutMs: defaultTimeoutMs * 2,
        dependsOn: ["task_001"],
        priority: 1,
      },
    ];

    return buildExecutionPlan(userInput, subTasks, diagnostics);
  }

  return { plan };
}

function validateTaskType(type: unknown): PlannedSubTask["type"] {
  const validTypes: ReadonlyArray<PlannedSubTask["type"]> = [
    "research", "coding", "generation", "analysis", "testing", "custom",
  ];
  if (typeof type === "string" && validTypes.includes(type as PlannedSubTask["type"])) {
    return type as PlannedSubTask["type"];
  }
  return "custom";
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildExecutionPlan(
  userInput: string,
  subTasks: readonly PlannedSubTask[],
  diagnostics: PlanDiagnostics,
): ExecutionPlan {
  return {
    planId: `plan_${Date.now()}`,
    originalInput: userInput,
    subTasks,
    totalTokenBudget: subTasks.reduce((sum, t) => sum + t.tokenBudget, 0),
    createdAt: Date.now(),
    diagnostics,
  };
}

export function topologicalSort(
  tasks: readonly PlannedSubTask[],
): string[] {
  const taskMap = new Map(tasks.map((t) => [t.taskId, t]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const task of tasks) {
    inDegree.set(task.taskId, 0);
    adjacency.set(task.taskId, []);
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (taskMap.has(dep)) {
        adjacency.get(dep)!.push(task.taskId);
        inDegree.set(task.taskId, (inDegree.get(task.taskId) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [taskId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(taskId);
    }
  }

  const result: string[] = [];
  while (queue.length > 0) {
    queue.sort((a, b) => {
      const taskA = taskMap.get(a);
      const taskB = taskMap.get(b);
      return (taskB?.priority ?? 0) - (taskA?.priority ?? 0);
    });

    const current = queue.shift()!;
    result.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (result.length !== tasks.length) {
    throw new Error("Circular dependency detected in execution plan");
  }

  return result;
}

export function getExecutableTasks(
  tasks: readonly PlannedSubTask[],
  completedTaskIds: ReadonlySet<string>,
): PlannedSubTask[] {
  return tasks.filter((task) =>
    task.dependsOn.every((dep) => completedTaskIds.has(dep)),
  );
}

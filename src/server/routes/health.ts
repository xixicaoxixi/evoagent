import type { RouteEntry, HttpRequest } from "../../server";
import { jsonResponse } from "../../server";
import type { EvoAgentContext } from "../../integration/context";

export interface HealthCheckResult {
  readonly status: "ok" | "degraded" | "unhealthy";
  readonly checks: {
    readonly ruleStore: ComponentHealth;
    readonly knowledgeManager: ComponentHealth;
    readonly llmProvider: ComponentHealth;
  };
  readonly uptime: number;
  readonly timestamp: number;
}

interface ComponentHealth {
  readonly status: "ok" | "degraded" | "unhealthy";
  readonly detail?: string;
}

async function checkRuleStore(ctx: EvoAgentContext): Promise<ComponentHealth> {
  try {
    const ruleStore = ctx.getRuleStore();
    const count = await ruleStore.count();
    await ruleStore.flush();
    return { status: "ok", detail: `${count} rules loaded` };
  } catch (err) {
    return {
      status: "unhealthy",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkKnowledgeManager(ctx: EvoAgentContext): Promise<ComponentHealth> {
  try {
    const km = ctx.getKnowledgeManager();
    const count = km.count();
    return { status: "ok", detail: `${count} memories loaded` };
  } catch (err) {
    return {
      status: "degraded",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkLLMProvider(ctx: EvoAgentContext): Promise<ComponentHealth> {
  try {
    const healthy = await ctx.provider.healthCheck();
    if (healthy) {
      return { status: "ok", detail: `${ctx.provider.providerType}/${ctx.provider.model} reachable` };
    }
    return { status: "unhealthy", detail: `${ctx.provider.providerType}/${ctx.provider.model} health check returned false` };
  } catch (err) {
    return {
      status: "unhealthy",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function aggregateStatus(checks: readonly ComponentHealth[]): "ok" | "degraded" | "unhealthy" {
  const statuses = checks.map((c) => c.status);
  if (statuses.includes("unhealthy")) return "unhealthy";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

export async function performDeepHealthCheck(ctx: EvoAgentContext, startTime: number): Promise<HealthCheckResult> {
  const [ruleStoreHealth, knowledgeHealth, llmHealth] = await Promise.all([
    checkRuleStore(ctx),
    checkKnowledgeManager(ctx),
    checkLLMProvider(ctx),
  ]);

  const checks = {
    ruleStore: ruleStoreHealth,
    knowledgeManager: knowledgeHealth,
    llmProvider: llmHealth,
  };

  return {
    status: aggregateStatus([ruleStoreHealth, knowledgeHealth, llmHealth]),
    checks,
    uptime: Date.now() - startTime,
    timestamp: Date.now(),
  };
}

export function registerHealthRoutes(deps: {
  readonly getContext: () => EvoAgentContext | undefined;
  readonly startTime: number;
}): readonly RouteEntry[] {
  return [
    {
      method: "GET",
      pattern: "/",
      handler: async (_req: HttpRequest) => {
        return jsonResponse({
          name: "EvoAgent API",
          version: "v1",
          endpoints: [
            "GET  /health",
            "GET  /config",
            "POST /chat",
            "GET  /tasks",
            "POST /tasks",
            "GET  /knowledge",
            "POST /knowledge",
            "GET  /evolution",
            "POST /evolution/analyze",
            "GET  /communication",
            "GET  /community",
            "GET  /analytics",
          ],
        });
      },
    },
    {
      method: "GET",
      pattern: "/health",
      handler: async (_req: HttpRequest) => {
        const ctx = deps.getContext();
        if (!ctx) {
          return jsonResponse({
            status: "degraded",
            checks: {
              ruleStore: { status: "unhealthy", detail: "No EvoAgentContext available" },
              knowledgeManager: { status: "unhealthy", detail: "No EvoAgentContext available" },
              llmProvider: { status: "unhealthy", detail: "No EvoAgentContext available" },
            },
            uptime: Date.now() - deps.startTime,
            timestamp: Date.now(),
          } satisfies HealthCheckResult, 503);
        }

        const result = await performDeepHealthCheck(ctx, deps.startTime);
        const httpStatus = result.status === "ok" ? 200 : result.status === "degraded" ? 200 : 503;
        return jsonResponse(result, httpStatus);
      },
    },
  ];
}

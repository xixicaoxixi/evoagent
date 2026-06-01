/**
 * 进化路由 — 连接真实 EvolutionEngine + RuleStore。
 *
 * GET /evolution — 进化引擎状态
 * GET /evolution/rules — 所有规则
 * GET /evolution/rules/:id — 单条规则
 * POST /evolution/rules/:id/activate — 激活规则
 * GET /evolution/stats — 进化统计
 * GET /evolution/ema — EMA 趋势
 * GET /evolution/budget — 触发预算
 */

import type { RouteEntry, HttpRequest } from "../../server";
import { jsonResponse, errorResponse } from "../../server";
import type { EvoAgentContext } from "../../integration/context";

// ─── 路由注册 ───

export interface EvolutionRouteDeps {
  getContext: () => EvoAgentContext | undefined;
}

export function registerEvolutionRoutes(deps: EvolutionRouteDeps): RouteEntry[] {
  return [
    {
      method: "GET",
      pattern: "/evolution",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });

        const state = ctx.getEvolutionEngine().getState();
        return jsonResponse(state);
      },
    },
    {
      method: "GET",
      pattern: "/evolution/rules",
      handler: async () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse([]);

        const rules = await ctx.getRuleStore().getAll();
        return jsonResponse(rules);
      },
    },
    {
      method: "GET",
      pattern: "/evolution/rules/:id",
      handler: async (req: HttpRequest) => {
        const ctx = deps.getContext();
        if (!ctx) return errorResponse("Not configured", 503);

        const id = req.params["id"];
        if (!id) return errorResponse("Missing rule ID", 400);

        const rule = await ctx.getRuleStore().getById(id);
        if (!rule) return errorResponse("Rule not found", 404);

        return jsonResponse(rule);
      },
    },
    {
      method: "POST",
      pattern: "/evolution/rules/:id/activate",
      auth: true,
      handler: async (req: HttpRequest) => {
        const ctx = deps.getContext();
        if (!ctx) return errorResponse("Not configured", 503);

        const id = req.params["id"];
        if (!id) return errorResponse("Missing rule ID", 400);

        const existing = await ctx.getRuleStore().getById(id);
        if (!existing) return errorResponse("Rule not found", 404);

        const updated = await ctx.getRuleStore().update(id, { status: "ACTIVE" as const });
        if (!updated) return errorResponse("Failed to activate rule", 500);

        return jsonResponse(updated);
      },
    },
    {
      method: "GET",
      pattern: "/evolution/stats",
      handler: async () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });

        const engine = ctx.getEvolutionEngine();
        const state = engine.getState();
        const ruleStore = ctx.getRuleStore();
        const allRules = await ruleStore.getAll();
        const activeRules = allRules.filter((r) => r.status === "ACTIVE");
        const sandboxRules = allRules.filter((r) => r.status === "SANDBOX");

        return jsonResponse({
          ...state,
          totalRules: allRules.length,
          activeRulesCount: activeRules.length,
          sandboxRulesCount: sandboxRules.length,
          avgConfidence: activeRules.length > 0
            ? activeRules.reduce((s, r) => s + r.success_rate, 0) / activeRules.length
            : 0,
        });
      },
    },
    {
      method: "GET",
      pattern: "/evolution/ema",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });

        const ema = ctx.getEvolutionEngine().getEMACalculator();
        return jsonResponse({
          currentValue: ema.getCurrent(),
          trend: ema.getTrend(),
          historyLength: ema.getHistory().length,
        });
      },
    },
    {
      method: "GET",
      pattern: "/evolution/budget",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });

        const budget = ctx.getEvolutionEngine().getTriggerBudget();
        return jsonResponse(budget.getState());
      },
    },
  ];
}

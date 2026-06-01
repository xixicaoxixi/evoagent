/**
 * 分析路由 — 连接真实 Analytics + StatsStore + CostTracker。
 *
 * GET /analytics/summary — 系统概览
 * GET /analytics/trends — 趋势数据
 * GET /analytics/cost — 成本统计
 * GET /analytics/performance — 性能指标
 * GET /analytics/observability — 可观测性状态
 */

import type { RouteEntry, HttpRequest } from "../../server";
import { jsonResponse } from "../../server";
import type { EvoAgentContext } from "../../integration/context";

// ─── 路由注册 ───

export interface AnalyticsRouteDeps {
  getContext: () => EvoAgentContext | undefined;
}

export function registerAnalyticsRoutes(deps: AnalyticsRouteDeps): RouteEntry[] {
  return [
    {
      method: "GET",
      pattern: "/analytics/summary",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });

        const analytics = ctx.getAnalytics();
        const summary = analytics.getSummary();

        const evolutionState = ctx.getEvolutionEngine().getState();
        const costTracker = ctx.getCostTracker();
        const statsStore = ctx.getStatsStore();
        const gateway = ctx.getGateway();

        return jsonResponse({
          ...summary,
          evolution: {
            totalTasks: evolutionState.totalTasks,
            successRate: evolutionState.globalSuccessRate,
            baselineRecorded: evolutionState.baselineRecorded,
          },
          cost: {
            totalCostUSD: costTracker.getTotalCost(),
            totalUsage: costTracker.getTotalUsage(),
          },
          network: {
            activePeers: gateway.getActivePeerCount(),
            gatewayStats: gateway.getStats(),
          },
          performance: {
            chatSuccesses: statsStore.getAll()["chat.successes"] ?? 0,
            chatFailures: statsStore.getAll()["chat.failures"] ?? 0,
            avgDurationMs: statsStore.getHistogram("chat.duration_ms"),
          },
        });
      },
    },
    {
      method: "GET",
      pattern: "/analytics/trends",
      handler: (req: HttpRequest) => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse([]);

        const metric = req.query.get("metric") ?? undefined;
        const analytics = ctx.getAnalytics();

        if (metric) {
          return jsonResponse(analytics.getTrend(metric, 50));
        }

        return jsonResponse({
          messages: analytics.getTrend("message", 20),
          taskSuccess: analytics.getTrend("task_success", 20),
          taskFailure: analytics.getTrend("task_failure", 20),
          toolCalls: analytics.getTrend("tool_call", 20),
        });
      },
    },
    {
      method: "GET",
      pattern: "/analytics/cost",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });

        const costTracker = ctx.getCostTracker();
        return jsonResponse({
          totalCost: costTracker.getTotalCost(),
          totalUsage: costTracker.getTotalUsage(),
          usageByModel: Object.fromEntries(costTracker.getUsageByModel()),
          formattedCost: costTracker.formatTotalCost(),
          formattedUsage: costTracker.formatModelUsage(),
        });
      },
    },
    {
      method: "GET",
      pattern: "/analytics/performance",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });

        const statsStore = ctx.getStatsStore();
        const allStats = statsStore.getAll();
        const durationHistogram = statsStore.getHistogram("chat.duration_ms");
        const complexDurationHistogram = statsStore.getHistogram("chat.complex_duration_ms");

        return jsonResponse({
          counters: allStats,
          chatDuration: durationHistogram,
          complexChatDuration: complexDurationHistogram,
          progress: ctx.getProgress(),
        });
      },
    },
    {
      method: "GET",
      pattern: "/analytics/observability",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });

        const statsStore = ctx.getStatsStore();
        const costTracker = ctx.getCostTracker();
        const progress = ctx.getProgress();
        const evolutionState = ctx.getEvolutionEngine().getState();
        const budget = ctx.getEvolutionEngine().getTriggerBudget();

        return jsonResponse({
          statsStore: {
            counters: statsStore.getAll(),
            histograms: {
              chatDuration: statsStore.getHistogram("chat.duration_ms"),
            },
          },
          costTracker: {
            totalCost: costTracker.getTotalCost(),
            usageByModel: Object.fromEntries(costTracker.getUsageByModel()),
          },
          progressTracker: progress,
          evolutionEngine: {
            state: evolutionState,
            budget: budget.getState(),
          },
        });
      },
    },
    {
      method: "GET",
      pattern: "/observability/status",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ progress: { toolUseCount: 0, tokenCount: 0, recentActivities: [] }, totalCost: 0, metrics: {} });

        const progress = ctx.getProgress();
        const costTracker = ctx.getCostTracker();
        const statsStore = ctx.getStatsStore();

        return jsonResponse({
          progress,
          totalCost: costTracker.getTotalCost(),
          metrics: statsStore.getAll(),
        });
      },
    },
  ];
}

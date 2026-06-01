/**
 * 市场路由 — 连接真实 Marketplace。
 */

import type { RouteEntry, HttpRequest } from "../../server";
import { jsonResponse, errorResponse } from "../../server";
import type { EvoAgentContext } from "../../integration/context";

export interface MarketplaceRouteDeps {
  getContext: () => EvoAgentContext | undefined;
}

export function registerMarketplaceRoutes(deps: MarketplaceRouteDeps): RouteEntry[] {
  return [
    {
      method: "GET",
      pattern: "/market/search",
      handler: (req: HttpRequest) => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse([]);

        const queryStr = req.query.get("q");
        const category = req.query.get("category");
        const marketplace = ctx.getMarketplace();
        const searchOpts: Record<string, unknown> = { limit: 20 };
        if (queryStr) searchOpts.query = queryStr;
        if (category) searchOpts.category = category;
        const results = marketplace.search(searchOpts as Parameters<typeof marketplace.search>[0]);
        return jsonResponse(results);
      },
    },
    {
      method: "GET",
      pattern: "/market/trending",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse([]);

        const marketplace = ctx.getMarketplace();
        return jsonResponse(marketplace.getTrending(10));
      },
    },
    {
      method: "POST",
      pattern: "/market/publish",
      auth: true,
      handler: (req: HttpRequest) => {
        const body = req.body as Record<string, unknown> | null;
        if (!body || typeof body.title !== "string") {
          return errorResponse("Missing 'title'", 400);
        }

        const ctx = deps.getContext();
        if (!ctx) return errorResponse("Not configured", 503);

        try {
          const marketplace = ctx.getMarketplace();
          const item = marketplace.publish({
            itemType: (body.itemType as "rule" | "knowledge" | "tool_template") ?? "knowledge",
            title: body.title as string,
            description: typeof body.description === "string" ? body.description : "",
            authorId: typeof body.authorId === "string" ? body.authorId : "self",
            content: typeof body.content === "object" && body.content !== null ? body.content as Record<string, unknown> : {},
            tags: Array.isArray(body.tags) ? body.tags as string[] : [],
            category: typeof body.category === "string" ? body.category : "general",
            difficulty: (body.difficulty as "beginner" | "intermediate" | "advanced") ?? "intermediate",
          });

          ctx.getAnalytics().recordEvent("market_publish", 1);
          return jsonResponse(item, 201);
        } catch (err) {
          return errorResponse(
            `Publish failed: ${err instanceof Error ? err.message : "Unknown error"}`,
            500,
          );
        }
      },
    },
    {
      method: "POST",
      pattern: "/market/rate/:id",
      auth: true,
      handler: (req: HttpRequest) => {
        const body = req.body as Record<string, unknown> | null;
        const score = typeof body?.score === "number" ? body.score : undefined;
        if (score === undefined || score < 0 || score > 5) {
          return errorResponse("Invalid 'score' (0-5)", 400);
        }
        const itemId = req.params["id"];
        if (!itemId) return errorResponse("Missing item ID", 400);

        const ctx = deps.getContext();
        if (!ctx) return errorResponse("Not configured", 503);

        const userId = typeof body?.userId === "string" ? body.userId : "self";
        const marketplace = ctx.getMarketplace();
        const success = marketplace.rateItem(itemId, score, userId);
        if (!success) return errorResponse("Item not found or rating failed", 404);

        return jsonResponse({ ok: true, itemId, score });
      },
    },
    {
      method: "GET",
      pattern: "/market/stats",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });

        const marketplace = ctx.getMarketplace();
        return jsonResponse({
          totalItems: marketplace.count(),
        });
      },
    },
  ];
}

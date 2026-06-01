/**
 * 社区路由 — 连接真实 Community + ReputationSystem。
 */

import type { RouteEntry, HttpRequest } from "../../server";
import { jsonResponse, errorResponse } from "../../server";
import type { EvoAgentContext } from "../../integration/context";

export interface CommunityRouteDeps {
  getContext: () => EvoAgentContext | undefined;
}

export function registerCommunityRoutes(deps: CommunityRouteDeps): RouteEntry[] {
  return [
    {
      method: "GET",
      pattern: "/community/proposals",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse([]);

        const community = ctx.getCommunity();
        return jsonResponse(community.getOpenProposals());
      },
    },
    {
      method: "POST",
      pattern: "/community/proposals",
      auth: true,
      handler: (req: HttpRequest) => {
        const body = req.body as Record<string, unknown> | null;
        if (!body || typeof body.title !== "string") {
          return errorResponse("Missing 'title'", 400);
        }

        const ctx = deps.getContext();
        if (!ctx) return errorResponse("Not configured", 503);

        try {
          const community = ctx.getCommunity();
          const proposal = community.createProposal({
            proposalType: (body.proposalType as "parameter_change" | "rule_promotion" | "network_policy" | "emergency") ?? "parameter_change",
            title: body.title as string,
            description: typeof body.description === "string" ? body.description : "",
            authorId: typeof body.authorId === "string" ? body.authorId : "self",
            passThreshold: typeof body.passThreshold === "number" ? body.passThreshold : 0.6,
            minVoters: typeof body.minVoters === "number" ? body.minVoters : 3,
            votingHours: typeof body.votingHours === "number" ? body.votingHours : 168,
          });

          ctx.getAnalytics().recordEvent("proposal_created", 1);
          return jsonResponse(proposal, 201);
        } catch (err) {
          return errorResponse(
            `Proposal creation failed: ${err instanceof Error ? err.message : "Unknown error"}`,
            500,
          );
        }
      },
    },
    {
      method: "POST",
      pattern: "/community/proposals/:id/vote",
      auth: true,
      handler: (req: HttpRequest) => {
        const body = req.body as Record<string, unknown> | null;
        const support = body?.support === true;
        const proposalId = req.params["id"];
        if (!proposalId) return errorResponse("Missing proposal ID", 400);

        const ctx = deps.getContext();
        if (!ctx) return errorResponse("Not configured", 503);

        const voterId = typeof body?.voterId === "string" ? body.voterId : "self";

        try {
          const community = ctx.getCommunity();
          const voterTier = ctx.getReputationSystem().getTier(0);
          const result = community.vote(proposalId, voterId, support, voterTier);

          ctx.getAnalytics().recordEvent("vote_cast", 1);
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(
            `Vote failed: ${err instanceof Error ? err.message : "Unknown error"}`,
            500,
          );
        }
      },
    },
    {
      method: "GET",
      pattern: "/community/leaderboard",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse([]);

        const reputation = ctx.getReputationSystem();
        return jsonResponse(reputation.listAll());
      },
    },
    {
      method: "GET",
      pattern: "/community/stats",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });

        const community = ctx.getCommunity();
        const stats = community.getProposalStats();
        return jsonResponse(stats);
      },
    },
    {
      method: "GET",
      pattern: "/community/status",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ total: 0, open: 0, passed: 0, rejected: 0, expired: 0 });

        const community = ctx.getCommunity();
        const stats = community.getProposalStats();
        return jsonResponse(stats);
      },
    },
  ];
}

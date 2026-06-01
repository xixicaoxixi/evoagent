/**
 * 通信路由 — 连接真实 Gateway + ConsensusEngine + ReputationSystem。
 */

import type { RouteEntry, HttpRequest } from "../../server";
import { jsonResponse, errorResponse } from "../../server";
import type { EvoAgentContext } from "../../integration/context";
import { createPeerMessage } from "../../communication/protocol";

export interface CommunicationRouteDeps {
  getContext: () => EvoAgentContext | undefined;
}

export function registerCommunicationRoutes(deps: CommunicationRouteDeps): RouteEntry[] {
  return [
    {
      method: "GET",
      pattern: "/net/peers",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse([]);
        return jsonResponse(ctx.getGateway().listPeers());
      },
    },
    {
      method: "POST",
      pattern: "/net/connect",
      auth: true,
      handler: (req: HttpRequest) => {
        const body = req.body as Record<string, unknown> | null;
        if (!body || typeof body.instanceId !== "string") {
          return errorResponse("Missing 'instanceId'", 400);
        }
        const ctx = deps.getContext();
        if (!ctx) return errorResponse("Not configured", 503);

        const gateway = ctx.getGateway();
        const added = gateway.addPeer({
          instanceId: body.instanceId as string,
          instanceName: typeof body.instanceName === "string" ? body.instanceName : body.instanceId as string,
          host: typeof body.host === "string" ? body.host : "localhost",
          port: typeof body.port === "number" ? body.port : 3000,
          trustScore: 0.5,
          publicKey: typeof body.publicKey === "string" ? body.publicKey : "",
          capabilities: Array.isArray(body.capabilities) ? body.capabilities as string[] : [],
          registeredAt: Date.now(),
          lastHeartbeat: Date.now(),
          messageCount: 0,
          rejectedCount: 0,
        });

        if (!added) {
          return errorResponse("Failed to add peer (duplicate or limit reached)", 409);
        }

        ctx.getAnalytics().recordEvent("peer_connected", 1);
        return jsonResponse({ instanceId: body.instanceId, connected: true }, 201);
      },
    },
    {
      method: "POST",
      pattern: "/messages",
      auth: true,
      handler: (req: HttpRequest) => {
        const body = req.body as Record<string, unknown> | null;
        if (!body || typeof body.type !== "string") {
          return errorResponse("Missing 'type'", 400);
        }
        const ctx = deps.getContext();
        if (!ctx) return errorResponse("Not configured", 503);

        const gateway = ctx.getGateway();
        const message = createPeerMessage({
          message_id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sender_id: typeof body.from === "string" ? body.from : "self",
          receiver_id: typeof body.to === "string" ? body.to : "broadcast",
          message_type: body.type as "knowledge_offer",
          payload: (typeof body.payload === "object" && body.payload !== null) ? body.payload as Record<string, unknown> : {},
        });
        const result = gateway.handleMessage(message);

        ctx.getAnalytics().recordEvent("message", 1);
        return jsonResponse({ accepted: result.accepted, reason: result.reason }, result.accepted ? 201 : 200);
      },
    },
    {
      method: "GET",
      pattern: "/net/consensus",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });

        const gateway = ctx.getGateway();
        const peers = gateway.listPeers();
        const trusted = peers.filter((p) => p.trustScore >= 0.7).length;

        return jsonResponse({ totalEndorsements: 0, trustedPeers: trusted, activePeers: peers.length });
      },
    },
    {
      method: "GET",
      pattern: "/net/reputation/:id",
      handler: (req: HttpRequest) => {
        const ctx = deps.getContext();
        if (!ctx) return errorResponse("Not configured", 503);

        const id = req.params["id"];
        if (!id) return errorResponse("Missing instance ID", 400);

        const reputation = ctx.getReputationSystem().getReputation(id);
        if (!reputation) return errorResponse("Reputation not found", 404);
        return jsonResponse(reputation);
      },
    },
    {
      method: "GET",
      pattern: "/net/stats",
      handler: () => {
        const ctx = deps.getContext();
        if (!ctx) return jsonResponse({ configured: false });
        return jsonResponse(ctx.getGateway().getStats());
      },
    },
  ];
}

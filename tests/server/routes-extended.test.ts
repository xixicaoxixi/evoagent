import { describe, it, expect } from "vitest";
import type { HttpRequest, HttpResponse, RouteEntry, StreamHttpResponse } from "../../src/server";
import { registerCommunicationRoutes } from "../../src/server/routes/communication";
import { registerMarketplaceRoutes } from "../../src/server/routes/marketplace";
import { registerCommunityRoutes } from "../../src/server/routes/community";
import { registerAnalyticsRoutes } from "../../src/server/routes/analytics";

const noContext = () => undefined;

type TestRoute = Pick<RouteEntry, "pattern" | "method" | "handler">;
type SyncHttpResponse = HttpResponse | StreamHttpResponse;

function findRoute(routes: readonly RouteEntry[], pattern: string, method: RouteEntry["method"]): TestRoute {
  const route = routes.find((candidate) => candidate.pattern === pattern && candidate.method === method);
  expect(route).toBeDefined();
  return route as TestRoute;
}

function makeReq(
  method: HttpRequest["method"] = "GET",
  body: unknown = null,
  params: Record<string, string> = {},
  query: URLSearchParams = new URLSearchParams(),
): HttpRequest {
  return {
    method,
    url: `/api/v1${Object.keys(params).length > 0 ? "/placeholder" : ""}`,
    body,
    params,
    query,
    headers: new Headers(),
    remoteAddress: "127.0.0.1",
    context: {},
  };
}

function assertJsonResponse(response: SyncHttpResponse): HttpResponse {
  expect(response.body).not.toBeInstanceOf(ReadableStream);
  return response as HttpResponse;
}

describe("Phase G > G.3 > 通信路由", () => {
  it("GET /net/peers 无 context 返回空数组", async () => {
    const routes = registerCommunicationRoutes({ getContext: noContext });
    const route = findRoute(routes, "/net/peers", "GET");
    const resp = await route.handler(makeReq());
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(200);
    expect(Array.isArray(json.body)).toBe(true);
  });

  it("GET /net/consensus 无 context 返回 configured:false", async () => {
    const routes = registerCommunicationRoutes({ getContext: noContext });
    const route = findRoute(routes, "/net/consensus", "GET");
    const resp = await route.handler(makeReq());
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(200);
    expect((json.body as { configured: boolean }).configured).toBe(false);
  });

  it("POST /net/connect 缺少 instanceId 返回 400", async () => {
    const routes = registerCommunicationRoutes({ getContext: noContext });
    const route = findRoute(routes, "/net/connect", "POST");
    const resp = await route.handler(makeReq("POST", {}));
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(400);
    expect((json.body as { error: string }).error).toBe("Missing 'instanceId'");
  });

  it("GET /net/reputation/:id 无 context 返回 503", async () => {
    const routes = registerCommunicationRoutes({ getContext: noContext });
    const route = findRoute(routes, "/net/reputation/:id", "GET");
    const resp = await route.handler(makeReq("GET", null, { id: "peer-1" }));
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(503);
    expect((json.body as { error: string }).error).toBe("Not configured");
  });
});

describe("Phase G > G.3 > 市场路由", () => {
  it("GET /market/search 无 context 返回空数组", async () => {
    const routes = registerMarketplaceRoutes({ getContext: noContext });
    const route = findRoute(routes, "/market/search", "GET");
    const resp = await route.handler(makeReq());
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(200);
    expect(Array.isArray(json.body)).toBe(true);
  });

  it("GET /market/trending 无 context 返回空数组", async () => {
    const routes = registerMarketplaceRoutes({ getContext: noContext });
    const route = findRoute(routes, "/market/trending", "GET");
    const resp = await route.handler(makeReq());
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(200);
    expect(Array.isArray(json.body)).toBe(true);
  });

  it("GET /market/stats 无 context 返回 configured:false", async () => {
    const routes = registerMarketplaceRoutes({ getContext: noContext });
    const route = findRoute(routes, "/market/stats", "GET");
    const resp = await route.handler(makeReq());
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(200);
    expect((json.body as { configured: boolean }).configured).toBe(false);
  });

  it("POST /market/publish 缺少 title 返回 400", async () => {
    const routes = registerMarketplaceRoutes({ getContext: noContext });
    const route = findRoute(routes, "/market/publish", "POST");
    const resp = await route.handler(makeReq("POST", {}));
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(400);
    expect((json.body as { error: string }).error).toBe("Missing 'title'");
  });

  it("POST /market/rate/:id score 非法返回 400", async () => {
    const routes = registerMarketplaceRoutes({ getContext: noContext });
    const route = findRoute(routes, "/market/rate/:id", "POST");
    const resp = await route.handler(makeReq("POST", { score: 8 }, { id: "item-1" }));
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(400);
    expect((json.body as { error: string }).error).toBe("Invalid 'score' (0-5)");
  });
});

describe("Phase G > G.3 > 社区路由", () => {
  it("GET /community/proposals 无 context 返回空数组", async () => {
    const routes = registerCommunityRoutes({ getContext: noContext });
    const route = findRoute(routes, "/community/proposals", "GET");
    const resp = await route.handler(makeReq());
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(200);
    expect(Array.isArray(json.body)).toBe(true);
  });

  it("GET /community/stats 无 context 返回 configured:false", async () => {
    const routes = registerCommunityRoutes({ getContext: noContext });
    const route = findRoute(routes, "/community/stats", "GET");
    const resp = await route.handler(makeReq());
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(200);
    expect((json.body as { configured: boolean }).configured).toBe(false);
  });

  it("POST /community/proposals 缺少 title 返回 400", async () => {
    const routes = registerCommunityRoutes({ getContext: noContext });
    const route = findRoute(routes, "/community/proposals", "POST");
    const resp = await route.handler(makeReq("POST", {}));
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(400);
    expect((json.body as { error: string }).error).toBe("Missing 'title'");
  });

  it("POST /community/proposals/:id/vote 缺少 context 返回 503", async () => {
    const routes = registerCommunityRoutes({ getContext: noContext });
    const route = findRoute(routes, "/community/proposals/:id/vote", "POST");
    const resp = await route.handler(makeReq("POST", { support: true }, { id: "proposal-1" }));
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(503);
    expect((json.body as { error: string }).error).toBe("Not configured");
  });
});

describe("Phase G > G.3 > 分析路由", () => {
  it("GET /analytics/summary 无 context 返回 configured:false", async () => {
    const routes = registerAnalyticsRoutes({ getContext: noContext });
    const route = findRoute(routes, "/analytics/summary", "GET");
    const resp = await route.handler(makeReq());
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(200);
    expect((json.body as { configured: boolean }).configured).toBe(false);
  });

  it("GET /analytics/trends 无 context 返回空数组", async () => {
    const routes = registerAnalyticsRoutes({ getContext: noContext });
    const route = findRoute(routes, "/analytics/trends", "GET");
    const resp = await route.handler(makeReq());
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(200);
    expect(Array.isArray(json.body)).toBe(true);
  });

  it("GET /analytics/cost 无 context 返回 configured:false", async () => {
    const routes = registerAnalyticsRoutes({ getContext: noContext });
    const route = findRoute(routes, "/analytics/cost", "GET");
    const resp = await route.handler(makeReq());
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(200);
    expect((json.body as { configured: boolean }).configured).toBe(false);
  });

  it("GET /analytics/observability 无 context 返回 configured:false", async () => {
    const routes = registerAnalyticsRoutes({ getContext: noContext });
    const route = findRoute(routes, "/analytics/observability", "GET");
    const resp = await route.handler(makeReq());
    const json = assertJsonResponse(resp);
    expect(json.status).toBe(200);
    expect((json.body as { configured: boolean }).configured).toBe(false);
  });
});

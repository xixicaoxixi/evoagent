import { describe, test, expect, vi } from "vitest";
import type { HttpRequest, HttpResponse, RouteEntry } from "../../src/server";
import { registerConfigRoutes } from "../../src/server/routes/config";
import { createProviderConfigStore } from "../../src/core/provider-config";

function findRoute(routes: readonly RouteEntry[], pattern: string, method: RouteEntry["method"]) {
  const route = routes.find((candidate) => candidate.pattern === pattern && candidate.method === method);
  expect(route).toBeDefined();
  return route as Pick<RouteEntry, "pattern" | "method" | "handler">;
}

function createRequest(method: HttpRequest["method"], body: unknown = null): HttpRequest {
  return {
    method,
    url: `/api/v1/config${method === "POST" ? "/provider" : ""}`,
    params: {},
    query: new URLSearchParams(),
    headers: new Headers(),
    body,
    remoteAddress: "127.0.0.1",
    context: {},
  };
}

function assertJsonResponse(response: HttpResponse | Promise<HttpResponse>): Promise<HttpResponse> {
  return Promise.resolve(response);
}

describe("配置路由", () => {
  test("GET /config/providers 返回支持的 Provider 列表", async () => {
    const routes = registerConfigRoutes({
      configStore: createProviderConfigStore(),
    });

    const route = findRoute(routes, "/config/providers", "GET");
    const response = await assertJsonResponse(route.handler(createRequest("GET")));

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toContain("deepseek");
    expect(response.body).toContain("openai");
  });

  test("GET /config/provider 在未配置时返回 sourceSnapshot", async () => {
    const routes = registerConfigRoutes({
      configStore: createProviderConfigStore(),
    });

    const route = findRoute(routes, "/config/provider", "GET");
    const response = await assertJsonResponse(route.handler(createRequest("GET")));

    expect(response.status).toBe(200);
    expect((response.body as { configured: boolean }).configured).toBe(false);
    expect((response.body as { sourceSnapshot: unknown }).sourceSnapshot).toEqual({
      effective: "unconfigured",
      provider: { source: "unconfigured", detail: "No provider configuration has been applied." },
      model: { source: "unconfigured", detail: "No provider configuration has been applied." },
      baseUrl: { source: "unconfigured", detail: "No provider configuration has been applied." },
    });
  });

  test("GET /config/provider 返回配置来源与快照", async () => {
    const configStore = createProviderConfigStore();
    await configStore.applyAutoDetectedProvider({
      context: {} as never,
      providerType: "deepseek",
      apiKey: "sk-env",
      model: "deepseek-chat",
      source: "env_auto_detected",
      sourceDetail: "from DEEPSEEK_API_KEY",
    });
    const routes = registerConfigRoutes({ configStore });

    const route = findRoute(routes, "/config/provider", "GET");
    const response = await assertJsonResponse(route.handler(createRequest("GET")));

    expect(response.status).toBe(200);
    expect((response.body as { configured: boolean }).configured).toBe(true);
    expect((response.body as { source: string }).source).toBe("env_auto_detected");
    expect((response.body as { sourceDetail: string }).sourceDetail).toBe("from DEEPSEEK_API_KEY");
    expect((response.body as { sourceSnapshot: { effective: string } }).sourceSnapshot.effective).toBe("env_auto_detected");
    expect((response.body as { sourceSnapshot: { provider: { detail: string } } }).sourceSnapshot.provider.detail).toBe("from DEEPSEEK_API_KEY");
  });

  test("GET /config/status 返回 provider/source/sourceSnapshot", async () => {
    const configStore = createProviderConfigStore();
    const getStatusMock = vi.fn(async () => ({
      ...configStore.getSnapshot(),
      configured: true,
      healthy: true,
      provider: "openai",
      model: "gpt-5.4",
      apiKeyPreview: "sk-r...time",
      source: {
        effective: "runtime_override",
        provider: { source: "runtime_override", detail: "from ./.evoagent/provider.json", value: "openai" },
        model: { source: "runtime_override", detail: "from ./.evoagent/provider.json", value: "gpt-5.4" },
        baseUrl: { source: "unconfigured", detail: "No provider configuration has been applied." },
      },
    }));
    const routes = registerConfigRoutes({
      configStore: {
        ...configStore,
        getStatus: getStatusMock,
      },
    });

    const route = findRoute(routes, "/config/status", "GET");
    const response = await assertJsonResponse(route.handler(createRequest("GET")));

    expect(response.status).toBe(200);
    expect((response.body as { provider: string }).provider).toBe("openai");
    expect((response.body as { source: string }).source).toBe("runtime_override");
    expect((response.body as { sourceDetail: string }).sourceDetail).toBe("from ./.evoagent/provider.json");
    expect((response.body as { sourceSnapshot: { effective: string } }).sourceSnapshot.effective).toBe("runtime_override");
    expect((response.body as { sourceSnapshot: { provider: unknown } }).sourceSnapshot.provider).toEqual({
      source: "runtime_override",
      detail: "from ./.evoagent/provider.json",
      value: "openai",
    });
    expect((response.body as { sourceSnapshot: { model: unknown } }).sourceSnapshot.model).toEqual({
      source: "runtime_override",
      detail: "from ./.evoagent/provider.json",
      value: "gpt-5.4",
    });
    expect((response.body as { sourceSnapshot: { baseUrl: { source: string } } }).sourceSnapshot.baseUrl.source).toBe("unconfigured");
  });

  test("POST /config/provider 缺少 provider_type 返回 400", async () => {
    const routes = registerConfigRoutes({
      configStore: createProviderConfigStore(),
    });

    const route = findRoute(routes, "/config/provider", "POST");
    const response = await assertJsonResponse(route.handler(createRequest("POST", {})));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Missing 'provider_type' field", status: 400 });
  });

  test("POST /config/provider 非 ollama 且缺少 api_key 返回 400", async () => {
    const routes = registerConfigRoutes({
      configStore: createProviderConfigStore(),
    });

    const route = findRoute(routes, "/config/provider", "POST");
    const response = await assertJsonResponse(route.handler(createRequest("POST", { provider_type: "openai" })));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Missing 'api_key' field", status: 400 });
  });

  test("POST /config/provider setProvider 失败时返回 500 与错误上下文", async () => {
    const configStore = createProviderConfigStore();
    const setProviderMock = vi.fn(async () => {
      throw new Error("boom");
    });
    const routes = registerConfigRoutes({
      configStore: {
        ...configStore,
        setProvider: setProviderMock,
      },
    });

    const route = findRoute(routes, "/config/provider", "POST");
    const response = await assertJsonResponse(
      route.handler(createRequest("POST", { provider_type: "openai", api_key: "sk-test" })),
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Failed to update provider: boom", status: 500 });
  });
});

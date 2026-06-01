import { describe, it, expect } from "vitest";
import type { HttpRequest, HttpResponse, RouteEntry, StreamHttpResponse } from "../../src/server";
import { registerTaskRoutes, createMemoryTaskStore } from "../../src/server/routes/tasks";
import { registerEvolutionRoutes } from "../../src/server/routes/evolution";
import { registerKnowledgeRoutes, createMemoryKnowledgeStore } from "../../src/server/routes/knowledge";

const noContext = () => undefined;

type TestRoute = Pick<RouteEntry, "pattern" | "method" | "handler">;
type SyncHttpResponse = HttpResponse | StreamHttpResponse;

function findRoute(routes: readonly RouteEntry[], pattern: string, method: RouteEntry["method"]): TestRoute {
  const route = routes.find((candidate) => candidate.pattern === pattern && candidate.method === method);
  expect(route).toBeDefined();
  return route as TestRoute;
}

function createRequest(
  method: HttpRequest["method"],
  body: unknown,
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

describe("Phase G > G.2", () => {
  describe("任务路由", () => {
    it("POST /tasks 创建任务", async () => {
      const store = createMemoryTaskStore();
      const routes = registerTaskRoutes({ store, getContext: noContext });
      const route = findRoute(routes, "/tasks", "POST");

      const resp = await route.handler(createRequest("POST", { description: "Test task" }));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(201);
      expect((json.body as { description: string }).description).toBe("Test task");
      expect((json.body as { id: string }).id).toBeDefined();
      expect((json.body as { execution: unknown }).execution).toEqual({
        stage: "created",
        degraded: false,
      });
    });

    it("POST /tasks 缺少 description 返回 400", async () => {
      const store = createMemoryTaskStore();
      const routes = registerTaskRoutes({ store, getContext: noContext });
      const route = findRoute(routes, "/tasks", "POST");

      const resp = await route.handler(createRequest("POST", {}));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(400);
    });

    it("POST /tasks 在执行异常时保留失败上下文", async () => {
      const store = createMemoryTaskStore();
      const routes = registerTaskRoutes({
        store,
        getContext: () => ({
          chat: async () => {
            throw new Error("boom");
          },
        }) as never,
      });
      const route = findRoute(routes, "/tasks", "POST");

      const resp = await route.handler(createRequest("POST", { description: "Failing task" }));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(201);
      expect((json.body as { status: string }).status).toBe("failed");
      expect((json.body as { error: string }).error).toBe("task execution failed: boom");
      expect((json.body as { execution: unknown }).execution).toEqual({
        stage: "chat_failed",
        degraded: true,
      });
    });

    it("POST /tasks 在终止时保留终止阶段信息", async () => {
      const store = createMemoryTaskStore();
      const routes = registerTaskRoutes({
        store,
        getContext: () => ({
          chat: async () => ({
            response: "",
            terminal: { reason: "aborted" },
          }),
        }) as never,
      });
      const route = findRoute(routes, "/tasks", "POST");

      const resp = await route.handler(createRequest("POST", { description: "Aborted task" }));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(201);
      expect((json.body as { status: string }).status).toBe("failed");
      expect((json.body as { error: string }).error).toBe("task execution terminated: aborted");
      expect((json.body as { execution: unknown }).execution).toEqual({
        stage: "chat_terminated",
        degraded: true,
        terminalReason: "aborted",
      });
    });

    it("POST /tasks/execute 返回最小可观测状态", async () => {
      const store = createMemoryTaskStore();
      const routes = registerTaskRoutes({
        store,
        getContext: () => ({
          chatComplex: async () => ({
            terminal: { reason: "completed" },
            planDiagnostics: {
              source: "planner",
              failureStage: "none",
              usedFallback: true,
              hasProvider: true,
              errorSummary: undefined,
            },
            agentCount: 2,
            response: "done",
            durationMs: 123,
          }),
        }) as never,
      });
      const route = findRoute(routes, "/tasks/execute", "POST");

      const resp = await route.handler(createRequest("POST", { description: "Complex task" }));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(200);
      expect((json.body as { success: boolean }).success).toBe(true);
      expect((json.body as { stage: string }).stage).toBe("completed");
      expect((json.body as { degraded: boolean }).degraded).toBe(true);
      expect((json.body as { terminalReason: string }).terminalReason).toBe("completed");
      expect((json.body as { planDiagnostics: unknown }).planDiagnostics).toEqual({
        source: "planner",
        failureStage: "none",
        usedFallback: true,
        hasProvider: true,
      });
    });

    it("GET /tasks 列出所有任务", async () => {
      const store = createMemoryTaskStore();
      store.create("Task 1");
      store.create("Task 2");
      const routes = registerTaskRoutes({ store, getContext: noContext });
      const route = findRoute(routes, "/tasks", "GET");

      const resp = await route.handler(createRequest("GET", null));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(200);
      expect((json.body as unknown[]).length).toBe(2);
    });

    it("GET /tasks/:id 获取单个任务", async () => {
      const store = createMemoryTaskStore();
      const task = store.create("Single task");
      const routes = registerTaskRoutes({ store, getContext: noContext });
      const route = findRoute(routes, "/tasks/:id", "GET");

      const resp = await route.handler(createRequest("GET", null, { id: task.id }));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(200);
      expect((json.body as { id: string }).id).toBe(task.id);
    });

    it("GET /tasks/:id 不存在返回 404", async () => {
      const store = createMemoryTaskStore();
      const routes = registerTaskRoutes({ store, getContext: noContext });
      const route = findRoute(routes, "/tasks/:id", "GET");

      const resp = await route.handler(createRequest("GET", null, { id: "missing" }));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(404);
    });

    it("DELETE /tasks/:id 删除任务", async () => {
      const store = createMemoryTaskStore();
      const task = store.create("Delete me");
      const routes = registerTaskRoutes({ store, getContext: noContext });
      const route = findRoute(routes, "/tasks/:id", "DELETE");

      const resp = await route.handler(createRequest("DELETE", null, { id: task.id }));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(200);
      expect((json.body as { ok: boolean }).ok).toBe(true);
      expect(store.get(task.id)).toBeUndefined();
    });

    it("TaskStore update 更新任务状态", () => {
      const store = createMemoryTaskStore();
      const task = store.create("Update me");
      const updated = store.update(task.id, { status: "completed" });
      expect(updated?.status).toBe("completed");
    });
  });

  describe("进化路由", () => {
    it("GET /evolution 无 context 返回 configured:false", async () => {
      const routes = registerEvolutionRoutes({ getContext: noContext });
      const route = findRoute(routes, "/evolution", "GET");

      const resp = await route.handler(createRequest("GET", null));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(200);
      expect((json.body as { configured: boolean }).configured).toBe(false);
    });

    it("GET /evolution/rules 无 context 返回空数组", async () => {
      const routes = registerEvolutionRoutes({ getContext: noContext });
      const route = findRoute(routes, "/evolution/rules", "GET");

      const resp = await route.handler(createRequest("GET", null));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(200);
      expect(json.body).toEqual([]);
    });

    it("GET /evolution/stats 无 context 返回 configured:false", async () => {
      const routes = registerEvolutionRoutes({ getContext: noContext });
      const route = findRoute(routes, "/evolution/stats", "GET");

      const resp = await route.handler(createRequest("GET", null));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(200);
      expect((json.body as { configured: boolean }).configured).toBe(false);
    });
  });

  describe("知识库路由", () => {
    it("GET /knowledge 返回知识库摘要", async () => {
      const store = createMemoryKnowledgeStore();
      store.inject({ content: "fact 1", type: "fact", confidence: 0.9 });
      const routes = registerKnowledgeRoutes({ store, getContext: noContext });
      const route = findRoute(routes, "/knowledge", "GET");

      const resp = await route.handler(createRequest("GET", null));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(200);
      expect((json.body as { total: number }).total).toBe(1);
    });

    it("GET /knowledge/search 搜索知识", async () => {
      const store = createMemoryKnowledgeStore();
      store.inject({ content: "TypeScript is a typed superset of JavaScript", type: "fact", confidence: 0.95 });
      const routes = registerKnowledgeRoutes({ store, getContext: noContext });
      const route = findRoute(routes, "/knowledge/search", "GET");

      const resp = await route.handler(createRequest("GET", null, {}, new URLSearchParams("q=TypeScript")));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(200);
      expect((json.body as unknown[]).length).toBe(1);
      expect(((json.body as Array<{ entry: { content: string } }>)[0]?.entry.content)).toContain("TypeScript");
    });

    it("GET /knowledge/search 缺少 q 参数返回 400", async () => {
      const store = createMemoryKnowledgeStore();
      const routes = registerKnowledgeRoutes({ store, getContext: noContext });
      const route = findRoute(routes, "/knowledge/search", "GET");

      const resp = await route.handler(createRequest("GET", null));
      const json = assertJsonResponse(resp);
      expect(json.status).toBe(400);
    });
  });
});

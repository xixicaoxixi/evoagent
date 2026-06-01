import { describe, it, expect } from "vitest";
import type { HttpRequest, HttpResponse } from "../../src/server";
import { createServer, jsonResponse, errorResponse, notFoundResponse } from "../../src/server";
import { createAuthenticator, createAuthMiddleware } from "../../src/server/auth";
import { createSlidingRateLimiter, createFixedRateLimiter, createRateLimitMiddleware } from "../../src/server/rate-limit";

function createRequest(
  method: HttpRequest["method"],
  remoteAddress = "192.168.1.1",
  headers = new Headers(),
): HttpRequest {
  return {
    method,
    url: "/api/v1/test",
    params: {},
    query: new URLSearchParams(),
    headers,
    body: null,
    remoteAddress,
    context: {},
  };
}

function assertSyncResponse(response: HttpResponse | Promise<HttpResponse>): HttpResponse {
  expect(response).not.toBeInstanceOf(Promise);
  return response as HttpResponse;
}

describe("Phase G > G.1 > 服务器基础", () => {
  it("createServer 创建服务器实例", () => {
    const server = createServer({ port: 0, prefix: "/api/v1" });
    expect(server).toBeDefined();
    expect(server.getConfig().prefix).toBe("/api/v1");
    expect(server.getConfig().port).toBe(0);
  });

  it("registerRoute + use 注册路由和中间件", () => {
    const server = createServer({ port: 0 });
    let middlewareCalled = false;

    server.use((_req: unknown, next: () => unknown) => {
      middlewareCalled = true;
      return next();
    });

    server.registerRoute({
      method: "GET",
      pattern: "/test",
      handler: () => jsonResponse({ ok: true }),
    });

    expect(server.getStats().totalRequests).toBe(0);
    expect(middlewareCalled).toBe(false);
  });

  it("jsonResponse 构建正确响应", () => {
    const resp = jsonResponse({ message: "hello" }, 200);
    expect(resp.status).toBe(200);
    expect(resp.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(resp.body).toEqual({ message: "hello" });
  });

  it("errorResponse 构建错误响应", () => {
    const resp = errorResponse("Something failed", 400);
    expect(resp.status).toBe(400);
    expect(resp.body).toEqual({ error: "Something failed", status: 400 });
  });

  it("notFoundResponse 返回 404", () => {
    const resp = notFoundResponse();
    expect(resp.status).toBe(404);
  });

  it("服务器统计初始值正确", () => {
    const server = createServer({ port: 0 });
    const stats = server.getStats();
    expect(stats.totalRequests).toBe(0);
    expect(stats.activeConnections).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.startTime).toBeGreaterThan(0);
  });
});

describe("Phase G > G.1 > 认证中间件", () => {
  it("无 API Key 配置时不需要认证", () => {
    const auth = createAuthenticator({ apiKeys: [] });
    expect(auth.requiresAuth(createRequest("POST"))).toBe(false);
  });

  it("有 API Key 配置时写操作需要认证", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_test_key_123"] });
    expect(auth.requiresAuth(createRequest("POST"))).toBe(true);
  });

  it("有 API Key 配置时读操作不需要认证", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_test_key_123"] });
    expect(auth.requiresAuth(createRequest("GET"))).toBe(false);
  });

  it("回环地址豁免认证", () => {
    const auth = createAuthenticator({
      apiKeys: ["evo_test_key_123"],
      loopbackExempt: true,
    });
    expect(auth.requiresAuth(createRequest("POST", "127.0.0.1"))).toBe(false);
  });

  it("validate 正确验证 API Key", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_test_key_123"] });
    const result = auth.validate("evo_test_key_123");
    expect(result.authenticated).toBe(true);
    expect(result.apiKey).toBeDefined();
    expect(result.apiKey).not.toBe("evo_test_key_123");
    expect(result.apiKey).toContain("...");
  });

  it("validate 拒绝无效 API Key", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_test_key_123"] });
    const result = auth.validate("evo_wrong_key");
    expect(result.authenticated).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("validate 拒绝缺少前缀的 Key", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_test_key_123"] });
    const result = auth.validate("wrong_prefix_key");
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("prefix");
  });

  it("validate 拒绝空 Key", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_test_key_123"] });
    expect(auth.validate("").authenticated).toBe(false);
    expect(auth.validate(null as unknown as string).authenticated).toBe(false);
  });

  it("createAuthMiddleware 放行不需要认证的请求", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_test_key_123"] });
    const middleware = createAuthMiddleware(auth);
    const result = assertSyncResponse(middleware(createRequest("GET"), () => ({ status: 200, headers: {}, body: "ok" })));
    expect(result.status).toBe(200);
  });

  it("createAuthMiddleware 拦截未认证的写请求", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_test_key_123"] });
    const middleware = createAuthMiddleware(auth);
    const result = assertSyncResponse(middleware(createRequest("POST"), () => ({ status: 200, headers: {}, body: "ok" })));
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "API key required", status: 401 });
  });

  it("createAuthMiddleware 放行已认证的写请求", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_test_key_123"] });
    const middleware = createAuthMiddleware(auth);
    const req = createRequest("POST", "192.168.1.1", new Headers({ "x-api-key": "evo_test_key_123" }));
    const result = assertSyncResponse(middleware(req, () => ({ status: 200, headers: {}, body: "ok" })));
    expect(result.status).toBe(200);
    expect(req.context.authenticated).toBe(true);
  });

  it("createAuthMiddleware 对无效 API Key 返回明确错误", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_test_key_123"] });
    const middleware = createAuthMiddleware(auth);
    const req = createRequest("POST", "192.168.1.1", new Headers({ "x-api-key": "evo_wrong_key" }));
    const result = assertSyncResponse(middleware(req, () => ({ status: 200, headers: {}, body: "ok" })));
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "Invalid API key", status: 401 });
  });

  it("createAuthMiddleware 在读请求携带合法 API Key 时注入指纹", () => {
    const fullKey = "evo_test_key_123";
    const auth = createAuthenticator({ apiKeys: [fullKey] });
    const middleware = createAuthMiddleware(auth);
    const req = createRequest("GET", "192.168.1.1", new Headers({ "x-api-key": fullKey }));
    const result = assertSyncResponse(middleware(req, () => ({ status: 200, headers: {}, body: "ok" })));
    expect(result.status).toBe(200);
    expect(req.context.authenticated).toBe(true);
    expect(req.context.apiKey).not.toBe(fullKey);
  });

  it("从环境变量加载 API Keys", () => {
    const original = process.env.EVOAGENT_API_KEYS;
    process.env.EVOAGENT_API_KEYS = "evo_key1, evo_key2, evo_key3";
    try {
      const auth = createAuthenticator();
      expect(auth.validate("evo_key1").authenticated).toBe(true);
      expect(auth.validate("evo_key2").authenticated).toBe(true);
      expect(auth.validate("evo_key3").authenticated).toBe(true);
    } finally {
      process.env.EVOAGENT_API_KEYS = original;
    }
  });

  it("getKeyPrefixes 返回脱敏前缀", () => {
    const auth = createAuthenticator({ apiKeys: ["evo_abcd1234_secret", "evo_efgh5678_secret"] });
    expect(auth.getKeyPrefixes()).toEqual(["evo_abcd...", "evo_efgh..."]);
  });
});

describe("Phase G > G.1 > 速率限制", () => {
  describe("滑动窗口速率限制器", () => {
    it("初始状态允许请求", () => {
      const limiter = createSlidingRateLimiter({ maxAttempts: 3, windowMs: 1000 });
      const result = limiter.check("user1");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(3);
    });

    it("达到限制后锁定", () => {
      const limiter = createSlidingRateLimiter({ maxAttempts: 3, windowMs: 1000 });
      limiter.recordFailure("user1");
      limiter.recordFailure("user1");
      limiter.recordFailure("user1");
      const result = limiter.check("user1");
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("锁定后 retryAfterMs 大于 0", () => {
      const limiter = createSlidingRateLimiter({ maxAttempts: 3, windowMs: 1000, lockoutMs: 2000 });
      limiter.recordFailure("user1");
      limiter.recordFailure("user1");
      limiter.recordFailure("user1");
      const result = limiter.check("user1");
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it("成功后 reset 清空状态", () => {
      const limiter = createSlidingRateLimiter({ maxAttempts: 2, windowMs: 1000 });
      limiter.recordFailure("user1");
      limiter.recordFailure("user1");
      limiter.reset("user1");
      const result = limiter.check("user1");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    });

    it("回环地址豁免", () => {
      const limiter = createSlidingRateLimiter({
        maxAttempts: 1,
        windowMs: 1000,
        loopbackExempt: true,
      });
      limiter.recordFailure("127.0.0.1");
      const result = limiter.check("127.0.0.1");
      expect(result.allowed).toBe(true);
    });

    it("prune 清理过期桶", () => {
      const limiter = createSlidingRateLimiter({
        maxAttempts: 1,
        windowMs: 1,
        lockoutMs: 1,
      });
      limiter.recordFailure("user1");
      limiter.recordFailure("user2");
      const pruned = limiter.prune();
      expect(pruned).toBeGreaterThanOrEqual(0);
    });

    it("size 返回桶数量", () => {
      const limiter = createSlidingRateLimiter({ maxAttempts: 1, windowMs: 1000 });
      limiter.recordFailure("user1");
      limiter.recordFailure("user2");
      expect(limiter.size()).toBe(2);
    });
  });

  describe("固定窗口速率限制器", () => {
    it("初始状态允许请求", () => {
      const limiter = createFixedRateLimiter({ maxRequests: 3, windowMs: 1000 });
      const result = limiter.consume("user1");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    });

    it("超过限制后拒绝请求", () => {
      const limiter = createFixedRateLimiter({ maxRequests: 2, windowMs: 1000 });
      limiter.consume("user1");
      limiter.consume("user1");
      const result = limiter.consume("user1");
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("不同 key 独立计数", () => {
      const limiter = createFixedRateLimiter({ maxRequests: 1, windowMs: 1000 });
      expect(limiter.consume("user1").allowed).toBe(true);
      expect(limiter.consume("user2").allowed).toBe(true);
      expect(limiter.consume("user1").allowed).toBe(false);
    });

    it("回环地址豁免", () => {
      const limiter = createFixedRateLimiter({
        maxRequests: 1,
        windowMs: 1000,
        loopbackExempt: true,
      });
      limiter.consume("127.0.0.1");
      const result = limiter.consume("127.0.0.1");
      expect(result.allowed).toBe(true);
    });

    it("size 返回桶数量", () => {
      const limiter = createFixedRateLimiter({ maxRequests: 1, windowMs: 1000 });
      limiter.consume("user1");
      limiter.consume("user2");
      expect(limiter.size()).toBe(2);
    });
  });

  describe("速率限制中间件", () => {
    it("放行未超限请求", () => {
      const limiter = createFixedRateLimiter({ maxRequests: 2 });
      const middleware = createRateLimitMiddleware({ fixedLimiter: limiter });
      const req = createRequest("GET");
      const result = assertSyncResponse(middleware(req, () => ({ status: 200, headers: {}, body: "ok" })));
      expect(result.status).toBe(200);
    });

    it("拦截超限请求返回 429", () => {
      const limiter = createFixedRateLimiter({ maxRequests: 1 });
      const middleware = createRateLimitMiddleware({ fixedLimiter: limiter });
      const req = createRequest("GET");
      assertSyncResponse(middleware(req, () => ({ status: 200, headers: {}, body: "ok" })));
      const result = assertSyncResponse(middleware(req, () => ({ status: 200, headers: {}, body: "ok" })));
      expect(result.status).toBe(429);
    });
  });
});

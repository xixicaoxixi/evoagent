import { describe, it, expect, beforeEach } from "vitest";
import {
  createLinkedTransportPair,
  type JSONRPCMessage,
  type Transport,
} from "../../src/mcp/transport";
import {
  createMCPClientWithBreaker,
  type MCPClient,
} from "../../src/mcp/client";

function createFailingTransport(): Transport {
  let closed = false;
  return {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    async start() {},
    async send() {
      if (closed) throw new Error("Transport is closed");
      throw new Error("Connection refused");
    },
    async close() {
      closed = true;
      this.onclose?.();
    },
  };
}

function createTimeoutTransport(): Transport {
  return {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    async start() {},
    async send() {
      // Never responds — will cause timeout
    },
    async close() {
      this.onclose?.();
    },
  };
}

function createErrorRespondingTransport(): Transport {
  return {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    async start() {},
    async send(message: JSONRPCMessage) {
      queueMicrotask(() => {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "Internal error" },
        });
      });
    },
    async close() {
      this.onclose?.();
    },
  };
}

function createHealthyTransport(): Transport {
  return {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    async start() {},
    async send(message: JSONRPCMessage) {
      queueMicrotask(() => {
        if (message.method === "tools/list") {
          this.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [{ name: "test-tool" }] },
          });
        } else {
          this.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: {},
          });
        }
      });
    },
    async close() {
      this.onclose?.();
    },
  };
}

function createSwitchableTransport(): {
  transport: Transport;
  setHealthy: () => void;
  setFailing: () => void;
} {
  let healthy = true;
  const t: Transport = {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    async start() {},
    async send(message: JSONRPCMessage) {
      if (!healthy) {
        throw new Error("Connection refused");
      }
      queueMicrotask(() => {
        if (message.method === "tools/list") {
          this.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [{ name: "test-tool" }] },
          });
        } else {
          this.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: {},
          });
        }
      });
    },
    async close() {
      this.onclose?.();
    },
  };
  return {
    transport: t,
    setHealthy: () => { healthy = true; },
    setFailing: () => { healthy = false; },
  };
}

describe("MCP Client + Circuit Breaker — 传输错误触发熔断", () => {
  it("连续 3 次传输错误后断路器打开", async () => {
    const client = createMCPClientWithBreaker({
      name: "test-failing",
      version: "1.0.0",
      transport: createFailingTransport(),
      requestTimeout: 500,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
    });

    await client.connect();
    expect(client.breaker.state).toBe("CLOSED");

    await expect(client.listTools()).rejects.toThrow("transport error");
    expect(client.breaker.consecutiveFailures).toBe(1);
    expect(client.breaker.state).toBe("CLOSED");

    await expect(client.listTools()).rejects.toThrow("transport error");
    expect(client.breaker.consecutiveFailures).toBe(2);
    expect(client.breaker.state).toBe("CLOSED");

    await expect(client.listTools()).rejects.toThrow("transport error");
    expect(client.breaker.consecutiveFailures).toBe(3);
    expect(client.breaker.state).toBe("OPEN");
  });

  it("断路器打开后请求被快速拒绝", async () => {
    const client = createMCPClientWithBreaker({
      name: "test-fast-reject",
      version: "1.0.0",
      transport: createFailingTransport(),
      requestTimeout: 500,
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });

    await client.connect();

    await expect(client.listTools()).rejects.toThrow("transport error");
    expect(client.breaker.state).toBe("OPEN");

    await expect(client.listTools()).rejects.toThrow("circuit breaker OPEN");
  });
});

describe("MCP Client + Circuit Breaker — JSON-RPC 错误触发熔断", () => {
  it("JSON-RPC 错误响应触发断路器记录失败", async () => {
    const client = createMCPClientWithBreaker({
      name: "test-jsonrpc-error",
      version: "1.0.0",
      transport: createErrorRespondingTransport(),
      requestTimeout: 5000,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
    });

    await client.connect();

    for (let i = 0; i < 3; i++) {
      await expect(client.listTools()).rejects.toThrow("MCP error -32603");
    }

    expect(client.breaker.state).toBe("OPEN");
  });
});

describe("MCP Client + Circuit Breaker — 超时触发熔断", () => {
  it("请求超时触发断路器记录失败", async () => {
    const client = createMCPClientWithBreaker({
      name: "test-timeout",
      version: "1.0.0",
      transport: createTimeoutTransport(),
      requestTimeout: 100,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
    });

    await client.connect();

    await expect(client.listTools()).rejects.toThrow("timed out");
    expect(client.breaker.consecutiveFailures).toBe(1);

    await expect(client.listTools()).rejects.toThrow("timed out");
    expect(client.breaker.state).toBe("OPEN");
  });
});

describe("MCP Client + Circuit Breaker — 成功调用重置失败计数", () => {
  it("成功调用后连续失败计数归零", async () => {
    const client = createMCPClientWithBreaker({
      name: "test-success-reset",
      version: "1.0.0",
      transport: createHealthyTransport(),
      requestTimeout: 5000,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
    });

    await client.connect();

    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(client.breaker.state).toBe("CLOSED");
    expect(client.breaker.consecutiveFailures).toBe(0);
  });
});

describe("MCP Client + Circuit Breaker — 熔断恢复", () => {
  it("冷却期后探测成功恢复为 CLOSED", async () => {
    const { transport, setHealthy, setFailing } = createSwitchableTransport();

    const client = createMCPClientWithBreaker({
      name: "test-recovery",
      version: "1.0.0",
      transport,
      requestTimeout: 500,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 200 },
    });

    await client.connect();

    setFailing();
    await expect(client.listTools()).rejects.toThrow();
    await expect(client.listTools()).rejects.toThrow();
    expect(client.breaker.state).toBe("OPEN");

    await expect(client.listTools()).rejects.toThrow("circuit breaker OPEN");

    await new Promise((r) => setTimeout(r, 300));

    setHealthy();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(client.breaker.state).toBe("CLOSED");
    expect(client.breaker.consecutiveFailures).toBe(0);
  });

  it("冷却期后探测失败回到 OPEN", async () => {
    const transport = createFailingTransport();

    const client = createMCPClientWithBreaker({
      name: "test-probe-fail",
      version: "1.0.0",
      transport,
      requestTimeout: 500,
      circuitBreaker: { failureThreshold: 1, cooldownMs: 200 },
    });

    await client.connect();

    await expect(client.listTools()).rejects.toThrow("transport error");
    expect(client.breaker.state).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 300));

    await expect(client.listTools()).rejects.toThrow("transport error");
    expect(client.breaker.state).toBe("OPEN");
  });
});

describe("MCP Client + Circuit Breaker — disconnect 重置断路器", () => {
  it("disconnect 后断路器重置为 CLOSED", async () => {
    const client = createMCPClientWithBreaker({
      name: "test-disconnect-reset",
      version: "1.0.0",
      transport: createFailingTransport(),
      requestTimeout: 500,
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });

    await client.connect();

    await expect(client.listTools()).rejects.toThrow("transport error");
    expect(client.breaker.state).toBe("OPEN");

    await client.disconnect();
    expect(client.breaker.state).toBe("CLOSED");
    expect(client.breaker.consecutiveFailures).toBe(0);
  });
});

describe("MCP Client + Circuit Breaker — InProcessTransport 集成", () => {
  let client: MCPClient & { readonly breaker: import("../../src/mcp/circuit-breaker").CircuitBreaker };
  let serverTransport: Transport;

  beforeEach(() => {
    const [clientTransport, sTransport] = createLinkedTransportPair();
    serverTransport = sTransport;

    serverTransport.onmessage = (msg) => {
      if (msg.id !== undefined && msg.method !== undefined) {
        const response: JSONRPCMessage = {
          jsonrpc: "2.0",
          id: msg.id,
          result: msg.method === "tools/list"
            ? { tools: [{ name: "bash", description: "Run bash commands" }] }
            : {},
        };
        serverTransport.send(response);
      }
    };

    client = createMCPClientWithBreaker({
      name: "test-inprocess",
      version: "1.0.0",
      transport: clientTransport,
      requestTimeout: 5000,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
    });
  });

  it("正常通信不触发断路器", async () => {
    await client.connect();

    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("bash");
    expect(client.breaker.state).toBe("CLOSED");
    expect(client.breaker.consecutiveFailures).toBe(0);
  });

  it("连续成功调用保持 CLOSED", async () => {
    await client.connect();

    for (let i = 0; i < 5; i++) {
      await client.listTools();
    }

    expect(client.breaker.state).toBe("CLOSED");
    expect(client.breaker.consecutiveFailures).toBe(0);
  });
});

describe("MCP Client + Circuit Breaker — 无断路器配置时使用默认值", () => {
  it("不配置 circuitBreaker 时使用默认阈值 3", async () => {
    const client = createMCPClientWithBreaker({
      name: "test-default",
      version: "1.0.0",
      transport: createFailingTransport(),
      requestTimeout: 500,
    });

    await client.connect();

    await expect(client.listTools()).rejects.toThrow();
    expect(client.breaker.state).toBe("CLOSED");

    await expect(client.listTools()).rejects.toThrow();
    expect(client.breaker.state).toBe("CLOSED");

    await expect(client.listTools()).rejects.toThrow();
    expect(client.breaker.state).toBe("OPEN");
  });
});

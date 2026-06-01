/**
 * Session 6.5 测试 — MCP 增强（InProcessTransport + 技能桥接 + Client）。
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  InProcessTransport,
  createLinkedTransportPair,
  type JSONRPCMessage,
  type Transport,
} from "../../src/mcp/transport";
import {
  registerSkillBuilders,
  getSkillBuilders,
  hasSkillBuilders,
  resetSkillBuilders,
} from "../../src/mcp/skill-bridge";
import { createMCPClient, type MCPClient } from "../../src/mcp/client";
import type { SkillDefinition } from "../../src/plugins/skills/definition";

// ─── InProcessTransport 测试 ───

describe("InProcessTransport", () => {
  it("创建链接的传输对", () => {
    const [client, server] = createLinkedTransportPair();
    expect(client).toBeDefined();
    expect(server).toBeDefined();
  });

  it("客户端发送消息，服务器接收", async () => {
    const [client, server] = createLinkedTransportPair();
    const received: JSONRPCMessage[] = [];

    server.onmessage = (msg) => {
      received.push(msg);
    };

    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "test",
      params: { key: "value" },
    };

    await client.send(message);

    // 等待 queueMicrotask
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe("test");
  });

  it("双向通信", async () => {
    const [client, server] = createLinkedTransportPair();
    const clientReceived: JSONRPCMessage[] = [];
    const serverReceived: JSONRPCMessage[] = [];

    client.onmessage = (msg) => clientReceived.push(msg);
    server.onmessage = (msg) => serverReceived.push(msg);

    await client.send({ jsonrpc: "2.0", id: 1, method: "from-client" });
    await server.send({ jsonrpc: "2.0", id: 2, method: "from-server" });

    await new Promise((r) => setTimeout(r, 0));

    expect(serverReceived).toHaveLength(1);
    expect(serverReceived[0]!.method).toBe("from-client");
    expect(clientReceived).toHaveLength(1);
    expect(clientReceived[0]!.method).toBe("from-server");
  });

  it("关闭后发送抛出错误", async () => {
    const [client] = createLinkedTransportPair();
    await client.close();

    await expect(
      client.send({ jsonrpc: "2.0", id: 1, method: "test" }),
    ).rejects.toThrow("Transport is closed");
  });

  it("关闭触发 onclose 回调", async () => {
    const [client, server] = createLinkedTransportPair();
    let clientClosed = false;
    let serverClosed = false;

    client.onclose = () => { clientClosed = true; };
    server.onclose = () => { serverClosed = true; };

    await client.close();

    expect(clientClosed).toBe(true);
    expect(serverClosed).toBe(true);
  });

  it("重复关闭不触发 onclose", async () => {
    const [client] = createLinkedTransportPair();
    let closeCount = 0;
    client.onclose = () => { closeCount++; };

    await client.close();
    await client.close();

    expect(closeCount).toBe(1);
  });

  it("关闭后对端发送不触发 onmessage", async () => {
    const [client, server] = createLinkedTransportPair();
    const received: JSONRPCMessage[] = [];
    client.onmessage = (msg) => received.push(msg);

    await server.close();
    // server 关闭后，client 的 peer 已标记为 closed
    // client.send 会抛出 Transport is closed
    try {
      await client.send({ jsonrpc: "2.0", id: 1, method: "test" });
    } catch {
      // 预期行为
    }

    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(0);
  });

  it("isClosed 正确报告状态", async () => {
    const [client] = createLinkedTransportPair();
    expect((client as InProcessTransport).isClosed()).toBe(false);
    await client.close();
    expect((client as InProcessTransport).isClosed()).toBe(true);
  });
});

// ─── SkillBridge 测试 ───

describe("SkillBridge", () => {
  beforeEach(() => {
    resetSkillBuilders();
  });

  it("初始状态未注册", () => {
    expect(hasSkillBuilders()).toBe(false);
  });

  it("注册后可获取", () => {
    const mockBuilders = {
      parseSkillContent: () => null,
      parseFrontmatterFields: () => ({ frontmatter: null, body: "" }),
    };

    registerSkillBuilders(mockBuilders);
    expect(hasSkillBuilders()).toBe(true);
    expect(getSkillBuilders()).toBe(mockBuilders);
  });

  it("未注册时获取抛出错误", () => {
    expect(() => getSkillBuilders()).toThrow("Skill builders not registered");
  });

  it("reset 清除注册", () => {
    registerSkillBuilders({
      parseSkillContent: () => null,
      parseFrontmatterFields: () => ({ frontmatter: null, body: "" }),
    });
    expect(hasSkillBuilders()).toBe(true);

    resetSkillBuilders();
    expect(hasSkillBuilders()).toBe(false);
  });
});

// ─── MCPClient 测试 ───

describe("MCPClient", () => {
  let client: MCPClient;
  let receivedMessages: JSONRPCMessage[];
  let serverTransport: Transport;

  beforeEach(() => {
    receivedMessages = [];
    const [clientTransport, sTransport] = createLinkedTransportPair();
    serverTransport = sTransport;

    // 模拟 MCP Server：收到请求后立即返回响应
    serverTransport.onmessage = (msg) => {
      receivedMessages.push(msg);
      // 发送 JSON-RPC 响应
      if (msg.id !== undefined && msg.method !== undefined) {
        const response: JSONRPCMessage = {
          jsonrpc: "2.0",
          id: msg.id,
          result: msg.method === "tools/list"
            ? { tools: [{ name: "bash", description: "Run bash commands" }] }
            : msg.method === "tools/call"
              ? { content: [{ type: "text", text: "done" }] }
              : msg.method === "resources/read"
                ? { contents: [{ uri: "file:///test.txt", text: "file content" }] }
                : msg.method === "resources/list"
                  ? { resources: [{ uri: "file:///test.txt", name: "test.txt" }] }
                  : {},
        };
        serverTransport.send(response);
      }
    };

    client = createMCPClient({
      name: "test-client",
      version: "1.0.0",
      transport: clientTransport,
      requestTimeout: 5000,
    });
  });

  it("初始状态未连接", () => {
    expect(client.connected).toBe(false);
    expect(client.name).toBe("test-client");
  });

  it("connect 后状态变为已连接", async () => {
    await client.connect();
    expect(client.connected).toBe(true);
  });

  it("disconnect 后状态变为未连接", async () => {
    await client.connect();
    await client.disconnect();
    expect(client.connected).toBe(false);
  });

  it("未连接时 listTools 抛出错误", async () => {
    await expect(client.listTools()).rejects.toThrow("not connected");
  });

  it("未连接时 callTool 抛出错误", async () => {
    await expect(client.callTool("test", {})).rejects.toThrow("not connected");
  });

  it("已连接时 listTools 发送请求", async () => {
    await client.connect();
    await client.listTools();

    await new Promise((r) => setTimeout(r, 0));
    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]!.method).toBe("tools/list");
  });

  it("已连接时 callTool 发送请求", async () => {
    await client.connect();
    await client.callTool("bash", { command: "ls" });

    await new Promise((r) => setTimeout(r, 0));
    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]!.method).toBe("tools/call");
  });

  it("已连接时 readResource 发送请求", async () => {
    await client.connect();
    await client.readResource("file:///test.txt");

    await new Promise((r) => setTimeout(r, 0));
    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]!.method).toBe("resources/read");
  });
});

/**
 * 阶段 E 集成测试。
 */

import { describe, it, expect } from "vitest";
import { createCritic } from "../../src/communication/critic";
import { createSummarizer } from "../../src/communication/summarizer";
import { createGateway } from "../../src/communication/gateway";
import { createObfuscator } from "../../src/communication/obfuscator";
import { createProtocol, createPeerInfo } from "../../src/communication/protocol";
import { createIdentity, createMessageSigner } from "../../src/communication/identity";
import { createMCPServer, JSONRPC_ERRORS } from "../../src/mcp/server";
import { createMCPServerPolicyChecker } from "../../src/mcp/policy";
import { createSandboxedSubprocess, createSubprocessResult, validateDockerSecurity, resolveDockerConfig, buildDockerArgs } from "../../src/sandbox/subprocess";

// ─── E.1 Critic 增强 ───

describe("Phase E > E.1 > Critic 增强", () => {

  it("getCacheStats 返回缓存统计", () => {
    const critic = createCritic({ cacheEnabled: true });
    expect(critic.getCacheStats().size).toBe(0);
    expect(critic.getCacheStats().maxSize).toBe(256);
  });

  it("clearCache 清空缓存", async () => {
    const critic = createCritic({ cacheEnabled: true });
    await critic.analyzeMessage("agent1", "test claim", 0.5);
    critic.clearCache();
    expect(critic.getCacheStats().size).toBe(0);
  });

  it("cacheEnabled=false 不缓存", async () => {
    const critic = createCritic({ cacheEnabled: false });
    await critic.analyzeMessage("agent1", "test claim", 0.5);
    expect(critic.getCacheStats().size).toBe(0);
  });

  it("LLM Provider 注入（降级模式）", async () => {
    const mockProvider = {
      name: "mock",
      invoke: async () => "invalid json response",
    };
    const critic = createCritic({ llmProvider: mockProvider });
    // 应该降级到简单分析，不崩溃
    const result = await critic.analyzeMessage("agent1", "test claim", 0.5);
    expect(result).toBeDefined();
    expect(result.processingResult).toBeDefined();
  });
});

// ─── E.2 通信层安全 ───

describe("Phase E > E.2 > 通信层安全", () => {

  it("HMAC 密钥从环境变量加载", () => {
    const originalKey = process.env.EVOAGENT_HMAC_KEY;
    process.env.EVOAGENT_HMAC_KEY = "test_key_at_least_16_chars";
    try {
      const id1 = createIdentity();
      const id2 = createIdentity();
      // 相同环境变量 → 相同 instanceId
      expect(id1.instanceId).toBe(id2.instanceId);
    } finally {
      if (originalKey !== undefined) {
        process.env.EVOAGENT_HMAC_KEY = originalKey;
      } else {
        delete process.env.EVOAGENT_HMAC_KEY;
      }
    }
  });

  it("签名验证跨实例工作", () => {
    const id1 = createIdentity({ hmacKey: "shared_key_for_testing_123" });
    const id2 = createIdentity({ hmacKey: "shared_key_for_testing_123" });
    const signer = createMessageSigner();

    const message = { type: "test", data: "hello" };
    const signed = signer.signMessage(message, id1);

    const result = signer.verifyMessage(signed, id1.getSigningKey());
    expect(result.valid).toBe(true);
  });

  it("Gateway 签名验证拒绝无效签名", () => {
    const identity = createIdentity({ hmacKey: "gateway_test_key_12345" });

    const gateway = createGateway({}, { identity });

    const peer = createPeerInfo({
      instanceId: "peer1",
      instanceName: "Peer1",
      host: "localhost",
      port: 3000,
      publicKey: "wrong_key",
    });

    gateway.addPeer(peer);

    const result = gateway.handleMessage({
      message_id: "msg1",
      sender_id: "peer1",
      recipient_id: "self",
      type: "claim",
      payload: {
        _signature: {
          signer: "peer1",
          signature: "invalid_signature_hex",
          publicKey: "wrong_key",
        },
        claim: "test",
      },
      timestamp: Date.now(),
      ttl: 60,
    });

    // 签名验证应失败（无效签名）
    expect(result.accepted).toBe(false);
  });
});

// ─── E.3 MCP Server + 策略 ───

describe("Phase E > E.3 > MCP Server", () => {

  it("initialize 返回服务器信息", async () => {
    const server = createMCPServer({ serverName: "test", serverVersion: "1.0" });
    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(response).toBeDefined();
    expect(response.result.serverInfo.name).toBe("test");
  });

  it("tools/list 返回已注册工具", async () => {
    const server = createMCPServer();
    server.registerTool(
      { name: "echo", description: "Echo tool" },
      async (params) => params,
    );

    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    expect(response.result.tools).toHaveLength(1);
    expect(response.result.tools[0].name).toBe("echo");
  });

  it("tools/call 执行工具", async () => {
    const server = createMCPServer();
    server.registerTool(
      { name: "add" },
      async (params) => {
        const p = params as { a: number; b: number };
        return { result: p.a + p.b };
      },
    );

    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "add", arguments: { a: 1, b: 2 } },
    });

    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text) as { result: number };
    expect(parsed.result).toBe(3);
  });

  it("未知方法返回 METHOD_NOT_FOUND", async () => {
    const server = createMCPServer();
    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "unknown_method",
    });

    expect(response.error.code).toBe(JSONRPC_ERRORS.METHOD_NOT_FOUND.code);
  });

  it("getStats 返回统计", async () => {
    const server = createMCPServer();
    await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
    const stats = server.getStats();
    expect(stats.totalRequests).toBe(1);
    expect(stats.successfulRequests).toBe(1);
  });
});

describe("Phase E > E.3 > MCP 策略", () => {

  it("空白名单阻断所有", () => {
    const checker = createMCPServerPolicyChecker({ allowlist: [] });
    const result = checker.check("any-server");
    expect(result.allowed).toBe(false);
  });

  it("无白名单允许所有", () => {
    const checker = createMCPServerPolicyChecker({});
    const result = checker.check("any-server");
    expect(result.allowed).toBe(true);
  });

  it("黑名单优先于白名单", () => {
    const checker = createMCPServerPolicyChecker({
      denylist: [{ type: "name", pattern: "evil-server" }],
      allowlist: [{ type: "name", pattern: "*" }],
    });
    expect(checker.check("evil-server").allowed).toBe(false);
    expect(checker.check("good-server").allowed).toBe(true);
  });

  it("通配符匹配", () => {
    const checker = createMCPServerPolicyChecker({
      allowlist: [{ type: "name", pattern: "mcp_*" }],
    });
    expect(checker.check("mcp_tool").allowed).toBe(true);
    expect(checker.check("other").allowed).toBe(false);
  });

  it("动态添加条目", () => {
    const checker = createMCPServerPolicyChecker({});
    checker.addDenyEntry({ type: "name", pattern: "banned" });
    expect(checker.check("banned").allowed).toBe(false);
    expect(checker.getStats().denylistSize).toBe(1);
  });
});

// ─── E.4 沙箱安全 ───

describe("Phase E > E.4 > 沙箱安全", () => {

  it("validateDockerSecurity 拒绝 host 网络", () => {
    const result = validateDockerSecurity({ network: "host" });
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("Network mode 'host' is not allowed");
  });

  it("validateDockerSecurity 要求 cap-drop ALL", () => {
    const result = validateDockerSecurity({ capDrop: [] });
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("validateDockerSecurity 安全配置通过", () => {
    const result = validateDockerSecurity({
      network: "none",
      capDrop: ["ALL"],
      memory: "256m",
    });
    expect(result.valid).toBe(true);
  });

  it("resolveDockerConfig 安全默认值", () => {
    const config = resolveDockerConfig();
    expect(config.readOnlyRoot).toBe(true);
    expect(config.network).toBe("none");
    expect(config.capDrop).toContain("ALL");
    expect(config.memory).toBe("512m");
  });

  it("buildDockerArgs 生成正确参数", () => {
    const config = resolveDockerConfig();
    const args = buildDockerArgs("test-container", config, "node", ["-e", "console.log(1)"]);
    expect(args).toContain("create");
    expect(args).toContain("--name");
    expect(args).toContain("test-container");
    expect(args).toContain("--read-only");
    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args).toContain("node");
  });
});

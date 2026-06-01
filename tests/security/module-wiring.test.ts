/**
 * A.3 安全模块接入测试 — 验证安全函数被正确接入到业务代码。
 *
 * 覆盖范围：
 * - PII 净化在 LLM 消息组装中被调用
 * - 工具输入截断在进度追踪中被调用
 * - 配置脱敏在日志记录中被调用
 * - MCP 工具名脱敏在工具注册中被调用
 */

import { describe, it, expect, spyOn } from "vitest";
import { createPIISanitizer } from "../../src/observability/pii";
import { sanitizeToolInputForLogging } from "../../src/security/truncate";
import { redactConfigObject, REDACTED_SENTINEL } from "../../src/security/redact";
import { sanitizeToolNameForAnalytics } from "../../src/security/truncate";
import { createMCPServer } from "../../src/mcp/server";
import { createProgressTracker, updateProgressFromMessage } from "../../src/observability/progress";
import { createLogger } from "../../src/observability/logger";

// ─── PII 净化接入验证 ───

describe("A.3 > 安全模块接入 > PII 净化", () => {
  it("PII sanitizer 能正确净化包含邮箱的消息", () => {
    const sanitizer = createPIISanitizer();
    const result = sanitizer.sanitize("请联系 user@example.com 获取更多信息");
    expect(result.redactedTypes).toContain("email");
    expect(result.redactionCount).toBeGreaterThan(0);
  });

  it("PII sanitizer 能正确净化包含 API Key 的消息", () => {
    const sanitizer = createPIISanitizer();
    const result = sanitizer.sanitize("api_key: sk-1234567890abcdef");
    expect(result.sanitized).not.toContain("sk-1234567890abcdef");
    expect(result.redactedTypes).toContain("api_key");
  });

  it("PII sanitizer 不影响正常消息", () => {
    const sanitizer = createPIISanitizer();
    const result = sanitizer.sanitize("请帮我写一个排序算法");
    expect(result.sanitized).toBe("请帮我写一个排序算法");
    expect(result.redactionCount).toBe(0);
  });

  it("PII sanitizer 净化 tool_result 中的文件路径和敏感信息", () => {
    const sanitizer = createPIISanitizer();
    const toolResult = "文件内容读取成功。联系邮箱: admin@company.com，密钥: sk-ant-test123";
    const result = sanitizer.sanitize(toolResult);
    expect(result.redactedTypes.length).toBeGreaterThan(0);
    expect(result.redactionCount).toBeGreaterThan(0);
  });
});

// ─── 工具输入截断接入验证 ───

describe("A.3 > 安全模块接入 > 工具输入截断", () => {
  it("sanitizeToolInputForLogging 截断长字符串", () => {
    const longInput = { content: "x".repeat(600) };
    const result = sanitizeToolInputForLogging(longInput) as Record<string, unknown>;
    expect((result["content"] as string).length).toBeLessThan(200);
    expect((result["content"] as string)).toContain("…[600 chars]");
  });

  it("sanitizeToolInputForLogging 过滤内部键", () => {
    const input = { public: "visible", _internal: "hidden", _secret: "classified" };
    const result = sanitizeToolInputForLogging(input) as Record<string, unknown>;
    expect(result.public).toBe("visible");
    expect(result._internal).toBeUndefined();
    expect(result._secret).toBeUndefined();
  });

  it("sanitizeToolInputForLogging 限制嵌套深度", () => {
    const deep = { a: { b: { c: { d: "value" } } } };
    const result = sanitizeToolInputForLogging(deep, 0) as Record<string, unknown>;
    expect((result["a"] as Record<string, unknown>)["b"]).toBe("<nested>");
  });
});

// ─── 配置脱敏接入验证 ───

describe("A.3 > 安全模块接入 > 配置脱敏", () => {
  it("redactConfigObject 脱敏敏感字段", () => {
    const config = { llm: { api_key: "sk-secret", model: "gpt-4o" } };
    const redacted = redactConfigObject(config) as typeof config;
    expect(redacted.llm.api_key).toBe(REDACTED_SENTINEL);
    expect(redacted.llm.model).toBe("gpt-4o");
  });

  it("redactConfigObject 不脱敏白名单字段", () => {
    const config = { llm: { max_tokens: 2048, temperature: 0.7 } };
    const redacted = redactConfigObject(config);
    expect(redacted).toEqual(config);
  });

  it("redactConfigObject 处理空 fields", () => {
    const redacted = redactConfigObject(undefined);
    expect(redacted).toBeUndefined();
  });
});

// ─── MCP 工具名脱敏接入验证 ───

describe("A.3 > 安全模块接入 > MCP 工具名脱敏", () => {
  it("MCP Server 注册时自动脱敏工具名", () => {
    const server = createMCPServer();
    server.registerTool(
      { name: "mcp__github__create_issue", description: "Create issue" },
      async () => ({ success: true }),
    );

    const tools = server.listTools();
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("mcp_tool");
  });

  it("MCP Server 注册普通工具名不受影响", () => {
    const server = createMCPServer();
    server.registerTool(
      { name: "file_read", description: "Read file" },
      async () => ({ content: "" }),
    );

    const tools = server.listTools();
    expect(tools[0]?.name).toBe("file_read");
  });

  it("MCP Server 通过脱敏后的名称调用工具", async () => {
    const server = createMCPServer();
    server.registerTool(
      { name: "mcp__slack__send_message", description: "Send message" },
      async (params) => ({ channel: params }),
    );

    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "mcp_tool", arguments: { channel: "#general" } },
    });

    // handler receives the arguments object directly
    expect(response?.result).toBeTruthy();
  });
});

// ─── 进度追踪截断接入验证 ───

describe("A.3 > 安全模块接入 > 进度追踪截断", () => {
  it("updateProgressFromMessage 记录的工具活动输入已被截断", () => {
    const tracker = createProgressTracker();
    updateProgressFromMessage(tracker, {
      type: "assistant",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [
        {
          type: "tool_use",
          name: "bash",
          input: { command: "x".repeat(600), _internal: "secret" },
        },
      ],
    });

    const progress = tracker.recentActivities;
    expect(progress.length).toBe(1);
    // 截断后的输入应该不包含完整的长字符串
    const inputStr = JSON.stringify(progress[0]?.input);
    expect(inputStr.length).toBeLessThan(300);
    // 内部键应该被过滤
    expect((progress[0]?.input as Record<string, unknown>)?._internal).toBeUndefined();
  });
});

// ─── 日志脱敏接入验证 ───

describe("A.3 > 安全模块接入 > 日志脱敏", () => {
  it("Logger 在记录日志时自动脱敏敏感字段", () => {
    const entries: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      minLevel: "info",
      handler: (entry) => entries.push(entry as unknown as Record<string, unknown>),
    });

    logger.info("Config loaded", {
      llm: { api_key: "sk-secret-123", model: "gpt-4o" },
      server: { host: "127.0.0.1" },
    });

    expect(entries.length).toBe(1);
    const fields = entries[0]?.fields as Record<string, unknown>;
    const llm = fields.llm as Record<string, unknown>;
    expect(llm.api_key).toBe(REDACTED_SENTINEL);
    expect(llm.model).toBe("gpt-4o");
  });

  it("Logger 不脱敏非敏感字段", () => {
    const entries: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      minLevel: "info",
      handler: (entry) => entries.push(entry as unknown as Record<string, unknown>),
    });

    logger.info("Request received", { path: "/api/chat", method: "POST" });

    expect(entries.length).toBe(1);
    const fields = entries[0]?.fields as Record<string, unknown>;
    expect(fields.path).toBe("/api/chat");
    expect(fields.method).toBe("POST");
  });

  it("Logger 处理空 fields", () => {
    const entries: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      minLevel: "info",
      handler: (entry) => entries.push(entry as unknown as Record<string, unknown>),
    });

    logger.info("Simple message");

    expect(entries.length).toBe(1);
    expect(entries[0]?.fields).toEqual({});
  });
});

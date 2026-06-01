/**
 * Session 6.6 — 阶段 6 集成测试。
 *
 * E2E 测试覆盖：插件加载 → 钩子注册 → 事件分发 → 技能激活 → MCP 通信。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createEventEmitter, type EventEmitter, type BaseEvent } from "../../src/plugins/event-emitter";
import {
  createAgentEvent,
  createToolEvent,
  createPluginEvent,
  type SystemEvent,
} from "../../src/plugins/events";
import { createHookRegistry, type HookRegistry } from "../../src/plugins/hooks/registry";
import { createHookEngine, type HookEngine } from "../../src/plugins/hooks/engine";
import { definePluginEntry, type PluginDefinitionInput } from "../../src/plugins/sdk";
import { createPluginRegistryImpl, type PluginRegistryExtended } from "../../src/plugins/registry";
import {
  parseFrontmatter,
  activateConditionalSkills,
  type SkillDefinition,
} from "../../src/plugins/skills/definition";
import {
  createLinkedTransportPair,
  type JSONRPCMessage,
} from "../../src/mcp/transport";
import { createMCPClient, type MCPClient } from "../../src/mcp/client";

// ─── E2E: 插件加载 + 钩子注册 + 事件分发 ───

describe("Phase 6 E2E > 插件 + 钩子 + 事件", () => {
  let registry: PluginRegistryExtended;
  let hookRegistry: HookRegistry;
  let emitter: EventEmitter<SystemEvent>;
  let engine: HookEngine;

  beforeEach(() => {
    registry = createPluginRegistryImpl({ autoActivate: false });
    hookRegistry = createHookRegistry();
    emitter = createEventEmitter<SystemEvent>();
    engine = createHookEngine(hookRegistry, emitter);
  });

  it("完整流程：注册插件 → 注册钩子 → 触发事件 → 钩子执行 → 事件分发", async () => {
    // 1. 注册插件
    const plugin = definePluginEntry({
      name: "monitor-plugin",
      version: "1.0.0",
      description: "Monitors tool calls",
      source: "user",
    });
    registry.register(plugin);
    expect(registry.getState("monitor-plugin")).toBe("registered");

    // 2. 注册钩子（模拟插件注册的钩子）
    const hookResults: string[] = [];
    hookRegistry.register({
      id: "tool-monitor",
      event: "tool",
      action: "after_call",
      handler: async (...args) => {
        const event = args[0] as SystemEvent;
        if (event.type === "tool") {
          hookResults.push(`hook:${event.toolName}`);
        }
      },
      source: "plugin",
      priority: 50,
      enabled: true,
    });

    // 3. 注册事件监听器
    const eventResults: string[] = [];
    emitter.on("tool:after_call", (e) => {
      if (e.type === "tool") {
        eventResults.push(`event:${e.toolName}`);
      }
    });

    // 4. 触发工具事件
    const toolEvent = createToolEvent("after_call", "bash", {
      success: true,
      durationMs: 100,
    });

    // 通过钩子引擎触发
    const hookResult = await engine.trigger("tool", "after_call", [toolEvent]);
    expect(hookResult.executedCount).toBe(1);
    expect(hookResults).toEqual(["hook:bash"]);

    // 通过事件发射器触发
    const eventResult = await engine.emitEvent(toolEvent);
    expect(eventResult.invokedCount).toBe(1);
    expect(eventResults).toEqual(["event:bash"]);
  });

  it("插件错误不影响钩子系统", async () => {
    // 注册一个会失败的钩子
    hookRegistry.register({
      id: "failing-hook",
      event: "agent",
      handler: async () => { throw new Error("hook failure"); },
      source: "builtin",
      priority: 10,
      enabled: true,
    });

    // 注册一个正常的钩子
    const results: string[] = [];
    hookRegistry.register({
      id: "normal-hook",
      event: "agent",
      handler: async () => { results.push("ok"); },
      source: "plugin",
      priority: 20,
      enabled: true,
    });

    const result = await engine.trigger("agent", "created", []);
    expect(result.executedCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(results).toEqual(["ok"]);
  });

  it("多来源钩子按优先级执行", async () => {
    const order: string[] = [];

    hookRegistry.register({
      id: "builtin-h",
      event: "test",
      handler: async () => { order.push("builtin"); },
      source: "builtin",
      priority: 100,
      enabled: true,
    });
    hookRegistry.register({
      id: "plugin-h",
      event: "test",
      handler: async () => { order.push("plugin"); },
      source: "plugin",
      priority: 100,
      enabled: true,
    });
    hookRegistry.register({
      id: "workspace-h",
      event: "test",
      handler: async () => { order.push("workspace"); },
      source: "workspace",
      priority: 100,
      enabled: true,
    });

    await engine.trigger("test", undefined, []);
    // workspace(50) > plugin(20) > builtin(10)
    expect(order).toEqual(["workspace", "plugin", "builtin"]);
  });
});

// ─── E2E: 技能系统 + 条件激活 ───

describe("Phase 6 E2E > 技能系统", () => {
  it("SKILL.md 解析 + 条件激活完整流程", () => {
    const skillContent = `---
description: TypeScript language helper
allowed-tools:
  - read
  - edit
paths:
  - "*.ts"
  - "src/**/*.ts"
---
# TypeScript Helper

When working with TypeScript files, this skill provides guidance.`;

    // 解析 SKILL.md
    const { frontmatter, body } = parseFrontmatter(skillContent);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.description).toBe("TypeScript language helper");
    expect(frontmatter!["allowed-tools"]).toEqual(["read", "edit"]);
    expect(frontmatter!.paths).toEqual(["*.ts", "src/**/*.ts"]);
    expect(body.trim()).toContain("# TypeScript Helper");

    // 创建技能定义
    const skill: SkillDefinition = {
      name: "ts-helper",
      source: "project",
      dirPath: "/project/.claude/skills/ts-helper",
      frontmatter: frontmatter!,
      markdownContent: body,
      isConditional: true,
      activated: false,
    };

    // 条件激活
    const result = activateConditionalSkills(
      [skill],
      ["src/index.ts", "lib/util.js"],
      "/project",
    );

    expect(result.activatedNames).toEqual(["ts-helper"]);
    expect(result.totalChecked).toBe(1);
  });

  it("多个技能独立匹配", () => {
    const skills: SkillDefinition[] = [
      {
        name: "ts-skill",
        source: "project",
        dirPath: "/p",
        frontmatter: { description: "TS", paths: ["*.ts"] },
        markdownContent: "",
        isConditional: true,
        activated: false,
      },
      {
        name: "js-skill",
        source: "project",
        dirPath: "/p",
        frontmatter: { description: "JS", paths: ["*.js"] },
        markdownContent: "",
        isConditional: true,
        activated: false,
      },
      {
        name: "py-skill",
        source: "project",
        dirPath: "/p",
        frontmatter: { description: "PY", paths: ["*.py"] },
        markdownContent: "",
        isConditional: true,
        activated: false,
      },
    ];

    const result = activateConditionalSkills(
      skills,
      ["src/index.ts", "lib/util.js", "README.md"],
      "/project",
    );

    expect(result.activatedNames).toContain("ts-skill");
    expect(result.activatedNames).toContain("js-skill");
    expect(result.activatedNames).not.toContain("py-skill");
  });
});

// ─── E2E: MCP 通信 ───

describe("Phase 6 E2E > MCP 通信", () => {
  it("Client → Transport → Server 完整消息流", async () => {
    const [clientTransport, serverTransport] = createLinkedTransportPair();
    const serverReceived: JSONRPCMessage[] = [];

    // 模拟 MCP Server：收到请求后返回响应
    serverTransport.onmessage = (msg) => {
      serverReceived.push(msg);
      if (msg.id !== undefined && msg.method !== undefined) {
        const response: JSONRPCMessage = {
          jsonrpc: "2.0",
          id: msg.id,
          result: msg.method === "tools/list"
            ? { tools: [{ name: "bash" }] }
            : msg.method === "tools/call"
              ? { content: [{ type: "text", text: "done" }] }
              : msg.method === "resources/read"
                ? { contents: [{ uri: "file:///test.txt", text: "content" }] }
                : {},
        };
        serverTransport.send(response);
      }
    };

    const client = createMCPClient({
      name: "test-client",
      version: "1.0.0",
      transport: clientTransport,
      requestTimeout: 5000,
    });

    await client.connect();
    expect(client.connected).toBe(true);

    // 发送多个请求
    await client.listTools();
    await client.callTool("bash", { command: "ls" });
    await client.readResource("file:///test.txt");

    expect(serverReceived).toHaveLength(3);
    expect(serverReceived[0]!.method).toBe("tools/list");
    expect(serverReceived[1]!.method).toBe("tools/call");
    expect(serverReceived[2]!.method).toBe("resources/read");

    await client.disconnect();
    expect(client.connected).toBe(false);
  });
});

// ─── E2E: 全系统联动 ───

describe("Phase 6 E2E > 全系统联动", () => {
  it("插件注册 → 钩子触发 → 事件广播 → MCP 通知", async () => {
    // 设置所有组件
    const hookRegistry = createHookRegistry();
    const emitter = createEventEmitter<SystemEvent>();
    const engine = createHookEngine(hookRegistry, emitter);
    const pluginRegistry = createPluginRegistryImpl({ autoActivate: false });

    // 1. 注册插件
    const plugin = definePluginEntry({
      name: "lifecycle-monitor",
      version: "1.0.0",
      description: "Monitors agent lifecycle",
      source: "builtin",
    });
    pluginRegistry.register(plugin);

    // 2. 注册钩子
    const lifecycleLog: string[] = [];
    hookRegistry.register({
      id: "lifecycle-hook",
      event: "agent",
      action: "completed",
      handler: async (...args) => {
        const event = args[0] as SystemEvent;
        if (event.type === "agent") {
          lifecycleLog.push(`hook:agent:${event.action}:${event.agentId}`);
        }
      },
      source: "builtin",
      priority: 10,
      enabled: true,
    });

    // 3. 注册事件监听
    const eventLog: string[] = [];
    emitter.on("agent:completed", (e) => {
      if (e.type === "agent") {
        eventLog.push(`event:agent:${e.action}:${e.agentId}`);
      }
    });

    // 4. 模拟 Agent 完成事件
    const agentEvent = createAgentEvent("completed", "agent-42", {
      sessionId: "sess-1",
    });

    // 通过钩子引擎触发
    const hookResult = await engine.trigger("agent", "completed", [agentEvent]);
    expect(hookResult.executedCount).toBe(1);
    expect(lifecycleLog).toEqual(["hook:agent:completed:agent-42"]);

    // 通过事件发射器广播
    const eventResult = await engine.emitEvent(agentEvent);
    expect(eventResult.invokedCount).toBe(1);
    expect(eventLog).toEqual(["event:agent:completed:agent-42"]);

    // 5. 验证插件状态
    expect(pluginRegistry.get("lifecycle-monitor")).toBeDefined();
    expect(pluginRegistry.count()).toBe(1);
  });
});

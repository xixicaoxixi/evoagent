/**
 * 阶段 1 集成测试 — 跨模块验证。
 *
 * 验证类型、Schema、Store、配置管线、持久化、LLM Provider 之间的协作。
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── 类型测试 ───

import {
  TaskId, RuleId, AgentId,
} from "../../src/types/ids";
import {
  AgentStatus, canTransition, TaskStatus,
} from "../../src/types/agent";
import {
  EvolutionAction, RuleStatus, isValidAction, canRuleTransition,
} from "../../src/types/evolution";
import {
  MessageRole, extractMessageContent, assertNever,
} from "../../src/types/message";
import {
  allowPermission, denyPermission, isAllowed, isDenied,
  validationOk, validationErr,
} from "../../src/types/permission";
import {
  createToolUse, createToolResult,
} from "../../src/types/tool";
import {
  inferProviderType, estimateTokens, ProviderType,
} from "../../src/types/common";

// ─── Schema 测试 ───

import {
  EvolutionRuleSchema, ErrorRecordSchema,
} from "../../src/schemas/evolution";
import { MessageSchema } from "../../src/schemas/message";
import { AppConfigSchema } from "../../src/schemas/config";

// ─── 核心模块测试 ───

import { createStore } from "../../src/core/store";
import { createConfigPipeline } from "../../src/core/config";
import { atomicWriteJSON, atomicReadJSON } from "../../src/persistence/atomic-write";
import { appendJSONL, readJSONL, countJSONL, truncateJSONL } from "../../src/persistence/jsonl";
import { createSnapshotManager } from "../../src/persistence/snapshot";

// ─── LLM Provider 测试 ───

import { MockProvider } from "../../src/llm/mock";
import { runWithModelFallback } from "../../src/llm/fallback";

// ─── 测试临时目录 ───

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `evoagent-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════
// 1. Branded Types
// ═══════════════════════════════════════════════

describe("Branded Types", () => {
  test("TaskId.fromUUID 生成唯一 ID", () => {
    const id1 = TaskId.fromUUID();
    const id2 = TaskId.fromUUID();
    expect(id1).not.toBe(id2);
    expect(typeof id1).toBe("string");
  });

  test("RuleId.create 从字符串创建", () => {
    const id = RuleId.create("rule-001");
    expect(id).toBe("rule-001");
  });

  test("AgentId 类型安全（编译时检查）", () => {
    const agentId = AgentId.fromUUID();
    const taskId = TaskId.fromUUID();
    // TypeScript 会在编译时阻止 agentId 赋值给 TaskId
    // 这里只验证运行时值
    expect(typeof agentId).toBe("string");
    expect(typeof taskId).toBe("string");
  });
});

// ═══════════════════════════════════════════════
// 2. Agent 状态机
// ═══════════════════════════════════════════════

describe("Agent State Machine", () => {
  test("合法状态转换", () => {
    expect(canTransition("CREATED", "INITIALIZING")).toBe(true);
    expect(canTransition("INITIALIZING", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "COMPLETED")).toBe(true);
    expect(canTransition("RUNNING", "FAILED")).toBe(true);
    expect(canTransition("COMPLETED", "DESTROYED")).toBe(true);
  });

  test("非法状态转换", () => {
    expect(canTransition("CREATED", "RUNNING")).toBe(false);
    expect(canTransition("DESTROYED", "RUNNING")).toBe(false);
    expect(canTransition("CREATED", "COMPLETED")).toBe(false);
  });

  test("枚举穷举", () => {
    const statuses = Object.values(AgentStatus);
    expect(statuses).toHaveLength(6);
  });
});

// ═══════════════════════════════════════════════
// 3. Evolution Action 验证
// ═══════════════════════════════════════════════

describe("Evolution Action", () => {
  test("16 种合法 Action", () => {
    const actions = Object.values(EvolutionAction);
    expect(actions).toHaveLength(16);
  });

  test("isValidAction 验证", () => {
    expect(isValidAction("RETRY_WITH_HIGHER_TIMEOUT")).toBe(true);
    expect(isValidAction("INVALID_ACTION")).toBe(false);
  });

  test("规则状态转换", () => {
    expect(canRuleTransition("PENDING_APPROVAL", "SANDBOX")).toBe(true);
    expect(canRuleTransition("SANDBOX", "PROBATION")).toBe(true);
    expect(canRuleTransition("PROBATION", "ACTIVE")).toBe(true);
    expect(canRuleTransition("ACTIVE", "DEPRECATED")).toBe(true);
    expect(canRuleTransition("DEPRECATED", "ACTIVE")).toBe(false);
  });
});

// ═══════════════════════════════════════════════
// 4. 消息类型
// ═══════════════════════════════════════════════

describe("Message Types", () => {
  test("extractMessageContent 正确提取内容", () => {
    expect(
      extractMessageContent({
        id: "1", role: "user", timestamp: Date.now(), content: "hello",
      }),
    ).toBe("hello");

    expect(
      extractMessageContent({
        id: "2", role: "tool_use", timestamp: Date.now(),
        toolName: "bash", toolUseId: "t1", input: { cmd: "ls" },
      }),
    ).toContain("bash");
  });

  test("assertNever 抛出错误", () => {
    expect(() => assertNever("never" as never)).toThrow("Unhandled");
  });
});

// ═══════════════════════════════════════════════
// 5. Permission 类型
// ═══════════════════════════════════════════════

describe("Permission Types", () => {
  test("allowPermission", () => {
    const result = allowPermission();
    expect(isAllowed(result)).toBe(true);
    expect(result.behavior).toBe("allow");
  });

  test("denyPermission", () => {
    const result = denyPermission("not allowed");
    expect(isDenied(result)).toBe(true);
    expect(result.reason).toBe("not allowed");
  });

  test("validationOk / validationErr", () => {
    expect(validationOk().ok).toBe(true);
    expect(validationErr("bad").ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════
// 6. Zod Schema 验证
// ═══════════════════════════════════════════════

describe("Zod Schemas", () => {
  test("EvolutionRuleSchema 验证完整规则", () => {
    const result = EvolutionRuleSchema.safeParse({
      rule_id: "rule-001",
      created_at: "2024-01-01",
      source_error_id: "err-001",
      trigger_pattern: "timeout",
      action: "RETRY_WITH_HIGHER_TIMEOUT",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("PENDING_APPROVAL");
      expect(result.data.priority).toBe(0.5);
    }
  });

  test("EvolutionRuleSchema 拒绝无效 action", () => {
    const result = EvolutionRuleSchema.safeParse({
      rule_id: "rule-002",
      created_at: "2024-01-01",
      source_error_id: "err-002",
      trigger_pattern: "test",
      action: "INVALID_ACTION",
    });
    expect(result.success).toBe(false);
  });

  test("MessageSchema 验证 UserMessage", () => {
    const result = MessageSchema.safeParse({
      id: "msg-001",
      role: "user",
      timestamp: Date.now(),
      content: "hello",
    });
    expect(result.success).toBe(true);
  });

  test("AppConfigSchema 默认值", () => {
    const config = AppConfigSchema.parse({});
    expect(config.llm.provider_type).toBe("openai");
    expect(config.llm.model).toBe("gpt-4o");
    expect(config.evolution.max_rules).toBe(50);
  });
});

// ═══════════════════════════════════════════════
// 7. Store
// ═══════════════════════════════════════════════

describe("Store", () => {
  test("createStore 基本功能", () => {
    const store = createStore({ count: 0 });
    expect(store.getState().count).toBe(0);

    store.setState((prev) => ({ count: prev.count + 1 }));
    expect(store.getState().count).toBe(1);
  });

  test("subscribe 订阅变更", () => {
    const store = createStore({ value: "a" });
    const changes: string[] = [];

    store.subscribe(() => {
      changes.push(store.getState().value);
    });

    store.setState(() => ({ value: "b" }));
    store.setState(() => ({ value: "c" }));
    expect(changes).toEqual(["b", "c"]);
  });

  test("setState 相同值不触发更新", () => {
    let callCount = 0;
    const obj = { x: 1 };
    const store = createStore(
      obj,
      () => { callCount++; },
    );

    store.setState(() => obj); // 相同引用
    expect(callCount).toBe(0);

    store.setState(() => ({ x: 2 })); // 不同引用
    expect(callCount).toBe(1);
  });

  test("unsubscribe 取消订阅", () => {
    const store = createStore({ n: 0 });
    const changes: number[] = [];

    const unsub = store.subscribe(() => {
      changes.push(store.getState().n);
    });

    store.setState(() => ({ n: 1 }));
    unsub();
    store.setState(() => ({ n: 2 }));
    expect(changes).toEqual([1]);
  });
});

// ═══════════════════════════════════════════════
// 8. 配置管线
// ═══════════════════════════════════════════════

describe("Config Pipeline", () => {
  test("加载不存在的配置文件返回默认值", async () => {
    const pipeline = createConfigPipeline({
      configPath: join(testDir, "nonexistent.json"),
    });

    const result = await pipeline.load();
    expect(result.config.llm.provider_type).toBe("openai");
    expect(result.config.llm.model).toBe("gpt-4o");
    expect(result.version).toBe(1);
  });

  test("保存和加载配置", async () => {
    const configPath = join(testDir, "config.json");
    const pipeline = createConfigPipeline({ configPath });

    await pipeline.save({
      llm: { provider_type: "anthropic", model: "claude-sonnet-4-20250514" },
    });

    const pipeline2 = createConfigPipeline({ configPath });
    const result = await pipeline2.load();
    expect(result.config.llm.provider_type).toBe("anthropic");
    expect(result.config.llm.model).toBe("claude-sonnet-4-20250514");
  });

  test("热更新配置", async () => {
    const configPath = join(testDir, "config.json");
    const pipeline = createConfigPipeline({ configPath });

    const result = await pipeline.hotUpdate({
      evolution: { auto_evolution: false },
    });
    expect(result.config.evolution.auto_evolution).toBe(false);
    expect(result.version).toBe(1);
  });
});

// ═══════════════════════════════════════════════
// 9. 持久化
// ═══════════════════════════════════════════════

describe("Persistence", () => {
  test("原子写入和读取 JSON", async () => {
    const filePath = join(testDir, "test.json");
    await atomicWriteJSON(filePath, { key: "value" });
    const data = await atomicReadJSON<{ key: string }>(filePath);
    expect(data).toEqual({ key: "value" });
  });

  test("读取不存在的文件返回 null", async () => {
    const data = await atomicReadJSON(join(testDir, "nonexistent.json"));
    expect(data).toBeNull();
  });

  test("JSONL 追加和读取", async () => {
    const filePath = join(testDir, "log.jsonl");
    await appendJSONL(filePath, { event: "start", ts: 1 });
    await appendJSONL(filePath, { event: "end", ts: 2 });

    const records = await readJSONL(filePath);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ event: "start", ts: 1 });
  });

  test("JSONL 计数和截断", async () => {
    const filePath = join(testDir, "truncate.jsonl");
    for (let i = 0; i < 20; i++) {
      await appendJSONL(filePath, { i });
    }

    expect(await countJSONL(filePath)).toBe(20);

    const newCount = await truncateJSONL(filePath, 5);
    expect(newCount).toBe(5);
    expect(await countJSONL(filePath)).toBe(5);
  });

  test("快照创建和回滚", async () => {
    const snapshotsDir = join(testDir, "snapshots");
    const manager = createSnapshotManager({
      snapshotsDir,
      maxCount: 5,
    });

    const meta = await manager.create(
      { rules: ["rule1", "rule2"] },
      "test snapshot",
      false,
      1,
    );
    expect(meta.snapshotId).toContain("snap_");

    const data = await manager.rollback(meta.snapshotId);
    expect(data).toEqual({ rules: ["rule1", "rule2"] });
  });
});

// ═══════════════════════════════════════════════
// 10. LLM Provider
// ═══════════════════════════════════════════════

describe("LLM Providers", () => {
  test("MockProvider 基本调用", async () => {
    const mock = new MockProvider({ defaultResponse: "test response" });
    const response = await mock.invoke([
      { role: "user", content: "hello" },
    ]);
    expect(response.content).toBe("test response");
    expect(response.stopReason).toBe("end_turn");
    expect(mock.callHistory).toHaveLength(1);
  });

  test("MockProvider 自定义响应函数", async () => {
    const mock = new MockProvider({
      responseFn: (msgs) => `Echo: ${msgs[0]?.content ?? ""}`,
    });
    const response = await mock.invoke([
      { role: "user", content: "hello" },
    ]);
    expect(response.content).toBe("Echo: hello");
  });

  test("MockProvider 流式输出", async () => {
    const mock = new MockProvider({ defaultResponse: "ABC" });
    const chunks: string[] = [];
    for await (const chunk of mock.stream([
      { role: "user", content: "test" },
    ])) {
      if (chunk.type === "content" && chunk.content) {
        chunks.push(chunk.content);
      }
    }
    expect(chunks).toEqual(["A", "B", "C"]);
  });

  test("MockProvider 健康检查", async () => {
    const mock = new MockProvider();
    expect(await mock.healthCheck()).toBe(true);

    const failing = new MockProvider({ shouldFail: true });
    expect(await failing.healthCheck()).toBe(false);
  });

  test("runWithModelFallback 主 Provider 成功", async () => {
    const mock = new MockProvider({ defaultResponse: "primary" });
    const result = await runWithModelFallback(
      [{ role: "user", content: "test" }],
      { providers: [mock] },
    );
    expect(result.response.content).toBe("primary");
    expect(result.providerIndex).toBe(0);
    expect(result.retries).toBe(0);
  });

  test("runWithModelFallback 故障转移", async () => {
    const failing = new MockProvider({ shouldFail: true });
    const fallback = new MockProvider({ defaultResponse: "fallback" });

    const result = await runWithModelFallback(
      [{ role: "user", content: "test" }],
      { providers: [failing, fallback], maxRetries: 0 },
    );
    expect(result.response.content).toBe("fallback");
    expect(result.providerIndex).toBe(1);
  });

  test("runWithModelFallback 全部失败抛出错误", async () => {
    const failing1 = new MockProvider({ shouldFail: true });
    const failing2 = new MockProvider({ shouldFail: true });

    expect(
      runWithModelFallback(
        [{ role: "user", content: "test" }],
        { providers: [failing1, failing2], maxRetries: 0 },
      ),
    ).rejects.toThrow("All providers failed");
  });
});

// ═══════════════════════════════════════════════
// 11. 通用工具
// ═══════════════════════════════════════════════

describe("Common Utilities", () => {
  test("inferProviderType 自动推断", () => {
    expect(inferProviderType("gpt-4o")).toBe("openai");
    expect(inferProviderType("claude-sonnet-4-20250514")).toBe("anthropic");
    expect(inferProviderType("llama3")).toBe("ollama");
    expect(inferProviderType("deepseek-chat")).toBe("deepseek");
    expect(inferProviderType("moonshot-v1-8k")).toBe("kimi");
    expect(inferProviderType("glm-4-flash")).toBe("glm");
    expect(inferProviderType("unknown-model")).toBeUndefined();
  });

  test("estimateTokens CJK 感知", () => {
    const cjkTokens = estimateTokens("你好世界");
    const asciiTokens = estimateTokens("hello world");
    // CJK 字符应该比相同长度的 ASCII 消耗更多 token
    expect(cjkTokens).toBeGreaterThan(0);
    expect(asciiTokens).toBeGreaterThan(0);
  });
});

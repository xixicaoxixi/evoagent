import { describe, it, expect } from "vitest";
import { z } from "zod";
import { coerceToolArgs } from "../../src/tools/coerce";
import { createToolDefinition } from "../../src/tools/builder";
import type { Tool } from "../../src/interfaces/tool";
import { StreamingToolExecutor, type ExecutorConfig } from "../../src/tools/executor";

// ─── 模拟工具：验证 coercion 后 Zod 验证仍执行 ───

function createCoerceTestTool(): Tool {
  const schema = z.object({
    count: z.number().int().min(0).max(100),
    name: z.string(),
    flag: z.boolean(),
    tags: z.array(z.string()).optional(),
  });

  return createToolDefinition({
    name: "coerce-test",
    description: "Test tool for coercion",
    inputSchema: schema,
    async call(input) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return {
          content: `Validation failed: ${parsed.error.message}`,
          isError: true,
        };
      }
      return {
        content: JSON.stringify(parsed.data),
        isError: false,
      };
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    checkPermissions: async () => ({ behavior: "allow" as const }),
  });
}

describe("Coercion + Zod 验证集成", () => {
  it("coercion 后 Zod 验证成功", () => {
    const schema = z.object({
      count: z.number().int().min(0).max(100),
      flag: z.boolean(),
    });

    const { coerced } = coerceToolArgs({ count: "5", flag: "true" }, schema);

    const parsed = schema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.count).toBe(5);
      expect(parsed.data.flag).toBe(true);
    }
  });

  it("coercion 后 Zod 验证仍可拒绝无效值", () => {
    const schema = z.object({
      count: z.number().int().min(0).max(100),
    });

    const { coerced } = coerceToolArgs({ count: "200" }, schema);

    expect(coerced.count).toBe(200);

    const parsed = schema.safeParse(coerced);
    expect(parsed.success).toBe(false);
  });

  it("coercion 不改变无法转换的值，Zod 验证会拒绝", () => {
    const schema = z.object({
      count: z.number(),
    });

    const { coerced } = coerceToolArgs({ count: "not-a-number" }, schema);

    const parsed = schema.safeParse(coerced);
    expect(parsed.success).toBe(false);
  });

  it("coercion 后布尔验证正确", () => {
    const schema = z.object({
      flag: z.boolean(),
    });

    const { coerced } = coerceToolArgs({ flag: "true" }, schema);
    const parsed = schema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.flag).toBe(true);
    }
  });

  it("coercion 后数组验证正确", () => {
    const schema = z.object({
      tags: z.array(z.string()),
    });

    const { coerced } = coerceToolArgs({ tags: "single" }, schema);
    const parsed = schema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tags).toEqual(["single"]);
    }
  });
});

describe("Coercion + Tool 集成", () => {
  it("工具通过 coercion 接收正确类型", async () => {
    const tool = createCoerceTestTool();
    const schema = tool.inputSchema;

    const { coerced } = coerceToolArgs(
      { count: "5", name: "test", flag: "true" },
      schema,
    );

    const result = await tool.call(
      coerced,
      { getAppState: () => ({}) },
      () => true,
    );

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content as string);
    expect(data.count).toBe(5);
    expect(data.name).toBe("test");
    expect(data.flag).toBe(true);
  });

  it("工具在 coercion 无法修复时返回验证错误", async () => {
    const tool = createCoerceTestTool();
    const schema = tool.inputSchema;

    const { coerced } = coerceToolArgs(
      { count: "not-a-number", name: "test", flag: "true" },
      schema,
    );

    const result = await tool.call(
      coerced,
      { getAppState: () => ({}) },
      () => true,
    );

    expect(result.isError).toBe(true);
    expect((result.content as string).includes("Validation failed")).toBe(true);
  });
});

describe("Coercion + Executor 集成", () => {
  it("StreamingToolExecutor 自动 coercion", async () => {
    const tool = createCoerceTestTool();

    const config: ExecutorConfig = {
      tools: [tool],
      context: { getAppState: () => ({}) },
      canUseTool: () => true,
    };

    const executor = new StreamingToolExecutor(config);
    const results = [];

    for await (const result of executor.execute([
      {
        toolUseId: "test-1",
        toolName: "coerce-test",
        input: { count: "5", name: "test", flag: "true" },
        tool,
      },
    ])) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.message.isError).toBe(false);

    const data = JSON.parse(results[0]!.message.content);
    expect(data.count).toBe(5);
    expect(data.flag).toBe(true);
  });

  it("StreamingToolExecutor coercion 失败时工具返回验证错误", async () => {
    const tool = createCoerceTestTool();

    const config: ExecutorConfig = {
      tools: [tool],
      context: { getAppState: () => ({}) },
      canUseTool: () => true,
    };

    const executor = new StreamingToolExecutor(config);
    const results = [];

    for await (const result of executor.execute([
      {
        toolUseId: "test-2",
        toolName: "coerce-test",
        input: { count: "not-a-number", name: "test", flag: "true" },
        tool,
      },
    ])) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.message.isError).toBe(true);
  });
});

describe("Coercion — 开源模型类型漂移场景", () => {
  it("场景1：模型输出 timeout 为字符串", () => {
    const schema = z.object({
      command: z.string(),
      timeout: z.number().optional(),
    });

    const { coerced } = coerceToolArgs(
      { command: "npm test", timeout: "60000" },
      schema,
    );

    const parsed = schema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.timeout).toBe(60000);
    }
  });

  it("场景2：模型输出布尔值为字符串", () => {
    const schema = z.object({
      file_path: z.string(),
      old_str: z.string(),
      new_str: z.string(),
      replace_all: z.boolean().default(false),
    });

    const { coerced } = coerceToolArgs(
      { file_path: "test.ts", old_str: "foo", new_str: "bar", replace_all: "true" },
      schema,
    );

    const parsed = schema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.replace_all).toBe(true);
    }
  });

  it("场景3：模型输出数组项为单个字符串", () => {
    const schema = z.object({
      pattern: z.string(),
      ignore: z.array(z.string()).optional(),
    });

    const { coerced } = coerceToolArgs(
      { pattern: "*.ts", ignore: "node_modules" },
      schema,
    );

    const parsed = schema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ignore).toEqual(["node_modules"]);
    }
  });

  it("场景4：模型输出 offset/limit 为字符串", () => {
    const schema = z.object({
      file_path: z.string(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional(),
    });

    const { coerced } = coerceToolArgs(
      { file_path: "test.ts", offset: "10", limit: "50" },
      schema,
    );

    const parsed = schema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.offset).toBe(10);
      expect(parsed.data.limit).toBe(50);
    }
  });

  it("场景5：模型输出多个参数类型均漂移", () => {
    const schema = z.object({
      count: z.number(),
      flag: z.boolean(),
      tags: z.array(z.string()).optional(),
    });

    const { coerced } = coerceToolArgs(
      { count: "3", flag: "false", tags: "urgent" },
      schema,
    );

    const parsed = schema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.count).toBe(3);
      expect(parsed.data.flag).toBe(false);
      expect(parsed.data.tags).toEqual(["urgent"]);
    }
  });

  it("场景6：正确类型输入不受影响", () => {
    const schema = z.object({
      count: z.number(),
      flag: z.boolean(),
      tags: z.array(z.string()).optional(),
    });

    const { coerced, applied } = coerceToolArgs(
      { count: 3, flag: false, tags: ["a", "b"] },
      schema,
    );

    const parsed = schema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    expect(applied).toHaveLength(0);
  });
});

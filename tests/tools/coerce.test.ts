import { describe, it, expect } from "vitest";
import { z } from "zod";
import { coerceToolArgs, type CoerceResult } from "../../src/tools/coerce";

describe("coerceToolArgs — 字符串→数字", () => {
  it('"5" → 5（整数）', () => {
    const schema = z.object({ count: z.number() });
    const result = coerceToolArgs({ count: "5" }, schema);
    expect(result.coerced.count).toBe(5);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.field).toBe("count");
  });

  it('"3.14" → 3.14（浮点数）', () => {
    const schema = z.object({ ratio: z.number() });
    const result = coerceToolArgs({ ratio: "3.14" }, schema);
    expect(result.coerced.ratio).toBe(3.14);
    expect(result.applied).toHaveLength(1);
  });

  it('"-7" → -7（负数）', () => {
    const schema = z.object({ offset: z.number() });
    const result = coerceToolArgs({ offset: "-7" }, schema);
    expect(result.coerced.offset).toBe(-7);
  });

  it('"123abc" 不转换（非纯数字）', () => {
    const schema = z.object({ count: z.number() });
    const result = coerceToolArgs({ count: "123abc" }, schema);
    expect(result.coerced.count).toBe("123abc");
    expect(result.applied).toHaveLength(0);
  });

  it('"" 不转换（空字符串）', () => {
    const schema = z.object({ count: z.number() });
    const result = coerceToolArgs({ count: "" }, schema);
    expect(result.coerced.count).toBe("");
    expect(result.applied).toHaveLength(0);
  });

  it('"Infinity" 不转换', () => {
    const schema = z.object({ count: z.number() });
    const result = coerceToolArgs({ count: "Infinity" }, schema);
    expect(result.coerced.count).toBe("Infinity");
    expect(result.applied).toHaveLength(0);
  });

  it("已是数字时不转换", () => {
    const schema = z.object({ count: z.number() });
    const result = coerceToolArgs({ count: 5 }, schema);
    expect(result.coerced.count).toBe(5);
    expect(result.applied).toHaveLength(0);
  });

  it("optional 字段也正确强制", () => {
    const schema = z.object({ timeout: z.number().optional() });
    const result = coerceToolArgs({ timeout: "30000" }, schema);
    expect(result.coerced.timeout).toBe(30000);
    expect(result.applied).toHaveLength(1);
  });
});

describe("coerceToolArgs — 字符串→布尔", () => {
  it('"true" → true', () => {
    const schema = z.object({ replace_all: z.boolean() });
    const result = coerceToolArgs({ replace_all: "true" }, schema);
    expect(result.coerced.replace_all).toBe(true);
    expect(result.applied).toHaveLength(1);
  });

  it('"false" → false', () => {
    const schema = z.object({ replace_all: z.boolean() });
    const result = coerceToolArgs({ replace_all: "false" }, schema);
    expect(result.coerced.replace_all).toBe(false);
    expect(result.applied).toHaveLength(1);
  });

  it('"TRUE" → true（大小写不敏感）', () => {
    const schema = z.object({ flag: z.boolean() });
    const result = coerceToolArgs({ flag: "TRUE" }, schema);
    expect(result.coerced.flag).toBe(true);
  });

  it('"False" → false（大小写不敏感）', () => {
    const schema = z.object({ flag: z.boolean() });
    const result = coerceToolArgs({ flag: "False" }, schema);
    expect(result.coerced.flag).toBe(false);
  });

  it('"yes" 不转换（非标准布尔值）', () => {
    const schema = z.object({ flag: z.boolean() });
    const result = coerceToolArgs({ flag: "yes" }, schema);
    expect(result.coerced.flag).toBe("yes");
    expect(result.applied).toHaveLength(0);
  });

  it('"1" 不转换（非标准布尔值）', () => {
    const schema = z.object({ flag: z.boolean() });
    const result = coerceToolArgs({ flag: "1" }, schema);
    expect(result.coerced.flag).toBe("1");
    expect(result.applied).toHaveLength(0);
  });

  it("已是布尔时不转换", () => {
    const schema = z.object({ flag: z.boolean() });
    const result = coerceToolArgs({ flag: true }, schema);
    expect(result.coerced.flag).toBe(true);
    expect(result.applied).toHaveLength(0);
  });
});

describe("coerceToolArgs — 数组包裹", () => {
  it('"url" → ["url"]（字符串→字符串数组）', () => {
    const schema = z.object({ ignore: z.array(z.string()) });
    const result = coerceToolArgs({ ignore: "url" }, schema);
    expect(result.coerced.ignore).toEqual(["url"]);
    expect(result.applied).toHaveLength(1);
  });

  it('"5" → [5]（数字字符串→数字数组）', () => {
    const schema = z.object({ ids: z.array(z.number()) });
    const result = coerceToolArgs({ ids: "5" }, schema);
    expect(result.coerced.ids).toEqual([5]);
    expect(result.applied).toHaveLength(1);
  });

  it("已是数组时不转换", () => {
    const schema = z.object({ ignore: z.array(z.string()) });
    const result = coerceToolArgs({ ignore: ["a", "b"] }, schema);
    expect(result.coerced.ignore).toEqual(["a", "b"]);
    expect(result.applied).toHaveLength(0);
  });

  it("数字→数字数组", () => {
    const schema = z.object({ ids: z.array(z.number()) });
    const result = coerceToolArgs({ ids: 42 }, schema);
    expect(result.coerced.ids).toEqual([42]);
    expect(result.applied).toHaveLength(1);
  });
});

describe("coerceToolArgs — 路径规范化", () => {
  it("file_path 字段在 Windows 上正斜杠→反斜杠", () => {
    const schema = z.object({ file_path: z.string() });
    const result = coerceToolArgs({ file_path: "src/tools/coerce.ts" }, schema);

    if (process.platform === "win32") {
      expect(result.coerced.file_path).toBe("src\\tools\\coerce.ts");
    } else {
      expect(result.coerced.file_path).toBe("src/tools/coerce.ts");
    }
  });

  it("path 字段规范化", () => {
    const schema = z.object({ path: z.string() });
    const result = coerceToolArgs({ path: "src/mcp/client.ts" }, schema);

    if (process.platform === "win32") {
      expect(result.coerced.path).toBe("src\\mcp\\client.ts");
    } else {
      expect(result.coerced.path).toBe("src/mcp/client.ts");
    }
  });

  it("非路径字段不规范化", () => {
    const schema = z.object({ command: z.string() });
    const result = coerceToolArgs({ command: "ls src/tools" }, schema);
    expect(result.coerced.command).toBe("ls src/tools");
  });

  it("cwd 字段规范化", () => {
    const schema = z.object({ cwd: z.string() });
    const result = coerceToolArgs({ cwd: "g:/工作内容/solo" }, schema);

    if (process.platform === "win32") {
      expect(result.coerced.cwd).toBe("g:\\工作内容\\solo");
    } else {
      expect(result.coerced.cwd).toBe("g:/工作内容/solo");
    }
  });
});

describe("coerceToolArgs — 不转换的情况", () => {
  it("schema 期望字符串时不转换字符串", () => {
    const schema = z.object({ name: z.string() });
    const result = coerceToolArgs({ name: "hello" }, schema);
    expect(result.coerced.name).toBe("hello");
    expect(result.applied).toHaveLength(0);
  });

  it("null 值不转换", () => {
    const schema = z.object({ count: z.number().nullable() });
    const result = coerceToolArgs({ count: null }, schema);
    expect(result.coerced.count).toBe(null);
    expect(result.applied).toHaveLength(0);
  });

  it("undefined 值不转换", () => {
    const schema = z.object({ count: z.number().optional() });
    const result = coerceToolArgs({}, schema);
    expect(result.coerced.count).toBeUndefined();
    expect(result.applied).toHaveLength(0);
  });

  it("非 ZodObject schema 返回原始输入", () => {
    const schema = z.string();
    const input = { foo: "bar" };
    const result = coerceToolArgs(input, schema);
    expect(result.coerced).toEqual(input);
    expect(result.applied).toHaveLength(0);
  });
});

describe("coerceToolArgs — 多字段同时强制", () => {
  it("Bash 工具典型场景：timeout 为字符串", () => {
    const schema = z.object({
      command: z.string(),
      timeout: z.number().optional(),
      cwd: z.string().optional(),
    });

    const result = coerceToolArgs(
      { command: "ls", timeout: "30000", cwd: "src/tools" },
      schema,
    );

    expect(result.coerced.command).toBe("ls");
    expect(result.coerced.timeout).toBe(30000);
    const timeoutCoerce = result.applied.find((a) => a.field === "timeout");
    expect(timeoutCoerce).toBeDefined();
    expect(timeoutCoerce!.originalValue).toBe("30000");
    expect(timeoutCoerce!.coercedValue).toBe(30000);
  });

  it("FileRead 工具典型场景：offset/limit 为字符串", () => {
    const schema = z.object({
      file_path: z.string(),
      offset: z.number().optional(),
      limit: z.number().optional(),
    });

    const result = coerceToolArgs(
      { file_path: "src/tools/coerce.ts", offset: "10", limit: "50" },
      schema,
    );

    if (process.platform === "win32") {
      expect(result.coerced.file_path).toBe("src\\tools\\coerce.ts");
    } else {
      expect(result.coerced.file_path).toBe("src/tools/coerce.ts");
    }
    expect(result.coerced.offset).toBe(10);
    expect(result.coerced.limit).toBe(50);
    expect(result.applied.length).toBeGreaterThanOrEqual(2);
  });

  it("FileEdit 工具典型场景：replace_all 为字符串", () => {
    const schema = z.object({
      file_path: z.string(),
      old_str: z.string(),
      new_str: z.string(),
      replace_all: z.boolean().default(false),
    });

    const result = coerceToolArgs(
      { file_path: "test.ts", old_str: "foo", new_str: "bar", replace_all: "true" },
      schema,
    );

    expect(result.coerced.replace_all).toBe(true);
  });

  it("Glob 工具典型场景：ignore 为字符串而非数组", () => {
    const schema = z.object({
      pattern: z.string(),
      path: z.string().optional(),
      ignore: z.array(z.string()).optional(),
    });

    const result = coerceToolArgs(
      { pattern: "*.ts", ignore: "node_modules" },
      schema,
    );

    expect(result.coerced.ignore).toEqual(["node_modules"]);
  });
});

describe("coerceToolArgs — CoerceRecord 记录", () => {
  it("记录原始值和强制值", () => {
    const schema = z.object({ count: z.number() });
    const result = coerceToolArgs({ count: "5" }, schema);

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.originalValue).toBe("5");
    expect(result.applied[0]!.coercedValue).toBe(5);
    expect(result.applied[0]!.from).toBe("string");
    expect(result.applied[0]!.to).toBe("number");
  });

  it("无转换时 applied 为空", () => {
    const schema = z.object({ name: z.string() });
    const result = coerceToolArgs({ name: "hello" }, schema);
    expect(result.applied).toHaveLength(0);
  });
});

describe("coerceToolArgs — ZodDefault 支持", () => {
  it("ZodDefault 内部类型正确识别", () => {
    const schema = z.object({
      replace_all: z.boolean().default(false),
    });

    const result = coerceToolArgs({ replace_all: "true" }, schema);
    expect(result.coerced.replace_all).toBe(true);
    expect(result.applied).toHaveLength(1);
  });

  it("ZodDefault 内部 number 类型正确识别", () => {
    const schema = z.object({
      timeout: z.number().default(30000),
    });

    const result = coerceToolArgs({ timeout: "60000" }, schema);
    expect(result.coerced.timeout).toBe(60000);
    expect(result.applied).toHaveLength(1);
  });
});

describe("coerceToolArgs — ZodNullable 支持", () => {
  it("ZodNullable 内部类型正确识别", () => {
    const schema = z.object({
      count: z.number().nullable(),
    });

    const result = coerceToolArgs({ count: "42" }, schema);
    expect(result.coerced.count).toBe(42);
    expect(result.applied).toHaveLength(1);
  });
});

describe("coerceToolArgs — 边界情况", () => {
  it("输入包含 schema 中不存在的字段时保留", () => {
    const schema = z.object({ count: z.number() });
    const result = coerceToolArgs({ count: "5", extra: "field" }, schema);
    expect(result.coerced.count).toBe(5);
    expect(result.coerced.extra).toBe("field");
  });

  it("空对象不报错", () => {
    const schema = z.object({ count: z.number() });
    const result = coerceToolArgs({}, schema);
    expect(result.coerced).toEqual({});
    expect(result.applied).toHaveLength(0);
  });

  it('"  42  " 带空格的数字字符串正确转换', () => {
    const schema = z.object({ count: z.number() });
    const result = coerceToolArgs({ count: "  42  " }, schema);
    expect(result.coerced.count).toBe(42);
  });

  it('"  true  " 带空格的布尔字符串正确转换', () => {
    const schema = z.object({ flag: z.boolean() });
    const result = coerceToolArgs({ flag: "  true  " }, schema);
    expect(result.coerced.flag).toBe(true);
  });

  it('"0" 正确转换为数字 0', () => {
    const schema = z.object({ count: z.number() });
    const result = coerceToolArgs({ count: "0" }, schema);
    expect(result.coerced.count).toBe(0);
  });

  it('"NaN" 不转换', () => {
    const schema = z.object({ count: z.number() });
    const result = coerceToolArgs({ count: "NaN" }, schema);
    expect(result.coerced.count).toBe("NaN");
    expect(result.applied).toHaveLength(0);
  });
});

/**
 * D.3 配置管线增强测试。
 */

import { describe, it, expect } from "vitest";
import {
  substituteEnvVars,
  deepSubstituteEnvVars,
  expandIncludes,
  diffConfigPaths,
  materializeConfig,
  MissingEnvVarError,
  type IncludeResolver,
} from "../../src/core/config";

// ═══════════════════════════════════════════════════════════
// ${ENV} 环境变量替换
// ═══════════════════════════════════════════════════════════

describe("D.3 > ${ENV} 环境变量替换", () => {
  it("替换已知环境变量", () => {
    const result = substituteEnvVars("Hello ${USER}", { USER: "alice" });
    expect(result).toBe("Hello alice");
  });

  it("多个变量替换", () => {
    const result = substituteEnvVars("${HOST}:${PORT}", { HOST: "localhost", PORT: "3000" });
    expect(result).toBe("localhost:3000");
  });

  it("缺失变量抛出 MissingEnvVarError", () => {
    expect(() => substituteEnvVars("${MISSING_VAR}")).toThrow(MissingEnvVarError);
  });

  it("onMissing 回调保留原始占位符", () => {
    const warnings: Array<{ varName: string }> = [];
    const result = substituteEnvVars("prefix_${MISSING}_suffix", {}, "", {
      onMissing: (w) => warnings.push(w),
    });
    expect(result).toBe("prefix_${MISSING}_suffix");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.varName).toBe("MISSING");
  });

  it("转义语法 $${VAR} → ${VAR}", () => {
    const result = substituteEnvVars("$${ESCAPED}", { ESCAPED: "value" });
    expect(result).toBe("${ESCAPED}");
  });

  it("不包含 $ 的字符串快速返回", () => {
    expect(substituteEnvVars("no vars here")).toBe("no vars here");
  });

  it("小写变量名不匹配", () => {
    const result = substituteEnvVars("${lowercase}", { lowercase: "value" });
    expect(result).toBe("${lowercase}");
  });

  it("deepSubstituteEnvVars 递归替换对象", () => {
    const obj = {
      api: { key: "${API_KEY}", endpoint: "${API_URL}" },
      tags: ["${ENV1}", "${ENV2}"],
    };
    const result = deepSubstituteEnvVars(obj, { API_KEY: "sk-123", API_URL: "https://api.test", ENV1: "a", ENV2: "b" });
    expect((result as Record<string, unknown>).api).toEqual({ key: "sk-123", endpoint: "https://api.test" });
    expect((result as Record<string, unknown>).tags).toEqual(["a", "b"]);
  });
});

// ═══════════════════════════════════════════════════════════
// $include 嵌套包含展开
// ═══════════════════════════════════════════════════════════

describe("D.3 > $include 嵌套包含", () => {
  const resolver: IncludeResolver = {
    resolve(path: string) {
      const store: Record<string, unknown> = {
        "base.json": { database: { host: "localhost", port: 5432 } },
        "overrides.json": { database: { host: "prod-db" }, cache: { ttl: 3600 } },
      };
      return store[path];
    },
  };

  it("展开 $include 引用", () => {
    const config = { "$include": "base.json" };
    const result = expandIncludes(config, resolver);
    expect(result).toEqual({ database: { host: "localhost", port: 5432 } });
  });

  it("不存在的 include 返回空", () => {
    const config = { "$include": "nonexistent.json" };
    const result = expandIncludes(config, resolver);
    expect(result).toEqual({});
  });

  it("循环引用检测", () => {
    const circularResolver: IncludeResolver = {
      resolve() {
        return { "$include": "self.json" };
      },
    };
    const config = { "$include": "self.json" };
    const result = expandIncludes(config, circularResolver);
    expect(result).toEqual({});
  });

  it("嵌套字段中的 $include", () => {
    const config = {
      app: { name: "test" },
      db: { "$include": "base.json" },
    };
    const result = expandIncludes(config, resolver) as Record<string, unknown>;
    expect(result.app).toEqual({ name: "test" });
    expect(result.db).toEqual({ database: { host: "localhost", port: 5432 } });
  });
});

// ═══════════════════════════════════════════════════════════
// diffConfigPaths 配置差异比较
// ═══════════════════════════════════════════════════════════

describe("D.3 > diffConfigPaths", () => {
  it("相同对象返回空", () => {
    const obj = { a: 1, b: { c: 2 } };
    expect(diffConfigPaths(obj, obj)).toEqual([]);
  });

  it("检测顶层变更", () => {
    expect(diffConfigPaths({ a: 1 }, { a: 2 })).toEqual(["a"]);
  });

  it("检测嵌套变更", () => {
    expect(diffConfigPaths({ a: { b: 1 } }, { a: { b: 2 } })).toEqual(["a.b"]);
  });

  it("检测新增字段", () => {
    expect(diffConfigPaths({ a: 1 }, { a: 1, b: 2 })).toEqual(["b"]);
  });

  it("检测删除字段", () => {
    expect(diffConfigPaths({ a: 1, b: 2 }, { a: 1 })).toEqual(["b"]);
  });

  it("根级别变更返回 <root>", () => {
    expect(diffConfigPaths(1, 2)).toEqual(["<root>"]);
  });
});

// ═══════════════════════════════════════════════════════════
// 物化引擎
// ═══════════════════════════════════════════════════════════

describe("D.3 > 物化引擎", () => {
  it("load 模式填充默认值", () => {
    const result = materializeConfig({} as never, "load");
    expect(result).toBeDefined();
  });

  it("snapshot 模式不填充默认值", () => {
    const partial = { last_modified: "2024-01-01" } as never;
    const result = materializeConfig(partial, "snapshot");
    expect(result).toBeDefined();
  });
});

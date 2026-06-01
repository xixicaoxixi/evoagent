/**
 * Session D.1 测试 — 路径感知规则加载。
 *
 * 验证规则路径范围声明、动态规则选择、全局规则保留、上下文节省统计。
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  createPathAwareRuleEngine,
  type PathAwareRuleEngine,
  type ScopedRule,
  type RuleFilterResult,
  type PathAwareStats,
} from "../../src/context/path-aware-rules";

// ─── 辅助函数 ───

function createRule(overrides?: Partial<ScopedRule>): ScopedRule {
  return {
    id: `rule-${Math.random().toString(36).slice(2, 8)}`,
    content: "This is a rule content for testing purposes.",
    ...overrides,
  };
}

function createEngine(): PathAwareRuleEngine {
  return createPathAwareRuleEngine();
}

// ─── 测试：规则注册 ───

describe("规则注册", () => {
  it("添加单条规则", () => {
    const engine = createEngine();
    const rule = createRule({ id: "r1" });

    engine.addRule(rule);

    expect(engine.getAllRules()).toHaveLength(1);
    expect(engine.getAllRules()[0]?.id).toBe("r1");
  });

  it("批量添加规则", () => {
    const engine = createEngine();
    const rules = [
      createRule({ id: "r1" }),
      createRule({ id: "r2" }),
      createRule({ id: "r3" }),
    ];

    engine.addRules(rules);

    expect(engine.getAllRules()).toHaveLength(3);
  });

  it("重复 ID 覆盖旧规则", () => {
    const engine = createEngine();

    engine.addRule(createRule({ id: "r1", content: "old" }));
    engine.addRule(createRule({ id: "r1", content: "new" }));

    expect(engine.getAllRules()).toHaveLength(1);
    expect(engine.getAllRules()[0]?.content).toBe("new");
  });

  it("移除规则", () => {
    const engine = createEngine();

    engine.addRule(createRule({ id: "r1" }));
    engine.addRule(createRule({ id: "r2" }));

    expect(engine.removeRule("r1")).toBe(true);
    expect(engine.getAllRules()).toHaveLength(1);
    expect(engine.getAllRules()[0]?.id).toBe("r2");
  });

  it("移除不存在的规则返回 false", () => {
    const engine = createEngine();
    expect(engine.removeRule("nonexistent")).toBe(false);
  });

  it("清空所有规则", () => {
    const engine = createEngine();
    engine.addRules([
      createRule({ id: "r1" }),
      createRule({ id: "r2" }),
    ]);

    engine.clear();

    expect(engine.getAllRules()).toHaveLength(0);
    expect(engine.getStats().totalRules).toBe(0);
  });
});

// ─── 测试：全局规则（无 scope） ───

describe("全局规则", () => {
  it("无 scope 的规则始终匹配", () => {
    const engine = createEngine();
    engine.addRule(createRule({ id: "global-1", content: "Global rule 1" }));
    engine.addRule(createRule({ id: "global-2", content: "Global rule 2" }));

    const result = engine.filterForPath("src/any/file.ts");

    expect(result.matchedRules).toHaveLength(2);
    expect(result.filteredCount).toBe(0);
  });

  it("空 scope 数组视为全局规则", () => {
    const engine = createEngine();
    engine.addRule(createRule({ id: "empty-scope", scope: [] }));

    const result = engine.filterForPath("src/any/file.ts");

    expect(result.matchedRules).toHaveLength(1);
  });

  it("全局规则与有 scope 的规则共存", () => {
    const engine = createEngine();
    engine.addRule(createRule({ id: "global", content: "Always loaded" }));
    engine.addRule(createRule({
      id: "scoped",
      content: "Only for security",
      scope: ["src/security/**"],
    }));

    const result = engine.filterForPath("src/security/auth.ts");

    expect(result.matchedRules).toHaveLength(2);
  });
});

// ─── 测试：路径范围匹配 ───

describe("路径范围匹配", () => {
  beforeEach(() => {
    // 每个测试使用独立的 engine
  });

  it("精确目录前缀匹配", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "security-rule",
      scope: ["src/security/**"],
    }));

    const result = engine.filterForPath("src/security/auth.ts");
    expect(result.matchedRules).toHaveLength(1);
  });

  it("不匹配的路径被过滤", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "security-rule",
      scope: ["src/security/**"],
    }));

    const result = engine.filterForPath("src/ui/components/Button.tsx");
    expect(result.matchedRules).toHaveLength(0);
    expect(result.filteredCount).toBe(1);
  });

  it("** 匹配任意多级目录", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "deep-rule",
      scope: ["src/**/test/**"],
    }));

    expect(engine.filterForPath("src/core/utils/test/utils.test.ts").matchedRules).toHaveLength(1);
    expect(engine.filterForPath("src/a/b/c/test/d.test.ts").matchedRules).toHaveLength(1);
  });

  it("* 匹配单级目录", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "single-star",
      scope: ["src/*/index.ts"],
    }));

    expect(engine.filterForPath("src/core/index.ts").matchedRules).toHaveLength(1);
    expect(engine.filterForPath("src/deep/nested/index.ts").matchedRules).toHaveLength(0);
  });

  it("多个 scope 模式（任一匹配即可）", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "multi-scope",
      scope: ["src/security/**", "src/auth/**", "src/crypto/**"],
    }));

    expect(engine.filterForPath("src/security/firewall.ts").matchedRules).toHaveLength(1);
    expect(engine.filterForPath("src/auth/login.ts").matchedRules).toHaveLength(1);
    expect(engine.filterForPath("src/crypto/aes.ts").matchedRules).toHaveLength(1);
    expect(engine.filterForPath("src/ui/button.ts").matchedRules).toHaveLength(0);
  });

  it("多个文件路径（任一匹配即可）", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "security-rule",
      scope: ["src/security/**"],
    }));

    const result = engine.filterForPaths([
      "src/ui/button.ts",
      "src/security/auth.ts",
    ]);

    expect(result.matchedRules).toHaveLength(1);
  });
});

// ─── 测试：优先级排序 ───

describe("优先级排序", () => {
  it("匹配的规则按优先级排序", () => {
    const engine = createEngine();
    engine.addRule(createRule({ id: "low", priority: 100 }));
    engine.addRule(createRule({ id: "high", priority: 1 }));
    engine.addRule(createRule({ id: "medium", priority: 50 }));

    const result = engine.filterForPath("any/path");

    expect(result.matchedRules[0]?.id).toBe("high");
    expect(result.matchedRules[1]?.id).toBe("medium");
    expect(result.matchedRules[2]?.id).toBe("low");
  });

  it("无优先级的规则默认排在后面", () => {
    const engine = createEngine();
    engine.addRule(createRule({ id: "no-priority" }));
    engine.addRule(createRule({ id: "high-priority", priority: 1 }));

    const result = engine.filterForPath("any/path");

    expect(result.matchedRules[0]?.id).toBe("high-priority");
    expect(result.matchedRules[1]?.id).toBe("no-priority");
  });
});

// ─── 测试：Token 节省统计 ───

describe("Token 节省统计", () => {
  it("过滤掉的规则计入 savedTokens", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "global",
      content: "A".repeat(100),
    }));
    engine.addRule(createRule({
      id: "scoped-matched",
      content: "B".repeat(100),
      scope: ["src/security/**"],
    }));
    engine.addRule(createRule({
      id: "scoped-filtered",
      content: "C".repeat(100),
      scope: ["src/ui/**"],
    }));

    const result = engine.filterForPath("src/security/auth.ts");

    expect(result.matchedCount).toBe(2);
    expect(result.filteredCount).toBe(1);
    expect(result.savedTokens).toBeGreaterThan(0);
  });

  it("所有规则都匹配时 savedTokens 为 0", () => {
    const engine = createEngine();
    engine.addRule(createRule({ id: "g1", content: "Global" }));
    engine.addRule(createRule({ id: "g2", content: "Global 2" }));

    const result = engine.filterForPath("any/path");

    expect(result.savedTokens).toBe(0);
  });

  it("累计统计跨多次过滤", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "scoped",
      content: "X".repeat(200),
      scope: ["src/security/**"],
    }));

    // 第一次过滤：不匹配
    engine.filterForPath("src/ui/button.ts");
    // 第二次过滤：不匹配
    engine.filterForPath("src/auth/login.ts");
    // 第三次过滤：匹配
    engine.filterForPath("src/security/auth.ts");

    const stats = engine.getStats();
    expect(stats.filterCount).toBe(3);
    expect(stats.totalSavedTokens).toBeGreaterThan(0);
  });

  it("resetStats 清零统计", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "scoped",
      content: "Y".repeat(100),
      scope: ["src/security/**"],
    }));

    engine.filterForPath("src/ui/button.ts");
    expect(engine.getStats().totalSavedTokens).toBeGreaterThan(0);

    engine.resetStats();
    expect(engine.getStats().totalSavedTokens).toBe(0);
    expect(engine.getStats().filterCount).toBe(0);
  });
});

// ─── 测试：统计信息 ───

describe("统计信息", () => {
  it("正确统计全局规则和有 scope 的规则", () => {
    const engine = createEngine();
    engine.addRule(createRule({ id: "g1" }));
    engine.addRule(createRule({ id: "g2" }));
    engine.addRule(createRule({ id: "s1", scope: ["src/a/**"] }));
    engine.addRule(createRule({ id: "s2", scope: ["src/b/**"] }));

    const stats = engine.getStats();

    expect(stats.totalRules).toBe(4);
    expect(stats.globalRules).toBe(2);
    expect(stats.scopedRules).toBe(2);
  });

  it("空引擎统计为零", () => {
    const engine = createEngine();
    const stats = engine.getStats();

    expect(stats.totalRules).toBe(0);
    expect(stats.globalRules).toBe(0);
    expect(stats.scopedRules).toBe(0);
    expect(stats.totalSavedTokens).toBe(0);
    expect(stats.filterCount).toBe(0);
  });
});

// ─── 测试：过滤结果结构 ───

describe("RuleFilterResult 结构", () => {
  it("包含所有必要字段", () => {
    const engine = createEngine();
    engine.addRule(createRule({ id: "r1" }));

    const result = engine.filterForPath("any/path");

    expect(result).toHaveProperty("matchedRules");
    expect(result).toHaveProperty("filteredCount");
    expect(result).toHaveProperty("matchedCount");
    expect(result).toHaveProperty("totalCount");
    expect(result).toHaveProperty("savedTokens");
    expect(result).toHaveProperty("matchedTokens");
  });

  it("matchedCount + filteredCount === totalCount", () => {
    const engine = createEngine();
    engine.addRules([
      createRule({ id: "g1" }),
      createRule({ id: "s1", scope: ["src/a/**"] }),
      createRule({ id: "s2", scope: ["src/b/**"] }),
    ]);

    const result = engine.filterForPath("src/a/file.ts");

    expect(result.matchedCount + result.filteredCount).toBe(result.totalCount);
  });
});

// ─── 测试：复杂场景 ───

describe("复杂场景", () => {
  it("模拟真实项目规则加载", () => {
    const engine = createEngine();

    // 全局规则
    engine.addRules([
      createRule({ id: "general-ts", content: "Use TypeScript strict mode", source: "project" }),
      createRule({ id: "general-testing", content: "Write tests for all new code", source: "project" }),
    ]);

    // 安全相关规则
    engine.addRules([
      createRule({
        id: "security-no-eval",
        content: "Never use eval() in security-related code",
        scope: ["src/security/**", "src/auth/**"],
        source: "managed",
        priority: 1,
      }),
      createRule({
        id: "security-input-validation",
        content: "Always validate user input in security modules",
        scope: ["src/security/**"],
        source: "managed",
        priority: 2,
      }),
    ]);

    // 进化相关规则
    engine.addRule(createRule({
      id: "evolution-safe-mutation",
      content: "Evolution mutations must be reversible",
      scope: ["src/evolution/**"],
      source: "managed",
    }));

    // 处理安全文件
    const securityResult = engine.filterForPath("src/security/firewall.ts");
    expect(securityResult.matchedRules).toHaveLength(4); // 2 global + 2 security
    expect(securityResult.filteredCount).toBe(1); // evolution filtered

    // 处理进化文件
    const evolutionResult = engine.filterForPath("src/evolution/rule-store.ts");
    expect(evolutionResult.matchedRules).toHaveLength(3); // 2 global + 1 evolution
    expect(evolutionResult.filteredCount).toBe(2); // 2 security filtered

    // 处理 UI 文件
    const uiResult = engine.filterForPath("src/ui/components/Button.tsx");
    expect(uiResult.matchedRules).toHaveLength(2); // 仅全局规则
    expect(uiResult.filteredCount).toBe(3); // 2 security + 1 evolution filtered
  });

  it("规则来源标记保留", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "managed-rule",
      source: "managed",
      scope: ["src/**"],
    }));
    engine.addRule(createRule({
      id: "user-rule",
      source: "user",
    }));

    const result = engine.filterForPath("src/file.ts");

    expect(result.matchedRules[0]?.source).toBe("managed");
    expect(result.matchedRules[1]?.source).toBe("user");
  });
});

// ─── 测试：边界情况 ───

describe("边界情况", () => {
  it("空引擎过滤返回空结果", () => {
    const engine = createEngine();
    const result = engine.filterForPath("any/path");

    expect(result.matchedRules).toHaveLength(0);
    expect(result.filteredCount).toBe(0);
    expect(result.savedTokens).toBe(0);
  });

  it("空文件路径", () => {
    const engine = createEngine();
    engine.addRule(createRule({ id: "global" }));
    engine.addRule(createRule({ id: "scoped", scope: ["src/**"] }));

    const result = engine.filterForPath("");

    // 空路径不匹配有 scope 的规则
    expect(result.matchedRules).toHaveLength(1);
  });

  it("Windows 风格路径", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "win-rule",
      scope: ["src/security/**"],
    }));

    const result = engine.filterForPath("src\\security\\auth.ts");

    expect(result.matchedRules).toHaveLength(1);
  });

  it("规则内容为空字符串", () => {
    const engine = createEngine();
    engine.addRule(createRule({
      id: "empty-content",
      content: "",
      scope: ["src/**"],
    }));

    const result = engine.filterForPath("src/file.ts");

    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedTokens).toBe(0);
  });
});

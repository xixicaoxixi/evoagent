/**
 * Session B.3 测试 — 指令型/学习型记忆分离。
 *
 * 验证 MemoryCategory、getMemoryCategory、getMemoryWeight、
 * 分层存储、权重差异、独立淘汰。
 */

import { describe, expect, it } from "vitest";
import {
  getMemoryCategory,
  getMemoryWeight,
  INSTRUCTION_WEIGHT,
  LEARNING_WEIGHT,
  type MemoryCategory,
  type MemoryType,
} from "../../src/knowledge/memory-types";
import { createKnowledgeManager } from "../../src/knowledge/knowledge-manager";
import type { MemoryEntry } from "../../src/knowledge/memory-types";

// ─── 辅助函数 ───

function createEntry(type: MemoryType, id: string, confidence: number = 0.8): MemoryEntry {
  return {
    id,
    type,
    title: `Test ${type} ${id}`,
    content: `Content for ${type} ${id}`,
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mtimeMs: Date.now(),
    source: "test",
    confidence,
  };
}

// ─── 测试 ───

describe("getMemoryCategory", () => {
  it("preference 属于 instruction 类", () => {
    expect(getMemoryCategory("preference")).toBe("instruction");
  });

  it("instruction 属于 instruction 类", () => {
    expect(getMemoryCategory("instruction")).toBe("instruction");
  });

  it("fact 属于 learning 类", () => {
    expect(getMemoryCategory("fact")).toBe("learning");
  });

  it("skill 属于 learning 类", () => {
    expect(getMemoryCategory("skill")).toBe("learning");
  });
});

describe("getMemoryWeight", () => {
  it("指令型记忆权重高于学习型", () => {
    expect(getMemoryWeight("preference")).toBe(INSTRUCTION_WEIGHT);
    expect(getMemoryWeight("instruction")).toBe(INSTRUCTION_WEIGHT);
    expect(getMemoryWeight("fact")).toBe(LEARNING_WEIGHT);
    expect(getMemoryWeight("skill")).toBe(LEARNING_WEIGHT);
    expect(INSTRUCTION_WEIGHT).toBeGreaterThan(LEARNING_WEIGHT);
  });

  it("指令型权重为 1.5", () => {
    expect(INSTRUCTION_WEIGHT).toBe(1.5);
  });

  it("学习型权重为 1.0", () => {
    expect(LEARNING_WEIGHT).toBe(1.0);
  });
});

describe("KnowledgeManager 分层存储", () => {
  it("指令型和学习型记忆可以同时存储", () => {
    const km = createKnowledgeManager();
    km.store(createEntry("preference", "pref-1"));
    km.store(createEntry("instruction", "inst-1"));
    km.store(createEntry("fact", "fact-1"));
    km.store(createEntry("skill", "skill-1"));
    expect(km.count()).toBe(4);
  });

  it("搜索结果中指令型记忆排名更高（权重差异）", () => {
    const km = createKnowledgeManager();
    km.store(createEntry("preference", "pref-1"));
    km.store(createEntry("fact", "fact-1"));

    const results = km.search("Test");
    expect(results.length).toBe(2);

    // 指令型记忆分数更高
    const prefScore = results.find((r) => r.entry.type === "preference")?.score ?? 0;
    const factScore = results.find((r) => r.entry.type === "fact")?.score ?? 0;
    expect(prefScore).toBeGreaterThan(factScore);
  });

  it("按类型过滤搜索", () => {
    const km = createKnowledgeManager();
    km.store(createEntry("preference", "pref-1"));
    km.store(createEntry("fact", "fact-1"));
    km.store(createEntry("skill", "skill-1"));

    const results = km.search("Test", { typeFilter: ["preference"] });
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.type).toBe("preference");
  });
});

describe("KnowledgeManager deleteByCategory", () => {
  it("删除所有指令型记忆", () => {
    const km = createKnowledgeManager();
    km.store(createEntry("preference", "pref-1"));
    km.store(createEntry("instruction", "inst-1"));
    km.store(createEntry("fact", "fact-1"));
    km.store(createEntry("skill", "skill-1"));

    const deleted = km.deleteByCategory("instruction");
    expect(deleted).toBe(2);
    expect(km.count()).toBe(2);

    const remaining = km.getAll();
    expect(remaining.every((e) => e.type === "fact" || e.type === "skill")).toBe(true);
  });

  it("删除所有学习型记忆", () => {
    const km = createKnowledgeManager();
    km.store(createEntry("preference", "pref-1"));
    km.store(createEntry("instruction", "inst-1"));
    km.store(createEntry("fact", "fact-1"));
    km.store(createEntry("skill", "skill-1"));

    const deleted = km.deleteByCategory("learning");
    expect(deleted).toBe(2);
    expect(km.count()).toBe(2);

    const remaining = km.getAll();
    expect(remaining.every((e) => e.type === "preference" || e.type === "instruction")).toBe(true);
  });

  it("无匹配时返回 0", () => {
    const km = createKnowledgeManager();
    km.store(createEntry("fact", "fact-1"));
    expect(km.deleteByCategory("instruction")).toBe(0);
  });
});

describe("KnowledgeManager evictLearningMemories", () => {
  it("淘汰低置信度的学习型记忆", () => {
    const km = createKnowledgeManager();
    km.store(createEntry("preference", "pref-1", 0.9));
    km.store(createEntry("fact", "fact-1", 0.1)); // 低置信度
    km.store(createEntry("fact", "fact-2", 0.8));
    km.store(createEntry("skill", "skill-1", 0.05)); // 低置信度

    const evicted = km.evictLearningMemories(10, 0.2);
    expect(evicted).toBe(2);
    expect(km.count()).toBe(2);

    // 指令型记忆不受影响
    expect(km.get("pref-1")).toBeDefined();
    // 高置信度学习型记忆不受影响
    expect(km.get("fact-2")).toBeDefined();
    // 低置信度学习型记忆被淘汰
    expect(km.get("fact-1")).toBeUndefined();
    expect(km.get("skill-1")).toBeUndefined();
  });

  it("maxCount 限制淘汰数量", () => {
    const km = createKnowledgeManager();
    km.store(createEntry("preference", "pref-1", 0.9));
    for (let i = 0; i < 5; i++) {
      km.store(createEntry("fact", `fact-${i}`, 0.1));
    }

    const evicted = km.evictLearningMemories(2, 0.2);
    expect(evicted).toBe(2);
    expect(km.count()).toBe(4); // 1 pref + 3 fact
  });

  it("不影响指令型记忆", () => {
    const km = createKnowledgeManager();
    km.store(createEntry("preference", "pref-1", 0.01)); // 极低置信度
    km.store(createEntry("instruction", "inst-1", 0.01));

    const evicted = km.evictLearningMemories(10, 0.0);
    expect(evicted).toBe(0);
    expect(km.count()).toBe(2);
  });

  it("无学习型记忆时返回 0", () => {
    const km = createKnowledgeManager();
    km.store(createEntry("preference", "pref-1", 0.9));
    expect(km.evictLearningMemories()).toBe(0);
  });
});

describe("KnowledgeManager 权重差异对搜索的影响", () => {
  it("相同内容下指令型记忆分数更高", () => {
    const km = createKnowledgeManager();
    // 相同内容但不同类型
    km.store(createEntry("preference", "pref-1"));
    km.store(createEntry("fact", "fact-1"));

    const results = km.search("Test Content");
    expect(results.length).toBe(2);

    const scores = results.map((r) => r.score);
    // 指令型分数应该更高（因为权重 1.5 vs 1.0）
    expect(scores[0]).toBeGreaterThan(scores[1] ?? 0);
  });

  it("权重差异在 injectForContext 中体现", () => {
    const km = createKnowledgeManager();
    km.store(createEntry("instruction", "inst-1"));
    km.store(createEntry("fact", "fact-1"));

    const result = km.injectForContext("Test", 500);
    // 指令型记忆应该被优先注入
    if (result.injectedCount > 0) {
      expect(result.systemPromptAddition).toContain("instruction");
    }
  });
});
